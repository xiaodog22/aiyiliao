#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""患者主索引对账（dry-run 优先）

用途：按 `docs/患者主索引映射对账方案_20261127.md` 的 D1~D4 口径，输出一份可人工裁决的对账报表。
默认**只读**，不写任何库；`--apply` 需要 V39 已迁移且显式 `--yes` 才允许写映射表。

用法：
    python tools/patient-reconcile.py                 # dry-run，输出到 artifacts/patient-reconcile/
    python tools/patient-reconcile.py --stdout        # 只打印，不落文件
    python tools/patient-reconcile.py --apply --yes   # 写 patient_index / his_patient_map（需 V39）

依赖：仅标准库 + 本机 mysql 客户端（连接参数取自 backend/deploy/env.local，不硬编码口令）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HIS_DB = ROOT / "clinic-his" / "data" / "clinic.db"
ENV_FILE = ROOT / "backend" / "deploy" / "env.local"
OUT_DIR = ROOT / "artifacts" / "patient-reconcile"

LEGACY_SALT = "clinic-his::patient::v1"
TABLES_V39 = ("patient_index", "his_patient_map")


# --------------------------------------------------------------------- 基础工具

def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def salted(value: str, salt: str) -> str:
    """HIS 口径：sha256(salt + value)，与 clinic-his/app/security.py 一致。"""
    value = (value or "").strip()
    return sha256_hex(salt + value) if value else ""


def load_salts() -> list[tuple[str, str]]:
    """返回 [(标签, 盐)]：当前盐优先，内置 v1 兜底（历史行混用两代盐）。"""
    current = os.environ.get("CLINIC_PATIENT_HASH_SALT", "").strip()
    if not current:
        salt_file = ROOT / "clinic-his" / "data" / ".patient_hash_salt"
        if salt_file.exists():
            current = salt_file.read_text(encoding="utf-8").strip()
    salts = []
    if current:
        salts.append(("current", current))
    salts.append(("v1", LEGACY_SALT))
    return salts


def mask_name(name: str) -> str:
    name = name or ""
    return name[:1] + "*" * max(len(name) - 1, 0)


def slot_date(slot_id: str) -> str:
    """兼容两种号源格式：SL20261119D001AM / slot-doc-x-20261121-0800。"""
    s = slot_id or ""
    m = re.search(r"(\d{4})(\d{2})(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return ""


# --------------------------------------------------------------------- MySQL 只读

def mysql_conf() -> dict:
    conf = {
        "host": "127.0.0.1",
        "port": "3306",
        "user": os.environ.get("MYSQL_USER", ""),
        "password": os.environ.get("MYSQL_PASSWORD", ""),
        "db": "wechar_dev",
    }
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key, val = key.strip(), val.strip().strip('"')
            if key == "MYSQL_URL":
                m = re.search(r"//([^:/]+)(?::(\d+))?/([A-Za-z0-9_]+)", val)
                if m:
                    conf["host"] = m.group(1)
                    conf["port"] = m.group(2) or "3306"
                    conf["db"] = m.group(3)
            elif key == "MYSQL_USER":
                conf["user"] = val
            elif key == "MYSQL_PASSWORD":
                conf["password"] = val
    return conf


def mysql_bin() -> str:
    found = shutil.which("mysql")
    if found:
        return found
    for cand in (r"D:\mysql\MySQL Server 8.0\bin\mysql.exe",
                 r"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"):
        if Path(cand).exists():
            return cand
    raise SystemExit("找不到 mysql 客户端：请把 MySQL bin 目录加入 PATH")


def query(sql: str) -> list[list[str]]:
    conf = mysql_conf()
    cmd = [mysql_bin(), "--default-character-set=utf8mb4", "--batch", "--raw", "-N",
           "-h", conf["host"], "-P", conf["port"], "-u", conf["user"], conf["db"], "-e", sql]
    env = dict(os.environ)
    if conf["password"]:
        env["MYSQL_PWD"] = conf["password"]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=env)
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        raise SystemExit("MySQL 查询失败：" + (detail[-1] if detail else "未知错误"))
    return [line.split("\t") for line in proc.stdout.splitlines() if line != ""]


def mysql_tables() -> set[str]:
    return {r[0].lower() for r in query("SHOW TABLES;") if r}


# --------------------------------------------------------------------- 数据装载

