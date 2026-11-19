"""留观床位与护理执行：床位看板、留观登记/转床/出区、医嘱执行、护理记录。"""

from __future__ import annotations

from .. import db, security
from ..errors import ApiError, conflict, not_found
from .clinical import _parse_vitals
from .common import as_int, as_list, as_str, one_of, require_fields

ORDER_TYPES = {"INFUSION", "INJECTION", "OBSERVE", "MEASURE"}
STAY_STATUS = {"IN", "OUT"}
BED_STATUS = {"FREE", "OCCUPIED", "CLEANING", "DISABLED"}


# ---------------------------------------------------------------- 通用

def _bed_by_id(con, bed_id: int):
    bed = con.execute("SELECT * FROM beds WHERE id=?", (bed_id,)).fetchone()
    if bed is None:
        raise not_found("床位不存在")
    return bed


def _stay_by_id(con, stay_id: int):
    stay = con.execute("SELECT * FROM bed_stays WHERE id=?", (stay_id,)).fetchone()
    if stay is None:
        raise not_found("留观记录不存在")
    return stay


def _patient_by_id(con, patient_id: int):
    patient = con.execute("SELECT * FROM patients WHERE id=?", (patient_id,)).fetchone()
    if patient is None:
        raise not_found("患者不存在")
    return patient


def _touch_bed(con, bed_id: int) -> None:
    con.execute("UPDATE beds SET updated_at=? WHERE id=?", (db.now_str(), bed_id))


def _stay_row(row) -> dict:
    return {
        "id": row["id"], "stayNo": row["stay_no"], "patientId": row["patient_id"],
        "patientName": security.mask_name(row["patient_name"]), "patientMrn": row["mrn"],
        "visitId": row["visit_id"], "bedId": row["bed_id"], "bedNo": row["bed_no"],
        "zone": row["zone"], "nursingLevel": row["nursing_level"], "diet": row["diet"],
        "diagnosis": row["diagnosis"], "status": row["status"], "inAt": row["in_at"],
        "outAt": row["out_at"], "outReason": row["out_reason"],
    }


def _order_row(row) -> dict:
    return {
        "id": row["id"], "stayId": row["stay_id"], "patientId": row["patient_id"],
        "orderType": row["order_type"], "content": row["content"], "dose": row["dose"],
        "route": row["route"], "frequency": row["frequency"], "status": row["status"],
        "orderedBy": row["ordered_by"], "orderedAt": row["ordered_at"],
        "executedAt": row["executed_at"], "remark": row["remark"],
    }


def _record_row(row) -> dict:
    return {
        "id": row["id"], "patientId": row["patient_id"], "stayId": row["stay_id"],
        "recordType": row["record_type"], "temperature": row["temperature"],
        "pulse": row["pulse"], "respiration": row["respiration"],
        "systolic": row["systolic"], "diastolic": row["diastolic"], "spo2": row["spo2"],
        "note": row["note"], "recordedBy": row["recorded_by"], "recordedAt": row["recorded_at"],
    }


# ---------------------------------------------------------------- 床位

def list_beds(ctx):
    rows = db.query(
        "SELECT b.*, bs.stay_no, bs.patient_id, bs.nursing_level, bs.in_at, "
        "p.name AS patient_name, p.mrn "
        "FROM beds b LEFT JOIN bed_stays bs ON bs.id=b.current_stay_id "
        "LEFT JOIN patients p ON p.id=bs.patient_id "
        "ORDER BY b.zone, b.bed_no")
    return [{
        "id": r["id"], "bedNo": r["bed_no"], "zone": r["zone"], "kind": r["kind"],
        "status": r["status"], "note": r["note"], "updatedAt": r["updated_at"],
        "stayId": r["current_stay_id"], "stayNo": r["stay_no"],
        "patientName": security.mask_name(r["patient_name"]) if r["patient_name"] else "",
        "patientMrn": r["mrn"] or "", "nursingLevel": r["nursing_level"] or "",
        "inAt": r["in_at"] or "",
    } for r in rows]


def clean_bed(ctx):
    bed_id = int(ctx.params["id"])
    with db.tx() as con:
        bed = _bed_by_id(con, bed_id)
        if bed["status"] != "CLEANING":
            raise conflict("仅保洁中的床位可以标记保洁完成", "STATE_CONFLICT")
        con.execute("UPDATE beds SET status='FREE', current_stay_id=NULL, updated_at=? WHERE id=?",
                    (db.now_str(), bed_id))
        security.audit(con, ctx.user, "bed.clean", "bed", bed_id,
                       f"bedNo={bed['bed_no']}", "OK", ctx.ip)
    return {"id": bed_id, "status": "FREE"}


