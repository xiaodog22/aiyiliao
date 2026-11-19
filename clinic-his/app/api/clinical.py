"""医生工作站：接诊、病历、诊断、处方开具、检查申请、完成与更正留痕。"""

from __future__ import annotations

import json

from .. import db, security
from ..errors import ApiError, conflict, forbidden, not_found
from .common import as_int, as_list, as_str, parse_vitals, require_fields


def _owner_check(visit, user: dict) -> None:
    if user["role"] == "ADMIN":
        return
    if visit["doctor_id"] != user.get("staff_id"):
        raise forbidden("仅接诊医生可操作本病历")


def _read_check(visit, user: dict) -> None:
    """病历读取权限：visit.read.all / patient.read.all 岗位，或本人接诊医生。"""
    if {"visit.read.all", "patient.read.all"} & set(user["perms"]):
        return
    if user["role"] == "DOCTOR" and visit["doctor_id"] != user.get("staff_id"):
        raise forbidden("仅可查看本人接诊病历")


VITALS_RANGES = {
    "temperature": (30, 45, "体温"),
    "pulse": (20, 250, "脉搏"),
    "respiration": (5, 60, "呼吸"),
    "systolic": (50, 300, "收缩压"),
    "diastolic": (20, 200, "舒张压"),
    "spo2": (50, 100, "血氧"),
}


def _parse_vitals(body: dict) -> dict:
    return parse_vitals(body)


def _load_json(raw: str) -> dict:
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


def _sync_primary_diagnosis(con, visit_id: int) -> None:
    """把 visit_diagnoses 的主诊断同步到 visits 冗余字段（兼容今日列表/报表/打印）。"""
    row = con.execute(
        "SELECT * FROM visit_diagnoses WHERE visit_id=? ORDER BY is_primary DESC, sort_no, id LIMIT 1",
        (visit_id,)).fetchone()
    if row is None:
        con.execute("UPDATE visits SET diagnosis_code='', diagnosis_name='', diagnosis_note='' WHERE id=?",
                    (visit_id,))
    else:
        con.execute("UPDATE visits SET diagnosis_code=?, diagnosis_name=?, diagnosis_note=? WHERE id=?",
                    (row["code"], row["name"], row["note"], visit_id))


def _diagnosis_rows(visit_id: int) -> list:
    rows = db.query(
        "SELECT * FROM visit_diagnoses WHERE visit_id=? ORDER BY is_primary DESC, sort_no, id",
        (visit_id,))
    return [{
        "id": r["id"], "code": r["code"], "name": r["name"],
        "isPrimary": bool(r["is_primary"]), "suspected": bool(r["suspected"]),
        "sortNo": r["sort_no"], "note": r["note"],
    } for r in rows]


def _load_visit(con, visit_id: int):
    row = con.execute("SELECT * FROM visits WHERE id=?", (visit_id,)).fetchone()
    if row is None:
        raise not_found("就诊记录不存在")
    return row


# ---------------------------------------------------------------- 列表与详情

def list_visits(ctx):
    date = ctx.q("date") or db.today_str()
    where, params = ["v.visit_date=?"], [date]
    if "visit.read.all" not in ctx.user["perms"] or ctx.q("mine") == "1":
        where.append("v.doctor_id=?")
        params.append(ctx.user.get("staff_id") or 0)
    if ctx.q("status"):
        where.append("v.status=?")
        params.append(ctx.q("status"))
    if ctx.q("doctorId") and "visit.read.all" in ctx.user["perms"]:
        where.append("v.doctor_id=?")
        params.append(int(ctx.q("doctorId")))
    rows = db.query(
        "SELECT v.*, p.name AS patient_name, p.mrn AS patient_mrn, p.gender AS patient_gender, "
        "p.allergy, s.name AS doctor_name, d.name AS dept_name, r.queue_no "
        "FROM visits v JOIN patients p ON p.id=v.patient_id JOIN staff s ON s.id=v.doctor_id "
        "JOIN departments d ON d.id=v.dept_id JOIN registrations r ON r.id=v.registration_id "
        "WHERE " + " AND ".join(where) + " ORDER BY v.id DESC LIMIT 200", tuple(params))
    return [{
        "id": r["id"], "visitNo": r["visit_no"], "patientId": r["patient_id"],
        "patientName": security.mask_name(r["patient_name"]), "patientMrn": r["patient_mrn"],
        "patientGender": r["patient_gender"], "allergy": r["allergy"],
        "doctorId": r["doctor_id"], "doctorName": r["doctor_name"], "deptName": r["dept_name"],
        "queueNo": r["queue_no"], "visitDate": r["visit_date"], "status": r["status"],
        "chiefComplaint": r["chief_complaint"], "diagnosisCode": r["diagnosis_code"],
        "diagnosisName": r["diagnosis_name"], "startedAt": r["started_at"],
        "finishedAt": r["finished_at"],
    } for r in rows]


def start_visit(ctx):
    require_fields(ctx.body, ["registrationId"])
    reg_id = as_int(ctx.body, "registrationId", required=True, minimum=1)
    with db.tx() as con:
        reg = con.execute("SELECT * FROM registrations WHERE id=?", (reg_id,)).fetchone()
        if reg is None:
            raise not_found("挂号记录不存在")
        if reg["status"] != "CHECKED_IN":
            raise conflict("患者未签到或已开始接诊", "STATE_CONFLICT")
        if ctx.user["role"] != "ADMIN" and reg["doctor_id"] != ctx.user.get("staff_id"):
            raise forbidden()
        existing = con.execute("SELECT id FROM visits WHERE registration_id=?", (reg_id,)).fetchone()
        if existing:
            raise conflict("该挂号已创建病历", "STATE_CONFLICT")
        compact = reg["reg_date"].replace("-", "")
        seq = db.next_sequence(con, "visit-" + compact)
        visit_no = f"VS{compact}-{seq:04d}"
        cur = con.execute(
            "INSERT INTO visits(visit_no,registration_id,patient_id,doctor_id,dept_id,visit_date,status,version,started_at) "
            "VALUES (?,?,?,?,?,?, 'IN_PROGRESS', 1, ?)",
            (visit_no, reg_id, reg["patient_id"], reg["doctor_id"], reg["dept_id"],
             reg["reg_date"], db.now_str()))
        visit_id = int(cur.lastrowid)
        con.execute("UPDATE registrations SET status='IN_PROGRESS' WHERE id=?", (reg_id,))
        con.execute("UPDATE queue_tickets SET status='SERVING' "
                    "WHERE registration_id=? AND status IN ('WAITING','CALLED')", (reg_id,))
        security.audit(con, ctx.user, "VISIT_START", "visit", visit_id,
                       f"reg={reg_id}", "OK", ctx.ip)
    return {"id": visit_id, "visitNo": visit_no, "status": "IN_PROGRESS"}


