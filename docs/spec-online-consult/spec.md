# 线上问诊：同步提速、上传合规收紧、响应延迟优化（Spec v2）

> 需求 A（历史 5 项）：① AI 导诊生成结果只能生成一次、清空按钮难点；② AI 问诊失忆、分诊结论后仍追问；③ 全流程就医提示不更新；④ 我的问诊字体过大；⑤ 优化算法性能。
> 需求 B（本轮）：B1 线上问诊信息同步慢；B2 患者端只能上传健康档案内容 + 校验 + 医生收到的图片/信息必须与所选档案一致；B3 在线问诊响应延迟高。
>
> v2 按评审意见修订：常驻轮询与短轮询统一 2s、前后端 MIME 白名单统一、附件反查按用户隔离、图片消息幂等与回滚、恢复会话后的校验与降级、进度卡刷新时机、本地存储隐私/容量、补后端 422 与前端入口回归测试。

## 1. 现状事实（已核对代码）

| 位置 | 事实 |
| --- | --- |
| `miniprogram/pages/consult/consult.js` | `onPickAttach` 提供「拍照 / 相册 / 聊天文件 / 健康档案」四项；`_pickImage`、`_pickFile`、`_uploadAndSend` 可上传任意本地文件 |
| 同上 | `POLL_INTERVAL = 4000`、`POLL_MAX = 12`；`_startPolling`（发送后短轮询）与 `_startLive`（常驻）共用该常量；每次全量拉消息，每 12s 拉元信息 |
| `miniprogram/pages/doctor/consult/consult.js` | `CHAT_POLL = 4000`、`LIST_POLL = 8000`；`_normMessages` 只渲染文本，`IMAGE_NOTE` 的 objectKey 被当成普通字符串 |
| `backend/.../ConsultationService.java#send` | 落库 `contentType` 硬编码 `"TEXT"`；未校验 `inputMode=IMAGE` 的内容来源 |
| `backend/.../AttachmentRepository.java` | 只有 `findByRecordId` / `findById`，无「objectKey + 用户」归属校验 |
| `backend/.../AttachmentStorage.java#signedUrl` | `expires = now + ttl`，每次调用都变；轮询拉消息会让图片 URL 变化、反复重下载 |
| `backend/.../dto/MessageData.java` | 无附件展示字段，医生端拿不到图片地址 |
| `miniprogram/utils/flow-progress.js#buildProgress` | 只接收预约列表；无预约时 subtitle 为空串，线上问诊进度不显示 |
| `miniprogram/pages/profile/consultations/consultations.wxss` | 标题 `calc(var(--font-title)+6rpx)`、日期 `--font-h2`、摘要 `calc(var(--font-body)+2rpx)`，整体偏大一档 |
| `miniprogram/pages/consultation/consultation.js` | 无会话持久化，重启/Tab 回收后 `activeId/_turns` 丢失并重新 `_greet()` |
| `miniprogram/pages/triage/triage.js` + `.wxss` | 生成幂等（`generated`）与清空按钮胶囊触控区**已实现**，本轮做回归验证 |
| `miniprogram/utils/triage-engine.js` | 预编译关键词 / 扁平症状表 / normalize 短缓存**已实现**，本轮补性能回归基线 |

## 2. 决策（实现口径）

### B2 上传合规（最高优先级）

**前端：只允许健康档案，彻底移除任意上传入口。**
1. `consult.js#onPickAttach`：删除 4 项 ActionSheet，直接调 `_pickFromHealthRecords()`；保留「无会话 / 未接单」前置提示。
2. 删除 `_pickImage`、`_pickFile`、`_uploadAndSend`（不再有相册 / 拍照 / 微信文件来源）。
3. `_pickFromHealthRecords` 收集 `{key: objectKey, name: fileName, mime, size, url, recordId, attachmentId}`，过滤：
   - `objectKey` 非空；
   - **MIME 只允许 `image/jpeg`、`image/png`、`image/webp`**（无 mime 时按扩展名 jpg/jpeg/png/webp，并归一为对应 mime）；
   - `0 < size <= 10MB`。
   无可用项 → Toast「健康档案里还没有可发送的合规图片」。
4. `_sendRecordAttachment`：二次校验同一规则；`content` 只放健康档案附件的 objectKey，`inputMode:'IMAGE'`；写 `_fileMeta[key] = {name,size,url}`。
5. `_normMessage`（IMAGE_NOTE）：优先 `m.attachmentUrl / m.attachmentName`，缺失回落 `_fileMeta`；不使用本地临时路径。

