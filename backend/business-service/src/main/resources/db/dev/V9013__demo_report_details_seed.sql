-- =====================================================================
-- V9013__demo_report_details_seed.sql —— 演示账号（u-dev-user-1）报告明细补齐（2026-11-14）
-- ⚠️ 仅 dev profile 加载（classpath:db/dev），不进入生产迁移。
-- ⚠️ 全部为开发环境模拟数据：模拟机构、模拟患者、模拟医师、模拟数值，
--    不含真实患者身份、真实医师签名或医院公章。
--
-- 为什么需要这一版（对应缺陷 D-05）：
--   u-dev-user-1 有 3 条 category=EXAM、report_status=READY 的健康档案，但
--   health_report_details 没有对应行；而 GET /api/v1/reports 的列表 SQL 是
--   `JOIN health_report_details`，于是「健康档案」显示 3 份已出报告、
--   「报告查询」却是空态 —— 两个页面同一批数据给出相反结论。
--   本脚本补 3 份 READY 明细（含分组与项目），并补 REVIEWING / PENDING 各 1 份，
--   让报告详情页的四种状态（已出/待审核/待出结果/无权限或已删除）都可实测。
--
-- 幂等：固定主键 + ON DUPLICATE KEY UPDATE id = id（no-op），可重复执行。
-- 前置：V27__health_report_structure.sql 已建表；V9010 已建 mi-v9010-* 演示机构。
-- =====================================================================

-- ---------- 1. READY ①：血常规（LAB）----------
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-demo-cbc', 'hr-demo-exam-cbc', 'u-dev-user-1', 'DEMO-CBC-20261020', 'LAB', 'mi-v9010-lab-01', NULL, '检验科', '张三', 'MALE', '64岁', 'DEMO-OP-CBC', NULL, '健康体检（模拟）', '演示申请医师（模拟）', '静脉血', 'DEMO-SP-CBC', '2026-10-20 08:10:00.000', '2026-10-20 08:35:00.000', '2026-10-20 09:00:00.000', '2026-10-20 09:20:00.000', '演示检验员（模拟）', '演示审核员（模拟）', '模拟方法学（非真实检测）', '演示设备（模拟）', NULL, NULL, '血常规各项指标均在参考区间内，未见明显异常。演示数据 · 非真实医疗报告 · 不构成诊断依据', '保持规律作息与均衡饮食；如有发热、乏力等症状请及时就诊。演示数据 · 非真实医疗报告', 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 不构成诊断依据', 1)
  ON DUPLICATE KEY UPDATE id = id;

INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-demo-cbc-1', 'hrd-demo-cbc', 'u-dev-user-1', 'CBC', '血细胞分析', 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-cbc-1-1', 'hrd-demo-cbc', 'hrs-demo-cbc-1', 'u-dev-user-1', 'DEMO-WBC', '白细胞计数', 6.2, NULL, '10^9/L', 3.5, 9.5, '3.5–9.5', 'NORMAL', NULL, NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-cbc-1-2', 'hrd-demo-cbc', 'hrs-demo-cbc-1', 'u-dev-user-1', 'DEMO-RBC', '红细胞计数', 4.6, NULL, '10^12/L', 4.3, 5.8, '4.3–5.8', 'NORMAL', NULL, NULL, 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-cbc-1-3', 'hrd-demo-cbc', 'hrs-demo-cbc-1', 'u-dev-user-1', 'DEMO-HGB', '血红蛋白', 138, NULL, 'g/L', 130, 175, '130–175', 'NORMAL', NULL, NULL, 30)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-cbc-1-4', 'hrd-demo-cbc', 'hrs-demo-cbc-1', 'u-dev-user-1', 'DEMO-PLT', '血小板计数', 210, NULL, '10^9/L', 125, 350, '125–350', 'NORMAL', NULL, NULL, 40)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-cbc-1-5', 'hrd-demo-cbc', 'hrs-demo-cbc-1', 'u-dev-user-1', 'DEMO-NEUT', '中性粒细胞百分比', 58.0, NULL, '%', 40, 75, '40–75', 'NORMAL', NULL, NULL, 50)
  ON DUPLICATE KEY UPDATE id = id;

