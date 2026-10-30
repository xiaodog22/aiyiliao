-- =====================================================================
-- V9009__cleanup_fake_seed.sql —— 清理伪造演示问诊链（2026-10-24）
-- ⚠️ 仅 dev profile 加载（application.yml 在 dev 追加 classpath:db/dev）；不进入生产迁移。
-- ⚠️ 背景：V9004/V9006 种子的「胃痛反酸咨询」会话（cons-dev-001 + cmsg-dev-001）
--    与消息（msg-doc-apply-001 / msg-dev-001 / msg-dev-002）是**直接写库的伪造数据**，
--    患者端从未实际发送，医生端消息中心/问诊列表会优先显示它，误导联调与演示
--    （用户反馈：医生端看到"患者端没有发送的胃疼反酸询问"）。
--    本迁移把这些伪造行删除；真实链路数据（张三 10-25 挂号、真实问诊会话）不受影响。
-- 幂等：DELETE 无副作用，可重复执行。
-- =====================================================================

-- 1. 伪造问诊会话链（cons-dev-001：胃痛反酸咨询 + 其消息）
DELETE FROM consultation_messages WHERE consultation_id = 'cons-dev-001';
DELETE FROM consultations WHERE id = 'cons-dev-001';

-- 2. 伪造消息中心行（医生端"患者在线问诊申请" + 患者端"挂号成功/医生已叫号"，均引用不存在的 ap-dev-demo-001）
DELETE FROM messages WHERE id IN ('msg-doc-apply-001', 'msg-dev-001', 'msg-dev-002');
