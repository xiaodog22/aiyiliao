# 测试报告 · 分片 C（个人中心 10 页）

- 日期：2026-10-29 ｜ 角色：资深 QA / 测试架构师 ｜ 模式：只读静态审查 + 离线单测（未改任何页面/服务/样式源码）
- 范围：pages/profile/profile、records、health-records、consultations、family、personal-info、settings、voice-settings、privacy、agreement；services/user.js、services/voice.js、utils/apt-status.js、paginate.js、err-text.js（引用关系）
- 环境：node v22.23.2 / Windows / BUILD_ENV=development（MOCK_FALLBACK=true）
- 新增单测：`tools/test-profile-pages-audit.js`（打桩 wx/getApp/Page/storage/request），**实跑 PASS=47 / FAIL=0（RESULT: PROFILE_AUDIT_OK）**
- 结论：**P0=0，P1=1，P2=6**

---

## 1. 用例表（PCT-xxx）

| ID | 维度 | 前置 | 步骤（审查路径） | 预期 | 实测 | 证据 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PCT-001 | F | 登录态 | profile.js 用户信息链路：getMe → _apply → resolveAvatar | 数据走 services/user.js，页面不散写业务数据 | ✅ | profile.js:62-66,112-122；user.js:142-144 | P1 |
| PCT-002 | F/R | 登录态 | resolveAvatar 空值返回包内默认头像 | '' → '/assets/img/avatar-default.png' | ✅ | user.js:349-355；单测 [user] 3 项 | P1 |
| PCT-003 | F | 有/无头像 | profile 页空头像渲染 | 空 avatarUrl 不渲染 `<image src="">`，用 icons.userGray 剪影占位 | ✅（设计裁决：刻意不用包内默认头像，注释说明） | profile.wxml:23-24,13-15；profile.js:118 | P2 |
| PCT-004 | F | 登录态 | profile 入口跳转逐一核对 | 8 个入口目标存在 | ✅ goRecords/goHealthRecords/goConsultations/goFamily/goPersonalInfo/goSettings/goPrivacy/goAgreement 全部指向已注册页；消息通知/账号安全显式降级 toast | profile.js:124-175 | P2 |
| PCT-005 | F | 登录态 | wb_tv 投屏状态 / wb_voice 音色状态在「我的」页展示 | 如设计有则展示 | ⏭ 设计稿 07 无此两行（语音设置已移至设置页，注释说明） | profile.js:169-172 | P2 |
| PCT-006 | F/R | 45 条契约预约 | records 分页：具名解构 paginate、首屏 20、触底 40→45、hasMore 翻 false、幂等 | 与 test-pages-paginate 同口径 | ✅ 单测 8 项全过 | records.js:13,95-99,163-164；单测 [records] 段 | P1 |
| PCT-007 | F | 7 态枚举 | 预约状态中文走 apt-status.js，页面禁写死判断 | PENDING→待确认 / CONFIRMED→待就诊 / CHECKED_IN→就诊中 / COMPLETED→已完成 / CANCELLED→已取消 / EXPIRED→已过期 / NO_SHOW→未到诊 | ✅ 单测 10 项；records.js:147 实测首行 PENDING→待确认 | apt-status.js:9-24；records.js:15,147 | P1 |
| PCT-008 | F | 45 条 | records 分段筛选（全部/待就诊/已完成）计数与切片 | active=35 / done=5；切换后 total/hasMore 正确 | ✅ 单测 3 项 | records.js:102-116；单测 | P2 |
| PCT-009 | R | 后端 500 | records 错误态：中文文案 + 实心重试按钮（bindtap=fetch） | 不直出英文/HTTP 码 | ✅ 单测：error 为纯中文；errText(err,'记录加载失败，请重试') | records.js:166-178；records.wxml:14-19 | P1 |
| PCT-010 | R | 空列表 | records 空态：图标+文案+「去挂号」CTA（switchTab appointment） | 空态不空白、可引导 | ✅ | records.wxml:59-64 | P2 |
| PCT-011 | F | — | records 叫号-完成状态流转 | 患者端无此能力（医生端职责） | ⏭ 本页仅取消/详情/再预约，符合分工 | records.js:186-246 | P2 |
| PCT-012 | F/R | 有/无档案 | health-records 读取链路 + 空态 | listHealthRecords → normalize → 骨架屏/错误态/空态 | ✅ | health-records.js:174-198；health-records.wxml:11,132 | P1 |
| PCT-013 | R | PDF 附件 | downloadFile→openDocument + statusCode 判定（410 过期提示） | 不直接传 https 给 openDocument | ✅ | health-records.js:352-378 | P1 |
| PCT-014 | R | 后端 501 | AI 解读未实现时可见中文降级，不伪造解读内容 | 501 → 「AI 解读功能尚未开放…」 | ✅ | health-records.js:310-318 | P1 |
| PCT-015 | F/R | 25 条会话 | consultations 分页 + 状态徽章（ACTIVE/CLOSED/ARCHIVED） | 具名解构 paginate；CLOSED 展示「已完成」 | ✅ | consultations.js:18,26,92-96,107-111 | P1 |
| PCT-016 | F | CLOSED 会话 | 历史会话详情跳转与只读语义 | → /pages/consult/consult?consultationId=；只读条由会话页实现（2026-10-24 已修） | ✅ | consultations.js:114-121；DEV_LOG 2026-10-24 | P1 |
| PCT-017 | F/R | 成员列表 | family 列表/增/删 + 空态 + 错误态 | list/create/remove 走 user.js；saving 防重；onSheetClose 提交在途禁关 | ✅ | family.js:102-107,131-153,178-200 | P1 |
| PCT-018 | F | — | family 成员「改」（编辑） | 设计稿无编辑操作行；user.js 无 updateFamilyMember | ⏭ 设计如此，登记说明 | family.wxml:4；user.js:191-204 | P2 |
| PCT-019 | F | V8 契约 | personal-info 各字段读取/保存（头像/姓名/邮箱/住宅/户籍/身份证/医保） | getMe+getExtendedProfile → 表单；PUT/POST 走 user.js | ✅ | personal-info.js:69-114,232-321；user.js:308-337 | P1 |
| PCT-020 | F | 敏感字段 | 身份证/医保/手机号脱敏展示，不回显原文 | maskedPhone/idMasked/insMasked；服务端加密 | ✅ | personal-info.js:96-97,109-112,211；personal-info.wxml:39 | P1 |
| PCT-021 | R | 连点 | 保存按钮防重复提交（5 个 saving 标志） | avatar/name/contact/id/ins 各自 saving 在途拒绝 | ✅ | personal-info.js:53-57,120,169,233,266,302 | P1 |
| PCT-022 | F/R | 三档字号 | settings 字号切换：app.setTheme 持久化 wb_theme + 根 view theme-{{theme}} 类 | standard/large/xlarge 即时生效 | ✅ | settings.js:167-177；app.js:85-87；app.wxss:78,89 | P1 |
| PCT-023 | R | 72h 会话 | onClearCache 保留 wb_login_at / wb_role / wb_user（+wb_theme/HC/voice_read/refresh 令牌） | 清缓存后登录态不丢 | ✅ 单测 9 项钉死 | settings.js:194-223；单测 [settings] 段 | P0 |
| PCT-024 | F | 版本号 | 版本展示取 wx.getAccountInfoSync（try/catch 兜底） | 不硬编码假版本 | ✅ | profile.js:32-43 | P2 |
| PCT-025 | F/R | 音色列表/试听/设默认/重扫 | voice-settings 链路走 services/voice.js | 列表 catalogRemote（远端优先、失败回落本地）；设默认立即落盘 | ⚠️ 列表/试听/删除/恢复正常；**设默认未接服务端持久化**（见 Bug C-01） | voice-settings.js:75-95,155-183；voice.js:129-179,196-211 | P1 |
| PCT-026 | R | 占位音质 | degraded/placeholder 提示不阻断播放 | speech.speak 支持 onDegraded 回调；页面应接线提示 | ❌ 页面未传 onDegraded（见 Bug C-03） | speech.js:256-257；voice-settings.js:192-203 | P2 |
| PCT-027 | F | 本地记忆 | wb_voice 本地记忆（speech.currentVoice/setCurrentVoice） | 选中音色落 storage，播报直读 | ✅ | speech.js:24,148-152；voice.js:186-188 | P1 |
| PCT-028 | F | 静态页 | privacy/agreement 内容完整、无业务数据泄漏、返回正常 | 静态声明页，不拉取/上传数据 | ✅ | privacy.wxml / agreement.wxml 全文；privacy.js:1-17 | P2 |
| PCT-029 | U | 全 10 页 | 图标走 utils/icons.js，禁 emoji | 渲染层无 emoji（⚠️ 仅出现在 WXML 注释） | ✅ | 全目录 grep 无命中 | P2 |
| PCT-030 | U | 全 10 页 | app.wxss 令牌唯一色源；字号三档 theme-* | 每页根 view 挂 theme-{{theme}} | ✅ | 各页 wxml 首行 + settings.js:40-44 | P2 |
| PCT-031 | U | 全 10 页 | 600/900px 断点 px 重写 | 每页均有 ≥600px 档且内部用 px（抽查 records.wxss:161-186 全 px） | ✅ | 10 页 wxss grep 断点 12 处 | P2 |
| PCT-032 | U | 全 10 页 | 状态不只颜色（图标徽章+文字）；动画只动 opacity | .state 徽章+标题+说明+实心按钮 | ✅ | records.wxml:14-19；consultations.wxml:12-17；family.wxml:22 | P2 |

