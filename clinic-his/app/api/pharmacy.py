"""药房：药品库存、处方审核与发药。"""

from __future__ import annotations

from .. import db, security
from ..errors import ApiError, conflict, not_found
from .common import as_int, as_str, one_of, require_fields


def list_drugs(ctx):
    keyword = (ctx.q("q") or "").strip()
    if keyword:
        like = f"%{keyword}%"
        rows = db.query("SELECT * FROM drugs WHERE name LIKE ? OR code LIKE ? ORDER BY code",
                        (like, like))
    else:
        rows = db.query("SELECT * FROM drugs ORDER BY code")
    return [{
        "id": r["id"], "code": r["code"], "name": r["name"], "spec": r["spec"], "unit": r["unit"],
        "price": r["price"], "stock": r["stock"], "alertStock": r["alert_stock"],
        "category": r["category"], "antibioticLevel": r["antibiotic_level"],
        "defaultRoute": r["default_route"], "defaultFreq": r["default_freq"],
        "controlled": bool(r["controlled"]), "status": r["status"],
        "lowStock": r["stock"] <= r["alert_stock"],
    } for r in rows]


def stock_in(ctx):
    drug_id = int(ctx.params["id"])
    quantity = as_int(ctx.body, "quantity", required=True, minimum=1, maximum=100000)
    note = as_str(ctx.body, "note", max_len=100)
    with db.tx() as con:
        drug = con.execute("SELECT * FROM drugs WHERE id=?", (drug_id,)).fetchone()
        if drug is None:
            raise not_found("药品不存在")
        con.execute("UPDATE drugs SET stock=stock+? WHERE id=?", (quantity, drug_id))
        security.audit(con, ctx.user, "STOCK_IN", "drug", drug_id,
                       f"qty={quantity} note={note}", "OK", ctx.ip)
    return {"id": drug_id, "stock": drug["stock"] + quantity}


def _rx_items_map(con, rx_ids: list[int]) -> dict:
    if not rx_ids:
        return {}
    marks = ",".join("?" for _ in rx_ids)
    rows = con.execute(
        f"SELECT * FROM prescription_items WHERE prescription_id IN ({marks}) ORDER BY id",
        tuple(rx_ids)).fetchall()
    mapping: dict[int, list] = {}
    for r in rows:
        mapping.setdefault(r["prescription_id"], []).append({
            "drugId": r["drug_id"], "drugName": r["drug_name"], "spec": r["spec"],
            "dosage": r["dosage"], "frequency": r["frequency"], "days": r["days"],
            "quantity": r["quantity"], "amount": r["amount"],
        })
    return mapping


def list_prescriptions(ctx):
    where, params = ["1=1"], []
    if ctx.q("status"):
        where.append("p.status=?")
        params.append(ctx.q("status"))
    if ctx.q("date"):
        where.append("substr(p.created_at,1,10)=?")
        params.append(ctx.q("date"))
    if ctx.q("mine") == "1":
        where.append("p.doctor_id=?")
        params.append(ctx.user.get("staff_id") or 0)
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT p.*, pt.name AS patient_name, pt.mrn AS patient_mrn, s.name AS doctor_name, "
            "rv.name AS reviewer_name FROM prescriptions p JOIN patients pt ON pt.id=p.patient_id "
            "JOIN staff s ON s.id=p.doctor_id LEFT JOIN staff rv ON rv.id=p.reviewer_id "
            "WHERE " + " AND ".join(where) + " ORDER BY p.id DESC LIMIT 200", tuple(params)).fetchall()
        items = _rx_items_map(con, [r["id"] for r in rows])
    finally:
        con.close()
    return [{
        "id": r["id"], "rxNo": r["rx_no"], "visitId": r["visit_id"], "patientId": r["patient_id"],
        "patientName": security.mask_name(r["patient_name"]), "patientMrn": r["patient_mrn"],
        "doctorName": r["doctor_name"], "status": r["status"], "totalAmount": r["total_amount"],
        "reviewerName": r["reviewer_name"], "reviewComment": r["review_comment"],
        "reviewedAt": r["reviewed_at"], "dispensedAt": r["dispensed_at"],
        "createdAt": r["created_at"], "items": items.get(r["id"], []),
    } for r in rows]


def _require_visit_finished(con, visit_id: int) -> None:
    """审方/发药前置：就诊须已完成（医生已提交病历）。"""
    visit = con.execute("SELECT status FROM visits WHERE id=?", (visit_id,)).fetchone()
    if visit is None or visit["status"] != "FINISHED":
        raise ApiError(400, "VISIT_NOT_FINISHED", "就诊尚未完成，不能审核或发放处方",
                       details=[{"field": "visitId", "reason": "就诊未完成"}])


