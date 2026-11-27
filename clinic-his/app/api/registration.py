"""预约挂号与分诊叫号。"""

from __future__ import annotations

import json
import secrets
import threading
import time

from .. import db, security
from ..errors import ApiError, conflict, not_found
from .common import as_int, as_str, one_of, parse_date, parse_vitals, require_fields

TITLE_FEE = {"主任医师": 20.0, "副主任医师": 18.0, "主治医师": 15.0, "住院医师": 10.0}
DEFAULT_FEE = 10.0

# ---------------------------------------------------------------- 挂号频控
# 背景（2026-11-22）：HIS 只有登录限流，挂号/取消可被脚本无限刷（刷号占号、
# 反复挂号取消制造脏数据）。这里做进程内滑动窗口限流，维度为「操作人 + 患者」。
# 说明：单实例演示足够；多实例部署需换成 Redis 计数（阈值语义不变）。
_RATE_LOCK = threading.Lock()
_RATE_HITS: dict[str, list[float]] = {}


def _limit(key: str, max_hits: int, window_sec: int, message: str) -> None:
    now = time.monotonic()
    with _RATE_LOCK:
        hits = [t for t in _RATE_HITS.get(key, []) if now - t < window_sec]
        if len(hits) >= max_hits:
            _RATE_HITS[key] = hits
            retry = int(window_sec - (now - hits[0])) + 1
            raise ApiError(429, "RATE_LIMITED", message,
                           details=[{"field": "rate", "reason": f"{window_sec} 秒内最多 {max_hits} 次",
                                     "retryAfterSec": max(retry, 1)}])
        hits.append(now)
        _RATE_HITS[key] = hits


def _reg_row(row) -> dict:
    return {
        "id": row["id"], "regNo": row["reg_no"], "patientId": row["patient_id"],
        "patientName": security.mask_name(row["patient_name"]), "patientMrn": row["patient_mrn"],
        "doctorId": row["doctor_id"], "doctorName": row["doctor_name"], "doctorTitle": row["doctor_title"],
        "deptId": row["dept_id"], "deptName": row["dept_name"], "regDate": row["reg_date"],
        "source": row["source"], "status": row["status"], "queueNo": row["queue_no"],
        "feeStatus": row["fee_status"] or "UNKNOWN", "hisOrderNo": row["his_order_no"],
        "createdAt": row["created_at"], "checkedInAt": row["checked_in_at"],
    }


# ---------------------------------------------------------------- 收费单关联口径（2026-11-27）
# 互联网医院（小程序）受理的挂号：平台侧演示账单按 ref_type='APPOINTMENT' + 平台预约 ID 落库
# （business PaymentService.createDemoCharge），院内挂号按 ref_type='REGISTRATION' + registrations.id。
# 只认院内一套会同时造成：已支付仍显示 UNKNOWN、签到被 REG_FEE_UNPAID 拦、取消不联动退费。
# 桥：registrations.his_order_no = openapi_orders.his_order_no → openapi_orders.appointment_id = charges.ref_id
_FEE_OF_REG = (
    "(c.ref_type='REGISTRATION' AND c.ref_id=r.id) OR "
    "(c.ref_type='APPOINTMENT' AND r.his_order_no<>'' AND c.ref_id=("
    "SELECT o.appointment_id FROM openapi_orders o WHERE o.his_order_no=r.his_order_no))"
)
# 复用于 SELECT 子句（别名 r 必须是 registrations）
FEE_STATUS_SUBQ = (
    "(SELECT c.status FROM charges c WHERE " + _FEE_OF_REG +
    " ORDER BY c.id DESC LIMIT 1) AS fee_status "
)
# 按挂号 id 取单/更新时用（子查询内部再按 his_order_no 桥接）
_FEE_OF_REG_ID = (
    "(charges.ref_type='REGISTRATION' AND charges.ref_id=?) OR "
    "(charges.ref_type='APPOINTMENT' AND charges.ref_id=("
    "SELECT o.appointment_id FROM openapi_orders o "
    "JOIN registrations r2 ON r2.his_order_no=o.his_order_no WHERE r2.id=?))"
)

