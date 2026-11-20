"""收费：待缴查询、批量收费、作废（留痕）。"""

from __future__ import annotations

from .. import db, security
from ..errors import ApiError, conflict, not_found
from .common import as_list, as_str, require_fields


def list_charges(ctx):
    where, params = ["1=1"], []
    if ctx.q("status"):
        where.append("c.status=?")
        params.append(ctx.q("status"))
    if ctx.q("category"):
        where.append("c.category=?")
        params.append(ctx.q("category"))
    if ctx.q("date"):
        where.append("substr(c.created_at,1,10)=?")
        params.append(ctx.q("date"))
    if ctx.q("patientId"):
        where.append("c.patient_id=?")
        params.append(int(ctx.q("patientId")))
    rows = db.query(
        "SELECT c.*, p.name AS patient_name, p.mrn AS patient_mrn, s.name AS cashier_name "
        "FROM charges c JOIN patients p ON p.id=c.patient_id LEFT JOIN staff s ON s.id=c.cashier_id "
        "WHERE " + " AND ".join(where) + " ORDER BY c.id DESC LIMIT 300", tuple(params))
    return [{
        "id": r["id"], "chargeNo": r["charge_no"], "patientId": r["patient_id"],
        "patientName": security.mask_name(r["patient_name"]), "patientMrn": r["patient_mrn"],
        "visitId": r["visit_id"], "category": r["category"], "description": r["description"],
        "amount": r["amount"], "status": r["status"], "refType": r["ref_type"],
        "refId": r["ref_id"], "cashierName": r["cashier_name"], "paidAt": r["paid_at"],
        "voidReason": r["void_reason"], "refundedAt": r["refunded_at"],
        "refundReason": r["refund_reason"], "createdAt": r["created_at"],
    } for r in rows]


def pay_charges(ctx):
    ids = as_list(ctx.body, "ids", required=True, max_items=100)
    if not ids:
        raise ApiError(400, "VALIDATION_FAILED", "请选择要收费的账单")
    try:
        charge_ids = [int(x) for x in ids]
    except (TypeError, ValueError):
        raise ApiError(400, "VALIDATION_FAILED", "ids 必须为整数数组")
    marks = ",".join("?" for _ in charge_ids)
    with db.tx() as con:
        rows = con.execute(f"SELECT * FROM charges WHERE id IN ({marks})", tuple(charge_ids)).fetchall()
        if len(rows) != len(set(charge_ids)):
            raise not_found("存在无效账单")
        unpaid = [r for r in rows if r["status"] == "UNPAID"]
        if len(unpaid) != len(rows):
            raise ApiError(400, "STATE_CONFLICT", "包含已收费或已作废账单，请刷新后重试")
        total = round(sum(float(r["amount"]) for r in rows), 2)
        now = db.now_str()
        # 逐条条件更新，rowcount 为 0 说明并发抢先，整批回滚并报冲突
        for cid in charge_ids:
            cur = con.execute(
                "UPDATE charges SET status='PAID', cashier_id=?, paid_at=? WHERE id=? AND status='UNPAID'",
                (ctx.user.get("staff_id"), now, cid))
            if cur.rowcount != 1:
                raise ApiError(400, "STATE_CONFLICT", "账单已被并发处理，请刷新后重试")
        security.audit(con, ctx.user, "CHARGE_PAY", "charges", ",".join(map(str, charge_ids)),
                       f"count={len(charge_ids)} total={total}", "OK", ctx.ip)
    return {"paidCount": len(charge_ids), "totalAmount": total}


def void_charge(ctx):
    charge_id = int(ctx.params["id"])
    reason = as_str(ctx.body, "reason", required=True, max_len=100)
    if len(reason) < 2:
        raise ApiError(400, "VALIDATION_FAILED", "作废原因不得少于 2 个字")
    with db.tx() as con:
        row = con.execute("SELECT * FROM charges WHERE id=?", (charge_id,)).fetchone()
        if row is None:
            raise not_found("账单不存在")
        if row["status"] != "UNPAID":
            raise conflict("仅未收费账单可作废，已收费请走退费流程", "STATE_CONFLICT")
        con.execute("UPDATE charges SET status='VOID', void_reason=? WHERE id=?", (reason, charge_id))
        security.audit(con, ctx.user, "CHARGE_VOID", "charge", charge_id,
                       f"reason={reason}", "OK", ctx.ip)
    return {"id": charge_id, "status": "VOID"}