def _rx_items(visit_id: int) -> list:
    rows = db.query(
        "SELECT pi.*, p.status AS rx_status, p.rx_no FROM prescription_items pi "
        "JOIN prescriptions p ON p.id=pi.prescription_id WHERE p.visit_id=? ORDER BY pi.id",
        (visit_id,))
    return [{
        "drugId": r["drug_id"], "drugName": r["drug_name"], "spec": r["spec"],
        "dosage": r["dosage"], "frequency": r["frequency"], "days": r["days"],
        "quantity": r["quantity"], "unitPrice": r["unit_price"], "amount": r["amount"],
        "rxNo": r["rx_no"], "rxStatus": r["rx_status"],
    } for r in rows]


def get_visit(ctx):
    visit_id = int(ctx.params["id"])
    visit = db.query("SELECT * FROM visits WHERE id=?", (visit_id,), one=True)
    if visit is None:
        raise not_found("就诊记录不存在")
    _read_check(visit, ctx.user)
    detail = db.query(
        "SELECT v.*, p.name AS patient_name, p.mrn, p.gender, p.birth_date, p.phone_mask, "
        "p.allergy, p.chronic_tags, p.address, s.name AS doctor_name, s.title AS doctor_title, "
        "d.name AS dept_name, r.vitals_json AS reg_vitals_json, r.queue_no, r.reg_no "
        "FROM visits v JOIN patients p ON p.id=v.patient_id JOIN staff s ON s.id=v.doctor_id "
        "JOIN departments d ON d.id=v.dept_id JOIN registrations r ON r.id=v.registration_id "
        "WHERE v.id=?", (visit_id,), one=True)
    try:
        chronic = json.loads(detail["chronic_tags"] or "[]")
    except ValueError:
        chronic = []
    # 体征：注册（分诊签到）录入值 + 病历补录值，后者优先覆盖同名项
    reg_vitals = _load_json(detail["reg_vitals_json"])
    doctor_vitals = {k: v for k, v in _load_json(detail["vitals_json"]).items() if v not in (None, "")}
    vitals = dict(reg_vitals)
    vitals.update(doctor_vitals)
    if reg_vitals and doctor_vitals:
        vitals_source = "MERGED"
    elif doctor_vitals:
        vitals_source = "DOCTOR"
    elif reg_vitals:
        vitals_source = "CHECKIN"
    else:
        vitals_source = ""
    prescriptions = db.query(
        "SELECT p.*, s.name AS doctor_name, rv.name AS reviewer_name, dp.name AS dispenser_name "
        "FROM prescriptions p JOIN staff s ON s.id=p.doctor_id "
        "LEFT JOIN staff rv ON rv.id=p.reviewer_id LEFT JOIN staff dp ON dp.id=p.dispensed_by "
        "WHERE p.visit_id=? ORDER BY p.id", (visit_id,))
    labs = db.query("SELECT * FROM lab_orders WHERE visit_id=? ORDER BY id", (visit_id,))
    amendments = db.query(
        "SELECT a.*, s.name AS amended_by_name FROM emr_amendments a "
        "JOIN staff s ON s.id=a.amended_by WHERE a.visit_id=? ORDER BY a.id", (visit_id,))
    with db.tx() as con:
        security.audit(con, ctx.user, "VISIT_VIEW", "visit", visit_id,
                       f"patient={detail['mrn']}", "OK", ctx.ip)
    stay = db.query(
        "SELECT bs.*, b.bed_no, b.zone FROM bed_stays bs JOIN beds b ON b.id=bs.bed_id "
        "WHERE bs.patient_id=? AND bs.status='IN' ORDER BY bs.id DESC LIMIT 1",
        (detail["patient_id"],), one=True)
    return {
        "id": detail["id"], "visitNo": detail["visit_no"], "registrationId": detail["registration_id"],
        "status": detail["status"], "version": detail["version"], "visitDate": detail["visit_date"],
        "patient": {
            "id": detail["patient_id"], "mrn": detail["mrn"], "name": detail["patient_name"],
            "gender": detail["gender"], "birthDate": detail["birth_date"],
            "phoneMask": detail["phone_mask"], "address": detail["address"],
            "allergy": detail["allergy"], "chronicTags": chronic,
        },
        "doctorName": detail["doctor_name"], "doctorTitle": detail["doctor_title"],
        "deptName": detail["dept_name"], "queueNo": detail["queue_no"], "regNo": detail["reg_no"],
        "vitals": vitals, "vitalsSource": vitals_source,
        "chiefComplaint": detail["chief_complaint"], "presentIllness": detail["present_illness"],
        "pastHistory": detail["past_history"], "physicalExam": detail["physical_exam"],
        "allergyHistory": detail["allergy_history"], "auxiliaryExam": detail["auxiliary_exam"],
        "diagnosisCode": detail["diagnosis_code"], "diagnosisName": detail["diagnosis_name"],
        "diagnosisNote": detail["diagnosis_note"], "treatmentAdvice": detail["treatment_advice"],
        "signedBy": detail["signed_by"], "signedAt": detail["signed_at"],
        "diagnoses": _diagnosis_rows(visit_id),
        "bedStay": {
            "id": stay["id"], "stayNo": stay["stay_no"], "bedNo": stay["bed_no"],
            "zone": stay["zone"], "nursingLevel": stay["nursing_level"], "diet": stay["diet"],
            "diagnosis": stay["diagnosis"], "inAt": stay["in_at"],
        } if stay else None,
        "startedAt": detail["started_at"], "finishedAt": detail["finished_at"],
        "prescriptions": [{
            "id": r["id"], "rxNo": r["rx_no"], "status": r["status"], "totalAmount": r["total_amount"],
            "reviewComment": r["review_comment"], "reviewerName": r["reviewer_name"],
            "reviewedAt": r["reviewed_at"], "dispensedAt": r["dispensed_at"],
        } for r in prescriptions],
        "rxItems": _rx_items(visit_id),
        "labOrders": [{
            "id": r["id"], "orderNo": r["order_no"], "itemCode": r["item_code"],
            "itemName": r["item_name"], "price": r["price"], "status": r["status"],
            "findings": r["report_findings"], "conclusion": r["report_conclusion"],
            "abnormal": bool(r["abnormal"]), "critical": bool(r["critical"]),
            "reportedAt": r["reported_at"],
        } for r in labs],
        "amendments": [{
            "reason": r["reason"], "amendedBy": r["amended_by_name"], "amendedAt": r["amended_at"],
        } for r in amendments],
    }