**后端：服务端强制白名单（与前端同口径）。**
1. `AttachmentRepository` 新增：
   - `Optional<AttachmentRow> findByObjectKeyAndUser(String objectKey, String userId)`（`WHERE object_key=? AND user_id=?`）
2. `ConsultationService` 注入 `AttachmentRepository`、`AttachmentStorage`。
3. 新增私有校验 `validateImageContent(userId, content)`：
   - 查不到归属附件 → 422 `ATTACHMENT_NOT_ALLOWED`「仅允许发送健康档案中的图片」；
   - mime 不在 `image/jpeg|image/png|image/webp` → 422；
   - `size > 10MB` → 422。
4. `send()`：`inputMode` 大小写不敏感为 `IMAGE` 时先校验，`contentType` 落 `IMAGE_NOTE`；文本仍 `TEXT`。`create()` 的 `initialMessage` 同规则（当前前端不使用，防直连接口）。
5. `MessageData` 追加可选字段：`attachmentUrl / attachmentName / attachmentMime / attachmentSize`（`NON_NULL`）。
6. `toData(MessageRow)`：`IMAGE_NOTE` 时用 **`findByObjectKeyAndUser(row.content(), row.userId())`** 反查（按消息所属用户隔离，不依赖 objectKey 全局唯一），再 `signedUrl` 生成 url；查不到则不补附件字段（前端退化为文件卡，不裂图）。
7. `AttachmentStorage#signedUrl(objectKey, ttl)`：`expires = ((now + ttl) / 300 + 1) * 300`，同 5 分钟窗口内 URL 恒定；签名算法与校验不变。
8. 医生端 `_normMessages`：`contentType=IMAGE_NOTE` → `kind:'image'`，`url = userService.resolveAttachmentUrl(m.attachmentUrl)`，`name = m.attachmentName`；`consult.wxml` 患者气泡渲染缩略图并支持 `wx.previewImage`。医生看到的与患者所选档案附件同 objectKey、同签名资源。

### B1 信息同步提速

1. 患者端 `consult.js`：`POLL_INTERVAL 4000 → 2000`（**短轮询与 `_liveTick` 常驻轮询同源，统一变 2s**）；`POLL_MAX 12 → 24`（总时长仍约 48s）。
2. `onShow` 有 `activeId` 时先 `_stopLive()` 再立即 `_liveTick()`，不等首个定时器。
3. 发送成功后 `_loadMessages()` + 重启常驻同步，消除「短轮询结束 → 常驻空窗」。
4. 医生端：`CHAT_POLL 4000 → 2000`、`LIST_POLL 8000 → 4000`；`onShow` 在列表模式立即 `loadList(true)`（已有刷新则去重）。

### B3 响应延迟

1. 文本发送**乐观更新**：点击后立即插入本地气泡（`id:'local-…'`、`timeText:nowTime()`）并清空输入框；成功后 `_loadMessages()` 用权威列表替换；失败移除本地气泡并恢复原文。
2. 图片发送同样乐观插入 `kind:'file'` 气泡（所选档案 name/url），失败移除。
3. **幂等键复用**：`_lastSendKey` 同时服务文本与图片；失败保留，用户重试复用同一键；成功或用户改动内容后清空。
4. 不引入 WebSocket / SSE（网关与小程序侧无现成能力），以「2s 轮询 + 乐观更新 + 立即同步」达成可感知即时性。

### ③ 全流程就医提示（含刷新时机）

1. `utils/flow-progress.js#buildProgress(list, title, consult)` 增加可选第 3 参：
   - 无预约、有 ACTIVE 线上问诊：`step = consult.accepting ? 2 : 1`；
     subtitle `线上问诊 | 待医生接单，已提交病情描述` / `线上问诊 | 医生已接单，点击继续沟通`；`hasFlow=true`；
   - 无预约、无问诊：保持现有空串（页面有兜底文案）。
2. `consultation.js#_loadProgress`：`Promise.all([listMyAppointments().catch(()=>[]), listMyConsultations().catch(()=>[])])` 后计算。
3. **刷新时机**：
   - `onShow` 刷新（已有）；
   - 发送成功、分诊结论生成后各刷新一次；
   - 页面可见且存在 ACTIVE 问诊时，每 10s 轻量刷新一次（只拉 `listMyConsultations`），`onHide/onUnload` 清除定时器 —— 保证「医生接单后自动变」，不依赖用户手动操作。
