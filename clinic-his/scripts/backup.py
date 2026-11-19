"""SQLite 在线备份（等保“数据备份”控制点的最小实现）。

用法（clinic-his 目录）：
    python scripts/backup.py            # 备份到 backups/clinic-YYYYmmdd-HHMMSS.db
    python scripts/backup.py --keep 30  # 只保留最近 30 份
备份使用 sqlite3 在线备份 API，可在服务运行中执行。
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "clinic.db")
BACKUP_DIR = os.path.join(ROOT, "backups")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", type=int, default=30, help="保留最近 N 份备份")
    args = parser.parse_args()

    if not os.path.exists(SRC):
        print(f"数据库不存在：{SRC}")
        return 1

    os.makedirs(BACKUP_DIR, exist_ok=True)
    target = os.path.join(BACKUP_DIR, "clinic-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".db")

    src = sqlite3.connect(SRC)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()

    verify = sqlite3.connect(target)
    try:
        result = verify.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        verify.close()

    if result != "ok":
        print(f"备份完整性校验失败：{result}")
        return 1

    files = sorted(
        (f for f in os.listdir(BACKUP_DIR) if f.startswith("clinic-") and f.endswith(".db")),
        reverse=True,
    )
    for stale in files[args.keep:]:
        os.remove(os.path.join(BACKUP_DIR, stale))

    size_kb = os.path.getsize(target) / 1024
    print(f"备份完成：{target}（{size_kb:.1f} KB，integrity=ok，保留 {min(len(files), args.keep)} 份）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