---

## 2. Bug 条目

### [P1] 音色「设为默认」未接服务端持久化契约（PCT-025）
- 位置：miniprogram/services/voice.js:186-188,196-211；miniprogram/pages/profile/voice-settings/voice-settings.js:155-159,172-183；miniprogram/config/api.js:133（VOICE_DEFAULT 已注册但全仓无引用）
- 根因：onSetDefault → voice.save → speech.setCurrentVoice 只写本地 storage `wb_voice`；契约 `POST /api/v1/voice/voices/default`（AI_CONTEXT BACKEND #9：立即持久化）未接线。api.js 已注册 VOICE_DEFAULT/VOICE_PREVIEW/VOICE_RELOAD，services/voice.js 仅引用 VOICE_LIST（voice.js:130）。
- 复现：进入音色管理 → 任选非当前音色点「设为默认」→ toast「已设为默认音色」→ 换设备/重装登录 → 音色回落到默认。
- 影响：用户音色偏好不跨端持久化；与登记契约不符（功能本身不阻断，故不定 P0）。
- 建议：voice.save 成功后补 `post(API.VOICE_DEFAULT, { voiceId })`；失败时保留本地选择并 toast 提示「云端保存失败，本机仍生效」。
- 证据：voice.js module.exports（233-240）无 setDefault；单测钉住「设默认链路 0 网络请求」现状。