def load_his() -> dict:
    con = sqlite3.connect(HIS_DB)
    con.row_factory = sqlite3.Row
    patients = [dict(r) for r in con.execute(
        "SELECT id, mrn, name, gender, birth_date, id_last4, id_hash, phone_mask, phone_hash, created_at "
        "FROM patients ORDER BY id")]
    counts = {}
    for row in patients:
        pid = row["id"]
        counts[pid] = {
            t: con.execute(f"SELECT COUNT(*) c FROM {t} WHERE patient_id=?", (pid,)).fetchone()["c"]
            for t in ("registrations", "visits", "prescriptions", "lab_orders", "queue_tickets", "charges")
        }
    orders = [dict(r) for r in con.execute(
        "SELECT his_order_no, appointment_id, slot_id, patient_name_mask, patient_name_hash, "
        "doctor_id, department_id, status, created_at FROM openapi_orders ORDER BY created_at")]
    regs = [dict(r) for r in con.execute(
        "SELECT id, reg_no, patient_id, reg_date, source, status, his_order_no FROM registrations")]
    reg_orders = {r["his_order_no"] for r in regs if r["his_order_no"]}
    con.close()
    return {"patients": patients, "counts": counts, "orders": orders,
            "regs": regs, "reg_orders": reg_orders}


def load_platform() -> dict:
    tables = mysql_tables()
    appts = [dict(zip(
        ("id", "user_id", "patient_name", "status", "his_order_no", "slot_id", "created_at"), r))
        for r in query(
            "SELECT id,user_id,patient_name,status,IFNULL(his_order_no,''),IFNULL(slot_id,''),"
            "DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') FROM appointments")]
    profiles = {r[0]: {"birth_date": r[1], "sex": r[2]} for r in query(
        "SELECT user_id, IFNULL(birth_date,''), IFNULL(sex,'') FROM user_profiles")}
    extended = {}
    if "user_extended" in tables:
        extended = {r[0]: {"has_id": r[1] == "1", "verified": r[2] == "1"}
                    for r in query("SELECT user_id, (id_card_hash IS NOT NULL AND id_card_hash<>''), "
                                   "id_card_verified FROM user_extended")}
    users = {r[0]: r[1] for r in query("SELECT id, display_name FROM users")}
    return {"appts": appts, "profiles": profiles, "extended": extended, "users": users,
            "tables": tables}


# --------------------------------------------------------------------- 身份判定

def identity_flags(patient: dict, salts: list[tuple[str, str]]) -> dict:
    """D1 核心：判定 HIS 档案的身份字段是否可信。"""
    name, last4, id_hash = patient["name"], patient["id_last4"] or "", patient["id_hash"] or ""
    placeholder = bool(id_hash) and bool(last4) and any(
        id_hash == salted(last4, salt) for _, salt in salts)
    name_hash = bool(id_hash) and any(id_hash == salted(name, salt) for _, salt in salts)
    return {
        "id_placeholder": placeholder,   # 证件号列其实是短串（如 "0520"）
        "id_is_name_hash": name_hash,    # DEMO 派生把姓名哈希塞进证件号列
        "id_trusted": bool(id_hash) and not placeholder and not name_hash and len(last4) == 4,
    }


# --------------------------------------------------------------------- 报表组装

