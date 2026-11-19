"""门诊单据渲染与 PDF 打印（零第三方依赖）。

- HTML：服务端拼装，外部 print.css + print.js，供浏览器直接打印/另存为 PDF。
- PDF：调用本机 Edge/Chrome 无头模式打印，缓存到 data/print-cache。
- 访问：短期签名链接（默认 10 分钟），可给小程序 downloadFile 使用；同时保留 Bearer 直连。
- 权限：病历/处方/账单/检查分别校验 RBAC 与医生归属，单据包按权限裁剪。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html as html_lib
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time

from . import db, security
from .errors import ApiError, forbidden, not_found

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
PRINT_CSS = os.path.join(WEB_DIR, "print.css")
CACHE_DIR = os.path.join(os.path.dirname(BASE_DIR), "data", "print-cache")
DOC_TOKEN_TTL = int(os.environ.get("CLINIC_DOC_TOKEN_TTL", "600"))
TEMPLATE_VERSION = "v1.0"


def _load_doc_secret() -> str:
    """签名密钥：优先环境变量，其次持久化文件（首次随机生成，0600），保证重启后链接仍有效。"""
    env_secret = os.environ.get("CLINIC_DOC_SECRET")
    if env_secret:
        return env_secret
    path = os.path.join(db.DATA_DIR, "doc-secret")
    try:
        with open(path, encoding="utf-8") as fh:
            stored = fh.read().strip()
        if stored:
            return stored
    except OSError:
        pass
    generated = secrets.token_hex(32)
    try:
        os.makedirs(db.DATA_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(generated)
        os.chmod(path, 0o600)
    except OSError:
        pass
    return generated


_DOC_SECRET = _load_doc_secret()
_PDF_LOCK = threading.Lock()

KINDS = ("visit", "packet", "prescription", "charge", "lab")

STATUS_NAMES = {
    "BOOKED": "已预约", "CHECKED_IN": "已签到", "IN_PROGRESS": "就诊中", "FINISHED": "已完成",
    "CANCELLED": "已取消", "SUBMITTED": "待审核", "APPROVED": "已通过", "REJECTED": "已驳回",
    "DISPENSED": "已发药", "UNPAID": "待收费", "PAID": "已收费", "VOID": "已作废",
    "APPLIED": "已申请", "SAMPLED": "已采样", "REPORTED": "已出报告",
}

CATEGORY_NAMES = {"REGISTRATION": "挂号费", "DRUG": "药品费", "LAB": "检查费"}


# ---------------------------------------------------------------- 工具

def _esc(value) -> str:
    return html_lib.escape(str(value == None and "" or value))


def _money(value) -> str:
    try:
        return f"¥{float(value or 0):.2f}"
    except (TypeError, ValueError):
        return "¥0.00"


def _status(value: str) -> str:
    return STATUS_NAMES.get(value, value or "—")


def _category(value: str) -> str:
    return CATEGORY_NAMES.get(value, value or "—")


def _text(value) -> str:
    return _esc(value or "—").replace("\n", "<br>")


def _vitals(raw: str) -> dict:
    try:
        data = json.loads(raw or "{}")
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


def _chronic(raw: str) -> list:
    try:
        data = json.loads(raw or "[]")
        return data if isinstance(data, list) else []
    except ValueError:
        return []


def _table(headers: list[str], rows: list[list[str]], empty: str = "—") -> str:
    if not rows:
        return f'<div class="empty-line">—</div>'
    head = "".join(f"<th>{_esc(h)}</th>" for h in headers)
    body = "".join("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in rows)
    return f'<table class="doc-table"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>'


def _meta(items: list[tuple[str, str]]) -> str:
    return '<div class="meta">' + "".join(
        f'<div><span>{_esc(k)}</span>{_esc(v)}</div>' for k, v in items
    ) + "</div>"


def _section(title: str, body: str) -> str:
    return f'<div class="section"><h3>{_esc(title)}</h3>{body}</div>'


def _sign(left: str, right: str) -> str:
    return f'<div class="sign"><div>{left}</div><div>{right}</div></div>'


def _footer(doc_no: str) -> str:
    return (f'<div class="doc-footer"><span>康诊云社区诊所 · 演示系统</span>'
            f'<span>单据号：{_esc(doc_no or "—")}</span>'
            f'<span>打印时间：{_esc(db.now_str())}</span></div>')


_PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} · 康诊云社区诊所</title>
  <link rel="stylesheet" href="/assets/print.css">
</head>
<body>
  <div class="doc-toolbar no-print">
    <button type="button" id="btn-print">打印 / 另存为 PDF</button>
    <button type="button" id="btn-close">关闭</button>
  </div>
  <div class="doc">
    <div class="watermark">演示系统 · 非正式医疗文书</div>
    <header class="doc-header">
      <div class="clinic-name">康诊云社区诊所</div>
      <div class="clinic-sub">Clinic HIS · 门诊单据</div>
    </header>
    <div class="doc-title">{title}</div>
    {body}
    {footer}
  </div>
  <script src="/assets/print.js" defer></script>
</body>
</html>"""


