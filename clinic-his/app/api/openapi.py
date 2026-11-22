"""对外接口 /openapi/v1：模拟真实医院 HIS 的受理契约（HMAC-SHA256 签名）。

对照主项目 HisClient：book → POST /appointments（受理返回单号）；
cancel → POST /appointments/{no}/cancel（幂等，不存在/已撤销也按成功处理）。
失败一律显式报错，绝不返回「看似成功」的单号。
"""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
import time
from datetime import date, datetime, timedelta

from .. import __version__, db, security
from ..errors import ApiError, not_found
from .common import as_float, as_str, check_unknown, require_fields

TIMESTAMP_TOLERANCE = 300          # ±300s
NONCE_TTL_SECONDS = 600            # nonce 保留 10 分钟
IDEM_MIN, IDEM_MAX = 8, 128

CREATE_FIELDS = {"appointmentId", "slotId", "patientName", "doctorId", "departmentId",
                 "slotDate", "slotTime"}
DEMO_CHARGE_FIELDS = {"patientName", "amount", "description", "refType", "refId"}
PAY_FIELDS = {"amount", "source"}
EXAM_CREATE_FIELDS = {"requestNo", "itemCode", "slotKey", "patientName"}
EXAM_SLOT_TIMES = ("08:30", "09:30", "10:30", "14:00", "15:00")
EXAM_WINDOW_DAYS = 7
EXAM_SLOT_KEY_RE = r"^\d{8}-\d{4}$"


# ---------------------------------------------------------------- 签名校验

def _header(ctx, name: str) -> str:
    return (ctx.headers.get(name) or "").strip() if ctx.headers is not None else ""


def _verify(ctx) -> dict:
    """校验 X-App-Id / X-Timestamp / X-Nonce / X-Signature，返回密钥行。

    顺序：appId → 时间戳 → nonce 已用检查 → 签名（常量时间）→ nonce 落库。
    nonce 只在签名通过后写入，避免未认证请求污染防重放表。
    """
    app_id = _header(ctx, "X-App-Id")
    timestamp = _header(ctx, "X-Timestamp")
    nonce = _header(ctx, "X-Nonce")
    signature = _header(ctx, "X-Signature")
    if not app_id:
        raise ApiError(401, "INVALID_APP_ID", "缺少 X-App-Id 请求头")
    key = db.query("SELECT * FROM openapi_keys WHERE app_id=? AND status='ACTIVE'", (app_id,), one=True)
    if key is None:
        raise ApiError(401, "INVALID_APP_ID", "应用标识无效或已停用")

    if not timestamp or not timestamp.isdigit():
        raise ApiError(401, "INVALID_TIMESTAMP", "X-Timestamp 须为 Unix 秒级时间戳")
    if abs(time.time() - int(timestamp)) > TIMESTAMP_TOLERANCE:
        raise ApiError(401, "INVALID_TIMESTAMP", "请求时间戳超出允许范围（±300s），请校准时钟")

    if not 8 <= len(nonce) <= 64:
        raise ApiError(401, "INVALID_SIGNATURE", "X-Nonce 须为 8~64 字符随机串")
    if not signature:
        raise ApiError(401, "INVALID_SIGNATURE", "缺少 X-Signature 请求头")

    # nonce 按 appId 作用域存储，避免不同应用使用相同 nonce 时互相阻塞（跨租户 DoS）
    scoped_nonce = f"{app_id}:{nonce}"
    used = db.query("SELECT 1 AS x FROM openapi_nonces WHERE nonce IN (?,?)",
                    (scoped_nonce, nonce), one=True)
    if used:
        raise ApiError(409, "REPLAY_DETECTED", "请求已被处理（nonce 重复），请勿重放", retryable=False)

    expected = security.sign_request(key["app_secret"], ctx.method, ctx.path, app_id,
                                     timestamp, nonce, ctx.raw_body)
    if not security.safe_compare(expected, signature.lower()):
        raise ApiError(401, "INVALID_SIGNATURE", "签名校验失败")

    with db.tx() as con:
        con.execute("DELETE FROM openapi_nonces WHERE ts < ?", (time.time() - NONCE_TTL_SECONDS,))
        try:
            con.execute("INSERT INTO openapi_nonces(nonce,app_id,ts) VALUES (?,?,?)",
                        (scoped_nonce, app_id, time.time()))
        except sqlite3.IntegrityError:
            raise ApiError(409, "REPLAY_DETECTED", "请求已被处理（nonce 重复），请勿重放")
    ctx.openapi_key = key
    return key


def _require_idem(ctx) -> str:
    key = _header(ctx, "Idempotency-Key")
    if not key:
        raise ApiError(400, "MISSING_IDEMPOTENCY_KEY", "缺少必需请求头 Idempotency-Key；重试必须复用同一键")
    if not IDEM_MIN <= len(key) <= IDEM_MAX:
        raise ApiError(400, "INVALID_IDEMPOTENCY_KEY", f"Idempotency-Key 长度须为 {IDEM_MIN}~{IDEM_MAX} 字符")
    return key


