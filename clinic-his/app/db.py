"""Clinic HIS 数据层：SQLite 连接、建表、事务与通用查询助手（纯标准库）。"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.environ.get("CLINIC_DATA_DIR") or os.path.join(PROJECT_ROOT, "data")
DB_PATH = os.environ.get("CLINIC_DB") or os.path.join(DATA_DIR, "clinic.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'CLINICAL'
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '女',
  role TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  dept_id INTEGER NOT NULL REFERENCES departments(id),
  license_no TEXT NOT NULL DEFAULT '',
  specialty TEXT NOT NULL DEFAULT '',
  phone_mask TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  hire_date TEXT NOT NULL DEFAULT '',
  pres_level INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  staff_id INTEGER REFERENCES staff(id),
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  password_changed_at TEXT,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS doctor_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_no TEXT NOT NULL UNIQUE,
  doctor_id INTEGER NOT NULL REFERENCES staff(id),
  dept_id INTEGER NOT NULL REFERENCES departments(id),
  work_date TEXT NOT NULL,
  period TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  booked INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN'
);
CREATE INDEX IF NOT EXISTS idx_slots_date ON doctor_slots(work_date, dept_id);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '女',
  birth_date TEXT NOT NULL DEFAULT '',
  id_last4 TEXT NOT NULL DEFAULT '',
  id_hash TEXT NOT NULL DEFAULT '',
  phone_mask TEXT NOT NULL DEFAULT '',
  phone_hash TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  allergy TEXT NOT NULL DEFAULT '',
  chronic_tags TEXT NOT NULL DEFAULT '[]',
  external_patient_ref TEXT,
  source_app_id TEXT,
  created_at TEXT NOT NULL,
  created_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name);

CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_no TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  slot_id INTEGER REFERENCES doctor_slots(id),
  doctor_id INTEGER NOT NULL REFERENCES staff(id),
  dept_id INTEGER NOT NULL REFERENCES departments(id),
  reg_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ONSITE',
  status TEXT NOT NULL DEFAULT 'BOOKED',
  his_order_no TEXT NOT NULL DEFAULT '',
  queue_no TEXT NOT NULL DEFAULT '',
  vitals_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by INTEGER,
  checked_in_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reg_date ON registrations(reg_date, status);

CREATE TABLE IF NOT EXISTS queue_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT NOT NULL,
  queue_date TEXT NOT NULL,
  dept_id INTEGER NOT NULL REFERENCES departments(id),
  registration_id INTEGER NOT NULL REFERENCES registrations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  status TEXT NOT NULL DEFAULT 'WAITING',
  called_at TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue ON queue_tickets(queue_date, dept_id, status);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_no TEXT NOT NULL UNIQUE,
  registration_id INTEGER NOT NULL UNIQUE REFERENCES registrations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES staff(id),
  dept_id INTEGER NOT NULL REFERENCES departments(id),
  visit_date TEXT NOT NULL,
  chief_complaint TEXT NOT NULL DEFAULT '',
  present_illness TEXT NOT NULL DEFAULT '',
  past_history TEXT NOT NULL DEFAULT '',
  physical_exam TEXT NOT NULL DEFAULT '',
  diagnosis_code TEXT NOT NULL DEFAULT '',
  diagnosis_name TEXT NOT NULL DEFAULT '',
  diagnosis_note TEXT NOT NULL DEFAULT '',
  treatment_advice TEXT NOT NULL DEFAULT '',
  allergy_history TEXT NOT NULL DEFAULT '',
  auxiliary_exam TEXT NOT NULL DEFAULT '',
  vitals_json TEXT NOT NULL DEFAULT '',
  signed_by TEXT NOT NULL DEFAULT '',
  signed_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  version INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(visit_date, doctor_id);

CREATE TABLE IF NOT EXISTS emr_amendments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  amended_by INTEGER NOT NULL,
  amended_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visit_diagnoses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0,
  suspected INTEGER NOT NULL DEFAULT 0,
  sort_no INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visit_diag ON visit_diagnoses(visit_id);

CREATE TABLE IF NOT EXISTS beds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bed_no TEXT NOT NULL UNIQUE,
  zone TEXT NOT NULL DEFAULT '观察室',
  kind TEXT NOT NULL DEFAULT 'BED',
  status TEXT NOT NULL DEFAULT 'FREE',
  current_stay_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bed_stays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_no TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  visit_id INTEGER,
  bed_id INTEGER NOT NULL REFERENCES beds(id),
  nursing_level TEXT NOT NULL DEFAULT '',
  diet TEXT NOT NULL DEFAULT '',
  diagnosis TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'IN',
  in_at TEXT NOT NULL,
  out_at TEXT NOT NULL DEFAULT '',
  out_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stay_bed ON bed_stays(bed_id, status);

CREATE TABLE IF NOT EXISTS nursing_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES bed_stays(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  order_type TEXT NOT NULL DEFAULT 'OBSERVE',
  content TEXT NOT NULL,
  dose TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  ordered_by INTEGER,
  ordered_at TEXT NOT NULL,
  executed_by INTEGER,
  executed_at TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_nursing_order ON nursing_orders(stay_id, status);

CREATE TABLE IF NOT EXISTS nursing_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  stay_id INTEGER,
  record_type TEXT NOT NULL DEFAULT 'VITALS',
  temperature REAL,
  pulse INTEGER,
  respiration INTEGER,
  systolic INTEGER,
  diastolic INTEGER,
  spo2 INTEGER,
  note TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nursing_record ON nursing_records(patient_id, recorded_at);

CREATE TABLE IF NOT EXISTS drugs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '盒',
  price REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  alert_stock INTEGER NOT NULL DEFAULT 10,
  category TEXT NOT NULL DEFAULT '口服',
  antibiotic_level TEXT NOT NULL DEFAULT '',
  controlled INTEGER NOT NULL DEFAULT 0,
  allergy_tags TEXT NOT NULL DEFAULT '',
  default_route TEXT NOT NULL DEFAULT '',
  default_freq TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rx_no TEXT NOT NULL UNIQUE,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'SUBMITTED',
  total_amount REAL NOT NULL DEFAULT 0,
  reviewer_id INTEGER,
  review_comment TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  dispensed_by INTEGER,
  dispensed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prescription_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id),
  drug_id INTEGER NOT NULL REFERENCES drugs(id),
  drug_name TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '',
  dosage TEXT NOT NULL,
  frequency TEXT NOT NULL,
  days INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charge_no TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  visit_id INTEGER,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'UNPAID',
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id INTEGER,
  cashier_id INTEGER,
  paid_at TEXT,
  void_reason TEXT NOT NULL DEFAULT '',
  refunded_at TEXT NOT NULL DEFAULT '',
  refund_reason TEXT NOT NULL DEFAULT '',
  refunded_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charges_status ON charges(status, category);

-- P0-1 演示支付：平台支付动作的幂等审计（appId+Idempotency-Key 只允许对应一笔账单）。
-- 不保存任何支付凭证/卡号；source 仅 DEMO/SANDBOX，演示账单不是真实收费凭证。
CREATE TABLE IF NOT EXISTS openapi_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charge_no TEXT NOT NULL REFERENCES charges(charge_no),
  app_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  amount REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'DEMO',
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(app_id, idem_key)
);

CREATE TABLE IF NOT EXISTS lab_items (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL,
  critical_low REAL,
  critical_high REAL
);

CREATE TABLE IF NOT EXISTS lab_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES staff(id),
  item_code TEXT NOT NULL,
  item_name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'APPLIED',
  sampled_at TEXT,
  report_findings TEXT NOT NULL DEFAULT '',
  report_conclusion TEXT NOT NULL DEFAULT '',
  abnormal INTEGER NOT NULL DEFAULT 0,
  critical INTEGER NOT NULL DEFAULT 0,
  reported_by INTEGER,
  reported_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lab_status ON lab_orders(status);

-- P0-2 检查预约（演示排期）：平台按 requestNo 建单，HIS 侧按 item+slot 防重复占用。
-- 只做预约占位，不生成 lab_orders；真实到院后由医技按现有流程建检查单。
CREATE TABLE IF NOT EXISTS openapi_exam_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_order_no TEXT NOT NULL UNIQUE,
  request_no TEXT NOT NULL,
  app_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  item_code TEXT NOT NULL,
  item_name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  slot_key TEXT NOT NULL,
  slot_date TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'BOOKED',
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancel_reason TEXT NOT NULL DEFAULT '',
  UNIQUE(app_id, request_no),
  UNIQUE(app_id, idem_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_openapi_exam_slot
  ON openapi_exam_orders(item_code, slot_key) WHERE status='BOOKED';
CREATE INDEX IF NOT EXISTS idx_openapi_exam_status ON openapi_exam_orders(status,slot_date);

CREATE TABLE IF NOT EXISTS ph_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  visit_id INTEGER,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  done_by INTEGER,
  done_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ph_status ON ph_tasks(status, due_at);

CREATE TABLE IF NOT EXISTS icd10 (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  chronic INTEGER NOT NULL DEFAULT 0,
  infectious INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id INTEGER,
  username TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'OK',
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);

CREATE TABLE IF NOT EXISTS openapi_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL UNIQUE,
  app_secret TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  rotated_at TEXT
);

CREATE TABLE IF NOT EXISTS openapi_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  his_order_no TEXT NOT NULL UNIQUE,
  idem_key TEXT NOT NULL,
  app_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  slot_id TEXT NOT NULL DEFAULT '',
  patient_name_mask TEXT NOT NULL DEFAULT '',
  patient_name_hash TEXT NOT NULL DEFAULT '',
  doctor_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACCEPTED',
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancel_reason TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_openapi_orders_app_idem ON openapi_orders(app_id, idem_key);
CREATE INDEX IF NOT EXISTS idx_openapi_orders_app_appt ON openapi_orders(app_id, appointment_id);

-- 患者建档幂等台账（2026-11-27）：同 appId + 同 Idempotency-Key 重放同一 patientRef 时
-- 返回同一档案且不重复审计。ref 自身幂等，此表只负责「重放」这一层语义。
CREATE TABLE IF NOT EXISTS openapi_patient_idem (
  app_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  patient_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, idem_key)
);

CREATE TABLE IF NOT EXISTS openapi_nonces (
  nonce TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  ts REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
"""


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def now_after(hours: float = 0, days: float = 0) -> str:
    return (datetime.now() + timedelta(hours=hours, days=days)).strftime("%Y-%m-%d %H:%M:%S")


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=10000")
    con.execute("PRAGMA foreign_keys=ON")
    return con


