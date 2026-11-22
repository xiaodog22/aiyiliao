"""科室、人员、排班号源、患者主索引。"""

from __future__ import annotations

import json
import re

from .. import db, security
from ..errors import ApiError, conflict, not_found
from .common import (as_int, as_list, as_str, one_of, pagination, parse_date,
                     require_fields)

# L7（2026-11-23）：患者主索引支持用证件号/手机号精确检索。
# 落库只存加盐哈希（不可逆），因此查询必须走 patient_hash_candidates()：
# 迁移期同时接受新盐与旧盐哈希，换盐不会导致老患者搜不到（D-07 收口）。
_PHONE_RE = re.compile(r"^1[3-9]\d{9}$")
_ID_CARD_RE = re.compile(r"^\d{17}[\dXx]$")


# ---------------------------------------------------------------- 科室

def list_departments(ctx):
    return db.query("SELECT id, code, name, type FROM departments ORDER BY id")


# ---------------------------------------------------------------- 人员

ROLE_ENUM = set(security.ROLE_NAMES.keys())


def _staff_row(row) -> dict:
    return {
        "id": row["id"], "staffNo": row["staff_no"], "name": row["name"], "gender": row["gender"],
        "role": row["role"], "roleName": security.ROLE_NAMES.get(row["role"], row["role"]),
        "title": row["title"], "deptId": row["dept_id"], "deptName": row["dept_name"],
        "licenseNo": row["license_no"], "specialty": row["specialty"],
        "status": row["status"], "presLevel": row["pres_level"],
        "username": row["username"] or "",
    }


def list_staff(ctx):
    where, params = ["1=1"], []
    if ctx.q("role"):
        where.append("s.role=?")
        params.append(ctx.q("role"))
    if ctx.q("deptId"):
        where.append("s.dept_id=?")
        params.append(as_int({"deptId": ctx.q("deptId")}, "deptId", required=True))
    if ctx.q("status"):
        where.append("s.status=?")
        params.append(ctx.q("status"))
    rows = db.query(
        "SELECT s.*, d.name AS dept_name, u.username FROM staff s "
        "JOIN departments d ON d.id=s.dept_id LEFT JOIN users u ON u.staff_id=s.id "
        "WHERE " + " AND ".join(where) + " ORDER BY s.role, s.staff_no", tuple(params))
    return [_staff_row(r) for r in rows]


def create_staff(ctx):
    body = ctx.body
    require_fields(body, ["name", "gender", "role", "deptCode", "username", "password"])
    name = as_str(body, "name", required=True, max_len=30)
    gender = one_of(as_str(body, "gender", required=True), {"男", "女"}, "gender")
    role = one_of(as_str(body, "role", required=True), ROLE_ENUM, "role")
    title = as_str(body, "title", max_len=30)
    dept_code = as_str(body, "deptCode", required=True, max_len=10)
    username = as_str(body, "username", required=True, max_len=40)
    password = as_str(body, "password", required=True, max_len=64)
    license_no = as_str(body, "licenseNo", max_len=40)
    specialty = as_str(body, "specialty", max_len=80)

    err = security.validate_password(password, username)
    if err:
        raise ApiError(400, "PASSWORD_WEAK", err)

    pres_level = 0
    if role == "DOCTOR":
        pres_level = {"主任医师": 3, "副主任医师": 3, "主治医师": 2, "住院医师": 1}.get(title, 1)

    with db.tx() as con:
        dept = con.execute("SELECT id FROM departments WHERE code=?", (dept_code,)).fetchone()
        if dept is None:
            raise not_found("科室不存在")
        if con.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise conflict("账号名已存在", "USERNAME_EXISTS")
        total = con.execute("SELECT COUNT(*) AS c FROM staff").fetchone()["c"] + 1
        staff_no = f"E{total:03d}"
        cur = con.execute(
            "INSERT INTO staff(staff_no,name,gender,role,title,dept_id,license_no,specialty,phone_mask,status,hire_date,pres_level) "
            "VALUES (?,?,?,?,?,?,?,?, '', 'ACTIVE', ?, ?)",
            (staff_no, name, gender, role, title, dept["id"], license_no, specialty,
             db.today_str(), pres_level))
        staff_id = int(cur.lastrowid)
        con.execute(
            "INSERT INTO users(username,password_hash,staff_id,role,status,failed_count,must_change,created_at) "
            "VALUES (?,?,?,?, 'ACTIVE', 0, 1, ?)",
            (username, security.hash_password(password), staff_id, role, db.now_str()))
        security.audit(con, ctx.user, "STAFF_CREATE", "staff", staff_id,
                       f"role={role} dept={dept_code}", "OK", ctx.ip)
    return {"id": staff_id, "staffNo": staff_no, "username": username}