4. `triage.js` 仅传两参，`onShow` 刷新逻辑不变。

### ④ 我的问诊字体

`pages/profile/consultations/consultations.wxss` 全量下调一档：
- `.qc-title`：`calc(var(--font-title)+6rpx)` → `var(--font-title)`
- `.qc-date`：`var(--font-h2)` → `var(--font-body)`
- `.qc-brief`：`calc(var(--font-body)+2rpx)` → `var(--font-body)`
- `.qc-more-t`：`var(--font-h2)` → `var(--font-body)`
- 平板/横屏媒体查询硬编码 px 同步下调 2px（23→21、17→15、16→15、25→23、18→16、17→16、18→17）。

### ② AI 问诊失忆 + 分诊后追问

**后端（已改，本轮回归）**：`ai-service/chat.py` 升 `consultation-chat-v6` + `【分诊建议已给出】` 答疑模式；`ConsultationService.chatContext` 在最新 TRIAGE 成功时前置该标记。

**前端会话持久化（本轮补）**：
- `SESSION_KEY='wb_consult_live_session_v1'`、`SESSION_TTL=6h`；保存 `activeId / messages（最多 40 条）/ msgId / _turns / _deptPushed / _pendingNavDept / latest / at`。
- 落盘点：`_appendMsg`、`_renderTriage`、`onHide`、`onUnload`；`_greet()` 清除旧快照。
- `_restoreSession()`：校验 TTL 与 `messages.length`；命中后**校验 activeId**：调一次 `listMyConsultations()`，若会话不存在或非 ACTIVE → 清快照并 `_greet()`；若 ACTIVE → 恢复本地消息并跳过 `_greet()`，同时刷新 `_loadProgress()`。
- 隐私/容量：仅存本机（微信应用沙箱 storage），不上传；消息裁剪到 40 条；TTL 到期或 `_greet` 时删除；不额外加密（会话内容本就来自本机输入/服务端下发）。

### ① AI 导诊生成幂等 + 清空按钮（已实现，回归）

- `triage.js`：`generated` 后 `onForceResult` Toast「本次已生成结果，如需重新导诊请先点「清空」」并 return；`onClear` 重置。
- 清空按钮：`navSafeRight`（胶囊安全宽）+ `.nav-clear` 胶囊触控区（min 96×64rpx）。
- 本轮补回归断言（静态源码检查 + 手工路径），不改交互。

### ⑤ 算法性能（已优化，补基线）

- `triage-engine.js` 已做预编译关键词、扁平症状表、normalize 短缓存、isNegated 循环。
- 本轮新增性能烟测：`analyze()` 连续 1000 次在宽松阈值内完成（防回退），阈值取 3000ms（当前量级远低于此），不作为精度断言。

## 3. 不做的事

- 不引入 WebSocket / SSE / 订阅消息推送。
- 不改数据库表结构（复用 `health_record_attachments`）。
- 不做语义级内容审核（敏感词/大模型审核），本轮以「来源白名单 + 类型/大小校验」堵住任意上传。
- 不做图片压缩/转码（健康档案附件已是后端落盘资源）。

## 4. 验收标准

1. 患者端「＋」只剩健康档案选择；源码中 `consult.js` 不再出现 `chooseMedia / chooseImage / chooseMessageFile / _uploadAndSend`。
2. 健康档案无合规图片时明确中文提示，且不发任何上传请求。
3. 非健康档案 objectKey 直接调 `POST /consultations/{id}/messages`（`inputMode=IMAGE`）→ 422 `ATTACHMENT_NOT_ALLOWED`；非白名单 MIME → 422。
4. 选健康档案图片后，患者与医生看到同一张图（同 objectKey、可预览），医生端不出现裸 objectKey。
5. 患者发送气泡立即出现；**短轮询与常驻轮询均为 2s**，医生端最迟约 2s 看到新消息，患者端最迟约 2s 看到医生回复。
6. 无预约但有进行中线上问诊时，进度卡显示「线上问诊 | 待医生接单…」，医生接单后 10s 内自动变「医生已接单，点击继续沟通」。
7. 「我的问诊」标题/日期/摘要字号明显小于改动前，布局不破。
8. 杀进程重进 AI 问诊页，6 小时内恢复上次多轮会话；activeId 失效时自动清空并重新问候。
9. AI 导诊生成一次后按钮不可再点，清空后可重新生成；清空按钮可点。
10. `triage-engine` 性能烟测通过。