REG_SELECT = (
    "SELECT r.*, p.name AS patient_name, p.mrn AS patient_mrn, s.name AS doctor_name, "
    "s.title AS doctor_title, d.name AS dept_name, " + FEE_STATUS_SUBQ +
    "FROM registrations r JOIN patients p ON p.id=r.patient_id "
    "JOIN staff s ON s.id=r.doctor_id JOIN departments d ON d.id=r.dept_id "
)


def list_registrations(ctx):
    date = parse_date(ctx.q("date"))
    where, params = ["r.reg_date=?"], [date]
    if ctx.q("status"):
        where.append("r.status=?")
        params.append(ctx.q("status"))
    if ctx.q("deptId"):
        where.append("r.dept_id=?")
        params.append(int(ctx.q("deptId")))
    if ctx.q("doctorId"):
        where.append("r.doctor_id=?")
        params.append(int(ctx.q("doctorId")))
    if ctx.q("patientId"):
        where.append("r.patient_id=?")
        params.append(int(ctx.q("patientId")))
    rows = db.query(REG_SELECT + "WHERE " + " AND ".join(where) + " ORDER BY r.id DESC LIMIT 300",
                    tuple(params))
    return [_reg_row(r) for r in rows]


def create_registration(ctx):
    body = ctx.body
    require_fields(body, ["patientId", "slotId"])
    patient_id = as_int(body, "patientId", required=True, minimum=1)
    slot_id = as_int(body, "slotId", required=True, minimum=1)
    source = one_of(as_str(body, "source", default="ONSITE") or "ONSITE",
                    {"ONSITE", "APPOINTMENT", "WECHAT"}, "source")

    # 频控：同一操作人 60 秒内最多 8 单（防批量刷单，先于业务校验，避免无效请求打库）；
    # 同一患者 10 分钟内最多 3 单放到**业务校验之后**——停用医生 / 停诊 / 已约满这类
    # 必被 400/409 拒绝的请求不该吃掉患者配额，也不该把"停用医生"答成 429（BUG-002）。
    _limit(f"reg-create-user:{ctx.user['id']}", 8, 60, "操作过于频繁，请稍后再试（挂号）")

    with db.tx() as con:
        patient = con.execute("SELECT id FROM patients WHERE id=?", (patient_id,)).fetchone()
        if patient is None:
            raise not_found("患者不存在")
        slot = con.execute(
            "SELECT sl.*, s.name AS doctor_name, s.title AS doctor_title, s.status AS doctor_status "
            "FROM doctor_slots sl JOIN staff s ON s.id=sl.doctor_id WHERE sl.id=?", (slot_id,)).fetchone()
        if slot is None:
            raise not_found("号源不存在")
        if slot["status"] != "OPEN":
            raise conflict("该号源已停诊", "SLOT_CLOSED")
        if slot["doctor_status"] != "ACTIVE":
            raise ApiError(400, "DOCTOR_UNAVAILABLE", "该医生已停用，不可挂号",
                           details=[{"field": "slotId", "reason": "医生非在职"}])
        if slot["work_date"] < db.today_str():
            raise conflict("不能预约已过期号源", "SLOT_CLOSED")
        _limit(f"reg-create-patient:{patient_id}", 3, 600, "该患者短时间内挂号次数过多，请稍后再试")
        cur = con.execute(
            "UPDATE doctor_slots SET booked=booked+1 WHERE id=? AND booked<capacity AND status='OPEN'",
            (slot_id,))
        if cur.rowcount == 0:
            raise conflict("该号源已约满", "SLOT_FULL")

        temp_no = "TMP-" + secrets.token_hex(8)
        cur = con.execute(
            "INSERT INTO registrations(reg_no,patient_id,slot_id,doctor_id,dept_id,reg_date,source,status,"
            "his_order_no,queue_no,vitals_json,created_at,created_by) "
            "VALUES (?,?,?,?,?,?,?, 'BOOKED', '', '', '', ?, ?)",
            (temp_no, patient_id, slot_id, slot["doctor_id"], slot["dept_id"], slot["work_date"],
             source, db.now_str(), ctx.user["id"]))
        reg_id = int(cur.lastrowid)
        reg_no = f"RG{slot['work_date'].replace('-', '')}-{reg_id:05d}"
        con.execute("UPDATE registrations SET reg_no=? WHERE id=?", (reg_no, reg_id))

        fee = TITLE_FEE.get(slot["doctor_title"], DEFAULT_FEE)
        charge_no = f"CH{slot['work_date'].replace('-', '')}-R{reg_id:06d}"
        con.execute(
            "INSERT INTO charges(charge_no,patient_id,visit_id,category,description,amount,status,ref_type,ref_id,created_at) "
            "VALUES (?,?,NULL,'REGISTRATION',?,?, 'UNPAID','REGISTRATION',?,?)",
            (charge_no, patient_id,
             f"挂号费（{slot['work_date']} {slot['period']} {slot['doctor_name']} {slot['doctor_title']}）",
             fee, reg_id, db.now_str()))
        security.audit(con, ctx.user, "REG_CREATE", "registration", reg_id,
                       f"slot={slot_id} source={source} fee={fee}", "OK", ctx.ip)
    return {"id": reg_id, "regNo": reg_no, "feeAmount": fee, "status": "BOOKED"}