# ---------------------------------------------------------------- 查询类

def ping(ctx):
    return {"service": "clinic-his", "status": "UP", "version": __version__, "time": db.now_str()}


def departments(ctx):
    _verify(ctx)
    rows = db.query("SELECT code, name, type FROM departments ORDER BY id")
    return [{"departmentId": r["code"], "name": r["name"], "type": r["type"]} for r in rows]


def doctors(ctx):
    _verify(ctx)
    sql = ("SELECT s.staff_no, s.name, s.title, s.specialty, d.code AS dept_code, d.name AS dept_name "
           "FROM staff s JOIN departments d ON d.id=s.dept_id "
           "WHERE s.role='DOCTOR' AND s.status='ACTIVE'")
    params: tuple = ()
    if ctx.q("departmentId"):
        sql += " AND d.code=?"
        params = (ctx.q("departmentId"),)
    rows = db.query(sql + " ORDER BY s.staff_no", params)
    return [{
        "doctorId": r["staff_no"], "name": r["name"], "title": r["title"],
        "departmentId": r["dept_code"], "departmentName": r["dept_name"],
        "specialty": r["specialty"],
    } for r in rows]


# ---------------------------------------------------------------- 受理

def _order_payload(order: dict) -> dict:
    return {
        "hisOrderNo": order["his_order_no"], "status": order["status"],
        "source": "HIS_LIVE", "mock": False,
        "departmentName": order.get("department_name", ""),
        "doctorName": order.get("doctor_name", ""),
        "acceptedAt": order["created_at"], "replayed": False,
    }


def _order_detail(order: dict) -> dict:
    """受理单详情：带上院内挂号/预排号，便于对账时一眼定位到具体号。"""
    detail = {
        "hisOrderNo": order["his_order_no"], "status": order["status"],
        "appointmentId": order["appointment_id"], "doctorId": order["doctor_id"],
        "departmentId": order["department_id"], "createdAt": order["created_at"],
        "cancelledAt": order["cancelled_at"], "cancelReason": order["cancel_reason"] or None,
    }
    reg = db.query(
        "SELECT reg_no, queue_no, reg_date, status FROM registrations WHERE his_order_no=?",
        (order["his_order_no"],), one=True)
    if reg is not None:
        detail.update({"registrationNo": reg["reg_no"], "queueNo": reg["queue_no"],
                       "visitDate": reg["reg_date"], "registrationStatus": reg["status"]})
    return detail


# ---------------------------------------------------------------- 受理即落院内挂号
#
# 背景（2026-11-22 排查）：原实现只写 openapi_orders（对外受理台账），院内
# registrations / queue_tickets 一行没有 —— 医生站、叫号大屏、日报统计都看不到
# 互联网医院来的患者，等于「平台说挂号成功、院内没有这个人」。
#
# 口径：
#   · 一位患者一次受理 = 一条 registrations（source=WECHAT，status=BOOKED，
#     his_order_no 关联受理单），患者档案按 appId+姓名派生 MRN（同结算演示口径）。
#   · 同时预排 queue_tickets 一行，status=RESERVED —— **不参与叫号**（call_next 只取
#     WAITING），到院签到后由 registration.checkin 复用该票并置 WAITING，
#     避免「没到院就被叫号」和「重复取号」。
#   · 不生成 charges：挂号费仍由院内收费处收取（互联网医院侧支付未接入该接口）。
#   · 号源联动（2026-11-22 二次整改）：受理时按「本院医生 + 就诊日期 + 午别」匹配一条
#     院内 doctor_slots，占号（booked+1）并回填 slot_id；撤销时释放（booked-1）。
#     这样院内「剩余号源」会随小程序挂号实时变化，不再出现「平台挂号成功、HIS 余量不动」。

def _parse_slot_date(raw: str) -> str:
    if not raw:
        return db.today_str()
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date().isoformat()
    except ValueError:
        raise ApiError(400, "VALIDATION_FAILED", "slotDate 格式须为 YYYY-MM-DD",
                       details=[{"field": "slotDate", "reason": "日期格式错误"}])


def _match_slot(con: sqlite3.Connection, doctor_id: int, slot_date: str, slot_time: str):
    """按医生+日期+午别匹配院内号源（上午=AM，下午=PM）。"""
    try:
        hour = int((slot_time or "09:00").split(":")[0])
    except ValueError:
        hour = 9
    period = "AM" if hour < 12 else "PM"
    return con.execute(
        "SELECT id, capacity, booked FROM doctor_slots "
        "WHERE doctor_id=? AND work_date=? AND period=? AND status='OPEN' "
        "ORDER BY start_time LIMIT 1",
        (doctor_id, slot_date, period)).fetchone()