# ---------------------------------------------------------------- 留观

def list_bed_stays(ctx):
    status = (ctx.q("status") or "").strip().upper()
    if status:
        one_of(status, STAY_STATUS, "status")
    where, params = [], []
    if status:
        where.append("bs.status=?")
        params.append(status)
    day = (ctx.q("date") or "").strip()
    if day:
        where.append("bs.in_at LIKE ?")
        params.append(day + "%")
    patient_id = (ctx.q("patientId") or "").strip()
    if patient_id:
        try:
            params.append(int(patient_id))
        except ValueError:
            raise ApiError(400, "VALIDATION_FAILED", "patientId 必须为整数")
        where.append("bs.patient_id=?")
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    rows = db.query(
        "SELECT bs.*, b.bed_no, b.zone, p.name AS patient_name, p.mrn "
        "FROM bed_stays bs JOIN beds b ON b.id=bs.bed_id JOIN patients p ON p.id=bs.patient_id "
        + clause + " ORDER BY bs.id DESC LIMIT 200", tuple(params))
    return [_stay_row(r) for r in rows]


def create_bed_stay(ctx):
    require_fields(ctx.body, ["patientId", "bedId"])
    patient_id = as_int(ctx.body, "patientId", required=True, minimum=1)
    bed_id = as_int(ctx.body, "bedId", required=True, minimum=1)
    visit_id = as_int(ctx.body, "visitId", default=0)
    nursing_level = as_str(ctx.body, "nursingLevel", max_len=20)
    diet = as_str(ctx.body, "diet", max_len=60)
    diagnosis = as_str(ctx.body, "diagnosis", max_len=200)
    with db.tx() as con:
        patient = _patient_by_id(con, patient_id)
        bed = _bed_by_id(con, bed_id)
        if bed["status"] != "FREE":
            raise ApiError(400, "BED_OCCUPIED", f"床位 {bed['bed_no']} 已被占用")
        if visit_id:
            visit = con.execute("SELECT * FROM visits WHERE id=?", (visit_id,)).fetchone()
            if visit is None:
                raise not_found("就诊记录不存在")
            if visit["patient_id"] != patient_id:
                raise conflict("就诊记录与患者不匹配", "STATE_CONFLICT")
        existing = con.execute("SELECT id FROM bed_stays WHERE patient_id=? AND status='IN'",
                               (patient_id,)).fetchone()
        if existing:
            raise conflict("该患者已在留观中，请先办理出区或转床", "PATIENT_IN_STAY")
        seq = db.next_sequence(con, "bed_stay")
        stay_no = f"OB{db.today_str().replace('-', '')}-{seq:04d}"
        now = db.now_str()
        cur = con.execute(
            "INSERT INTO bed_stays(stay_no,patient_id,visit_id,bed_id,nursing_level,diet,diagnosis,"
            "status,in_at,out_at,out_reason,created_by,created_at) "
            "VALUES (?,?,?,?,?,?,?,'IN',?,'','',?,?)",
            (stay_no, patient_id, visit_id or None, bed_id, nursing_level, diet, diagnosis,
             now, ctx.user.get("staff_id") or ctx.user["id"], now))
        stay_id = int(cur.lastrowid)
        cur = con.execute("UPDATE beds SET status='OCCUPIED', current_stay_id=?, updated_at=? "
                          "WHERE id=? AND status='FREE'",
                          (stay_id, now, bed_id))
        if cur.rowcount != 1:
            raise ApiError(400, "BED_OCCUPIED", f"床位 {bed['bed_no']} 已被占用")
        security.audit(con, ctx.user, "bed.create", "bed_stay", stay_id,
                       f"stayNo={stay_no} bed={bed['bed_no']} patient={patient['mrn']}", "OK", ctx.ip)
    return {"id": stay_id, "stayNo": stay_no, "bedId": bed_id, "status": "IN"}