## 5. 验证命令

```bash
node --check miniprogram/pages/consult/consult.js
node --check miniprogram/pages/doctor/consult/consult.js
node --check miniprogram/pages/consultation/consultation.js
node --check miniprogram/pages/triage/triage.js
node --check miniprogram/utils/flow-progress.js
node --check miniprogram/utils/triage-engine.js
node tools/check-project.js
node tools/test-fe-all.js
cd backend && mvnw.cmd -o -q -DskipTests compile
cd backend && mvnw.cmd -o -q -Dtest=AttachmentSignatureTest,ConsultationAttachmentGuardTest test
```

## 6. 测试补充

- 后端新增 `ConsultationAttachmentGuardTest`：
  - 非健康档案 objectKey → 422 `ATTACHMENT_NOT_ALLOWED`；
  - `image/gif` → 422；
  - `>10MB` → 422；
  - 合法 jpeg → 落库 `contentType=IMAGE_NOTE`。
- 前端新增 `miniprogram/tests/consult-upload-guard.test.js`（源码静态断言：四个禁用 API 不出现、`_pickFromHealthRecords` 仍存在、MIME 白名单存在）；若 `test-fe-all` 自动发现 `tests/*.test.js` 则无需改 runner。
- 前端新增 `miniprogram/tests/triage-engine.perf.test.js`：1000 次 `analyze()` < 3000ms。

## 7. 风险与回退

| 风险 | 处理 |
| --- | --- |
| `MessageData` 追字段影响契约校验 | 字段可选 + `NON_NULL`；跑后端编译与测试；失败则改独立 `GET /consultations/{id}/attachments` 端点（回退方案） |
| 2s 轮询增加服务端压力 | 仅会话详情页前台运行；`onHide/onUnload` 立即停表；列表 4s；进度卡 10s |
| 乐观消息与权威列表重复 | 成功后整表替换；失败移除本地项；幂等键复用 |
| 签名 URL 取整影响旧链接 | 只改过期时间计算，签名算法/校验不变，旧链接仍有效至原过期时间 |
| `toData` 反查附件串图 | 按 `row.userId()` 限定查询，不依赖 objectKey 全局唯一 |

## 8. v3 增补（2026-11-15 用户复审后）

### 8.1 系统推送报告图（`health.*` resourceKey）可发送

- 背景：后端 `resource_asset` 已登记系统推送报告（如 `health.report-blood-routine`，V30），健康档案页可展示，但问诊选图因“只认 objectKey”被跳过。
- 方案：
  - 前端 `_pickFromHealthRecords` 同时收集 `objectKey` 与 `resourceKey`（只认 `health.*`），展示 URL 走 `resourceService.staticResourceUrl(key)`；
  - 后端 `validateImageContent`：`health.*` 前缀 → `ResourceAssetRepository.findActiveByKey` 命中 + 图片 MIME 白名单 + ≤10MB，否则 422；
  - 后端 `toData`：附件表查不到且为 `health.*` → 下发 `attachmentUrl=/api/v1/resources/{key}`、`attachmentName=健康档案报告.<ext>`；
  - 选图列表降级与健康档案页同源（开发档演示档案中的报告携带真实 resourceKey），写操作仍由后端校验。
- 边界：非 `health.*` 的任何资源 key（如 `home.*`）一律 422，防止拿图标/主视觉冒充检查资料。

### 8.2 接单前允许继续补充（取消 D6 闸门）

- 背景：`consult.wxml` 在 `activeId && !accepting` 时用等待条替换整个输入栏，患者第二条信息发不出去。
- 方案：
  - 等待条改为输入栏上方轻提示（`.cs-wait-top`），输入栏常显；
  - 删除 `onSendText` / `onPickAttach` 的 `!accepting` 拦截，后端删除 `WAITING_ACCEPT` 闸门；
  - 接诊态同步：`_liveTick` 每 2 轮（≈4s）拉一次会话详情；进页/回到页面首轮延迟 400ms。
- 回归：`医生接单前_患者可继续补充消息`（后端）、`consult-upload-guard`（前端静态）。
