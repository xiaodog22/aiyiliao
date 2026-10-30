-- =====================================================================
-- V9003__frontend_contract_seed.sql —— 前端数据依赖 dev 种子（2026-10-17）
-- ⚠️ 仅 dev profile 加载（application.yml 在 dev 追加 classpath:db/dev）。
-- 幂等：ON DUPLICATE KEY UPDATE / 定向 UPDATE，可重复执行。
-- 内容：
--   1) 科室目录对齐前端 triage-kb（15 个可挂号科室 + 急诊科 INACTIVE），补结构化楼层；
--   2) 新科室各 2 位医生 + 未来 7 天号源（沿用 V9000 口径，仅新医生）；
--   3) 科普内容对齐前端 knowledge-kb（6 图文 + 3 视频），旧 dev 示例置 RETIRED；
--   4) 预约地点快照回填（科室楼层已调整，需重算）；
--   5) /me 的性别与出生日期、家庭成员性别、档案来源与异常标记回填。
-- 红线：只写开发演示数据，不进入生产迁移（生产仅 classpath:db/migration）。
-- =====================================================================

-- ---------- 1. 科室：4 个既有科室补结构化位置（楼层与 packageNav 平面图对齐：均在门诊楼 1F） ----------
UPDATE departments SET hospital_name = '示例互联网医院',
    building = '门诊楼', floor = '1F', area = '东区', room_no = NULL,
    location = '门诊楼 1F 东区', updated_at = CURRENT_TIMESTAMP(3)
WHERE id = 'dep-gastro';

UPDATE departments SET hospital_name = '示例互联网医院',
    building = '门诊楼', floor = '1F', area = '西区', room_no = NULL,
    location = '门诊楼 1F 西区', updated_at = CURRENT_TIMESTAMP(3)
WHERE id = 'dep-resp';

UPDATE departments SET hospital_name = '示例互联网医院',
    building = '门诊楼', floor = '1F', area = '东区', room_no = NULL,
    location = '门诊楼 1F 东区', updated_at = CURRENT_TIMESTAMP(3)
WHERE id = 'dep-cardio';

UPDATE departments SET hospital_name = '示例互联网医院',
    building = '门诊楼', floor = '1F', area = '西区', room_no = NULL,
    location = '门诊楼 1F 西区', updated_at = CURRENT_TIMESTAMP(3)
WHERE id = 'dep-ortho';

-- ---------- 1b. 新增 11 个可挂号科室（与前端 DEPARTMENT_INFO 的临床科室对齐） ----------
INSERT INTO departments (id, hospital_id, hospital_name, name, location, building, floor, area, room_no,
                         description, icon_key, sort_order, status)
