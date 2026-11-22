-- =====================================================================
-- V9021__easter_egg_master_data_map.sql —— 彩蛋角色主数据映射补齐（2026-11-22）
--
-- 背景：V9018 建了平台医生 doc-emergency-1（马义童），V9019 放开了急诊号源；
-- clinic-his 侧也已有 JZ/急诊科、D010/马义童、XH/消化内科、D009/林建平。
-- 但 his_master_data_map 里没有这两组映射，平台受理时会走「演示兜底 D001/QK」，
-- 导致挂号落到全科、院内号源扣的是别人的号 —— 表现为「小程序挂号后 HIS 余号不变」。
--
-- 口径：这两组映射由业务在 2026-11-22 明确指定（彩蛋演示角色），故置 CONFIRMED。
-- 幂等：唯一键 (entity_type, platform_id)，冲突则覆盖为最新值。
-- =====================================================================

INSERT INTO his_master_data_map (entity_type, platform_id, his_id, status, note) VALUES
('DEPARTMENT', 'dep-gastro',    'XH', 'CONFIRMED', '演示彩蛋：消化内科（HIS XH）'),
('DEPARTMENT', 'dep-emergency', 'JZ', 'CONFIRMED', '演示彩蛋：急诊科（HIS JZ）'),
('DOCTOR',     'doc-gastro-1',    'D009', 'CONFIRMED', '演示彩蛋：林建平（HIS D009）'),
('DOCTOR',     'doc-emergency-1', 'D010', 'CONFIRMED', '演示彩蛋：马义童（HIS D010）')
ON DUPLICATE KEY UPDATE
    his_id = VALUES(his_id),
    status = VALUES(status),
    note = VALUES(note),
    updated_at = CURRENT_TIMESTAMP(3);