def _page(title: str, body: str, doc_no: str) -> str:
    return _PAGE.format(title=_esc(title), body=body, footer=_footer(doc_no))


# ---------------------------------------------------------------- 数据加载

def _load_visit(visit_id: int):
    return db.query(
        "SELECT v.*, p.name AS patient_name, p.mrn, p.gender, p.birth_date, p.phone_mask, "
        "p.allergy, p.chronic_tags, p.address, s.name AS doctor_name, s.title AS doctor_title, "
        "d.name AS dept_name, r.vitals_json, r.queue_no, r.reg_no "
        "FROM visits v JOIN patients p ON p.id=v.patient_id JOIN staff s ON s.id=v.doctor_id "
        "JOIN departments d ON d.id=v.dept_id JOIN registrations r ON r.id=v.registration_id "
        "WHERE v.id=?", (visit_id,), one=True)


def _load_visit_orders(visit_id: int):
    rx_rows = db.query(
        "SELECT p.*, s.name AS doctor_name, rv.name AS reviewer_name, dp.name AS dispenser_name "
        "FROM prescriptions p JOIN staff s ON s.id=p.doctor_id "
        "LEFT JOIN staff rv ON rv.id=p.reviewer_id LEFT JOIN staff dp ON dp.id=p.dispensed_by "
        "WHERE p.visit_id=? ORDER BY p.id", (visit_id,))
    labs = db.query("SELECT * FROM lab_orders WHERE visit_id=? ORDER BY id", (visit_id,))
    charges = db.query(
        "SELECT c.*, s.name AS cashier_name FROM charges c LEFT JOIN staff s ON s.id=c.cashier_id "
        "WHERE c.visit_id=? ORDER BY c.id", (visit_id,))
    amendments = db.query(
        "SELECT a.*, s.name AS amended_by_name FROM emr_amendments a JOIN staff s ON s.id=a.amended_by "
        "WHERE a.visit_id=? ORDER BY a.id", (visit_id,))
    return rx_rows, labs, charges, amendments


def _load_rx(rx_id: int):
    return db.query(
        "SELECT rx.*, v.visit_no, v.visit_date, v.dept_id, p.name AS patient_name, p.mrn, "
        "p.gender, p.birth_date, p.phone_mask, p.allergy, s.name AS doctor_name, s.title AS doctor_title, "
        "d.name AS dept_name, rv.name AS reviewer_name, dp.name AS dispenser_name "
        "FROM prescriptions rx JOIN visits v ON v.id=rx.visit_id JOIN patients p ON p.id=rx.patient_id "
        "JOIN staff s ON s.id=rx.doctor_id JOIN departments d ON d.id=v.dept_id "
        "LEFT JOIN staff rv ON rv.id=rx.reviewer_id LEFT JOIN staff dp ON dp.id=rx.dispensed_by "
        "WHERE rx.id=?", (rx_id,), one=True)


def _load_charge(charge_id: int):
    return db.query(
        "SELECT c.*, p.name AS patient_name, p.mrn, p.gender, p.birth_date, p.phone_mask, p.allergy, "
        "v.visit_no, v.visit_date, v.doctor_id, "
        "s.name AS cashier_name FROM charges c JOIN patients p ON p.id=c.patient_id "
        "LEFT JOIN visits v ON v.id=c.visit_id LEFT JOIN staff s ON s.id=c.cashier_id "
        "WHERE c.id=?", (charge_id,), one=True)


def _load_lab(order_id: int):
    return db.query(
        "SELECT lo.*, p.name AS patient_name, p.mrn, p.gender, p.birth_date, p.phone_mask, p.allergy, "
        "s.name AS doctor_name, s.title AS doctor_title, d.name AS dept_name, "
        "rb.name AS reporter_name FROM lab_orders lo JOIN patients p ON p.id=lo.patient_id "
        "JOIN staff s ON s.id=lo.doctor_id JOIN visits v ON v.id=lo.visit_id "
        "JOIN departments d ON d.id=v.dept_id LEFT JOIN staff rb ON rb.id=lo.reported_by "
        "WHERE lo.id=?", (order_id,), one=True)