VALUES
  ('dep-ped',     'hosp-wechar-dev', '示例互联网医院', '儿科诊区',   '门诊楼 1F 东区', '门诊楼', '1F', '东区', NULL,
   '儿童常见病、生长发育、发热咳嗽腹泻等', 'dept-ped', 5, 'ACTIVE'),
  ('dep-gp',      'hosp-wechar-dev', '示例互联网医院', '全科医学科', '门诊楼 1F 大厅', '门诊楼', '1F', '大厅', NULL,
   '症状不典型、乏力不适、多种症状并存、暂不确定科室时首选', 'dept-gp', 6, 'ACTIVE'),
  ('dep-derm',    'hosp-wechar-dev', '示例互联网医院', '皮肤科',     '门诊楼 2F 东区', '门诊楼', '2F', '东区', NULL,
   '皮疹、湿疹、荨麻疹、痤疮、脱发、皮肤瘙痒等', 'dept-derm', 7, 'ACTIVE'),
  ('dep-oph',     'hosp-wechar-dev', '示例互联网医院', '眼科',       '门诊楼 2F 西区', '门诊楼', '2F', '西区', NULL,
   '眼红眼痛、视力下降、流泪、干眼等', 'dept-oph', 8, 'ACTIVE'),
  ('dep-ent',     'hosp-wechar-dev', '示例互联网医院', '耳鼻喉科',   '门诊楼 2F 东区', '门诊楼', '2F', '东区', NULL,
   '耳痛耳鸣、鼻塞鼻出血、咽痛声嘶、扁桃体炎等', 'dept-ent', 9, 'ACTIVE'),
  ('dep-dental',  'hosp-wechar-dev', '示例互联网医院', '口腔科',     '门诊楼 2F 西区', '门诊楼', '2F', '西区', NULL,
   '牙痛、牙龈出血、口腔溃疡、拔牙修复等', 'dept-dental', 10, 'ACTIVE'),
  ('dep-neuro',   'hosp-wechar-dev', '示例互联网医院', '神经内科',   '门诊楼 3F 东区', '门诊楼', '3F', '东区', NULL,
   '头痛头晕、眩晕、手脚麻木、面瘫、失眠（非精神因素）等', 'dept-neuro', 11, 'ACTIVE'),
  ('dep-endo',    'hosp-wechar-dev', '示例互联网医院', '内分泌科',   '门诊楼 3F 西区', '门诊楼', '3F', '西区', NULL,
   '糖尿病、甲状腺疾病、多饮多尿、体重异常变化等', 'dept-endo', 12, 'ACTIVE'),
  ('dep-uro',     'hosp-wechar-dev', '示例互联网医院', '泌尿外科',   '门诊楼 3F 东区', '门诊楼', '3F', '东区', NULL,
   '尿频尿急尿痛、排尿困难、泌尿系结石等', 'dept-uro', 13, 'ACTIVE'),
  ('dep-obgyn',   'hosp-wechar-dev', '示例互联网医院', '妇产科',     '门诊楼 4F 东区', '门诊楼', '4F', '东区', NULL,
   '月经异常、白带异常、痛经、孕产保健等', 'dept-obgyn', 14, 'ACTIVE'),
  ('dep-psych',   'hosp-wechar-dev', '示例互联网医院', '精神心理科', '门诊楼 4F 西区', '门诊楼', '4F', '西区', NULL,
   '失眠、焦虑、情绪低落、压力相关躯体不适等', 'dept-psych', 15, 'ACTIVE')
ON DUPLICATE KEY UPDATE hospital_name = VALUES(hospital_name), name = VALUES(name),
                        location = VALUES(location), building = VALUES(building), floor = VALUES(floor),
                        area = VALUES(area), description = VALUES(description),
                        sort_order = VALUES(sort_order), status = VALUES(status),
                        updated_at = CURRENT_TIMESTAMP(3);

-- 急诊科：绿色通道独立入口，不参与门诊挂号 → INACTIVE（不出现在 /departments 可约目录）。
INSERT INTO departments (id, hospital_id, hospital_name, name, location, building, floor, area, room_no,
                         description, icon_key, sort_order, status)
VALUES ('dep-emergency', 'hosp-wechar-dev', '示例互联网医院', '急诊科', '门诊楼 1F 急诊区',
        '门诊楼', '1F', '急诊区', NULL,
        '胸痛、卒中、呼吸困难、大出血、意识障碍等急危重症的绿色通道（直接前往，不预约）',
        'dept-emergency', 99, 'INACTIVE')
ON DUPLICATE KEY UPDATE location = VALUES(location), building = VALUES(building), floor = VALUES(floor),
                        area = VALUES(area), description = VALUES(description), status = VALUES(status),
                        updated_at = CURRENT_TIMESTAMP(3);

