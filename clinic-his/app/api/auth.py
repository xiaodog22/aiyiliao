"""登录、注销、当前用户、修改口令。"""

from __future__ import annotations

from datetime import datetime, timedelta

from .. import db, security
from ..errors import ApiError
from .common import as_str, require_fields


def _user_payload(row) -> dict:
    return {
        "username": row["username"],
        "name": row["staff_name"] or row["username"],
        "staffNo": row["staff_no"] or "",
        "title": row["title"] or "",
        "role": row["role"],
        "roleName": security.ROLE_NAMES.get(row["role"], row["role"]),
        "deptName": row["dept_name"] or "",
        "mustChange": bool(row["must_change"]),
        "perms": sorted(security.perms_for(row["role"])),
    }


def login(ctx):
    require_fields(ctx.body, ["username", "password"])
    username = as_str(ctx.body, "username", required=True, max_len=40)
    password = as_str(ctx.body, "password", required=True, max_len=64)

    if not security.ip_login_allowed(ctx.ip):
        raise ApiError(429, "TOO_MANY_REQUESTS", "尝试过于频繁，请稍后再试", retryable=True)

    con = db.connect()
    try:
        row = con.execute(
            "SELECT u.*, st.name AS staff_name, st.staff_no, st.title, d.name AS dept_name "
            "FROM users u LEFT JOIN staff st ON st.id=u.staff_id "
            "LEFT JOIN departments d ON d.id=st.dept_id WHERE u.username=?", (username,)
        ).fetchone()
        if row is None:
            security.record_ip_attempt(ctx.ip)
            security.audit_login_failure(username, ctx.ip, "USER_NOT_FOUND")
            raise ApiError(401, "INVALID_CREDENTIALS", "账号或口令错误")

        if row["status"] != "ACTIVE":
            security.audit_login_failure(username, ctx.ip, "ACCOUNT_DISABLED")
            raise ApiError(403, "ACCOUNT_DISABLED", "账号已停用，请联系管理员")

        now = datetime.now()
        locked_until = row["locked_until"]
        if locked_until:
            try:
                locked_dt = datetime.strptime(locked_until, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                locked_dt = None
            if locked_dt and locked_dt > now:
                minutes = max(1, int((locked_dt - now).total_seconds() // 60) + 1)
                raise ApiError(403, "ACCOUNT_LOCKED", f"账号已锁定，请 {minutes} 分钟后重试")

        if not security.verify_password(password, row["password_hash"]):
            security.record_ip_attempt(ctx.ip)
            failed = int(row["failed_count"]) + 1
            if failed >= security.MAX_LOGIN_FAILURES:
                until = (now + timedelta(minutes=security.LOCK_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
                con.execute("UPDATE users SET failed_count=0, locked_until=? WHERE id=?", (until, row["id"]))
                con.commit()
                security.audit_login_failure(username, ctx.ip, "MAX_FAILURES_LOCKED")
                raise ApiError(403, "ACCOUNT_LOCKED",
                               f"口令连续错误 {security.MAX_LOGIN_FAILURES} 次，账号锁定 {security.LOCK_MINUTES} 分钟")
            con.execute("UPDATE users SET failed_count=? WHERE id=?", (failed, row["id"]))
            con.commit()
            security.audit_login_failure(username, ctx.ip, "BAD_PASSWORD")
            raise ApiError(401, "INVALID_CREDENTIALS", "账号或口令错误")

        con.execute("UPDATE users SET failed_count=0, locked_until=NULL, last_login_at=? WHERE id=?",
                    (db.now_str(), row["id"]))
        con.commit()
    finally:
        con.close()

    token = security.create_session(row["id"], ctx.ip, ctx.headers.get("User-Agent", "") if ctx.headers else "")
    with db.tx() as txcon:
        security.audit(txcon, {"id": row["id"], "username": username, "role": row["role"]},
                       "AUTH_LOGIN", "user", username, "", "OK", ctx.ip)

    user = _user_payload(row)
    return {"token": token, "expiresIn": security.SESSION_HOURS * 3600, "user": user}


def logout(ctx):
    security.revoke_session(ctx.token)
    with db.tx() as con:
        security.audit(con, ctx.user, "AUTH_LOGOUT", "user", ctx.user["username"], "", "OK", ctx.ip)
    return {"loggedOut": True}


def me(ctx):
    return _user_payload({
        "username": ctx.user["username"], "staff_name": ctx.user["staff_name"],
        "staff_no": ctx.user["staff_no"], "title": ctx.user["title"], "role": ctx.user["role"],
        "dept_name": ctx.user["dept_name"], "must_change": ctx.user["must_change"],
    })


def change_password(ctx):
    require_fields(ctx.body, ["oldPassword", "newPassword"])
    old = as_str(ctx.body, "oldPassword", required=True, max_len=64)
    new = as_str(ctx.body, "newPassword", required=True, max_len=64)

    con = db.connect()
    try:
        row = con.execute("SELECT * FROM users WHERE id=?", (ctx.user["id"],)).fetchone()
        if row is None or not security.verify_password(old, row["password_hash"]):
            raise ApiError(400, "OLD_PASSWORD_INVALID", "原口令不正确")
        if old == new:
            raise ApiError(400, "VALIDATION_FAILED", "新口令不得与原口令相同")
        err = security.validate_password(new, ctx.user["username"])
        if err:
            raise ApiError(400, "PASSWORD_WEAK", err)
        con.execute("UPDATE users SET password_hash=?, password_changed_at=?, must_change=0 WHERE id=?",
                    (security.hash_password(new), db.now_str(), ctx.user["id"]))
        # 吊销除当前会话外的其他会话
        con.execute("UPDATE sessions SET revoked=1 WHERE user_id=? AND revoked=0 "
                    "AND token_hash<>?", (ctx.user["id"], security._token_hash(ctx.token)))
        security.audit(con, ctx.user, "PASSWORD_CHANGE", "user", ctx.user["username"], "", "OK", ctx.ip)
        con.commit()
    finally:
        con.close()
    return {"changed": True}


def register(router):
    router.add("POST", r"/api/v1/auth/login", login, auth=False)
    router.add("POST", r"/api/v1/auth/logout", logout)
    router.add("GET", r"/api/v1/auth/me", me)
    router.add("POST", r"/api/v1/auth/password", change_password)