def visit_reports(ctx):
    """该次就诊的检查报告列表（perm=lab.read；结论文本受 clinical.read 约束）。"""
    visit_id = int(ctx.params["id"])
    visit = db.query("SELECT * FROM visits WHERE id=?", (visit_id,), one=True)
    if visit is None:
        raise not_found("就诊记录不存在")
    _read_check(visit, ctx.user)
    full = "clinical.read" in set(ctx.user["perms"])
    rows = db.query(
        "SELECT lo.*, rb.name AS reporter_name FROM lab_orders lo "
        "LEFT JOIN staff rb ON rb.id=lo.reported_by WHERE lo.visit_id=? ORDER BY lo.id",
        (visit_id,))
    return [{
        "id": r["id"], "orderNo": r["order_no"], "itemCode": r["item_code"],
        "itemName": r["item_name"], "status": r["status"],
        "findings": r["report_findings"] if full else "",
        "conclusion": r["report_conclusion"] if full else "",
        "abnormal": bool(r["abnormal"]), "critical": bool(r["critical"]),
        "reporterName": r["reporter_name"], "sampledAt": r["sampled_at"],
        "reportedAt": r["reported_at"],
    } for r in rows]


EDITABLE_FIELDS = {
    "chiefComplaint": "chief_complaint",
    "presentIllness": "present_illness",
    "pastHistory": "past_history",
    "allergyHistory": "allergy_history",
    "physicalExam": "physical_exam",
    "auxiliaryExam": "auxiliary_exam",
    "treatmentAdvice": "treatment_advice",
    "diagnosisNote": "diagnosis_note",
}


def update_visit(ctx):
    visit_id = int(ctx.params["id"])
    body = ctx.body
    unknown = [k for k in body if k not in EDITABLE_FIELDS]
    if unknown:
        raise ApiError(400, "VALIDATION_FAILED", "请求包含未知字段：" + "、".join(unknown))
    with db.tx() as con:
        visit = _load_visit(con, visit_id)
        _owner_check(visit, ctx.user)
        if visit["status"] != "IN_PROGRESS":
            raise conflict("病历已完成，修改须提交更正留痕", "EMR_LOCKED")
        sets, params = [], []
        for key, column in EDITABLE_FIELDS.items():
            if key in body:
                value = as_str(body, key, max_len=2000)
                sets.append(f"{column}=?")
                params.append(value)
        if not sets:
            raise ApiError(400, "VALIDATION_FAILED", "没有可更新的字段")
        sets.append("version=version+1")
        params.append(visit_id)
        con.execute("UPDATE visits SET " + ",".join(sets) + " WHERE id=?", tuple(params))
        security.audit(con, ctx.user, "VISIT_UPDATE", "visit", visit_id,
                       "fields=" + ",".join(k for k in EDITABLE_FIELDS if k in body), "OK", ctx.ip)
    return {"updated": True}


# ---------------------------------------------------------------- 诊断与公卫任务

def _ensure_ph_task(con, task_type: str, patient_id: int, visit_id: int, title: str,
                    detail: str, due_at: str) -> None:
    exists = con.execute(
        "SELECT 1 FROM ph_tasks WHERE visit_id=? AND type=? AND status='OPEN'",
        (visit_id, task_type)).fetchone()
    if exists:
        return
    seq = db.next_sequence(con, "ph")
    task_no = f"PH{db.today_str().replace('-', '')}-{seq:05d}"
    con.execute(
        "INSERT INTO ph_tasks(task_no,type,patient_id,visit_id,title,detail,due_at,status,created_at) "
        "VALUES (?,?,?,?,?,?,?, 'OPEN', ?)",
        (task_no, task_type, patient_id, visit_id, title, detail, due_at, db.now_str()))


