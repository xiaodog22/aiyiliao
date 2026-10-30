-- =====================================================================
-- V9001__m1_dev_seed.sql —— M1 dev 种子（内容目录少量条目）
-- ⚠️ 仅 dev profile 加载（application.yml spring.flyway.locations 在 dev 追加 classpath:db/dev）。
-- 幂等：ON DUPLICATE KEY UPDATE，可重复执行。
-- 说明：只有 review_status='APPROVED' 且在有效期内的条目才对用户可见（契约 /contents）。
--      生产内容由运营/医学审核走正式流程导入，不依赖本文件。
-- =====================================================================

INSERT INTO contents (id, title, summary, category, body, source, reviewer, cover_key,
                      review_status, provenance, effective_from, published_at, read_count)
VALUES
  ('cont-dev-001', '秋季润肺：日常养护三要点', '秋季干燥，日常起居与饮食的润肺养护建议。',
   '呼吸养护',
   '秋季空气干燥，容易出现咽干、干咳。日常可注意：一、保持室内湿度，避免长时间待在空调出风口；二、适量饮水，饮食以清淡滋润为主；三、规律作息，避免熬夜。若咳嗽持续超过两周或伴有发热、胸痛，请及时就医。',
   '内部医学审核资料（dev 示例）', 'dev-reviewer', NULL,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-10-01 02:00:00.000', 120),

  ('cont-dev-002', '胃部不适先看消化内科：常见症状自查', '饭后胀痛、反酸烧心该挂哪个科？',
   '消化健康',
   '反复的饭后胀痛、反酸、烧心，通常先到消化内科就诊。就诊前可简单记录：症状出现的时间、与进食的关系、加重或缓解的因素。若出现呕血、黑便或剧烈腹痛，请立即急诊就医。',
   '内部医学审核资料（dev 示例）', 'dev-reviewer', NULL,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-10-01 02:10:00.000', 98),

  ('cont-dev-003', '高血压随访：家庭测量的正确姿势', '家庭自测血压的常见误区。',
   '心血管健康',
   '家庭自测血压建议：测量前安静休息 5 分钟，取坐位，袖带与心脏平齐；每次测量 2 次取平均；固定时间段记录并带给医生参考。不要因为一两次读数偏高就自行加药，用药调整必须由医生决定。',
   '内部医学审核资料（dev 示例）', 'dev-reviewer', NULL,
   'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2026-10-01 02:20:00.000', 210),

  ('cont-dev-004', '草稿：未经审核的养生说法（dev 演示不可见）', '演示 DRAFT 不出现在列表。',
   '演示',
   '这是 dev 环境中用于演示"未通过审核的内容不出现在 /contents 列表"的草稿条目。',
   NULL, NULL, NULL,
   'DRAFT', 'HUMAN_REVIEWED', NULL, NULL, 0)
ON DUPLICATE KEY UPDATE title = VALUES(title), summary = VALUES(summary),
                        body = VALUES(body), updated_at = CURRENT_TIMESTAMP(3);