def _ensure_registration(con: sqlite3.Connection, *, app_id: str, his_order_no: str,
                         patient_name: str, doctor: dict, doctor_no: str, dept: dict,
                         dept_code: str, slot_date: str, slot_time: str, ip: str) -> dict:
    """受理成功的院内落地：挂号（占院内号源）+ 预排号（幂等，按 his_order_no 只建一次）。"""
    exist = con.execute(
        "SELECT id, reg_no, queue_no FROM registrations WHERE his_order_no=?",
        (his_order_no,)).fetchone()
    if exist is not None:
        return dict(exist)

    patient = _demo_patient(con, app_id, patient_name) if patient_name else None
    if patient is None:
        # 没有姓名就没有可用的院内患者档案：不伪造，直接说明缺什么
        raise ApiError(400, "VALIDATION_FAILED", "受理互联网医院挂号必须提供 patientName",
                       details=[{"field": "patientName", "reason": "院内挂号需要患者姓名"}])

    created_at = db.now_str()
    temp_no = "TMP-" + secrets.token_hex(8)
    slot = _match_slot(con, doctor["id"], slot_date, slot_time)
    if slot is not None:
        cur = con.execute(
            "UPDATE doctor_slots SET booked=booked+1 WHERE id=? AND booked<capacity AND status='OPEN'",
            (slot["id"],))
        if cur.rowcount == 0:
            raise conflict("院内该时段号源已约满，请换时段或改约", "HIS_SLOT_FULL")
        slot_id = slot["id"]
    else:
        # 院内未排该时段（例如临时加号）：不占号，但仍建挂号，避免丢患者
        slot_id = None
    cur = con.execute(
        "INSERT INTO registrations(reg_no,patient_id,slot_id,doctor_id,dept_id,reg_date,source,status,"
        "his_order_no,queue_no,vitals_json,created_at,created_by) "
        "VALUES (?,?,?,?,?,?,?, 'BOOKED', ?, '', '', ?, NULL)",
        (temp_no, patient["id"], slot_id, doctor["id"], dept["id"], slot_date,
         "WECHAT", his_order_no, created_at))
    reg_id = int(cur.lastrowid)
    reg_no = f"RG{slot_date.replace('-', '')}-{reg_id:05d}"
    con.execute("UPDATE registrations SET reg_no=? WHERE id=?", (reg_no, reg_id))

    # 取号口径（2026-11-22 整改）：按「就诊日」全局连续发号，跨科室共用一条流水，
    # 不再按「日期+科室」各自从 001 起 —— 否则同一天不同科室/不同患者都显示 001，
    # 与挂号记录 RG…-00002/00003 的连续观感不一致。
    seq = db.next_sequence(con, f"queue-day-{slot_date}")
    ticket_no = f"{dept_code}{seq:03d}"
    con.execute(
        "INSERT INTO queue_tickets(ticket_no,queue_date,dept_id,registration_id,patient_id,"
        "status,created_at) VALUES (?,?,?,?,?, 'RESERVED', ?)",
        (ticket_no, slot_date, dept["id"], reg_id, patient["id"], created_at))
    con.execute("UPDATE registrations SET queue_no=? WHERE id=?", (ticket_no, reg_id))
    security.audit(con, None, "OPENAPI_REG_CREATE", "registration", reg_id,
                   f"hisOrderNo={his_order_no} doctor={doctor_no} dept={dept_code} "
                   f"date={slot_date} time={slot_time} queue={ticket_no}", "OK", ip or "-")
    return {"id": reg_id, "reg_no": reg_no, "queue_no": ticket_no}


def _cancel_registration(con: sqlite3.Connection, his_order_no: str, ip: str) -> int:
    """受理单撤销时同步作废院内挂号与预排号；已签到/已就诊的不动（需走退号流程）。"""
    reg = con.execute(
        "SELECT id, slot_id FROM registrations WHERE his_order_no=? AND status='BOOKED'",
        (his_order_no,)).fetchone()
    if reg is None:
        return 0
    con.execute("UPDATE registrations SET status='CANCELLED' WHERE id=?", (reg["id"],))
    if reg["slot_id"] is not None:
        # 释放受理时占用的院内号源，保证「取消后余号回升」
        con.execute("UPDATE doctor_slots SET booked=MAX(booked-1,0) WHERE id=?",
                    (reg["slot_id"],))
    con.execute(
        "UPDATE queue_tickets SET status='CANCELLED' WHERE registration_id=? "
        "AND status IN ('RESERVED','WAITING')", (reg["id"],))
    security.audit(con, None, "OPENAPI_REG_CANCEL", "registration", reg["id"],
                   f"hisOrderNo={his_order_no} 随受理单撤销", "OK", ip or "-")
    return int(reg["id"])


