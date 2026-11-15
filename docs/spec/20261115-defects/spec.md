# 六项缺陷修复 Spec（2026-11-15）

> 范围：患者端「网络异常重试 / AI 问诊兜底 / AI 导诊脏会话 / 全流程进度 / 在线问诊附件与健康档案 / 在线问诊预约接单」。
> 约束：原生小程序，不改网关入口，不引入 npm 依赖，主包不得突破 2MB。

---

## 1. 缺陷与根因

### D1 网络异常提示中的「重试 / 重新连接」按钮变形

**现状**
- 各页错误态按钮不是同一套：
  - `pages/profile/health-records`、`consultations`、`consult-families` 用 `.btn.btn-primary.state-btn`（宽 320rpx）。
  - `pages/appointment` 用 `.btn.btn-outline.error-retry`（`.btn` 是块级 flex，按钮被拉成整行宽）。
  - `pages/profile/reports` / `report-detail` 用自定义 `.rep-state-btn` / `.rd-state-btn`（inline-block + 固定行高）。
  - `pages/consult/picker` 用 `.cp-btn.cp-state-btn`（另一套尺寸）。
- 大字档 / 平板档下文字与高度比例不一致，窄容器里还会被压扁或换行，视觉上就是「变形」。

**修复**
- `app.wxss`：
  - `.btn` 增加 `padding: 0 32rpx; white-space: nowrap; flex-shrink: 0;`（防压扁、防换行）。
  - 新增 `.btn-inline { width: auto; min-width: 280rpx; padding: 0 48rpx; }`，作为错误态按钮统一容器。
  - `.state-btn` 增加 `white-space: nowrap;`。
- 把 `appointment`、`reports`、`report-detail`、`consult/picker` 四处重试按钮统一为
  `class="btn btn-primary btn-inline ..."`，删除各自写死的宽度 / 行高 / display，仅保留外边距。
- 不改文案、不改点击逻辑。

### D2 AI 问诊在模型不可用时没有落到「规则匹配」兜底

**现状**
- `backend/ai-service/app/providers/chain.py`：DeepSeek 没有 key 时直接 `continue`，Ollama 不可用即抛
  `CAPABILITY_UNAVAILABLE`，这是预期行为，不需要改后端。
- `pages/consultation/consultation.js` 的 `_onAiFail(err)` 只追加一句
  「AI 助手暂时没能回答（…）」，没有使用项目已有的本地规则引擎
  `services/triage.js#parse`（三级兜底的最后一级）。

**修复（仅前端）**
- `_awaitChat` / `catch` 把用户原话传入 `_onAiFail(err, text)`。
- `_onAiFail` 判定错误码属于「AI 服务不可用」集合
  （`CAPABILITY_UNAVAILABLE / AI_TASK_FAILED / TASK_POLL_TIMEOUT / NETWORK_ERROR / TIMEOUT / NO_TASK / EMPTY_RESULT`）时：
  1. 先追加一条提示气泡：「暂时无法连接 AI 服务，已为您切换到院内规则匹配。」
  2. 调 `triageService.parse(text, {})` 得到本地规则结果：
     - 有 `primary.dept`：复用 `_pushDeptCard(result)` 渲染科室卡（含备选、建议、去挂号）；
     - 无明确科室：追加文本气泡「暂未匹配到明确科室，建议先到全科医学科或咨询导诊台」。
  3. 文案统一用 `errText` 的安全中文，不暴露英文错误码。
- 非「AI 不可用」类错误（如 `AUTH_REQUIRED`）保持原文案，不误报为规则匹配。
- 规则结果不落库：仅本页展示；刷新后可通过再次提问重试（不做伪造持久化）。

### D3 AI 导诊脏会话 / 重复出结果 / 多余「更多服务」

**现状**
- `triage.js` 用 `SESSION_KEY = wb_triage_live_session_v1` 恢复上一次对话，并恢复
  `_consultationId / _history / _asked`，所以用户换症状提问时后端会话与本地槽位仍带着上一次「咳嗽」。
- 页面没有清空入口。
- `onForceResult()` 没有并发守卫，连点会重复 `_analyze`。
- 输入区下方固定渲染「更多服务」快捷入口（`quick-services`）。

**修复**
- 顶部 `nav-right` 增加「清空」文字按钮（仅在 `messages.length > 1` 时显示）：
  - `wx.showModal` 二次确认；
  - 停止语音；`_clearSession()`；重置 `messages / msgId / slotsText / rounds / canReport / lastResult / emergency / input / status`；
  - 重置实例字段 `_consultationId='' / _history=[] / _asked=[] / _pendingNavDept='' / _deptPushed=false`；
  - 重新 `_greet()`，确保下一次提问会创建**新会话**。