### [P2] 试听未走契约 /voices/preview，且未接 onDegraded 占位音质提示（PCT-026）
- 位置：voice-settings.js:192-203；speech.js:256-257；config/api.js:137（VOICE_PREVIEW 已注册无引用）
- 根因：试听经 speech.speak → `POST /api/v1/voice/tts`（主接口），未走契约 preview（form-data → WAV）；speech.speak 已支持 onDegraded（degraded=true / engine=placeholder → 占位音质照常播放），但页面只传 onEnd/onError，占位音质播放时用户无提示。
- 复现：后端 engine=placeholder 时试听 → 听到占位音，页面无任何「占位音质」提示。
- 影响：功能不阻断（onError 有兜底文案），违反 AI_CONTEXT #7「占位音质须提示」的口径。
- 建议：speech.speak 调用补 `onDegraded: () => this.setData({ engineHint: '当前为占位音质，正式音色上线后自动切换' })`。
- 证据：speech.js:256-257 `if (o.onDegraded && (r.meta.degraded || r.meta.engine === 'placeholder'))`；voice-settings.js:192-203 无 onDegraded 字段。

### [P2] voice.save/remove 只认本地 CATALOG，远端音色不可设默认/删除（PCT-025）
- 位置：voice.js:198-204,214-225
- 根因：save() 用 `catalog().rows`（本地 4 条）校验 voiceId；catalogRemote() 拉到的远端自定义音色 id 不在本地 CATALOG → onSetDefault → save 被拒「音色不存在」(NOT_FOUND)；remove() 同理只查本地 CATALOG。
- 复现：远端目录覆盖列表后（voice-settings.js:75-95），对远端音色点「设为默认」→ engineHint「保存失败，请稍后重试」。
- 影响：远端音色可用不可设默认/删除（与 Bug C-01 同源：服务端链路整体未接）。
- 建议：远端目录加载后把远端 rows 并入校验集，或 save 校验改读当前列表缓存。
- 证据：voice.js:198 `const rows = catalog().rows`；voice-settings.js:175 `voice.save({ voiceId, rate })`。

