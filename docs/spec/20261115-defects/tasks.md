# 六项缺陷修复 Tasks（2026-11-15）

> 执行顺序：先共享样式/工具，再单页修复，最后后端闸门与首页提示；每步完成后跑最小验证。

## T1 网络异常重试按钮统一（D1）
- [x] `app.wxss`：`.btn` 增加 `padding: 0 32rpx; white-space: nowrap; flex-shrink: 0;`
- [x] `app.wxss`：新增 `.btn-inline`；`.state-btn` 增加 `white-space: nowrap`
- [x] `appointment.wxml/wxss`：`.error-retry` 改用 `.btn.btn-primary.btn-inline`
- [x] `reports.wxml/wxss`：`.rep-state-btn` 改用 `.btn.btn-primary.btn-inline`
- [x] `report-detail.wxml/wxss`：`.rd-state-btn` 改用 `.btn.btn-primary.btn-inline`
- [x] `picker.wxml/wxss`：`.cp-state-btn` 改用 `.btn.btn-primary.btn-inline`
- [x] 验证：`node tools/check-project.js`

## T2 AI 问诊规则兜底（D2）
- [x] `consultation.js`：`_onAiFail(err, text)` 接收原话
- [x] `consultation.js`：AI 不可用错误码集合 → 追加「无法连接」提示 + `triageService.parse(text, {})`
- [x] 有科室：复用 `_pushDeptCard`；无科室：文本引导全科医学科
- [x] 非 AI 不可用错误保持原文案
- [x] 验证：`node --check miniprogram/pages/consultation/consultation.js`

## T3 AI 导诊会话修复（D3）
- [x] `triage.wxml`：nav-right 增加「清空」；删除 `quick-services` 整块
- [x] `triage.wxss`：新增 `.nav-clear`、`.collect-btn-off`；删除 `.quick-services/.qs-item`
- [x] `triage.js`：新增 `onClear`（确认、清 storage、重置状态与实例字段、重新问候）
- [x] `triage.js`：`onForceResult` 加 THINKING 守卫
- [x] `triage.js`：删除 `SERVICE_MENU / onServices / onQuickBook / onQuickReport / onQuickNav / onAllServices`
- [x] 验证：`node --check` + 手点「清空」/连点「生成结果」

## T4 全流程就医提示（D4）
- [x] 新增 `utils/flow-progress.js`：`pickFocus(list)` + `buildProgress(list, title)`
- [x] `triage.js`：改用工具；`onShow` 调 `_loadProgress`
- [x] `consultation.js`：改用工具；空列表清空 `hasFlow`
- [x] 验证：`node --check` 两个页面 + `node tools/check-project.js`

## T5 在线问诊内部资料 + 健康档案系统推送（D5）
- [x] `consult.js`：动作面板加「从健康档案选择」
- [x] `consult.js`：新增 `_pickFromHealthRecords()`（最多 6 条，发送 objectKey）
- [x] `health-records.wxml`：删除上传入口与删除按钮，附件标题「系统推送资料」，新增全屏查看浮层
- [x] `health-records.wxss`：新增浮层与推送标题样式
- [x] `health-records.js`：删除上传/删除方法；`normalize` 支持 `bundle` 路径；本地图片走浮层
- [x] `mock-data.js`：`HEALTH_RECORDS.reports` 增加两条系统推送附件
- [x] 新增 `tools/gen-health-push-images.py` 并生成两张 JPEG（≤45KB/张）
- [x] 验证：`python -m py_compile` + `node --check` + `node tools/check-project.js`（主包体积）

## T6 在线问诊预约-接单后端闸门（D6 后端）
- [x] `ConsultationRepository` 新增 `hasDoctorAcceptance(id)`
- [x] `ConsultationService`：会话映射、`accept()` 改用医生接单判定
- [x] `ConsultationService.send()`：未接单且已有首条消息 → 409 `WAITING_ACCEPT`
- [x] 验证：`mvnw -o -DskipTests compile`（运行中 jar 被占用，repackage 跳过）

## T7 在线问诊预约-接单前端 + 首页提示（D6 前端）
- [x] `consult.wxml`：预约阶段按钮「提交预约」/placeholder 调整
- [x] `consult.wxml`：已预约未接单 → 只读等待条；接单后恢复输入栏
- [x] `consult.js`：`onSend / onPickAttach` 未接单守卫 + toast
- [x] `home.js`：`onShow` 拉 `listMyConsultations()`，生成 `consultNotice`
- [x] `home.wxml/wxss`：就医安排卡片内新增问诊提示行
- [x] `home.js`：点击跳转 + 已接单本地已读标记
- [x] 验证：`node --check` + `node tools/check-project.js`

## T8 回归与日志
- [x] `node tools/test-fe-all.js`（新增失败 0，仅 3 项登记在案历史失败）
- [x] 手工验收清单（见 spec.md §4）
- [x] `DEV_LOG.md` 尾部追加一条