- `onForceResult()` 首行：`if (this.data.status === 'THINKING') return`；
  WXML 按钮加 `collect-btn-off` 态（半透明），点击后立即可见反馈。
- 删除 `triage.wxml` 的 `quick-services` 整块、`triage.wxss` 的 `.quick-services / .qs-item` 样式、
  `triage.js` 的 `SERVICE_MENU / onServices / onQuickBook / onQuickReport / onQuickNav / onAllServices`。
- 「清空」按钮样式写入 `triage.wxss`，沿用现有 nav 尺寸与主色。

### D4 全流程就医提示不更新

**现状**
- `triage.js` / `consultation.js` 的 `_loadProgress()` 取 `list[list.length - 1]`；
- 后端 `GET /api/v1/appointments/me` 按 `created_at DESC` 返回（新→旧），于是永远取到**最旧**一条；
- `triage.js` 的 `onShow` 只切主题，不重新拉取；
- 列表为空时直接 `return`，旧文案残留。

**修复**
- 新增 `miniprogram/utils/flow-progress.js`（纯函数，无副作用）：
  - `pickFocus(list)`：优先取「进行中」状态（`PENDING / CONFIRMED / CHECKED_IN`）中时间最近的一条；
    否则取最近一条已结束记录；不依赖数组顺序。
  - `buildProgress(list, title)`：沿用现有 4 步文案与 `isPastVisit` 规则，返回
    `{ hasFlow, step, subtitle }`；列表为空返回 `{ hasFlow:false, step:1, subtitle:'' }`。
- 两个页面改为调用该工具；`setData({ progress: ... })` 无条件覆盖（空列表也要清空）。
- `triage.js` 的 `onShow` 增加 `_loadProgress()`；`consultation.js` 已有 onShow 调用，保留。

### D5 在线问诊上传内部资料 + 健康档案改为系统推送图片

**现状**
- `pages/consult/consult.js` 的 `＋` 只支持拍照 / 相册 / 微信聊天文件，不能选择小程序内已有的
  病历、检查报告图片。
- `pages/profile/health-records` 有「＋ 上传检查资料」和附件删除按钮，与「医院系统推送」的定位冲突。
- 演示数据 `MOCK.HEALTH_RECORDS.reports` 没有附件图片。

**修复**
- 在线问诊：
  - `onPickAttach` 动作面板新增「从健康档案选择」；
  - 新增 `_pickFromHealthRecords()`：`userService.listHealthRecords()` → 展开图片类附件
    （`mime` 为 image 或文件名后缀为图片）→ 最多 6 条 → 动作面板；
  - 选中后复用现有逻辑：`sendConsultationMessage(id, { content: objectKey, inputMode: 'IMAGE' })`，
    并把 `objectKey → { name, size, url }` 写入 `_fileMeta`，气泡立即显示缩略图。
  - 仅在已存在会话（`activeId`）时可用；预约提交阶段不可用。
- 健康档案：
  - 删除 WXML 的上传入口与附件删除按钮；
  - 删除 JS 的 `onUploadAttachment / _doUpload / onDeleteAttachment / uploading`；
  - 附件区标题改为「系统推送资料」，保留缩略图与点击查看；
  - 演示数据补系统推送附件（`bundle: true` + `/assets/health-push/*.jpg`），
    `normalize()` 对 `bundle` 路径不做网关拼接；
  - 包内图片不能用 `wx.previewImage`，新增全屏 `<image mode="aspectFit">` 浮层查看。
- 图片生成（按用户要求「变形网页代码并截取网页」）：
  - 新增 `tools/gen-health-push-images.py`：内置两份院内报告 HTML 模板（血常规检验报告单、血压动态监测报告），
    用本机 Edge `--headless=new --screenshot` 截图为 PNG，再用 Pillow 转 JPEG（质量约 70）；
  - 输出 `miniprogram/assets/health-push/`；
  - 单图目标 ≤ 45KB，两张合计 ≤ 90KB（主包余量约 237KB，禁止超限）。

### D6 在线问诊「先预约 → 医生接单 → 才可对话」

**现状**
- 前端进入会话即可输入；
- 后端 `accepting` 用 `hasNonUserMessage(role <> 'user')` 判定，**AI 回复（role=assistant）也会把它置为 true**，
  等于没有真正「医生接单」；
- 首页「我的就医安排」只展示线下预约，不展示在线问诊接单状态。