def patch_staff(ctx):
    staff_id = int(ctx.params["id"])
    body = ctx.body
    allowed = {"status", "title", "specialty", "deptCode"}
    unknown = [k for k in body if k not in allowed]
    if unknown:
        raise ApiError(400, "VALIDATION_FAILED", "请求包含未知字段：" + "、".join(unknown))

    with db.tx() as con:
        row = con.execute("SELECT * FROM staff WHERE id=?", (staff_id,)).fetchone()
        if row is None:
            raise not_found("人员不存在")
        updates, params = [], []
        if "status" in body:
            status = one_of(as_str(body, "status", required=True), {"ACTIVE", "DISABLED"}, "status")
            updates.append("status=?")
            params.append(status)
            if status == "DISABLED":
                con.execute("UPDATE users SET status='DISABLED' WHERE staff_id=?", (staff_id,))
                con.execute(
                    "UPDATE sessions SET revoked=1 WHERE revoked=0 AND user_id IN "
                    "(SELECT id FROM users WHERE staff_id=?)", (staff_id,))
            else:
                # 启用账号：恢复登录状态并清理失败计数/锁定，避免停用后无法再登录
                con.execute("UPDATE users SET status='ACTIVE', failed_count=0, locked_until=NULL "
                            "WHERE staff_id=?", (staff_id,))
        if "title" in body:
            title = as_str(body, "title", max_len=30)
            updates.append("title=?")
            params.append(title)
            if row["role"] == "DOCTOR":
                updates.append("pres_level=?")
                params.append({"主任医师": 3, "副主任医师": 3, "主治医师": 2, "住院医师": 1}.get(title, 1))
        if "specialty" in body:
            updates.append("specialty=?")
            params.append(as_str(body, "specialty", max_len=80))
        if "deptCode" in body:
            dept = con.execute("SELECT id FROM departments WHERE code=?",
                               (as_str(body, "deptCode", required=True),)).fetchone()
            if dept is None:
                raise not_found("科室不存在")
            updates.append("dept_id=?")
            params.append(dept["id"])
        if not updates:
            raise ApiError(400, "VALIDATION_FAILED", "没有可更新的字段")
        params.append(staff_id)
        con.execute("UPDATE staff SET " + ",".join(updates) + " WHERE id=?", tuple(params))
        security.audit(con, ctx.user, "STAFF_UPDATE", "staff", staff_id,
                       "fields=" + ",".join(k for k in allowed if k in body), "OK", ctx.ip)
    return {"updated": True}


# ---------------------------------------------------------------- 号源

def list_schedules(ctx):
    date = parse_date(ctx.q("date"))
    where, params = ["sl.work_date=?"], [date]
    if ctx.q("deptId"):
        where.append("sl.dept_id=?")
        params.append(int(ctx.q("deptId")))
    if ctx.q("doctorId"):
        where.append("sl.doctor_id=?")
        params.append(int(ctx.q("doctorId")))
    rows = db.query(
        "SELECT sl.*, s.name AS doctor_name, s.title AS doctor_title, "
        "(sl.capacity - sl.booked) AS remaining, d.name AS dept_name "
        "FROM doctor_slots sl JOIN staff s ON s.id=sl.doctor_id "
        "JOIN departments d ON d.id=sl.dept_id WHERE " + " AND ".join(where) +
        " ORDER BY sl.dept_id, sl.doctor_id, sl.period", tuple(params))
    return [{
        "id": r["id"], "slotNo": r["slot_no"], "doctorId": r["doctor_id"], "doctorName": r["doctor_name"],
        "doctorTitle": r["doctor_title"], "deptId": r["dept_id"], "deptName": r["dept_name"],
        "workDate": r["work_date"], "period": r["period"], "startTime": r["start_time"],
        "endTime": r["end_time"], "capacity": r["capacity"], "booked": r["booked"],
        "remaining": r["remaining"], "status": r["status"],
    } for r in rows]


