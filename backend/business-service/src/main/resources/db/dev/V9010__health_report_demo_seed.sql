-- =====================================================================
-- V9010__health_report_demo_seed.sql —— 电子检查报告演示数据（2026-11-05）
-- ⚠️ 仅 dev profile 加载（classpath:db/dev），不进入生产迁移。
-- ⚠️ 全部为开发环境模拟数据：模拟机构、模拟患者、模拟医生、模拟数值，
--    不含真实患者身份、真实医生签名、医院公章或官方报告二维码。
-- ⚠️ 不修改 / 不删除任何原有账号（u-dev-user-1/2/3、u-dev-user-fresh-9）
--    与原有 7 条健康档案；所有 ID 使用独立 v9010- 前缀。
-- 幂等：固定主键 + ON DUPLICATE KEY UPDATE pk = pk（no-op），可重复执行。
-- 生成器：tools/gen-report-demo-seed.py（重新生成后勿改已应用文件的 checksum）。
-- 前置：V27__health_report_structure.sql 已建新表与复合外键。
-- =====================================================================

-- ---------- 1. 演示医疗机构目录 ----------
INSERT INTO medical_institutions (id, institution_code, institution_name, institution_type, hospital_level, address, telephone, status, is_demo) VALUES ('mi-v9010-lab-01', 'DEMO-LAB-01', '演示医学检验中心（模拟）', 'LAB', NULL, '演示环境（无真实地址）', NULL, 'ACTIVE', 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO medical_institutions (id, institution_code, institution_name, institution_type, hospital_level, address, telephone, status, is_demo) VALUES ('mi-v9010-img-01', 'DEMO-IMG-01', '演示影像诊断中心（模拟）', 'IMAGING', NULL, '演示环境（无真实地址）', NULL, 'ACTIVE', 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO medical_institutions (id, institution_code, institution_name, institution_type, hospital_level, address, telephone, status, is_demo) VALUES ('mi-v9010-check-01', 'DEMO-CHECKUP-01', '演示健康体检中心（模拟）', 'CHECKUP', NULL, '演示环境（无真实地址）', NULL, 'ACTIVE', 1)
  ON DUPLICATE KEY UPDATE id = id;

-- ---------- 2. 演示患者账号（openid 为 dev 前缀，非真实微信凭证） ----------
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at) VALUES ('u-v9010-patient-a', 'dev-v9010-patient-a', NULL, NULL, 0, '演示患者甲', 'ACTIVE', 1, '2026-11-05 00:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO user_profiles (id, user_id, birth_date, sex, height_cm, weight_kg, allergies, chronic_conditions, version) VALUES ('up-u-v9010-patient-a', 'u-v9010-patient-a', '1981-06-15', 'MALE', 172.0, 70.5, '演示数据：青霉素类过敏（模拟）', NULL, 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO user_preferences (user_id, locale, theme_mode, font_scale, tts_rate, tts_auto_play, version) VALUES ('u-v9010-patient-a', 'zh-CN', 'SYSTEM', 'STANDARD', 1.0, 0, 1)
  ON DUPLICATE KEY UPDATE user_id = user_id;
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at) VALUES ('u-v9010-patient-b', 'dev-v9010-patient-b', NULL, NULL, 0, '演示患者乙', 'ACTIVE', 1, '2026-11-05 00:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO user_profiles (id, user_id, birth_date, sex, height_cm, weight_kg, allergies, chronic_conditions, version) VALUES ('up-u-v9010-patient-b', 'u-v9010-patient-b', '1988-03-22', 'FEMALE', 162.0, 56.0, '演示数据：无已知药物过敏', NULL, 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO user_preferences (user_id, locale, theme_mode, font_scale, tts_rate, tts_auto_play, version) VALUES ('u-v9010-patient-b', 'zh-CN', 'SYSTEM', 'STANDARD', 1.0, 0, 1)
  ON DUPLICATE KEY UPDATE user_id = user_id;
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at) VALUES ('u-v9010-patient-c', 'dev-v9010-patient-c', NULL, NULL, 0, '演示患者丙', 'ACTIVE', 1, '2026-11-05 00:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO user_profiles (id, user_id, birth_date, sex, height_cm, weight_kg, allergies, chronic_conditions, version) VALUES ('up-u-v9010-patient-c', 'u-v9010-patient-c', '1964-09-08', 'MALE', 170.0, 74.0, '演示数据：无已知药物过敏', NULL, 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO user_preferences (user_id, locale, theme_mode, font_scale, tts_rate, tts_auto_play, version) VALUES ('u-v9010-patient-c', 'zh-CN', 'SYSTEM', 'STANDARD', 1.0, 0, 1)
  ON DUPLICATE KEY UPDATE user_id = user_id;

-- ---------- 3. 演示家属（用户 A） ----------
INSERT INTO family_members (id, user_id, display_name, relation, proxy_status, gender, age_band, created_at) VALUES ('fm-v9010-patient-a-child', 'u-v9010-patient-a', '演示家属小甲', 'CHILD', 'NONE', 'MALE', 'CHILD', '2026-11-05 00:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;

-- ---------- 4. 报告主记录（health_records，保留原表结构） ----------
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-a-cbc', 'u-v9010-patient-a', NULL, 'EXAM', '血常规检验报告（演示）', '演示报告摘要：血常规检验报告（演示）。演示数据 · 非真实医疗报告 · 不构成诊断依据', '2026-10-20 10:05:00.000', 'DEMO_SEED_V9010', '演示医师（模拟）', 0, 'READY', '演示医学检验中心（模拟）', 1, NULL, NULL, '2026-10-20 10:05:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-a-liver', 'u-v9010-patient-a', NULL, 'EXAM', '肝肾功能检验报告（演示）', '演示报告摘要：肝肾功能检验报告（演示）。演示数据 · 非真实医疗报告 · 不构成诊断依据', '2026-10-22 11:20:00.000', 'DEMO_SEED_V9010', '演示医师（模拟）', 1, 'READY', '演示医学检验中心（模拟）', 1, NULL, NULL, '2026-10-22 11:20:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-a-us', 'u-v9010-patient-a', NULL, 'EXAM', '腹部超声检查报告（演示）', '演示报告摘要：腹部超声检查报告（演示）。演示数据 · 非真实医疗报告 · 不构成诊断依据', '2026-10-25 15:30:00.000', 'DEMO_SEED_V9010', '演示医师（模拟）', 1, 'READY', '演示影像诊断中心（模拟）', 1, NULL, NULL, '2026-10-25 15:30:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-b-urine', 'u-v9010-patient-b', NULL, 'EXAM', '尿常规检验报告（演示）', '演示报告摘要：尿常规检验报告（演示）。演示数据 · 非真实医疗报告 · 不构成诊断依据', '2026-10-28 09:40:00.000', 'DEMO_SEED_V9010', '演示医师（模拟）', 0, 'READY', '演示医学检验中心（模拟）', 1, NULL, NULL, '2026-10-28 09:40:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-b-checkup', 'u-v9010-patient-b', NULL, 'EXAM', '年度健康体检报告（演示）', '演示报告摘要：年度健康体检报告（演示）。演示数据 · 非真实医疗报告 · 不构成诊断依据', '2026-11-01 16:00:00.000', 'DEMO_SEED_V9010', '演示医师（模拟）', 1, 'READY', '演示健康体检中心（模拟）', 1, NULL, NULL, '2026-11-01 16:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-c-ecg', 'u-v9010-patient-c', NULL, 'EXAM', '心电图检查报告（演示·待审核）', '演示报告摘要：心电图检查报告（演示·待审核）。演示数据 · 非真实医疗报告 · 不构成诊断依据', '2026-11-03 10:00:00.000', 'DEMO_SEED_V9010', '演示医师（模拟）', NULL, 'REVIEWING', '演示影像诊断中心（模拟）', 1, NULL, NULL, '2026-11-03 10:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-c-imaging', 'u-v9010-patient-c', NULL, 'EXAM', '胸部影像检查报告（演示·待出结果）', '演示报告摘要：胸部影像检查报告（演示·待出结果）。演示数据 · 非真实医疗报告 · 不构成诊断依据', '2026-11-04 09:00:00.000', 'DEMO_SEED_V9010', '演示医师（模拟）', NULL, 'PENDING', '演示影像诊断中心（模拟）', 1, NULL, NULL, '2026-11-04 09:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;

-- ---------- 5. 报告详情（REVIEWING/PENDING 不生成项目明细，避免未审核结果落库） ----------
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-v9010-a-cbc', 'hr-v9010-a-cbc', 'u-v9010-patient-a', 'DEMO-20261020-001', 'LAB', 'mi-v9010-lab-01', NULL, '检验科', '演示患者甲', 'MALE', '45岁', 'DEMO-OP-a-cbc', NULL, '演示：健康体检/随访（模拟）', '演示申请医师（模拟）', '静脉血', 'DEMO-SP-a-cbc', '2026-10-20 07:20:00.000', '2026-10-20 07:48:00.000', '2026-10-20 09:10:00.000', '2026-10-20 10:05:00.000', '演示检验员（模拟）', '演示审核员（模拟）', '模拟方法学（非真实检测）', '演示设备（模拟）', NULL, NULL, '本次模拟血常规各项指标均在参考范围内。演示数据 · 非真实医疗报告 · 不构成诊断依据', '演示数据 · 非真实医疗报告 · 不构成诊断依据', 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 不构成诊断依据', 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-v9010-a-liver', 'hr-v9010-a-liver', 'u-v9010-patient-a', 'DEMO-20261022-002', 'LAB', 'mi-v9010-lab-01', NULL, '检验科', '演示患者甲', 'MALE', '45岁', 'DEMO-OP-a-liver', NULL, '演示：健康体检/随访（模拟）', '演示申请医师（模拟）', '静脉血', 'DEMO-SP-a-liver', '2026-10-22 07:40:00.000', '2026-10-22 08:05:00.000', '2026-10-22 10:15:00.000', '2026-10-22 11:20:00.000', '演示检验员（模拟）', '演示审核员（模拟）', '模拟方法学（非真实检测）', '演示设备（模拟）', NULL, NULL, '模拟结果提示尿酸轻度偏高、总胆固醇轻度偏高，建议结合临床复查。演示数据 · 非真实医疗报告 · 不构成诊断依据', '演示数据 · 非真实医疗报告 · 不构成诊断依据', 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 不构成诊断依据', 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-v9010-a-us', 'hr-v9010-a-us', 'u-v9010-patient-a', 'DEMO-20261025-003', 'IMAGING', 'mi-v9010-img-01', NULL, '超声科', '演示患者甲', 'MALE', '45岁', 'DEMO-OP-a-us', NULL, '演示：健康体检/随访（模拟）', '演示申请医师（模拟）', NULL, 'DEMO-SP-a-us', '2026-10-25 14:50:00.000', '2026-10-25 14:55:00.000', '2026-10-25 15:10:00.000', '2026-10-25 15:30:00.000', '演示检验员（模拟）', '演示审核员（模拟）', '模拟方法学（非真实检测）', '演示设备（模拟）', '肝大小形态正常，实质回声稍增强，肝内管道结构显示清晰；胆囊壁光滑，未见结石；胰、脾、双肾未见明显异常（模拟描述）。', '轻度脂肪肝声像（模拟印象），建议随访。', '模拟影像所见与诊断意见仅供界面演示。演示数据 · 非真实医疗报告 · 不构成诊断依据', '演示数据 · 非真实医疗报告 · 不构成诊断依据', 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 不构成诊断依据', 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-v9010-b-urine', 'hr-v9010-b-urine', 'u-v9010-patient-b', 'DEMO-20261028-004', 'LAB', 'mi-v9010-lab-01', NULL, '检验科', '演示患者乙', 'FEMALE', '38岁', 'DEMO-OP-b-urine', NULL, '演示：健康体检/随访（模拟）', '演示申请医师（模拟）', '中段尿', 'DEMO-SP-b-urine', '2026-10-28 08:00:00.000', '2026-10-28 08:20:00.000', '2026-10-28 09:00:00.000', '2026-10-28 09:40:00.000', '演示检验员（模拟）', '演示审核员（模拟）', '模拟方法学（非真实检测）', '演示设备（模拟）', NULL, NULL, '模拟尿常规各项未见明显异常。演示数据 · 非真实医疗报告 · 不构成诊断依据', '演示数据 · 非真实医疗报告 · 不构成诊断依据', 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 不构成诊断依据', 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-v9010-b-checkup', 'hr-v9010-b-checkup', 'u-v9010-patient-b', 'DEMO-20261101-005', 'CHECKUP', 'mi-v9010-check-01', NULL, '体检科', '演示患者乙', 'FEMALE', '38岁', 'DEMO-OP-b-checkup', NULL, '演示：健康体检/随访（模拟）', '演示申请医师（模拟）', NULL, 'DEMO-SP-b-checkup', '2026-11-01 08:30:00.000', '2026-11-01 08:40:00.000', '2026-11-01 10:30:00.000', '2026-11-01 16:00:00.000', '演示检验员（模拟）', '演示审核员（模拟）', '模拟方法学（非真实检测）', '演示设备（模拟）', NULL, NULL, '模拟体检提示低密度脂蛋白轻度偏高，建议生活方式干预后复查。演示数据 · 非真实医疗报告 · 不构成诊断依据', '演示数据 · 非真实医疗报告 · 不构成诊断依据', 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 不构成诊断依据', 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-v9010-c-ecg', 'hr-v9010-c-ecg', 'u-v9010-patient-c', 'DEMO-20261103-006', 'ECG', 'mi-v9010-img-01', NULL, '心电诊断科', '演示患者丙', 'MALE', '62岁', 'DEMO-OP-c-ecg', NULL, '演示：健康体检/随访（模拟）', '演示申请医师（模拟）', NULL, 'DEMO-SP-c-ecg', '2026-11-03 09:10:00.000', '2026-11-03 09:20:00.000', '2026-11-03 09:30:00.000', NULL, '演示检验员（模拟）', '演示审核员（模拟）', '模拟方法学（非真实检测）', '演示设备（模拟）', NULL, NULL, NULL, NULL, 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 不构成诊断依据', 1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_details (id, record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_name_snapshot, patient_sex_snapshot, patient_age_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_type, specimen_no, collection_at, received_at, tested_at, reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, demo_notice, version) VALUES ('hrd-v9010-c-imaging', 'hr-v9010-c-imaging', 'u-v9010-patient-c', 'DEMO-20261104-007', 'IMAGING', 'mi-v9010-img-01', NULL, '影像科', '演示患者丙', 'MALE', '62岁', 'DEMO-OP-c-imaging', NULL, '演示：健康体检/随访（模拟）', '演示申请医师（模拟）', NULL, 'DEMO-SP-c-imaging', '2026-11-04 08:20:00.000', '2026-11-04 08:35:00.000', NULL, NULL, '演示检验员（模拟）', '演示审核员（模拟）', '模拟方法学（非真实检测）', '演示设备（模拟）', NULL, NULL, NULL, NULL, 'DEMO', NULL, 1, '演示数据 · 非真实医疗报告 · 不构成诊断依据', 1)
  ON DUPLICATE KEY UPDATE id = id;

-- ---------- 6. 报告分组与检查项目 ----------
INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-v9010-a-cbc-1', 'hrd-v9010-a-cbc', 'u-v9010-patient-a', 'CBC', '血常规', 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-cbc-1-1', 'hrd-v9010-a-cbc', 'hrs-v9010-a-cbc-1', 'u-v9010-patient-a', 'DEMO-CBC-1-1', '白细胞计数', 6.2, NULL, '×10⁹/L', 3.5, 9.5, '3.5–9.5', 'NORMAL', '电阻抗法', NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-cbc-1-2', 'hrd-v9010-a-cbc', 'hrs-v9010-a-cbc-1', 'u-v9010-patient-a', 'DEMO-CBC-1-2', '红细胞计数', 4.82, NULL, '×10¹²/L', 4.3, 5.8, '4.3–5.8', 'NORMAL', NULL, NULL, 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-cbc-1-3', 'hrd-v9010-a-cbc', 'hrs-v9010-a-cbc-1', 'u-v9010-patient-a', 'DEMO-CBC-1-3', '血红蛋白', 145, NULL, 'g/L', 130, 175, '130–175', 'NORMAL', NULL, NULL, 30)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-cbc-1-4', 'hrd-v9010-a-cbc', 'hrs-v9010-a-cbc-1', 'u-v9010-patient-a', 'DEMO-CBC-1-4', '血小板计数', 230, NULL, '×10⁹/L', 125, 350, '125–350', 'NORMAL', NULL, NULL, 40)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-cbc-1-5', 'hrd-v9010-a-cbc', 'hrs-v9010-a-cbc-1', 'u-v9010-patient-a', 'DEMO-CBC-1-5', '中性粒细胞百分比', 63.5, NULL, '%', 40, 75, '40–75', 'NORMAL', NULL, NULL, 50)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-cbc-1-6', 'hrd-v9010-a-cbc', 'hrs-v9010-a-cbc-1', 'u-v9010-patient-a', 'DEMO-CBC-1-6', '淋巴细胞百分比', 28.0, NULL, '%', 20, 50, '20–50', 'NORMAL', NULL, NULL, 60)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-v9010-a-liver-1', 'hrd-v9010-a-liver', 'u-v9010-patient-a', 'LIVER', '肝功能', 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-liver-1-1', 'hrd-v9010-a-liver', 'hrs-v9010-a-liver-1', 'u-v9010-patient-a', 'DEMO-LIVER-1-1', '丙氨酸氨基转移酶', 46, NULL, 'U/L', 9, 50, '9–50', 'NORMAL', '速率法', NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-liver-1-2', 'hrd-v9010-a-liver', 'hrs-v9010-a-liver-1', 'u-v9010-patient-a', 'DEMO-LIVER-1-2', '天门冬氨酸氨基转移酶', 28, NULL, 'U/L', 15, 40, '15–40', 'NORMAL', NULL, NULL, 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-liver-1-3', 'hrd-v9010-a-liver', 'hrs-v9010-a-liver-1', 'u-v9010-patient-a', 'DEMO-LIVER-1-3', '总胆红素', 18.2, NULL, 'μmol/L', 3.4, 20.5, '3.4–20.5', 'NORMAL', NULL, NULL, 30)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-liver-1-4', 'hrd-v9010-a-liver', 'hrs-v9010-a-liver-1', 'u-v9010-patient-a', 'DEMO-LIVER-1-4', '白蛋白', 42, NULL, 'g/L', 40, 55, '40–55', 'NORMAL', NULL, NULL, 40)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-v9010-a-liver-2', 'hrd-v9010-a-liver', 'u-v9010-patient-a', 'KIDNEY', '肾功能', 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-liver-2-1', 'hrd-v9010-a-liver', 'hrs-v9010-a-liver-2', 'u-v9010-patient-a', 'DEMO-KIDNEY-2-1', '肌酐', 88, NULL, 'μmol/L', 57, 97, '57–97', 'NORMAL', NULL, NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-liver-2-2', 'hrd-v9010-a-liver', 'hrs-v9010-a-liver-2', 'u-v9010-patient-a', 'DEMO-KIDNEY-2-2', '尿素', 5.4, NULL, 'mmol/L', 3.1, 8.0, '3.1–8.0', 'NORMAL', NULL, NULL, 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-liver-2-3', 'hrd-v9010-a-liver', 'hrs-v9010-a-liver-2', 'u-v9010-patient-a', 'DEMO-KIDNEY-2-3', '尿酸', 452, NULL, 'μmol/L', 208, 428, '208–428', 'HIGH', NULL, NULL, 30)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-v9010-a-liver-3', 'hrd-v9010-a-liver', 'u-v9010-patient-a', 'LIPID', '血脂', 30)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-liver-3-1', 'hrd-v9010-a-liver', 'hrs-v9010-a-liver-3', 'u-v9010-patient-a', 'DEMO-LIPID-3-1', '总胆固醇', 5.9, NULL, 'mmol/L', 0, 5.2, '<5.2', 'HIGH', NULL, NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-v9010-a-us-1', 'hrd-v9010-a-us', 'u-v9010-patient-a', 'US_FINDINGS', '检查所见', 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-us-1-1', 'hrd-v9010-a-us', 'hrs-v9010-a-us-1', 'u-v9010-patient-a', 'DEMO-US_FINDINGS-1-1', '肝实质回声', NULL, '稍增强，考虑轻度脂肪肝（模拟描述）', NULL, NULL, NULL, NULL, 'ABNORMAL', NULL, NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-a-us-1-2', 'hrd-v9010-a-us', 'hrs-v9010-a-us-1', 'u-v9010-patient-a', 'DEMO-US_FINDINGS-1-2', '胆囊', NULL, '壁光滑，未见结石（模拟描述）', NULL, NULL, NULL, NULL, 'NORMAL', NULL, NULL, 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-v9010-b-urine-1', 'hrd-v9010-b-urine', 'u-v9010-patient-b', 'URINE', '尿常规', 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-urine-1-1', 'hrd-v9010-b-urine', 'hrs-v9010-b-urine-1', 'u-v9010-patient-b', 'DEMO-URINE-1-1', '尿蛋白', NULL, '阴性', NULL, NULL, NULL, NULL, 'NEGATIVE', NULL, NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-urine-1-2', 'hrd-v9010-b-urine', 'hrs-v9010-b-urine-1', 'u-v9010-patient-b', 'DEMO-URINE-1-2', '尿糖', NULL, '阴性', NULL, NULL, NULL, NULL, 'NEGATIVE', NULL, NULL, 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-urine-1-3', 'hrd-v9010-b-urine', 'hrs-v9010-b-urine-1', 'u-v9010-patient-b', 'DEMO-URINE-1-3', '尿白细胞', 3.0, NULL, '/μL', 0, 12, '0–12', 'NORMAL', NULL, NULL, 30)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-urine-1-4', 'hrd-v9010-b-urine', 'hrs-v9010-b-urine-1', 'u-v9010-patient-b', 'DEMO-URINE-1-4', '尿红细胞', 1.0, NULL, '/μL', 0, 5, '0–5', 'NORMAL', NULL, NULL, 40)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-urine-1-5', 'hrd-v9010-b-urine', 'hrs-v9010-b-urine-1', 'u-v9010-patient-b', 'DEMO-URINE-1-5', '尿比重', 1.02, NULL, NULL, 1.005, 1.03, '1.005–1.030', 'NORMAL', NULL, NULL, 50)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-urine-1-6', 'hrd-v9010-b-urine', 'hrs-v9010-b-urine-1', 'u-v9010-patient-b', 'DEMO-URINE-1-6', '尿酸碱度', 6.5, NULL, NULL, 4.6, 8.0, '4.6–8.0', 'NORMAL', NULL, NULL, 60)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-v9010-b-checkup-1', 'hrd-v9010-b-checkup', 'u-v9010-patient-b', 'VITAL', '体格检查', 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-checkup-1-1', 'hrd-v9010-b-checkup', 'hrs-v9010-b-checkup-1', 'u-v9010-patient-b', 'DEMO-VITAL-1-1', '收缩压', 128, NULL, 'mmHg', 90, 139, '90–139', 'NORMAL', NULL, NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-checkup-1-2', 'hrd-v9010-b-checkup', 'hrs-v9010-b-checkup-1', 'u-v9010-patient-b', 'DEMO-VITAL-1-2', '舒张压', 82, NULL, 'mmHg', 60, 89, '60–89', 'NORMAL', NULL, NULL, 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-checkup-1-3', 'hrd-v9010-b-checkup', 'hrs-v9010-b-checkup-1', 'u-v9010-patient-b', 'DEMO-VITAL-1-3', '体质指数', 23.4, NULL, 'kg/m²', 18.5, 23.9, '18.5–23.9', 'NORMAL', NULL, NULL, 30)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_sections (id, report_detail_id, user_id, section_code, section_name, sort_order) VALUES ('hrs-v9010-b-checkup-2', 'hrd-v9010-b-checkup', 'u-v9010-patient-b', 'LIPID', '血脂', 20)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-checkup-2-1', 'hrd-v9010-b-checkup', 'hrs-v9010-b-checkup-2', 'u-v9010-patient-b', 'DEMO-LIPID-2-1', '总胆固醇', 5.1, NULL, 'mmol/L', 0, 5.2, '<5.2', 'NORMAL', NULL, NULL, 10)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_report_items (id, report_detail_id, section_id, user_id, item_code, item_name, result_value, result_text, unit, reference_low, reference_high, reference_text, abnormal_flag, inspection_method, remark, sort_order) VALUES ('hri-v9010-b-checkup-2-2', 'hrd-v9010-b-checkup', 'hrs-v9010-b-checkup-2', 'u-v9010-patient-b', 'DEMO-LIPID-2-2', '低密度脂蛋白胆固醇', 3.5, NULL, 'mmol/L', 0, 3.4, '<3.4', 'HIGH', NULL, NULL, 20)
  ON DUPLICATE KEY UPDATE id = id;