def create_appointment(ctx):
    key = _verify(ctx)
    idem_key = _require_idem(ctx)

    body = ctx.body
    check_unknown(body, CREATE_FIELDS)
    require_fields(body, ["appointmentId", "doctorId", "departmentId"])
    appointment_id = as_str(body, "appointmentId", required=True, max_len=64)
    doctor_id = as_str(body, "doctorId", required=True, max_len=32)
    department_id = as_str(body, "departmentId", required=True, max_len=32)
    slot_id = as_str(body, "slotId", max_len=64)
    patient_name = as_str(body, "patientName", max_len=50)
    # 就诊日期/时间：平台号源是 UTC Instant，落到院内挂号必须按本地日期分队列，
    # 因此要求调用方显式下发（缺失时按当天处理，兼容旧客户端）。
    slot_date = _parse_slot_date(as_str(body, "slotDate", max_len=10))
    slot_time = as_str(body, "slotTime", max_len=5)

    with db.tx() as con:
        replay = con.execute(
            "SELECT * FROM openapi_orders WHERE app_id=? AND idem_key=?",
            (key["app_id"], idem_key)).fetchone()
        if replay is None:
            replay = con.execute(
                "SELECT * FROM openapi_orders WHERE appointment_id=? AND app_id=?",
                (appointment_id, key["app_id"])).fetchone()
        if replay is not None:
            if (replay["appointment_id"] != appointment_id
                    or replay["doctor_id"] != doctor_id
                    or replay["department_id"] != department_id):
                raise ApiError(409, "IDEMPOTENCY_KEY_REUSE",
                               "幂等键已用于不同请求，请更换 Idempotency-Key")
            order = dict(replay)
            dept = con.execute("SELECT name FROM departments WHERE code=?", (order["department_id"],)).fetchone()
            doc = con.execute("SELECT name FROM staff WHERE staff_no=?", (order["doctor_id"],)).fetchone()
            order["department_name"] = dept["name"] if dept else ""
            order["doctor_name"] = doc["name"] if doc else ""
            reg = con.execute("SELECT reg_no, queue_no FROM registrations WHERE his_order_no=?",
                              (order["his_order_no"],)).fetchone()
            ctx.status = 200
            payload = _order_payload(order)
            payload["replayed"] = True
            if reg is not None:
                payload["registrationNo"] = reg["reg_no"]
                payload["queueNo"] = reg["queue_no"]
            return payload

        dept = con.execute("SELECT id, name FROM departments WHERE code=?", (department_id,)).fetchone()
        if dept is None:
            raise not_found("科室不存在")
        doc = con.execute(
            "SELECT id, name, dept_id, status FROM staff WHERE staff_no=? AND role='DOCTOR'",
            (doctor_id,)).fetchone()
        if doc is None or doc["status"] != "ACTIVE":
            raise not_found("医生不存在或已停诊")
        if doc["dept_id"] != dept["id"]:
            raise ApiError(400, "VALIDATION_FAILED", "医生不属于该科室",
                           details=[{"field": "departmentId", "reason": "与医生所属科室不一致"}])

        seq = db.next_sequence(con, "openapi-" + db.today_str().replace("-", ""))
        his_order_no = f"CLN{db.today_str().replace('-', '')}-{seq:06d}"
        created_at = db.now_str()
        try:
            con.execute(
                "INSERT INTO openapi_orders(his_order_no,idem_key,app_id,appointment_id,slot_id,"
                "patient_name_mask,patient_name_hash,doctor_id,department_id,status,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?, 'ACCEPTED', ?)",
                (his_order_no, idem_key, key["app_id"], appointment_id, slot_id,
                 security.mask_name(patient_name), security.patient_hash(patient_name),
                 doctor_id, department_id, created_at))
        except sqlite3.IntegrityError:
            raise ApiError(409, "IDEMPOTENCY_KEY_REUSE", "幂等键并发冲突，请使用原请求重试")
        security.audit(con, None, "OPENAPI_ACCEPT", "openapi_order", his_order_no,
                       f"appId={key['app_id']} appointmentId={appointment_id} "
                       f"doctor={doctor_id} dept={department_id}", "OK", ctx.ip)
        # 受理即落院内：registrations（医生站/日报可见）+ queue_tickets（RESERVED，不参与叫号）
        reg = _ensure_registration(con, app_id=key["app_id"], his_order_no=his_order_no,
                                   patient_name=patient_name, doctor=doc, doctor_no=doctor_id,
                                   dept=dept, dept_code=department_id,
                                   slot_date=slot_date, slot_time=slot_time, ip=ctx.ip)
        ctx.status = 201
        return {
            "hisOrderNo": his_order_no, "status": "ACCEPTED",
            "source": "HIS_LIVE", "mock": False,
            "departmentName": dept["name"], "doctorName": doc["name"],
            "registrationNo": reg["reg_no"], "queueNo": reg["queue_no"],
            "visitDate": slot_date, "visitTime": slot_time,
            "acceptedAt": created_at, "replayed": False,
        }


