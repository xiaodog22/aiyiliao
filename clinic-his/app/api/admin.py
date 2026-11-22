"""工作台、日报、审计、合规自检与对接密钥管理。"""

from __future__ import annotations

import ast
import os
import secrets
import sys
from datetime import datetime

from .. import db, legacy_credentials, security
from ..errors import bad_request, not_found
from .common import as_str, pagination, parse_date

# L4（2026-11-22）：种子初始口令不再写死；合规自检改为统计 must_change=1。


def _scalar(sql: str, params: tuple = ()):
    row = db.query(sql, params, one=True)
    if row is None:
        return 0
    return list(row.values())[0] if row else 0


def dashboard(ctx):
    today = db.today_str()
    reg_rows = db.query("SELECT status, COUNT(*) AS c FROM registrations WHERE reg_date=? GROUP BY status",
                        (today,))
    reg = {r["status"]: r["c"] for r in reg_rows}
    visit_rows = db.query("SELECT status, COUNT(*) AS c FROM visits WHERE visit_date=? GROUP BY status",
                          (today,))
    visits = {r["status"]: r["c"] for r in visit_rows}
    return {
        "date": today,
        "registrations": {
            "total": sum(reg.values()), "booked": reg.get("BOOKED", 0),
            "checkedIn": reg.get("CHECKED_IN", 0), "inProgress": reg.get("IN_PROGRESS", 0),
            "finished": reg.get("FINISHED", 0), "cancelled": reg.get("CANCELLED", 0),
        },
        "visits": {"inProgress": visits.get("IN_PROGRESS", 0), "finished": visits.get("FINISHED", 0)},
        "prescriptions": {"pendingReview": _scalar(
            "SELECT COUNT(*) FROM prescriptions WHERE status='SUBMITTED'")},
        "charges": {
            "unpaidCount": _scalar("SELECT COUNT(*) FROM charges WHERE status='UNPAID'"),
            "unpaidAmount": round(float(_scalar("SELECT COALESCE(SUM(amount),0) FROM charges WHERE status='UNPAID'")), 2),
        },
        "queue": {"waiting": _scalar(
            "SELECT COUNT(*) FROM queue_tickets WHERE queue_date=? AND status='WAITING'", (today,))},
        "ph": {
            "open": _scalar("SELECT COUNT(*) FROM ph_tasks WHERE status='OPEN'"),
            "overdue": _scalar(
                "SELECT COUNT(*) FROM ph_tasks WHERE status='OPEN' AND due_at < ?", (db.now_str(),)),
        },
        "drugs": {"lowStock": _scalar("SELECT COUNT(*) FROM drugs WHERE stock<=alert_stock")},
        "revenue": {"todayPaid": round(float(_scalar(
            "SELECT COALESCE(SUM(amount),0) FROM charges WHERE status='PAID' AND substr(paid_at,1,10)=?",
            (today,))), 2)},
    }


def daily_report(ctx):
    date = parse_date(ctx.q("date"))
    by_dept = db.query(
        "SELECT d.id, d.name, "
        "(SELECT COUNT(*) FROM registrations r WHERE r.dept_id=d.id AND r.reg_date=?) AS registrations, "
        "(SELECT COUNT(*) FROM visits v WHERE v.dept_id=d.id AND v.visit_date=? AND v.status='FINISHED') AS finished, "
        "(SELECT COUNT(*) FROM prescriptions p JOIN visits v2 ON v2.id=p.visit_id "
        " WHERE v2.dept_id=d.id AND substr(p.created_at,1,10)=?) AS prescriptions "
        "FROM departments d WHERE d.type='CLINICAL' ORDER BY d.id", (date, date, date))
    by_doctor = db.query(
        "SELECT s.id, s.name, s.title, d.name AS dept_name, "
        "(SELECT COUNT(*) FROM visits v WHERE v.doctor_id=s.id AND v.visit_date=? AND v.status='FINISHED') AS finished, "
        "(SELECT COUNT(*) FROM prescriptions p WHERE p.doctor_id=s.id AND substr(p.created_at,1,10)=?) AS prescriptions "
        "FROM staff s JOIN departments d ON d.id=s.dept_id "
        "WHERE s.role='DOCTOR' AND s.status='ACTIVE' ORDER BY s.staff_no", (date, date))
    revenue_rows = db.query(
        "SELECT category, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount FROM charges "
        "WHERE status='PAID' AND substr(paid_at,1,10)=? GROUP BY category", (date,))
    totals = {
        "registrations": _scalar("SELECT COUNT(*) FROM registrations WHERE reg_date=?", (date,)),
        "visited": _scalar("SELECT COUNT(*) FROM visits WHERE visit_date=?", (date,)),
        "finished": _scalar("SELECT COUNT(*) FROM visits WHERE visit_date=? AND status='FINISHED'", (date,)),
        "prescriptions": _scalar("SELECT COUNT(*) FROM prescriptions WHERE substr(created_at,1,10)=?", (date,)),
        "newPatients": _scalar("SELECT COUNT(*) FROM patients WHERE substr(created_at,1,10)=?", (date,)),
        "revenue": round(float(_scalar(
            "SELECT COALESCE(SUM(amount),0) FROM charges WHERE status='PAID' AND substr(paid_at,1,10)=?",
            (date,))), 2),
    }
    return {
        "date": date, "totals": totals,
        "byDept": [dict(r) for r in by_dept],
        "byDoctor": [dict(r) for r in by_doctor],
        "revenueByCategory": [
            {"category": r["category"], "count": r["count"], "amount": round(float(r["amount"]), 2)}
            for r in revenue_rows],
    }