def build_report(his: dict, plat: dict, salts: list[tuple[str, str]]) -> dict:
    patients = his["patients"]
    counts = his["counts"]
    flags = {p["id"]: identity_flags(p, salts) for p in patients}

    groups: dict[tuple[str, str], list[dict]] = {}
    for a in plat["appts"]:
        groups.setdefault((a["user_id"], a["patient_name"]), []).append(a)

    subjects, mapped = [], set()
    for (uid, name), rows in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        prof = plat["profiles"].get(uid, {})
        ext = plat["extended"].get(uid, {})
        base = {
            "user_id": uid,
            "user_name": plat["users"].get(uid, ""),
            "patient_name": name,
            "appointments": len(rows),
            "with_his_order": sum(1 for r in rows if r["his_order_no"]),
            "platform_birth": prof.get("birth_date", ""),
            # 用户级实名只在「就诊人=账号本人」时才算本条的强标识（代挂号不适用）
            "platform_id_verified": bool(ext.get("verified")) and name == plat["users"].get(uid, ""),
            "platform_self": name == plat["users"].get(uid, ""),
        }
        cands = [p for p in patients if p["name"] == name]
        if not cands:
            subjects.append({**base, "his_mrn": "-", "his_patient_id": "-", "his_birth": "",
                             "his_id_last4": "",
                             "his_counts": {k: 0 for k in ("registrations", "visits", "prescriptions",
                                                          "lab_orders", "queue_tickets", "charges")},
                             "counts_trusted": False, "tier": "-", "status": "UNMAPPED",
                             "reason": "HIS 无同名档案（受理单未落挂号或已取消）"})
            continue

        scored = []
        for p in cands:
            c = counts[p["id"]]
            has_data = any(c[k] > 0 for k in ("registrations", "visits", "charges"))
            birth_ok = bool(prof.get("birth_date")) and prof["birth_date"] == (p["birth_date"] or "")
            scored.append({"p": p, "f": flags[p["id"]], "c": c, "has_data": has_data, "birth_ok": birth_ok})
        with_data = [x for x in scored if x["has_data"]]

        for x in scored:
            p, f, c = x["p"], x["f"], x["c"]
            mapped.add(p["id"])
            if not with_data:
                status, tier = "UNMAPPED", "T4"
                reason = "候选档案均无业务数据，不建 canonical"
            elif len(with_data) > 1:
                status, tier = "CONFLICT", "-"
                reason = f"多个候选有业务数据（{len(with_data)} 条），需人工裁决"
            elif x is not with_data[0]:
                status, tier = "ALIAS", "-"
                reason = ("种子/占位档案（证件号列是短串或姓名哈希，无真实身份）"
                          if (f["id_placeholder"] or f["id_is_name_hash"]) else "业务数据在另一条档案")
            else:
                status = "CONFIRMED"
                if not f["id_trusted"] and not x["birth_ok"]:
                    tier = "DEV_ONLY"
                    reason = "仅姓名一致 + 两端同批 fixture，演示档专用；生产拒绝"
                elif not f["id_trusted"]:
                    tier = "T4"
                    reason = "身份不可信，仅姓名/生日弱证据，需人工确认"
                else:
                    tier = "T3" if x["birth_ok"] else "T4"
                    reason = "证件号可信，缺 phone 因子（两端口径不同）"
            subjects.append({**base, "his_mrn": p["mrn"], "his_patient_id": p["id"],
                             "his_birth": p["birth_date"] or "", "his_id_last4": p["id_last4"] or "",
                             "his_counts": c, "counts_trusted": f["id_trusted"],
                             "tier": tier, "status": status, "reason": reason})

    # ORPHAN：只列演示派生 + 带平台单号的档案（现场建档不在映射范围）
    order_patients = set()
    for r in his["regs"]:
        if r["his_order_no"]:
            order_patients.add(r["patient_id"])
    orphans, onsite_others = [], 0
    for p in patients:
        if p["id"] in mapped:
            continue
        if (p["mrn"] or "").startswith("DEMO-") or p["id"] in order_patients:
            orphans.append({"his_patient_id": p["id"], "mrn": p["mrn"], "name": p["name"],
                            "counts": counts[p["id"]], "identity": flags[p["id"]]})
        else:
            onsite_others += 1

    # D2：平台有单号、HIS 无挂号的单 —— 字段级比对
    his_orders = {o["his_order_no"]: o for o in his["orders"]}
    d2 = []
    for a in plat["appts"]:
        no = a["his_order_no"]
        if not no or no in his["reg_orders"]:
            continue
        o = his_orders.get(no)
        if not o:
            d2.append({"his_order_no": no, "verdict": "HIS_DECLINED"})
            continue
        name_hash_ok = any(o["patient_name_hash"] == salted(a["patient_name"], salt) for _, salt in salts)
        appt_ok = o["appointment_id"] == a["id"]
        slot_ok = (o["slot_id"] or "") == (a["slot_id"] or "")
        fields_ok = appt_ok and slot_ok and name_hash_ok
        if not fields_ok:
            verdict = "MANUAL（字段不一致）"
        elif a["status"] == "CANCELLED" and o["status"] == "CANCELLED":
            verdict = "一致（均已取消，无需动作）"
        elif a["status"] in ("PENDING", "CONFIRMED") and o["status"] == "ACCEPTED":
            verdict = "可补写 CONFIRMED"
        elif a["status"] == "CANCELLED" and o["status"] == "ACCEPTED":
            verdict = "需同步撤销 HIS 单"
        else:
            verdict = f"人工（{a['status']} vs {o['status']}）"
        d2.append({"his_order_no": no, "appointment_id": a["id"], "patient_name": a["patient_name"],
                   "platform_status": a["status"], "his_status": o["status"],
                   "appt_ok": appt_ok, "slot_ok": slot_ok, "name_hash_ok": name_hash_ok,
                   "slot_id": a["slot_id"], "verdict": verdict})

    # D3：未落挂号受理单的「是否可能已线下服务」
    regs_by_patient: dict[int, list[dict]] = {}
    for r in his["regs"]:
        regs_by_patient.setdefault(r["patient_id"], []).append(r)
    d3 = []
    for o in his["orders"]:
        if o["his_order_no"] in his["reg_orders"]:
            continue
        date = slot_date(o["slot_id"])
        full = next((a["patient_name"] for a in plat["appts"] if a["his_order_no"] == o["his_order_no"]), "")
        cands = ([p for p in patients if p["name"] == full] if full
                 else [p for p in patients if mask_name(p["name"]) == o["patient_name_mask"]])
        hits = [r for p in cands for r in regs_by_patient.get(p["id"], []) if date and r["reg_date"] == date]
        offline = [r for r in hits if r["source"] != "WECHAT"]
        verdict = ("可能已线下服务" if offline else "疑重复下单" if hits
                   else "无同日院内记录" if date else "无法判定（缺号源日期）")
        d3.append({"his_order_no": o["his_order_no"], "source": "平台" if full else "直调API",
                   "patient": full or o["patient_name_mask"], "visit_date": date, "verdict": verdict,
                   "evidence": [f"{r['reg_no']}/{r['source']}" for r in (offline or hits)][:3]})

    # D4：历史预约规模
    by_status: dict[str, int] = {}
    for a in plat["appts"]:
        by_status[a["status"]] = by_status.get(a["status"], 0) + 1
    legacy = {"total": len(plat["appts"]), "by_status": by_status,
              "completed": by_status.get("COMPLETED", 0), "checked_in": by_status.get("CHECKED_IN", 0),
              "no_patient_ref": len(plat["appts"])}
    if "patient_index" in plat["tables"]:
        rows = query("SELECT COUNT(*) FROM appointments WHERE patient_ref IS NULL OR patient_ref='';")
        legacy["no_patient_ref"] = int(rows[0][0]) if rows else 0

    # 数据质量：受理单姓名为空（历史编码问题无法自动识别，§6 有说明）
    missing_mask = [o["his_order_no"] for o in his["orders"] if not (o["patient_name_mask"] or "").strip()]

    summary = {
        "subjects": len(subjects),
        "confirmed": sum(1 for s in subjects if s["status"] == "CONFIRMED"),
        "alias": sum(1 for s in subjects if s["status"] == "ALIAS"),
        "conflict": sum(1 for s in subjects if s["status"] == "CONFLICT"),
        "unmapped": sum(1 for s in subjects if s["status"] == "UNMAPPED"),
        "d2_can_confirm": sum(1 for d in d2 if d["verdict"] == "可补写 CONFIRMED"),
        "d2_need_cancel": sum(1 for d in d2 if d["verdict"] == "需同步撤销 HIS 单"),
        "d3_offline": sum(1 for d in d3 if d["verdict"] == "可能已线下服务"),
        "d3_unknown": sum(1 for d in d3 if d["verdict"].startswith("无法判定")),
        "missing_name_mask": missing_mask,
    }
    return {"subjects": subjects, "orphans": orphans, "onsite_others": onsite_others,
            "d2": d2, "d3": d3, "legacy": legacy, "summary": summary,
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}