def checkin(ctx):
    reg_id = int(ctx.params["id"])
    body = ctx.body or {}
    # 体征复用统一解析与合理范围校验（超范围 400 INVALID_VITALS）
    vitals = parse_vitals(body)
    for key, label in (("height", "身高"), ("weight", "体重")):
        if key in body and body[key] not in (None, ""):
            try:
                vitals[key] = round(float(body[key]), 1)
            except (TypeError, ValueError):
                raise ApiError(400, "INVALID_VITALS", f"{label}必须为数字",
                               details=[{"field": key, "reason": "类型错误"}])

    with db.tx() as con:
        reg = con.execute("SELECT * FROM registrations WHERE id=?", (reg_id,)).fetchone()
        if reg is None:
            raise not_found("挂号记录不存在")
        if reg["status"] != "BOOKED":
            raise conflict("当前状态不可签到", "STATE_CONFLICT")
        if reg["reg_date"] != db.today_str():
            raise conflict("仅可对当日挂号签到", "STATE_CONFLICT")
        paid = con.execute(
            "SELECT 1 FROM charges WHERE status='PAID' AND (" + _FEE_OF_REG_ID + ")",
            (reg_id, reg_id)).fetchone()
        if paid is None:
            raise conflict("挂号费尚未收取，请先到收费处缴费", "REG_FEE_UNPAID")

        dept = con.execute("SELECT code FROM departments WHERE id=?", (reg["dept_id"],)).fetchone()
        # 互联网医院受理时已预排一张 RESERVED 票（openapi._ensure_registration）：
        # 签到复用它并转 WAITING，既保证「一挂号一队号」，也不让未到院的预约被叫号。
        reserved = con.execute(
            "SELECT id, ticket_no FROM queue_tickets WHERE registration_id=? AND status='RESERVED'",
            (reg_id,)).fetchone()
        if reserved is not None:
            ticket_no = reserved["ticket_no"]
            con.execute("UPDATE queue_tickets SET status='WAITING', queue_date=? WHERE id=?",
                        (db.today_str(), reserved["id"]))
        else:
            # 按 就诊日 全局取号（跨科室共用一条流水，避免同日各科室都从 001 起）
            seq = db.next_sequence(con, f"queue-day-{db.today_str()}")
            ticket_no = f"{dept['code']}{seq:03d}"
            con.execute(
                "INSERT INTO queue_tickets(ticket_no,queue_date,dept_id,registration_id,patient_id,status,created_at) "
                "VALUES (?,?,?,?,?, 'WAITING', ?)",
                (ticket_no, db.today_str(), reg["dept_id"], reg_id, reg["patient_id"], db.now_str()))
        con.execute(
            "UPDATE registrations SET status='CHECKED_IN', checked_in_at=?, queue_no=?, vitals_json=? WHERE id=?",
            (db.now_str(), ticket_no, json.dumps(vitals, ensure_ascii=False), reg_id))
        security.audit(con, ctx.user, "REG_CHECKIN", "registration", reg_id,
                       f"queueNo={ticket_no} vitals={','.join(vitals.keys())}", "OK", ctx.ip)
    return {"id": reg_id, "queueNo": ticket_no, "status": "CHECKED_IN", "vitals": vitals}