def transfer_bed_stay(ctx):
    stay_id = int(ctx.params["id"])
    require_fields(ctx.body, ["bedId"])
    target_id = as_int(ctx.body, "bedId", required=True, minimum=1)
    with db.tx() as con:
        stay = _stay_by_id(con, stay_id)
        if stay["status"] != "IN":
            raise conflict("仅留观中的患者可以转床", "STATE_CONFLICT")
        target = _bed_by_id(con, target_id)
        if target["status"] != "FREE":
            raise conflict(f"目标床位 {target['bed_no']} 不可用", "BED_OCCUPIED")
        now = db.now_str()
        cur = con.execute("UPDATE beds SET status='OCCUPIED', current_stay_id=?, updated_at=? "
                          "WHERE id=? AND status='FREE'", (stay_id, now, target_id))
        if cur.rowcount != 1:
            raise ApiError(400, "BED_OCCUPIED", f"目标床位 {target['bed_no']} 已被占用")
        cur = con.execute("UPDATE beds SET status='FREE', current_stay_id=NULL, updated_at=? "
                          "WHERE id=? AND status='OCCUPIED' AND current_stay_id=?",
                          (now, stay["bed_id"], stay_id))
        if cur.rowcount != 1:
            raise ApiError(400, "BED_OCCUPIED", "原床位状态已变更，请刷新后重试")
        con.execute("UPDATE bed_stays SET bed_id=? WHERE id=?", (target_id, stay_id))
        old_bed = con.execute("SELECT bed_no FROM beds WHERE id=?", (stay["bed_id"],)).fetchone()
        security.audit(con, ctx.user, "bed.transfer", "bed_stay", stay_id,
                       f"stayNo={stay['stay_no']} {old_bed['bed_no']}->{target['bed_no']}", "OK", ctx.ip)
    return {"id": stay_id, "bedId": target_id, "bedNo": target["bed_no"]}


def discharge_bed_stay(ctx):
    stay_id = int(ctx.params["id"])
    reason = as_str(ctx.body, "reason", required=True, max_len=200)
    with db.tx() as con:
        stay = _stay_by_id(con, stay_id)
        if stay["status"] != "IN":
            raise conflict("该留观记录已出区", "STATE_CONFLICT")
        now = db.now_str()
        con.execute("UPDATE bed_stays SET status='OUT', out_at=?, out_reason=? WHERE id=?",
                    (now, reason, stay_id))
        con.execute("UPDATE beds SET status='CLEANING', current_stay_id=NULL, updated_at=? WHERE id=?",
                    (now, stay["bed_id"]))
        cancelled = con.execute(
            "UPDATE nursing_orders SET status='CANCELLED' WHERE stay_id=? AND status='PENDING'",
            (stay_id,)).rowcount
        security.audit(con, ctx.user, "bed.discharge", "bed_stay", stay_id,
                       f"stayNo={stay['stay_no']} reason={reason} cancelOrders={cancelled}", "OK", ctx.ip)
    return {"id": stay_id, "status": "OUT", "outReason": reason, "cancelledOrders": cancelled}


def get_bed_stay(ctx):
    stay_id = int(ctx.params["id"])
    row = db.query(
        "SELECT bs.*, b.bed_no, b.zone, p.name AS patient_name, p.mrn, p.gender, p.birth_date, "
        "p.allergy, p.chronic_tags FROM bed_stays bs JOIN beds b ON b.id=bs.bed_id "
        "JOIN patients p ON p.id=bs.patient_id WHERE bs.id=?", (stay_id,), one=True)
    if row is None:
        raise not_found("留观记录不存在")
    orders = db.query(
        "SELECT o.*, s.name AS ordered_by_name FROM nursing_orders o LEFT JOIN staff s ON s.id=o.ordered_by "
        "WHERE o.stay_id=? ORDER BY o.ordered_at, o.id", (stay_id,))
    records = db.query(
        "SELECT * FROM nursing_records WHERE patient_id=? ORDER BY recorded_at DESC, id DESC LIMIT 50",
        (row["patient_id"],))
    return {
        "stay": _stay_row(row),
        "patient": {
            "id": row["patient_id"], "mrn": row["mrn"], "name": security.mask_name(row["patient_name"]),
            "gender": row["gender"], "birthDate": row["birth_date"], "allergy": row["allergy"],
        },
        "bed": {"id": row["bed_id"], "bedNo": row["bed_no"], "zone": row["zone"]},
        "orders": [dict(_order_row(o), orderedByName=o["ordered_by_name"] or "") for o in orders],
        "records": [_record_row(r) for r in records],
    }


# ---------------------------------------------------------------- 医嘱