# --------------------------------------------------------------------- 输出

def render_md(rep: dict) -> str:
    s = rep["summary"]
    L = ["# 患者主索引对账报表（dry-run）\n",
         f"生成时间：{rep['generated_at']}　｜　口径：`docs/患者主索引映射对账方案_20261127.md`\n",
         "## 0. 摘要\n",
         f"- 就诊人记录 {s['subjects']} 条：`CONFIRMED` {s['confirmed']}、`ALIAS` {s['alias']}、"
         f"`CONFLICT` {s['conflict']}、`UNMAPPED` {s['unmapped']}",
         f"- D2：可补写 `CONFIRMED` {s['d2_can_confirm']} 条、需同步撤销 HIS 单 {s['d2_need_cancel']} 条",
         f"- D3：可能已线下服务 {s['d3_offline']} 条、无法判定 {s['d3_unknown']} 条",
         f"- D4：预约 {rep['legacy']['total']} 条全部无 `patient_ref`"
         f"（`COMPLETED` {rep['legacy']['completed']} / `CHECKED_IN` {rep['legacy']['checked_in']} 优先迁移）",
         (f"- ⚠ 数据质量：{len(s['missing_name_mask'])} 条受理单姓名为空 —— "
          + ", ".join(s["missing_name_mask"]) if s["missing_name_mask"] else "- 数据质量：受理单姓名无空值"),
         "",
         "## 1. 平台就诊人 × HIS 候选档案\n",
         "| 平台用户 | 就诊人 | 关系 | 预约 | 带单号 | 平台生日 | 平台实名 | HIS MRN | HIS 生日 | 尾号 | 证件可信 | 业务量(挂号/就诊/处方/费用) | tier | 建议状态 | 理由 |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for x in rep["subjects"]:
        c = x["his_counts"]
        L.append(f"| {x['user_name'] or x['user_id']} | {x['patient_name']} | "
                 f"{'本人' if x['platform_self'] else '代挂号'} | {x['appointments']} | "
                 f"{x['with_his_order']} | {x['platform_birth'] or '-'} | "
                 f"{'已核验' if x['platform_id_verified'] else ('用户已实名（不适用本条）' if not x['platform_self'] else '未实名')} | "
                 f"{x['his_mrn']} | {x['his_birth'] or '-'} | {x['his_id_last4'] or '-'} | "
                 f"{'是' if x['counts_trusted'] else '否'} | "
                 f"{c['registrations']}/{c['visits']}/{c['prescriptions']}/{c['charges']} | "
                 f"{x['tier']} | **{x['status']}** | {x['reason']} |")
    L.append("")

    L.append("## 2. ORPHAN（HIS 有档案、平台无对应就诊人）\n")
    L.append("| MRN | 姓名 | 挂号 | 就诊 | 处方 | 证件可信 |")
    L.append("|---|---|---|---|---|---|")
    for o in rep["orphans"]:
        c = o["counts"]
        L.append(f"| {o['mrn']} | {o['name']} | {c['registrations']} | {c['visits']} | "
                 f"{c['prescriptions']} | {'是' if o['identity']['id_trusted'] else '否'} |")
    L.append(f"\n其余 {rep['onsite_others']} 条院内现场建档（无互联网单）不在映射范围，未列出。\n")

    L.append("## 3. D2 分叉单字段级比对\n")
    L.append("| 受理单 | 患者 | 平台状态 | HIS 状态 | appointment_id | slot_id | 姓名哈希 | 结论 |")
    L.append("|---|---|---|---|---|---|---|---|")
    for d in rep["d2"]:
        if d["verdict"] == "HIS_DECLINED":
            L.append(f"| {d['his_order_no']} | - | - | - | - | - | - | HIS 无此单 |")
            continue
        ok = lambda b: "✓" if b else "✗"
        L.append(f"| {d['his_order_no']} | {d['patient_name']} | {d['platform_status']} | {d['his_status']} | "
                 f"{ok(d['appt_ok'])} | {ok(d['slot_ok'])} | {ok(d['name_hash_ok'])} | **{d['verdict']}** |")
    L.append("")

    L.append("## 4. D3 未落挂号受理单（是否可能已线下服务）\n")
    L.append("| 受理单 | 来源 | 患者 | 就诊日 | 判定 | 证据 |")
    L.append("|---|---|---|---|---|---|")
    for d in rep["d3"]:
        L.append(f"| {d['his_order_no']} | {d['source']} | {d['patient']} | {d['visit_date'] or '-'} | "
                 f"{d['verdict']} | {', '.join(d['evidence']) or '—'} |")
    L.append("")

    lg = rep["legacy"]
    L.append("## 5. D4 历史预约规模\n")
    L.append(f"- 预约总数 {lg['total']}，按状态：{lg['by_status']}")
    L.append(f"- 无 `patient_ref`（需白名单/迁移）：**{lg['no_patient_ref']}**")
    L.append(f"- 其中 `COMPLETED` {lg['completed']}、`CHECKED_IN` {lg['checked_in']}（优先迁移报告读取）")

    L.append("\n## 6. 口径提醒\n")
    L.append("- **T1 当前不可达**：平台 `user_extended.id_card_hash` 是**无盐** sha256，HIS `patients.id_hash` 是"
             "**加盐** sha256(salt+id)，不在同一哈希空间；须 business 解密后按 HIS 口径重算再比对。")
    L.append("- **T2 当前不可达**：两端 `phone_hash` 同样口径不同，本报表把 id/phone 因子一律置为不可用。")
    L.append("- `id_placeholder` / `id_is_name_hash` 的档案，证件号列不可作为证据（D1）。")
    L.append("- `openapi_orders.patient_name_mask` 有历史编码问题（个别行呈 `鑱**` 这类乱码），"
             "属展示瑕疵，不影响按 `appointment_id`/`slot_id` 的比对；不自动判定条数，避免误报。")
    return "\n".join(L) + "\n"


def apply_mapping(rep: dict) -> None:
    """写映射：只写 CONFIRMED / ALIAS，逐条前查，避免误覆盖 canonical。"""
    conf = mysql_conf()
    env = dict(os.environ)
    if conf["password"]:
        env["MYSQL_PWD"] = conf["password"]

    def esc(v: str) -> str:
        return (v or "").replace("\\", "\\\\").replace("'", "''")

    def run(sql: str) -> None:
        cmd = [mysql_bin(), "--default-character-set=utf8mb4", "-h", conf["host"], "-P", conf["port"],
               "-u", conf["user"], conf["db"], "-e", sql]
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=env)
        if p.returncode != 0:
            raise SystemExit("写入失败：" + (p.stderr or "").strip())

    written = skipped = 0
    for s in rep["subjects"]:
        if s["status"] not in ("CONFIRMED", "ALIAS") or s["his_patient_id"] in ("-", ""):
            continue
        # C3-①：ref 必须是随机值，不得由 userId/姓名派生；幂等靠「按 owner+姓名查既有」再复用
        existing = query("SELECT patient_ref FROM patient_index "
                         f"WHERE owner_user_id='{esc(s['user_id'])}' "
                         f"AND display_name='{esc(s['patient_name'])}' LIMIT 1;")
        ref = existing[0][0] if existing else "pat-" + uuid.uuid4().hex
        occupied = query(f"SELECT COUNT(*) FROM his_patient_map WHERE his_patient_id='{s['his_patient_id']}';")
        canonical = query(f"SELECT COUNT(*) FROM his_patient_map WHERE canonical_key='{esc(ref)}';")
        if int(occupied[0][0]) or (s["status"] == "CONFIRMED" and int(canonical[0][0])):
            print(f"跳过 {s['patient_name']} / {s['his_mrn']}：已存在映射，需人工裁决")
            skipped += 1
            continue
        birth = f"'{esc(s['his_birth'])}'" if s["his_birth"] else "NULL"
        run("INSERT INTO patient_index (patient_ref, owner_user_id, display_name, birth_date, status, "
            "identity_source, verification_level) VALUES "
            f"('{esc(ref)}','{esc(s['user_id'])}','{esc(s['patient_name'])}',{birth},'ACTIVE',"
            "'LEGACY_APPOINTMENT','NONE') ON DUPLICATE KEY UPDATE updated_at=NOW(3);")
        evidence = f"tier={s['tier']}; user={s['user_id']}; by=patient-reconcile"
        run("INSERT INTO his_patient_map (platform_id, his_patient_id, his_mrn, status, match_tier, "
            "evidence, decided_by, decided_at) VALUES "
            f"('{esc(ref)}','{esc(str(s['his_patient_id']))}','{esc(s['his_mrn'])}','{s['status']}',"
            f"'{esc(s['tier'])}','{esc(evidence)}','tool:patient-reconcile',NOW(3));")
        written += 1
    print(f"写入完成：{written} 条，跳过 {skipped} 条")