**修复**
- 后端（business-service）：
  - `ConsultationRepository` 新增 `hasDoctorAcceptance(id)`：
    `role = 'doctor'` 或 `role = 'system_notice' AND content LIKE '%接诊%'`；
  - 患者端 / 医生端会话映射、`accept()` 的重复提示守卫改用该方法；
  - `ConsultationService.send()` 增加闸门：患者已有首条消息且尚未 `hasDoctorAcceptance` →
    抛 `WAITING_ACCEPT`（409，「医生接单后才能继续对话」）；
    首条预约描述由 `create()` 落库，不受影响。
- 前端在线问诊：
  - 「指定医生 + 无会话」= 预约阶段：输入框 placeholder 改为「请描述病情，提交后等待医生接单」，
    发送按钮文案「提交预约」；首条消息即预约描述。
  - 已有会话且 `accepting === false && !closed`：底部换成「已提交预约，等待医生接单」只读条，
    不显示输入框；`onSend / onPickAttach` 增加守卫并 toast「请等待医生接单」。
  - `accepting === true` 后恢复原输入栏。
- 首页：
  - `home.js` 引入 `userService`，`onShow` 时并行拉 `listMyConsultations()`；
  - 在「我的就医安排」卡片内新增一条问诊提示行：
    - 待接单：`在线问诊 · 等待医生接单` / 副文案「XX医生接单后可开始对话」；
    - 已接单：`医生已接单 · 可开始咨询` / 副文案「点击进入在线问诊」；
  - 已接单提示用本地 storage `wb_consult_ack_<id>` 记录 `lastMessageAt`，点击进入后不再重复提示；
  - 点击跳转 `/pages/consult/consult?consultationId=<id>`。
  - 样式沿用 `home.wxss` 的卡片令牌（主色/浅蓝底/18rpx 圆角），不新增页面。

---

## 2. 影响文件

**前端**
- `miniprogram/app.wxss`
- `miniprogram/pages/appointment/appointment.wxml|wxss`
- `miniprogram/pages/profile/reports/reports.wxml|wxss`
- `miniprogram/pages/profile/report-detail/report-detail.wxml|wxss`
- `miniprogram/pages/consult/picker/picker.wxml|wxss`
- `miniprogram/pages/consultation/consultation.js`
- `miniprogram/pages/triage/triage.wxml|wxss|js`
- `miniprogram/pages/consult/consult.wxml|wxss|js`
- `miniprogram/pages/profile/health-records/health-records.wxml|wxss|js`
- `miniprogram/pages/home/home.wxml|wxss|js`
- `miniprogram/utils/flow-progress.js`（新增）
- `miniprogram/utils/mock-data.js`
- `miniprogram/assets/health-push/*.jpg`（新增，生成产物）

**工具**
- `tools/gen-health-push-images.py`（新增）

**后端**
- `backend/business-service/.../consultation/ConsultationRepository.java`
- `backend/business-service/.../consultation/ConsultationService.java`

**文档**
- `DEV_LOG.md` 尾部追加一条。

## 3. 非目标

- 不新增「在线问诊预约表」或数据库迁移；复用现有 consultation + doctor accept 机制。
- 不改网关路由、不改 AI provider 顺序；DeepSeek 无 key 时继续快速跳过。
- 不做规则结果的持久化落库（D2 仅前端兜底展示）。
- 不引入 npm 包；截图工具只用本机 Edge + Pillow。

## 4. 验证

1. `node --check` 覆盖所有改动 JS。
2. `python -m py_compile tools/gen-health-push-images.py`。
3. `node tools/check-project.js`（含主包体积门禁）。
4. `node tools/test-fe-all.js`：只允许既有的 5 项历史红灯
   （RQ 信封 / pages-contract / paginate / patient-flows / profile-audit）。
5. 后端：`mvn -q -DskipTests package` 编译通过；如已有 consultation 相关测试则跑对应测试。
6. 手工验收：
   - 断网点任意错误页「重新加载」→ 按钮为统一胶囊、不拉伸不换行；
   - 停 Ollama、无 DeepSeek key 时在 AI 问诊发「肚子疼」→ 先提示无法连接，再出现规则匹配科室；
   - 导诊页问「咳嗽」→ 点「清空」→ 问「肚子疼」，不再出现咳嗽答案；
   - 导诊「生成结果」连点只触发一次；
   - 预约/取号/完成状态变化后返回问诊/导诊页，全流程提示同步更新；
   - 在线问诊 `＋` 可从健康档案选图片；健康档案无上传入口，显示系统推送图片并可全屏查看；
   - 新会话提交预约后输入栏锁定，首页显示「等待医生接单」；医生接单后首页提示「医生已接单」，进入后可对话。
