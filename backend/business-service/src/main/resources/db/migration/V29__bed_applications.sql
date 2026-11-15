-- 床位申请（申请制 · 2026-11-15）
--
-- 业务口径变更：医生端不再直接占用床位（原 ASSIGN 动作由护士站/住院处执行），
-- 医生只能提交「床位申请」，由病区护士站审批：PENDING → APPROVED / REJECTED。
-- 审批通过时若申请指定了具体床位，由服务端在同一事务内完成落床（beds.status → OCCUPIED）。
--
-- 字段说明：
--   doctor_id / department_id  申请人与其科室（列表按 doctor_id 过滤，越权在 Service 判定）
--   ward_id / bed_id           期望病区与床位：bed_id 可空（只申请病区，由护士站排床）
--   patient_ref                内部患者 ID（与 beds.occupant_user_id 同口径，不接受姓名/手机号）
--   patient_display_name       写入时即脱敏（首字 + *），与 beds.occupant_display_name 一致
--   priority                   NORMAL / URGENT
--   status                     PENDING / APPROVED / REJECTED / CANCELLED
CREATE TABLE IF NOT EXISTS bed_applications (
    id                    VARCHAR(64)  NOT NULL,
    doctor_id             VARCHAR(64)  NOT NULL,
    department_id         VARCHAR(64)  NOT NULL,
    ward_id               VARCHAR(64)  NULL,
    bed_id                VARCHAR(64)  NULL,
    patient_ref           VARCHAR(64)  NOT NULL,
    patient_display_name  VARCHAR(40)  NULL,
    reason                VARCHAR(200) NULL,
    priority              VARCHAR(16)  NOT NULL DEFAULT 'NORMAL',
    status                VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
    review_note           VARCHAR(200) NULL,
    reviewer              VARCHAR(64)  NULL,
    reviewed_at           DATETIME(3)  NULL DEFAULT NULL,
    idempotency_key       VARCHAR(128) NULL,
    request_digest        CHAR(64)     NULL,
    created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at            DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_bed_app_idem (idempotency_key),
    KEY idx_bed_app_doctor (doctor_id, created_at),
    KEY idx_bed_app_status (status, created_at),
    CONSTRAINT fk_bed_app_bed FOREIGN KEY (bed_id) REFERENCES beds (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
