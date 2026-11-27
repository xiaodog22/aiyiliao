-- =====================================================================
-- V41__appointment_patient_link.sql —— 预约的患者主索引/院内患者双键（2026-11-27）
--
-- 背景（P0-1 兜底）：受理成功后，平台要把「就诊人 ↔ HIS 患者」写成映射。
-- 但「HIS 已受理」与「平台写映射」是两个存储，后者失败不能回滚前者（回滚会让
-- 患者已占号却显示未受理）。因此把双键**落在预约行上**，映射表退化为可重建的投影：
--
--   appointments.patient_ref     ← 平台就诊人（新预约必填；历史为 NULL）
--   appointments.his_patient_id  ← HIS 回执里的 patients.id
--
-- 两者在「置 CONFIRMED + 写 his_order_no」的同一个本地事务里写入，
-- 之后 his_patient_map 的 upsert 即使失败，也能由预约行重放重建。
--
-- 只加列/索引，不改历史行、不回填数据。
-- =====================================================================

ALTER TABLE appointments
    ADD COLUMN patient_ref VARCHAR(64) NULL
        COMMENT '就诊人主索引 patient_index.patient_ref；历史预约为 NULL（走白名单降级读）'
        AFTER family_member_id,
    ADD COLUMN his_patient_id VARCHAR(64) NULL
        COMMENT 'HIS patients.id（受理回执 hisPatientId）；映射投影的事实源'
        AFTER his_order_no,
    ADD KEY idx_appointments_patient_ref (patient_ref),
    ADD KEY idx_appointments_his_patient (his_patient_id);

-- 回滚（只允许后续修复迁移）：
--   ALTER TABLE appointments
--     DROP KEY idx_appointments_his_patient,
--     DROP KEY idx_appointments_patient_ref,
--     DROP COLUMN his_patient_id,
--     DROP COLUMN patient_ref;
-- =====================================================================