### [P2] 清缓存未保留 wb_voice / wb_voice_rate（音色偏好被重置）（PCT-023）
- 位置：settings.js:209-219
- 根因：clearStorageSync 后恢复 wb_role/wb_user/wb_login_at/wb_theme/wb_high_contrast/wb_voice_read/refresh 令牌，但未恢复 wb_voice、wb_voice_rate——注释声明「保留用户设置」，音色偏好恰属此类。
- 复现：设置 → 清除缓存 → 重进音色管理 → 当前音色回落到第一项、语速回 1.0。
- 影响：低（偏好类，非会话类）；单测已钉住现状（`[settings] 现状钉住：wb_voice 清缓存后未保留`）。
- 建议：onClearCache 快照时补 `const voiceId = speech.currentVoice(); const rate = speech.currentRate();`，清后恢复。
- 证据：settings.js:210-219 恢复键清单无 wb_voice/wb_voice_rate；单测实测 storage.wb_voice === undefined。

### [P2] records.onCancel 无在途防重（双击双弹窗）（PCT-009 对照）
- 位置：records.js:209-231
- 根因：取消预约无 cancelling 标志（对比 family.onSubmit:179、personal-info 各 saving 标志）；快速双击 → 两个 showModal → 两次 POST cancelAppointment（每次新建幂等键）。
- 复现：列表「取消预约」连点两次 → 两个确认弹窗。
- 影响：服务端幂等（同终态 200/409），无脏数据；仅体验问题。
- 建议：加 `cancelling` 标志或 showLoading(mask:true)（family.onRemove:140 已有同款范式）。
- 证据：records.js:209-231 无 loading/标志；family.js:140 对照。

### [P2] profile「隐私设置」入口文案与目标页错位（PCT-004）
- 位置：profile.wxml:78-82
- 根因：行文案「隐私设置」bindtap=goSettings → /pages/profile/settings/settings（系统设置页）；隐私政策实际在协议卡（profile.wxml:97-101）。
- 影响：用户预期与落点不符（IA 错位），无功能损失。
- 建议：文案改「系统设置」，或在设置页顶部补隐私入口分组。
- 证据：profile.wxml:79-80 文案「隐私设置」→ goSettings（profile.js:144-146）。

