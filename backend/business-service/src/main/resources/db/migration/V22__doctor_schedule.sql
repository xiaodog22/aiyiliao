-- =====================================================================
-- V22__doctor_schedule.sql —— 医生排班与在线接诊状态（2026-10-22）
--
-- 背景：医生工作台「排班设置」此前是占位（前端 onPlaceholder），契约与代码均无；
--   患者侧也无法判断某医生当前是否在线接诊。本迁移补两张表：
--   1) doctor_schedules     —— 周模板（一名医生一天可有多段），是**排班设置**的唯一事实源；
--   2) doctor_online_status —— 实时在线/接诊开关（单行/医生），患者侧 availability 只读它。
--
-- 口径约定（与契约 DoctorSchedule/DoctorOnlineStatus 一致）：
--   · weekday：1=周一 … 7=周日（ISO-8601）；
--   · start_time/end_time：**本地墙上时间**（不含时区），按部署机时区解释；
--   · slot_minutes：号源粒度，只允许 10/15/20/30/60（应用层校验，库层只保证 >0）；
--   · capacity：每个号源可约人数；
--   · online_only：该时段仅接在线问诊（不生成线下号源）；
--   · version：**医生级**排班版本（同一医生的所有行共享同一值）。整体替换时
--     version = expectedVersion + 1，用于乐观锁；无排班时版本视为 0。
--   · doctor_online_status.version：在线状态自身版本（每次开关 +1），与排班版本互不影响。
-- 生产不回填：排班属医生配置，不臆造默认值（dev 种子见 V9005）。
-- =====================================================================

-- ---------- 1. 周模板 ----------
CREATE TABLE doctor_schedules (
    id           VARCHAR(64)  NOT NULL,
    doctor_id    VARCHAR(64)  NOT NULL,
    weekday      TINYINT      NOT NULL,
    start_time   TIME         NOT NULL,
    end_time     TIME         NOT NULL,
    slot_minutes INT          NOT NULL DEFAULT 30,
    capacity     INT          NOT NULL DEFAULT 1,
    online_only  TINYINT(1)   NOT NULL DEFAULT 0,
    version      INT          NOT NULL DEFAULT 1,
    created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_dsched_doctor_weekday (doctor_id, weekday, start_time),
    CONSTRAINT fk_dsched_doctor FOREIGN KEY (doctor_id) REFERENCES doctors (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------- 2. 在线接诊状态 ----------
-- accepting = 是否愿意接新会话：online=0 时应用层强制置 0（不接受"离线但仍接诊"的脏态）。
CREATE TABLE doctor_online_status (
    doctor_id  VARCHAR(64) NOT NULL,
    online     TINYINT(1)  NOT NULL DEFAULT 0,
    accepting  TINYINT(1)  NOT NULL DEFAULT 0,
    version    INT         NOT NULL DEFAULT 1,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (doctor_id),
    CONSTRAINT fk_donline_doctor FOREIGN KEY (doctor_id) REFERENCES doctors (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