def diagnose(ctx):
    """旧接口（保留兼容）：写入 visit_diagnoses 主诊断并同步 visits 冗余字段。"""
    visit_id = int(ctx.params["id"])
    require_fields(ctx.body, ["code"])
    code = as_str(ctx.body, "code", required=True, max_len=20)
    note = as_str(ctx.body, "note", max_len=500)
    with db.tx() as con:
        visit = _load_visit(con, visit_id)
        _owner_check(visit, ctx.user)
        if visit["status"] != "IN_PROGRESS":
            raise conflict("病历已完成，不可直接修改诊断", "EMR_LOCKED")
        icd = con.execute("SELECT * FROM icd10 WHERE code=?", (code,)).fetchone()
        if icd is None:
            raise not_found("ICD-10 诊断编码不存在")
        con.execute("UPDATE visit_diagnoses SET is_primary=0 WHERE visit_id=?", (visit_id,))
        existing = con.execute("SELECT id FROM visit_diagnoses WHERE visit_id=? AND code=?",
                               (visit_id, code)).fetchone()
        if existing:
            con.execute("UPDATE visit_diagnoses SET name=?, note=?, is_primary=1 WHERE id=?",
                        (icd["name"], note, existing["id"]))
        else:
            sort_row = con.execute("SELECT COALESCE(MAX(sort_no),0) AS m FROM visit_diagnoses WHERE visit_id=?",
                                   (visit_id,)).fetchone()
            con.execute(
                "INSERT INTO visit_diagnoses(visit_id,code,name,is_primary,suspected,sort_no,note,created_by,created_at) "
                "VALUES (?,?,?,1,0,?,?,?,?)",
                (visit_id, code, icd["name"], int(sort_row["m"]) + 1, note,
                 ctx.user.get("staff_id") or ctx.user["id"], db.now_str()))
        con.execute("UPDATE visits SET version=version+1 WHERE id=?", (visit_id,))
        _sync_primary_diagnosis(con, visit_id)
        _ensure_diagnosis_ph_tasks(con, icd, visit, visit_id)
        security.audit(con, ctx.user, "DIAGNOSE", "visit", visit_id, f"icd={code}", "OK", ctx.ip)
    return {"diagnosisCode": code, "diagnosisName": icd["name"]}


def _ensure_diagnosis_ph_tasks(con, icd, visit, visit_id: int) -> None:
    if icd["infectious"]:
        _ensure_ph_task(con, "INFECTION", visit["patient_id"], visit_id,
                        f"法定传染病上报：{icd['name']}",
                        f"诊断编码 {icd['code']}，须在 24 小时内完成上报", db.now_after(hours=24))
    if icd["chronic"]:
        _ensure_ph_task(con, "CHRONIC_FOLLOWUP", visit["patient_id"], visit_id,
                        f"慢病随访：{icd['name']}",
                        f"诊断编码 {icd['code']}，纳入慢病管理", db.now_after(days=7))


# ---------------------------------------------------------------- 诊断主/次（visit_diagnoses）

def list_visit_diagnoses(ctx):
    visit_id = int(ctx.params["id"])
    visit = db.query("SELECT * FROM visits WHERE id=?", (visit_id,), one=True)
    if visit is None:
        raise not_found("就诊记录不存在")
    _read_check(visit, ctx.user)
    return _diagnosis_rows(visit_id)


def add_visit_diagnosis(ctx):
    visit_id = int(ctx.params["id"])
    require_fields(ctx.body, ["code"])
    body = ctx.body
    code = as_str(body, "code", required=True, max_len=20)
    note = as_str(body, "note", max_len=500)
    name = as_str(body, "name", max_len=100)
    suspected = 1 if body.get("suspected") else 0
    is_primary = bool(body.get("isPrimary"))

    with db.tx() as con:
        visit = _load_visit(con, visit_id)
        _owner_check(visit, ctx.user)
        if visit["status"] != "IN_PROGRESS":
            raise conflict("病历已完成，不可修改诊断", "EMR_LOCKED")
        icd = con.execute("SELECT * FROM icd10 WHERE code=?", (code,)).fetchone()
        if icd is None and not name:
            raise not_found("ICD-10 诊断编码不存在")
        diag_name = name or icd["name"]

        existing = con.execute("SELECT * FROM visit_diagnoses WHERE visit_id=? AND code=?",
                               (visit_id, code)).fetchone()
        count = con.execute("SELECT COUNT(*) AS c FROM visit_diagnoses WHERE visit_id=?",
                            (visit_id,)).fetchone()["c"]
        # 首条诊断自动设为主诊断，保证“完成就诊”可通过
        if count == 0:
            is_primary = True
        if is_primary:
            con.execute("UPDATE visit_diagnoses SET is_primary=0 WHERE visit_id=?", (visit_id,))
        if existing:
            con.execute(
                "UPDATE visit_diagnoses SET name=?, suspected=?, note=?, is_primary=? WHERE id=?",
                (diag_name, suspected,
                 note if "note" in body else existing["note"],
                 1 if is_primary else existing["is_primary"], existing["id"]))
            diag_id = existing["id"]
        else:
            sort_row = con.execute("SELECT COALESCE(MAX(sort_no),0) AS m FROM visit_diagnoses WHERE visit_id=?",
                                   (visit_id,)).fetchone()
            cur = con.execute(
                "INSERT INTO visit_diagnoses(visit_id,code,name,is_primary,suspected,sort_no,note,created_by,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (visit_id, code, diag_name, 1 if is_primary else 0, suspected,
                 int(sort_row["m"]) + 1, note, ctx.user.get("staff_id") or ctx.user["id"], db.now_str()))
            diag_id = int(cur.lastrowid)
        con.execute("UPDATE visits SET version=version+1 WHERE id=?", (visit_id,))
        _sync_primary_diagnosis(con, visit_id)
        if icd is not None:
            _ensure_diagnosis_ph_tasks(con, icd, visit, visit_id)
        security.audit(con, ctx.user, "DIAG_ADD", "visit", visit_id,
                       f"icd={code} primary={1 if is_primary else 0}", "OK", ctx.ip)
    return {"id": diag_id, "diagnoses": _diagnosis_rows(visit_id)}


