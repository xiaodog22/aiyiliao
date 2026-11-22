"""一次性轮换存量账号口令（发布前 B3 条件，2026-11-23）。

背景：B3 只把「从未改密」账号置 must_change=1，旧统一默认口令仍可用于首登改密；
发布前必须直接轮换，避免知道旧口令的人抢先接管账号。

口径：
  · 只轮换 must_change=1 且「建号后从未改密」的账号（已自行改密的不动）；
  · 每个账号生成独立随机口令（≥14 位，大小写/数字/符号齐全），PBKDF2 存储；
  · 轮换后仍保持 must_change=1（首次登录继续强制改密）；
  · 口令明文只写入本地 `data/rotated_credentials_<date>.txt`（gitignored），不打印到 stdout；
  · 审计只记录数量与角色分布，不落任何口令；
  · 幂等：已有 ROTATE 审计且未 --force 时不再轮换；--force 可再次轮换。
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app import db, security  # noqa: E402

ACTION = "LEGACY_CREDENTIAL_ROTATE"
_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
_LOWER = "abcdefghijkmnopqrstuvwxyz"
_DIGITS = "23456789"
_SYMBOLS = "!@#$%^&*-_+="


def _password(length: int = 16) -> str:
    pool = _UPPER + _LOWER + _DIGITS + _SYMBOLS
    chars = [secrets.choice(_UPPER), secrets.choice(_LOWER),
             secrets.choice(_DIGITS), secrets.choice(_SYMBOLS)]
    chars.extend(secrets.choice(pool) for _ in range(max(0, length - 4)))
    secrets.SystemRandom().shuffle(chars)
    password = "".join(chars)
    if security.validate_password(password):
        raise RuntimeError("生成口令不符合策略，拒绝落库")
    return password


def rotate(dry_run: bool = False, force: bool = False, out_path: str = "") -> dict:
    with db.tx() as con:
        already = con.execute(
            "SELECT COUNT(*) AS c FROM audit_logs WHERE action=?", (ACTION,)).fetchone()["c"]
        if already and not force:
            return {"rotated": 0, "reason": "ALREADY_ROTATED", "dryRun": dry_run}

        rows = con.execute(
            "SELECT id, username, role FROM users WHERE must_change=1 AND "
            "(password_changed_at IS NULL OR password_changed_at <= created_at) "
            "ORDER BY role, username").fetchall()
        if dry_run or not rows:
            return {"rotated": 0, "scanned": len(rows), "dryRun": dry_run}

        now = db.now_str()
        lines = ["# 一次性轮换口令（本地文件，禁止入库/外发）",
                 "# generated_at=" + now,
                 "# 账号首登仍需改密；此文件验证后请删除", ""]
        roles = {}
        for row in rows:
            password = _password()
            con.execute(
                "UPDATE users SET password_hash=?, password_changed_at=?, must_change=1 WHERE id=?",
                (security.hash_password(password), now, row["id"]))
            lines.append("\t".join((row["username"], row["role"], password)))
            roles[row["role"]] = roles.get(row["role"], 0) + 1

        target = out_path or os.path.join(
            os.path.dirname(db.DB_PATH),
            "rotated_credentials_" + datetime.now().strftime("%Y%m%d") + ".txt")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(lines) + "\n")
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass

        security.audit(con, None, ACTION, "user", "bulk",
                       "rotated=" + str(len(rows)) + " roles=" + json.dumps(roles, ensure_ascii=False),
                       "OK")
        return {"rotated": len(rows), "roles": roles, "file": target, "dryRun": False}


def main() -> int:
    parser = argparse.ArgumentParser(description="轮换存量账号口令（一次性）")
    parser.add_argument("--db", default="", help="SQLite 路径（默认 CLINIC_DB / data/clinic.db）")
    parser.add_argument("--apply", action="store_true", help="实际写库；缺省只读预览")
    parser.add_argument("--force", action="store_true", help="已有审计记录时再次轮换")
    parser.add_argument("--out", default="", help="口令文件输出路径（默认 data/rotated_credentials_<date>.txt）")
    args = parser.parse_args()

    db_path = os.path.abspath(args.db or os.environ.get("CLINIC_DB")
                              or os.path.join(ROOT, "data", "clinic.db"))
    if not os.path.isfile(db_path):
        print(json.dumps({"error": "DB_NOT_FOUND", "db": db_path}, ensure_ascii=False))
        return 2
    os.environ["CLINIC_DB"] = db_path
    os.environ.setdefault("CLINIC_DATA_DIR", os.path.dirname(db_path))

    result = rotate(dry_run=not args.apply, force=args.force, out_path=args.out)
    result["db"] = db_path
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