def load_user(user_id: int) -> dict | None:
    row = db.query(
        "SELECT u.*, st.name AS staff_name, st.staff_no, st.title, st.dept_id, d.name AS dept_name "
        "FROM users u LEFT JOIN staff st ON st.id=u.staff_id LEFT JOIN departments d ON d.id=st.dept_id "
        "WHERE u.id=?", (user_id,), one=True)
    if row is None or row["status"] != "ACTIVE":
        return None
    user = dict(row)
    user["perms"] = security.perms_for(user["role"])
    user["role_name"] = security.ROLE_NAMES.get(user["role"], user["role"])
    return user


# ---------------------------------------------------------------- 权限

def _is_all(perms: set[str], role: str) -> bool:
    return "visit.read.all" in perms or role in ("ADMIN", "DIRECTOR", "MEDICAL_AFFAIRS")


def _authorize_visit(user: dict, visit) -> None:
    perms, role, staff_id = user.get("perms", set()), user.get("role"), user.get("staff_id")
    if "visit.read" not in perms:
        raise forbidden("无病历查看权限")
    if "visit.read.all" in perms or role in ("ADMIN", "DIRECTOR", "MEDICAL_AFFAIRS"):
        return
    if role == "DOCTOR" and visit["doctor_id"] == staff_id:
        return
    if role == "NURSE":
        # 护士站需要打印分诊/护理用病历；本次记录审计，后续可按队列进一步收窄
        return
    raise forbidden("仅可打印本人接诊病历")


def _authorize_rx(user: dict, rx) -> None:
    perms, role, staff_id = user.get("perms", set()), user.get("role"), user.get("staff_id")
    if "rx.read" not in perms:
        raise forbidden("无处方查看权限")
    if role == "DOCTOR" and rx["doctor_id"] != staff_id:
        raise forbidden("仅可打印本人开具处方")


def _authorize_charge(user: dict, charge) -> None:
    perms, role, staff_id = user.get("perms", set()), user.get("role"), user.get("staff_id")
    if "charge.read" in perms:
        return
    if role == "DOCTOR" and charge["doctor_id"] == staff_id:
        # 医生可打印本人接诊患者的缴费单，但不能遍历收费列表
        return
    raise forbidden("无收费单查看权限")


def _authorize_lab(user: dict, order) -> None:
    perms, role, staff_id = user.get("perms", set()), user.get("role"), user.get("staff_id")
    if "lab.read" not in perms:
        raise forbidden("无检查单查看权限")
    if role == "DOCTOR" and order["doctor_id"] != staff_id:
        raise forbidden("仅可打印本人开具检查单")


def authorize(kind: str, doc_id: int, user: dict) -> dict:
    if kind not in KINDS:
        raise not_found("单据类型不存在")
    if kind in ("visit", "packet"):
        visit = _load_visit(doc_id)
        if visit is None:
            raise not_found("就诊记录不存在")
        _authorize_visit(user, visit)
        return {"visit": visit}
    if kind == "prescription":
        rx = _load_rx(doc_id)
        if rx is None:
            raise not_found("处方不存在")
        _authorize_rx(user, rx)
        return {"rx": rx}
    if kind == "charge":
        charge = _load_charge(doc_id)
        if charge is None:
            raise not_found("账单不存在")
        _authorize_charge(user, charge)
        return {"charge": charge}
    if kind == "lab":
        order = _load_lab(doc_id)
        if order is None:
            raise not_found("检查申请不存在")
        _authorize_lab(user, order)
        return {"lab": order}
    raise not_found("单据类型不存在")


# ---------------------------------------------------------------- 单据正文

def _patient_meta(row, extra: list[tuple[str, str]] | None = None) -> str:
    items = [
        ("患者", row["patient_name"]), ("性别", row["gender"]),
        ("病历号", row["mrn"]), ("出生日期", row["birth_date"] or "—"),
        ("联系电话", row["phone_mask"] or "—"), ("过敏史", row["allergy"] or "—"),
    ]
    if extra:
        items.extend(extra)
    return _meta(items)