def delete_visit_diagnosis(ctx):
    visit_id = int(ctx.params["id"])
    diag_id = int(ctx.params["did"])
    with db.tx() as con:
        visit = _load_visit(con, visit_id)
        _owner_check(visit, ctx.user)
        if visit["status"] != "IN_PROGRESS":
            raise conflict("病历已完成，不可修改诊断", "EMR_LOCKED")
        row = con.execute("SELECT * FROM visit_diagnoses WHERE id=? AND visit_id=?",
                          (diag_id, visit_id)).fetchone()
        if row is None:
            raise not_found("诊断记录不存在")
        con.execute("DELETE FROM visit_diagnoses WHERE id=?", (diag_id,))
        if row["is_primary"]:
            promoted = con.execute(
                "SELECT id FROM visit_diagnoses WHERE visit_id=? ORDER BY sort_no, id LIMIT 1",
                (visit_id,)).fetchone()
            if promoted:
                con.execute("UPDATE visit_diagnoses SET is_primary=1 WHERE id=?", (promoted["id"],))
        con.execute("UPDATE visits SET version=version+1 WHERE id=?", (visit_id,))
        _sync_primary_diagnosis(con, visit_id)
        security.audit(con, ctx.user, "DIAG_DELETE", "visit", visit_id,
                       f"diag={diag_id} code={row['code']}", "OK", ctx.ip)
    return {"deleted": True, "diagnoses": _diagnosis_rows(visit_id)}


# ---------------------------------------------------------------- 体征补录

def record_visit_vitals(ctx):
    visit_id = int(ctx.params["id"])
    vitals = _parse_vitals(ctx.body or {})
    if not vitals:
        raise ApiError(400, "VALIDATION_FAILED", "请至少录入一项生命体征")
    with db.tx() as con:
        visit = _load_visit(con, visit_id)
        _owner_check(visit, ctx.user)
        if visit["status"] != "IN_PROGRESS":
            raise conflict("病历已完成，不可补录体征", "EMR_LOCKED")
        merged = _load_json(visit["vitals_json"])
        merged.update(vitals)
        con.execute("UPDATE visits SET vitals_json=?, version=version+1 WHERE id=?",
                    (json.dumps(merged, ensure_ascii=False), visit_id))
        # 体温单留痕（门诊补录不关联留观）
        con.execute(
            "INSERT INTO nursing_records(patient_id,stay_id,record_type,temperature,pulse,respiration,"
            "systolic,diastolic,spo2,note,recorded_by,recorded_at) "
            "VALUES (?,NULL,'VITALS',?,?,?,?,?,?,?,?,?)",
            (visit["patient_id"], vitals.get("temperature"), vitals.get("pulse"),
             vitals.get("respiration"), vitals.get("systolic"), vitals.get("diastolic"),
             vitals.get("spo2"), "医生补录", ctx.user.get("staff_id") or ctx.user["id"], db.now_str()))
        security.audit(con, ctx.user, "VISIT_VITALS", "visit", visit_id,
                       "fields=" + ",".join(vitals.keys()), "OK", ctx.ip)
    return {"vitals": merged}


# ---------------------------------------------------------------- 处方

def create_prescription(ctx):
    visit_id = int(ctx.params["id"])
    items = as_list(ctx.body, "items", required=True, max_items=20)
    if not items:
        raise ApiError(400, "VALIDATION_FAILED", "处方至少包含 1 种药品")
    with db.tx() as con:
        visit = _load_visit(con, visit_id)
        _owner_check(visit, ctx.user)
        if visit["status"] != "IN_PROGRESS":
            raise conflict("病历已完成，不可新开处方", "EMR_LOCKED")
        doctor = con.execute("SELECT * FROM staff WHERE id=?", (visit["doctor_id"],)).fetchone()
        pres_level = int(doctor["pres_level"] if doctor else 1)
        patient = con.execute("SELECT allergy FROM patients WHERE id=?", (visit["patient_id"],)).fetchone()
        allergy_text = (patient["allergy"] or "").strip() if patient else ""

        normalized = []
        need = {}
        for idx, item in enumerate(items):
            if not isinstance(item, dict):
                raise ApiError(400, "VALIDATION_FAILED", f"items[{idx}] 必须为对象")
            drug_id = as_int(item, "drugId", required=True, minimum=1)
            dosage = as_str(item, "dosage", required=True, max_len=40)
            frequency = as_str(item, "frequency", required=True, max_len=40)
            days = as_int(item, "days", required=True, minimum=1, maximum=30)
            quantity = as_int(item, "quantity", required=True, minimum=1, maximum=99)
            drug = con.execute("SELECT * FROM drugs WHERE id=?", (drug_id,)).fetchone()
            if drug is None or drug["status"] != "ACTIVE":
                raise not_found(f"药品不存在或已停用：{drug_id}")
            if drug["controlled"]:
                raise ApiError(403, "CONTROLLED_DRUG_BLOCKED",
                               f"{drug['name']} 属管制药品，普通门诊不得开具，请走专用处方流程")
            level = drug["antibiotic_level"]
            if level == "特殊":
                raise ApiError(403, "ANTIBIOTIC_LEVEL_DENIED",
                               f"{drug['name']} 属特殊级抗菌药物，须会诊审批后方可使用")
            if level == "限制" and pres_level < 2:
                raise ApiError(403, "ANTIBIOTIC_LEVEL_DENIED",
                               f"{drug['name']} 属限制级抗菌药物，须主治医师及以上职称开具")
            # 过敏冲突服务端硬阻断：命中任意过敏标签即整单拒绝（写库前校验，不落处方/不扣库存）
            tags = [t.strip() for t in (drug["allergy_tags"] or "").split("|") if t.strip()]
            matched = [t for t in tags if t in allergy_text] if allergy_text else []
            if matched:
                raise ApiError(400, "ALLERGY_CONFLICT",
                               f"患者过敏史「{allergy_text}」与 {drug['name']} 冲突（{matched[0]}），请更换药品")
            need[drug_id] = need.get(drug_id, 0) + quantity
            normalized.append((drug, dosage, frequency, days, quantity))

        for drug_id, qty in need.items():
            drug = con.execute("SELECT name, stock FROM drugs WHERE id=?", (drug_id,)).fetchone()
            if drug["stock"] < qty:
                raise conflict(f"{drug['name']} 库存不足（现有 {drug['stock']}，需要 {qty}）",
                               "STOCK_INSUFFICIENT")

        compact = db.today_str().replace("-", "")
        seq = db.next_sequence(con, "rx-" + compact)
        rx_no = f"RX{compact}-{seq:04d}"
        cur = con.execute(
            "INSERT INTO prescriptions(rx_no,visit_id,patient_id,doctor_id,status,total_amount,created_at) "
            "VALUES (?,?,?,?, 'SUBMITTED', 0, ?)",
            (rx_no, visit_id, visit["patient_id"], visit["doctor_id"], db.now_str()))
        rx_id = int(cur.lastrowid)
        total = 0.0
        for drug, dosage, frequency, days, quantity in normalized:
            amount = round(float(drug["price"]) * quantity, 2)
            total += amount
            con.execute(
                "INSERT INTO prescription_items(prescription_id,drug_id,drug_name,spec,dosage,frequency,days,quantity,unit_price,amount) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (rx_id, drug["id"], drug["name"], drug["spec"], dosage, frequency, days,
                 quantity, drug["price"], amount))
        con.execute("UPDATE prescriptions SET total_amount=? WHERE id=?", (round(total, 2), rx_id))
        security.audit(con, ctx.user, "RX_CREATE", "prescription", rx_id,
                       f"visit={visit_id} items={len(normalized)} total={round(total, 2)}", "OK", ctx.ip)
    return {"id": rx_id, "rxNo": rx_no, "totalAmount": round(total, 2), "status": "SUBMITTED"}