-- ---------- 7. 非报告类健康档案：不标 READY（契约 NULL = 非报告类） ----------
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-a-vitals', 'u-v9010-patient-a', 'fm-v9010-patient-a-child', 'VITALS', '家属血压记录（演示）', '演示家属小甲 血压 118/76 mmHg，自测记录。', '2026-10-18 08:00:00.000', 'DEMO_SEED_V9010', NULL, NULL, NULL, NULL, 1, NULL, NULL, '2026-10-18 08:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-a-allergy', 'u-v9010-patient-a', NULL, 'ALLERGY', '药物过敏史（演示）', '演示数据：青霉素类过敏（模拟，非真实病历）。', '2026-10-15 09:00:00.000', 'DEMO_SEED_V9010', NULL, NULL, NULL, NULL, 1, NULL, NULL, '2026-10-15 09:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-b-vitals', 'u-v9010-patient-b', NULL, 'VITALS', '体重记录（演示）', '体重 56.0 kg，居家自测。', '2026-10-26 07:30:00.000', 'DEMO_SEED_V9010', NULL, NULL, NULL, NULL, 1, NULL, NULL, '2026-10-26 07:30:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-b-medication', 'u-v9010-patient-b', NULL, 'MEDICATION', '用药记录（演示）', '演示数据：维生素 D 滴剂（模拟条目）。', '2026-10-27 20:00:00.000', 'DEMO_SEED_V9010', NULL, NULL, NULL, NULL, 1, NULL, NULL, '2026-10-27 20:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-c-vitals', 'u-v9010-patient-c', NULL, 'VITALS', '空腹血糖自测（演示）', '空腹血糖 6.1 mmol/L，居家自测（模拟）。', '2026-11-02 07:10:00.000', 'DEMO_SEED_V9010', NULL, NULL, NULL, NULL, 1, NULL, NULL, '2026-11-02 07:10:00.000')
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at, source, doctor_name, abnormal, report_status, hospital, version, idempotency_key, request_digest, created_at) VALUES ('hr-v9010-c-history', 'u-v9010-patient-c', NULL, 'HISTORY', '既往病史（演示）', '演示数据：高血压病史 5 年（模拟，非真实病历）。', '2026-10-30 10:00:00.000', 'DEMO_SEED_V9010', NULL, NULL, NULL, NULL, 1, NULL, NULL, '2026-10-30 10:00:00.000')
  ON DUPLICATE KEY UPDATE id = id;

-- =====================================================================
-- 验收口径（执行后实测，未执行不得写通过）：
--   新增用户 3 / 新增报告 7（READY 5、REVIEWING 1、PENDING 1）/
--   非报告类档案 6（report_status NULL）/ 演示机构 3 / 演示家属 1。
--   REVIEWING 与 PENDING 报告不写入 health_report_items。
--   原有 4 个账号与 7 条档案逐行保持不变。
-- =====================================================================