def _apply_refund(con, ctx, row, reason: str) -> None:
    """在调用方事务内完成退费：状态迁移 + 业务联动 + 审计。

    仅处理 status='PAID' 的账单；rowcount 为 0 说明已被并发退费/作废。
    """
    ref_type, ref_id = row["ref_type"], row["ref_id"]
    # 检查报告已出具不可退（先校验，避免任何写入）
    if ref_type == "LAB_ORDER" and ref_id:
        lab = con.execute("SELECT status FROM lab_orders WHERE id=?", (ref_id,)).fetchone()
        if lab is not None and lab["status"] == "REPORTED":
            raise ApiError(400, "STATE_CONFLICT", "检查报告已出具，不可退费")
    cur = con.execute(
        "UPDATE charges SET status='REFUNDED', refunded_at=?, refund_reason=?, refunded_by=? "
        "WHERE id=? AND status='PAID'",
        (db.now_str(), reason, ctx.user.get("staff_id"), row["id"]))
    if cur.rowcount == 0:
        raise ApiError(400, "STATE_CONFLICT", "账单状态已变更，请刷新后重试")

    if ref_type == "REGISTRATION" and ref_id:
        reg = con.execute("SELECT * FROM registrations WHERE id=?", (ref_id,)).fetchone()
        if reg is not None and reg["status"] != "CANCELLED":
            con.execute("UPDATE registrations SET status='CANCELLED' WHERE id=?", (ref_id,))
            # 复用取消挂号的号源扣回逻辑
            if reg["slot_id"]:
                con.execute("UPDATE doctor_slots SET booked=MAX(booked-1,0) WHERE id=?", (reg["slot_id"],))
    elif ref_type == "PRESCRIPTION" and ref_id:
        rx = con.execute("SELECT id, status FROM prescriptions WHERE id=?", (ref_id,)).fetchone()
        if rx is not None:
            if rx["status"] == "DISPENSED":
                # 已发药：药品回库
                items = con.execute(
                    "SELECT drug_id, quantity FROM prescription_items WHERE prescription_id=?",
                    (ref_id,)).fetchall()
                for item in items:
                    con.execute("UPDATE drugs SET stock=stock+? WHERE id=?",
                                (item["quantity"], item["drug_id"]))
            con.execute("UPDATE prescriptions SET status='REFUNDED' WHERE id=?", (ref_id,))
    elif ref_type == "LAB_ORDER" and ref_id:
        con.execute("UPDATE lab_orders SET status='REFUNDED' WHERE id=?", (ref_id,))

    security.audit(con, ctx.user, "CHARGE_REFUND", "charge", row["id"],
                   f"reason={reason} amount={row['amount']} ref={ref_type}:{ref_id}", "OK", ctx.ip)


def refund_charge(ctx):
    charge_id = int(ctx.params["id"])
    reason = as_str(ctx.body, "reason", required=True, max_len=100)
    if len(reason) < 4:
        raise ApiError(400, "VALIDATION_FAILED", "退费原因不得少于 4 个字")
    with db.tx() as con:
        row = con.execute("SELECT * FROM charges WHERE id=?", (charge_id,)).fetchone()
        if row is None:
            raise not_found("账单不存在")
        if row["status"] != "PAID":
            raise ApiError(400, "STATE_CONFLICT", "仅已收费账单可退费")
        me = ctx.user.get("staff_id") or ctx.user["id"]
        if row["cashier_id"] and str(row["cashier_id"]) == str(me) \
                and not security.has_perm(ctx.user, "charge.void"):
            raise ApiError(403, "SEPARATION_OF_DUTIES",
                           "收费员不能退收本人收取的账单，请由其他收费员或主管办理（收退分离）")
        _apply_refund(con, ctx, row, reason)
    return {"id": charge_id, "status": "REFUNDED"}


def register(router):
    router.add("GET", r"/api/v1/charges", list_charges, perm="charge.read")
    router.add("POST", r"/api/v1/charges/pay", pay_charges, perm="charge.pay")
    router.add("POST", r"/api/v1/charges/(?P<id>\d+)/void", void_charge, perm="charge.void")
    router.add("POST", r"/api/v1/charges/(?P<id>\d+)/refund", refund_charge, perm="charge.refund")
