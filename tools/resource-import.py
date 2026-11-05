# -*- coding: utf-8 -*-
"""资源库导入脚本（V14+）：把小程序包内图片资产登记进 resource_asset，并同步服务端副本。

用法：
    python tools/resource-import.py --check        # 只盘点（默认）：列出新增 / 内容变更 / 副本差异
    python tools/resource-import.py --write        # 复制副本 + 生成迁移（INSERT 新增 + UPDATE 变更）

设计要点（与 docs/资源库分类规则_20261019.md 对应）：
1. **只存元数据**：DB 写 key/相对路径/mime/size/sha256/status/delivery，二进制留在文件系统。
2. **服务端副本**：`resource_asset.file_path` 相对 `app.resources.dir`（= backend/deploy/resources），
   源文件在小程序包内 → 脚本负责复制副本；包内原件**不移动、不删除**（前端 bundlePath 兜底依赖它）。
3. **三方一致**：包内源 ←→ 服务端副本（sha256 相同）←→ DB 行（size/sha256 与文件一致）。
4. **不静默跳过**：缺失 / 重复 / mime 非白名单 / 复制失败 / 已登记但源文件消失，全部进报告并非 0 退出。
5. **副本同步覆盖全部条目**（2026-10-19 修复）：
   旧实现 `if key in known: continue` 只把新条目送进 copy_files，导致**已登记资源改了内容副本不更新**。
   现在所有已解析条目都参与 sha256 比对；差异既复制副本，也生成 UPDATE 迁移把 DB 的 size/sha256 拉正。

退出码：0 全通过（可含"无变更"）；1 存在失败项；2 检测到差异但为 --check 模式（不写文件）。
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "miniprogram")
DST = os.path.join(ROOT, "backend", "deploy", "resources")
MIGRATION_DIR = os.path.join(ROOT, "backend", "business-service", "src", "main", "resources", "db", "migration")
REPORT = os.path.join(ROOT, "docs", "资源库导入报告_%s.md" % date.today().strftime("%Y%m%d"))

# mime 白名单（与 ResourceAssetService.ALLOWED_MIME 对齐）
MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
}

# 源目录 → (目标子目录, key 前缀, 默认分类)
# 2026-10-19：补 packageContent/assets（递归），此前只扫 videos/，导致 5 张科普封面全漏。
SOURCE_DIRS = [
    ("assets/icons", "icons", "icons.", "icon"),
    ("assets/home", "", "home.", None),
    ("assets/img", "img", "img.", None),
    ("packageContent/videos", "", None, None),
    ("packageContent/assets", "content", "content.", None),
    ("packageNav/assets", "nav", "nav.", "image"),
]
# 递归扫描的源目录（其余只扫一层）
RECURSIVE = {"packageContent/assets"}


@dataclass
class Item:
    key: str
    category: str
    file_path: str          # 相对 app.resources.dir
    src_abs: str            # 包内源文件绝对路径
    mime: str
    size: int
    sha256: str
    delivery: str
    level: str = "A"
    bundle_path: str = ""
    note: str = ""
    is_new: bool = True
    db_sha256: str = ""     # 已登记条目在 DB 里的 sha256（用于差异判定）
    db_size: int = -1


@dataclass
class Report:
    scanned: int = 0
    new_items: list = field(default_factory=list)
    existing_items: list = field(default_factory=list)   # 已登记且源文件仍在（参与副本同步）
    changed: list = field(default_factory=list)          # 源文件内容与 DB 不一致
    dst_stale: list = field(default_factory=list)        # 副本缺失或与源不一致
    skipped: list = field(default_factory=list)
    missing: list = field(default_factory=list)          # 新增条目：源文件不存在
    existing_missing: list = field(default_factory=list)  # 已登记但源文件消失
    duplicates: list = field(default_factory=list)
    bad_mime: list = field(default_factory=list)
    copy_failed: list = field(default_factory=list)
    copied: list = field(default_factory=list)


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_icons_js() -> list[tuple[str, str]]:
    path = os.path.join(SRC, "utils", "icons.js")
    if not os.path.isfile(path):
        raise SystemExit("找不到 %s" % path)
    text = open(path, encoding="utf-8").read()
    pairs = re.findall(r"'([A-Za-z0-9_]+)'\s*:\s*'(/[^']+\.png)'", text)
    seen, out = set(), []
    for k, p in pairs:
        if k in seen:
            continue
        seen.add(k)
        out.append((k, p))
    return out


# 解析迁移里的 INSERT 行：key, category, file_path, mime, size, sha256, status, level, bundle_path
_ROW_RE = re.compile(
    r"\('([A-Za-z0-9][A-Za-z0-9._-]{0,127})',\s*'([a-z]+)',\s*'([^']+)',\s*'([^']+)',\s*(\d+),"
    r"\s*'([0-9a-f]{64})',\s*(\d+),\s*'([AB])',\s*(?:'([^']*)'|NULL)"
)


# 解析迁移里的 UPDATE 行（内容变更后拉正 size/sha256）：
# UPDATE resource_asset SET file_size = N, sha256 = '<64hex>', status = 1 WHERE resource_key = '<key>';
_UPDATE_RE = re.compile(
    r"UPDATE resource_asset SET file_size = (\d+), sha256 = '([0-9a-f]{64})'"
    r".*?WHERE resource_key = '([^']+)';"
)

# 解析迁移里的 DELETE 行（资源下线后摘除登记，如 V26）：
# DELETE FROM resource_asset WHERE resource_key IN ('a', 'b', ...);
# 或 DELETE FROM resource_asset WHERE resource_key = 'x';
_DELETE_RE = re.compile(
    r"DELETE FROM resource_asset WHERE resource_key IN \(([^)]*)\);",
    re.S
)
_DELETE_ONE_RE = re.compile(
    r"DELETE FROM resource_asset WHERE resource_key = '([^']+)';"
)
_KEY_RE = re.compile(r"'([^']+)'")


def existing_rows() -> list[dict]:
    """从现有 Flyway 迁移解析已登记资源（INSERT 建行 + UPDATE 拉正内容）。

    必须同时解析 UPDATE：否则 --write 把内容变更写进新迁移后，
    下一次 --check 仍按旧 sha256 判定，会永远报"内容变更"（自测卡在这里）。

    必须同时解析 DELETE（V26 起）：资源下线后登记行被摘除，
    若仍当作"已登记"，--check 会报「已登记但源文件消失」。

    迁移文件按 **版本号** 排序（不是文件名字符串序，否则 V10 会排在 V2 前面，
    DELETE 早于 INSERT 执行 → 行又被重新登记回来）。
    """
    rows: dict[str, dict] = {}
    files = []
    for fn in os.listdir(MIGRATION_DIR):
        if not fn.endswith(".sql") or "resource_asset" not in fn:
            continue
        m = re.match(r"V(\d+)__", fn)
        files.append((int(m.group(1)) if m else 0, fn))
    for _ver, fn in sorted(files):
        text = open(os.path.join(MIGRATION_DIR, fn), encoding="utf-8").read()
        for m in _ROW_RE.finditer(text):
            rows[m.group(1)] = {
                "key": m.group(1), "category": m.group(2), "file_path": m.group(3),
                "mime": m.group(4), "size": int(m.group(5)), "sha256": m.group(6),
                "status": int(m.group(7)), "level": m.group(8), "bundle_path": m.group(9) or "",
            }
        for m in _UPDATE_RE.finditer(text):
            row = rows.get(m.group(3))
            if row is not None:
                row["size"] = int(m.group(1))
                row["sha256"] = m.group(2)
        for m in _DELETE_RE.finditer(text):
            for k in _KEY_RE.findall(m.group(1)):
                rows.pop(k, None)
        for m in _DELETE_ONE_RE.finditer(text):
            rows.pop(m.group(1), None)
    return list(rows.values())


def guess_category(key: str, stem: str, default: str | None) -> str:
    if default:
        return default
    low = stem.lower()
    if low.startswith("banner") or low.startswith("kb-cover") or low.startswith("cover-"):
        return "cover"
    # 详情页顶部 hero：90KB 级大图、每篇只出现一次 → 与封面同属"大图低频"，
    # 归 cover 才能拿到 remote（若归 image 会落到 local，等于永远走包内）。
    if low.startswith("detail-hero"):
        return "cover"
    if low.startswith("ai-doctor") or low.startswith("xiaoan"):
        return "avatar"
    if low.startswith("svc-"):
        return "icon"
    return "image"


def delivery_for(key: str, category: str) -> str:
    """分类规则（docs/资源库分类规则_20261019.md §3）：

    · 96×96 图标 / 默认头像 / 空态图 / 画布底图 → local（渲染频繁或必须同步可读）
    · 封面 / 科普大图                        → remote（大图、低频、需可独立更新）
    · 视频                                  → **local**（2026-10-19 收口）：
      视频实际走分包内 mp4，清单只下发图片 mime，标 remote 是死标记；远端化方案见
      docs/视频远端化需求.md（本轮不实现）。
    · 其余默认 local（宁可不上云，也不误上云）
    """
    if category == "video":
        return "local"
    if key.startswith(("icons.", "img.", "nav.")):
        return "local"
    # 登录页主视觉（2026-10-21）：大图 + 需要独立纠错，走远端；包内保留同版兜底。
    if key == "home.xiaoan-robot":
        return "remote"
    if category == "cover":
        return "remote"
    return "local"


def walk_files(base: str, recursive: bool):
    if not os.path.isdir(base):
        return
    if recursive:
        for root, _dirs, files in os.walk(base):
            for fn in sorted(files):
                full = os.path.join(root, fn)
                yield full, os.path.relpath(full, base).replace(os.sep, "/")
    else:
        for fn in sorted(os.listdir(base)):
            full = os.path.join(base, fn)
            if os.path.isfile(full):
                yield full, fn


def collect(rep: Report, known: dict) -> None:
    # 同一文件可能已用别的 key 登记（如 packageContent/videos 的 wash-hands.jpg
    # 早已以 health.wash-hands 入库）→ 按 file_path 复用，避免"同文件两个 key"。
    known_by_path = {r["file_path"]: r for r in known.values() if r.get("file_path")}
    icons = parse_icons_js()
    rep.scanned += len(icons)

    # ① 图标：key = icons.<iconsKey>
    for key, bundle in icons:
        stem = os.path.basename(bundle)
        src_abs = os.path.join(SRC, bundle.lstrip("/").replace("/", os.sep))
        rid = "icons." + key
        if not os.path.isfile(src_abs):
            (rep.missing if rid not in known else rep.existing_missing).append((rid, bundle))
            continue
        ext = os.path.splitext(stem)[1].lower()
        mime = MIME_BY_EXT.get(ext)
        if not mime:
            rep.bad_mime.append((rid, ext))
            continue
        item = Item(key=rid, category="icon", file_path="icons/" + stem, src_abs=src_abs, mime=mime,
                    size=os.path.getsize(src_abs), sha256=sha256_of(src_abs),
                    delivery=delivery_for(rid, "icon"), level="A", bundle_path=bundle)
        _register(rep, known, known_by_path, item)

    # ② 其余目录
    for sub, dst_sub, prefix, cat_default in SOURCE_DIRS:
        if sub == "assets/icons":
            continue
        base = os.path.join(SRC, sub.replace("/", os.sep))
        for full, rel_in_dir in walk_files(base, sub in RECURSIVE):
            fn = os.path.basename(full)
            ext = os.path.splitext(fn)[1].lower()
            mime = MIME_BY_EXT.get(ext)
            if not mime:
                rep.skipped.append((os.path.join(sub, rel_in_dir), "非白名单扩展名 " + ext))
                continue
            rep.scanned += 1
            stem = os.path.splitext(fn)[0]
            key = (prefix + stem) if prefix else stem
            category = guess_category(key, stem, cat_default)
            file_path = (dst_sub + "/" + fn) if dst_sub else fn
            bundle = "/" + sub + "/" + rel_in_dir
            item = Item(key=key, category=category, file_path=file_path, src_abs=full, mime=mime,
                        size=os.path.getsize(full), sha256=sha256_of(full),
                        delivery=delivery_for(key, category), level="A", bundle_path=bundle,
                        note="包内 %s" % bundle)
            _register(rep, known, known_by_path, item)

    # 重复 key 检测
    seen = {}
    for it in rep.new_items:
        if it.key in seen:
            rep.duplicates.append((it.key, seen[it.key], it.src_abs))
        else:
            seen[it.key] = it.src_abs


def _register(rep: Report, known: dict, known_by_path: dict, item: Item) -> None:
    """按 key（或同一 file_path）归类：新增 → new_items；已登记 → existing_items。"""
    db = known.get(item.key)
    if db is None:
        db = known_by_path.get(item.file_path)
        if db is not None:
            # 同一物理文件已用别的 key 登记 → 沿用 DB 的 key，避免重复登记
            item.key = db["key"]
    if db is None:
        rep.new_items.append(item)
        return
    item.is_new = False
    item.db_sha256 = db["sha256"]
    item.db_size = db["size"]
    # 以 DB 的 file_path / bundle_path 为准（可能与当前推导不同，避免误判）
    if db["file_path"]:
        item.file_path = db["file_path"]
    if db["bundle_path"]:
        item.bundle_path = db["bundle_path"]
    rep.existing_items.append(item)
    if item.sha256 != db["sha256"] or item.size != db["size"]:
        rep.changed.append(item)


def scan_dst(rep: Report) -> None:
    """检查副本：缺失 / sha256 不一致 → dst_stale（--check 也能报）。"""
    for it in rep.new_items + rep.existing_items:
        dest = os.path.join(DST, it.file_path.replace("/", os.sep))
        if not os.path.isfile(dest):
            rep.dst_stale.append((it.key, it.file_path, "副本缺失"))
            continue
        if sha256_of(dest) != it.sha256:
            rep.dst_stale.append((it.key, it.file_path, "副本与源不一致"))


def copy_files(rep: Report) -> None:
    """复制/覆盖副本。遍历**全部条目**（新增 + 已登记），这是 2026-10-19 的关键修复。"""
    for it in rep.new_items + rep.existing_items:
        dest = os.path.join(DST, it.file_path.replace("/", os.sep))
        parent = os.path.dirname(dest)
        if parent:
            os.makedirs(parent, exist_ok=True)
        try:
            if os.path.isfile(dest) and sha256_of(dest) == it.sha256:
                continue  # 已是最新，不重写（保留 mtime）
            shutil.copy2(it.src_abs, dest)
            if sha256_of(dest) != it.sha256:
                rep.copy_failed.append((it.file_path, "复制后 sha256 不一致"))
                continue
            rep.copied.append(it.file_path)
        except OSError as exc:
            rep.copy_failed.append((it.file_path, "%s: %s" % (type(exc).__name__, exc)))


def sql_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "''")


def write_migration(rep: Report, version: int) -> str | None:
    if not rep.new_items and not rep.changed:
        return None
    fn = os.path.join(MIGRATION_DIR, "V%d__resource_asset_catalog.sql" % version)
    # ⚠️ 必须拒绝覆盖已存在的迁移：Flyway 已应用过的文件被改写后 checksum 不匹配，
    #    下次启动 validate 直接失败；而"修好它"只能靠从旧 jar / 备份里捞原文。
    if os.path.exists(fn):
        raise SystemExit(
            "拒绝写入：%s 已存在。Flyway 迁移只能追加，不能覆盖。"
            "请用 --version %d（或省略 --version 走自动取号）。" % (os.path.basename(fn), version + 1))
    lines = [
        "-- =====================================================================",
        "-- V%d__resource_asset_catalog.sql —— 资源登记（%s 由 tools/resource-import.py 生成）"
        % (version, date.today().isoformat()),
        "--",
        "-- **不要手改**：改分类规则请改脚本再重跑。",
        "-- 只登记元数据 + 相对路径，二进制留在文件系统（不写 BLOB）。",
        "-- delivery：local = 仅本地兜底（清单不下发 url）/ remote = 远端优先。",
        "-- 本次：新增 %d 条、内容变更 %d 条。" % (len(rep.new_items), len(rep.changed)),
        "-- =====================================================================",
        "",
    ]
    if rep.new_items:
        lines += [
            "INSERT INTO resource_asset",
            "    (resource_key, category, file_path, mime_type, file_size, sha256, status, level, bundle_path, sort_order, delivery)",
            "VALUES",
        ]
        rows = []
        for i, it in enumerate(rep.new_items):
            bundle = "NULL" if not it.bundle_path else "'%s'" % sql_escape(it.bundle_path)
            rows.append(
                "    ('%s', '%s', '%s', '%s', %d, '%s', 1, '%s', %s, %d, '%s')"
                % (sql_escape(it.key), it.category, sql_escape(it.file_path), it.mime,
                   it.size, it.sha256, it.level, bundle, 300 + i, it.delivery)
            )
        lines.append(",\n".join(rows) + ";")
        lines.append("")

    if rep.changed:
        lines += [
            "-- 内容变更：源文件已替换，把 size/sha256 拉正（否则端点 ETag 与文件不符、对账会红）",
        ]
        for it in rep.changed:
            lines.append(
                "UPDATE resource_asset SET file_size = %d, sha256 = '%s', status = 1 WHERE resource_key = '%s';"
                % (it.size, it.sha256, sql_escape(it.key))
            )
        lines.append("")

    with open(fn, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    return fn


def write_report(rep: Report, mode: str, migration: str | None, version: int) -> None:
    total = len(rep.new_items) + len(rep.existing_items)
    by_delivery = {"local": 0, "remote": 0}
    for it in rep.new_items:
        by_delivery[it.delivery] = by_delivery.get(it.delivery, 0) + 1
    by_cat = {}
    for it in rep.new_items:
        by_cat[it.category] = by_cat.get(it.category, 0) + 1

    lines = [
        "# 资源库导入报告（%s）" % date.today().strftime("%Y-%m-%d %H:%M"),
        "",
        "> `python tools/resource-import.py %s`　模式：**%s**"
        % ("--write --version %d" % version if mode == "write" else "--check", mode),
        "",
        "## 1. 汇总",
        "",
        "| 指标 | 数值 |",
        "|---|---|",
        "| 扫描文件数 | %d |" % rep.scanned,
        "| 新增登记 | **%d** |" % len(rep.new_items),
        "| 已登记（参与副本同步） | %d |" % len(rep.existing_items),
        "| **内容变更（源 ≠ DB）** | **%d** |" % len(rep.changed),
        "| **副本缺失/过期** | **%d** |" % len(rep.dst_stale),
        "| 非白名单扩展名跳过 | %d |" % len(rep.skipped),
        "| 新增条目源文件缺失 | **%d** |" % len(rep.missing),
        "| 已登记但源文件消失 | **%d** |" % len(rep.existing_missing),
        "| 重复 key | **%d** |" % len(rep.duplicates),
        "| mime 非白名单 | **%d** |" % len(rep.bad_mime),
        "| 复制失败 | **%d** |" % len(rep.copy_failed),
        "| 本次实际写入副本 | %d |" % len(rep.copied),
        "",
        "新增条目分类：`%s`；投递方式：local=%d / remote=%d。"
        % (", ".join("%s=%d" % (k, v) for k, v in sorted(by_cat.items())) or "无",
           by_delivery["local"], by_delivery["remote"]),
        "",
    ]
    if migration:
        lines += ["迁移文件：`%s`" % os.path.relpath(migration, ROOT).replace(os.sep, "/"), ""]

    if rep.existing_missing:
        lines += ["## 2. 已登记但源文件消失（必须修）", "",
                  "> 已登记的 key 在包内找不到源文件：要么补回文件，要么确认该资源已下线并从 DB 停用。", "",
                  "| key | 包内路径 |", "|---|---|"]
        lines += ["| `%s` | `%s` |" % m for m in rep.existing_missing]
        lines.append("")
    if rep.missing:
        lines += ["## 3. 新增条目源文件缺失（必须修）", "", "| key | 引用路径 |", "|---|---|"]
        lines += ["| `%s` | `%s` |" % m for m in rep.missing]
        lines.append("")
    if rep.changed:
        lines += ["## 4. 内容变更（源文件已替换，需同步 DB）", "",
                  "| key | 旧 sha256 | 新 sha256 | size |", "|---|---|---|---|"]
        for it in rep.changed[:40]:
            lines.append("| `%s` | `%s…` | `%s…` | %d |"
                         % (it.key, it.db_sha256[:12], it.sha256[:12], it.size))
        if len(rep.changed) > 40:
            lines.append("| … | 其余 %d 条 | | |" % (len(rep.changed) - 40))
        lines.append("")
    if rep.dst_stale:
        lines += ["## 5. 副本缺失/过期", "", "| key | file_path | 状态 |", "|---|---|---|"]
        lines += ["| `%s` | `%s` | %s |" % d for d in rep.dst_stale[:40]]
        if len(rep.dst_stale) > 40:
            lines.append("| … | 其余 %d 条 | |" % (len(rep.dst_stale) - 40))
        lines.append("")
    if rep.duplicates:
        lines += ["## 6. 重复 key（必须修）", "", "| key | 首个来源 | 冲突来源 |", "|---|---|---|"]
        lines += ["| `%s` | `%s` | `%s` |" % d for d in rep.duplicates]
        lines.append("")
    if rep.bad_mime:
        lines += ["## 7. mime 非白名单（已拒绝）", "", "| key | 扩展名 |", "|---|---|"]
        lines += ["| `%s` | `%s` |" % b for b in rep.bad_mime]
        lines.append("")
    if rep.copy_failed:
        lines += ["## 8. 复制失败", "", "| 目标 | 原因 |", "|---|---|"]
        lines += ["| `%s` | %s |" % c for c in rep.copy_failed]
        lines.append("")

    lines += [
        "## 9. 结论",
        "",
        "```text",
        "条目合计 = %d（新增 %d + 已登记 %d）" % (total, len(rep.new_items), len(rep.existing_items)),
        "内容变更 = %d，副本需更新 = %d，本次写入副本 = %d"
        % (len(rep.changed), len(rep.dst_stale), len(rep.copied)),
        "失败项 = 源缺失 %d / 已登记源消失 %d / 重复 %d / mime %d / 复制 %d"
        % (len(rep.missing), len(rep.existing_missing), len(rep.duplicates),
           len(rep.bad_mime), len(rep.copy_failed)),
        "```",
        "",
    ]
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))


def max_migration_version() -> int:
    """扫描 migration 目录取最大版本号（V 前缀 + 数字，如 V18__x.sql → 18）。"""
    top = 0
    if os.path.isdir(MIGRATION_DIR):
        for fn in os.listdir(MIGRATION_DIR):
            m = re.match(r"V(\d+)__", fn)
            if m:
                top = max(top, int(m.group(1)))
    return top


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="复制副本并生成迁移 SQL")
    ap.add_argument("--check", action="store_true", help="只盘点不写文件（默认行为）")
    ap.add_argument("--version", type=int, default=None,
                    help="迁移版本号（省略=自动取 max(现有版本)+1；指定已存在版本会被拒绝）")
    args = ap.parse_args()
    if args.write and args.check:
        ap.error("--write 与 --check 不能同时使用")

    # 历史坑：默认值曾硬编码 16，裸跑 --write 会把已应用的 V16 整份覆盖掉
    # （244 行 → 16 行，Flyway checksum 校验失败，只能从旧 jar 里捞原文恢复）。
    version = args.version if args.version is not None else max_migration_version() + 1
    args.version = version

    known = {r["key"]: r for r in existing_rows()}
    rep = Report()
    collect(rep, known)
    scan_dst(rep)

    migration = None
    if args.write:
        copy_files(rep)
        migration = write_migration(rep, args.version)
    write_report(rep, "write" if args.write else "check", migration, args.version)

    print("扫描 %d｜新增 %d｜已登记 %d｜内容变更 %d｜副本待更新 %d"
          % (rep.scanned, len(rep.new_items), len(rep.existing_items), len(rep.changed), len(rep.dst_stale)))
    print("失败：源缺失 %d / 已登记源消失 %d / 重复 %d / mime %d / 复制 %d"
          % (len(rep.missing), len(rep.existing_missing), len(rep.duplicates),
             len(rep.bad_mime), len(rep.copy_failed)))
    if migration:
        print("迁移已生成：%s" % os.path.relpath(migration, ROOT))
    print("报告：%s" % os.path.relpath(REPORT, ROOT))

    if rep.missing or rep.existing_missing or rep.duplicates or rep.bad_mime or rep.copy_failed:
        return 1
    if not args.write and (rep.new_items or rep.changed or rep.dst_stale):
        return 2  # --check 下检测到待处理差异
    return 0


if __name__ == "__main__":
    sys.exit(main())