@contextmanager
def tx():
    """事务：正常提交，异常回滚。"""
    con = connect()
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def query(sql: str, params: tuple = (), one: bool = False):
    con = connect()
    try:
        rows = con.execute(sql, params).fetchall()
        items = [dict(r) for r in rows]
        return (items[0] if items else None) if one else items
    finally:
        con.close()


def insert(sql: str, params: tuple = ()) -> int:
    with tx() as con:
        cur = con.execute(sql, params)
        return int(cur.lastrowid)


def execute(sql: str, params: tuple = ()) -> int:
    with tx() as con:
        cur = con.execute(sql, params)
        return cur.rowcount


def next_sequence(con: sqlite3.Connection, name: str) -> int:
    """进程事务内自增序列（用于单号生成）。"""
    row = con.execute("SELECT value FROM sequences WHERE name=?", (name,)).fetchone()
    if row is None:
        con.execute("INSERT INTO sequences(name, value) VALUES (?, 1)", (name,))
        return 1
    value = int(row["value"]) + 1
    con.execute("UPDATE sequences SET value=? WHERE name=?", (value, name))
    return value


def ensure_column(con: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    """存量库补列：缺列才 ALTER TABLE ADD COLUMN（ddl 为列定义，不含列名）。"""
    cols = {row["name"] for row in con.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


# 存量库需补齐的列（新库由 SCHEMA 的 CREATE 定义直接建成）
VISIT_MIGRATIONS = [
    ("allergy_history", "TEXT NOT NULL DEFAULT ''"),
    ("auxiliary_exam", "TEXT NOT NULL DEFAULT ''"),
    ("vitals_json", "TEXT NOT NULL DEFAULT ''"),
    ("signed_by", "TEXT NOT NULL DEFAULT ''"),
    ("signed_at", "TEXT NOT NULL DEFAULT ''"),
]

# 药品过敏标签（| 分隔）用于处方前置过敏冲突校验，存量库补齐
DRUG_MIGRATIONS = [
    ("allergy_tags", "TEXT NOT NULL DEFAULT ''"),
    ("default_route", "TEXT NOT NULL DEFAULT ''"),
    ("default_freq", "TEXT NOT NULL DEFAULT ''"),
]

# 收费退费留痕列（存量库补齐）
CHARGE_MIGRATIONS = [
    ("refunded_at", "TEXT NOT NULL DEFAULT ''"),
    ("refund_reason", "TEXT NOT NULL DEFAULT ''"),
    ("refunded_by", "INTEGER"),
    # P0-1 演示账单归属：只标识由哪个 OpenAPI 应用创建，不改变员工端收费语义
    ("openapi_app_id", "TEXT"),
    ("openapi_idem_key", "TEXT"),
]

# 危急值阈值（存量库补齐）
LAB_ITEM_MIGRATIONS = [
    ("critical_low", "REAL"),
    ("critical_high", "REAL"),
]

# 报告危急值标记（存量库补齐）
LAB_ORDER_MIGRATIONS = [
    ("critical", "INTEGER NOT NULL DEFAULT 0"),
]

# 患者主索引关联列（2026-11-27，P3 病历/报告前置）：
# external_patient_ref 由平台下发（pat-<uuid>），source_app_id 记录建档 appId 防跨租户占用。
# 新库由 SCHEMA 的 CREATE 直接建成，存量库靠 ensure_column 补。
PATIENT_MIGRATIONS = [
    ("external_patient_ref", "TEXT"),
    ("source_app_id", "TEXT"),
]


def _migrate_openapi_orders(con: sqlite3.Connection) -> None:
    """把旧版全局 idem_key 唯一约束迁移为 (app_id, idem_key) 复合唯一。

    旧约束会让 A 应用占用 B 应用的幂等键，造成跨租户抢单/阻断；
    这里重建表，保留全部历史单据。
    """
    indexes = con.execute("PRAGMA index_list('openapi_orders')").fetchall()
    legacy = False
    for idx in indexes:
        if not idx["unique"]:
            continue
        cols = [r["name"] for r in con.execute(f"PRAGMA index_info('{idx['name']}')").fetchall()]
        if cols == ["idem_key"]:
            legacy = True
            break
    if not legacy:
        return

    con.execute("DROP INDEX IF EXISTS uq_openapi_orders_app_idem")
    con.execute("DROP INDEX IF EXISTS idx_openapi_orders_app_appt")
    con.execute("ALTER TABLE openapi_orders RENAME TO openapi_orders_legacy")
    con.execute("""
        CREATE TABLE openapi_orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          his_order_no TEXT NOT NULL UNIQUE,
          idem_key TEXT NOT NULL,
          app_id TEXT NOT NULL,
          appointment_id TEXT NOT NULL,
          slot_id TEXT NOT NULL DEFAULT '',
          patient_name_mask TEXT NOT NULL DEFAULT '',
          patient_name_hash TEXT NOT NULL DEFAULT '',
          doctor_id TEXT NOT NULL,
          department_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ACCEPTED',
          created_at TEXT NOT NULL,
          cancelled_at TEXT,
          cancel_reason TEXT NOT NULL DEFAULT ''
        )
    """)
    con.execute(
        "INSERT INTO openapi_orders(id,his_order_no,idem_key,app_id,appointment_id,slot_id,"
        "patient_name_mask,patient_name_hash,doctor_id,department_id,status,created_at,"
        "cancelled_at,cancel_reason) "
        "SELECT id,his_order_no,idem_key,app_id,appointment_id,slot_id,patient_name_mask,"
        "patient_name_hash,doctor_id,department_id,status,created_at,cancelled_at,cancel_reason "
        "FROM openapi_orders_legacy")
    con.execute("DROP TABLE openapi_orders_legacy")
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_openapi_orders_app_idem "
                "ON openapi_orders(app_id, idem_key)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_openapi_orders_app_appt "
                "ON openapi_orders(app_id, appointment_id)")
    con.execute("DELETE FROM sqlite_sequence WHERE name IN ('openapi_orders','openapi_orders_legacy')")
    max_id = con.execute("SELECT COALESCE(MAX(id),0) AS m FROM openapi_orders").fetchone()["m"]
    con.execute("INSERT INTO sqlite_sequence(name,seq) VALUES ('openapi_orders',?)", (max_id,))


def init_db() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    con = connect()
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript(SCHEMA)
        _migrate_openapi_orders(con)
        for column, ddl in VISIT_MIGRATIONS:
            ensure_column(con, "visits", column, ddl)
        for column, ddl in DRUG_MIGRATIONS:
            ensure_column(con, "drugs", column, ddl)
        for column, ddl in CHARGE_MIGRATIONS:
            ensure_column(con, "charges", column, ddl)
        # P0-1：OpenAPI 演示账单的幂等防线（存量库补列后建索引；部分唯一索引避免影响员工端历史收费）
        con.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_charges_openapi_idem "
            "ON charges(openapi_app_id, openapi_idem_key) "
            "WHERE openapi_app_id IS NOT NULL AND openapi_idem_key IS NOT NULL"
        )
        con.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_charges_openapi_ref "
            "ON charges(openapi_app_id, ref_type, ref_id) "
            "WHERE openapi_app_id IS NOT NULL AND ref_id IS NOT NULL "
            "AND status IN ('UNPAID','PAID')"
        )
        for column, ddl in LAB_ITEM_MIGRATIONS:
            ensure_column(con, "lab_items", column, ddl)
        for column, ddl in LAB_ORDER_MIGRATIONS:
            ensure_column(con, "lab_orders", column, ddl)
        # 患者主索引（P3 前置）：补列 + 外部就诊人引用唯一（空值不占位，历史派生档案不受影响）
        for column, ddl in PATIENT_MIGRATIONS:
            ensure_column(con, "patients", column, ddl)
        con.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_patients_external_ref "
            "ON patients(external_patient_ref) "
            "WHERE external_patient_ref IS NOT NULL AND external_patient_ref <> ''"
        )
        con.commit()
    finally:
        con.close()