-- ---------- 2. 新科室医生（每科 2 位） ----------
INSERT INTO doctors (id, department_id, name, title, specialties_json, introduction)
VALUES
  ('doc-ped-1',    'dep-ped',    '许安然', '主任医师',  '["儿童常见病","儿童生长发育"]', '从事儿科临床工作 20 年，擅长儿童常见病与生长发育评估。'),
  ('doc-ped-2',    'dep-ped',    '蔡小雨', '主治医师',  '["儿童呼吸道感染","儿童腹泻"]', '擅长儿童呼吸道与消化道常见病的规范化诊治。'),
  ('doc-gp-1',     'dep-gp',     '郑文清', '主任医师',  '["未分化症状","慢病综合管理"]', '从事全科医学工作 18 年，擅长症状不典型时的综合评估与转诊。'),
  ('doc-gp-2',     'dep-gp',     '方晓东', '主治医师',  '["常见病首诊","健康咨询"]',     '擅长常见病首诊分流与健康生活方式指导。'),
  ('doc-derm-1',   'dep-derm',   '林静',   '副主任医师','["湿疹","荨麻疹","痤疮"]',      '擅长过敏性皮肤病与痤疮的规范化治疗与护理指导。'),
  ('doc-derm-2',   'dep-derm',   '罗嘉',   '主治医师',  '["皮肤瘙痒","脱发"]',           '擅长常见皮肤瘙痒与脱发的评估和日常护理指导。'),
  ('doc-oph-1',    'dep-oph',    '陈明',   '主任医师',  '["干眼","白内障"]',             '从事眼科临床工作 24 年，擅长干眼与白内障的评估。'),
  ('doc-oph-2',    'dep-oph',    '谢婉',   '主治医师',  '["视力下降","眼红眼痛"]',       '擅长常见眼表疾病与视力下降的初筛。'),
  ('doc-ent-1',    'dep-ent',    '黄立',   '副主任医师','["鼻窦炎","咽炎"]',             '擅长鼻窦炎、咽炎的规范化诊治。'),
  ('doc-ent-2',    'dep-ent',    '许晴',   '主治医师',  '["耳鸣","扁桃体炎"]',           '擅长耳鸣评估与扁桃体炎的诊疗指导。'),
  ('doc-dental-1', 'dep-dental', '王皓',   '副主任医师','["牙体牙髓","牙周病"]',         '擅长牙体牙髓病与牙周病的综合治疗。'),
  ('doc-dental-2', 'dep-dental', '李岚',   '主治医师',  '["口腔溃疡","拔牙修复"]',       '擅长口腔黏膜疾病与拔牙后修复指导。'),
  ('doc-neuro-1',  'dep-neuro',  '张启明', '主任医师',  '["头痛","眩晕","脑血管病随访"]', '从事神经内科临床工作 26 年，擅长头痛眩晕与脑血管病随访。'),
  ('doc-neuro-2',  'dep-neuro',  '刘颖',   '副主任医师','["手脚麻木","面瘫"]',           '擅长周围神经病与面神经麻痹的评估。'),
  ('doc-endo-1',   'dep-endo',   '吴承志', '主任医师',  '["糖尿病","甲状腺疾病"]',       '从事内分泌临床工作 23 年，擅长糖尿病与甲状腺疾病长期管理。'),
  ('doc-endo-2',   'dep-endo',   '周敏',   '主治医师',  '["体重异常","多饮多尿"]',       '擅长代谢异常初筛与生活方式干预指导。'),
  ('doc-uro-1',    'dep-uro',    '何建国', '主任医师',  '["泌尿系结石","前列腺疾病"]',   '从事泌尿外科临床工作 25 年，擅长结石与前列腺疾病诊治。'),
  ('doc-uro-2',    'dep-uro',    '邓宇',   '主治医师',  '["尿路感染","排尿困难"]',       '擅长尿路感染与排尿困难的评估处理。'),
  ('doc-obgyn-1',  'dep-obgyn',  '苏慧',   '主任医师',  '["月经异常","孕产保健"]',       '从事妇产科临床工作 27 年，擅长月经异常与孕产期保健。'),
  ('doc-obgyn-2',  'dep-obgyn',  '庄雅',   '副主任医师','["妇科炎症","痛经"]',           '擅长妇科炎症与痛经的规范化诊治。'),
  ('doc-psych-1',  'dep-psych',  '林知远', '副主任医师','["失眠","焦虑"]',               '擅长失眠与焦虑的评估及非药物干预指导。'),
  ('doc-psych-2',  'dep-psych',  '高宁',   '主治医师',  '["情绪低落","压力相关不适"]',   '擅长情绪问题的初筛与心理支持。')
