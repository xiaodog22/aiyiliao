"""医技：检查申请列表、采样、报告录入与审核。"""

from __future__ import annotations

from .. import db, security
from ..errors import ApiError, conflict, not_found
from .common import as_str, require_fields


def list_items(ctx):
    return db.query("SELECT code, name, category, price, critical_low AS criticalLow, "
                    "critical_high AS criticalHigh FROM lab_items ORDER BY code")


def list_lab_orders(ctx):
    where, params = ["1=1"], []
    if ctx.q("status"):
        where.append("lo.status=?")
        params.append(ctx.q("status"))
    if ctx.q("date"):
        where.append("substr(lo.created_at,1,10)=?")
        params.append(ctx.q("date"))
    if ctx.q("patientId"):
        where.append("lo.patient_id=?")
        params.append(int(ctx.q("patientId")))
    if ctx.q("visitId"):
        where.append("lo.visit_id=?")
        params.append(int(ctx.q("visitId")))
    rows = db.query(
        "SELECT lo.*, p.name AS patient_name, p.mrn AS patient_mrn, s.name AS doctor_name, "
        "rb.name AS reporter_name "
        "FROM lab_orders lo JOIN patients p ON p.id=lo.patient_id JOIN staff s ON s.id=lo.doctor_id "
        "LEFT JOIN staff rb ON rb.id=lo.reported_by "
        "WHERE " + " AND ".join(where) + " ORDER BY lo.id DESC LIMIT 300", tuple(params))
    return [{
        "id": r["id"], "orderNo": r["order_no"], "visitId": r["visit_id"], "patientId": r["patient_id"],
        "patientName": security.mask_name(r["patient_name"]), "patientMrn": r["patient_mrn"],
        "doctorName": r["doctor_name"], "itemCode": r["item_code"], "itemName": r["item_name"],
        "price": r["price"], "status": r["status"], "sampledAt": r["sampled_at"],
        "findings": r["report_findings"], "conclusion": r["report_conclusion"],
        "abnormal": bool(r["abnormal"]), "critical": bool(r["critical"]),
        "reporterName": r["reporter_name"],
        "reportedAt": r["reported_at"], "createdAt": r["created_at"],
    } for r in rows]


def sample(ctx):
    order_id = int(ctx.params["id"])
    with db.tx() as con:
        row = con.execute("SELECT * FROM lab_orders WHERE id=?", (order_id,)).fetchone()
        if row is None:
            raise not_found("检查申请不存在")
        if row["status"] != "APPLIED":
            raise conflict("当前状态不可采样", "STATE_CONFLICT")
        con.execute("UPDATE lab_orders SET status='SAMPLED', sampled_at=? WHERE id=?",
                    (db.now_str(), order_id))
        security.audit(con, ctx.user, "LAB_SAMPLE", "lab_order", order_id, "", "OK", ctx.ip)
    return {"id": order_id, "status": "SAMPLED"}


def report(ctx):
    order_id = int(ctx.params["id"])
    require_fields(ctx.body, ["findings", "conclusion"])
    findings = as_str(ctx.body, "findings", required=True, max_len=2000)
    conclusion = as_str(ctx.body, "conclusion", required=True, max_len=500)
    abnormal = 1 if ctx.body.get("abnormal") in (True, 1, "1", "true") else 0
    value = None
    if ctx.body.get("value") not in (None, ""):
        try:
            value = float(ctx.body["value"])
        except (TypeError, ValueError):
            raise ApiError(400, "VALIDATION_FAILED", "value 必须为数字",
                           details=[{"field": "value", "reason": "类型错误"}])
    with db.tx() as con:
        row = con.execute("SELECT * FROM lab_orders WHERE id=?", (order_id,)).fetchone()
        if row is None:
            raise not_found("检查申请不存在")
        if row["status"] not in ("APPLIED", "SAMPLED"):
            raise conflict("当前状态不可录入报告", "STATE_CONFLICT")
        item = con.execute("SELECT * FROM lab_items WHERE code=?", (row["item_code"],)).fetchone()
        low, high = (item["critical_low"], item["critical_high"]) if item else (None, None)
        critical = 0
        if value is not None and (low is not None or high is not None):
            if (low is not None and value < low) or (high is not None and value > high):
                critical = 1
        con.execute(
            "UPDATE lab_orders SET status='REPORTED', report_findings=?, report_conclusion=?, "
            "abnormal=?, critical=?, reported_by=?, reported_at=? WHERE id=?",
            (findings, conclusion, abnormal, critical, ctx.user.get("staff_id"),
             db.now_str(), order_id))
        security.audit(con, ctx.user, "LAB_REPORT", "lab_order", order_id,
                       f"abnormal={abnormal} value={value if value is not None else '-'} critical={critical}",
                       "OK", ctx.ip)
        if critical:
            security.audit(con, ctx.user, "LAB_CRITICAL", "lab_order", order_id,
                           f"危急值 {row['item_name']}={value}（参考区间 {low}~{high}）",
                           "OK", ctx.ip)
    return {"id": order_id, "status": "REPORTED", "critical": bool(critical), "value": value}


def register(router):
    router.add("GET", r"/api/v1/lab-items", list_items, perm="lab.read")
    router.add("GET", r"/api/v1/lab-orders", list_lab_orders, perm="lab.read")
    router.add("POST", r"/api/v1/lab-orders/(?P<id>\d+)/sample", sample, perm="lab.report")
    router.add("POST", r"/api/v1/lab-orders/(?P<id>\d+)/report", report, perm="lab.report")
