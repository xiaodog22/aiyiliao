-- =====================================================================
-- V21__doctor_patient_interop.sql —— 医生-患者挂号互通（2026-10-21）
--
-- 背景：患者下单的挂号（appointments）与医生账号（doctors.user_id）原本只靠
--   appointments.doctor_id 关联（列表/叫号链路已通）；本迁移补齐互通缺口：
--   1) consultations 加 doctor_id —— 问诊会话获得医生归属，
--      使 /doctor/todos 的 CONSULT_REPLY（问诊待回复）可被服务端判定；
--   2) 建 messages 表 —— 消息中心（/api/v1/messages）与状态变更通知，
--      医生叫号/完成等流转实时通知患者，打通"医生回应 → 患者感知"链路。
-- 约定同 V1~V20：utf8mb4；时间 UTC（DATETIME(3)）；主键应用生成（VARCHAR(64)）。
-- 生产不回填 consultations.doctor_id：历史问诊无归属依据，不臆造关联（dev 种子除外）。
-- =====================================================================

-- ---------- 1. 问诊会话医生归属 ----------
ALTER TABLE consultations ADD COLUMN doctor_id VARCHAR(64) NULL AFTER user_id;
ALTER TABLE consultations ADD KEY idx_consultations_doctor (doctor_id, status, created_at);
ALTER TABLE consultations ADD CONSTRAINT fk_consultations_doctor FOREIGN KEY (doctor_id) REFERENCES doctors (id) ON DELETE SET NULL;

-- ---------- 2. 消息中心 ----------
-- type：APPOINTMENT_CREATED（挂号成功）/ APPOINTMENT_STATUS（医生流转通知）/ SYSTEM_NOTICE（系统通知）
-- ref_type/ref_id：关联业务对象（appointment / consultation / null），供前端跳转
-- read_at：NULL = 未读（未读红点数据源）；只读操作置值，消息本身只追加不改写
CREATE TABLE messages (
    id          VARCHAR(64)  NOT NULL,
    user_id     VARCHAR(64)  NOT NULL,
    type        VARCHAR(32)  NOT NULL,
    title       VARCHAR(80)  NOT NULL,
    body        VARCHAR(300) NULL,
    ref_type    VARCHAR(24)  NULL,
    ref_id      VARCHAR(64)  NULL,
    read_at     DATETIME(3)  NULL,
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_messages_user_created (user_id, created_at),
    KEY idx_messages_user_unread (user_id, read_at),
    CONSTRAINT fk_messages_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