def create_nursing_orders(ctx):
    stay_id = int(ctx.params["id"])
    items = as_list(ctx.body, "items", required=True, max_items=20)
    if not items:
        raise ApiError(400, "VALIDATION_FAILED", "至少开立 1 条医嘱")
    with db.tx() as con:
        stay = _stay_by_id(con, stay_id)
        if stay["status"] != "IN":
            raise conflict("患者已出区，不能继续开立医嘱", "STATE_CONFLICT")
        now = db.now_str()
        created = []
        for item in items:
            if not isinstance(item, dict):
                raise ApiError(400, "VALIDATION_FAILED", "医嘱项必须为对象")
            order_type = as_str(item, "orderType", max_len=20) or "OBSERVE"
            one_of(order_type, ORDER_TYPES, "orderType")
            content = as_str(item, "content", required=True, max_len=200)
            dose = as_str(item, "dose", max_len=40)
            route = as_str(item, "route", max_len=40)
            frequency = as_str(item, "frequency", max_len=40)
            cur = con.execute(
                "INSERT INTO nursing_orders(stay_id,patient_id,order_type,content,dose,route,frequency,"
                "status,ordered_by,ordered_at,executed_by,executed_at,remark) "
                "VALUES (?,?,?,?,?,?,?,'PENDING',?,?,NULL,'','')",
                (stay_id, stay["patient_id"], order_type, content, dose, route, frequency,
                 ctx.user.get("staff_id") or ctx.user["id"], now))
            created.append({"id": int(cur.lastrowid), "orderType": order_type, "content": content})
        security.audit(con, ctx.user, "nursing.order.create", "bed_stay", stay_id,
                       f"stayNo={stay['stay_no']} count={len(created)}", "OK", ctx.ip)
    return {"orders": created}


def execute_nursing_order(ctx):
    order_id = int(ctx.params["id"])
    remark = as_str(ctx.body or {}, "remark", max_len=200)
    with db.tx() as con:
        order = con.execute("SELECT * FROM nursing_orders WHERE id=?", (order_id,)).fetchone()
        if order is None:
            raise not_found("医嘱不存在")
        if order["status"] != "PENDING":
            raise ApiError(400, "STATE_CONFLICT", "该医嘱已执行或已取消，不能重复执行")
        now = db.now_str()
        con.execute("UPDATE nursing_orders SET status='DONE', executed_by=?, executed_at=?, remark=? "
                    "WHERE id=?",
                    (ctx.user.get("staff_id") or ctx.user["id"], now, remark, order_id))
        security.audit(con, ctx.user, "nursing.order.execute", "nursing_order", order_id,
                       f"content={order['content']}", "OK", ctx.ip)
    return {"id": order_id, "status": "DONE", "executedAt": now}


def cancel_nursing_order(ctx):
    order_id = int(ctx.params["id"])
    with db.tx() as con:
        order = con.execute("SELECT * FROM nursing_orders WHERE id=?", (order_id,)).fetchone()
        if order is None:
            raise not_found("医嘱不存在")
        if order["status"] != "PENDING":
            raise conflict("仅待执行医嘱可以取消", "STATE_CONFLICT")
        con.execute("UPDATE nursing_orders SET status='CANCELLED' WHERE id=?", (order_id,))
        security.audit(con, ctx.user, "nursing.order.cancel", "nursing_order", order_id,
                       f"content={order['content']}", "OK", ctx.ip)
    return {"id": order_id, "status": "CANCELLED"}


def list_nursing_tasks(ctx):
    status = (ctx.q("status") or "PENDING").strip().upper()
    one_of(status, {"PENDING", "DONE", "CANCELLED"}, "status")
    where, params = ["o.status=?"], [status]
    day = (ctx.q("date") or "").strip()
    if day:
        where.append("o.ordered_at LIKE ?")
        params.append(day + "%")
    rows = db.query(
        "SELECT o.*, bs.stay_no, b.bed_no, b.zone, p.name AS patient_name, p.mrn, "
        "s.name AS ordered_by_name "
        "FROM nursing_orders o JOIN bed_stays bs ON bs.id=o.stay_id JOIN beds b ON b.id=bs.bed_id "
        "JOIN patients p ON p.id=o.patient_id LEFT JOIN staff s ON s.id=o.ordered_by "
        "WHERE " + " AND ".join(where) + " ORDER BY o.ordered_at, o.id LIMIT 200", tuple(params))
    return [dict(_order_row(r), stayNo=r["stay_no"], bedNo=r["bed_no"], zone=r["zone"],
                 patientName=security.mask_name(r["patient_name"]), patientMrn=r["mrn"],
                 orderedByName=r["ordered_by_name"] or "") for r in rows]


# ---------------------------------------------------------------- 护理记录