ON DUPLICATE KEY UPDATE department_id = VALUES(department_id), name = VALUES(name), title = VALUES(title),
                        specialties_json = VALUES(specialties_json),
                        introduction = VALUES(introduction), updated_at = CURRENT_TIMESTAMP(3);

-- ---------- 2b. 新医生号源：未来 7 天 × 上午/下午各一档（不触碰既有 8 位医生的余号） ----------
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
WHERE d.id IN ('doc-ped-1','doc-ped-2','doc-gp-1','doc-gp-2','doc-derm-1','doc-derm-2',
               'doc-oph-1','doc-oph-2','doc-ent-1','doc-ent-2','doc-dental-1','doc-dental-2',
               'doc-neuro-1','doc-neuro-2','doc-endo-1','doc-endo-2','doc-uro-1','doc-uro-2',
               'doc-obgyn-1','doc-obgyn-2','doc-psych-1','doc-psych-2')
ON DUPLICATE KEY UPDATE remaining = remaining, updated_at = CURRENT_TIMESTAMP(3);

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
WHERE d.id IN ('doc-ped-1','doc-ped-2','doc-gp-1','doc-gp-2','doc-derm-1','doc-derm-2',
               'doc-oph-1','doc-oph-2','doc-ent-1','doc-ent-2','doc-dental-1','doc-dental-2',
               'doc-neuro-1','doc-neuro-2','doc-endo-1','doc-endo-2','doc-uro-1','doc-uro-2',
               'doc-obgyn-1','doc-obgyn-2','doc-psych-1','doc-psych-2')
ON DUPLICATE KEY UPDATE remaining = remaining, updated_at = CURRENT_TIMESTAMP(3);

-- ---------- 3. 科普内容（6 图文 + 3 视频，与 knowledge-kb.js 对齐） ----------
UPDATE contents SET review_status = 'RETIRED', updated_at = CURRENT_TIMESTAMP(3)
WHERE id IN ('cont-dev-001', 'cont-dev-002', 'cont-dev-003');

INSERT INTO contents (id, title, summary, category, body, source, reviewer, cover_key,
                      content_type, cover_url, video_url, duration_sec, read_time_sec,
                      review_status, provenance, effective_from, published_at, read_count)
