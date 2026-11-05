# -*- coding: utf-8 -*-
"""资源库一致性校验（DB / 服务端副本 / 包内源 / 前端引用 四方对账）。

用法：
    python tools/check-resource-consistency.py              # 自动：能连 DB 就连，连不上退化离线
    python tools/check-resource-consistency.py --offline    # 只做离线校验（不连 DB）

校验项：
  1. icons.js 每个键 → 包内 `assets/icons/*.png` 存在
  2. icons.js 每个键 → 服务端副本 `deploy/resources/icons/*.png` 存在且 sha256 一致
  3. 前端 wxml/js 里引用的 `icons.X` → 都在 icons.js 里有定义
  4. DB 每行 file_path → 服务端文件存在
  5. DB 每行 size/sha256 → 与磁盘一致（内容漂移检测）
  6. 清单 key 集合 == DB 中 (status=1 AND delivery='remote' AND 图片 mime) 集合
  7. status=0 的资源不得出现在清单
  8. delivery='remote' 的条目必须有 bundle_path（否则前端远端失败无兜底）

退出码：0 全通过；1 存在失败项。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "miniprogram")
DST = os.path.join(ROOT, "backend", "deploy", "resources")
ENV_LOCAL = os.path.join(ROOT, "backend", "deploy", "env.local")
REPORT = os.path.join(ROOT, "docs", "资源库一致性校验报告_%s.md" % date.today().strftime("%Y%m%d"))

IMAGE_MIMES = ("image/png", "image/jpeg", "image/webp")


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_env_local() -> dict:
    out = {}
    if not os.path.isfile(ENV_LOCAL):
        return out
    for line in open(ENV_LOCAL, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def parse_icons_js() -> dict:
    text = open(os.path.join(SRC, "utils", "icons.js"), encoding="utf-8").read()
    return {k: p for k, p in re.findall(r"'([A-Za-z0-9_]+)'\s*:\s*'(/[^']+\.png)'", text)}


def frontend_icon_refs() -> dict:
    """收集 wxml/js 里的 `icons.X` 引用（排除 icons.js 自身的 require 路径）。"""
    refs = {}
    for base, _dirs, files in os.walk(SRC):
        if os.sep + "node_modules" in base:
            continue
        for fn in files:
            if not fn.endswith((".wxml", ".js")):
                continue
            full = os.path.join(base, fn)
            if os.path.basename(full) == "icons.js":
                continue
            try:
                text = open(full, encoding="utf-8").read()
            except (OSError, UnicodeDecodeError):
                continue
            for m in re.finditer(r"icons\.([A-Za-z][A-Za-z0-9_]*)", text):
                name = m.group(1)
                if name in ("js", "json", "png", "svg"):
                    continue  # 文件路径误命中
                refs.setdefault(name, set()).add(os.path.relpath(full, ROOT).replace(os.sep, "/"))
    return refs


def query_db() -> tuple[list | None, str]:
    """用 mysql CLI 读 resource_asset；返回 (rows, 说明)。rows=None 表示不可用。"""
    env = parse_env_local()
    user = env.get("MYSQL_USER", "wechar_dev")
    pwd = env.get("MYSQL_PASSWORD", "")
    host = env.get("MYSQL_HOST", "127.0.0.1")
    port = env.get("MYSQL_PORT", "3306")
    db = "wechar_dev"
    url = env.get("MYSQL_URL", "")
    m = re.search(r"//([^/]+)/([A-Za-z0-9_]+)", url)
    if m:
        host = m.group(1).split(":")[0]
        db = m.group(2)
    sql = ("SELECT resource_key, file_path, mime_type, IFNULL(file_size,-1), IFNULL(sha256,''), "
           "status, delivery, IFNULL(bundle_path,'') FROM resource_asset ORDER BY resource_key")
    cmd = ["mysql", "-h", host, "-P", port, "-u", user, "--default-character-set=utf8mb4",
           "-N", "-B", "-e", sql, db]
    if pwd:
        cmd.insert(1, "-p" + pwd)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=25, encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError) as exc:
        return None, "mysql CLI 不可用：%s" % type(exc).__name__
    if proc.returncode != 0:
        return None, "mysql 查询失败：%s" % (proc.stderr or "").strip().splitlines()[:1]
    rows = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 8:
            continue
        rows.append({
            "key": parts[0], "file_path": parts[1], "mime": parts[2],
            "size": int(parts[3]), "sha256": parts[4], "status": int(parts[5]),
            "delivery": parts[6], "bundle_path": parts[7],
        })
    return rows, "DB 可读（%d 行）" % len(rows)


def fetch_manifest() -> tuple[list | None, str]:
    """请求本机网关的清单（走 8080），拿 key 集合。"""
    import urllib.request
    url = "http://127.0.0.1:8080/api/v1/resources/manifest?platform=wechat-miniprogram"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=8) as resp:
            doc = json.loads(resp.read().decode("utf-8"))
        return [it.get("key") for it in doc.get("data", {}).get("items", [])], "清单可读（%d 条）" % len(doc.get("data", {}).get("items", []))
    except Exception as exc:  # noqa: BLE001 —— 本地网关可能没起，属可跳过项
        return None, "清单不可用（%s）" % type(exc).__name__


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="不连 DB，只做文件/引用校验")
    args = ap.parse_args()

    fails, warns, checked = [], [], 0
    icons = parse_icons_js()
    lines = []

    # ---- 1/2. icons.js → 包内源 + 服务端副本 ----
    src_missing, dst_missing, dst_mismatch = [], [], []
    for key, bundle in icons.items():
        checked += 1
        src_abs = os.path.join(SRC, bundle.lstrip("/").replace("/", os.sep))
        dst_abs = os.path.join(DST, "icons", os.path.basename(bundle))
        if not os.path.isfile(src_abs):
            src_missing.append((key, bundle))
            continue
        if not os.path.isfile(dst_abs):
            dst_missing.append((key, "icons/" + os.path.basename(bundle)))
            continue
        if sha256_of(src_abs) != sha256_of(dst_abs):
            dst_mismatch.append((key, "icons/" + os.path.basename(bundle)))
    fails += [("icons 包内源缺失", k, p) for k, p in src_missing]
    fails += [("icons 服务端副本缺失", k, p) for k, p in dst_missing]
    fails += [("icons 副本 sha256 不一致", k, p) for k, p in dst_mismatch]

    # ---- 3. 前端引用 → icons.js ----
    refs = frontend_icon_refs()
    undefined = [(n, sorted(f)[:2]) for n, f in refs.items() if n not in icons]
    fails += [("前端引用未定义图标", n, ",".join(f)) for n, f in undefined]
    unused = sorted(set(icons) - set(refs))

    # ---- 4/5. DB → 文件/内容 ----
    db_rows = None
    db_note = "已跳过（--offline）"
    if not args.offline:
        db_rows, db_note = query_db()
    db_missing, db_drift, no_bundle, bad_status = [], [], [], []
    if db_rows is not None:
        for row in db_rows:
            checked += 1
            full = os.path.join(DST, row["file_path"].replace("/", os.sep))
            if not os.path.isfile(full):
                db_missing.append((row["key"], row["file_path"]))
                continue
            if row["size"] >= 0 and os.path.getsize(full) != row["size"]:
                db_drift.append((row["key"], "size %d≠%d" % (row["size"], os.path.getsize(full))))
            elif row["sha256"] and sha256_of(full) != row["sha256"]:
                db_drift.append((row["key"], "sha256 不一致"))
            if row["status"] not in (0, 1):
                bad_status.append((row["key"], str(row["status"])))
            if row["delivery"] == "remote" and not row["bundle_path"]:
                no_bundle.append((row["key"], "remote 但无 bundle_path"))
    fails += [("DB 路径缺文件", k, p) for k, p in db_missing]
    fails += [("DB 内容漂移", k, p) for k, p in db_drift]
    fails += [("status 值非法", k, p) for k, p in bad_status]
    warns += [("remote 缺 bundle_path", k, p) for k, p in no_bundle]

    # ---- 6/7. 清单 vs DB ----
    manifest_keys, manifest_note = (None, "已跳过（offline）")
    extra_in_manifest, missing_in_manifest = [], []
    if db_rows is not None and not args.offline:
        manifest_keys, manifest_note = fetch_manifest()
    if db_rows is not None and manifest_keys is not None:
        expect = {r["key"] for r in db_rows
                  if r["status"] == 1 and r["delivery"] == "remote" and r["mime"] in IMAGE_MIMES}
        got = set(manifest_keys)
        extra_in_manifest = sorted(got - expect)
        missing_in_manifest = sorted(expect - got)
        disabled_keys = {r["key"] for r in db_rows if r["status"] == 0}
        leaked = sorted(got & disabled_keys)
        fails += [("清单出现停用资源", k, "status=0") for k in leaked]
        fails += [("清单出现 DB 外资源", k, "不在 resource_asset") for k in extra_in_manifest]
        warns += [("DB remote 未进清单", k, "检查 mime/status") for k in missing_in_manifest]

    # ---- 报告 ----
    lines += [
        "# 资源库一致性校验报告（%s）" % date.today().strftime("%Y-%m-%d"),
        "",
        "> `python tools/check-resource-consistency.py%s`" % (" --offline" if args.offline else ""),
        "",
        "## 1. 结论",
        "",
        "```text",
        "校验项        = %d" % checked,
        "失败          = %d" % len(fails),
        "告警          = %d" % len(warns),
        "DB            = %s" % db_note,
        "清单          = %s" % manifest_note,
        "```",
        "",
        "| 对账 | 数量 |", "|---|---|",
        "| icons.js 键 | %d |" % len(icons),
        "| 前端引用图标名 | %d |" % len(refs),
        "| 未被引用的图标 | %d |" % len(unused),
        "| DB 行 | %s |" % (len(db_rows) if db_rows is not None else "—"),
        "| 清单条目 | %s |" % (len(manifest_keys) if manifest_keys is not None else "—"),
        "",
    ]
    if fails:
        lines += ["## 2. 失败项（必须修）", "", "| 类型 | key/名称 | 详情 |", "|---|---|---|"]
        lines += ["| %s | `%s` | %s |" % f for f in fails[:60]]
        if len(fails) > 60:
            lines.append("| … | 其余 %d 条 | |" % (len(fails) - 60))
        lines.append("")
    if warns:
        lines += ["## 3. 告警（可接受但需知晓）", "", "| 类型 | key | 详情 |", "|---|---|---|"]
        lines += ["| %s | `%s` | %s |" % w for w in warns[:40]]
        lines.append("")
    if unused:
        lines += ["## 4. 未被前端引用的图标（不删除，仅记录）", "",
                  "合计 %d 个：`%s`" % (len(unused), "`, `".join(unused[:30]) + ("…" if len(unused) > 30 else "")), ""]

    lines += ["## 5. 判定", "",
              "**%s**" % ("全部通过" if not fails else "存在 %d 项失败，见 §2" % len(fails)), ""]

    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))

    print("校验项 %d｜失败 %d｜告警 %d" % (checked, len(fails), len(warns)))
    print("DB: %s｜清单: %s" % (db_note, manifest_note))
    if fails:
        for f in fails[:8]:
            print("  FAIL %s: %s (%s)" % f)
    print("报告：%s" % os.path.relpath(REPORT, ROOT))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