def get_order(ctx):
    _verify(ctx)
    key = ctx.openapi_key
    order = db.query("SELECT * FROM openapi_orders WHERE his_order_no=? AND app_id=?",
                     (ctx.params["his_order_no"], key["app_id"]), one=True)
    if order is None:
        raise not_found("受理单号不存在")
    return _order_detail(order)


def cancel_order(ctx):
    _verify(ctx)
    key = ctx.openapi_key
    _require_idem(ctx)
    his_order_no = ctx.params["his_order_no"]
    reason = as_str(ctx.body or {}, "reason", max_len=200)

    with db.tx() as con:
        order = con.execute("SELECT * FROM openapi_orders WHERE his_order_no=? AND app_id=?",
                            (his_order_no, key["app_id"])).fetchone()
        if order is None:
            # 与 HisClient.cancel 约定一致：单号不存在按已撤销处理（幂等），
            # 但绝不触碰其他应用的单据；若命中他方单号则留审计痕迹。
            foreign = con.execute("SELECT 1 FROM openapi_orders WHERE his_order_no=?",
                                  (his_order_no,)).fetchone()
            if foreign:
                security.audit(con, None, "OPENAPI_CANCEL_DENIED", "openapi_order", his_order_no,
                               f"appId={key['app_id']} reason=cross-tenant", "DENY", ctx.ip)
            return {"hisOrderNo": his_order_no, "status": "CANCELLED", "idempotent": True}
        if order["status"] == "CANCELLED":
            return {"hisOrderNo": his_order_no, "status": "CANCELLED", "idempotent": True}
        con.execute("UPDATE openapi_orders SET status='CANCELLED', cancelled_at=?, cancel_reason=? "
                    "WHERE id=?", (db.now_str(), reason, order["id"]))
        cancelled_reg = _cancel_registration(con, his_order_no, ctx.ip)
        security.audit(con, None, "OPENAPI_CANCEL", "openapi_order", his_order_no,
                       f"appId={key['app_id']} reason={reason[:50]} reg={cancelled_reg}", "OK", ctx.ip)
    return {"hisOrderNo": his_order_no, "status": "CANCELLED", "idempotent": False,
            "registrationCancelled": bool(cancelled_reg)}


# ---------------------------------------------------------------- 演示账单（P0-1）

def _demo_patient(con: sqlite3.Connection, app_id: str, patient_name: str) -> dict:
    """按 appId+姓名 派生演示 MRN；不存在则建。姓名原样存患者档案，不写入日志/回执。"""
    mrn = "DEMO-" + hashlib.sha256(f"{app_id}|{patient_name}".encode("utf-8")).hexdigest()[:10].upper()
    row = con.execute("SELECT id, mrn FROM patients WHERE mrn=?", (mrn,)).fetchone()
    if row is not None:
        return dict(row)
    con.execute(
        "INSERT INTO patients(mrn,name,gender,birth_date,id_last4,id_hash,phone_mask,phone_hash,"
        "address,allergy,chronic_tags,created_at) "
        "VALUES (?,?, '女', '', '', ?, '', '', '演示地址', '', '[]', ?)",
        (mrn, patient_name, security.patient_hash(patient_name), db.now_str()))
    row = con.execute("SELECT id, mrn FROM patients WHERE mrn=?", (mrn,)).fetchone()
    return dict(row)


def _charge_payload(charge: dict, replayed: bool) -> dict:
    return {
        "chargeNo": charge["charge_no"],
        "amount": round(float(charge["amount"]), 2),
        "status": charge["status"],
        "source": "DEMO",
        "replayed": replayed,
    }


