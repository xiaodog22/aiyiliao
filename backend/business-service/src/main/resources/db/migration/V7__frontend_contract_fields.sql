-- =====================================================================
-- V7__frontend_contract_fields.sql —— 前端数据依赖补齐（2026-10-17）
-- 事实源：docs/前端数据依赖与后端接口需求_20261017.md §3/§6
-- 约定：utf8mb4；时间 UTC（DATETIME(3)）；只加列/索引，不改既有列语义。
-- 说明：
--   1) departments：补结构化楼层（building/floor/area/room_no）与医院名；
--      location 保留为面向用户的整串展示（"门诊楼 1F 东区"），两者不互斥。
--   2) appointments：补 location/hospital_name 快照（下单时冗余自科室，
--      科室搬迁不影响历史记录）；symptom_summary 已存在（V1），此处不重复加。
--   3) health_records：补 source/doctor_name/abnormal（abnormal NULL = 未判定，
--      客户端据此不渲染异常标记，不用 false 冒充"已判定正常"）。
--   4) family_members：补 gender/phone_masked（脱敏展示号，明文手机号仍只存哈希）。
--   5) contents：补 content_type/cover_url/video_url/duration_sec/read_time_sec。
-- 兼容：H2 MySQL 模式（测试/迁移演练）逐列 ALTER，不用 MySQL 多列合并语法。
-- =====================================================================

-- ---------- 1. departments：结构化位置 ----------
ALTER TABLE departments ADD COLUMN hospital_name VARCHAR(60) NULL;
ALTER TABLE departments ADD COLUMN building VARCHAR(40) NULL;
ALTER TABLE departments ADD COLUMN floor VARCHAR(20) NULL;
ALTER TABLE departments ADD COLUMN area VARCHAR(40) NULL;
ALTER TABLE departments ADD COLUMN room_no VARCHAR(20) NULL;

-- 历史行回填：location 形如 "门诊楼 2F 东区" → building/floor/area 可解析部分先留空，
-- 由调用方（dev 种子 / 运营后台）补齐；hospital_name 按 hospital_id 归一（与 CatalogService 口径一致）。
UPDATE departments SET hospital_name = '示例互联网医院' WHERE hospital_name IS NULL;

-- ---------- 2. appointments：就诊地点快照 ----------
ALTER TABLE appointments ADD COLUMN location VARCHAR(80) NULL;
ALTER TABLE appointments ADD COLUMN hospital_name VARCHAR(60) NULL;

-- 已有预约按科室当前值回填（仅 NULL 行；不覆盖后续快照）。
UPDATE appointments
SET location = (SELECT d.location FROM departments d WHERE d.id = appointments.department_id)
WHERE location IS NULL;

UPDATE appointments
SET hospital_name = (SELECT d.hospital_name FROM departments d WHERE d.id = appointments.department_id)
WHERE hospital_name IS NULL;

-- ---------- 3. health_records：来源 / 医生 / 异常标记 ----------
ALTER TABLE health_records ADD COLUMN source VARCHAR(120) NULL;
ALTER TABLE health_records ADD COLUMN doctor_name VARCHAR(40) NULL;
ALTER TABLE health_records ADD COLUMN abnormal TINYINT(1) NULL;

-- ---------- 4. family_members：性别 / 脱敏手机号 ----------
ALTER TABLE family_members ADD COLUMN gender VARCHAR(8) NULL;
ALTER TABLE family_members ADD COLUMN phone_masked VARCHAR(20) NULL;

-- ---------- 5. contents：内容类型 / 封面 / 视频 / 时长 ----------
ALTER TABLE contents ADD COLUMN content_type VARCHAR(12) NOT NULL DEFAULT 'ARTICLE';
ALTER TABLE contents ADD COLUMN cover_url VARCHAR(255) NULL;
ALTER TABLE contents ADD COLUMN video_url VARCHAR(255) NULL;
ALTER TABLE contents ADD COLUMN duration_sec INT NULL;
ALTER TABLE contents ADD COLUMN read_time_sec INT NULL;

-- ---------- 6. home_block_config：首页服务入口配置化（运营可调顺序，不必发版） ----------
-- 真源唯一：前端 SERVICES 的 key 与 item_code 对齐；QUICK_SERVICES 块只下发 enabled=1 的条目。
CREATE TABLE home_block_config (
    id          VARCHAR(64)  NOT NULL,
    block_kind  VARCHAR(32)  NOT NULL,
    item_code   VARCHAR(40)  NOT NULL,
    label       VARCHAR(20)  NOT NULL,
    icon_key    VARCHAR(128) NULL,
    sort_order  INT          NOT NULL DEFAULT 0,
    enabled     TINYINT(1)   NOT NULL DEFAULT 1,
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at  DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_home_block_item (block_kind, item_code)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 8 项与前端 SERVICES 的 key 一一对应（triage/doctor/dept/archive/checkup/care/advice/more）。
INSERT INTO home_block_config (id, block_kind, item_code, label, icon_key, sort_order, enabled) VALUES
  ('hb-quick-triage',  'QUICK_SERVICES', 'triage',  '智能导诊', 'svc-triage',  1, 1),
  ('hb-quick-doctor',  'QUICK_SERVICES', 'doctor',  '找医生',   'svc-doctor',  2, 1),
  ('hb-quick-dept',    'QUICK_SERVICES', 'dept',    '找科室',   'svc-dept',    3, 1),
  ('hb-quick-archive', 'QUICK_SERVICES', 'archive', '健康档案', 'svc-archive', 4, 1),
  ('hb-quick-checkup', 'QUICK_SERVICES', 'checkup', '体检服务', 'svc-checkup', 5, 1),
  ('hb-quick-care',    'QUICK_SERVICES', 'care',    '居家护理', 'svc-care',    6, 1),
  ('hb-quick-advice',  'QUICK_SERVICES', 'advice',  '健康咨询', 'svc-advice',  7, 1),
  ('hb-quick-more',    'QUICK_SERVICES', 'more',    '更多服务', 'svc-more',    8, 1);