# ---------------------------------------------------------------- 检查申请

def create_lab_orders(ctx):
    visit_id = int(ctx.params["id"])
    items = as_list(ctx.body, "items", required=True, max_items=10)
    if not items:
        raise ApiError(400, "VALIDATION_FAILED", "至少选择 1 个检查项目")
    with db.tx() as con:
        visit = _load_visit(con, visit_id)
        _owner_check(visit, ctx.user)
        if visit["status"] != "IN_PROGRESS":
            raise conflict("病历已完成，不可新开检查", "EMR_LOCKED")
        created = []
        compact = db.today_str().replace("-", "")
        for idx, code in enumerate(items):
            if not isinstance(code, str):
                raise ApiError(400, "VALIDATION_FAILED", f"items[{idx}] 必须为项目编码字符串")
            item = con.execute("SELECT * FROM lab_items WHERE code=?", (code.strip(),)).fetchone()
            if item is None:
                raise not_found(f"检查项目不存在：{code}")
            seq = db.next_sequence(con, "lab-" + compact)
            order_no = f"LAB{compact}-{seq:04d}"
            cur = con.execute(
                "INSERT INTO lab_orders(order_no,visit_id,patient_id,doctor_id,item_code,item_name,price,status,created_at) "
                "VALUES (?,?,?,?,?,?,?, 'APPLIED', ?)",
                (order_no, visit_id, visit["patient_id"], visit["doctor_id"],
                 item["code"], item["name"], item["price"], db.now_str()))
            order_id = int(cur.lastrowid)
            con.execute(
                "INSERT INTO charges(charge_no,patient_id,visit_id,category,description,amount,status,ref_type,ref_id,created_at) "
                "VALUES (?,?,?, 'LAB', ?,?, 'UNPAID','LAB_ORDER',?,?)",
                (f"CH{compact}-L{order_id:06d}", visit["patient_id"], visit_id,
                 f"检查费（{item['name']}）", item["price"], order_id, db.now_str()))
            created.append({"id": order_id, "orderNo": order_no, "itemName": item["name"],
                            "price": item["price"]})
        security.audit(con, ctx.user, "LAB_ORDER_CREATE", "visit", visit_id,
                       f"items={len(created)}", "OK", ctx.ip)
    return {"orders": created}


# ---------------------------------------------------------------- 完成与更正

def finish_visit(ctx):
    visit_id = int(ctx.params["id"])
    with db.tx() as con:
        visit = _load_visit(con, visit_id)
        _owner_check(visit, ctx.user)
        if visit["status"] != "IN_PROGRESS":
            raise conflict("就诊状态不允许完成", "STATE_CONFLICT")
        # 完成前强校验：复用质控全部 HIGH 项（主诉 / 诊断 / 开方须有诊断），任一未过即拒绝
        diag_count = con.execute("SELECT COUNT(*) AS c FROM visit_diagnoses WHERE visit_id=?",
                                 (visit_id,)).fetchone()["c"]
        has_diag = diag_count > 0 or bool((visit["diagnosis_name"] or "").strip())
        rx_count = con.execute("SELECT COUNT(*) AS c FROM prescriptions WHERE visit_id=?",
                               (visit_id,)).fetchone()["c"]
        checks = [
            ("chiefComplaint", "主诉", bool((visit["chief_complaint"] or "").strip())),
            ("diagnoses", "诊断", has_diag),
            ("prescriptions", "开方须有诊断", (rx_count == 0) or has_diag),
        ]
        missing = [(field, label) for field, label, ok in checks if not ok]
        if missing:
            raise ApiError(400, "EMR_INCOMPLETE",
                           "病历不完整，缺少：" + "、".join(label for _, label in missing),
                           details=[{"field": field, "reason": "质控 HIGH 项未通过"}
                                    for field, _ in missing])
        signed_by = ctx.user.get("staff_name") or ctx.user.get("username") or ""
        con.execute("UPDATE visits SET status='FINISHED', finished_at=?, signed_by=?, signed_at=?, "
                    "version=version+1 WHERE id=?",
                    (db.now_str(), signed_by, db.now_str(), visit_id))
        con.execute("UPDATE registrations SET status='FINISHED' WHERE id=?", (visit["registration_id"],))
        con.execute("UPDATE queue_tickets SET status='DONE', done_at=? "
                    "WHERE registration_id=? AND status IN ('WAITING','CALLED','SERVING')",
                    (db.now_str(), visit["registration_id"]))
        security.audit(con, ctx.user, "VISIT_FINISH", "visit", visit_id,
                       f"signedBy={signed_by}", "OK", ctx.ip)
    return {"id": visit_id, "status": "FINISHED", "signedBy": signed_by}