def _visit_body(visit, with_orders: bool = True) -> str:
    vit = _vitals(visit["vitals_json"])
    chronic = _chronic(visit["chronic_tags"])
    vital_rows = [
        ("体温", f'{vit.get("temperature", "—")} ℃'),
        ("血压", f'{vit.get("systolic", "—")}/{vit.get("diastolic", "—")} mmHg'),
        ("脉搏", f'{vit.get("pulse", "—")} 次/分'),
        ("身高", f'{vit.get("height", "—")} cm'),
        ("体重", f'{vit.get("weight", "—")} kg'),
    ]
    parts = [
        _meta([
            ("病历号", visit["visit_no"]), ("就诊日期", visit["visit_date"]),
            ("科室", visit["dept_name"]), ("接诊医师", f'{visit["doctor_name"]} {visit["doctor_title"]}'),
            ("挂号号", visit["reg_no"]), ("队列号", visit["queue_no"] or "—"),
            ("状态", _status(visit["status"])), ("慢病标签", "、".join(chronic) or "—"),
        ]),
        _patient_meta(visit),
        _section("生命体征", _meta(vital_rows)),
        _section("主诉", f'<div class="text">{_text(visit["chief_complaint"])}</div>'),
        _section("现病史", f'<div class="text">{_text(visit["present_illness"])}</div>'),
        _section("既往史", f'<div class="text">{_text(visit["past_history"])}</div>'),
        _section("体格检查", f'<div class="text">{_text(visit["physical_exam"])}</div>'),
        _section("诊断", _meta([
            ("ICD-10", visit["diagnosis_code"] or "—"),
            ("诊断名称", visit["diagnosis_name"] or "—"),
            ("诊断说明", visit["diagnosis_note"] or "—"),
        ])),
        _section("处理意见", f'<div class="text">{_text(visit["treatment_advice"])}</div>'),
    ]
    if with_orders:
        rx_rows, labs, _charges, amendments = _load_visit_orders(visit["id"])
        rx_table = _table(
            ["处方号", "状态", "金额", "审方药师", "发药时间"],
            [[_esc(r["rx_no"]), _esc(_status(r["status"])) + " " + _esc(r["review_comment"] or ""),
              _money(r["total_amount"]), _esc(r["reviewer_name"] or "—"), _esc(r["dispensed_at"] or "—")]
             for r in rx_rows],
        )
        lab_table = _table(
            ["申请号", "项目", "状态", "结论"],
            [[_esc(r["order_no"]), _esc(r["item_name"]), _esc(_status(r["status"])),
              _esc(r["report_conclusion"] or "—")] for r in labs],
        )
        parts.append(_section("处方", rx_table))
        parts.append(_section("检查", lab_table))
        if amendments:
            parts.append(_section("更正留痕", "".join(
                f'<div class="text small">{_esc(a["amended_at"])} · {_esc(a["amended_by_name"])} · '
                f'{_esc(a["reason"])}</div>' for a in amendments)))
    parts.append(_sign(
        f'医师签名：{_esc(visit["doctor_name"])}',
        f'日期：{_esc((visit["finished_at"] or visit["started_at"] or "")[:10])}'))
    return "".join(parts)


def _rx_body(rx) -> str:
    items = db.query("SELECT * FROM prescription_items WHERE prescription_id=? ORDER BY id", (rx["id"],))
    rows = [[
        _esc(i["drug_name"]), _esc(i["spec"] or "—"), _esc(i["dosage"]), _esc(i["frequency"]),
        f'{int(i["days"])} 天', f'{int(i["quantity"])}', _money(i["unit_price"]), _money(i["amount"]),
    ] for i in items]
    return "".join([
        _meta([
            ("处方号", rx["rx_no"]), ("开方日期", (rx["created_at"] or "")[:10]),
            ("患者", rx["patient_name"]), ("病历号", rx["mrn"]),
            ("科室", rx["dept_name"]), ("医师", f'{rx["doctor_name"]} {rx["doctor_title"]}'),
            ("状态", _status(rx["status"])), ("关联就诊", rx["visit_no"]),
        ]),
        _patient_meta(rx),
        _section("处方明细", _table(
            ["药品", "规格", "用法", "频次", "天数", "数量", "单价", "金额"], rows)),
        _section("合计", f'<div class="total">合计金额：{_money(rx["total_amount"])}</div>'),
        _section("审方与发药", _meta([
            ("审方药师", rx["reviewer_name"] or "—"), ("审方意见", rx["review_comment"] or "—"),
            ("审方时间", rx["reviewed_at"] or "—"), ("发药药师", rx["dispenser_name"] or "—"),
            ("发药时间", rx["dispensed_at"] or "—"),
        ])),
        _sign(f'医师签名：{_esc(rx["doctor_name"])}', f'日期：{_esc((rx["created_at"] or "")[:10])}'),
    ])