def audit_logs(ctx):
    where, params = ["1=1"], []
    if ctx.q("date"):
        where.append("substr(ts,1,10)=?")
        params.append(ctx.q("date"))
    if ctx.q("action"):
        where.append("action LIKE ?")
        params.append(f"%{ctx.q('action')}%")
    if ctx.q("username"):
        where.append("username=?")
        params.append(ctx.q("username"))
    if ctx.q("result"):
        where.append("result=?")
        params.append(ctx.q("result"))
    limit, offset = pagination({"limit": ctx.q("limit") or "100", "offset": ctx.q("offset") or "0"})
    rows = db.query(
        "SELECT id, ts, username, role, action, object_type, object_id, ip, detail, result "
        "FROM audit_logs WHERE " + " AND ".join(where) + " ORDER BY id DESC LIMIT ? OFFSET ?",
        tuple(params) + (limit, offset))
    total = _scalar("SELECT COUNT(*) FROM audit_logs WHERE " + " AND ".join(where), tuple(params))
    return {
        "total": total,
        "items": [{
            "id": r["id"], "ts": r["ts"], "username": r["username"], "role": r["role"],
            "action": r["action"], "objectType": r["object_type"], "objectId": r["object_id"],
            "ip": r["ip"], "detail": r["detail"], "result": r["result"],
        } for r in rows],
    }


def verify_audit(ctx):
    return security.verify_audit_chain()