def generate_schedules(ctx):
    start = parse_date(as_str(ctx.body, "startDate", max_len=10) or ctx.q("startDate"))
    days = as_int(ctx.body, "days", default=7, minimum=1, maximum=30)
    doctor_filter = as_int(ctx.body, "doctorId", default=0)
    created = 0
    from datetime import datetime, timedelta
    with db.tx() as con:
        docs = con.execute("SELECT id, staff_no, dept_id FROM staff WHERE role='DOCTOR' AND status='ACTIVE'"
                           + (" AND id=?" if doctor_filter else ""),
                           ((doctor_filter,) if doctor_filter else ())).fetchall()
        base = datetime.strptime(start, "%Y-%m-%d").date()
        for offset in range(days):
            day = (base + timedelta(days=offset)).strftime("%Y-%m-%d")
            compact = day.replace("-", "")
            for doc in docs:
                for period, st, en, cap in (("AM", "08:00", "12:00", 20), ("PM", "14:00", "17:30", 15)):
                    slot_no = f"SL{compact}{doc['staff_no']}{period}"
                    cur = con.execute(
                        "INSERT OR IGNORE INTO doctor_slots(slot_no,doctor_id,dept_id,work_date,period,start_time,end_time,capacity,booked,status) "
                        "VALUES (?,?,?,?,?,?,?,?,0,'OPEN')",
                        (slot_no, doc["id"], doc["dept_id"], day, period, st, en, cap))
                    created += cur.rowcount
        security.audit(con, ctx.user, "SCHEDULE_GENERATE", "doctor_slots", start,
                       f"days={days} created={created}", "OK", ctx.ip)
    return {"created": created, "startDate": start, "days": days}


# ---------------------------------------------------------------- 患者

def _clinical_full_access(user: dict, patient_id: int) -> bool:
    """病历全文可见范围（三接口复用）。

    需具备 clinical.read；再满足「跨医生读取 patient.read.all」或「本人曾接诊该患者」。
    否则只返回脱敏患者信息与就诊概要，避免越权读取 EMR 文本与处方明细。
    """
    if not security.has_perm(user, "clinical.read"):
        return False
    if security.has_perm(user, "patient.read.all"):
        return True
    staff_id = user.get("staff_id") or 0
    if not staff_id:
        return False
    row = db.query("SELECT 1 FROM visits WHERE patient_id=? AND doctor_id=? LIMIT 1",
                   (patient_id, staff_id), one=True)
    return row is not None


def _patient_brief(row) -> dict:
    try:
        tags = json.loads(row["chronic_tags"] or "[]")
    except ValueError:
        tags = []
    return {
        "id": row["id"], "mrn": row["mrn"], "name": security.mask_name(row["name"]),
        "gender": row["gender"], "birthDate": row["birth_date"], "phoneMask": row["phone_mask"],
        "chronicTags": tags,
    }


def list_patients(ctx):
    keyword = (ctx.q("q") or "").strip()
    # 支持前端顶栏「患者搜索」按 limit=8 精简返回，兼容原有不带 limit 的调用
    limit, _ = pagination({"limit": ctx.q("limit") or "50"})
    if keyword:
        like = f"%{keyword}%"
        clauses = ["name LIKE ?", "mrn LIKE ?", "phone_mask LIKE ?"]
        params = [like, like, like]
        if _PHONE_RE.match(keyword) or _ID_CARD_RE.match(keyword):
            hashes = security.patient_hash_candidates(keyword)
            if hashes:
                marks = ",".join("?" * len(hashes))
                clauses.append(f"id_hash IN ({marks})")
                params.extend(hashes)
                clauses.append(f"phone_hash IN ({marks})")
                params.extend(hashes)
        params.append(limit)
        rows = db.query(
            "SELECT * FROM patients WHERE " + " OR ".join(clauses)
            + " ORDER BY id DESC LIMIT ?", tuple(params))
    else:
        rows = db.query("SELECT * FROM patients ORDER BY id DESC LIMIT ?", (limit,))
    return [_patient_brief(r) for r in rows]