def cancel_registration(ctx):
    reg_id = int(ctx.params["id"])
    # 复用收费退费逻辑：已缴挂号费自动生成 REFUNDED 记录（含审计），未缴的按原逻辑作废
    from .charge import _apply_refund
    with db.tx() as con:
        reg = con.execute("SELECT * FROM registrations WHERE id=?", (reg_id,)).fetchone()
        if reg is None:
            raise not_found("挂号记录不存在")
        # 频控：同一操作人 5 分钟最多 5 次取消；同一患者 10 分钟最多 3 次取消
        _limit(f"reg-cancel-user:{ctx.user['id']}", 5, 300, "取消过于频繁，请稍后再试（取消挂号）")
        _limit(f"reg-cancel-patient:{reg['patient_id']}", 3, 600, "该患者短时间内取消次数过多，请稍后再试")
        if reg["status"] != "BOOKED":
            raise conflict("已签到或已就诊的挂号不可取消，请走退号流程", "STATE_CONFLICT")
        paid = con.execute(
            "SELECT * FROM charges WHERE status='PAID' AND (" + _FEE_OF_REG_ID + ")",
            (reg_id, reg_id)).fetchall()
        for charge_row in paid:
            # _apply_refund 只对 ref_type='REGISTRATION' 联动「置 CANCELLED + 扣回号源」；
            # 平台演示账单是 APPOINTMENT，必须由下面这段收口（rowcount 保证不重复扣）。
            _apply_refund(con, ctx, charge_row, "取消挂号自动退费")
        cur = con.execute(
            "UPDATE registrations SET status='CANCELLED' WHERE id=? AND status<>'CANCELLED'", (reg_id,))
        if cur.rowcount:
            if reg["slot_id"]:
                con.execute("UPDATE doctor_slots SET booked=MAX(booked-1,0) WHERE id=?", (reg["slot_id"],))
        con.execute(
            "UPDATE charges SET status='VOID', void_reason='挂号取消' "
            "WHERE status='UNPAID' AND (" + _FEE_OF_REG_ID + ")", (reg_id, reg_id))
        security.audit(con, ctx.user, "REG_CANCEL", "registration", reg_id,
                       f"refunded={len(paid)}", "OK", ctx.ip)
    return {"id": reg_id, "status": "CANCELLED"}


# ---------------------------------------------------------------- 队列

def list_queue(ctx):
    date = parse_date(ctx.q("date"))
    where, params = ["q.queue_date=?"], [date]
    if ctx.q("deptId"):
        where.append("q.dept_id=?")
        params.append(int(ctx.q("deptId")))
    rows = db.query(
        "SELECT q.*, p.name AS patient_name, p.mrn AS patient_mrn, d.name AS dept_name, "
        "r.status AS reg_status FROM queue_tickets q JOIN patients p ON p.id=q.patient_id "
        "JOIN departments d ON d.id=q.dept_id JOIN registrations r ON r.id=q.registration_id "
        "WHERE " + " AND ".join(where) + " ORDER BY q.id", tuple(params))
    return [{
        "id": r["id"], "ticketNo": r["ticket_no"], "deptId": r["dept_id"], "deptName": r["dept_name"],
        "patientName": security.mask_name(r["patient_name"]), "patientMrn": r["patient_mrn"],
        "patientId": r["patient_id"],
        "registrationId": r["registration_id"], "status": r["status"],
        "regStatus": r["reg_status"], "calledAt": r["called_at"], "doneAt": r["done_at"],
    } for r in rows]