def main() -> int:
    ap = argparse.ArgumentParser(description="患者主索引对账（默认 dry-run，只读）")
    ap.add_argument("--apply", action="store_true", help="写 patient_index / his_patient_map（需 V39 + --yes）")
    ap.add_argument("--yes", action="store_true", help="确认写入")
    ap.add_argument("--stdout", action="store_true", help="只打印，不落文件")
    args = ap.parse_args()

    if not HIS_DB.exists():
        raise SystemExit(f"HIS 库不存在：{HIS_DB}")

    salts = load_salts()
    rep = build_report(load_his(), load_platform(), salts)
    md = render_md(rep)

    if args.stdout:
        print(md)
    else:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        md_path = OUT_DIR / f"report_{stamp}.md"
        md_path.write_text(md, encoding="utf-8")
        (OUT_DIR / f"report_{stamp}.json").write_text(
            json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"报表已生成：{md_path}")

    if args.apply:
        if not args.yes:
            raise SystemExit("--apply 必须同时给 --yes")
        tables = mysql_tables()
        missing = [t for t in TABLES_V39 if t not in tables]
        if missing:
            raise SystemExit("V39 未迁移，缺少表：" + ", ".join(missing))
        apply_mapping(rep)
    return 0


if __name__ == "__main__":
    sys.exit(main())
