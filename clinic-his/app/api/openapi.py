"""对外接口 /openapi/v1：模拟真实医院 HIS 的受理契约（HMAC-SHA256 签名）。

对照主项目 HisClient：book → POST /appointments（受理返回单号）；
cancel → POST /appointments/{no}/cancel（幂等，不存在/已撤销也按成功处理）。
失败一律显式报错，绝不返回「看似成功」的单号。
"""

from __future__ import annotations

import sqlite3
import time

from .. import __version__, db, security
from ..errors import ApiError, not_found
from .common import as_str, check_unknown, require_fields

TIMESTAMP_TOLERANCE = 300          # ±300s
NONCE_TTL_SECONDS = 600            # nonce 保留 10 分钟
IDEM_MIN, IDEM_MAX = 8, 128

CREATE_FIELDS = {"appointmentId", "slotId", "patientName", "doctorId", "departmentId"}


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
    return {
        "hisOrderNo": order["his_order_no"], "status": order["status"],
        "appointmentId": order["appointment_id"], "doctorId": order["doctor_id"],
        "departmentId": order["department_id"], "createdAt": order["created_at"],
        "cancelledAt": order["cancelled_at"], "cancelReason": order["cancel_reason"] or None,
    }


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
            ctx.status = 200
            payload = _order_payload(order)
            payload["replayed"] = True
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
        ctx.status = 201
        return {
            "hisOrderNo": his_order_no, "status": "ACCEPTED",
            "source": "HIS_LIVE", "mock": False,
            "departmentName": dept["name"], "doctorName": doc["name"],
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
        security.audit(con, None, "OPENAPI_CANCEL", "openapi_order", his_order_no,
                       f"appId={key['app_id']} reason={reason[:50]}", "OK", ctx.ip)
    return {"hisOrderNo": his_order_no, "status": "CANCELLED", "idempotent": False}


def register(router):
    router.add("GET", r"/openapi/v1/ping", ping, auth=False)
    router.add("GET", r"/openapi/v1/departments", departments, auth=False)
    router.add("GET", r"/openapi/v1/doctors", doctors, auth=False)
    router.add("POST", r"/openapi/v1/appointments", create_appointment, auth=False)
    router.add("GET", r"/openapi/v1/appointments/(?P<his_order_no>[A-Za-z0-9\-]+)",
               get_order, auth=False)
    router.add("POST", r"/openapi/v1/appointments/(?P<his_order_no>[A-Za-z0-9\-]+)/cancel",
               cancel_order, auth=False)