def call_next(ctx):
    require_fields(ctx.body, ["deptId"])
    dept_id = as_int(ctx.body, "deptId", required=True, minimum=1)
    force = ctx.body.get("force") in (True, 1, "1", "true")
    with db.tx() as con:
        current = con.execute(
            "SELECT id, ticket_no FROM queue_tickets WHERE queue_date=? AND dept_id=? "
            "AND status='CALLED' ORDER BY id LIMIT 1", (db.today_str(), dept_id)).fetchone()
        if current is not None:
            if not force:
                raise conflict(
                    f"本科室已有叫号（{current['ticket_no']}）未处理，请先完成就诊或过号；"
                    "如需自动过号请传 force=true", "CALL_IN_PROGRESS")
            con.execute(
                "UPDATE queue_tickets SET status='SKIPPED' "
                "WHERE queue_date=? AND dept_id=? AND status='CALLED'",
                (db.today_str(), dept_id))
        row = con.execute(
            "SELECT q.*, p.name AS patient_name, p.mrn AS patient_mrn FROM queue_tickets q "
            "JOIN patients p ON p.id=q.patient_id "
            "WHERE q.queue_date=? AND q.dept_id=? AND q.status='WAITING' ORDER BY q.id LIMIT 1",
            (db.today_str(), dept_id)).fetchone()
        if row is None:
            return {"called": None, "message": "当前科室暂无等待患者"}
        con.execute("UPDATE queue_tickets SET status='CALLED', called_at=? WHERE id=?",
                    (db.now_str(), row["id"]))
        security.audit(con, ctx.user, "QUEUE_CALL", "queue_ticket", row["id"],
                       f"ticket={row['ticket_no']} dept={dept_id}", "OK", ctx.ip)
    return {"called": {
        "id": row["id"], "ticketNo": row["ticket_no"],
        "patientName": security.mask_name(row["patient_name"]),
        "patientMrn": row["patient_mrn"], "registrationId": row["registration_id"],
        "status": "CALLED",
    }}


def skip_ticket(ctx):
    ticket_id = int(ctx.params["id"])
    with db.tx() as con:
        row = con.execute("SELECT * FROM queue_tickets WHERE id=?", (ticket_id,)).fetchone()
        if row is None:
            raise not_found("队列记录不存在")
        if row["status"] not in ("WAITING", "CALLED"):
            raise conflict("当前状态不可过号", "STATE_CONFLICT")
        con.execute("UPDATE queue_tickets SET status='SKIPPED' WHERE id=?", (ticket_id,))
        security.audit(con, ctx.user, "QUEUE_SKIP", "queue_ticket", ticket_id,
                       f"ticket={row['ticket_no']}", "OK", ctx.ip)
    return {"id": ticket_id, "status": "SKIPPED"}


def register(router):
    router.add("GET", r"/api/v1/registrations", list_registrations, perm="reg.read")
    router.add("POST", r"/api/v1/registrations", create_registration, perm="reg.write")
    router.add("POST", r"/api/v1/registrations/(?P<id>\d+)/checkin", checkin, perm="reg.checkin")
    router.add("POST", r"/api/v1/registrations/(?P<id>\d+)/cancel", cancel_registration, perm="reg.write")
    router.add("GET", r"/api/v1/queue", list_queue, perm="queue.read")
    router.add("POST", r"/api/v1/queue/call-next", call_next, perm="queue.call")
    router.add("POST", r"/api/v1/queue/(?P<id>\d+)/skip", skip_ticket, perm="queue.call")