def _charge_body(charge) -> str:
    return "".join([
        _meta([
            ("账单号", charge["charge_no"]), ("开单日期", (charge["created_at"] or "")[:10]),
            ("患者", charge["patient_name"]), ("病历号", charge["mrn"]),
            ("类别", _category(charge["category"]), ), ("状态", _status(charge["status"])),
            ("关联就诊", charge["visit_no"] or "—"), ("收费员", charge["cashier_name"] or "—"),
            ("收费时间", charge["paid_at"] or "—"),
        ]),
        _patient_meta(charge),
        _section("收费明细", _table(
            ["项目", "数量", "金额"],
            [[_esc(charge["description"] or _category(charge["category"])), "1", _money(charge["amount"])]])),
        _section("合计", f'<div class="total">应收金额：{_money(charge["amount"])}</div>'),
        _section("备注", f'<div class="text">{_text(charge["void_reason"] or "—")}</div>'),
        _sign(f'收费员：{_esc(charge["cashier_name"] or "—")}',
              f'日期：{_esc((charge["paid_at"] or charge["created_at"] or "")[:10])}'),
    ])


def _lab_body(order) -> str:
    abnormal = "异常" if order["abnormal"] else "未见异常"
    return "".join([
        _meta([
            ("申请号", order["order_no"]), ("申请日期", (order["created_at"] or "")[:10]),
            ("患者", order["patient_name"]), ("病历号", order["mrn"]),
            ("科室", order["dept_name"]), ("开单医师", f'{order["doctor_name"]} {order["doctor_title"]}'),
            ("检查项目", order["item_name"]), ("状态", _status(order["status"])),
        ]),
        _patient_meta(order),
        _section("检查申请", _table(
            ["项目", "价格", "状态"],
            [[_esc(order["item_name"]), _money(order["price"]), _esc(_status(order["status"]))]])),
        _section("检查所见", f'<div class="text">{_text(order["report_findings"])}</div>'),
        _section("检查结论", f'<div class="text">{_text(order["report_conclusion"])}</div>'),
        _section("结果判定", f'<div class="text">{_esc(abnormal)}</div>'),
        _sign(f'报告人：{_esc(order["reporter_name"] or "—")}',
              f'报告时间：{_esc(order["reported_at"] or "—")}'),
    ])


# ---------------------------------------------------------------- 渲染入口

def render_html(kind: str, doc_id: int, user: dict) -> tuple[str, str, str]:
    """返回 (html, title, doc_no)。"""
    ctx = authorize(kind, doc_id, user)
    if kind == "visit":
        visit = ctx["visit"]
        return _page("门诊病历", _visit_body(visit, with_orders=True), visit["visit_no"]), "门诊病历", visit["visit_no"]
    if kind == "packet":
        visit = ctx["visit"]
        perms = user.get("perms", set())
        rx_rows, labs, charges, _amendments = _load_visit_orders(visit["id"])
        include_rx = "rx.read" in perms
        include_lab = "lab.read" in perms
        include_charge = "charge.read" in perms or (
            user.get("role") == "DOCTOR" and visit["doctor_id"] == user.get("staff_id"))
        blocks = [_visit_body(visit, with_orders=False)]
        if include_rx:
            for rx in rx_rows:
                blocks.append('<div class="page-break"></div><div class="doc-title sub">处方 / 取药单</div>' + _rx_body(rx))
        if include_lab:
            for order in labs:
                blocks.append('<div class="page-break"></div><div class="doc-title sub">检查申请 / 报告单</div>' + _lab_body(order))
        if include_charge:
            for charge in charges:
                blocks.append('<div class="page-break"></div><div class="doc-title sub">缴费单</div>' + _charge_body(charge))
        return _page("就诊单据包", "".join(blocks), visit["visit_no"]), "就诊单据包", visit["visit_no"]
    if kind == "prescription":
        rx = ctx["rx"]
        return _page("处方 / 取药单", _rx_body(rx), rx["rx_no"]), "处方 / 取药单", rx["rx_no"]
    if kind == "charge":
        charge = ctx["charge"]
        return _page("缴费单", _charge_body(charge), charge["charge_no"]), "缴费单", charge["charge_no"]
    if kind == "lab":
        order = ctx["lab"]
        return _page("检查申请 / 报告单", _lab_body(order), order["order_no"]), "检查申请 / 报告单", order["order_no"]
    raise not_found("单据类型不存在")


