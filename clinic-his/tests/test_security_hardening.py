"""L7/L10 回归（2026-11-22 敌意审查）：患者哈希盐与登录限速窗口。

复现：
  - L7：PATIENT_HASH_SALT 硬编码，攻击者拿到库后可离线字典还原证件/手机号哈希；
  - L10：_login_windows 只清当前 IP 的过期记录，离线 IP 永不淘汰 → 内存无界增长。

修复期望：
  - 生产（CLINIC_ENV=production）必须显式注入 CLINIC_PATIENT_HASH_SALT，缺失拒绝启动；
  - 非生产保留旧盐兼容存量数据（换盐需重算迁移）；
  - 登录窗口全表过期清理 + 10000 IP 硬上限，按最近活动淘汰。

运行：cd clinic-his && python -m unittest discover -s tests -p "test_*.py" -v
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# db 在 import 时读取 CLINIC_DB / CLINIC_DATA_DIR；必须早于 import app.db。
_TMP = tempfile.mkdtemp(prefix="clinic-his-l7-")
os.environ["CLINIC_DB"] = os.path.join(_TMP, "clinic.db")
os.environ["CLINIC_DATA_DIR"] = _TMP
os.environ["CLINIC_PATIENT_HASH_SALT"] = "test-current-patient-salt"
os.environ.pop("CLINIC_ENV", None)
os.environ.pop("CLINIC_PATIENT_HASH_SALT_LEGACY", None)
os.environ.pop("CLINIC_ALLOW_LEGACY_PATIENT_HASH_SALT", None)

from app import security  # noqa: E402


class PatientHashSaltTest(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in (
            "CLINIC_ENV", "CLINIC_PATIENT_HASH_SALT",
            "CLINIC_PATIENT_HASH_SALT_LEGACY", "CLINIC_ALLOW_LEGACY_PATIENT_HASH_SALT")}
        os.environ.pop("CLINIC_ENV", None)
        os.environ.pop("CLINIC_PATIENT_HASH_SALT", None)
        os.environ.pop("CLINIC_PATIENT_HASH_SALT_LEGACY", None)
        os.environ.pop("CLINIC_ALLOW_LEGACY_PATIENT_HASH_SALT", None)

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_生产缺盐拒绝启动(self):
        os.environ["CLINIC_ENV"] = "production"
        with self.assertRaises(RuntimeError):
            security.load_patient_hash_salt()

    def test_非生产缺盐也拒绝启动(self):
        with self.assertRaises(RuntimeError):
            security.load_patient_hash_salt()

    def test_生产注入盐优先(self):
        os.environ["CLINIC_ENV"] = "production"
        os.environ["CLINIC_PATIENT_HASH_SALT"] = "prod-salt-from-kms"
        self.assertEqual("prod-salt-from-kms", security.load_patient_hash_salt())

    def test_非生产显式兼容开关才允许旧盐(self):
        os.environ["CLINIC_ENV"] = "dev"
        os.environ["CLINIC_ALLOW_LEGACY_PATIENT_HASH_SALT"] = "true"
        self.assertEqual(security._LEGACY_PATIENT_HASH_SALT, security.load_patient_hash_salt())

    def test_生产不允许兼容开关(self):
        os.environ["CLINIC_ENV"] = "production"
        os.environ["CLINIC_ALLOW_LEGACY_PATIENT_HASH_SALT"] = "true"
        with self.assertRaises(RuntimeError):
            security.load_patient_hash_salt()

    def test_盐为空串按未配置处理(self):
        os.environ["CLINIC_ENV"] = "production"
        os.environ["CLINIC_PATIENT_HASH_SALT"] = "   "
        with self.assertRaises(RuntimeError):
            security.load_patient_hash_salt()

    def test_双读兼容旧盐且新盐不相等(self):
        os.environ["CLINIC_ENV"] = "dev"
        os.environ["CLINIC_PATIENT_HASH_SALT"] = security.PATIENT_HASH_SALT
        os.environ["CLINIC_PATIENT_HASH_SALT_LEGACY"] = security._LEGACY_PATIENT_HASH_SALT
        old_hash = hashlib.sha256(
            (security._LEGACY_PATIENT_HASH_SALT + "110101199003071234").encode()).hexdigest()
        new_hash = security.patient_hash("110101199003071234")
        self.assertTrue(security.patient_hash_matches("110101199003071234", old_hash))
        self.assertTrue(security.patient_hash_matches("110101199003071234", new_hash))
        self.assertNotEqual(old_hash, new_hash)
        self.assertFalse(security.patient_hash_matches("110101199003071234", "f" * 64))


class LoginWindowBoundTest(unittest.TestCase):
    def setUp(self):
        self._backup = {ip: list(stamps) for ip, stamps in security._login_windows.items()}
        security._login_windows.clear()

    def tearDown(self):
        security._login_windows.clear()
        security._login_windows.update(self._backup)

    def test_超过上限按最近活动淘汰最旧(self):
        now = time.time()
        for i in range(12000):
            security._login_windows[f"ip-{i}"] = [now - (11999 - i) * 0.01]
        security._prune_login_windows(now)
        self.assertEqual(security._LOGIN_MAX_IPS, len(security._login_windows))
        self.assertNotIn("ip-0", security._login_windows, "最久未活动的 IP 应被淘汰")
        self.assertIn("ip-11999", security._login_windows, "最近活动的 IP 必须保留")

    def test_离线IP过期窗口全部清除(self):
        now = time.time()
        security._login_windows["offline"] = [now - 400]
        security._login_windows["weird"] = [now - 301, now - 200]
        security._login_windows["online"] = [now - 10]
        security._prune_login_windows(now)
        self.assertNotIn("offline", security._login_windows)
        self.assertEqual(1, len(security._login_windows["weird"]), "只保留窗口内的尝试")
        self.assertIn("online", security._login_windows)

    def test_大量来源IP经公开检查接口后字典仍不超过上限(self):
        for i in range(12000):
            security.ip_login_allowed(f"flood-{i}")
        self.assertLessEqual(len(security._login_windows), security._LOGIN_MAX_IPS)

    def test_20次上限仍生效(self):
        for _ in range(20):
            security.record_ip_attempt("10.0.0.9")
        self.assertFalse(security.ip_login_allowed("10.0.0.9"))
        security._login_windows["10.0.0.9"] = []
        self.assertTrue(security.ip_login_allowed("10.0.0.9"))


if __name__ == "__main__":
    unittest.main()
