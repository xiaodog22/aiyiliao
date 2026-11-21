#!/usr/bin/env python3
"""
HIS 逻辑整合对账任务（只读，不写业务库 / 不写 clinic-his）。

用途：
  - 以 platform appointments.his_order_no 为唯一跨库键，核对 MySQL 与 clinic-his SQLite；
  - 输出平台有单/HIS 无单、HIS 有单/平台无单、状态不一致、主数据映射覆盖；
  - 供演示期“后端主数据、HIS 辅助”口径的日常核对与上线前对账使用。

用法：
  python tools/his_reconcile.py
  python tools/his_reconcile.py --out artifacts/his-reconcile/latest.md
  python tools/his_reconcile.py --json-out artifacts/his-reconcile/latest.json

依赖：本机 mysql CLI、Python 3.10+（标准库 sqlite3）。
数据库口令只从 backend/deploy/env.local 的 MYSQL_PASSWORD 读取，不写死在脚本里。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV = ROOT / "backend" / "deploy" / "env.local"
DEFAULT_SQLITE = ROOT / "clinic-his" / "data" / "clinic.db"
DEFAULT_OUT = ROOT / "artifacts" / "his-reconcile" / "latest.md"
MYSQL_CANDIDATES = [
    os.environ.get("MYSQL_EXE", ""),
    r"D:\mysql\MySQL Server 8.0\bin\mysql.exe",
    "mysql",
]

PLATFORM_OPEN_STATUSES = {"PENDING", "CONFIRMED", "COMPLETED", "NO_SHOW"}
HIS_EXPECTED = {
    "PENDING": "ACCEPTED",
    "CONFIRMED": "ACCEPTED",
    "COMPLETED": "ACCEPTED",
    "CANCELLED": "CANCELLED",
    "NO_SHOW": "CANCELLED",
}


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def resolve_mysql() -> str:
    for candidate in MYSQL_CANDIDATES:
        if candidate and Path(candidate).exists():
            return candidate
        if candidate and shutil.which(candidate):
            return candidate
    raise RuntimeError("找不到 mysql CLI；请设置 MYSQL_EXE 或安装 MySQL 客户端")


def mysql_rows(mysql: str, user: str, password: str, database: str, sql: str) -> list[list[str]]:
    env = dict(os.environ)
    if password:
        env["MYSQL_PWD"] = password
    cmd = [mysql, f"-u{user}", "--default-character-set=utf8mb4", "--batch", "--raw", "--skip-column-names", "-D", database, "-e", sql]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=env)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "mysql 查询失败").strip())
    rows = []
    for line in proc.stdout.splitlines():
        if line.strip():
            rows.append(line.split("\t"))
    return rows


def sqlite_rows(path: Path, sql: str, params: tuple = ()) -> list[tuple]:
    if not path.exists():
        raise RuntimeError(f"clinic-his SQLite 不存在：{path}")
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        return list(conn.execute(sql, params))
    finally:
        conn.close()


def to_int(value: str) -> int:
    try:
        return int(value or 0)
    except ValueError:
        return 0


def build_report(platform: list[dict], his_orders: list[dict], mapping_rows: list[dict], counts: dict) -> dict:
    platform_by_id = {row["id"]: row for row in platform}
    his_by_no = {row["his_order_no"]: row for row in his_orders}

    linked = []
    platform_only = []
    for row in platform:
        order_no = (row.get("his_order_no") or "").strip()
        if not order_no:
            continue
        his = his_by_no.get(order_no)
        if his:
            linked.append({"platform": row, "his": his})
        else:
            platform_only.append(row)

    his_only = []
    for row in his_orders:
        appointment_id = (row.get("appointment_id") or "").strip()
        idem_key = (row.get("idem_key") or "").strip()
        if appointment_id not in platform_by_id and idem_key not in platform_by_id:
            his_only.append(row)

    id_mismatch = []
    status_mismatch = []
    for pair in linked:
        p = pair["platform"]
        h = pair["his"]
        if (h.get("idem_key") or "") != p["id"]:
            id_mismatch.append(pair)
        expected = HIS_EXPECTED.get(p["status"], "UNKNOWN")
        if expected != "UNKNOWN" and h["status"] != expected:
            status_mismatch.append({**pair, "expected": expected})

    local_only = [row for row in platform if not (row.get("his_order_no") or "").strip()]

    mappings = {}
    for row in mapping_rows:
        key = row["entity_type"]
        mappings.setdefault(key, {"CONFIRMED": 0, "CONFLICT": 0, "UNMAPPED": 0, "total": 0})
        mappings[key]["total"] += 1
        status = row.get("status") or "UNMAPPED"
        mappings[key][status] = mappings[key].get(status, 0) + 1

    return {
        "platform": {
            "total": len(platform),
            "linked": len(linked),
            "localOnly": len(local_only),
            "withHisNo": sum(1 for row in platform if (row.get("his_order_no") or "").strip()),
        },
        "his": {
            "orders": len(his_orders),
            "linked": len(linked),
            "only": len(his_only),
        },
        "counts": counts,
        "mappings": mappings,
        "platformOnly": platform_only,
        "hisOnly": his_only,
        "idMismatch": id_mismatch,
        "statusMismatch": status_mismatch,
        "linked": linked,
    }


def render_markdown(report: dict, meta: dict) -> str:
    p = report["platform"]
    h = report["his"]
    lines = [
        "# HIS 逻辑整合对账报告",
        "",
        f"> 生成时间：{meta['generated_at']}",
        f"> 平台库：`{meta['mysql_database']}`（MySQL，主库）",
        f"> HIS 库：`{meta['sqlite_path']}`（SQLite，辅助库）",
        "> 口径：只读核对；不写库、不双写、不迁移表。",
        "",
        "## 1. 总量",
        "",
        "| 指标 | 数量 |",
        "| --- | --- |",
        f"| 平台预约总数 | {p['total']} |",
        f"| 平台预约带 HIS 单号 | {p['withHisNo']} |",
        f"| 已关联（平台 ↔ HIS） | {p['linked']} |",
        f"| 平台本地单（无 HIS） | {p['localOnly']} |",
        f"| HIS OpenAPI 单总数 | {h['orders']} |",
        f"| HIS 单未关联平台 | {h['only']} |",
        f"| 状态不一致 | {len(report['statusMismatch'])} |",
        f"| 幂等键/预约 ID 不一致 | {len(report['idMismatch'])} |",
        "",
        f"平台字典：{report['counts']['departments']} 个科室、{report['counts']['doctors']} 位医生、{report['counts']['slots']} 条号源；映射表只登记已证实/冲突行，其余按未映射处理。",
        "",
        "## 2. 主数据映射覆盖",
        "",
        "| 实体 | 已确认 | 冲突 | 未映射 | 总行 |",
        "| --- | --- | --- | --- | --- |",
    ]
    for entity in sorted(report["mappings"]):
        m = report["mappings"][entity]
        lines.append(f"| {entity} | {m.get('CONFIRMED', 0)} | {m.get('CONFLICT', 0)} | {m.get('UNMAPPED', 0)} | {m.get('total', 0)} |")
    if not report["mappings"]:
        lines.append("| （映射表为空或未迁移） | 0 | 0 | 0 | 0 |")

    lines += ["", "## 3. 差异明细", ""]
    sections = [
        ("平台有 HIS 单、HIS 无记录", report["platformOnly"], ["id", "status", "his_order_no"]),
        ("HIS 有单、平台无记录", report["hisOnly"], ["his_order_no", "appointment_id", "idem_key", "status"]),
        ("状态不一致", report["statusMismatch"], ["platform", "his", "expected"]),
        ("预约 ID / 幂等键不一致", report["idMismatch"], ["platform", "his"]),
    ]
    for title, rows, fields in sections:
        lines.append(f"### {title}（{len(rows)}）")
        if not rows:
            lines.append("无。")
            lines.append("")
            continue
        if title == "状态不一致":
            lines.append("| 平台预约 | 平台状态 | HIS 单号 | HIS 状态 | 期望 HIS 状态 |")
            lines.append("| --- | --- | --- | --- | --- |")
            for row in rows[:20]:
                lines.append(f"| `{row['platform']['id']}` | {row['platform']['status']} | `{row['his']['his_order_no']}` | {row['his']['status']} | {row['expected']} |")
        elif title == "预约 ID / 幂等键不一致":
            lines.append("| 平台预约 | 平台状态 | HIS 单号 | HIS appointment_id | HIS idem_key |")
            lines.append("| --- | --- | --- | --- | --- |")
            for row in rows[:20]:
                lines.append(f"| `{row['platform']['id']}` | {row['platform']['status']} | `{row['his']['his_order_no']}` | `{row['his']['appointment_id']}` | `{row['his']['idem_key']}` |")
        else:
            cols = " | ".join(fields)
            lines.append(f"| {cols} |")
            lines.append("| " + " | ".join("---" for _ in fields) + " |")
            for row in rows[:20]:
                lines.append("| " + " | ".join(str(row.get(f, "")) for f in fields) + " |")
        if len(rows) > 20:
            lines.append(f"> 仅显示前 20 条，共 {len(rows)} 条。")
        lines.append("")

    lines += [
        "## 4. 关联样本",
        "",
        "| 平台预约 | 平台状态 | HIS 单号 | HIS 状态 |",
        "| --- | --- | --- | --- |",
    ]
    for pair in report["linked"][:10]:
        lines.append(f"| `{pair['platform']['id']}` | {pair['platform']['status']} | `{pair['his']['his_order_no']}` | {pair['his']['status']} |")
    if not report["linked"]:
        lines.append("| 无 | — | — | — |")

    lines += [
        "",
        "## 5. 结论",
        "",
        "- 平台主库与 HIS 辅助库不是同一套数据；本报告只核对 `his_order_no` 关联，不做表迁移。",
        "- `平台本地单` 是演示期正常状态：`APP_HIS_ENABLED=false` 时只写 MySQL。",
        "- `HIS 单未关联平台` 多为历史冒烟/演示单；是否清理由业务确认，脚本不删除。",
        "- 主数据映射为 0 的实体，禁止开启 `APP_HIS_ENABLED=true` 做真实受理；先补映射并复核。",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="HIS 逻辑整合对账（只读）")
    parser.add_argument("--env", default=str(DEFAULT_ENV), help="env.local 路径")
    parser.add_argument("--sqlite", default=str(DEFAULT_SQLITE), help="clinic-his SQLite 路径")
    parser.add_argument("--mysql", default="", help="mysql CLI 路径")
    parser.add_argument("--database", default="", help="MySQL 数据库名；默认从 MYSQL_URL 解析或 wechar_dev")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Markdown 输出路径")
    parser.add_argument("--json-out", default="", help="可选 JSON 输出路径")
    parser.add_argument("--fail-on-mismatch", action="store_true", help="存在差异时返回 2（供 CI/巡检使用）")
    args = parser.parse_args()

    env = read_env(Path(args.env))
    mysql = args.mysql or resolve_mysql()
    database = args.database
    if not database:
        url = env.get("MYSQL_URL", "")
        # jdbc:mysql://127.0.0.1:3306/wechar_dev?... -> wechar_dev
        database = url.rsplit("/", 1)[-1].split("?", 1)[0] if "/" in url else "wechar_dev"
    user = env.get("MYSQL_USER", "wechar_dev")
    password = env.get("MYSQL_PASSWORD", "")

    platform = []
    for row in mysql_rows(
        mysql,
        user,
        password,
        database,
        "SELECT id, status, booking_source, COALESCE(his_order_no,''), DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') FROM appointments ORDER BY created_at;",
    ):
        platform.append({"id": row[0], "status": row[1], "booking_source": row[2], "his_order_no": row[3], "created_at": row[4]})

    his_orders = [
        {"his_order_no": row[0], "idem_key": row[1], "appointment_id": row[2], "status": row[3], "created_at": row[4]}
        for row in sqlite_rows(
            Path(args.sqlite),
            "SELECT his_order_no, idem_key, appointment_id, status, created_at FROM openapi_orders ORDER BY id;",
        )
    ]

    mapping_rows = []
    try:
        for row in mysql_rows(mysql, user, password, database, "SELECT entity_type, platform_id, COALESCE(his_id,''), status FROM his_master_data_map ORDER BY entity_type, platform_id;"):
            mapping_rows.append({"entity_type": row[0], "platform_id": row[1], "his_id": row[2], "status": row[3]})
    except RuntimeError:
        # 映射表尚未迁移时仍可对账，但报告中明确为空
        mapping_rows = []

    counts = {
        "departments": to_int(mysql_rows(mysql, user, password, database, "SELECT COUNT(*) FROM departments;")[0][0]),
        "doctors": to_int(mysql_rows(mysql, user, password, database, "SELECT COUNT(*) FROM doctors;")[0][0]),
        "slots": to_int(mysql_rows(mysql, user, password, database, "SELECT COUNT(*) FROM doctor_slots;")[0][0]),
    }
    report = build_report(platform, his_orders, mapping_rows, counts)

    meta = {
        "generated_at": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z"),
        "mysql_database": database,
        "sqlite_path": str(Path(args.sqlite).resolve()),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_markdown(report, meta), encoding="utf-8")
    print(f"对账完成：{out}")
    print(f"平台 {report['platform']['total']} 条；关联 {report['platform']['linked']}；平台本地单 {report['platform']['localOnly']}；HIS 孤儿单 {report['his']['only']}；状态不一致 {len(report['statusMismatch'])}")
    if args.json_out:
        json_path = Path(args.json_out)
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps({"meta": meta, **report}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"JSON：{json_path}")

    if args.fail_on_mismatch and (report["platformOnly"] or report["hisOnly"] or report["statusMismatch"] or report["idMismatch"]):
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - CLI 入口统一转可读错误
        print(f"对账失败：{exc}", file=sys.stderr)
        sys.exit(1)
