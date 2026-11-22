"""B3 回归（2026-11-23 复审 D-05/D-06）：存量库旧默认口令必须强制首登改密。

复现事实（修复前，真实 data/clinic.db）：
  USERS_TOTAL=31，MUST_CHANGE_0=30；admin06 / doctor01 / nurse01 用旧统一默认口令
  哈希校验均为 True，且 must_change=0 → 可直接调用全部业务接口；
  admin.py 只统计 must_change=1，会把「从未改密」算成已完成 → 合规自检误报 PASS。

修复期望：
  1. mark_legacy_accounts() 把「must_change=0 且从未改密」的账号置 1，幂等、写审计哈希链；
  2. 迁移后 ADMIN/医生/护士首登全部被 403 拦截，改密后恢复；
  3. 合规自检不再 PASS：未迁移 → FAIL；已迁移未改密 → WARN 且列出角色分布；
  4. 已改密账号不会被二次标记。

运行：cd clinic-his && python -m unittest discover -s tests -p "test_*.py" -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

_TMP = tempfile.mkdtemp(prefix="clinic-his-b3-")
os.environ["CLINIC_DB"] = os.path.join(_TMP, "clinic.db")
os.environ["CLINIC_DATA_DIR"] = _TMP
os.environ["CLINIC_PATIENT_HASH_SALT"] = "test-b3-patient-salt"
os.environ.setdefault("CLINIC_ENV", "test")

from app import db, legacy_credentials, security, seed  # noqa: E402
from app.api import admin, auth  # noqa: E402

SEED_PASSWORD = "SeedInit@2026"


class LegacyCredentialMigrationTest(unittest.TestCase):
    def setUp(self):
        os.environ[seed.SEED_PASSWORD_ENV] = SEED_PASSWORD
        if os.path.exists(db.DB_PATH):
            for suffix in ("", "-wal", "-shm"):
                path = db.DB_PATH + suffix
                if os.path.exists(path):
                    os.remove(path)
        db.init_db()
        seed.ensure_seed()
        # 还原存量库现场：种子账号 must_change=0，password_changed_at=created_at。
        with db.tx() as con:
            con.execute(
                "UPDATE users SET must_change=0, password_changed_at=created_at")
            self.total = con.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]

    def _user(self, username):
        with db.tx() as con:
            return con.execute("SELECT * FROM users WHERE username=?",
                               (username,)).fetchone()

    def _session_user(self, username):
        row = self._user(username)
        token = security.create_session(row["id"], "127.0.0.1", "unit-test")
        return token, security.resolve_session(token)

    def test_存量未标记账号可绕过首登改密_修复前缺陷现场(self):
        pending = legacy_credentials.find_unmarked()
        self.assertEqual(self.total, len(pending),
                         "存量账号应全部处于「从未改密且未标记」")
        for username in ("admin06", "doctor01", "nurse01"):
            _, user = self._session_user(username)
            self.assertEqual(0, int(user["must_change"]))
            self.assertFalse(
                security.must_change_blocks(user, "GET", "/api/v1/patients"),
                username + " 未改密却可访问业务接口（D-05 复现）")

    def test_迁移后全部强制改密且幂等可审计(self):
        first = legacy_credentials.mark_legacy_accounts()
        self.assertEqual(self.total, first["marked"])
        self.assertEqual([], legacy_credentials.find_unmarked())

        for username in ("admin06", "doctor01", "nurse01"):
            _, user = self._session_user(username)
            self.assertEqual(1, int(user["must_change"]))
            self.assertTrue(
                security.must_change_blocks(user, "GET", "/api/v1/patients"),
                username + " 迁移后仍未被拦截")
            self.assertTrue(
                security.must_change_blocks(user, "GET", "/api/v1/reports/overview"),
                username + " 报表接口未被拦截")

        second = legacy_credentials.mark_legacy_accounts()
        self.assertEqual(0, second["marked"], "迁移必须幂等")

        with db.tx() as con:
            audit = con.execute(
                "SELECT COUNT(*) AS c FROM audit_logs WHERE action='LEGACY_CREDENTIAL_FORCE_CHANGE'"
            ).fetchone()["c"]
        self.assertEqual(1, audit, "迁移必须留审计痕且只写一条")

    def test_已改密账号不会被二次标记(self):
        token, user = self._session_user("doctor01")
        self.assertEqual(0, int(user["must_change"]))
        time.sleep(1.05)  # 让 password_changed_at 严格晚于 created_at（秒级时间戳）
        ctx = SimpleNamespace(
            token=token, user=user, ip="127.0.0.1",
            body={"oldPassword": SEED_PASSWORD, "newPassword": "DoctorNew@2026!"},
            params={})
        self.assertTrue(auth.change_password(ctx)["changed"])

        result = legacy_credentials.mark_legacy_accounts()
        self.assertEqual(self.total - 1, result["marked"], "只应标记其余从未改密账号")
        _, changed = self._session_user("doctor01")
        self.assertEqual(0, int(changed["must_change"]), "已改密账号被误标记")
        self.assertFalse(security.must_change_blocks(changed, "GET", "/api/v1/patients"))

    def test_合规自检不再误报PASS(self):
        ctx = SimpleNamespace(user=None, ip="127.0.0.1")
        before = admin.compliance(ctx)
        item = next(i for i in before["items"] if i["key"] == "password_policy")
        self.assertEqual("FAIL", item["status"], "未迁移的存量账号不得报 PASS/WARN 以上")
        self.assertIn("存量账号从未改密", item["detail"])

        legacy_credentials.mark_legacy_accounts()
        after = admin.compliance(ctx)
        item = next(i for i in after["items"] if i["key"] == "password_policy")
        self.assertEqual("WARN", item["status"], "已强制改密但未完成时不得 PASS")
        self.assertIn("尚未完成首登改密", item["detail"])
        self.assertIn("ADMIN", item["detail"], "明细必须列出角色分布")
        self.assertIn("改密前业务接口一律 403", item["detail"])


if __name__ == "__main__":
    unittest.main()
