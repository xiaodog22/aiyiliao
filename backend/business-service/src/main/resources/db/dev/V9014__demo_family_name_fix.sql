-- V9014__demo_family_name_fix.sql —— 演示就诊人「姓名被写成关系」修正（D-08）
--
-- 背景：u-dev-user-1 的 MOTHER 记录 display_name 存的是关系词「母亲」，
--      页面「就诊人管理」里姓名与关系标签都显示「母亲」，疑似姓名取了关系字段。
-- 口径：姓名与关系是两个字段，姓名必须是可称呼的姓名（演示数据用虚构姓名），
--      关系只用于关系标签。只按 user_id + relation + 旧值三重限定，不误改真实数据。
-- 幂等：重复执行时 display_name 已不是旧值 → 命中 0 行，无副作用。

UPDATE family_members
SET display_name = '李秀兰'
WHERE user_id = 'u-dev-user-1'
  AND relation = 'MOTHER'
  AND display_name IN ('母亲', '妈', '妈妈');
