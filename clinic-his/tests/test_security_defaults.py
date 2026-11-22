"""L4 回归（2026-11-22 敌意审查）：clinic-his 种子口令必须 env/随机且首登改密。

复现原缺陷：
  - seed.py 写死统一口令 Clinic@2026、users.must_change=0；
  - main.py 鉴权后没有任何 must_change 拦截；
  → 全新建库后任何人都能用公开口令调用全部业务接口。

修复后期望（fail-closed）：
  1. 种子口令来自 CLINIC_SEED_PASSWORD，未提供则随机生成并仅打印一次；
  2. 所有种子账号 must_change=1（ADMIN 同样适用）；
  3. 未改密时仅 /auth/me、/auth/password、/auth/logout 放行，其余一律拦截；
  4. 改密成功后 must_change 归零、拦截解除。

运行（纯标准库，无需 pytest）：
  cd clinic-his && python -m unittest discover -s tests -p "test_*.py" -v
"""
from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
import unittest.mock
from types import SimpleNamespace

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# db 在 import 时读取 CLINIC_DB / CLINIC_DATA_DIR；必须早于 import app.db。
_TMP = tempfile.mkdtemp(prefix="clinic-his-l4-")
os.environ["CLINIC_DB"] = os.path.join(_TMP, "clinic.db")
os.environ["CLINIC_DATA_DIR"] = _TMP
os.environ["CLINIC_PATIENT_HASH_SALT"] = "test-l4-patient-salt"
os.environ.setdefault("CLINIC_ENV", "test")

from app import db, seed, security  # noqa: E402
from app.api import auth  # noqa: E402

# 测试预置口令：通过环境变量注入，避免依赖任何代码内默认值。
SEED_PASSWORD = "SeedInit@2026"


class SeedMustChangeTest(unittest.TestCase):
    def setUp(self):
        os.environ[seed.SEED_PASSWORD_ENV] = SEED_PASSWORD
        if os.path.exists(db.DB_PATH):
            os.remove(db.DB_PATH)
        db.init_db()
        seed.ensure_seed()

    def test_种子账号全部标记首登改密(self):
        con = db.connect()
        try:
            rows = con.execute("SELECT username, must_change FROM users").fetchall()
        finally:
            con.close()
        self.assertGreater(len(rows), 0, "种子账号未创建")
        not_flagged = [r["username"] for r in rows if int(r["must_change"]) != 1]
        self.assertEqual([], not_flagged, "以下账号 must_change 仍为 0（默认口令可直接使用）: "
                         + ", ".join(not_flagged))

    def test_未改密仅放行三个端点(self):
        con = db.connect()
        try:
            uid = con.execute("SELECT id FROM users WHERE username='doctor01'").fetchone()["id"]
        finally:
            con.close()
        token = security.create_session(uid, "127.0.0.1", "unit-test")
        user = security.resolve_session(token)
        self.assertEqual(1, int(user["must_change"]))

        # 业务接口全部拦截（含读写、报表、管理）
        for method, path in (
            ("GET", "/api/v1/patients"),
            ("POST", "/api/v1/visits"),
            ("GET", "/api/v1/reports/overview"),
            ("POST", "/api/v1/charge/1/pay"),
        ):
            self.assertTrue(security.must_change_blocks(user, method, path),
                            f"{method} {path} 未被首登改密拦截")

        # 自助端点放行
        for method, path in (
            ("GET", "/api/v1/auth/me"),
            ("POST", "/api/v1/auth/password"),
            ("POST", "/api/v1/auth/logout"),
        ):
            self.assertFalse(security.must_change_blocks(user, method, path),
                             f"{method} {path} 应放行（否则无法完成改密）")

    def test_改密后归零并恢复业务访问(self):
        con = db.connect()
        try:
            uid = con.execute("SELECT id FROM users WHERE username='doctor01'").fetchone()["id"]
        finally:
            con.close()
        token = security.create_session(uid, "127.0.0.1", "unit-test")
        user = security.resolve_session(token)

        ctx = SimpleNamespace(
            token=token,
            user=user,
            ip="127.0.0.1",
            body={"oldPassword": SEED_PASSWORD, "newPassword": "NewPassw0rd!2026"},
            params={},
        )
        result = auth.change_password(ctx)
        self.assertTrue(result["changed"])

        user2 = security.resolve_session(token)  # 改密保留当前会话
        self.assertEqual(0, int(user2["must_change"]), "改密后 must_change 未归零")
        self.assertFalse(security.must_change_blocks(user2, "GET", "/api/v1/patients"),
                         "改密后业务接口仍被拦截")

    def test_无会话用户不拦截由401负责(self):
        self.assertFalse(security.must_change_blocks(None, "GET", "/api/v1/patients"))

    def test_种子口令来自环境变量且旧统一口令失效(self):
        con = db.connect()
        try:
            stored = con.execute(
                "SELECT password_hash FROM users WHERE username='doctor01'").fetchone()["password_hash"]
        finally:
            con.close()
        self.assertTrue(security.verify_password(SEED_PASSWORD, stored), "环境变量注入的口令未生效")
        self.assertFalse(security.verify_password("Clinic@2026", stored),
                         "旧统一口令 Clinic@2026 仍可登录")

    def test_未配置环境变量时随机生成且仅打印一次(self):
        with unittest.mock.patch.dict(os.environ, {seed.SEED_PASSWORD_ENV: ""}):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                first = seed.resolve_seed_password()
                second = seed.resolve_seed_password()
        self.assertNotEqual(first, second, "随机口令不得复用")
        self.assertIsNone(security.validate_password(first))
        self.assertIsNone(security.validate_password(second))
        printed = out.getvalue()
        self.assertEqual(1, printed.count(first), "随机口令必须在生成时打印且仅一次")
        self.assertEqual(1, printed.count(second), "随机口令必须在生成时打印且仅一次")

    def test_ADMIN改密前业务权限不可用(self):
        con = db.connect()
        try:
            uid = con.execute("SELECT id FROM users WHERE username='admin06'").fetchone()["id"]
        finally:
            con.close()
        token = security.create_session(uid, "127.0.0.1", "unit-test")
        user = security.resolve_session(token)
        self.assertEqual(1, int(user["must_change"]))
        self.assertTrue(security.must_change_blocks(user, "GET", "/api/v1/audit/logs"),
                        "ADMIN 未改密时系统管理接口必须被拦截")

        ctx = SimpleNamespace(
            token=token, user=user, ip="127.0.0.1",
            body={"oldPassword": SEED_PASSWORD, "newPassword": "AdminNew@2026!"},
            params={},
        )
        self.assertTrue(auth.change_password(ctx)["changed"])

        user2 = security.resolve_session(token)
        self.assertEqual(0, int(user2["must_change"]))
        self.assertIn("system.admin", user2["perms"], "ADMIN 改密后应恢复系统管理权限")
        self.assertFalse(security.must_change_blocks(user2, "GET", "/api/v1/audit/logs"))


if __name__ == "__main__":
    unittest.main()