def _scan_non_stdlib_imports(root: str, stdlib: set[str]) -> set[str]:
    """扫描 Python 源码的绝对导入，返回不在标准库名单中的顶层模块名。"""
    found = set()
    for dirpath, _dirs, files in os.walk(root):
        for filename in files:
            if not filename.endswith(".py"):
                continue
            path = os.path.join(dirpath, filename)
            try:
                with open(path, encoding="utf-8") as fh:
                    tree = ast.parse(fh.read(), filename=path)
            except (OSError, SyntaxError):
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    found.update(alias.name.split(".")[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    found.add(node.module.split(".")[0])
    return {name for name in found if name not in stdlib}


def compliance(ctx):
    chain = security.verify_audit_chain()
    patient_columns = [row["name"] for row in db.query(
        "SELECT name FROM pragma_table_info('patients')")]
    plaintext_id = any(col in patient_columns for col in ("id_card", "id_number", "idcard"))
    active_keys = _scalar("SELECT COUNT(*) FROM openapi_keys WHERE status='ACTIVE'")
    backup_dir = os.path.join(db.PROJECT_ROOT, "backups")
    last_backup = ""
    if os.path.isdir(backup_dir):
        files = [os.path.join(backup_dir, f) for f in os.listdir(backup_dir) if f.endswith(".db")]
        if files:
            last_backup = datetime.fromtimestamp(max(os.path.getmtime(f) for f in files)).strftime("%Y-%m-%d %H:%M:%S")

    # ① 口令策略（B3/D-06）：must_change=1 **或** 建号后从未改密，都算未完成首登改密。
    # 原实现只数 must_change=1，把 30 个仍用旧默认口令的存量账号算成"已完成"→ 误报 PASS。
    pending_change = _scalar(
        "SELECT COUNT(*) FROM users WHERE must_change=1 OR "
        + legacy_credentials.NEVER_CHANGED_SQL)
    legacy_unmarked = _scalar(
        "SELECT COUNT(*) FROM users WHERE must_change=0 AND "
        + legacy_credentials.NEVER_CHANGED_SQL)
    role_rows = db.query(
        "SELECT role, COUNT(*) AS c FROM users WHERE must_change=1 OR "
        + legacy_credentials.NEVER_CHANGED_SQL + " GROUP BY role ORDER BY role")
    role_detail = "、".join(f"{row['role']} {row['c']}" for row in role_rows)
    if legacy_unmarked > 0:
        password_status = "FAIL"
        password_state = (f"检测到 {legacy_unmarked} 个存量账号从未改密且未被强制标记"
                          "（迁移未执行或 must_change 被重置）")
    elif pending_change > 0:
        password_status = "WARN"
        password_state = (f"{pending_change} 个账号尚未完成首登改密（{role_detail}；"
                          "改密前业务接口一律 403）")
    else:
        password_status = "PASS"
        password_state = "全部账号已完成首登改密"
    password_item = {
        "key": "password_policy", "name": "口令策略（≥10 位，大小写/数字/符号）",
        "status": password_status,
        "detail": f"PBKDF2-SHA256 12 万次迭代；连续 5 次失败锁定 15 分钟；" + password_state}

    # ② 会话管理：读取配置并统计过期未清理会话
    expired_sessions = _scalar(
        "SELECT COUNT(*) FROM sessions WHERE revoked=0 AND expires_at < ?", (db.now_str(),))
    session_item = {
        "key": "session_policy", "name": "会话管理",
        "status": "PASS" if expired_sessions == 0 else "WARN",
        "detail": f"Token 仅存哈希；{security.SESSION_HOURS}h 绝对超时 + "
                  f"{security.IDLE_MINUTES}min 空闲超时；过期未清理会话 {expired_sessions} 条"}

    # ③ 零依赖：扫描 app/ 导入与标准库名单比对
    stdlib = set(sys.stdlib_module_names) | {"app"}
    non_std = sorted(_scan_non_stdlib_imports(os.path.join(db.PROJECT_ROOT, "app"), stdlib))
    deps_item = {
        "key": "dependencies", "name": "第三方依赖审计",
        "status": "PASS" if not non_std else "FAIL",
        "detail": "纯 Python 标准库，零第三方包，无外部 CDN" if not non_std
                  else "发现非标准库模块：" + "、".join(non_std)}

    # ④ 病历完整性：已完成就诊中缺主诉或缺诊断的条数与占比
    finished = _scalar("SELECT COUNT(*) FROM visits WHERE status='FINISHED'")
    incomplete = _scalar(
        "SELECT COUNT(*) FROM visits v WHERE v.status='FINISHED' AND ("
        "TRIM(COALESCE(v.chief_complaint,''))='' OR ("
        "TRIM(COALESCE(v.diagnosis_name,''))='' AND NOT EXISTS("
        "SELECT 1 FROM visit_diagnoses d WHERE d.visit_id=v.id)))")
    ratio = round(incomplete * 100.0 / finished, 1) if finished else 0.0
    emr_item = {
        "key": "emr", "name": "电子病历完整性",
        "status": "PASS" if incomplete == 0 else "WARN",
        "detail": f"已完成病历 {finished} 份，缺主诉或诊断 {incomplete} 份（{ratio}%）；"
                  "病历不物理删除，完成后修改走更正留痕"}

    items = [
        {"key": "audit_chain", "name": "审计日志哈希链",
         "status": "PASS" if chain["ok"] else "FAIL",
         "detail": f"已校验 {chain['checked']} 条" + ("" if chain["ok"] else f"，断点 id={chain['brokenId']}")},
        password_item,
        session_item,
        {"key": "no_plaintext_id", "name": "证件号/手机号不落明文", "status": "PASS" if not plaintext_id else "FAIL",
         "detail": "患者表仅存后 4 位展示值与加盐 SHA-256 校验值"},
        {"key": "openapi_key", "name": "对外接口密钥", "status": "PASS" if active_keys else "WARN",
         "detail": f"启用中的应用 {active_keys} 个；签名 HMAC-SHA256 + 时间戳 + nonce"},
        {"key": "backup", "name": "数据备份", "status": "PASS" if last_backup else "WARN",
         "detail": f"最近备份：{last_backup}" if last_backup else "尚未执行备份（运行 scripts/backup.py）"},
        deps_item,
        emr_item,
    ]
    summary = {"pass": sum(1 for i in items if i["status"] == "PASS"),
               "warn": sum(1 for i in items if i["status"] == "WARN"),
               "fail": sum(1 for i in items if i["status"] == "FAIL")}
    return {"items": items, "summary": summary}


def get_openapi_key(ctx):
    row = db.query("SELECT * FROM openapi_keys ORDER BY id DESC LIMIT 1", one=True)
    if row is None:
        raise not_found("尚未配置对接密钥")
    reveal = ctx.q("reveal") == "1"
    secret_value = row["app_secret"] if reveal else security.mask_secret(row["app_secret"])
    if reveal:
        with db.tx() as con:
            security.audit(con, ctx.user, "OPENAPI_KEY_REVEAL", "openapi_key", row["app_id"], "", "OK", ctx.ip)
    return {
        "appId": row["app_id"], "appSecret": secret_value, "secretMasked": not reveal,
        "status": row["status"], "createdAt": row["created_at"], "rotatedAt": row["rotated_at"],
    }


def rotate_openapi_key(ctx):
    row = db.query("SELECT * FROM openapi_keys ORDER BY id DESC LIMIT 1", one=True)
    if row is None:
        raise not_found("尚未配置对接密钥")
    new_secret = secrets.token_hex(24)
    with db.tx() as con:
        con.execute("UPDATE openapi_keys SET app_secret=?, rotated_at=? WHERE id=?",
                    (new_secret, db.now_str(), row["id"]))
        security.audit(con, ctx.user, "OPENAPI_KEY_ROTATE", "openapi_key", row["app_id"], "", "OK", ctx.ip)
    return {"appId": row["app_id"], "appSecret": new_secret, "rotated": True}


def workbench(ctx):
    """角色工作台：按岗位返回待办与告警，待办可点击直达对应视图（待办优先）。"""
    user = ctx.user
    role = user["role"]
    staff_id = int(user.get("staff_id") or 0)
    today, now = db.today_str(), db.now_str()
    todos, alerts = [], []

    def add(key: str, label: str, count, view: str, hint: str = "") -> None:
        todos.append({"key": key, "label": label, "count": int(count), "view": view, "hint": hint})

    if role == "DOCTOR":
        waiting = _scalar("SELECT COUNT(*) FROM registrations WHERE reg_date=? AND doctor_id=? AND status='CHECKED_IN'", (today, staff_id))
        doing = _scalar("SELECT COUNT(*) FROM visits WHERE visit_date=? AND doctor_id=? AND status='IN_PROGRESS'", (today, staff_id))
        abn = _scalar("SELECT COUNT(*) FROM lab_orders lo JOIN visits v ON v.id=lo.visit_id "
                      "WHERE v.doctor_id=? AND lo.status='REPORTED' AND lo.abnormal=1", (staff_id,))
        add("waitingVisits", "待接诊", waiting, "doctor", "已签到待开诊")
        add("inProgress", "就诊中", doing, "doctor", "未完成病历")
        add("abnormalReports", "异常检查报告", abn, "lab", "需回看并处理")
        add("criticalReports", "危急值报告", _scalar(
            "SELECT COUNT(*) FROM lab_orders lo JOIN visits v ON v.id=lo.visit_id "
            "WHERE v.doctor_id=? AND lo.status='REPORTED' AND lo.critical=1", (staff_id,)),
            "lab", "须立即复核并记录处理")
    elif role == "NURSE":
        add("waitingQueue", "等待叫号", _scalar(
            "SELECT COUNT(*) FROM queue_tickets WHERE queue_date=? AND status='WAITING'", (today,)),
            "queue", "候诊队列")
        add("pendingOrders", "待执行医嘱", _scalar(
            "SELECT COUNT(*) FROM nursing_orders WHERE status='PENDING'"), "nursing", "护理执行")
        add("inBed", "在床留观", _scalar(
            "SELECT COUNT(*) FROM bed_stays WHERE status='IN'"), "beds", "留观床位")
        add("criticalReports", "危急值报告", _scalar(
            "SELECT COUNT(*) FROM lab_orders WHERE status='REPORTED' AND critical=1"),
            "lab", "配合医生立即处置")
    elif role == "PHARMACIST":
        add("pendingReview", "待审方", _scalar(
            "SELECT COUNT(*) FROM prescriptions WHERE status='SUBMITTED'"), "pharmacy", "合理用药审核")
        add("pendingDispense", "待发药", _scalar(
            "SELECT COUNT(*) FROM prescriptions WHERE status='APPROVED'"), "pharmacy", "已审方待调配")
    elif role == "CASHIER":
        count = _scalar("SELECT COUNT(*) FROM charges WHERE status='UNPAID'")
        amount = float(_scalar("SELECT COALESCE(SUM(amount),0) FROM charges WHERE status='UNPAID'"))
        add("unpaid", "待收费", count, "charge", f"应收 ¥{amount:.2f}")
    elif role == "TECHNICIAN":
        add("pendingReport", "待出报告", _scalar(
            "SELECT COUNT(*) FROM lab_orders WHERE status IN ('APPLIED','SAMPLED')"), "lab", "检查申请")
        add("criticalReports", "危急值报告", _scalar(
            "SELECT COUNT(*) FROM lab_orders WHERE status='REPORTED' AND critical=1"),
            "lab", "已标记危急值，须立即反馈临床")
    elif role == "PUBLIC_HEALTH":
        add("openTasks", "待办任务", _scalar(
            "SELECT COUNT(*) FROM ph_tasks WHERE status='OPEN'"), "ph", "公卫随访/上报")
        add("overdueTasks", "逾期任务", _scalar(
            "SELECT COUNT(*) FROM ph_tasks WHERE status='OPEN' AND due_at < ?", (now,)), "ph", "需优先处理")
    else:  # ADMIN / DIRECTOR / MEDICAL_AFFAIRS
        count = _scalar("SELECT COUNT(*) FROM charges WHERE status='UNPAID'")
        amount = float(_scalar("SELECT COALESCE(SUM(amount),0) FROM charges WHERE status='UNPAID'"))
        add("pendingReview", "待审方", _scalar(
            "SELECT COUNT(*) FROM prescriptions WHERE status='SUBMITTED'"), "pharmacy")
        add("unpaid", "待收费", count, "charge", f"应收 ¥{amount:.2f}")
        add("lowStock", "库存预警", _scalar(
            "SELECT COUNT(*) FROM drugs WHERE stock<=alert_stock"), "pharmacy")
        add("auditToday", "今日审计", _scalar(
            "SELECT COUNT(*) FROM audit_logs WHERE substr(ts,1,10)=?", (today,)), "system")
        add("criticalReports", "危急值报告", _scalar(
            "SELECT COUNT(*) FROM lab_orders WHERE status='REPORTED' AND critical=1"),
            "lab", "跟踪危急值处置闭环")

    crit = _scalar("SELECT COUNT(*) FROM lab_orders WHERE status='REPORTED' AND critical=1")
    if crit and role in ("DOCTOR", "NURSE", "TECHNICIAN", "ADMIN", "DIRECTOR", "MEDICAL_AFFAIRS"):
        alerts.append({"level": "danger", "message": f"危急值报告 {crit} 项", "view": "lab"})

    abn = _scalar("SELECT COUNT(*) FROM lab_orders WHERE status='REPORTED' AND abnormal=1")
    if abn:
        alerts.append({"level": "warn", "message": f"异常检查报告 {abn} 项待回看", "view": "lab"})
    low = _scalar("SELECT COUNT(*) FROM drugs WHERE stock<=alert_stock")
    if low:
        alerts.append({"level": "warn", "message": f"药品库存预警 {low} 项", "view": "pharmacy"})
    overdue = _scalar("SELECT COUNT(*) FROM ph_tasks WHERE status='OPEN' AND due_at < ?", (now,))
    if overdue:
        alerts.append({"level": "warn", "message": f"公卫任务逾期 {overdue} 项", "view": "ph"})

    return {"role": role, "roleName": user.get("role_name", role),
            "deptName": user.get("dept_name", ""), "todos": todos, "alerts": alerts}


def register(router):
    router.add("GET", r"/api/v1/dashboard", dashboard)
    router.add("GET", r"/api/v1/workbench", workbench)
    router.add("GET", r"/api/v1/reports/daily", daily_report, perm="report.view")
    router.add("GET", r"/api/v1/audit-logs", audit_logs, perm="audit.view")
    router.add("GET", r"/api/v1/audit-logs/verify", verify_audit, perm="audit.view")
    router.add("GET", r"/api/v1/system/compliance", compliance, perm="system.admin")
    router.add("GET", r"/api/v1/system/openapi-key", get_openapi_key, perm="system.admin")
    router.add("POST", r"/api/v1/system/openapi-key/rotate", rotate_openapi_key, perm="system.admin")
