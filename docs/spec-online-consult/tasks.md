# 任务清单 v2：线上问诊同步 / 上传合规 / 延迟 + 历史 5 项

> 对应 `docs/spec-online-consult/spec.md` v2。按序执行，完成即勾选。

## 阶段 0：回归确认（历史项已改代码，先验证再动刀）

- [x] T0.1 `node --check` 跑 `triage.js / triage-engine.js / consultation.js`，确认既有改动可运行
- [x] T0.2 静态确认 `triage.js` 存在 `generated` 幂等闸门与 `navSafeRight`；`.nav-clear` 胶囊触控区存在

## 阶段 1：B2 后端白名单（最高优先级）

- [x] T1.1 `backend/.../patient/AttachmentRepository.java`
  - 新增 `Optional<AttachmentRow> findByObjectKeyAndUser(String objectKey, String userId)`（SQL 双条件）
- [x] T1.2 `backend/.../consultation/dto/MessageData.java`
  - 追加 `String attachmentUrl, String attachmentName, String attachmentMime, Long attachmentSize`
- [x] T1.3 `backend/.../consultation/ConsultationService.java`
  - 注入 `AttachmentRepository`、`AttachmentStorage`
  - 新增 `validateImageContent(userId, content)`：归属 + MIME 白名单 `image/jpeg|image/png|image/webp` + `<=10MB`，失败 422 `ATTACHMENT_NOT_ALLOWED`
  - `send()`：`IMAGE` 模式先校验，`contentType=IMAGE_NOTE`
  - `create()`：`initialMessage` 为 IMAGE 时同规则
  - `toData(MessageRow)`：`IMAGE_NOTE` 用 `findByObjectKeyAndUser(content, row.userId())` 补附件字段 + `signedUrl`
- [x] T1.4 `backend/.../patient/AttachmentStorage.java`
  - `signedUrl(objectKey, ttl)` 过期时间按 300s 窗口取整

## 阶段 2：B2 患者端收口

- [x] T2.1 `miniprogram/pages/consult/consult.js`
  - `onPickAttach` 直接调 `_pickFromHealthRecords()`，删除 4 项 ActionSheet
  - 删除 `_pickImage`、`_pickFile`、`_uploadAndSend`
  - `_pickFromHealthRecords`：MIME 白名单 + 大小 + objectKey 校验，收集 recordId/attachmentId
  - `_sendRecordAttachment`：二次校验、`inputMode:'IMAGE'`、`_fileMeta` 写 name/size/url
  - `_normMessage` IMAGE_NOTE：优先服务端附件字段

## 阶段 3：B1/B3 同步与延迟

- [x] T3.1 患者端 `consult.js`
  - `POLL_INTERVAL 4000→2000`（短轮询 + `_liveTick` 同源）、`POLL_MAX 12→24`
  - `onShow`：`_stopLive()` 后立即 `_liveTick()`
  - `onSendText`：乐观插入本地气泡；失败移除 + 恢复输入；`_lastSendKey` 失败复用、成功清空
  - 图片发送：乐观 `kind:'file'` 气泡 + 失败移除 + 同一幂等键策略
- [x] T3.2 医生端 `miniprogram/pages/doctor/consult/consult.js`
  - `CHAT_POLL 4000→2000`、`LIST_POLL 8000→4000`
  - `onShow` 列表模式立即 `loadList(true)`（避免重复请求）
  - `_normMessages` 支持 `IMAGE_NOTE → kind:'image'`（url/name）
  - 新增 `onPreviewMessageImage`
- [x] T3.3 医生端 `consult.wxml`
  - 患者气泡分支按 `kind==='image'` 渲染缩略图 + 文件名，点击预览

## 阶段 4：③ 全流程就医提示

- [x] T4.1 `miniprogram/utils/flow-progress.js`
  - `buildProgress(list, title, consult)`：无预约 + ACTIVE 问诊 → step 1/2 + 文案
- [x] T4.2 `miniprogram/pages/consultation/consultation.js`
  - `_loadProgress` 并行拉预约 + 问诊（各自 catch 静默）
  - `onShow` / 发送成功 / 分诊结论后刷新
  - 页面可见且存在 ACTIVE 问诊时 10s 轻量刷新；`onHide/onUnload` 清定时器