def review_prescription(ctx):
    rx_id = int(ctx.params["id"])
    require_fields(ctx.body, ["decision"])
    decision = one_of(as_str(ctx.body, "decision", required=True), {"APPROVE", "REJECT"}, "decision")
    comment = as_str(ctx.body, "comment", max_len=200)
    if decision == "REJECT" and len(comment) < 2:
        raise ApiError(400, "VALIDATION_FAILED", "驳回处方必须填写理由")
    with db.tx() as con:
        rx = con.execute("SELECT * FROM prescriptions WHERE id=?", (rx_id,)).fetchone()
        if rx is None:
            raise not_found("处方不存在")
        if rx["status"] != "SUBMITTED":
            raise conflict("处方状态不允许审核", "STATE_CONFLICT")
        _require_visit_finished(con, rx["visit_id"])
        if decision == "REJECT":
            con.execute(
                "UPDATE prescriptions SET status='REJECTED', reviewer_id=?, review_comment=?, reviewed_at=? WHERE id=?",
                (ctx.user.get("staff_id"), comment, db.now_str(), rx_id))
            security.audit(con, ctx.user, "RX_REJECT", "prescription", rx_id,
                           f"comment={comment}", "OK", ctx.ip)
            return {"id": rx_id, "status": "REJECTED"}
        con.execute(
            "UPDATE prescriptions SET status='APPROVED', reviewer_id=?, review_comment=?, reviewed_at=? WHERE id=?",
            (ctx.user.get("staff_id"), comment, db.now_str(), rx_id))
        compact = db.today_str().replace("-", "")
        con.execute(
            "INSERT INTO charges(charge_no,patient_id,visit_id,category,description,amount,status,ref_type,ref_id,created_at) "
            "VALUES (?,?,?, 'DRUG', ?,?, 'UNPAID','PRESCRIPTION',?,?)",
            (f"CH{compact}-D{rx_id:06d}", rx["patient_id"], rx["visit_id"],
             f"药品费（{rx['rx_no']}）", rx["total_amount"], rx_id, db.now_str()))
        security.audit(con, ctx.user, "RX_APPROVE", "prescription", rx_id,
                       f"total={rx['total_amount']}", "OK", ctx.ip)
    return {"id": rx_id, "status": "APPROVED"}


def dispense(ctx):
    rx_id = int(ctx.params["id"])
    with db.tx() as con:
        rx = con.execute("SELECT * FROM prescriptions WHERE id=?", (rx_id,)).fetchone()
        if rx is None:
            raise not_found("处方不存在")
        if rx["status"] != "APPROVED":
            raise conflict("处方未审核通过，不可发药", "RX_NOT_REVIEWED")
        _require_visit_finished(con, rx["visit_id"])
        paid = con.execute(
            "SELECT 1 FROM charges WHERE ref_type='PRESCRIPTION' AND ref_id=? AND status='PAID'",
            (rx_id,)).fetchone()
        if paid is None:
            raise conflict("药品费尚未收取，不可发药", "RX_CHARGE_UNPAID")
        items = con.execute("SELECT * FROM prescription_items WHERE prescription_id=?",
                            (rx_id,)).fetchall()
        for item in items:
            cur = con.execute("UPDATE drugs SET stock=stock-? WHERE id=? AND stock>=?",
                              (item["quantity"], item["drug_id"], item["quantity"]))
            if cur.rowcount == 0:
                drug = con.execute("SELECT name, stock FROM drugs WHERE id=?",
                                   (item["drug_id"],)).fetchone()
                raise conflict(f"{drug['name']} 库存不足（现有 {drug['stock']}），发药失败",
                               "STOCK_INSUFFICIENT")
        con.execute("UPDATE prescriptions SET status='DISPENSED', dispensed_by=?, dispensed_at=? WHERE id=?",
                    (ctx.user.get("staff_id"), db.now_str(), rx_id))
        security.audit(con, ctx.user, "RX_DISPENSE", "prescription", rx_id,
                       f"items={len(items)}", "OK", ctx.ip)
    return {"id": rx_id, "status": "DISPENSED"}


def register(router):
    router.add("GET", r"/api/v1/drugs", list_drugs, perm="drug.read")
    router.add("POST", r"/api/v1/drugs/(?P<id>\d+)/stock-in", stock_in, perm="drug.stock")
    router.add("GET", r"/api/v1/prescriptions", list_prescriptions, perm="rx.read")
    router.add("POST", r"/api/v1/prescriptions/(?P<id>\d+)/review", review_prescription, perm="rx.review")
    router.add("POST", r"/api/v1/prescriptions/(?P<id>\d+)/dispense", dispense, perm="rx.dispense")
