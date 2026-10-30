-- =====================================================================
-- V5__m3_tables.sql —— M3 新增表（病区/床位 / 挂号状态事件 / 删除申请）+ consents 幂等列
-- 事实源：backend/contracts/business-openapi.yaml
--         （doctor/workbench、doctor/appointments/{id}/status、beds、consents、me/deletion-requests）
--         + docs/v4/07 §8/§9（保留期限与注销流程）
-- 约定：utf8mb4；时间 UTC（DATETIME(3)）；主键应用生成（VARCHAR(64)）。
-- 说明：V1~V4 已应用不可改；本文件只建新表 + 为 consents 追加 M3 幂等列。
-- =====================================================================

-- 病区（V1 无病区模型：床位的归属与医生授权范围都由病区→科室推导，契约 scope.wardIds 来源）。
CREATE TABLE wards (
    id            VARCHAR(64) NOT NULL,
    department_id VARCHAR(64) NOT NULL,
    name          VARCHAR(40) NOT NULL,
    status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NULL DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_wards_department_status (department_id, status),
    CONSTRAINT fk_wards_department FOREIGN KEY (department_id) REFERENCES departments (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 床位（契约 Bed：id/wardId/label/status/version 必填）。
-- 一床一占用者：占用关系即行上的 occupant_user_id（不在床位上存患者姓名/手机号，
-- occupant_display_name 存的是**已脱敏**展示名，避免敏感信息随床位列表扩散）。
-- 分配并发：version 乐观锁；同一床位的重复分配由 (ward_id, label) 唯一 + version 裁决。
-- 幂等：记录最近一次分配操作的键与摘要（M3 口径见任务回执：床位分配以"最近一次操作"判定重放）。
CREATE TABLE beds (
    id                     VARCHAR(64) NOT NULL,
    ward_id                VARCHAR(64) NOT NULL,
    label                  VARCHAR(20) NOT NULL,
    status                 VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
    occupant_user_id       VARCHAR(64) NULL,
    occupant_display_name  VARCHAR(40) NULL,
    admitted_at            DATETIME(3) NULL DEFAULT NULL,
    version                INT         NOT NULL DEFAULT 1,
    last_idempotency_key   VARCHAR(128) NULL,
    last_request_digest    CHAR(64)    NULL,
    last_note              VARCHAR(200) NULL,
    created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at             DATETIME(3) NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_beds_ward_label (ward_id, label),
    KEY idx_beds_ward_status (ward_id, status),
    CONSTRAINT fk_beds_ward FOREIGN KEY (ward_id) REFERENCES wards (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 挂号状态流转事件（契约 updateAppointmentStatus：每次流转写入，记录操作者、时间与服务端时间戳）。
-- 审计不可变：只追加不修改。(operator_user_id, idempotency_key) 唯一 → 兼作幂等重放凭据。
CREATE TABLE appointment_status_events (
    id                VARCHAR(64)  NOT NULL,
    appointment_id    VARCHAR(64)  NOT NULL,
    from_status       VARCHAR(16)  NOT NULL,
    to_status         VARCHAR(16)  NOT NULL,
    operator_user_id  VARCHAR(64)  NOT NULL,
    operator_doctor_id VARCHAR(64) NULL,
    note              VARCHAR(200) NULL,
    version_after     INT          NOT NULL,
    idempotency_key   VARCHAR(128) NULL,
    request_digest    CHAR(64)     NULL,
    server_time       DATETIME(3)  NOT NULL,
    created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_status_events_idem (operator_user_id, idempotency_key),
    KEY idx_status_events_appointment (appointment_id, server_time),
    CONSTRAINT fk_status_events_appointment FOREIGN KEY (appointment_id) REFERENCES appointments (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 删除/注销申请（契约 DeletionRequest：异步工作流，受理 ≠ 已删除）。
-- retained_items_json：逐项保留例外（category/reason/retainUntil），创建时定格，避免读时口径漂移。
-- root 依据 docs/v4/07 §8/§9：保留期限全部"待法务确认"，故 retainUntil 一律留空（不编造日期）。
CREATE TABLE deletion_requests (
    id              VARCHAR(64)  NOT NULL,
    user_id         VARCHAR(64)  NOT NULL,
    scope_json      VARCHAR(500) NOT NULL,
    status          VARCHAR(24)  NOT NULL DEFAULT 'RECEIVED',
    reason          VARCHAR(200) NULL,
    retained_items_json TEXT     NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_digest  CHAR(64)     NOT NULL,
    created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      DATETIME(3)  NULL DEFAULT NULL,
    completed_at    DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_deletion_requests_idem (user_id, idempotency_key),
    KEY idx_deletion_requests_user (user_id, created_at),
    CONSTRAINT fk_deletion_requests_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- consents：M3 的 POST /consents 与 POST /consents/{purpose}/withdraw 都要求 Idempotency-Key。
-- 追加两列（不动 V1 既有列语义）：记录本次操作键与载荷摘要，(user_id, idempotency_key) 唯一。
-- 历史行（M1 无幂等列）保持 NULL —— 多行 NULL 不冲突，故不影响既有数据。
-- ---------------------------------------------------------------------
ALTER TABLE consents ADD COLUMN idempotency_key VARCHAR(128) NULL;
ALTER TABLE consents ADD COLUMN request_digest CHAR(64) NULL;
-- 撤回原因（契约 withdrawConsent 的可选 reason ≤200，"仅用于运营分析，不影响撤回效力"）：
-- 不落库会静默丢弃用户输入，故如实保存（grant 行为 NULL）。
ALTER TABLE consents ADD COLUMN withdraw_reason VARCHAR(200) NULL;
ALTER TABLE consents ADD CONSTRAINT uq_consents_idem UNIQUE (user_id, idempotency_key);
