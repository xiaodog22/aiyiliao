"""L7 回归（2026-11-23 复审）：患者哈希必须接入真实查询路径，不能只留测试 helper。

复现缺陷：
  · `patient_hash_matches/candidates` 只被单测调用，患者检索只查 name/mrn/phone_mask；
  · 用证件号或完整手机号在系统里搜不到患者（掩码列只有 138****8000）；
  · 换盐后旧哈希行即使保留，也没有任何查询能命中 → 双读形同虚设。

修复期望：
  1. `list_patients(q=证件号/手机号)` 走 id_hash / phone_hash 精确检索；
  2. 迁移期同时接受新盐与旧盐哈希（CLINIC_PATIENT_HASH_SALT_LEGACY）；
  3. 响应不回传任何哈希或明文证件号；错误号码返回空列表而不是报错。

运行：cd clinic-his && python -m unittest discover -s tests -p "test_*.py" -v
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

_TMP = tempfile.mkdtemp(prefix="clinic-his-l7q-")
os.environ["CLINIC_DB"] = os.path.join(_TMP, "clinic.db")
os.environ["CLINIC_DATA_DIR"] = _TMP
os.environ["CLINIC_ENV"] = "test"
os.environ["CLINIC_PATIENT_HASH_SALT"] = "new-patient-salt"
os.environ["CLINIC_PATIENT_HASH_SALT_LEGACY"] = "old-patient-salt"

from app import db, security, seed  # noqa: E402
from app.api import basic  # noqa: E402

ID_CARD = "110101199003071234"
PHONE = "13800138000"


def _legacy_hash(value: str) -> str:
    return hashlib.sha256(("old-patient-salt" + value).encode("utf-8")).hexdigest()


def _ctx(**query):
    return SimpleNamespace(q=lambda name, default="": query.get(name, default),
                           user={"id": 1, "role": "ADMIN"}, ip="127.0.0.1")


class PatientHashLookupTest(unittest.TestCase):
    def setUp(self):
        os.environ.setdefault(seed.SEED_PASSWORD_ENV, "SeedInit@2026")
        # unittest discover 会把多个测试模块导入同一进程：盐常量以最后 import 为准。
        # 本用例显式固定当前盐与旧盐，避免受 import 顺序影响（否则换盐双读测不出来）。
        os.environ["CLINIC_PATIENT_HASH_SALT"] = "new-patient-salt"
        os.environ["CLINIC_PATIENT_HASH_SALT_LEGACY"] = "old-patient-salt"
        self._saved_salt = security.PATIENT_HASH_SALT
        security.PATIENT_HASH_SALT = "new-patient-salt"
        for suffix in ("", "-wal", "-shm"):
            path = db.DB_PATH + suffix
            if os.path.exists(path):
                os.remove(path)
        db.init_db()
        seed.ensure_seed()
        # 模拟换盐后的存量行：id_hash/phone_hash 仍是旧盐
        with db.tx() as con:
            con.execute(
                "INSERT INTO patients(mrn,name,gender,birth_date,id_last4,id_hash,phone_mask,phone_hash,"
                "address,allergy,chronic_tags,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                ("P999999", "哈希检索测试", "男", "1990-03-07", "1234",
                 _legacy_hash(ID_CARD), "138****8000", _legacy_hash(PHONE),
                 "", "", "[]", db.now_str()))

    def tearDown(self):
        security.PATIENT_HASH_SALT = self._saved_salt
        os.environ.pop("CLINIC_PATIENT_HASH_SALT_LEGACY", None)

    def test_证件号可命中旧盐哈希(self):
        rows = basic.list_patients(_ctx(q=ID_CARD))
        self.assertEqual(1, len(rows), "旧盐 id_hash 必须可检索（换盐不能丢老患者）")
        self.assertEqual("P999999", rows[0]["mrn"])

    def test_完整手机号可命中旧盐哈希(self):
        rows = basic.list_patients(_ctx(q=PHONE))
        self.assertEqual(1, len(rows), "掩码列搜不到完整手机号，必须走 phone_hash")
        self.assertEqual("P999999", rows[0]["mrn"])

    def test_新盐哈希同样可检索(self):
        with db.tx() as con:
            con.execute("UPDATE patients SET id_hash=? WHERE mrn='P999999'",
                        (security.patient_hash(ID_CARD),))
        rows = basic.list_patients(_ctx(q=ID_CARD))
        self.assertEqual(1, len(rows))

    def test_错误号码返回空且不回传哈希(self):
        rows = basic.list_patients(_ctx(q="110101199003079999"))
        self.assertEqual([], rows)
        rows = basic.list_patients(_ctx(q=ID_CARD))
        self.assertNotIn("id_hash", rows[0])
        self.assertNotIn("phone_hash", rows[0])
        self.assertNotIn(ID_CARD, str(rows[0]))
        self.assertEqual("138****8000", rows[0]["phoneMask"])


if __name__ == "__main__":
    unittest.main()