def list_nursing_records(ctx):
    where, params = [], []
    patient_id = (ctx.q("patientId") or "").strip()
    if patient_id:
        try:
            params.append(int(patient_id))
        except ValueError:
            raise ApiError(400, "VALIDATION_FAILED", "patientId 必须为整数")
        where.append("r.patient_id=?")
    stay_id = (ctx.q("stayId") or "").strip()
    if stay_id:
        try:
            params.append(int(stay_id))
        except ValueError:
            raise ApiError(400, "VALIDATION_FAILED", "stayId 必须为整数")
        where.append("r.stay_id=?")
    try:
        limit = int(ctx.q("limit") or 50)
    except ValueError:
        raise ApiError(400, "VALIDATION_FAILED", "limit 必须为整数")
    limit = max(1, min(limit, 200))
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    rows = db.query(
        "SELECT r.*, s.name AS recorder_name FROM nursing_records r LEFT JOIN staff s ON s.id=r.recorded_by "
        + clause + " ORDER BY r.recorded_at DESC, r.id DESC LIMIT ?", tuple(params + [limit]))
    return [dict(_record_row(r), recorderName=r["recorder_name"] or "") for r in rows]


def create_nursing_record(ctx):
    require_fields(ctx.body, ["patientId"])
    patient_id = as_int(ctx.body, "patientId", required=True, minimum=1)
    stay_id = as_int(ctx.body, "stayId", default=0)
    note = as_str(ctx.body, "note", max_len=500)
    vitals = _parse_vitals(ctx.body)
    if not vitals and not note:
        raise ApiError(400, "VALIDATION_FAILED", "请至少填写一项体征或护理记录")
    with db.tx() as con:
        _patient_by_id(con, patient_id)
        if stay_id:
            stay = _stay_by_id(con, stay_id)
            if stay["patient_id"] != patient_id:
                raise conflict("留观记录与患者不匹配", "STATE_CONFLICT")
            if stay["status"] != "IN":
                raise ApiError(400, "STATE_CONFLICT", "该留观记录已出区，不可补录护理记录")
        record_type = "VITALS" if vitals else "NOTE"
        cur = con.execute(
            "INSERT INTO nursing_records(patient_id,stay_id,record_type,temperature,pulse,respiration,"
            "systolic,diastolic,spo2,note,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (patient_id, stay_id or None, record_type, vitals.get("temperature"), vitals.get("pulse"),
             vitals.get("respiration"), vitals.get("systolic"), vitals.get("diastolic"),
             vitals.get("spo2"), note, ctx.user.get("staff_id") or ctx.user["id"], db.now_str()))
        record_id = int(cur.lastrowid)
        security.audit(con, ctx.user, "nursing.record.create", "nursing_record", record_id,
                       f"patient={patient_id} type={record_type}", "OK", ctx.ip)
    row = db.query("SELECT * FROM nursing_records WHERE id=?", (record_id,), one=True)
    return _record_row(row)


# ---------------------------------------------------------------- 路由

def register(router):
    router.add("GET", r"/api/v1/beds", list_beds, perm="bed.read")
    router.add("POST", r"/api/v1/beds/(?P<id>\d+)/clean", clean_bed, perm="bed.write")
    router.add("GET", r"/api/v1/bed-stays", list_bed_stays, perm="nursing.read")
    router.add("POST", r"/api/v1/bed-stays", create_bed_stay, perm="bed.write")
    router.add("GET", r"/api/v1/bed-stays/(?P<id>\d+)", get_bed_stay, perm="nursing.read")
    router.add("POST", r"/api/v1/bed-stays/(?P<id>\d+)/transfer", transfer_bed_stay, perm="bed.write")
    router.add("POST", r"/api/v1/bed-stays/(?P<id>\d+)/discharge", discharge_bed_stay, perm="bed.write")
    router.add("POST", r"/api/v1/bed-stays/(?P<id>\d+)/orders", create_nursing_orders, perm="bed.write")
    router.add("POST", r"/api/v1/nursing-orders/(?P<id>\d+)/execute",
               execute_nursing_order, perm="nursing.write")
    router.add("POST", r"/api/v1/nursing-orders/(?P<id>\d+)/cancel",
               cancel_nursing_order, perm="bed.write")
    router.add("GET", r"/api/v1/nursing-tasks", list_nursing_tasks, perm="nursing.read")
    router.add("GET", r"/api/v1/nursing-records", list_nursing_records, perm="nursing.read")
    router.add("POST", r"/api/v1/nursing-records", create_nursing_record, perm="nursing.write")