AMEND_FIELDS = {
    "chiefComplaint": "chief_complaint",
    "presentIllness": "present_illness",
    "pastHistory": "past_history",
    "physicalExam": "physical_exam",
    "diagnosisNote": "diagnosis_note",
    "treatmentAdvice": "treatment_advice",
}


def amend_visit(ctx):
    visit_id = int(ctx.params["id"])
    require_fields(ctx.body, ["reason"])
    reason = as_str(ctx.body, "reason", required=True, max_len=200)
    if len(reason) < 5:
        raise ApiError(400, "VALIDATION_FAILED", "更正原因不得少于 5 个字")
    changes = ctx.body.get("changes")
    if not isinstance(changes, dict) or not changes:
        raise ApiError(400, "VALIDATION_FAILED", "changes 必须为待更正的字段对象")
    unknown = [k for k in changes if k not in AMEND_FIELDS and k != "diagnosisCode"]
    if unknown:
        raise ApiError(400, "VALIDATION_FAILED", "请求包含不可更正字段：" + "、".join(unknown))

    with db.tx() as con:
        visit = _load_visit(con, visit_id)
        _owner_check(visit, ctx.user)
        if visit["status"] != "FINISHED":
            raise conflict("仅已完成的病历需要提交更正留痕", "STATE_CONFLICT")
        before = {k: visit[v] for k, v in AMEND_FIELDS.items()}
        before["diagnosisCode"] = visit["diagnosis_code"]
        sets, params = [], []
        after = dict(before)
        for key, column in AMEND_FIELDS.items():
            if key in changes:
                value = as_str(changes, key, max_len=2000)
                sets.append(f"{column}=?")
                params.append(value)
                after[key] = value
        if "diagnosisCode" in changes:
            code = as_str(changes, "diagnosisCode", required=True, max_len=20)
            icd = con.execute("SELECT * FROM icd10 WHERE code=?", (code,)).fetchone()
            if icd is None:
                raise not_found("ICD-10 诊断编码不存在")
            sets.extend(["diagnosis_code=?", "diagnosis_name=?"])
            params.extend([code, icd["name"]])
            after["diagnosisCode"] = code
            if icd["infectious"]:
                _ensure_ph_task(con, "INFECTION", visit["patient_id"], visit_id,
                                f"法定传染病上报：{icd['name']}",
                                f"更正诊断编码 {code}，须在 24 小时内完成上报", db.now_after(hours=24))
        params.append(visit_id)
        con.execute("UPDATE visits SET " + ",".join(sets) + ", version=version+1 WHERE id=?",
                    tuple(params))
        # 更正诊断编码须同步 visit_diagnoses 主诊断行，保证主表与 diagnoses[] 一致
        if "diagnosisCode" in changes:
            primary = con.execute(
                "SELECT id FROM visit_diagnoses WHERE visit_id=? ORDER BY is_primary DESC, sort_no, id LIMIT 1",
                (visit_id,)).fetchone()
            if primary is None:
                con.execute(
                    "INSERT INTO visit_diagnoses(visit_id,code,name,is_primary,suspected,sort_no,note,created_by,created_at) "
                    "VALUES (?,?,?,1,0,1,?,?,?)",
                    (visit_id, code, icd["name"], after["diagnosisNote"],
                     ctx.user.get("staff_id") or ctx.user["id"], db.now_str()))
            else:
                con.execute("UPDATE visit_diagnoses SET code=?, name=?, note=? WHERE id=?",
                            (code, icd["name"], after["diagnosisNote"], primary["id"]))
            _sync_primary_diagnosis(con, visit_id)
        con.execute(
            "INSERT INTO emr_amendments(visit_id,reason,before_json,after_json,amended_by,amended_at) "
            "VALUES (?,?,?,?,?,?)",
            (visit_id, reason, json.dumps(before, ensure_ascii=False),
             json.dumps(after, ensure_ascii=False), ctx.user.get("staff_id") or ctx.user["id"],
             db.now_str()))
        security.audit(con, ctx.user, "EMR_AMEND", "visit", visit_id,
                       f"fields=" + ",".join(list(changes.keys())), "OK", ctx.ip)
    return {"amended": True}


# ---------------------------------------------------------------- 字典

def list_icd10(ctx):
    keyword = (ctx.q("q") or "").strip()
    if keyword:
        like = f"%{keyword}%"
        return db.query("SELECT * FROM icd10 WHERE code LIKE ? OR name LIKE ? ORDER BY code",
                        (like, like))
    return db.query("SELECT * FROM icd10 ORDER BY code")


# ---------------------------------------------------------------- 合理用药前置校验

_RX_LEVEL_ORDER = {"HIGH": 0, "MEDIUM": 1, "INFO": 2}


