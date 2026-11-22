"""受理即落院内挂号（2026-11-22）：openapi 受理成功后必须生成 registrations / queue_tickets。

背景：原实现只写 openapi_orders（对外受理台账），院内挂号列表、叫号队列、日报统计
完全看不到互联网医院来的患者 —— 平台显示「挂号成功」，院内没有这个人。

本文件锁定四条不变量：
  1. 首次受理 → registrations 一行（source=WECHAT、status=BOOKED、his_order_no 关联）
     + queue_tickets 一行（status=RESERVED，不参与叫号）；
  2. 同幂等键重放 → 不重复建挂号，回执带同一个 registrationNo；
  3. 撤销受理单 → 挂号与预排号同步 CANCELLED，不去动已签到/已就诊的记录；
  4. doctorId 与 departmentId 不属于同一科室 → 400，且不产生任何院内挂号。

运行：cd clinic-his && python -m unittest tests.test_openapi_registration -v
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# db 在 import 时读环境；必须早于 import app.*
_TMP = tempfile.mkdtemp(prefix="clinic-his-openapi-reg-")
os.environ["CLINIC_DB"] = os.path.join(_TMP, "clinic.db")
os.environ["CLINIC_DATA_DIR"] = _TMP
os.environ["CLINIC_PATIENT_HASH_SALT"] = "openapi-reg-test-salt"
os.environ.setdefault("CLINIC_SEED_PASSWORD", "OpenapiReg@2026!A")
os.environ.pop("CLINIC_ENV", None)

from app import db, security, seed  # noqa: E402
from app.main import ClinicServer, Handler  # noqa: E402

APP_ID = "wechar-mini"


class OpenApiRegistrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        seed.ensure_seed()
        cls.server = ClinicServer(("127.0.0.1", 0), Handler)
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        with db.tx() as con:
            row = con.execute("SELECT app_secret FROM openapi_keys WHERE app_id=?", (APP_ID,)).fetchone()
        assert row is not None, "种子未生成 openapi_keys"
        cls.secret = row["app_secret"]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    # ---------------- 工具 ----------------

    def _signed(self, method: str, path: str, body: dict | None, idem: str | None = None):
        raw = json.dumps(body or {}, ensure_ascii=False).encode("utf-8") if body is not None else b""
        ts = str(int(time.time()))
        nonce = secrets.token_hex(8)
        sig = security.sign_request(self.secret, method, path, APP_ID, ts, nonce, raw)
        headers = {
            "X-App-Id": APP_ID, "X-Timestamp": ts, "X-Nonce": nonce,
            "X-Signature": sig, "Content-Type": "application/json",
        }
        if idem:
            headers["Idempotency-Key"] = idem
        req = urllib.request.Request(self.base + path, data=raw if method != "GET" else None,
                                     method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    def _count(self, sql: str, params=()):
        with db.tx() as con:  # 读也走 tx：sqlite3.Row 工厂一致
            return con.execute(sql, params).fetchone()[0]

    def _staff(self, staff_no: str):
        with db.tx() as con:
            return con.execute("SELECT id, dept_id FROM staff WHERE staff_no=?", (staff_no,)).fetchone()

    def _dept_id(self, code: str):
        with db.tx() as con:
            return con.execute("SELECT id FROM departments WHERE code=?", (code,)).fetchone()["id"]

    # ---------------- 用例 ----------------

    def test_受理成功即生成挂号与预排号(self):
        doctor = self._staff("D001")          # 陈志远 / 全科医学科 QK（seed 自带）
        dept_id = self._dept_id("QK")
        before_reg = self._count("SELECT COUNT(*) FROM registrations")
        before_q = self._count("SELECT COUNT(*) FROM queue_tickets")

        status, payload = self._signed("POST", "/openapi/v1/appointments", {
            "appointmentId": "ap-reg-1", "slotId": "slot-reg-1",
            "patientName": "联调患者甲", "doctorId": "D001", "departmentId": "QK",
            "slotDate": "2026-12-01", "slotTime": "08:30",
        }, idem="idem-reg-1")

        self.assertEqual(201, status, payload)
        data = payload["data"]
        self.assertTrue(data["registrationNo"].startswith("RG20261201-"), data)
        self.assertTrue(data["queueNo"].startswith("QK"), data)
        self.assertEqual("2026-12-01", data["visitDate"])

        self.assertEqual(before_reg + 1, self._count("SELECT COUNT(*) FROM registrations"))
        self.assertEqual(before_q + 1, self._count("SELECT COUNT(*) FROM queue_tickets"))

        with db.tx() as con:
            reg = con.execute("SELECT * FROM registrations WHERE his_order_no=?",
                              (data["hisOrderNo"],)).fetchone()
            ticket = con.execute("SELECT * FROM queue_tickets WHERE registration_id=?",
                                 (reg["id"],)).fetchone()
        self.assertEqual("BOOKED", reg["status"])
        self.assertEqual("WECHAT", reg["source"])
        self.assertEqual("2026-12-01", reg["reg_date"])
        self.assertEqual(doctor["id"], reg["doctor_id"])
        self.assertEqual(dept_id, reg["dept_id"])
        self.assertIsNone(reg["slot_id"], "平台号源与院内号源不同源，不得伪造外键")
        self.assertEqual(data["queueNo"], reg["queue_no"])
        self.assertEqual("RESERVED", ticket["status"], "预排号不得直接进入叫号队列")
        self.assertEqual("2026-12-01", ticket["queue_date"])

    def test_同幂等键重放不重复建挂号(self):
        body = {
            "appointmentId": "ap-reg-2", "slotId": "slot-reg-2",
            "patientName": "联调患者乙", "doctorId": "D001", "departmentId": "QK",
            "slotDate": "2026-12-02", "slotTime": "09:00",
        }
        first = self._signed("POST", "/openapi/v1/appointments", body, idem="idem-reg-2")
        self.assertEqual(201, first[0], first)
        reg_no = first[1]["data"]["registrationNo"]
        count_after_first = self._count("SELECT COUNT(*) FROM registrations WHERE his_order_no=?",
                                        (first[1]["data"]["hisOrderNo"],))

        second = self._signed("POST", "/openapi/v1/appointments", body, idem="idem-reg-2")
        self.assertEqual(200, second[0], second)
        self.assertTrue(second[1]["data"]["replayed"])
        self.assertEqual(reg_no, second[1]["data"]["registrationNo"])
        self.assertEqual(1, count_after_first)
        self.assertEqual(1, self._count("SELECT COUNT(*) FROM registrations WHERE his_order_no=?",
                                        (first[1]["data"]["hisOrderNo"],)))

    def test_撤销受理单同步作废院内挂号(self):
        body = {
            "appointmentId": "ap-reg-3", "slotId": "slot-reg-3",
            "patientName": "联调患者丙", "doctorId": "D001", "departmentId": "QK",
            "slotDate": "2026-12-03", "slotTime": "10:00",
        }
        created = self._signed("POST", "/openapi/v1/appointments", body, idem="idem-reg-3")
        self.assertEqual(201, created[0], created)
        order_no = created[1]["data"]["hisOrderNo"]

        cancelled = self._signed("POST", f"/openapi/v1/appointments/{order_no}/cancel",
                                 {"reason": "联调撤销"}, idem="idem-reg-3-cancel")
        self.assertEqual(200, cancelled[0], cancelled)
        self.assertTrue(cancelled[1]["data"]["registrationCancelled"])

        with db.tx() as con:
            reg = con.execute("SELECT * FROM registrations WHERE his_order_no=?", (order_no,)).fetchone()
            ticket = con.execute("SELECT status FROM queue_tickets WHERE registration_id=?",
                                 (reg["id"],)).fetchone()
        self.assertEqual("CANCELLED", reg["status"])
        self.assertEqual("CANCELLED", ticket["status"])

    def test_医生不属于科室时拒绝且不落挂号(self):
        before = self._count("SELECT COUNT(*) FROM registrations")
        status, payload = self._signed("POST", "/openapi/v1/appointments", {
            "appointmentId": "ap-reg-4", "patientName": "联调患者丁",
            "doctorId": "D001", "departmentId": "NK", "slotDate": "2026-12-04",
        }, idem="idem-reg-4")
        self.assertEqual(400, status, payload)
        self.assertEqual("VALIDATION_FAILED", payload["code"])
        self.assertEqual(before, self._count("SELECT COUNT(*) FROM registrations"))

    def test_缺省就诊日期按当天落库(self):
        status, payload = self._signed("POST", "/openapi/v1/appointments", {
            "appointmentId": "ap-reg-5", "patientName": "联调患者戊",
            "doctorId": "D001", "departmentId": "QK",
        }, idem="idem-reg-5")
        self.assertEqual(201, status, payload)
        self.assertEqual(db.today_str(), payload["data"]["visitDate"])


if __name__ == "__main__":
    unittest.main()