### [P2] privacy 声明与 settings 注销口径不一致（PCT-028）
- 位置：privacy.wxml:25；settings.js:267-274
- 根因：隐私政策写「注销账号后，我们会按约定删除相关本机数据」，设置页注销弹窗写「当前版本尚未开放线上注销」。
- 影响：演示版声明，上线前法务替换时需对齐，当前不构成功能 bug。
- 建议：正式文本落地时统一注销口径。
- 证据：privacy.wxml:25 vs settings.js:270。

---

## 3. 页面核对表

### 页面 pages/profile/profile
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 用户信息走 getMe 契约 | F | ✅ | profile.js:62-66 | 失败静默，登录态字段兜底 |
| 头像 resolveAvatar 空值处理 | F | ✅ | profile.wxml:23-24 | 刻意 CSS 剪影占位（设计裁决，注释 13-15 行） |
| 状态位真实数据（档案同步/未读点） | F | ✅ | profile.js:72-95 | 无静态假标；单测 archiveSynced/unread 均 true |
| 入口跳转 8 项 | F | ✅ | profile.js:124-175 | 2 个未落地入口显式 toast 降级 |
| wb_tv/wb_voice 状态行 | F | ⏭ | profile.js:169-172 | 设计稿 07 无此行 |
| 版本号真实获取 | F | ✅ | profile.js:32-43 | try/catch 兜底 V1.5.0 |

### 页面 pages/profile/records
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 分页对象导出 + 触底追加 | R | ✅ | records.js:13,95-99 | 单测 8 项 |
| 状态中文 apt-status | F | ✅ | records.js:15,147 | 首行 PENDING→待确认实测 |
| 分段筛选计数 | F | ✅ | records.js:102-116 | active=35/done=5 |
| 空态/错误态+重试 | R | ✅ | records.wxml:14-19,59-64 | errText 中文实测 |
| 取消预约二次确认 | F | ✅ | records.js:209-231 | 无在途防重（Bug C-05） |
| 叫号-完成流转 | F | ⏭ | — | 患者端无此能力 |

### 页面 pages/profile/health-records
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 档案读取/空态 | F/R | ✅ | health-records.js:174-198 | 骨架屏→错误态+重试 |
| 分类筛选动态生成 | F | ✅ | health-records.js:105-116 | 不硬编码后端未返回类别 |
| 附件上传/删除 | R | ✅ | health-records.js:213-260,381-401 | uploading 防重 + 10MB 预检 |
| PDF 两步打开 + 410 | R | ✅ | health-records.js:352-378 | statusCode 判定（KNOWN #20 落实） |
| AI 解读 501 降级 | R | ✅ | health-records.js:310-318 | interpreting 连点保护 |
| 报告未就绪锁定 | F | ✅ | health-records.js:95-98,275-279 | 仅明确未就绪时锁 |

### 页面 pages/profile/consultations
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 列表取数+分页 | F | ✅ | consultations.js:88-111 | 具名解构 paginate |
| 状态徽章映射 | F | ✅ | consultations.js:26-38 | ACTIVE/CLOSED/ARCHIVED |
| 详情跳转+只读 | F | ✅ | consultations.js:114-121 | 会话页 CLOSED 只读条（DEV_LOG 10-24） |
| 空态 CTA | R | ✅ | consultations.wxml:40-45 | switchTab consultation |

### 页面 pages/profile/family
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 列表/增/删 | F | ✅ | family.js:102-107,131-153,178-200 | 写操作幂等键由服务层生成 |
| 防重复提交 | R | ✅ | family.js:179,161 | saving 在途禁关浮层 |
| 空态/错误态 | R | ✅ | family.wxml:22,57 | — |
| 成员编辑 | F | ⏭ | family.wxml:4 | 设计稿无编辑行 |