def create_demo_charge(ctx):
    """POST /openapi/v1/demo/charges：按 appId+refType+refId 建演示账单（幂等）。"""
    key = _verify(ctx)
    idem_key = _require_idem(ctx)

    body = ctx.body
    check_unknown(body, DEMO_CHARGE_FIELDS)
    require_fields(body, ["patientName", "amount", "refType", "refId"])
    patient_name = as_str(body, "patientName", required=True, max_len=50)
    amount = as_float(body, "amount", minimum=0.01, maximum=10000.0)
    description = as_str(body, "description", max_len=100, default="演示挂号费")
    ref_type = as_str(body, "refType", required=True, max_len=32)
    ref_id = as_str(body, "refId", required=True, max_len=64)
    if ref_type not in {"APPOINTMENT", "REGISTRATION", "OTHER"}:
        raise ApiError(400, "VALIDATION_FAILED", "refType 仅支持 APPOINTMENT / REGISTRATION / OTHER")

    with db.tx() as con:
        # 同幂等键必须对应同一 ref；同 ref 已建过则回放同一账单
        replay = con.execute(
            "SELECT * FROM charges WHERE openapi_app_id=? AND openapi_idem_key=?",
            (key["app_id"], idem_key)).fetchone()
        if replay is not None:
            if replay["ref_type"] != ref_type or str(replay["ref_id"]) != ref_id:
                raise ApiError(409, "IDEMPOTENCY_KEY_REUSE", "幂等键已用于不同账单")
            ctx.status = 200
            return _charge_payload(dict(replay), True)

        replay = con.execute(
            "SELECT * FROM charges WHERE openapi_app_id=? AND ref_type=? AND ref_id=? "
            "AND status IN ('UNPAID','PAID')",
            (key["app_id"], ref_type, ref_id)).fetchone()
        if replay is not None:
            ctx.status = 200
            return _charge_payload(dict(replay), True)

        patient = _demo_patient(con, key["app_id"], patient_name)
        seq = db.next_sequence(con, "demo-charge-" + db.today_str().replace("-", ""))
        charge_no = f"DCHG{db.today_str().replace('-', '')}-{seq:06d}"
        created_at = db.now_str()
        try:
            con.execute(
                "INSERT INTO charges(charge_no,patient_id,visit_id,category,description,amount,status,"
                "ref_type,ref_id,cashier_id,paid_at,created_at,openapi_app_id,openapi_idem_key) "
                "VALUES (?,?,NULL,'REGISTRATION',?,?,'UNPAID',?,?,NULL,NULL,?,?,?)",
                (charge_no, patient["id"], description, amount, ref_type, ref_id,
                 created_at, key["app_id"], idem_key))
        except sqlite3.IntegrityError:
            raise ApiError(409, "IDEMPOTENCY_KEY_REUSE", "幂等键并发冲突，请使用原请求重试")
        security.audit(con, None, "OPENAPI_DEMO_CHARGE", "charge", charge_no,
                       f"appId={key['app_id']} ref={ref_type}/{ref_id} amount={amount}", "OK", ctx.ip)
        row = con.execute("SELECT * FROM charges WHERE charge_no=?", (charge_no,)).fetchone()
        ctx.status = 201
        return _charge_payload(dict(row), False)


def get_demo_charge(ctx):
    _verify(ctx)
    charge = db.query("SELECT * FROM charges WHERE charge_no=? AND openapi_app_id=?",
                      (ctx.params["charge_no"], ctx.openapi_key["app_id"]), one=True)
    if charge is None:
        raise not_found("演示账单不存在")
    return _charge_payload(dict(charge), False)