def create_patient(ctx):
    body = ctx.body
    require_fields(body, ["name", "gender"])
    name = as_str(body, "name", required=True, max_len=30)
    gender = one_of(as_str(body, "gender", required=True), {"男", "女"}, "gender")
    birth_date = as_str(body, "birthDate", max_len=10)
    if birth_date and not __import__("re").fullmatch(r"\d{4}-\d{2}-\d{2}", birth_date):
        raise ApiError(400, "VALIDATION_FAILED", "出生日期格式须为 YYYY-MM-DD")
    id_card = as_str(body, "idCard", max_len=20)
    phone = as_str(body, "phone", max_len=20)
    address = as_str(body, "address", max_len=100)
    allergy = as_str(body, "allergy", max_len=100) or "无"
    tags = as_list(body, "chronicTags", required=False, max_items=10)

    with db.tx() as con:
        # MRN 走原子序列取号；首次使用时以现有最大号初始化，避免与种子数据冲突
        seq_row = con.execute("SELECT value FROM sequences WHERE name='patient'").fetchone()
        if seq_row is None:
            max_row = con.execute(
                "SELECT MAX(CAST(SUBSTR(mrn,2) AS INTEGER)) AS m FROM patients").fetchone()
            con.execute("INSERT OR IGNORE INTO sequences(name,value) VALUES ('patient',?)",
                        (int(max_row["m"] or 0),))
        mrn = f"P{db.next_sequence(con, 'patient'):06d}"
        id_last4 = security.mask_id_card(id_card)
        cur = con.execute(
            "INSERT INTO patients(mrn,name,gender,birth_date,id_last4,id_hash,phone_mask,phone_hash,address,allergy,chronic_tags,created_at,created_by) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (mrn, name, gender, birth_date, id_last4, security.patient_hash(id_card),
             security.mask_phone(phone), security.patient_hash(phone), address, allergy,
             json.dumps(tags, ensure_ascii=False), db.now_str(), ctx.user["id"]))
        patient_id = int(cur.lastrowid)
        security.audit(con, ctx.user, "PATIENT_CREATE", "patient", patient_id, f"mrn={mrn}", "OK", ctx.ip)
    return {"id": patient_id, "mrn": mrn}


def get_patient(ctx):
    patient_id = int(ctx.params["id"])
    row = db.query("SELECT * FROM patients WHERE id=?", (patient_id,), one=True)
    if row is None:
        raise not_found("患者不存在")
    try:
        tags = json.loads(row["chronic_tags"] or "[]")
    except ValueError:
        tags = []
    # 无权读取病历全文时：姓名脱敏、去掉住址，仅保留性别/年龄/MRN/掩码电话/过敏标记
    full = _clinical_full_access(ctx.user, patient_id)
    with db.tx() as con:
        security.audit(con, ctx.user, "PATIENT_VIEW", "patient", patient_id,
                       f"mrn={row['mrn']} restricted={0 if full else 1}", "OK", ctx.ip)
    data = {
        "id": row["id"], "mrn": row["mrn"],
        "name": row["name"] if full else security.mask_name(row["name"]),
        "gender": row["gender"], "birthDate": row["birth_date"], "idLast4": row["id_last4"],
        "phoneMask": row["phone_mask"], "allergy": row["allergy"], "chronicTags": tags,
        "createdAt": row["created_at"],
    }
    if full:
        data["address"] = row["address"]
    return data


def patient_visits(ctx):
    """患者历史就诊（时间倒序）：供医生站「上次就诊」调阅，含诊断与处方摘要。"""
    patient_id = int(ctx.params["id"])
    try:
        limit = int(ctx.q("limit") or 20)
    except ValueError:
        raise ApiError(400, "VALIDATION_FAILED", "limit 必须为整数")
    limit = max(1, min(limit, 100))
    try:
        exclude_id = int(ctx.q("excludeVisitId") or 0)
    except ValueError:
        raise ApiError(400, "VALIDATION_FAILED", "excludeVisitId 必须为整数")
    where = "WHERE v.patient_id=?"
    params = [patient_id]
    if exclude_id:
        where += " AND v.id<>?"
        params.append(exclude_id)
    rows = db.query(
        "SELECT v.*, s.name AS doctor_name, s.title AS doctor_title, d.name AS dept_name "
        "FROM visits v JOIN staff s ON s.id=v.doctor_id JOIN departments d ON d.id=v.dept_id "
        + where + " ORDER BY v.id DESC LIMIT ?", tuple(params + [limit]))
    # 无病历全文权限（收费/技师/药师/公卫或非接诊医生）只给就诊概要，不含 EMR 文本与处方明细
    full = _clinical_full_access(ctx.user, patient_id)
    result = []
    for r in rows:
        if not full:
            result.append({
                "id": r["id"], "visitNo": r["visit_no"], "visitDate": r["visit_date"],
                "doctorName": r["doctor_name"], "doctorTitle": r["doctor_title"],
                "deptName": r["dept_name"], "status": r["status"],
                "diagnosisName": r["diagnosis_name"],
            })
            continue
        diags = db.query(
            "SELECT code, name, is_primary FROM visit_diagnoses WHERE visit_id=? "
            "ORDER BY is_primary DESC, sort_no, id", (r["id"],))
        if not diags and r["diagnosis_code"]:
            diags = [{"code": r["diagnosis_code"], "name": r["diagnosis_name"], "is_primary": 1}]
        rxs = db.query("SELECT id, rx_no FROM prescriptions WHERE visit_id=? ORDER BY id", (r["id"],))
        rx_summaries = []
        for rx in rxs:
            drugs = db.query(
                "SELECT drug_name FROM prescription_items WHERE prescription_id=? ORDER BY id",
                (rx["id"],))
            rx_summaries.append({"rxNo": rx["rx_no"], "drugNames": [x["drug_name"] for x in drugs]})
        result.append({
            "id": r["id"], "visitNo": r["visit_no"], "visitDate": r["visit_date"],
            "doctorName": r["doctor_name"], "doctorTitle": r["doctor_title"], "deptName": r["dept_name"],
            "diagnosisCode": r["diagnosis_code"], "diagnosisName": r["diagnosis_name"],
            "chiefComplaint": r["chief_complaint"], "presentIllness": r["present_illness"],
            "physicalExam": r["physical_exam"], "treatmentAdvice": r["treatment_advice"],
            "status": r["status"], "startedAt": r["started_at"], "finishedAt": r["finished_at"],
            "diagnoses": [{"code": d["code"], "name": d["name"], "isPrimary": bool(d["is_primary"])}
                          for d in diags],
            "prescriptions": rx_summaries,
        })
    return result


