# 六项缺陷修复 Checklist（2026-11-15）

> 对应 spec.md / tasks.md；每项均为可复核的代码或运行证据。

## D1 网络异常重试按钮
- [x] `app.wxss` 存在 `.btn-inline`（inline-flex、min-width 280rpx、不换行），`.btn` 补 `white-space: nowrap`
- [x] appointment / reports / report-detail / picker 四处错误态按钮统一为 `btn btn-primary btn-inline`
- [x] 四处页面 WXSS 不再保留固定行高的自造错误按钮（仅剩 margin）

## D2 AI 问诊规则兜底
- [x] `_onAiFail(err, text)` 对 AI 不可用错误码先输出「暂时无法连接 AI 服务…已切换到院内规则匹配」
- [x] 规则命中主诉 → 复用科室卡；已出过卡 → 文字补规则结论；未命中 → 全科医学科引导
- [x] 非 AI 不可用错误保持原文案；气泡不出现英文错误码（`test-patient-deep-audit` B3/B6 通过）

## D3 AI 导诊
- [x] 导航栏「清空」入口存在，确认后清 `SESSION_KEY` 与 `_consultationId/_asked/_history/_deptPushed` 并重新问候
- [x] 「生成结果」在 THINKING 期间直接 return，且按钮带 `collect-btn-off` 置灰
- [x] 「更多服务」WXML 区块、WXSS 样式、JS 常量与 5 个方法全部移除

## D4 全流程就医提示
- [x] `utils/flow-progress.js#pickFocus` 按状态优先级 + 时间挑选，不再依赖数组末位
- [x] triage / consultation 两页 `_loadProgress` 无条件 `setData`（空列表 `hasFlow:false`）
- [x] `triage.onShow` 已调用 `_loadProgress`（consultation.onShow 亦同）

## D5 内部资料 + 健康档案只读
- [x] 健康档案无上传/删除入口，附件区标注「系统推送资料」
- [x] 包内 `/assets/` 图片点击走自定义全屏浮层 `hrc-viewer`
- [x] 在线问诊 ＋ 面板含「从健康档案选择」，最多 6 条，按 objectKey 发送 `IMAGE`
- [x] `tools/gen-health-push-images.py` 可重复生成两张 JPEG（39.6KB / 42.6KB，均 ≤45KB）

## D6 在线问诊预约制
- [x] `hasDoctorAcceptance` 只认 `role='doctor'` 或含「接诊」的 `system_notice`（AI 回复不算）
- [x] `ConsultationService.send()` 在指定医生会话「已有消息且未接单」时抛 409 `WAITING_ACCEPT`
- [x] 指定医生会话不创建 CHAT AI 任务（避免 AI 气泡冒充医生）
- [x] `consult.wxml` 未接单渲染只读等待条；预约阶段按钮为「提交预约」
- [x] `consult.js` 未接单发送/上传均 toast 拦截
- [x] 首页「我的就医安排」卡展示问诊提示行，已接单按 `lastMessageAt` 写本地已读并可跳转会话

## 回归
- [x] `node tools/check-project.js` 全部通过
- [x] `node tools/test-fe-all.js` 新增失败 0（仅 3 项登记在案历史失败）
- [x] `backend/business-service` `mvnw -o -DskipTests compile` 通过
- [x] `DEV_LOG.md` 尾部已追加本次修复记录