def pay_demo_charge(ctx):
    """POST /openapi/v1/charges/{charge_no}/pay：金额严格比对，UNPAID→PAID，幂等审计。"""
    key = _verify(ctx)
    idem_key = _require_idem(ctx)
    charge_no = ctx.params["charge_no"]

    body = ctx.body or {}
    check_unknown(body, PAY_FIELDS)
    require_fields(body, ["amount", "source"])
    amount = as_float(body, "amount", minimum=0.01, maximum=10000.0)
    source = as_str(body, "source", required=True, max_len=16)
    if source not in {"DEMO", "SANDBOX"}:
        raise ApiError(400, "VALIDATION_FAILED", "source 仅支持 DEMO / SANDBOX")

    with db.tx() as con:
        charge = con.execute("SELECT * FROM charges WHERE charge_no=? AND openapi_app_id=?",
                             (charge_no, key["app_id"])).fetchone()
        if charge is None:
            raise not_found("演示账单不存在")

        existing = con.execute("SELECT * FROM openapi_payments WHERE app_id=? AND idem_key=?",
                               (key["app_id"], idem_key)).fetchone()
        if existing is not None:
            if existing["charge_no"] != charge_no:
                raise ApiError(409, "IDEMPOTENCY_KEY_REUSE", "幂等键已用于其他账单")
            return _charge_payload(dict(charge), True)

        if charge["status"] == "PAID":
            return _charge_payload(dict(charge), True)
        if charge["status"] != "UNPAID":
            raise ApiError(409, "CHARGE_NOT_PAYABLE", f"账单状态 {charge['status']} 不可支付")
        if abs(float(charge["amount"]) - amount) > 0.005:
            raise ApiError(400, "AMOUNT_MISMATCH", "支付金额与账单金额不一致")

        paid_at = db.now_str()
        try:
            con.execute(
                "INSERT INTO openapi_payments(charge_no,app_id,idem_key,amount,source,paid_at,created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (charge_no, key["app_id"], idem_key, amount, source, paid_at, paid_at))
        except sqlite3.IntegrityError:
            raise ApiError(409, "IDEMPOTENCY_KEY_REUSE", "幂等键并发冲突，请使用原请求重试")
        con.execute("UPDATE charges SET status='PAID', paid_at=? WHERE id=?",
                    (paid_at, charge["id"]))
        security.audit(con, None, "OPENAPI_DEMO_PAY", "charge", charge_no,
                       f"appId={key['app_id']} amount={amount} source={source}", "OK", ctx.ip)
        row = con.execute("SELECT * FROM charges WHERE charge_no=?", (charge_no,)).fetchone()
        ctx.status = 200
        return _charge_payload(dict(row), False)


# ---------------------------------------------------------------- 检查预约（P0-2）

def _exam_payload(order: dict, replayed: bool) -> dict:
    return {
        "examOrderNo": order["exam_order_no"],
        "requestNo": order["request_no"],
        "itemCode": order["item_code"],
        "itemName": order["item_name"],
        "price": round(float(order["price"]), 2),
        "slotKey": order["slot_key"],
        "slotDate": order["slot_date"],
        "slotTime": order["slot_time"],
        "status": order["status"],
        "source": "DEMO",
        "replayed": replayed,
    }


def _exam_slots(con: sqlite3.Connection, item_code: str) -> dict:
    """生成未来 7 天演示排期；同一 item+slot 只允许 1 笔 BOOKED。"""
    start = date.today() + timedelta(days=1)
    booked = {
        r["slot_key"] for r in con.execute(
            "SELECT slot_key FROM openapi_exam_orders WHERE item_code=? "
            "AND status='BOOKED' AND slot_date>=?", (item_code, start.isoformat()))
    }
    slots = []
    for day_offset in range(EXAM_WINDOW_DAYS):
        day = start + timedelta(days=day_offset)
        for tm in EXAM_SLOT_TIMES:
            key = day.strftime("%Y%m%d") + "-" + tm.replace(":", "")
            slots.append({
                "slotKey": key, "slotDate": day.isoformat(), "slotTime": tm,
                "available": key not in booked,
            })
    return {"itemCode": item_code, "slots": slots}


def list_exam_items(ctx):
    _verify(ctx)
    rows = db.query("SELECT code,name,category,price FROM lab_items ORDER BY code")
    return [{
        "itemCode": r["code"], "itemName": r["name"], "category": r["category"],
        "price": round(float(r["price"]), 2), "demo": True,
    } for r in rows]


def list_exam_slots(ctx):
    _verify(ctx)
    item_code = ctx.params["item_code"]
    item = db.query("SELECT code,name FROM lab_items WHERE code=?", (item_code,), one=True)
    if item is None:
        raise not_found("检查项目不存在")
    with db.tx() as con:
        payload = _exam_slots(con, item_code)
    payload["itemName"] = item["name"]
    return payload


def create_exam_order(ctx):
    key = _verify(ctx)
    idem_key = _require_idem(ctx)

    body = ctx.body
    check_unknown(body, EXAM_CREATE_FIELDS)
    require_fields(body, ["requestNo", "itemCode", "slotKey", "patientName"])
    request_no = as_str(body, "requestNo", required=True, max_len=64)
    item_code = as_str(body, "itemCode", required=True, max_len=32)
    slot_key = as_str(body, "slotKey", required=True, max_len=32)
    patient_name = as_str(body, "patientName", required=True, max_len=50)
    try:
        datetime.strptime(slot_key, "%Y%m%d-%H%M")
    except ValueError:
        raise ApiError(400, "VALIDATION_FAILED", "slotKey 须为 yyyyMMdd-HHmm",
                       details=[{"field": "slotKey", "reason": "格式错误"}])

    with db.tx() as con:
        replay = con.execute(
            "SELECT * FROM openapi_exam_orders WHERE app_id=? AND idem_key=?",
            (key["app_id"], idem_key)).fetchone()
        if replay is not None:
            if (replay["request_no"] != request_no or replay["item_code"] != item_code
                    or replay["slot_key"] != slot_key):
                raise ApiError(409, "IDEMPOTENCY_KEY_REUSE", "幂等键已用于不同检查预约")
            ctx.status = 200
            return _exam_payload(dict(replay), True)

        replay = con.execute(
            "SELECT * FROM openapi_exam_orders WHERE app_id=? AND request_no=?",
            (key["app_id"], request_no)).fetchone()
        if replay is not None:
            if replay["item_code"] != item_code or replay["slot_key"] != slot_key:
                raise ApiError(409, "REQUEST_NO_REUSE", "检查申请号已用于不同项目/时段")
            ctx.status = 200
            return _exam_payload(dict(replay), True)

        item = con.execute("SELECT code,name,price FROM lab_items WHERE code=?", (item_code,)).fetchone()
        if item is None:
            raise not_found("检查项目不存在")
        slot = next((s for s in _exam_slots(con, item_code)["slots"] if s["slotKey"] == slot_key), None)
        if slot is None:
            raise ApiError(400, "SLOT_INVALID", "所选时段不在可预约排期内")
        if not slot["available"]:
            raise ApiError(409, "SLOT_TAKEN", "该时段已被预约，请换一个时段")

        patient = _demo_patient(con, key["app_id"], patient_name)
        seq = db.next_sequence(con, "openapi-exam-" + db.today_str().replace("-", ""))
        exam_order_no = f"EXM{db.today_str().replace('-', '')}-{seq:06d}"
        created_at = db.now_str()
        try:
            con.execute(
                "INSERT INTO openapi_exam_orders(exam_order_no,request_no,app_id,idem_key,patient_id,"
                "item_code,item_name,price,slot_key,slot_date,slot_time,status,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?, 'BOOKED', ?)",
                (exam_order_no, request_no, key["app_id"], idem_key, patient["id"],
                 item["code"], item["name"], item["price"], slot_key,
                 slot["slotDate"], slot["slotTime"], created_at))
        except sqlite3.IntegrityError:
            raise ApiError(409, "SLOT_TAKEN", "该时段已被预约，请换一个时段")
        security.audit(con, None, "OPENAPI_EXAM_BOOK", "exam_order", exam_order_no,
                       f"appId={key['app_id']} requestNo={request_no} item={item_code} slot={slot_key}",
                       "OK", ctx.ip)
        row = con.execute("SELECT * FROM openapi_exam_orders WHERE exam_order_no=?",
                          (exam_order_no,)).fetchone()
        ctx.status = 201
        return _exam_payload(dict(row), False)


def get_exam_order(ctx):
    _verify(ctx)
    order = db.query("SELECT * FROM openapi_exam_orders WHERE exam_order_no=? AND app_id=?",
                     (ctx.params["exam_order_no"], ctx.openapi_key["app_id"]), one=True)
    if order is None:
        raise not_found("检查预约不存在")
    return _exam_payload(dict(order), False)


def cancel_exam_order(ctx):
    _verify(ctx)
    key = ctx.openapi_key
    _require_idem(ctx)
    order_no = ctx.params["exam_order_no"]
    reason = as_str(ctx.body or {}, "reason", max_len=200)

    with db.tx() as con:
        order = con.execute("SELECT * FROM openapi_exam_orders WHERE exam_order_no=? AND app_id=?",
                            (order_no, key["app_id"])).fetchone()
        if order is None:
            raise not_found("检查预约不存在")
        if order["status"] == "CANCELLED":
            return _exam_payload(dict(order), True)
        if order["status"] != "BOOKED":
            raise ApiError(409, "STATE_CONFLICT", f"当前状态 {order['status']} 不可取消")
        con.execute("UPDATE openapi_exam_orders SET status='CANCELLED', cancelled_at=?, cancel_reason=? "
                    "WHERE id=?", (db.now_str(), reason, order["id"]))
        security.audit(con, None, "OPENAPI_EXAM_CANCEL", "exam_order", order_no,
                       f"appId={key['app_id']} reason={reason[:50]}", "OK", ctx.ip)
        row = con.execute("SELECT * FROM openapi_exam_orders WHERE exam_order_no=?", (order_no,)).fetchone()
        ctx.status = 200
        return _exam_payload(dict(row), False)


def register(router):
    router.add("GET", r"/openapi/v1/ping", ping, auth=False)
    router.add("GET", r"/openapi/v1/departments", departments, auth=False)
    router.add("GET", r"/openapi/v1/doctors", doctors, auth=False)
    router.add("POST", r"/openapi/v1/appointments", create_appointment, auth=False)
    router.add("GET", r"/openapi/v1/appointments/(?P<his_order_no>[A-Za-z0-9\-]+)",
               get_order, auth=False)
    router.add("POST", r"/openapi/v1/appointments/(?P<his_order_no>[A-Za-z0-9\-]+)/cancel",
               cancel_order, auth=False)
    # P0-1 演示账单：建单/查询/标记支付（全部 HMAC 签名，写操作另需 Idempotency-Key）
    router.add("POST", r"/openapi/v1/demo/charges", create_demo_charge, auth=False)
    router.add("GET", r"/openapi/v1/charges/(?P<charge_no>[A-Za-z0-9\-]+)",
               get_demo_charge, auth=False)
    router.add("POST", r"/openapi/v1/charges/(?P<charge_no>[A-Za-z0-9\-]+)/pay",
               pay_demo_charge, auth=False)
    # P0-2 检查预约：项目/排期只读 + 建单/查询/取消（全部 HMAC 签名，写操作另需 Idempotency-Key）
    router.add("GET", r"/openapi/v1/exam-items", list_exam_items, auth=False)
    router.add("GET", r"/openapi/v1/exam-items/(?P<item_code>[A-Za-z0-9\-]+)/slots",
               list_exam_slots, auth=False)
    router.add("POST", r"/openapi/v1/exam-orders", create_exam_order, auth=False)
    router.add("GET", r"/openapi/v1/exam-orders/(?P<exam_order_no>[A-Za-z0-9\-]+)",
               get_exam_order, auth=False)
    router.add("POST", r"/openapi/v1/exam-orders/(?P<exam_order_no>[A-Za-z0-9\-]+)/cancel",
               cancel_exam_order, auth=False)
