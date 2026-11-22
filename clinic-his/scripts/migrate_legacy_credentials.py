"""一次性存量账号口令迁移（B3 / D-05）：把「建号后从未改密」的账号置 must_change=1。

用法（在 clinic-his 目录）：
    python scripts/migrate_legacy_credentials.py                 # 只读预览（默认）
    python scripts/migrate_legacy_credentials.py --apply         # 实际写库
    python scripts/migrate_legacy_credentials.py --db data/clinic.db --apply

幂等：重复执行 marked=0；只改 must_change，不动 password_hash；写 audit_logs 哈希链。
服务启动时也会自动执行同一函数（app/main.py bootstrap），本脚本用于运维显式留痕/演练。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    parser = argparse.ArgumentParser(description="存量账号强制首登改密迁移（幂等）")
    parser.add_argument("--db", default="", help="SQLite 路径（默认取 CLINIC_DB / data/clinic.db）")
    parser.add_argument("--apply", action="store_true", help="实际写库；缺省只读预览")
    args = parser.parse_args()

    db_path = os.path.abspath(args.db or os.environ.get("CLINIC_DB")
                              or os.path.join(ROOT, "data", "clinic.db"))
    if not os.path.isfile(db_path):
        print(json.dumps({"error": "DB_NOT_FOUND", "db": db_path}, ensure_ascii=False))
        return 2
    # 必须在 import app.db 之前定库；数据目录跟随 DB，避免脚本写到默认目录。
    os.environ["CLINIC_DB"] = db_path
    os.environ.setdefault("CLINIC_DATA_DIR", os.path.dirname(db_path))
    sys.path.insert(0, ROOT)

    from app import legacy_credentials  # noqa: E402

    result = legacy_credentials.mark_legacy_accounts(dry_run=not args.apply)
    result["db"] = db_path
    result["applied"] = bool(args.apply)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