VALUES
  ('cont-bp-daily', '高血压患者的一天：这 5 个时间点要留意',
   '血压不是一整天都一样的。管好起床、吃药、吃饭、运动、睡前这 5 个节点，比单纯加药更有效。',
   '慢病管理',
   '起床别猛坐起，先躺 30 秒、坐 30 秒再站；服药前静坐 5 分钟后测一次血压。固定时间吃药，漏服不要补双倍剂量。全天盐控制在 5 克以内，少喝咸汤、少吃咸菜腊味。下午快走 30 分钟左右，避开清晨血压最高的时段。睡前再测一次并记录。血压 ≥180/110，或伴胸痛、说话不清、一侧无力，请立刻就医。',
   '院内宣传科', 'dev-reviewer', NULL,
   'ARTICLE', NULL, NULL, NULL, 180,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-09-08 02:00:00.000', 320),

  ('cont-diabetes-diet', '糖尿病饮食：把「一碗饭」换成「三个拳头」',
   '不用称重、不用记卡路里，用手就能量出每餐该吃多少。',
   '慢病管理',
   '每餐主食一个拳头、蛋白一个拳头、蔬菜两个拳头。吃饭顺序建议先吃菜、再吃肉蛋、最后吃主食，血糖更平稳。少喝粥、少喝含糖饮料，果汁不等于水果。出现心慌、出汗、手抖时先测血糖，再决定是否进食含糖食物。饮食调整不能替代降糖药物，用药方案请遵医嘱。',
   '院内宣传科', 'dev-reviewer', NULL,
   'ARTICLE', NULL, NULL, NULL, 180,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-09-05 02:00:00.000', 280),

  ('cont-cold-vs-flu', '普通感冒还是流感？看这 4 点就够了',
   '症状位置、起病速度、发热程度、全身酸痛，四点帮你初步分辨。',
   '日常防护',
   '普通感冒多以鼻塞流涕咽痛为主，起病较缓，发热不高；流感常突然高热、全身酸痛明显、乏力重。无论哪种，出现持续高热超过 3 天、呼吸困难、胸痛、意识改变，都应及时就医。日常勤洗手、通风，流行季少去人群密集场所。',
   '院内宣传科', 'dev-reviewer', NULL,
   'ARTICLE', NULL, NULL, NULL, 120,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-09-02 02:00:00.000', 260),

  ('cont-fall-prevent', '家里这 6 个地方，最容易让老人跌倒',
   '床边、卫生间、厨房、阳台、楼梯、门口，逐处排查就能挡掉大多数意外。',
   '老年照护',
   '床边放小夜灯，起夜别摸黑走；卫生间铺防滑垫并装扶手；厨房地面保持干燥，油渍及时清理；阳台不要堆放杂物；楼梯两侧装扶手、台阶贴防滑条；门口换鞋处放稳固的座椅。正在服用降压药、安眠药的老人，起床和起身都要慢。',
   '院内宣传科', 'dev-reviewer', NULL,
   'ARTICLE', NULL, NULL, NULL, 180,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-08-28 02:00:00.000', 240),

  ('cont-drug-safety', '这些药别一起吃：常见用药冲突清单',
   '多种药一起吃之前，先让医生或药师核一遍。',
   '用药安全',
   '常见需要留意的组合包括：部分止痛药与抗凝药同用会增加出血风险；多种含相同成分的感冒药同服可能造成重复用药；部分抗生素与含钙、镁、铝的制剂同服会影响吸收。就诊时请带上正在服用的全部药品（含保健品），由医生或药师核对。不要自行停药、加量或换药。',
   '院内药剂科', 'dev-reviewer', NULL,
   'ARTICLE', NULL, NULL, NULL, 180,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-08-25 02:00:00.000', 300),

  ('cont-report-read', '体检报告上的「箭头」，哪些要当真',
   '不是所有箭头都代表生病，关键看偏离程度和是否持续。',
   '就医指导',
   '轻度偏离且无其他异常时，医生通常会建议复查而非立即治疗。需要重视的情况包括：指标明显偏离参考范围、连续两次复查仍异常、伴随相应症状，或涉及肝肾功能、血糖、血脂等关键指标。拿到报告后建议由医生结合病史解读，不要仅凭箭头自行用药。',
   '院内体检中心', 'dev-reviewer', NULL,
   'ARTICLE', NULL, NULL, NULL, 180,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-08-20 02:00:00.000', 210),

  ('cont-wash-hands', '七步洗手法',
   '每一步都要搓到位，全程不少于 20 秒。',
   '日常防护',
   '用流动水，先把手打湿再涂洗手液；按七步法依次搓掌心、手背、指缝、指背、拇指、指尖、手腕；最后用流动水冲净并擦干。饭前便后、外出回来、护理老人前后都要洗。没有流动水时，可用免洗手消毒液搓够 20 秒。',
   '院内宣传科', 'dev-reviewer', NULL,
   'VIDEO', '/api/gw/assets/wash-hands.jpg', '/api/gw/assets/wash-hands.mp4', 11, NULL,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-09-10 02:00:00.000', 410),

  ('cont-measure-bp', '在家量血压 4 个要点',
   '姿势不对，数值可能偏高 10~20mmHg。',
   '慢病管理',
   '固定每天同一时间测量；坐着量，不要躺着量；测量前安静休息 5 分钟，测量前 30 分钟别喝茶、别吸烟；袖带与心脏平齐，每次测 2 次取平均并记录。复诊时把记录带给医生。',
   '院内宣传科', 'dev-reviewer', NULL,
   'VIDEO', '/api/gw/assets/measure-bp.jpg', '/api/gw/assets/measure-bp.mp4', 11, NULL,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-09-10 02:10:00.000', 390),

  ('cont-stand-up', '起床三步曲（防跌倒）',
   '躺 30 秒、坐 30 秒、再站 30 秒，能挡掉大多数起床头晕跌倒。',
   '老年照护',
   '醒来后先躺 30 秒，再慢慢坐起坐 30 秒，最后扶稳站立 30 秒再走动。床头放一盏小夜灯，起夜别摸黑走；床边、卫生间装扶手，地面保持干燥。正在吃降压药、安眠药的老人，起床更要慢。',
   '院内宣传科', 'dev-reviewer', NULL,
   'VIDEO', '/api/gw/assets/stand-up.jpg', '/api/gw/assets/stand-up.mp4', 11, NULL,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-09-10 02:20:00.000', 350)
ON DUPLICATE KEY UPDATE title = VALUES(title), summary = VALUES(summary), category = VALUES(category),
                        body = VALUES(body), source = VALUES(source),
                        content_type = VALUES(content_type), cover_url = VALUES(cover_url),
                        video_url = VALUES(video_url), duration_sec = VALUES(duration_sec),
                        read_time_sec = VALUES(read_time_sec), review_status = VALUES(review_status),
                        effective_from = VALUES(effective_from), published_at = VALUES(published_at),
                        updated_at = CURRENT_TIMESTAMP(3);

-- ---------- 4. 预约地点快照回填（科室楼层已按平面图修正） ----------
UPDATE appointments SET location = (SELECT d.location FROM departments d WHERE d.id = appointments.department_id);
UPDATE appointments SET hospital_name = (SELECT d.hospital_name FROM departments d WHERE d.id = appointments.department_id)
WHERE hospital_name IS NULL OR hospital_name = '';

-- ---------- 5. /me 性别与出生日期（dev 演示账号） ----------
UPDATE user_profiles SET sex = 'MALE', birth_date = '1962-05-12', updated_at = CURRENT_TIMESTAMP(3)
WHERE user_id = 'u-dev-user-1';
UPDATE user_profiles SET sex = 'FEMALE', birth_date = '1985-11-03', updated_at = CURRENT_TIMESTAMP(3)
WHERE user_id = 'u-dev-user-2';

-- ---------- 5b. 家庭成员性别（按关系推断，仅补 NULL 行） ----------
UPDATE family_members SET gender = 'FEMALE'
WHERE gender IS NULL AND relation IN ('MOTHER', '母亲', '妻子', '配偶', '女儿');
UPDATE family_members SET gender = 'MALE'
WHERE gender IS NULL AND relation IN ('FATHER', '父亲', '丈夫', '儿子');

-- ---------- 5c. 健康档案来源与异常标记（按类目/记录值回填，不臆造异常） ----------
UPDATE health_records SET source = '院内检验科'
WHERE source IS NULL AND category = 'EXAM';
UPDATE health_records SET source = '门诊病历'
WHERE source IS NULL AND category = 'HISTORY';
UPDATE health_records SET source = '门诊药房'
WHERE source IS NULL AND category = 'MEDICATION';
UPDATE health_records SET source = '健康监测'
WHERE source IS NULL AND category = 'VITALS';
UPDATE health_records SET source = '过敏原检测'
WHERE source IS NULL AND category = 'ALLERGY';
UPDATE health_records SET source = '门诊记录'
WHERE source IS NULL AND category = 'OTHER';
-- 仅当记录值本身是"收缩压/舒张压"形态且落在常见正常区间时才标记正常，其余保持 NULL（未判定）。
UPDATE health_records SET abnormal = 0
WHERE abnormal IS NULL AND category = 'VITALS'
  AND summary REGEXP '^[0-9]{2,3}/[0-9]{2,3}$'
  AND CAST(SUBSTRING_INDEX(summary, '/', 1) AS UNSIGNED) BETWEEN 90 AND 139
  AND CAST(SUBSTRING_INDEX(summary, '/', -1) AS UNSIGNED) BETWEEN 60 AND 89;
