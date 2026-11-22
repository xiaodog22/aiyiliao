"""存量账号口令迁移（2026-11-23 复审阻断项 B3 / D-05、D-06）。

缺陷事实：
  · 存量演示库 31 个账号里 30 个 must_change=0，旧统一默认口令哈希校验仍为 True；
  · seed.ensure_seed() 只在 departments 为空时建账号，已有库永远不会重新 seed；
  · admin 合规自检只统计 must_change=1，于是把「从未改密的存量账号」算成已完成改密。

判定口径（与合规自检共用）：
  must_change=0 且 password_changed_at IS NULL 或 <= created_at
  → 建号后从未改密，仍可能是种子/管理员初始口令 → 必须重新强制首登改密。

为什么不是「比对旧默认口令」：
  代码里再写一份旧口令等于把已泄露口令长期留在仓库；而且运营改过初始口令的库也识别不到。
  「从未改密」是更宽、更保守的条件：宁可多要求一次改密，不可放过一个默认口令账号。

迁移是幂等、可审计的：只把 must_change 从 0 置 1，不修改口令哈希、不动密码历史；
重复执行 marked=0。审计只记数量与角色分布，不落任何口令明文。
"""

from __future__ import annotations

import json

from . import db

# SQL 片段：建号后从未改密（NULL 或与创建时间相同/更早）。
NEVER_CHANGED_SQL = "(password_changed_at IS NULL OR password_changed_at <= created_at)"


def _rows(con):
    return con.execute(
        "SELECT id, username, role, must_change, created_at, password_changed_at "
        "FROM users WHERE must_change=0 AND " + NEVER_CHANGED_SQL + " "
        "ORDER BY role, username"
    ).fetchall()


def find_unmarked(con=None) -> list:
    """返回仍未被强制改密的存量账号（只读，供脚本 dry-run / 测试断言）。"""
    if con is not None:
        return _rows(con)
    with db.tx() as own:
        return _rows(own)


def pending_by_role(con=None) -> dict:
    """统计「未完成首登改密」账号的角色分布（must_change=1 或从未改密）。"""
    def query(c):
        rows = c.execute(
            "SELECT role, COUNT(*) AS c FROM users "
            "WHERE must_change=1 OR " + NEVER_CHANGED_SQL + " GROUP BY role ORDER BY role"
        ).fetchall()
        return {row["role"]: int(row["c"]) for row in rows}

    if con is not None:
        return query(con)
    with db.tx() as own:
        return query(own)


def mark_legacy_accounts(dry_run: bool = False) -> dict:
    """把存量未标记账号置 must_change=1（幂等）。

    返回 {scanned, marked, roles, dryRun}；dryRun 时不写库。
    审计写入与更新在同一事务内，异常整体回滚（不会出现「改了没留痕」）。
    """
    with db.tx() as con:
        rows = _rows(con)
        roles = {}
        for row in rows:
            roles[row["role"]] = roles.get(row["role"], 0) + 1
        summary = {
            "scanned": len(rows),
            "marked": 0,
            "roles": roles,
            "dryRun": bool(dry_run),
        }
        if dry_run or not rows:
            return summary

        con.executemany("UPDATE users SET must_change=1 WHERE id=?",
                        [(row["id"],) for row in rows])
        # 延迟导入：dry-run 不依赖患者哈希盐（运维只读排查也能跑）。
        from . import security
        security.audit(
            con, None, "LEGACY_CREDENTIAL_FORCE_CHANGE", "user", "bulk",
            "marked=" + str(len(rows)) + " roles=" + json.dumps(roles, ensure_ascii=False),
            "OK")
        summary["marked"] = len(rows)
        return summary