-- ---------- 2. READY ②：胸部 CT（IMAGING，以影像所见/印象为主，不列检验项目）----------
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-demo-ct', 'hr-demo-exam-ct', 'u-dev-user-1', 'DEMO-CT-20261025', 'IMAGING', 'mi-v9010-img-01', NULL, '放射科', '张三', 'MALE', '64岁', 'DEMO-OP-CT', NULL, '胸部不适待查（模拟）', '演示申请医师（模拟）', NULL, 'DEMO-SP-CT', '2026-10-25 15:00:00.000', '2026-10-25 15:10:00.000', '2026-10-25 15:25:00.000', '2026-10-25 15:40:00.000', '演示技师（模拟）', '演示审核员（模拟）', '胸部 CT 平扫（模拟）', '演示 CT 设备（模拟）', '双肺纹理清晰，未见实质性病变；纵隔未见肿大淋巴结；心影大小形态正常（模拟描述）。', '胸部 CT 平扫未见明显异常（模拟印象）。', '影像所见与诊断意见仅供界面演示，不构成诊断依据。演示数据 · 非真实医疗报告', '如出现持续咳嗽、胸痛或呼吸困难，请及时线下就诊。演示数据 · 非真实医疗报告', 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 不构成诊断依据', 1)
  ON DUPLICATE KEY UPDATE id = id;

-- ---------- 3. READY ③：年度体检（CHECKUP，三个分组）----------
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-demo-annual', 'hr-demo-exam-annual', 'u-dev-user-1', 'DEMO-CHECKUP-20261028', 'CHECKUP', 'mi-v9010-check-01', NULL, '体检科', '张三', 'MALE', '64岁', 'DEMO-OP-CHECKUP', NULL, '年度健康体检（模拟）', '演示申请医师（模拟）', NULL, 'DEMO-SP-CHECKUP', '2026-10-28 07:50:00.000', '2026-10-28 08:00:00.000', '2026-10-28 08:20:00.000', '2026-10-28 08:30:00.000', '演示检验员（模拟）', '演示审核员（模拟）', '常规体检项目（模拟）', '演示设备（模拟）', NULL, NULL, '血压、空腹血糖、血脂四项、肝功能均在参考区间内。演示数据 · 非真实医疗报告 · 不构成诊断依据', '建议保持规律运动与低盐低脂饮食，每年复查一次。演示数据 · 非真实医疗报告', 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 不构成诊断依据', 1)
  ON DUPLICATE KEY UPDATE id = id;

INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-demo-annual-1', 'hrd-demo-annual', 'u-dev-user-1', 'VITAL', '一般检查', 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-annual-1-1', 'hrd-demo-annual', 'hrs-demo-annual-1', 'u-dev-user-1', 'DEMO-SBP', '收缩压', 128, NULL, 'mmHg', 90, 139, '90–139', 'NORMAL', NULL, NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-annual-1-2', 'hrd-demo-annual', 'hrs-demo-annual-1', 'u-dev-user-1', 'DEMO-DBP', '舒张压', 82, NULL, 'mmHg', 60, 89, '60–89', 'NORMAL', NULL, NULL, 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-annual-1-3', 'hrd-demo-annual', 'hrs-demo-annual-1', 'u-dev-user-1', 'DEMO-BMI', '体质指数', 23.2, NULL, 'kg/m²', 18.5, 23.9, '18.5–23.9', 'NORMAL', NULL, NULL, 30)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-demo-annual-2', 'hrd-demo-annual', 'u-dev-user-1', 'LIPID', '血脂四项', 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-annual-2-1', 'hrd-demo-annual', 'hrs-demo-annual-2', 'u-dev-user-1', 'DEMO-TC', '总胆固醇', 4.6, NULL, 'mmol/L', 0, 5.2, '<5.2', 'NORMAL', NULL, NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-annual-2-2', 'hrd-demo-annual', 'hrs-demo-annual-2', 'u-dev-user-1', 'DEMO-LDL', '低密度脂蛋白胆固醇', 2.9, NULL, 'mmol/L', 0, 3.4, '<3.4', 'NORMAL', NULL, NULL, 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-annual-2-3', 'hrd-demo-annual', 'hrs-demo-annual-2', 'u-dev-user-1', 'DEMO-TG', '甘油三酯', 1.2, NULL, 'mmol/L', 0, 1.7, '<1.7', 'NORMAL', NULL, NULL, 30)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-demo-annual-3', 'hrd-demo-annual', 'u-dev-user-1', 'GLU', '血糖', 30)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-demo-annual-3-1', 'hrd-demo-annual', 'hrs-demo-annual-3', 'u-dev-user-1', 'DEMO-GLU', '空腹血糖', 5.4, NULL, 'mmol/L', 3.9, 6.1, '3.9–6.1', 'NORMAL', NULL, NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;

