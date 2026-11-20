"""安全层：口令、会话、RBAC、脱敏、审计哈希链、接口签名。"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from datetime import datetime, timedelta

from . import db
from .errors import ApiError, forbidden, unauthorized

PBKDF2_ITERATIONS = 120000
SESSION_HOURS = 8
IDLE_MINUTES = 30
MAX_LOGIN_FAILURES = 5
LOCK_MINUTES = 15

# ---------------------------------------------------------------- RBAC

ALL_PERMS = {
    "patient.read", "patient.read.all", "patient.write", "clinical.read",
    "reg.read", "reg.write", "reg.checkin",
    "queue.read", "queue.call",
    "visit.read", "visit.read.all", "visit.write",
    "rx.read", "rx.write", "rx.review", "rx.dispense",
    "drug.read", "drug.stock",
    "charge.read", "charge.pay", "charge.void", "charge.refund",
    "lab.read", "lab.order", "lab.report",
    "ph.read", "ph.complete",
    "bed.read", "bed.write",
    "nursing.read", "nursing.write",
    "staff.read", "schedule.write",
    "report.view", "audit.view", "system.admin",
}

# 病历全文读取（clinical.read）只授予诊疗与质控岗位；患者跨医生读取（patient.read.all）只授予管理与质控岗位。
# 系统管理员保留全部系统权限，但按整改要求不授予 clinical.read，患者 EMR 文本仍按脱敏口径返回。
ROLE_PERMS = {
    "ADMIN": ALL_PERMS - {"clinical.read"},
    "DIRECTOR": {
        "patient.read", "patient.read.all", "clinical.read",
        "reg.read", "queue.read", "visit.read.all", "rx.read",
        "charge.read", "charge.void", "charge.refund", "report.view", "audit.view", "staff.read",
        "ph.read", "lab.read", "drug.read", "bed.read", "nursing.read",
    },
    "MEDICAL_AFFAIRS": {
        "patient.read", "patient.read.all", "clinical.read",
        "reg.read", "visit.read.all", "rx.read", "charge.read",
        "charge.void", "report.view", "audit.view", "staff.read", "schedule.write",
        "ph.read", "lab.read", "drug.read", "bed.read", "nursing.read",
    },
    "DOCTOR": {
        "patient.read", "clinical.read", "patient.write", "reg.read", "queue.read", "queue.call",
        "visit.read", "visit.write", "rx.read", "rx.write",
        "lab.read", "lab.order", "report.view", "ph.read", "drug.read",
        "bed.read", "bed.write", "nursing.read",
    },
    "NURSE": {
        "patient.read", "clinical.read", "reg.read", "reg.checkin", "queue.call", "queue.read",
        "visit.read", "ph.read",
        "bed.read", "bed.write", "nursing.read", "nursing.write",
    },
    "PUBLIC_HEALTH": {
        "patient.read", "reg.read", "queue.read", "ph.read", "ph.complete",
        "report.view",
    },
    "PHARMACIST": {
        "patient.read", "rx.read", "rx.review", "rx.dispense", "drug.stock",
        "drug.read",
    },
    "CASHIER": {
        "patient.read", "patient.write", "reg.read", "reg.write", "reg.checkin",
        "charge.read", "charge.pay", "charge.refund",
    },
    "TECHNICIAN": {
        "patient.read", "lab.read", "lab.report",
    },
}

ROLE_NAMES = {
    "ADMIN": "系统管理员",
    "DIRECTOR": "院长",
    "MEDICAL_AFFAIRS": "医务科",
    "DOCTOR": "医师",
    "NURSE": "护士",
    "PUBLIC_HEALTH": "公共卫生",
    "PHARMACIST": "药师",
    "CASHIER": "收费员",
    "TECHNICIAN": "医技技师",
}


def perms_for(role: str) -> set[str]:
    return set(ROLE_PERMS.get(role, set()))


def has_perm(user: dict | None, perm: str) -> bool:
    if not user:
        return False
    return perm in user.get("perms", set())


def require_perm(user: dict | None, perm: str) -> None:
    if not has_perm(user, perm):
        raise forbidden()


# ---------------------------------------------------------------- 口令

def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt, expected = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iters))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def validate_password(password: str, username: str = "") -> str | None:
    """返回错误文案；合规返回 None。"""
    if not isinstance(password, str) or len(password) < 10:
        return "口令长度不得少于 10 位"
    if len(password) > 64:
        return "口令长度不得超过 64 位"
    checks = [
        (any(c.isupper() for c in password), "须包含大写字母"),
        (any(c.islower() for c in password), "须包含小写字母"),
        (any(c.isdigit() for c in password), "须包含数字"),
        (any(not c.isalnum() for c in password), "须包含符号"),
    ]
    for ok, msg in checks:
        if not ok:
            return "口令" + msg
    if username and username.lower() in password.lower():
        return "口令不得包含账号名"
    return None


# ---------------------------------------------------------------- 登录限速（IP 维度，进程内）

_login_lock = threading.Lock()
_login_windows: dict[str, list[float]] = {}


def ip_login_allowed(ip: str) -> bool:
    now = time.time()
    with _login_lock:
        attempts = [t for t in _login_windows.get(ip, []) if now - t < 300]
        _login_windows[ip] = attempts
        return len(attempts) < 20


def record_ip_attempt(ip: str) -> None:
    with _login_lock:
        _login_windows.setdefault(ip, []).append(time.time())


# ---------------------------------------------------------------- 会话

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def create_session(user_id: int, ip: str, ua: str) -> str:
    token = secrets.token_urlsafe(32)
    now = datetime.now()
    with db.tx() as con:
        con.execute(
            "INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen,ip,ua,revoked) "
            "VALUES (?,?,?,?,?,?,?,0)",
            (_token_hash(token), user_id, now.strftime("%Y-%m-%d %H:%M:%S"),
             (now + timedelta(hours=SESSION_HOURS)).strftime("%Y-%m-%d %H:%M:%S"),
             now.strftime("%Y-%m-%d %H:%M:%S"), ip[:64], ua[:200]),
        )
    return token


def resolve_session(token: str) -> dict | None:
    if not token:
        return None
    th = _token_hash(token)
    with db.tx() as con:
        row = con.execute(
            "SELECT s.expires_at, s.last_seen, s.revoked, "
            "u.id AS id, u.username, u.role, u.status AS user_status, u.staff_id, u.must_change, "
            "st.name AS staff_name, st.staff_no, st.title, st.dept_id, d.name AS dept_name "
            "FROM sessions s JOIN users u ON u.id=s.user_id "
            "LEFT JOIN staff st ON st.id=u.staff_id LEFT JOIN departments d ON d.id=st.dept_id "
            "WHERE s.token_hash=?", (th,)
        ).fetchone()
        if row is None or row["revoked"]:
            return None
        now = datetime.now()
        expires = _parse_dt(row["expires_at"])
        last_seen = _parse_dt(row["last_seen"])
        if expires is None or expires < now or last_seen is None or (now - last_seen) > timedelta(minutes=IDLE_MINUTES):
            con.execute("UPDATE sessions SET revoked=1 WHERE token_hash=?", (th,))
            return None
        if row["user_status"] != "ACTIVE":
            return None
        con.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?",
                    (now.strftime("%Y-%m-%d %H:%M:%S"), th))
        user = dict(row)
        user["perms"] = perms_for(user["role"])
        user["role_name"] = ROLE_NAMES.get(user["role"], user["role"])
        return user


def revoke_session(token: str) -> None:
    if not token:
        return
    with db.tx() as con:
        con.execute("UPDATE sessions SET revoked=1 WHERE token_hash=?", (_token_hash(token),))


def revoke_user_sessions(con, user_id: int) -> None:
    con.execute("UPDATE sessions SET revoked=1 WHERE user_id=? AND revoked=0", (user_id,))


# ---------------------------------------------------------------- 脱敏

def mask_name(name: str) -> str:
    name = (name or "").strip()
    if len(name) <= 1:
        return name or "—"
    if len(name) == 2:
        return name[0] + "*"
    return name[0] + "*" * (len(name) - 1)


def mask_phone(phone: str) -> str:
    phone = (phone or "").strip()
    if len(phone) >= 7:
        return phone[:3] + "****" + phone[-4:]
    return "****"


def mask_id_card(id_card: str) -> str:
    id_card = (id_card or "").strip()
    return id_card[-4:] if len(id_card) >= 4 else ""


def mask_secret(secret: str) -> str:
    if not secret:
        return ""
    if len(secret) <= 8:
        return "****"
    return secret[:4] + "****" + secret[-4:]


# 患者证件/手机号的不可逆校验值（加盐，防彩虹表）
PATIENT_HASH_SALT = "clinic-his::patient::v1"


def patient_hash(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    return hashlib.sha256((PATIENT_HASH_SALT + value).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- 审计哈希链

def audit(con, user: dict | None, action: str, object_type: str = "", object_id="",
          detail: str = "", result: str = "OK", ip: str = "") -> None:
    """追加审计记录（哈希链，只增不改）。detail 不得包含患者姓名等敏感明文。"""
    row = con.execute("SELECT entry_hash FROM audit_logs ORDER BY id DESC LIMIT 1").fetchone()
    prev_hash = row["entry_hash"] if row else "GENESIS"
    ts = db.now_str()
    user_id = user.get("id") if user else None
    username = user.get("username", "") if user else ""
    role = user.get("role", "") if user else ""
    payload = "|".join([prev_hash, ts, str(user_id), username, role, action,
                        object_type, str(object_id), ip, detail, result])
    entry_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    con.execute(
        "INSERT INTO audit_logs(ts,user_id,username,role,action,object_type,object_id,ip,detail,result,prev_hash,entry_hash) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (ts, user_id, username, role, action, object_type, str(object_id), ip, detail, result, prev_hash, entry_hash),
    )


def verify_audit_chain(limit: int = 0) -> dict:
    con = db.connect()
    try:
        sql = "SELECT * FROM audit_logs ORDER BY id"
        rows = con.execute(sql).fetchall()
        prev = "GENESIS"
        count = 0
        for row in rows:
            payload = "|".join([prev, row["ts"], str(row["user_id"]), row["username"], row["role"],
                                row["action"], row["object_type"], row["object_id"], row["ip"],
                                row["detail"], row["result"]])
            expected = hashlib.sha256(payload.encode("utf-8")).hexdigest()
            if row["prev_hash"] != prev or row["entry_hash"] != expected:
                return {"ok": False, "checked": count, "brokenId": row["id"]}
            prev = row["entry_hash"]
            count += 1
        return {"ok": True, "checked": count, "brokenId": None}
    finally:
        con.close()


# ---------------------------------------------------------------- 对外接口签名

def sign_request(secret: str, method: str, path: str, app_id: str, timestamp: str,
                 nonce: str, body: bytes) -> str:
    body_hash = hashlib.sha256(body or b"").hexdigest()
    string_to_sign = "\n".join([method.upper(), path, app_id, timestamp, nonce, body_hash])
    return hmac.new(secret.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()


def safe_compare(a: str, b: str) -> bool:
    return hmac.compare_digest((a or "").encode("utf-8"), (b or "").encode("utf-8"))


def audit_login_failure(username: str, ip: str, reason: str) -> None:
    with db.tx() as con:
        audit(con, None, "AUTH_LOGIN_FAILED", "user", username, f"reason={reason}", "FAIL", ip)