### 页面 pages/profile/personal-info
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| V8 契约读写 | F | ✅ | personal-info.js:69-114,232-321 | 5 个写端点全接线 |
| 敏感字段脱敏 | F | ✅ | personal-info.js:96-112,211 | maskedPhone/idMasked/insMasked |
| 防重复提交 | R | ✅ | personal-info.js:53-57 | 5 个 saving 标志 |
| 身份证前端格式校验 | F | ✅ | personal-info.js:19,273 | GB11643 服务端复核 |
| 错误文案 errText | R | ✅ | personal-info.js:78,141,184,252,286,318 | 无直出 err.message |

### 页面 pages/profile/settings
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 三档字号切换 | F | ✅ | settings.js:167-177 | setTheme + theme-* 类 |
| onClearCache 保留 72h 会话 | R | ✅ | settings.js:194-223 | 单测 9 项钉死；补 wb_voice 建议（Bug C-04） |
| 服务状态四态探针 | F | ✅ | settings.js:118-148 | 30s 轮询+onHide/onUnload 停表 |
| 高对比/语音朗读开关 | F | ✅ | settings.js:180-192 | HC_KEY 清缓存保留 |
| 版本号展示 | F | ✅ | profile.js:32-43（共用） | — |

### 页面 pages/profile/voice-settings
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 目录远端优先+本地回落 | F | ✅ | voice-settings.js:75-95；voice.js:129-163 | source 标注 |
| 设为默认即时生效 | F | ⚠️ | voice-settings.js:155-159；voice.js:196-211 | 本地即时 ✅；服务端持久化缺失（Bug C-01） |
| 试听 | R | ⚠️ | voice-settings.js:187-204 | onError 兜底 ✅；onDegraded 未接（Bug C-02） |
| 删除自定义/恢复默认 | F | ⚠️ | voice-settings.js:208-243 | 远端音色删除被拒（Bug C-03） |
| 语速三档本地记忆 | F | ✅ | voice-settings.js:64-72,247-257 | wb_voice_rate |

### 页面 pages/profile/privacy / agreement
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 静态内容完整 | F | ✅ | privacy.wxml / agreement.wxml 全文 | 5 节齐全，演示版标注 |
| 无业务数据泄漏 | F | ✅ | privacy.js:1-17 | 不拉取/上传 |
| 导航返回 | F | ✅ | 原生导航栏（页面无自定义返回逻辑） | — |
| 注销口径一致性 | F | ⚠️ | privacy.wxml:25 vs settings.js:270 | Bug C-07 |

---

## 4. 离线单测执行摘要

| 项 | 结果 |
| --- | --- |
| 脚本 | `tools/test-profile-pages-audit.js`（新增，未改任何既有源码） |
| 运行命令 | `node tools/test-profile-pages-audit.js` |
| 输出 | `PASS=47 FAIL=0` → `RESULT: PROFILE_AUDIT_OK`（exit 0） |
| 覆盖 | apt-status 映射 10 项 / user 契约字段 3 项 / records 分页·筛选·错误态 14 项 / settings 清缓存保留键 10 项（含 2 项现状钉住）/ voice 链路 7 项（含 1 项缺口钉住）/ profile 数据链路 4 项 |
| 复用 | 未重复造轮子：打桩 harness 与 test-pages-paginate.js 同范式；apt-status/paginate/err-text 既有单测（test-fe-*.js）不重写 |
| 回归 | `node tools/check-project.js` 全部通过（语法/json/图标键/禁址无命中） |

## 5. 统计与修复建议

- **P0=0**：72h 会话保留键（wb_login_at/wb_role/wb_user）实测完好，无数据安全/不可用级问题。
- **P1=1**：Bug C-01 音色设默认未接服务端持久化（api.js 端点已注册待接线）。
- **P2=6**：C-02 试听 onDegraded 未接 / C-03 远端音色不可设默认·删除 / C-04 清缓存未保留音色偏好 / C-05 records 取消无在途防重 / C-06 「隐私设置」入口 IA 错位 / C-07 注销口径不一致。
- 修复优先级建议：C-01 → C-03（同源一并接服务端音色链路）→ C-02 → C-04 → C-05 → C-06/C-07。
