-- =====================================================================
-- V9000__dev_seed.sql —— M0.3 dev 种子（4 科室 + 医生 + 号源）
-- ⚠️ 仅 dev profile 加载：application.yml 的 spring.flyway.locations 在 dev 下追加 classpath:db/dev，
--    生产（非 dev）只有 classpath:db/migration，本文件不会进入生产迁移。
-- 幂等：ON DUPLICATE KEY UPDATE，可重复执行不报错。
-- 号源：以执行日为基准，每位医生未来 7 天，每天上午/下午各一档（真实时间为 UTC 语义，
--       由 JDBC connectionTimeZone=UTC + forceConnectionTimeZoneToSession 保证）。
-- =====================================================================

-- ---------- 科室（4 个，任务书 M0.3） ----------
INSERT INTO departments (id, hospital_id, name, location, description, icon_key, sort_order)
VALUES
  ('dep-gastro', 'hosp-wechar-dev', '消化内科', '门诊楼 2F 东区',  '擅长胃炎、消化性溃疡、肠易失综合征等常见消化道疾病', 'dept-gastro', 1),
  ('dep-resp',   'hosp-wechar-dev', '呼吸内科', '门诊楼 3F 西区',  '擅长感冒、咳嗽、支气管炎、哮喘等呼吸系统常见病',   'dept-resp',   2),
  ('dep-cardio', 'hosp-wechar-dev', '心血管内科','门诊楼 4F 东区',  '擅长高血压、冠心病、心律失常等心血管疾病随访',     'dept-cardio', 3),
  ('dep-ortho',  'hosp-wechar-dev', '骨科',     '门诊楼 1F 西区',  '擅长颈肩腰腿痛、骨折康复、关节退行性病变',         'dept-ortho',  4)
ON DUPLICATE KEY UPDATE name = VALUES(name), location = VALUES(location),
                        description = VALUES(description), updated_at = CURRENT_TIMESTAMP(3);

-- ---------- 医生（每科室 2 位） ----------
INSERT INTO doctors (id, department_id, name, title, specialties_json, introduction)
VALUES
  ('doc-gastro-1', 'dep-gastro', '林建平', '主任医师', '["胃炎","消化性溃疡","幽门螺杆菌"]', '从事消化内科临床工作 25 年，擅长内镜下诊断与常见消化道疾病规范化治疗。'),
  ('doc-gastro-2', 'dep-gastro', '苏雯',   '副主任医师','["功能性胃肠病","胃肠功能紊乱"]',   '擅长功能性胃肠病的个体化调理与饮食生活方式干预。'),
  ('doc-resp-1',   'dep-resp',   '陈志远', '主任医师', '["慢性咳嗽","支气管哮喘","慢阻肺"]', '从事呼吸内科临床工作 22 年，擅长慢性气道疾病长期管理。'),
  ('doc-resp-2',   'dep-resp',   '黄雅琴', '主治医师', '["上呼吸道感染","肺部感染"]',       '擅长呼吸道感染性疾病的诊断与用药指导。'),
  ('doc-cardio-1', 'dep-cardio', '周明辉', '主任医师', '["高血压","冠心病","心衰随访"]',    '从事心血管内科临床工作 28 年，擅长高血压与冠心病规范化随访。'),
  ('doc-cardio-2', 'dep-cardio', '吴心怡', '副主任医师','["心律失常","心脏康复"]',          '擅长心律失常评估与心脏康复生活方式指导。'),
  ('doc-ortho-1',  'dep-ortho',  '赵国强', '主任医师', '["腰椎间盘突出","颈椎病"]',         '从事骨科临床工作 26 年，擅长颈肩腰腿痛阶梯治疗与康复指导。'),
  ('doc-ortho-2',  'dep-ortho',  '钱佳明', '主治医师', '["运动损伤","骨折康复"]',           '擅长常见运动损伤处理与骨折后康复训练指导。')
ON DUPLICATE KEY UPDATE name = VALUES(name), title = VALUES(title),
                        specialties_json = VALUES(specialties_json),
                        introduction = VALUES(introduction), updated_at = CURRENT_TIMESTAMP(3);

-- ---------- 号源：每位医生未来 7 天 × 上午/下午各一档，capacity 5 ----------
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status)
SELECT
  CONCAT('slot-', d.id, '-', DATE_FORMAT(day.d, '%Y%m%d'), '-am'),
  d.id,
  TIMESTAMP(day.d, '09:00:00'),
  TIMESTAMP(day.d, '09:30:00'),
  5, 5, 25.00, 'CNY', 'OPEN'
FROM doctors d,
     (SELECT CURDATE() + INTERVAL n DAY AS d
      FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3
            UNION SELECT 4 UNION SELECT 5 UNION SELECT 6) nums) day
ON DUPLICATE KEY UPDATE remaining = VALUES(remaining), updated_at = CURRENT_TIMESTAMP(3);

INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status)
SELECT
  CONCAT('slot-', d.id, '-', DATE_FORMAT(day.d, '%Y%m%d'), '-pm'),
  d.id,
  TIMESTAMP(day.d, '14:00:00'),
  TIMESTAMP(day.d, '14:30:00'),
  5, 5, 25.00, 'CNY', 'OPEN'
FROM doctors d,
     (SELECT CURDATE() + INTERVAL n DAY AS d
      FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3
            UNION SELECT 4 UNION SELECT 5 UNION SELECT 6) nums) day
ON DUPLICATE KEY UPDATE remaining = VALUES(remaining), updated_at = CURRENT_TIMESTAMP(3);