## 阶段 5：④ 我的问诊字号

- [x] T5.1 `miniprogram/pages/profile/consultations/consultations.wxss`
  - `.qc-title` → `var(--font-title)`
  - `.qc-date` → `var(--font-body)`
  - `.qc-brief` → `var(--font-body)`
  - `.qc-more-t` → `var(--font-body)`
  - 平板/横屏媒体查询 px 各降 2px（见 spec 第 2 节 ④）

## 阶段 6：② AI 问诊会话持久化

- [x] T6.1 `miniprogram/pages/consultation/consultation.js`
  - `SESSION_KEY='wb_consult_live_session_v1'`、TTL 6h、消息最多 40 条
  - `_persistSession` / `_restoreSession`；落盘点 `_appendMsg`、`_renderTriage`、`onHide`、`onUnload`；`_greet` 清快照
  - 恢复后 `listMyConsultations` 校验 activeId：非 ACTIVE → 清快照 + `_greet`；ACTIVE → 跳过问候 + 刷新 `_loadProgress`
- [x] T6.2 后端（已改，回归）：`chat.py` v6 答疑模式 + `ConsultationService.chatContext` 分诊标记；跑 `python -m py_compile` 与既有测试

## 阶段 7：⑤ 算法性能基线

- [x] T7.1 新增 `miniprogram/tests/triage-engine.perf.test.js`：1000 次 `analyze()` < 3000ms
- [x] T7.2 新增 `miniprogram/tests/consult-upload-guard.test.js`：断言 `consult.js` 不含 `chooseMedia/chooseImage/chooseMessageFile`，且含 MIME 白名单与 `_pickFromHealthRecords`

## 阶段 8：后端测试

- [x] T8.1 新增 `backend/.../consultation/ConsultationAttachmentGuardTest.java`
  - 非健康档案 objectKey → 422
  - `image/gif` → 422
  - `>10MB` → 422
  - 合法 jpeg → `IMAGE_NOTE`
- [x] T8.2 若 `ConsultationService` 构造器变更导致既有测试编译失败，同步修正测试构造参数

## 阶段 9：验证与记录

- [x] T9.1 `node --check`：consult.js（患者/医生）、consultation.js、triage.js、flow-progress.js、triage-engine.js、新增测试文件
- [x] T9.2 `node tools/check-project.js`
- [x] T9.3 `node tools/test-fe-all.js`（含新增测试）
- [x] T9.4 `cd backend && mvnw.cmd -o -q -DskipTests compile`
- [x] T9.5 `cd backend && mvnw.cmd -o -q -Dtest=AttachmentSignatureTest,ConsultationAttachmentGuardTest test`
- [x] T9.6 `DEV_LOG.md` 尾部追加；`README.md` 仅更新受影响节（问诊上传口径 / 轮询间隔 / MessageData 附件字段）

## 阶段 10：v3 增补（系统推送报告图 + 接单前可补充）

- [x] T10.1 前端 `_pickFromHealthRecords` 收集 `resourceKey`（仅 `health.*`），URL 走 `staticResourceUrl`
- [x] T10.2 后端 `validateImageContent` 支持 `health.*` 资源白名单（启用 + MIME + ≤10MB）
- [x] T10.3 后端 `toData` 为 `health.*` 下发 `/api/v1/resources/{key}` 与通用文件名
- [x] T10.4 删除 `onSendText` / `onPickAttach` 的 `!accepting` 拦截与后端 `WAITING_ACCEPT` 闸门
- [x] T10.5 `consult.wxml` 等待条改为输入栏上方轻提示；`consult.wxss` 新增 `.cs-wait-top`
- [x] T10.6 接诊态同步：`_liveTick` 每 2 轮拉详情；首轮 400ms（`POLL_FIRST_DELAY`）
- [x] T10.7 后端测试：`health.*` 可发送且下发资源 URL、`home.*` 422、接单前可补充消息
- [x] T10.8 验证：`node --check` / `check-project` / `test-fe-all` / `mvnw compile` / `ConsultationAttachmentGuardTest`
