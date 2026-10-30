-- =====================================================================
-- V1__core_tables.sql —— M0.2 核心表 v0（users/user_profiles/consents/departments/doctors/appointments）
-- 事实源：docs/v4/03 §3/§5 + backend/contracts/business-openapi.yaml
-- 约定：utf8mb4；时间统一 UTC（DATETIME(3)，由 JDBC connectionTimeZone=UTC 保证）；
--      主键由应用生成（VARCHAR(64)），不含手机号等可识别信息。
-- =====================================================================

-- 账号主体：与档案（user_profiles）分离，见 docs/v4/03 §3
CREATE TABLE users (
    id              VARCHAR(64)  NOT NULL,
    -- 微信 openid 只在服务端落库；客户端永不接触（契约 auth 描述）
    wechat_openid   VARCHAR(64)  NOT NULL,
    -- 手机号密文（AES-GCM，密钥与数据库分离）；响应不回显原文
    phone_cipher    VARBINARY(512) NULL,
    phone_hash      VARCHAR(64)  NULL,
    phone_bound     TINYINT(1)   NOT NULL DEFAULT 0,
    display_name    VARCHAR(40)  NOT NULL,
    avatar_key      VARCHAR(255) NULL,
    status          VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    version         INT          NOT NULL DEFAULT 1,
    created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_users_openid (wechat_openid),
    KEY idx_users_status (status)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 档案：最少字段，与身份认证信息分离
CREATE TABLE user_profiles (
    id                VARCHAR(64) NOT NULL,
    user_id           VARCHAR(64) NOT NULL,
    birth_date        DATE        NULL,
    sex               VARCHAR(8)  NULL,
    height_cm         DECIMAL(5,1) NULL,
    weight_kg         DECIMAL(5,1) NULL,
    allergies         VARCHAR(500) NULL,
    chronic_conditions VARCHAR(500) NULL,
    version           INT         NOT NULL DEFAULT 1,
    created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at        DATETIME(3) NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_user_profiles_user (user_id),
    CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 同意记录：只追加不覆盖（撤回记录同样返回，不原地覆盖；政策版本升级旧同意不自动延续）
-- 当前状态 = 该 (user_id, purpose) 最新一行
CREATE TABLE consents (
    id              VARCHAR(64)  NOT NULL,
    user_id         VARCHAR(64)  NOT NULL,
    purpose         VARCHAR(40)  NOT NULL,
    policy_version  VARCHAR(20)  NOT NULL,
    status          VARCHAR(16)  NOT NULL,
    channel         VARCHAR(16)  NULL,
    scope_json      VARCHAR(1000) NULL,
    evidence_digest VARCHAR(128) NULL,
    withdrawn_at    DATETIME(3)  NULL,
    created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_consents_user_purpose_time (user_id, purpose, created_at),
    CONSTRAINT fk_consents_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 科室（只读目录）
CREATE TABLE departments (
    id          VARCHAR(64)  NOT NULL,
    hospital_id VARCHAR(64)  NOT NULL,
    name        VARCHAR(40)  NOT NULL,
    location    VARCHAR(80)  NULL,
    description VARCHAR(200) NULL,
    icon_key    VARCHAR(128) NULL,
    sort_order  INT          NOT NULL DEFAULT 0,
    status      VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at  DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_departments_hospital_status (hospital_id, status)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 医生：user_id 关联登录账号（医生端登录由服务端按任职关系判定角色，契约 doctorLogin）
CREATE TABLE doctors (
    id            VARCHAR(64)  NOT NULL,
    department_id VARCHAR(64)  NOT NULL,
    user_id       VARCHAR(64)  NULL,
    name          VARCHAR(40)  NOT NULL,
    title         VARCHAR(20)  NOT NULL,
    specialties_json VARCHAR(600) NULL,
    introduction  VARCHAR(500) NULL,
    avatar_key    VARCHAR(255) NULL,
    status        VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_doctors_department_status (department_id, status),
    KEY idx_doctors_user (user_id),
    CONSTRAINT fk_doctors_department FOREIGN KEY (department_id) REFERENCES departments (id),
    CONSTRAINT fk_doctors_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 号源：remaining 的原子扣减是预约正确性的唯一防线（契约 createAppointment）
CREATE TABLE doctor_slots (
    id          VARCHAR(64)  NOT NULL,
    doctor_id   VARCHAR(64)  NOT NULL,
    start_time  DATETIME(3)  NOT NULL,
    end_time    DATETIME(3)  NOT NULL,
    capacity    INT          NOT NULL,
    remaining   INT          NOT NULL,
    fee         DECIMAL(8,2) NULL,
    currency    VARCHAR(8)   NULL,
    status      VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at  DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_slots_doctor_time (doctor_id, start_time),
    CONSTRAINT fk_slots_doctor FOREIGN KEY (doctor_id) REFERENCES doctors (id),
    CONSTRAINT chk_slots_capacity CHECK (capacity >= 0),
    CONSTRAINT chk_slots_remaining CHECK (remaining >= 0 AND remaining <= capacity)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 预约：幂等键唯一约束（用户+操作类型+键），乐观锁 version
CREATE TABLE appointments (
    id                  VARCHAR(64)  NOT NULL,
    user_id             VARCHAR(64)  NOT NULL,
    family_member_id    VARCHAR(64)  NULL,
    slot_id             VARCHAR(64)  NOT NULL,
    doctor_id           VARCHAR(64)  NOT NULL,
    department_id       VARCHAR(64)  NOT NULL,
    patient_name        VARCHAR(40)  NOT NULL,
    contact_phone_cipher VARBINARY(512) NULL,
    symptom_summary     VARCHAR(300) NULL,
    status              VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
    queue_number        INT          NULL,
    cancel_reason       VARCHAR(200) NULL,
    idempotency_key     VARCHAR(128) NOT NULL,
    request_digest      VARCHAR(64)  NOT NULL,
    version             INT          NOT NULL DEFAULT 1,
    created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at          DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_appointments_idem (user_id, idempotency_key),
    KEY idx_appointments_user_status_time (user_id, status, created_at),
    KEY idx_appointments_slot (slot_id),
    CONSTRAINT fk_appointments_slot FOREIGN KEY (slot_id) REFERENCES doctor_slots (id),
    CONSTRAINT fk_appointments_doctor FOREIGN KEY (doctor_id) REFERENCES doctors (id),
    CONSTRAINT fk_appointments_department FOREIGN KEY (department_id) REFERENCES departments (id),
    CONSTRAINT fk_appointments_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