-- ---------- 4. REVIEWING：待审核（有明细元信息、无项目明细，验证门禁不泄露结果）----------
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-demo-exam-mri-review', 'u-dev-user-1', NULL, 'EXAM', '头颅 MRI 平扫报告（待审核）', '影像已采集，报告待审核出具。演示数据 · 非真实医疗报告', '2026-11-13 10:20:00.000', 'DEMO_SEED_V9013', '演示医师（模拟）', NULL, 'REVIEWING', '市第一人民医院', 1, NULL, NULL, '2026-11-13 10:20:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-demo-mri-review', 'hr-demo-exam-mri-review', 'u-dev-user-1', 'DEMO-MRI-20261113', 'IMAGING', 'mi-v9010-img-01', NULL, '放射科', '张三', 'MALE', '64岁', 'DEMO-OP-MRI', NULL, '头晕待查（模拟）', '演示申请医师（模拟）', NULL, 'DEMO-SP-MRI', '2026-11-13 10:00:00.000', '2026-11-13 10:05:00.000', '2026-11-13 10:15:00.000', NULL, '演示技师（模拟）', NULL, '头颅 MRI 平扫（模拟）', '演示 MRI 设备（模拟）', NULL, NULL, NULL, NULL, 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 审核中不展示结果', 1)
  ON DUPLICATE KEY UPDATE id = id;

-- ---------- 5. PENDING：待出结果（同上，仅元信息）----------
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-demo-exam-us-pending', 'u-dev-user-1', NULL, 'EXAM', '甲状腺超声检查报告（待出结果）', '检查已完成，结果待出具。演示数据 · 非真实医疗报告', '2026-11-14 09:10:00.000', 'DEMO_SEED_V9013', '演示医师（模拟）', NULL, 'PENDING', '市第一人民医院', 1, NULL, NULL, '2026-11-14 09:10:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-demo-us-pending', 'hr-demo-exam-us-pending', 'u-dev-user-1', 'DEMO-US-20261114', 'IMAGING', 'mi-v9010-img-01', NULL, '超声科', '张三', 'MALE', '64岁', 'DEMO-OP-US', NULL, '颈部不适待查（模拟）', '演示申请医师（模拟）', NULL, 'DEMO-SP-US', '2026-11-14 09:00:00.000', '2026-11-14 09:05:00.000', NULL, NULL, '演示技师（模拟）', NULL, '甲状腺超声（模拟）', '演示超声设备（模拟）', NULL, NULL, NULL, NULL, 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 结果未出具', 1)
  ON DUPLICATE KEY UPDATE id = id;

-- =====================================================================
-- 验收口径（执行后必须实测，未执行不得写通过）：
--   u-dev-user-1 报告列表 = 5 条：READY 3（血常规/胸部 CT/年度体检）、
--   REVIEWING 1（头颅 MRI）、PENDING 1（甲状腺超声）；
--   READY 3 条各带分组与项目明细，REVIEWING/PENDING 不写 items（门禁不外泄）。
--   其余账号与档案逐行不变；重复执行不新增行。
-- =====================================================================