def patient_reports(ctx):
    patient_id = int(ctx.params["id"])
    rows = db.query(
        "SELECT lo.*, s.name AS doctor_name FROM lab_orders lo JOIN staff s ON s.id=lo.doctor_id "
        "WHERE lo.patient_id=? AND lo.status='REPORTED' ORDER BY lo.id DESC LIMIT 100", (patient_id,))
    # 与全视图同口径：无病历全文权限时只给有无异常与日期，不给所见/结论
    full = _clinical_full_access(ctx.user, patient_id)
    return [{
        "id": r["id"], "orderNo": r["order_no"], "itemName": r["item_name"],
        "doctorName": r["doctor_name"],
        "findings": r["report_findings"] if full else "",
        "conclusion": r["report_conclusion"] if full else "",
        "abnormal": bool(r["abnormal"]), "reportedAt": r["reported_at"],
    } for r in rows]


def patient_overview(ctx):
    """患者全视图（EMPI/CDR 统一视图）：基本资料 + 今日就诊 + 历次就诊 + 处方 + 检查 + 留观。"""
    patient_id = int(ctx.params["id"])
    row = db.query("SELECT * FROM patients WHERE id=?", (patient_id,), one=True)
    if row is None:
        raise not_found("患者不存在")
    try:
        tags = json.loads(row["chronic_tags"] or "[]")
    except ValueError:
        tags = []
    # 与患者详情/就诊历史同一可见范围规则：无权读病历全文时只给概要
    full = _clinical_full_access(ctx.user, patient_id)

    today = db.today_str()
    today_rows = db.query(
        "SELECT r.id, r.reg_no, r.status, r.queue_no, r.source, d.name AS dept_name, "
        "s.name AS doctor_name, "
        "(SELECT c.status FROM charges c WHERE c.ref_type='REGISTRATION' AND c.ref_id=r.id "
        " ORDER BY c.id DESC LIMIT 1) AS fee_status "
        "FROM registrations r JOIN departments d ON d.id=r.dept_id JOIN staff s ON s.id=r.doctor_id "
        "WHERE r.patient_id=? AND r.reg_date=? ORDER BY r.id DESC", (patient_id, today))

    visit_rows = db.query(
        "SELECT v.id, v.visit_no, v.visit_date, v.status, v.diagnosis_name, "
        "s.name AS doctor_name, d.name AS dept_name "
        "FROM visits v JOIN staff s ON s.id=v.doctor_id JOIN departments d ON d.id=v.dept_id "
        "WHERE v.patient_id=? ORDER BY v.id DESC LIMIT 20", (patient_id,))

    rx_rows = db.query(
        "SELECT p.id, p.rx_no, p.status, p.total_amount, p.created_at, s.name AS doctor_name "
        "FROM prescriptions p JOIN staff s ON s.id=p.doctor_id "
        "WHERE p.patient_id=? ORDER BY p.id DESC LIMIT 20", (patient_id,))
    prescriptions = []
    for rx in rx_rows:
        drugs = db.query("SELECT drug_name FROM prescription_items WHERE prescription_id=? ORDER BY id",
                         (rx["id"],))
        prescriptions.append({
            "id": rx["id"], "rxNo": rx["rx_no"], "status": rx["status"],
            "totalAmount": rx["total_amount"], "createdAt": rx["created_at"],
            "doctorName": rx["doctor_name"],
            # 无病历全文权限时不返回处方药品明细
            "drugNames": [d["drug_name"] for d in drugs] if full else [],
        })

    report_rows = db.query(
        "SELECT order_no, item_name, report_conclusion, abnormal, reported_at FROM lab_orders "
        "WHERE patient_id=? AND status='REPORTED' ORDER BY id DESC LIMIT 20", (patient_id,))
    # 无病历全文权限时报告只给「有/无异常 + 日期」，不给报告结论
    reports = [{
        "orderNo": r["order_no"], "itemName": r["item_name"],
        "conclusion": r["report_conclusion"] if full else "",
        "abnormal": bool(r["abnormal"]), "reportedAt": r["reported_at"],
    } for r in report_rows]

    stay_rows = db.query(
        "SELECT bs.stay_no, bs.nursing_level, bs.diet, bs.diagnosis, bs.status, bs.in_at, bs.out_at, "
        "b.bed_no, b.zone FROM bed_stays bs JOIN beds b ON b.id=bs.bed_id "
        "WHERE bs.patient_id=? ORDER BY bs.id DESC LIMIT 10", (patient_id,))

    with db.tx() as con:
        security.audit(con, ctx.user, "PATIENT_OVERVIEW", "patient", patient_id,
                       f"mrn={row['mrn']}", "OK", ctx.ip)

    return {
        "patient": {
            "id": row["id"], "mrn": row["mrn"],
            "name": row["name"] if full else security.mask_name(row["name"]),
            "gender": row["gender"], "birthDate": row["birth_date"], "phoneMask": row["phone_mask"],
            "address": row["address"] if full else "",
            "allergy": row["allergy"], "chronicTags": tags,
        },
        "today": [{
            "id": r["id"], "regNo": r["reg_no"], "status": r["status"], "queueNo": r["queue_no"],
            "source": r["source"], "deptName": r["dept_name"], "doctorName": r["doctor_name"],
            "feeStatus": r["fee_status"] or "UNKNOWN",
        } for r in today_rows],
        "visits": [{
            "id": r["id"], "visitNo": r["visit_no"], "visitDate": r["visit_date"],
            "status": r["status"], "diagnosisName": r["diagnosis_name"],
            "doctorName": r["doctor_name"], "deptName": r["dept_name"],
        } for r in visit_rows],
        "prescriptions": prescriptions,
        "reports": reports,
        "abnormalReports": sum(1 for r in reports if r["abnormal"]),
        # 无病历全文权限时留观记录只给床号与状态
        "stays": [{
            "stayNo": r["stay_no"], "bedNo": r["bed_no"],
            "zone": r["zone"] if full else "",
            "nursingLevel": r["nursing_level"] if full else "",
            "diet": r["diet"] if full else "",
            "diagnosis": r["diagnosis"] if full else "",
            "status": r["status"],
            "inAt": r["in_at"] if full else "",
            "outAt": r["out_at"] if full else "",
        } for r in stay_rows],
    }


def register(router):
    router.add("GET", r"/api/v1/departments", list_departments)
    router.add("GET", r"/api/v1/staff", list_staff, perm="staff.read")
    router.add("POST", r"/api/v1/staff", create_staff, perm="system.admin")
    router.add("PATCH", r"/api/v1/staff/(?P<id>\d+)", patch_staff, perm="system.admin")
    router.add("GET", r"/api/v1/schedules", list_schedules)
    router.add("POST", r"/api/v1/schedules/generate", generate_schedules, perm="schedule.write")
    router.add("GET", r"/api/v1/patients", list_patients, perm="patient.read")
    router.add("POST", r"/api/v1/patients", create_patient, perm="patient.write")
    router.add("GET", r"/api/v1/patients/(?P<id>\d+)", get_patient, perm="patient.read")
    router.add("GET", r"/api/v1/patients/(?P<id>\d+)/overview", patient_overview, perm="patient.read")
    router.add("GET", r"/api/v1/patients/(?P<id>\d+)/visits", patient_visits, perm="patient.read")
    router.add("GET", r"/api/v1/patients/(?P<id>\d+)/reports", patient_reports, perm="lab.read")
