-- =====================================================================
-- V4__m2_tables.sql —— M2 新增表（问诊会话 / AI 任务 / 语音 / 照护建议）
-- 事实源：backend/contracts/business-openapi.yaml（consultation/ai-task/voice/care-plan）
--         + backend/contracts/ai-openapi.yaml（内部任务编排）
-- 约定：utf8mb4；时间 UTC（DATETIME(3)）；主键应用生成（VARCHAR(64)）。
-- 说明：V1~V3 已应用不可改；本文件只建新表。
-- =====================================================================

-- 问诊会话（契约 Consultation：列表只给元数据与摘要，正文按会话单独拉取）。
-- 幂等：POST /consultations 要求 Idempotency-Key，(user_id, idempotency_key) 唯一。
CREATE TABLE consultations (
    id               VARCHAR(64)  NOT NULL,
    user_id          VARCHAR(64)  NOT NULL,
    title            VARCHAR(60)  NULL,
    status           VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    summary          VARCHAR(200) NULL,
    last_message_at  DATETIME(3)  NULL,
    idempotency_key  VARCHAR(128) NULL,
    request_digest   CHAR(64)     NULL,
    created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at       DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_consultations_idem (user_id, idempotency_key),
    KEY idx_consultations_user (user_id, created_at),
    CONSTRAINT fk_consultations_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 会话消息（契约 Message：权威记录在 MySQL；用户消息先落库再建 AI 任务）。
-- generation_status：草稿转写 DRAFT → 用户确认 CONFIRMED（确认语义见 confirmations）。
-- idempotency：POST /messages、POST /confirmations 共用 (user_id, idempotency_key) 唯一。
CREATE TABLE consultation_messages (
    id               VARCHAR(64)  NOT NULL,
    consultation_id  VARCHAR(64)  NOT NULL,
    user_id          VARCHAR(64)  NOT NULL,
    role             VARCHAR(20)  NOT NULL,
    content_type     VARCHAR(24)  NOT NULL DEFAULT 'TEXT',
    content          VARCHAR(4000) NULL,
    provenance       VARCHAR(20)  NOT NULL DEFAULT 'USER_INPUT',
    citations_json   TEXT         NULL,
    risk_tags_json   TEXT         NULL,
    generation_status VARCHAR(16) NULL,
    source_task_id   VARCHAR(64)  NULL,
    idempotency_key  VARCHAR(128) NULL,
    request_digest   CHAR(64)     NULL,
    confirm_idempotency_key VARCHAR(128) NULL,
    confirm_digest   CHAR(64)     NULL,
    created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_messages_idem (user_id, idempotency_key),
    UNIQUE KEY uq_messages_confirm_idem (user_id, confirm_idempotency_key),
    KEY idx_messages_consultation (consultation_id, created_at),
    KEY idx_messages_source_task (source_task_id),
    CONSTRAINT fk_messages_consultation FOREIGN KEY (consultation_id) REFERENCES consultations (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- AI 任务（业务侧权威行；上游 ai-service 的可重建中间态镜像）。
-- id 对客户端暴露；upstream_task_id 为 ai-service /internal/v1/tasks 的任务 ID。
-- O-02 未定稿：状态靠轮询 GET /internal/v1/tasks/{id} 权威同步，无回调。
CREATE TABLE ai_tasks (
    id               VARCHAR(64)  NOT NULL,
    user_id          VARCHAR(64)  NOT NULL,
    consultation_id  VARCHAR(64)  NULL,
    task_type        VARCHAR(16)  NOT NULL,
    status           VARCHAR(16)  NOT NULL DEFAULT 'QUEUED',
    progress_phase   VARCHAR(20)  NULL,
    model_profile    VARCHAR(20)  NULL,
    model_id         VARCHAR(60)  NULL,
    model_version    VARCHAR(40)  NULL,
    policy_version   VARCHAR(40)  NOT NULL,
    input_ref        VARCHAR(256) NULL,
    upstream_task_id VARCHAR(64)  NULL,
    result_json      TEXT         NULL,
    error_code       VARCHAR(40)  NULL,
    error_message    VARCHAR(300) NULL,
    error_retryable  TINYINT(1)   NULL,
    created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at       DATETIME(3)  NULL DEFAULT NULL,
    expires_at       DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_ai_tasks_user (user_id, created_at),
    KEY idx_ai_tasks_upstream (upstream_task_id),
    CONSTRAINT fk_ai_tasks_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 照护建议请求（契约 POST /care-plans 同步响应 + Idempotency-Key；结果落库供同键重放）。
CREATE TABLE care_plan_requests (
    id               VARCHAR(64)  NOT NULL,
    user_id          VARCHAR(64)  NOT NULL,
    goal             VARCHAR(300) NOT NULL,
    constraints_json TEXT         NULL,
    locale           VARCHAR(20)  NOT NULL DEFAULT 'zh-CN',
    status           VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
    task_id          VARCHAR(64)  NULL,
    result_json      TEXT         NULL,
    refused          TINYINT(1)   NOT NULL DEFAULT 0,
    refusal_reason   VARCHAR(200) NULL,
    idempotency_key  VARCHAR(128) NOT NULL,
    request_digest   CHAR(64)     NOT NULL,
    created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at       DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_care_plan_idem (user_id, idempotency_key),
    CONSTRAINT fk_care_plan_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 自定义音色（契约 Voice.isCustom=true 的来源；built-in 音色来自服务端配置）。
CREATE TABLE custom_voices (
    id           VARCHAR(64) NOT NULL,
    user_id      VARCHAR(64) NOT NULL,
    display_name VARCHAR(40) NOT NULL,
    locale       VARCHAR(20) NULL,
    gender       VARCHAR(20) NULL,
    created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_custom_voices_user (user_id),
    CONSTRAINT fk_custom_voices_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 语音偏好（契约 VoicePreference：voiceId/rate/autoPlay；默认关闭自动朗读）。
-- 与 V2 user_preferences.tts_* 的关系：这里是音色维度的偏好（含 voiceId），M4 统一收口。
CREATE TABLE voice_preferences (
    user_id    VARCHAR(64)  NOT NULL,
    voice_id   VARCHAR(64)  NOT NULL,
    rate       DECIMAL(3,2) NULL,
    auto_play  TINYINT(1)   NOT NULL DEFAULT 0,
    version    INT          NOT NULL DEFAULT 1,
    created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_voice_prefs_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- TTS 结果缓存（缓存键 HMAC-SHA-256(引擎版本|音色|语速|格式|规范化文本|隐私作用域)）。
-- 音频本体由上游持有，此处只存短期签名 URL 与元数据；过期后重新申请。
CREATE TABLE tts_cache (
    cache_key   CHAR(64)     NOT NULL,
    audio_url   VARCHAR(512) NOT NULL,
    mime        VARCHAR(60)  NOT NULL,
    duration_ms INT          NULL,
    engine      VARCHAR(40)  NULL,
    voice_id    VARCHAR(64)  NOT NULL,
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at  DATETIME(3)  NOT NULL,
    PRIMARY KEY (cache_key)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ASR 受控输入登记（契约：音频不长期保存；inputRef = 'asr:{id}'，文件在受控临时目录，
-- 任务终态后清理；本表只留大小/摘要/过期时间做审计，不存音频字节、不存绝对路径）。
CREATE TABLE asr_inputs (
    id         VARCHAR(64) NOT NULL,
    user_id    VARCHAR(64) NOT NULL,
    task_id    VARCHAR(64) NULL,
    size_bytes INT         NOT NULL,
    sha256     CHAR(64)    NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_asr_inputs_user (user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