# ---------------------------------------------------------------- 签名链接

def _sign_token(kind: str, doc_id: int, user_id: int) -> str:
    payload = json.dumps({"k": kind, "i": doc_id, "u": user_id,
                          "e": int(time.time()) + DOC_TOKEN_TTL},
                         separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    body = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    sig = hmac.new(_DOC_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    return body + "." + sig


def verify_token(token: str) -> dict:
    if not token or "." not in token:
        raise ApiError(403, "DOC_LINK_INVALID", "打印链接无效")
    body, sig = token.split(".", 1)
    expected = hmac.new(_DOC_SECRET.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise ApiError(403, "DOC_LINK_INVALID", "打印链接无效或已被篡改")
    try:
        raw = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ApiError(403, "DOC_LINK_INVALID", "打印链接无效")
    if int(payload.get("e", 0)) < int(time.time()):
        raise ApiError(410, "DOC_LINK_EXPIRED", "打印链接已过期，请重新生成")
    return payload


def make_links(kind: str, doc_id: int, user: dict) -> dict:
    authorize(kind, doc_id, user)
    token = _sign_token(kind, doc_id, int(user["id"]))
    return {
        "htmlUrl": f"/api/v1/documents/render?t={token}&format=html",
        "pdfUrl": f"/api/v1/documents/render?t={token}&format=pdf",
        "expiresIn": DOC_TOKEN_TTL,
        "expiresAt": db.now_str(),
    }


# ---------------------------------------------------------------- PDF

def _browser_path() -> str | None:
    env = os.environ.get("CLINIC_PDF_BROWSER")
    candidates = [
        env,
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return path
    for name in ("chromium", "chromium-browser", "google-chrome", "microsoft-edge"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _inline_css(page_html: str) -> str:
    try:
        with open(PRINT_CSS, "r", encoding="utf-8") as fh:
            css = fh.read()
    except OSError:
        css = ""
    page_html = page_html.replace(
        '<link rel="stylesheet" href="/assets/print.css">',
        f"<style>{css}</style>")
    page_html = re.sub(r'<script src="/assets/print\.js" defer></script>', "", page_html)
    return page_html


def _clean_cache() -> None:
    try:
        cutoff = time.time() - 7 * 86400
        for name in os.listdir(CACHE_DIR):
            path = os.path.join(CACHE_DIR, name)
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.remove(path)
    except OSError:
        pass


def render_pdf(page_html: str, cache_key: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    pdf_path = os.path.join(CACHE_DIR, cache_key + ".pdf")
    with _PDF_LOCK:
        if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 1000:
            return pdf_path
        browser = _browser_path()
        if not browser:
            raise ApiError(503, "PDF_ENGINE_UNAVAILABLE",
                           "未找到 Edge/Chrome，无法生成 PDF；可先用浏览器打印")
        html_path = os.path.join(CACHE_DIR, cache_key + ".html")
        with open(html_path, "w", encoding="utf-8") as fh:
            fh.write(_inline_css(page_html))
        try:
            file_url = "file:///" + html_path.replace("\\", "/").lstrip("/")
            for headless in ("--headless=new", "--headless"):
                cmd = [browser, headless, "--disable-gpu", "--no-pdf-header-footer",
                       "--allow-file-access-from-files", "--disable-extensions",
                       "--run-all-compositor-stages-before-draw", "--virtual-time-budget=3000",
                       f"--print-to-pdf={pdf_path}", file_url]
                try:
                    subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                except (OSError, subprocess.TimeoutExpired):
                    continue
                if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 1000:
                    break
                try:
                    os.remove(pdf_path)
                except OSError:
                    pass
            if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) <= 1000:
                raise ApiError(503, "PDF_ENGINE_FAILED",
                               "PDF 生成失败；请确认本机 Edge/Chrome 可用，或使用浏览器打印")
            _clean_cache()
            return pdf_path
        finally:
            try:
                os.remove(html_path)
            except OSError:
                pass


def pdf_cache_key(kind: str, doc_id: int, page_html: str) -> str:
    raw = f"{TEMPLATE_VERSION}|{kind}|{doc_id}|{page_html}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()
