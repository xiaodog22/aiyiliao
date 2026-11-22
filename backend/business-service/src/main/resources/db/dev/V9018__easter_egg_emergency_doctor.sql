-- =====================================================================
-- V9018__easter_egg_emergency_doctor.sql —— 演示彩蛋：急诊医生马义童（2026-11-22）
--
-- 背景：clinic-his 侧已落「急诊科 JZ / D010 马义童 / 账号 13900139000」；
--       小程序医生端的可见性由 doctors.user_id（任职关系）决定，HIS 有账号不等于
--       平台医生端可见 → 这里补一条平台医生档案 + 独立 dev 账号并回填任职。
--
-- 口径：
--   · 医生 ID `doc-emergency-1`，挂 `dep-emergency`（V9003 已建，状态 INACTIVE：
--     急诊绿色通道不参与门诊预约，故 /departments 目录不返回该科室）。
--     → 结论：马义童在医生端可见/可登录，患者端**不可**预约急诊号；若业务确认要放开预约，
--       单独把 dep-emergency.status 改 ACTIVE，本迁移不用动。
--   · 账号沿用 V9017 规则：user_id = 'u-doc-' || doctor_id，openid = 'dev-doc-' || doctor_id，
--     与 dev 登录码 `dev-doctor-doc-emergency-1` 一一对应（见 DevWechatSessionProvider）。
--   · employee_no 记 HIS 工号 13900139000（只读展示用；dev 档无密码体系，不做手机号绑定）。
--   · 幂等：INSERT ... ON DUPLICATE KEY UPDATE + INSERT IGNORE + 定向 UPDATE。
--
-- 仅 dev profile 加载；生产由院方 HR/账号系统登记，不跑本迁移。
-- =====================================================================

-- ① 急诊科（已存在则只同步名称/状态，避免误改成可预约）
INSERT INTO departments (id, hospital_id, hospital_name, name, location, building, floor, area, room_no,
                         description, icon_key, sort_order, status)
VALUES ('dep-emergency', 'hosp-wechar-dev', '示例互联网医院', '急诊科', '门诊楼 1F 急诊区',
        '门诊楼', '1F', '急诊区', NULL,
        '胸痛、卒中、呼吸困难、大出血、意识障碍等急危重症的绿色通道（直接前往，不预约）',
        'dept-emergency', 99, 'INACTIVE')
ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = CURRENT_TIMESTAMP(3);

-- ② 医生档案（急诊科，主治医师）
INSERT INTO doctors (id, department_id, name, title, specialties_json, introduction, status, employee_no)
VALUES ('doc-emergency-1', 'dep-emergency', '马义童', '主治医师',
        '["急诊急救","创伤处置","高热与急腹症首诊"]',
        '急诊科主治医师，长期负责急诊首诊分流、创伤处置与急危重症识别（演示角色）。',
        'ACTIVE', '13900139000')
ON DUPLICATE KEY UPDATE department_id = VALUES(department_id), name = VALUES(name),
                        title = VALUES(title), specialties_json = VALUES(specialties_json),
                        introduction = VALUES(introduction), employee_no = VALUES(employee_no),
                        updated_at = CURRENT_TIMESTAMP(3);

-- ③ 独立登录账号（与医生 ID 稳定对应，不复用患者账号）
INSERT IGNORE INTO users
    (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-doc-doc-emergency-1', 'dev-doc-doc-emergency-1', NULL, NULL, 0, '马义童', 'ACTIVE', 1,
        '2026-01-01 00:00:00');

-- ④ 回填任职关系（只补空值，避免覆盖人工登记）
UPDATE doctors d
JOIN users u ON u.wechat_openid = 'dev-doc-doc-emergency-1'
SET d.user_id = u.id,
    d.updated_at = CURRENT_TIMESTAMP(3)
WHERE d.id = 'doc-emergency-1' AND d.user_id IS NULL;

-- ⑤ 自检（人工执行，不参与迁移）：
--   SELECT d.id, d.name, d.department_id, d.employee_no, d.user_id, u.wechat_openid
--   FROM doctors d LEFT JOIN users u ON u.id = d.user_id
--   WHERE d.id = 'doc-emergency-1';     -- 期望 user_id 非空、openid=dev-doc-doc-emergency-1
