"""患者主索引建档接口（2026-11-27，P3 病历/报告前置）。

背景：此前平台对 HIS 只有「姓名」一个身份字段，HIS 用 sha256(appId|姓名) 派生 DEMO- MRN，
同名即串号、改名即另起一档。本接口引入 external_patient_ref（pat-<uuid>）作为稳定外部引用。

本文件锁定 11 条不变量（对应 docs/患者主索引接口契约_20261127.md §7.1）：
  H-01 新 ref → 新建 1 条、source_app_id 写入、审计 CREATE
  H-02 同 ref 二次调用（字段更全）→ 不新建，只补空字段，fieldsUpdated 精确
  H-03 同 ref 二次调用（已有非空值不同）→ 非空值不被覆盖
  H-04 另一 appId 用同 ref → 409 PATIENT_REF_OWNED_BY_OTHER_APP，库不变
  H-05 ref 格式非法 → 400 PATIENT_REF_INVALID
  H-06 idHash 非 64 hex → 400 VALIDATION_FAILED
  H-07 同 idHash 绑到另一 ref → 409 ID_HASH_CONFLICT
  H-08 受理带 patientRef → 挂号落在该 patient，响应含 hisPatientId
  H-09 受理不带 patientRef → 走 _demo_patient，审计标 LEGACY_DERIVED
  H-10 受理带非法 ref → 400，且不落挂号（无 openapi_orders / registrations 新行）
  H-11 同 Idempotency-Key 重放 → 同 patientId，不重复建档、不重复审计

运行：cd clinic-his && python -m unittest tests.test_openapi_patient -v
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
_TMP = tempfile.mkdtemp(prefix="clinic-his-openapi-patient-")
os.environ["CLINIC_DB"] = os.path.join(_TMP, "clinic.db")
os.environ["CLINIC_DATA_DIR"] = _TMP
os.environ["CLINIC_PATIENT_HASH_SALT"] = "openapi-patient-test-salt"
os.environ.setdefault("CLINIC_SEED_PASSWORD", "OpenapiPatient@2026!A")
os.environ.pop("CLINIC_ENV", None)

from app import db, security, seed  # noqa: E402
from app.main import ClinicServer, Handler  # noqa: E402

APP_ID = "wechar-mini"
OTHER_APP_ID = "other-app"
OTHER_APP_SECRET = "other-app-secret-for-test"
def ref(n: int = 1) -> str:
    return "pat-" + f"{n:032x}"


def h64(n: int) -> str:
    """测试用 64 位哈希：每个用例取不同的值，避免互相触发 ID_HASH_CONFLICT。"""
    return f"{n:064x}"


class OpenApiPatientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        seed.ensure_seed()
        with db.tx() as con:
            row = con.execute("SELECT app_secret FROM openapi_keys WHERE app_id=?", (APP_ID,)).fetchone()
            assert row is not None, "种子未生成 openapi_keys"
            cls.secret = row["app_secret"]
            con.execute(
                "INSERT OR IGNORE INTO openapi_keys(app_id,app_secret,name,status,created_at) "
                "VALUES (?,?,?,'ACTIVE',?)",
                (OTHER_APP_ID, OTHER_APP_SECRET, "测试第二应用", db.now_str()))
        cls.server = ClinicServer(("127.0.0.1", 0), Handler)
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    # ---------------- 工具 ----------------

    def _signed(self, method: str, path: str, body: dict | None, idem: str | None = None,
                app_id: str = APP_ID, secret: str | None = None):
        raw = json.dumps(body or {}, ensure_ascii=False).encode("utf-8") if body is not None else b""
        ts = str(int(time.time()))
        nonce = secrets.token_hex(8)
        sig = security.sign_request(secret or self.secret, method, path, app_id, ts, nonce, raw)
        headers = {
            "X-App-Id": app_id, "X-Timestamp": ts, "X-Nonce": nonce,
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

    def _put(self, body: dict, idem: str, **kw):
        return self._signed("PUT", "/openapi/v1/patients", body, idem=idem, **kw)

    def _count(self, sql: str, params=()):
        with db.tx() as con:
            return con.execute(sql, params).fetchone()[0]

    def _patient(self, patient_ref: str):
        with db.tx() as con:
            row = con.execute("SELECT * FROM patients WHERE external_patient_ref=?",
                              (patient_ref,)).fetchone()
        return dict(row) if row else None

    def _audits(self, object_id) -> list[dict]:
        with db.tx() as con:
            rows = con.execute(
                "SELECT action, detail FROM audit_logs WHERE action='OPENAPI_PATIENT_UPSERT' "
                "AND object_id=? ORDER BY id", (str(object_id),)).fetchall()
        return [dict(r) for r in rows]

    # ---------------- H-01 ----------------

    def test_H01_新建患者档案(self):
        r = ref(101)
        before = self._count("SELECT COUNT(*) FROM patients")
        status, payload = self._put({
            "patientRef": r, "name": "建档患者甲", "gender": "男",
            "birthDate": "1962-05-12", "idHash": h64(11), "idLast4": "3621",
            "phoneHash": h64(12),
        }, idem="idem-h01")
        self.assertEqual(201, status, payload)
        data = payload["data"]
        self.assertTrue(data["created"], data)
        self.assertEqual(r, data["patientRef"])
        self.assertEqual(APP_ID, data["sourceAppId"])
        self.assertTrue(data["mrn"].startswith("P"), data)
        self.assertEqual(security.mask_name("建档患者甲"), data["nameMask"], "回执只给掩码姓名")

        self.assertEqual(before + 1, self._count("SELECT COUNT(*) FROM patients"))
        row = self._patient(r)
        self.assertEqual(APP_ID, row["source_app_id"])
        self.assertEqual("男", row["gender"])
        self.assertEqual("3621", row["id_last4"])
        self.assertEqual(h64(11), row["id_hash"])
        audits = self._audits(data["patientId"])
        self.assertEqual(1, len(audits), audits)
        self.assertIn("action=CREATE", audits[0]["detail"])
        self.assertNotIn("建档患者甲", audits[0]["detail"], "审计不得写姓名明文")

    # ---------------- H-02 ----------------

    def test_H02_同ref二次调用只补空字段(self):
        r = ref(102)
        status, first = self._put({"patientRef": r, "name": "补字段患者"}, idem="idem-h02a")
        self.assertEqual(201, status, first)
        pid = first["data"]["patientId"]

        status, second = self._put({
            "patientRef": r, "name": "补字段患者", "gender": "女",
            "birthDate": "1980-01-02", "idHash": h64(21), "idLast4": "0024",
        }, idem="idem-h02b")
        self.assertEqual(200, status, second)
        data = second["data"]
        self.assertFalse(data["created"], data)
        self.assertEqual(pid, data["patientId"], "同 ref 必须复用同一档案")
        self.assertEqual(["birthDate", "gender", "idHash", "idLast4"],
                         sorted(data["fieldsUpdated"]), data)
        self.assertEqual(1, self._count(
            "SELECT COUNT(*) FROM patients WHERE external_patient_ref=?", (r,)))

        row = self._patient(r)
        self.assertEqual("女", row["gender"])
        self.assertEqual("1980-01-02", row["birth_date"])

    # ---------------- H-03 ----------------

    def test_H03_非空值不被覆盖(self):
        r = ref(103)
        status, first = self._put({
            "patientRef": r, "name": "不覆盖患者", "gender": "男",
            "birthDate": "1970-03-04", "idHash": h64(31),
        }, idem="idem-h03a")
        self.assertEqual(201, status, first)

        status, second = self._put({
            "patientRef": r, "name": "不覆盖患者", "gender": "女",
            "birthDate": "1999-12-31", "idHash": h64(32),
        }, idem="idem-h03b")
        self.assertEqual(200, status, second)
        self.assertEqual([], second["data"]["fieldsUpdated"], second)

        row = self._patient(r)
        self.assertEqual("男", row["gender"], "非空性别不得被覆盖")
        self.assertEqual("1970-03-04", row["birth_date"], "非空生日不得被覆盖")
        self.assertEqual(h64(31), row["id_hash"], "非空证件哈希不得被覆盖")
        self.assertEqual("不覆盖患者", row["name"], "院内姓名不得被平台改名覆盖")

    # ---------------- H-04 ----------------

    def test_H04_跨应用占用被拒(self):
        r = ref(104)
        status, first = self._put({"patientRef": r, "name": "跨端患者"}, idem="idem-h04a")
        self.assertEqual(201, status, first)

        status, payload = self._put({"patientRef": r, "name": "跨端患者", "gender": "女"},
                                    idem="idem-h04b", app_id=OTHER_APP_ID,
                                    secret=OTHER_APP_SECRET)
        self.assertEqual(409, status, payload)
        self.assertEqual("PATIENT_REF_OWNED_BY_OTHER_APP", payload["code"], payload)
        row = self._patient(r)
        self.assertEqual(APP_ID, row["source_app_id"])
        self.assertEqual("未知", row["gender"], "被拒请求不得产生任何字段变更")

    # ---------------- H-05 ----------------

    def test_H05_ref格式非法(self):
        for bad in ("pat-XYZ", "pat-123", "PAT-" + "a" * 32, "pat-" + "A" * 32, "x"):
            status, payload = self._put({"patientRef": bad, "name": "非法患者"},
                                        idem="idem-h05-" + bad[:8])
            self.assertEqual(400, status, (bad, payload))
            self.assertEqual("PATIENT_REF_INVALID", payload["code"], (bad, payload))
        self.assertEqual(0, self._count(
            "SELECT COUNT(*) FROM patients WHERE name='非法患者'"))

    # ---------------- H-06 ----------------

    def test_H06_证件哈希格式非法(self):
        status, payload = self._put({"patientRef": ref(106), "name": "坏哈希",
                                     "idHash": "zz" * 32}, idem="idem-h06a")
        self.assertEqual(400, status, payload)
        self.assertEqual("VALIDATION_FAILED", payload["code"], payload)

        status, payload = self._put({"patientRef": ref(106), "name": "坏哈希",
                                     "idLast4": "0024"}, idem="idem-h06b")
        self.assertEqual(400, status, payload)
        self.assertEqual("VALIDATION_FAILED", payload["code"], payload)

    # ---------------- H-07 ----------------

    def test_H07_同证件哈希绑定另一ref被拒(self):
        status, first = self._put({"patientRef": ref(107), "name": "证件甲",
                                   "idHash": h64(71)}, idem="idem-h07a")
        self.assertEqual(201, status, first)
        status, payload = self._put({"patientRef": ref(108), "name": "证件乙",
                                     "idHash": h64(71)}, idem="idem-h07b")
        self.assertEqual(409, status, payload)
        self.assertEqual("ID_HASH_CONFLICT", payload["code"], payload)
        self.assertIsNone(self._patient(ref(108)), "冲突请求不得建档")

    # ---------------- H-08 ----------------

    def test_H08_受理带patientRef落在该患者(self):
        r = ref(109)
        status, created = self._put({"patientRef": r, "name": "受理患者"}, idem="idem-h08a")
        self.assertEqual(201, status, created)
        pid = created["data"]["patientId"]

        before_reg = self._count("SELECT COUNT(*) FROM registrations")
        status, payload = self._signed("POST", "/openapi/v1/appointments", {
            "appointmentId": "ap-h08", "slotId": "slot-h08",
            "patientName": "受理患者", "patientRef": r,
            "doctorId": "D001", "departmentId": "QK",
            "slotDate": "2026-12-02", "slotTime": "08:30",
        }, idem="idem-h08b")
        self.assertEqual(201, status, payload)
        data = payload["data"]
        self.assertEqual(pid, data["hisPatientId"], data)
        self.assertEqual(r, data["patientRef"], data)
        self.assertEqual(before_reg + 1, self._count("SELECT COUNT(*) FROM registrations"))
        with db.tx() as con:
            reg = con.execute("SELECT patient_id FROM registrations WHERE his_order_no=?",
                              (data["hisOrderNo"],)).fetchone()
        self.assertEqual(pid, reg["patient_id"], "挂号必须落在 patientRef 指向的档案")
        self.assertEqual(1, self._count(
            "SELECT COUNT(*) FROM patients WHERE external_patient_ref=?", (r,)),
            "受理不得因姓名再派生一条档案")

    def test_H08b_受理姓名与档案不一致(self):
        r = ref(110)
        self._put({"patientRef": r, "name": "档案姓名"}, idem="idem-h08c")
        before = self._count("SELECT COUNT(*) FROM registrations")
        status, payload = self._signed("POST", "/openapi/v1/appointments", {
            "appointmentId": "ap-h08b", "patientName": "别的姓名", "patientRef": r,
            "doctorId": "D001", "departmentId": "QK",
            "slotDate": "2026-12-02", "slotTime": "09:00",
        }, idem="idem-h08d")
        self.assertEqual(422, status, payload)
        self.assertEqual("PATIENT_NAME_MISMATCH", payload["code"], payload)
        self.assertEqual(before, self._count("SELECT COUNT(*) FROM registrations"),
                         "姓名不一致必须整单回滚")

    # ---------------- H-09 ----------------

    def test_H09_受理不带ref走姓名派生并标记(self):
        status, payload = self._signed("POST", "/openapi/v1/appointments", {
            "appointmentId": "ap-h09", "patientName": "派生患者乙",
            "doctorId": "D001", "departmentId": "QK",
            "slotDate": "2026-12-03", "slotTime": "08:30",
        }, idem="idem-h09")
        self.assertEqual(201, status, payload)
        data = payload["data"]
        self.assertEqual("", data["patientRef"], data)
        self.assertTrue(data["hisPatientId"] > 0, data)
        with db.tx() as con:
            row = con.execute("SELECT mrn FROM patients WHERE id=?", (data["hisPatientId"],)).fetchone()
            audit = con.execute(
                "SELECT detail FROM audit_logs WHERE action='OPENAPI_REG_CREATE' "
                "AND object_id=? ORDER BY id DESC LIMIT 1", (str(data["registrationNo"]),)).fetchone()
        self.assertTrue(row["mrn"].startswith("DEMO-"), row["mrn"])
        if audit is not None:
            self.assertIn("LEGACY_DERIVED", audit["detail"], audit["detail"])

    # ---------------- H-10 ----------------

    def test_H10_受理带非法ref不落任何行(self):
        before_orders = self._count("SELECT COUNT(*) FROM openapi_orders")
        before_reg = self._count("SELECT COUNT(*) FROM registrations")
        before_q = self._count("SELECT COUNT(*) FROM queue_tickets")
        status, payload = self._signed("POST", "/openapi/v1/appointments", {
            "appointmentId": "ap-h10", "patientName": "非法引用患者",
            "patientRef": "pat-bad", "doctorId": "D001", "departmentId": "QK",
            "slotDate": "2026-12-04", "slotTime": "08:30",
        }, idem="idem-h10")
        self.assertEqual(400, status, payload)
        self.assertEqual("PATIENT_REF_INVALID", payload["code"], payload)
        self.assertEqual(before_orders, self._count("SELECT COUNT(*) FROM openapi_orders"))
        self.assertEqual(before_reg, self._count("SELECT COUNT(*) FROM registrations"))
        self.assertEqual(before_q, self._count("SELECT COUNT(*) FROM queue_tickets"))

    # ---------------- H-11 ----------------

    def test_H11_幂等键重放不重复建档(self):
        r = ref(111)
        body = {"patientRef": r, "name": "重放患者", "gender": "男"}
        status, first = self._put(body, idem="idem-h11")
        self.assertEqual(201, status, first)
        audits_before = len(self._audits(first["data"]["patientId"]))

        status, second = self._put(body, idem="idem-h11")
        self.assertEqual(200, status, second)
        self.assertEqual(first["data"]["patientId"], second["data"]["patientId"])
        self.assertFalse(second["data"]["created"])
        self.assertEqual([], second["data"]["fieldsUpdated"])
        self.assertEqual(1, self._count(
            "SELECT COUNT(*) FROM patients WHERE external_patient_ref=?", (r,)))
        self.assertEqual(audits_before, len(self._audits(first["data"]["patientId"])),
                         "重放不得重复写审计")

        # 同幂等键换 ref → 409，防止一键多用
        status, payload = self._put({"patientRef": ref(112), "name": "另一个"}, idem="idem-h11")
        self.assertEqual(409, status, payload)
        self.assertEqual("IDEMPOTENCY_KEY_REUSE", payload["code"], payload)

    # ---------------- GET 联调 ----------------

    def test_GET患者仅返回掩码(self):
        r = ref(113)
        self._put({"patientRef": r, "name": "查询患者", "birthDate": "1990-01-01"},
                  idem="idem-get")
        status, payload = self._signed("GET", f"/openapi/v1/patients/{r}", None)
        self.assertEqual(200, status, payload)
        data = payload["data"]
        self.assertEqual(security.mask_name("查询患者"), data["nameMask"], data)
        self.assertNotIn("idHash", data)
        self.assertNotIn("phoneHash", data)

        status, payload = self._signed("GET", f"/openapi/v1/patients/{r}", None,
                                       app_id=OTHER_APP_ID, secret=OTHER_APP_SECRET)
        self.assertEqual(404, status, payload)
        self.assertEqual("NOT_FOUND", payload["code"], payload)


if __name__ == "__main__":
    unittest.main()