def rx_check(ctx):
    """合理用药前置提示（少量高价值规则）：过敏冲突 HIGH、同单重复 MEDIUM、管制药品/抗菌分级 INFO。"""
    if not isinstance(ctx.body, dict):
        raise ApiError(400, "VALIDATION_FAILED", "请求体必须为 JSON 对象")
    patient_id = as_int(ctx.body, "patientId", required=True, minimum=1)
    items = as_list(ctx.body, "items", required=True, max_items=20)
    if not items:
        raise ApiError(400, "VALIDATION_FAILED", "至少包含 1 种药品")
    patient = db.query("SELECT id, allergy FROM patients WHERE id=?", (patient_id,), one=True)
    if patient is None:
        raise not_found("患者不存在")
    allergy = (patient["allergy"] or "").strip()

    warnings, seen, checked = [], set(), 0
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            raise ApiError(400, "VALIDATION_FAILED", f"items[{idx}] 必须为对象")
        drug_id = as_int(item, "drugId", required=True, minimum=1)
        drug = db.query("SELECT * FROM drugs WHERE id=?", (drug_id,), one=True)
        if drug is None:
            raise not_found(f"药品不存在：{drug_id}")
        checked += 1
        name = drug["name"]
        # ① 过敏冲突：患者过敏文本命中药品过敏标签任一
        tags = [t.strip() for t in (drug["allergy_tags"] or "").split("|") if t.strip()]
        matched = [t for t in tags if t in allergy] if allergy else []
        if matched:
            warnings.append({"level": "HIGH", "code": "ALLERGY_CONFLICT",
                             "message": f"患者过敏史「{allergy}」与 {name} 冲突（{matched[0]}），禁止开具"})
        # ② 同单重复药品
        if drug_id in seen:
            warnings.append({"level": "MEDIUM", "code": "DUPLICATE_DRUG",
                             "message": f"{name} 在同一处方中重复出现，请合并剂量"})
        seen.add(drug_id)
        # ③ 管制药品
        if drug["controlled"]:
            warnings.append({"level": "INFO", "code": "CONTROLLED_DRUG",
                             "message": f"{name} 属管制药品，普通门诊不得开具，须走专用处方流程"})
        # ④ 抗菌药物分级
        if drug["antibiotic_level"]:
            warnings.append({"level": "INFO", "code": "ANTIBIOTIC_LEVEL",
                             "message": f"{name} 属{drug['antibiotic_level']}级抗菌药物，请按分级管理要求使用"})

    warnings.sort(key=lambda w: _RX_LEVEL_ORDER.get(w["level"], 9))
    return {"warnings": warnings, "checked": checked}


# ---------------------------------------------------------------- 病历质控

QC_ITEMS = [
    ("chief_complaint", "chief_complaint", "主诉", "HIGH"),
    ("present_illness", "present_illness", "现病史", "MEDIUM"),
    ("physical_exam", "physical_exam", "体格检查", "MEDIUM"),
    ("diagnosis", "diagnosis_name", "诊断", "HIGH"),
    ("treatment_advice", "treatment_advice", "处理意见", "MEDIUM"),
]


def visit_qc(ctx):
    """病历质控提示：必填缺项（HIGH/红）与建议缺项（MEDIUM/黄）+ 完整率。"""
    visit_id = int(ctx.params["id"])
    visit = db.query("SELECT * FROM visits WHERE id=?", (visit_id,), one=True)
    if visit is None:
        raise not_found("就诊记录不存在")
    _read_check(visit, ctx.user)
    items = []
    for code, field, label, level in QC_ITEMS:
        items.append({"code": code, "label": label, "level": level,
                      "ok": bool((visit[field] or "").strip())})
    # 开方须有诊断：无处方视为通过
    rx_count = db.query("SELECT COUNT(*) AS c FROM prescriptions WHERE visit_id=?", (visit_id,), one=True)["c"]
    diag_rows = db.query("SELECT COUNT(*) AS c FROM visit_diagnoses WHERE visit_id=?", (visit_id,), one=True)["c"]
    has_diag = bool(diag_rows) or bool((visit["diagnosis_name"] or "").strip())
    items.append({"code": "rx_needs_diagnosis", "label": "开方须有诊断", "level": "HIGH",
                  "ok": (rx_count == 0) or has_diag})
    passed = sum(1 for i in items if i["ok"])
    return {"items": items, "passRate": round(passed * 100.0 / len(items), 1)}


def register(router):
    router.add("GET", r"/api/v1/visits", list_visits, perm="visit.read")
    router.add("POST", r"/api/v1/visits", start_visit, perm="visit.write")
    router.add("GET", r"/api/v1/visits/(?P<id>\d+)", get_visit, perm="visit.read")
    router.add("GET", r"/api/v1/visits/(?P<id>\d+)/reports", visit_reports, perm="lab.read")
    router.add("GET", r"/api/v1/visits/(?P<id>\d+)/qc", visit_qc, perm="visit.read")
    router.add("PATCH", r"/api/v1/visits/(?P<id>\d+)", update_visit, perm="visit.write")
    router.add("POST", r"/api/v1/visits/(?P<id>\d+)/diagnose", diagnose, perm="visit.write")
    router.add("GET", r"/api/v1/visits/(?P<id>\d+)/diagnoses", list_visit_diagnoses, perm="visit.read")
    router.add("POST", r"/api/v1/visits/(?P<id>\d+)/diagnoses", add_visit_diagnosis, perm="visit.write")
    router.add("DELETE", r"/api/v1/visits/(?P<id>\d+)/diagnoses/(?P<did>\d+)",
               delete_visit_diagnosis, perm="visit.write")
    router.add("PATCH", r"/api/v1/visits/(?P<id>\d+)/vitals", record_visit_vitals, perm="visit.write")
    router.add("POST", r"/api/v1/visits/(?P<id>\d+)/prescriptions", create_prescription, perm="rx.write")
    router.add("POST", r"/api/v1/visits/(?P<id>\d+)/lab-orders", create_lab_orders, perm="lab.order")
    router.add("POST", r"/api/v1/visits/(?P<id>\d+)/finish", finish_visit, perm="visit.write")
    router.add("POST", r"/api/v1/visits/(?P<id>\d+)/amendments", amend_visit, perm="visit.write")
    router.add("GET", r"/api/v1/icd10", list_icd10)
    router.add("POST", r"/api/v1/rx-check", rx_check, perm="rx.write")
