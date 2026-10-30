# business-service —— V4 业务服务（Agent-M 业务权威面）

> Spring Boot 3.5.x / Java 17 / Maven Wrapper / MySQL 8 + Flyway。
> 契约事实源：`backend/contracts/business-openapi.yaml`（除 `edge-gateway` 标签外全部路径）。
> 本文只保存当前有效知识；任务书见 `docs/v4/08B-Agent-M任务书-MiMo-V2.6-Flash.md`。

## STATUS

| 项 | 值 |
|---|---|
| 当前里程碑 | **M4（硬化与验收）——M 侧完成** |
| 端口 | 8088（`SERVER_PORT` 可覆盖） |
| 健康 URL | `GET /actuator/health` → `{"status":"UP"}` |
| profile | `dev`（默认；生产必须显式指定且不加载 dev 种子） |

## 启动接入契约（I-3 · 供 Agent-D 消费，M0 收口冻结）

| 项 | 值 |
|---|---|
| dev 启动命令 | `cd backend/business-service && ./mvnw spring-boot:run`（Windows：`mvnw.cmd spring-boot:run`） |
| 包模式启动 | 先 `mvnw -q -DskipTests package`，再 `java -jar target/business-service-0.1.0-SNAPSHOT.jar`（须在 dev profile 或显式设 `SPRING_PROFILES_ACTIVE=dev` 以加载种子） |
| 端口 | 8088 |
| 健康 URL | `GET http://127.0.0.1:8088/actuator/health` → `{"status":"UP"}` |
| 构建产物 | `backend/business-service/target/business-service-0.1.0-SNAPSHOT.jar` |

## 环境变量清单

| 变量 | 说明 | 默认（仅 dev） |
|---|---|---|
| `MYSQL_URL` | JDBC URL（生产必须覆盖，含真实主机与库名） | `jdbc:mysql://127.0.0.1:3306/wechar_dev?...` |
| `MYSQL_USER` | 数据库账号（生产用专用最小权限账号，不用 root） | `wechar_dev` |
| `MYSQL_PASSWORD` | 数据库密码（**无默认值**，dev 由启动方注入；生产必须覆盖） | 空（空则连接失败，不掩盖） |
| `PHONE_KEY_BASE64` | 手机号 AES-GCM 密钥（Base64，32 字节；缺失/非法启动即失败） | dev 占位 `MDEy...ZWY=`（生产必须覆盖） |
| `WECHAT_MINIPROGRAM_APP_ID` | 小程序 AppID（生产登录必需；**不得写入源码/样例/夹具**） | 空（未配置 → 登录 503） |
| `WECHAT_MINIPROGRAM_APP_SECRET` | 小程序 AppSecret（密钥；只能由部署环境注入） | 空（未配置 → 登录 503 `WECHAT_PROVIDER_UNAVAILABLE`，绝不回退模拟登录） |
| `WECHAT_MINIPROGRAM_API_BASE_URL` | 微信开放接口基址（仅隔离联调需改） | `https://api.weixin.qq.com` |
| `WECHAT_MINIPROGRAM_CONNECT_TIMEOUT_MS` | code2session/getuserphonenumber 建连超时 | `3000` |
| `WECHAT_MINIPROGRAM_READ_TIMEOUT_MS` | 单次请求读取超时（不无限等待） | `5000` |
| `SERVER_PORT` | 服务端口 | `8088` |
| `SPRING_PROFILES_ACTIVE` | 环境档位（**2026-10-29 起 application.yml 默认改为 `prod`**；本地必须显式设 `dev`，否则不加载 dev 种子且登录走生产 provider） | `prod`（未设置时） |
| `APP_AUTH_DEV_LOGIN_ENABLED` | dev 派生 code 闸门开关（`DevLoginGuard`）：`true` 才允许 `dev-user-*`/`dev-phone-*`；prod 不配置 | `false` |
| `APP_AUTH_DEV_LOGIN_KEY` | 联调登录密钥：请求头 `X-Dev-Login-Key` 必须与之恒定时间相等；前端对应 `miniprogram/config/env.js` 的 `DEV_LOGIN_KEY` | 空（空=一律拒绝） |
| `APP_AUTH_MODE` | 鉴权档位（M4）：`strict`=仅会话 Bearer（生产默认，X-User-Id 被忽略）/ `header`=dev·itest 开发身份源 / `off`=M1 占位回滚阀（默认不启用） | `header`（dev 档；基线默认 `strict`，缺配置即最严） |
| `APP_AUDIT_ENABLED` | 审计开关（M4，docs/v4/03 §39）：只追加 `audit_events`，写操作全记录、只读仅记非 2xx，不含请求/响应正文 | `true` |
| `APP_RATE_LIMIT_ENABLED` | 业务侧限流开关（M4，docs/v4/03 §145）：仅覆盖契约声明 429 的 12 条路径；与网关 `GW_RATE_LIMIT_*` 分层并存 | `true` |
| `APP_RATE_LIMIT_WINDOW` | 限流固定窗口（秒，进程内存） | `60` |
| `APP_RATE_LIMIT_LOGIN` | 登录类路径每窗口阈值（键=IP） | `30` |
| `APP_RATE_LIMIT_SUBMIT` | 提交类路径每窗口阈值（键=认证主体） | `60` |

> MySQL 是硬依赖（`docs/v4/08` §7）：连不上就启动失败并明确报错，绝不用降级掩盖。

> **生产微信登录失败语义**（`ProdWechatSessionProvider`，2026-10-18 接入真实 `code2session`；2026-10-18 复审修订）：
> 凭证缺失 / 配置类 errcode（`40001`/`40013`/`40014`/`41002`/`41004`/`40125`/`40164`/`42001`）
> → `503 WECHAT_PROVIDER_UNAVAILABLE`（`retryable=false`）；code 无效/过期/已使用
> （微信 `40029`/`40163`）→ `422 WECHAT_CODE_INVALID`；网络异常/建连超时/读取超时/上游 5xx
> / `-1`/`45011`（可证明的繁忙）→ `503 WECHAT_UPSTREAM_UNAVAILABLE`（`retryable=true`）；
> **未知 errcode → `503 WECHAT_UPSTREAM_REJECTED`（`retryable=false`，安全默认：无法证明重试安全，
> 且 code 一次性，重发只会 `40163`；errcode 入日志供运维补充分类）**；响应非 JSON / 缺 `openid` /
> 结构异常 / 调用出现未预期异常（只记异常类名，防密钥 URI 泄入日志）→ `503 WECHAT_RESPONSE_INVALID`。
> 任何失败都**不签发会话**，日志只记 operation/errcode/类别/耗时，
> 不记 code、AppSecret、session_key 与响应正文；`session_key` 永不回给小程序。

## 进度登记（M1 端点状态；M0.4：未实现端点体面返回）

- 所有**未实现路径**统一返回 `501 NOT_IMPLEMENTED` + 契约 `ApiError` 信封
  （`code=NOT_IMPLEMENTED`、`retryable=false`、带 `requestId`/`serverTime`），
  **绝不 `200 + 空对象`、不静默**。实现进度以本表为准，完成一项勾一项。

| 里程碑 | 域 | 状态 |
|---|---|---|
| M0 | 骨架 / 统一信封 / requestId / Flyway 基线 / dev 种子 | ✅ 完成 |
| M1 | auth / me / catalog / appointment / home / triage / content | ✅ 完成（逐端点见下） |
| M1（复核补齐） | auth refresh/logout · appointments /me · /cancel · /by-idempotency-key · resources/manifest · health-records · family-members / invitations · OkSession/OkUser 形状 | ✅ 完成（V3 迁移） |
| M2 | consultations / ai-tasks / voice / care-plans | ✅ 完成（V4 迁移，逐端点见下） |
| M3 | doctor/login · doctor/workbench · doctor/appointments（含 {appointmentId}/status）· beds（含 {bedId}/assignment）· consents（含 {purpose}/withdraw）· me/deletion-requests（含 {requestId}） | ✅ 完成（V5 迁移，逐端点见下；health-records / family-members 邀请 / contents 详情为 M1/M2 已实现，M3 仅回归） |
| M4 | 硬化（鉴权 / 幂等 / 审计 / 限流 / 契约测试） | ✅ 完成（拦截器三层 + V6 审计表 + 契约/并发/迁移演练测试；详见 §M4 硬化说明） |

### 进度三态标注说明

- **契约路径 ✅**：路径与响应形状以 `backend/contracts/business-openapi.yaml` 为准实现并实测。
- **契约外补充（保留原因）**：契约中无此路径，为任务书/复核要求或 dev 联调便利而保留，已标注原因。
- **未实现（501）**：契约路径但 M1 未做，统一 501 `NOT_IMPLEMENTED` + 契约 ApiError 信封，绝不 200+空对象。

### M1 端点逐条状态（三态：契约路径 ✅ / 契约外补充 / 未实现 501）

#### auth 域

| 方法 | 路径 | 三态 | 关键规则 |
|---|---|---|---|
| POST | `/api/v1/auth/wechat/login` | 契约路径 ✅ | 请求体 WechatLoginRequest（required=[code,consentVersion]，additionalProperties:false → 未知字段 400）；响应 OkSession（accessToken=at-/refreshToken=rt-、expiresIn≥60、tokenType=Bearer、user=User 形状）；库内只存 SHA-256 |
| POST | `/api/v1/auth/refresh` | 契约路径 ✅ | RefreshRequest（refreshToken 16~512）；一次一换（轮换即失效），旧 refreshToken 重放 → 401 SESSION_REVOKED |
| POST | `/api/v1/auth/logout` | 契约路径 ✅ | 契约要求 Idempotency-Key（缺 → 400）；data={revoked}；撤销整链，重复调用幂等（已撤销再注销仍 200 revoked=true） |
| POST | `/api/v1/auth/phone/bind` | 契约外补充（保留原因：dev 联调便利，契约路径是 login.phoneCode） | AES-GCM 密文+SHA-256 哈希，响应仅占位串+后四位；login.phoneCode 契约路径同样已实现（AuthService.applyPhone，phoneCode 优先） |
| GET | `/api/v1/auth/session` | 契约外补充（保留原因：任务书联调用，复核要求标注） | 复用登录响应结构（OkSession） |

#### me 域

| 方法 | 路径 | 三态 | 关键规则 |
|---|---|---|---|
| GET | `/api/v1/me` | 契约路径 ✅ | 响应契约 User（required=[id,displayName,roles,createdAt]，additionalProperties:false）；不含 preferences/profile 契约外字段（全局严格反序列化 + User 严格形状，实测 body 无额外字段） |
| PATCH | `/api/v1/me/profile` | 契约外补充（保留原因：任务书 M1 要求的档案更新，契约未定义此路径；miniprogram 未调用，不破坏现有前端） | version 必填，缺→400，不匹配→409 VERSION_CONFLICT |
| PUT | `/api/v1/me/preferences` | 契约外补充（保留原因：同上；miniprogram 未调用） | 缺省字段保留，version 乐观锁 |

#### catalog 域

| 方法 | 路径 | 三态 | 关键规则 |
|---|---|---|---|
| GET | `/api/v1/departments` | 契约路径 ✅ | dev 种子 4 科室 |
| GET | `/api/v1/departments/{departmentId}/doctors` | 契约路径 ✅ | 按科室枚举医生 |
| GET | `/api/v1/doctors`、`/api/v1/doctors/{id}` | 契约外补充（保留原因：任务书别名，miniprogram 旧路径联调用；契约路径为 /departments/{id}/doctors） | 全局/详情枚举 |
| GET | `/api/v1/doctors/{doctorId}/slots` | 契约路径 ✅ | from/to→UTC Instant |

#### appointment 域

| 方法 | 路径 | 三态 | 关键规则 |
|---|---|---|---|
| POST | `/api/v1/appointments` | 契约路径 ✅ | Idempotency-Key 必填(缺 400)；同键同体 200 重放+`replayed=true`；同键异体 409 IDEMPOTENCY_KEY_REUSE；原子扣减 0 行→409 SLOT_FULL；过去→422 SLOT_IN_PAST；事务包裹 status=PENDING |
| PATCH | `/api/v1/appointments/{appointmentId}` | 契约外补充（保留原因：任务书要求先实现乐观锁更新；契约仅定义 /cancel；miniprogram 用 /api/appoint/updateStatus 旧路径未破坏） | version 乐观锁不匹配→409 VERSION_CONFLICT；终态→409 |
| GET | `/api/v1/appointments/me` | 契约路径 ✅ | 契约路径（原裸 /appointments 改名）；服务端身份范围过滤；query: status?/cursor?/limit?（limit bounded 1-50） |
| GET | `/api/v1/appointments/by-idempotency-key/{key}` | 契约路径 ✅ | key 8~128（缺→422）；仅当前用户（越权→404 APPOINTMENT_NOT_FOUND，不泄露存在性）；无则 404 |
| POST | `/api/v1/appointments/{appointmentId}/cancel` | 契约路径 ✅ | Idempotency-Key 必填（缺→400）；body {reason?}≤200 可选；首次 CANCELLED version+1；重复取消→200 同终态；其他终态→409 APPOINTMENT_STATE_CONFLICT；他人预约→404（先身份过滤再判终态） |
| GET | `/api/v1/appointments/stats` | 契约外补充（保留原因：任务书扩展三计数；契约暂无此路径） | upcoming/completed/cancelled |

#### patient 域（复核补齐，V3 迁移）

| 方法 | 路径 | 三态 | 关键规则 |
|---|---|---|---|
| GET | `/api/v1/health-records` | 契约路径 ✅ | familyMemberId?/cursor?/limit?；代成员仅 GRANTED 放行，否则 404（不泄露存在性） |
| POST | `/api/v1/health-records` | 契约路径 ✅ | Idempotency-Key；HealthRecordCreate（required=[category,recordedAt]，additionalProperties:false）；category 枚举 6 值（非法→422）；familyMemberId 无授权→404 |
| GET | `/api/v1/health-records/{recordId}` | 契约路径 ✅ | 本人或 GRANTED 代操作；他人→404 HEALTH_RECORD_NOT_FOUND |
| PUT | `/api/v1/health-records/{recordId}` | 契约外补充（保留原因：复核要求补齐 CRUD 更新；契约未定义此路径） | version 乐观锁；category 缺省保留原值 |
| DELETE | `/api/v1/health-records/{recordId}` | 契约外补充（保留原因：复核要求补齐 CRUD 删除；契约未定义此路径） | 本人或 GRANTED |
| GET | `/api/v1/family-members` | 契约路径 ✅ | 全量枚举（含 proxyStatus） |
| POST | `/api/v1/family-members` | 契约路径 ✅ | FamilyMemberCreate（required=[displayName,relation]）；**添加≠授权**：proxyStatus 恒为 NONE |
| GET | `/api/v1/family-members/{memberId}` | 契约外补充（保留原因：复核要求补齐 CRUD 详情；契约未定义此路径） | 本人成员枚举内查找，非本人→404 |
| PATCH | `/api/v1/family-members/{memberId}` | 契约外补充（保留原因：复核要求补齐 CRUD 更新；契约未定义此路径） | 缺省字段保留；不触碰 proxyStatus |
| DELETE | `/api/v1/family-members/{memberId}` | 契约外补充（保留原因：复核要求补齐 CRUD 删除；契约未定义此路径） | 本人成员 |
| POST | `/api/v1/family-members/invitations` | 契约路径 ✅ | required=[relation]，channel∈{QRCODE,PHONE_DEEPLINK}；令牌一次性、仅创建响应返回、服务端只存 SHA-256 哈希（实测库内无明文）；不授予代理权限（成员仍 NONE） |

#### home / triage / content 域

| 方法 | 路径 | 三态 | 关键规则 |
|---|---|---|---|
| GET | `/api/v1/home` | 契约外补充（保留原因：任务书路径（三分支演示），契约仅定义 /home/summary） | BIND_PHONE / UPCOMING_APPOINTMENT(带 appointmentId) / AI_GUIDANCE；问候语 Asia/Shanghai |
| GET | `/api/v1/home/summary` | 契约路径 ✅ | HomeSummary：greeting+blocks |
| POST | `/api/v1/triage` | 契约外补充（保留原因：任务书路径，契约路径为 /triage/recommendations；同一引擎） | localRuleHits 非空不降级→EMERGENCY+120；红旗词表；provenance=RULE_RESULT；limitations 固定文案 |
| POST | `/api/v1/triage/emergency-check` | 契约外补充（保留原因：任务书路径，契约路径为 /triage/emergency-checks；同一引擎） | 复用 TRIAGE-RULES-001 |
| POST | `/api/v1/triage/recommendations`、`/api/v1/triage/emergency-checks` | 契约路径 ✅（M2 随域切换，同一引擎 TRIAGE-RULES-001） | 与任务书别名 /triage、/triage/emergency-check 同一实现，契约路径 200 |
| GET | `/api/v1/contents`、`/api/v1/contents/{contentId}` | 契约路径 ✅ | 只返回 reviewStatus=APPROVED 且有效期内（HUMAN_REVIEWED）；草稿 404；响应 ContentItem 形状（id/title/summary/category/reviewStatus/effectiveFrom/publishedAt/readCount） |

#### resources 域（复核补齐）

| 方法 | 路径 | 三态 | 关键规则 |
|---|---|---|---|
| GET | `/api/v1/resources/manifest` | 契约路径 ✅ | manifestVersion+items；query: platform（const=wechat-miniprogram，其他值→422）、clientVersion≤20；7 条内置条目全 level=A、mime=image/png、url=null、真实 sha256（64 位小写 hex）；硬校验：可执行后缀黑名单（.js/.wxml/.wxss）、禁词表（redflag/红旗/rule/规则）命中即启动失败 |

#### M2 端点逐条状态（consultations / ai-tasks / voice / care-plans，V4 迁移）

| 方法 | 路径 | 三态 | 关键规则 |
|---|---|---|---|
| GET | `/api/v1/consultations` | 契约路径 ✅ | cursor/limit 游标分页（limit bounded，非法 cursor→422）；服务端身份范围过滤；meta.nextCursor |
| POST | `/api/v1/consultations` | 契约路径 ✅ | Idempotency-Key 必填（缺→400）；**急症优先**：本地红旗规则先行（provenance=RULE_RESULT，不等模型）；**用户消息先落库再建 AI 任务，生成失败（503）不影响消息持久化**；同键同体 200 重放、同键异体 409、上次任务失败同键重试补建任务 |
| GET | `/api/v1/consultations/{consultationId}` | 契约路径 ✅ | 归属 user_id 参与 SQL 条件，他人→404（不泄露存在性）；返回会话+messages+latestTask |
| POST | `/api/v1/consultations/{consultationId}/messages` | 契约路径 ✅ | 同上幂等三态；消息先经独立事务落库再建任务（生成失败不回滚消息） |
| POST | `/api/v1/consultations/{consultationId}/confirmations` | 契约路径 ✅ | 转写/结构化输入确认：DRAFT→CONFIRMED（确认先独立提交，随后终止源任务失败不连带回滚）；同键同体重放、异体 409、无草稿→404 SOURCE_TASK_NOT_FOUND；他人会话→404 |
| GET | `/api/v1/ai/tasks/{taskId}` | 契约路径 ✅ | 断线恢复权威（轮询单查）：**result 仅 SUCCEEDED 出现、error 仅 FAILED 出现**（NON_NULL 序列化）；他人任务→404 TASK_NOT_FOUND；taskId>64→422 |
| DELETE | `/api/v1/ai/tasks/{taskId}` | 契约路径 ✅ | 终态幂等：重复取消返回同一终态（不再调上游）；上游不可达时本地强制 CANCELLED（不假装还在跑） |
| GET | `/api/v1/ai/tasks/{taskId}/events` | 契约路径 ✅ | SSE：`Cache-Control: no-store` + `X-Accel-Buffering: no`（不缓冲）；progressPhase 为阶段名非百分比；result 仅终态 SUCCEEDED 事件出现 |
| POST | `/api/v1/voice/asr` | 契约路径 ✅ | Idempotency-Key 必填（缺→400，**header 承载**，契约 `in: header`——08G §12 N-3 返工对齐）；时长 1~60000ms（超→400，不提交上游）；空音频→400；上游能力不可用→503 结构化；识别成功落 **DRAFT** 草稿，`requiresConfirmation` 恒 true，响应不回显 inputRef |
| POST | `/api/v1/voice/tts` | 契约路径 ✅ | Idempotency-Key 必填；同文本缓存重放 `cached=true`（不重复打上游）；上游失败→503 TTS_UNAVAILABLE 降级提示（保留文字展示） |
| GET | `/api/v1/voice/voices`、`/voices/default` | 契约路径 ✅ | 内置音色来自服务端配置（isCustom=false）+ 用户自定义；默认音色 qwen3-female-1 |
| POST | `/api/v1/voice/voices` | 契约路径 ✅ | 保存音色偏好（契约 VoicePreference：voiceId 必填，rate/autoPlay 可选）；未知音色回退默认 |
| DELETE | `/api/v1/voice/voices/{voiceId}` | 契约路径 ✅ | 幂等防探测：不存在/内置音色也返回 200（deleted=true/false），仅删当前用户自定义音色 |
| POST | `/api/v1/voice/voices/{voiceId}/previews` | 契约路径 ✅ | 未知/不存在音色→404 VOICE_NOT_FOUND（试听不静默回退）；未知音色保存偏好时回退默认音色 |
| GET | `/api/v1/voice/models` | 契约路径 ✅ | 能力状态如实：探针不可达→各项 status=unavailable 且 detail 非空（**不 200+空对象**） |
| POST | `/api/v1/care-plans` | 契约路径 ✅ | Idempotency-Key 必填；定位生活方式建议（limitations 固定含"不构成处方"）；证据不足→结构化拒答（refused=true，不用通用话术填充）；同键同体重放、异体 409；上游失败→503 且**同事务回滚不落 PENDING 残行** |

#### M3 端点逐条状态（doctor / beds / consents / deletion，V5 迁移）

| 方法 | 路径 | 三态 | 关键规则 |
|---|---|---|---|
| POST | `/api/v1/doctor/login` | 契约路径 ✅ | `x-idempotency: not-required`（不要求幂等键）；X-Client-Version/X-Platform 必填（缺失→400，Platform 非 const→422）；请求体 WechatLoginRequest（严格）；**角色由服务端按任职关系判定**（`doctors.user_id` + status=ACTIVE）→ 非医生 403 FORBIDDEN（不签发会话） |
| GET | `/api/v1/doctor/workbench` | 契约路径 ✅ | 范围为任职科室 + 该科室 ACTIVE 病区（`scope.departmentIds/wardIds`，不接受客户端传范围）；summary 四计数按 UTC 日窗口；**子块独立降级**（异常→该块 `unavailable` 且省略该计数，不用 0 冒充）；无任职→403 |
| GET | `/api/v1/doctor/appointments` | 契约路径 ✅ | doctor_id 参与 SQL 条件（他科挂号不出现）；status?/date?（yyyy-MM-dd，非法→400）/cursor?（非法→422）/limit?（1~50 钳制）；`meta.nextCursor`（无更多时省略） |
| POST | `/api/v1/doctor/appointments/{appointmentId}/status` | 契约路径 ✅ | Idempotency-Key 必填（缺→400）；body required=[toStatus, expectedVersion]（缺→422）；**状态机**非法转换（含终态、含流转到自身）→409 `APPOINTMENT_STATUS_INVALID`；`expectedVersion` 不匹配→409 `VERSION_CONFLICT`；每次流转追加 `appointment_status_events`（操作者/医生/服务端时间戳）；他人或他科挂号→404 |
| GET | `/api/v1/beds` | 契约路径 ✅ | 范围 = 授权病区（ward_id 白名单进 SQL）；显式指定越权病区→403；status? 作筛选条件；`occupantDisplayName` 为写入时即脱敏的展示名（不落明文姓名） |
| POST | `/api/v1/beds/{bedId}/assignment` | 契约路径 ✅ | Idempotency-Key 必填；五动作状态机（非法动作组合→409 `BED_STATE_CONFLICT`）；`expectedVersion` 乐观锁（不匹配→409）；ASSIGN 必填 `patientRef`（内部患者 ID；手机号/姓名→422，不存在→404），占用者脱敏落库；越权病区床位→404 |
| GET | `/api/v1/consents` | 契约路径 ✅ | 每 purpose 取最新一行（撤回记录同样返回、不从列表消失）；响应形状与 `/me` 的 `User.consents` **同源同一查询** |
| POST | `/api/v1/consents` | 契约路径 ✅ | Idempotency-Key 必填；追加式（不改写历史行）；purpose/channel 枚举外→422；同键同载荷→200 重放（不追行）、同键异载荷→409 |
| POST | `/api/v1/consents/{purpose}/withdraw` | 契约路径 ✅ | Idempotency-Key 必填；追加 WITHDRAWN 行（不删历史、不原地覆盖）；**重复撤回→200 同一终态**（不再追加）；reason ≤200（超→400）并如实落库；purpose 未知/从未授权→404（该路径契约未声明 422，不臆造状态码） |
| POST | `/api/v1/me/deletion-requests` | 契约路径 ✅ | Idempotency-Key 必填；返回**受理状态 RECEIVED**（不设 completedAt、不声明已删除）；`retainedItems` **逐项**列出法定保留例外（引用 `docs/v4/07` §8 原文与"待确认"状态，`retainUntil` 一律 null——期限未获法务确认，不编造日期）；scope 空/枚举外→400（该路径契约未声明 422）；同键同载荷→200 同一受理编号、同键异载荷→409 |
| GET | `/api/v1/me/deletion-requests/{requestId}` | 契约路径 ✅ | user_id 参与查询条件：**他人的申请一律 404**（不返回 403，避免存在性泄漏） |

### M3 解释性口径（契约未给定义，登记待用户/Agent-D 裁定）

| # | 口径 | 说明 |
|---|---|---|
| 1 | `waitingPatients` / `pendingReviews` 计数定义 | 契约只给出计数名，未给定义。当前实现：前者 = 今日 `CHECKED_IN`（已签到候诊）数，后者 = 今日 `PENDING`（待医生确认）数 |
| 2 | 挂号状态转换表 | 契约只给 `AppointmentStatus` 枚举与"状态机驱动"，未逐条列出允许转换。当前实现：PENDING→{CONFIRMED,CHECKED_IN,CANCELLED,NO_SHOW,EXPIRED}；CONFIRMED→{CHECKED_IN,CANCELLED,NO_SHOW,EXPIRED}；CHECKED_IN→{COMPLETED,CANCELLED}；其余为终态（含流转到自身→409） |
| 3 | 床位分配幂等判定 | 契约要求 Idempotency-Key 但表结构无独立幂等表。当前实现：以该床位**最近一次分配操作**的键 + 载荷摘要判定重放；陈旧键重放由 `expectedVersion` 乐观锁兜底为 409 |
| 4 | 未声明错误码的处理 | 契约未声明的状态码一律不下发：对"取值不在枚举内"的查询参数按筛选语义（空结果）或最近似已声明错误处理（如 withdraw 的 purpose→404），参数类型错误仍为 400 |

#### 其余契约路径（仍未实现 → 501）

| 路径 | 说明 |
|---|---|
| `/internal/v1/callbacks/task-events` | 契约 `x-status: provisional`（O-02 未定稿），**明文"不得作为实现的依据"**；定稿前以轮询 `GET /internal/v1/tasks/{taskId}` 为权威 → 保持 501 即正确 |
| `/api/gw/*`（health / routes / voices） | 契约 `x-served-by: edge-gateway`，由网关进程提供，业务后端不应有 handler → 501 可识别错误 |

### M4 硬化说明（鉴权 / 审计 / 限流 / 契约与并发测试 / 迁移演练）

- **鉴权（三层拦截器）**：`AuditInterceptor(order 0) → AuthInterceptor(order 1) → RateLimitInterceptor(order 2)`，仅拦 `/api/v1/**`（`/api/gw/*` 保持 501，`/internal/*`、`/actuator` 不拦）。三档模式见 `APP_AUTH_MODE`；受保护路径无身份 → 401 `UNAUTHORIZED`，伪造/撤销会话 → 401 `SESSION_REVOKED`；IDOR 抽查（他人资源一律 404 不泄露存在性、非医生 403）由 `M4AuthTest` / `M4StrictAuthTest` 固化。
- **审计（V6__m4_audit.sql）**：`audit_events` 只追加（无 UPDATE/DELETE 路径，源码级断言在 `M4AuditTest`）；action 记路径模板（不含对象 ID 与正文）；主体统一为业务主键（openid→`u-` 映射）；写入失败记 ERROR 不打断业务。
- **限流**：固定窗口（进程内存），只拦契约声明 429 的 **12 条路径**；登录类键=IP、提交类=认证主体；429 信封与网关口径一致（`RATE_LIMITED` + `Retry-After` + `retryable=true`）。itest 阈值放宽至 100000 防测试互扰。
- **契约测试（`M4ContractCoreTest` / `M4ContractConsultTest` / `M4ContractDoctorTest`，16 例）**：逐路径真实探针，断言实测状态码 ∈ `business-openapi.yaml` 各操作声明集合；上游 AI 以 `@MockitoBean` 替身（沿用 M2 模式）；501 占位（`/api/gw/*`、internal 回调）显式断言。
- **并发专项（`M4ConcurrencyIdemTest` / `M4ConcurrencyVersionTest`）**：真实 Tomcat（RANDOM_PORT）8 线程同键双发预约 → 恰落 1 行、无 5xx（撞 `uk_appointments_idem` 由 `AppointmentController#createWithRaceFallback` 兜底转重放/409，号源扣减随事务回滚不泄漏）；8 线程抢同一 `expectedVersion=1`（状态流转/床位分配）→ 恰 1 胜出、其余结构化 409、终态版本 +1 且伴随事件恰 1 条。
- **迁移回滚演练（`M4MigrationDrillTest`）**：H2 文件库三阶段——空库迁到恢复点 V5（`audit_events` 不存在）→ 同库续迁 V6 → 第三次 migrate `migrationsExecuted=0`（幂等）；Flyway Community 无 undo，回滚口径 = 回到恢复点（`spring.flyway.target=N`）续迁，证据 `backend/deploy/run/m4-m-side-2026-10-16/`。

## 数据库（M0.2 / M0.3 / M1 复核补齐 / M2 / M3 / M4）

- 迁移：`src/main/resources/db/migration/`（生产唯一来源；**V1/V2 已应用不可改，只增不改**）
  - `V1__core_tables.sql`：`users` / `user_profiles` / `consents` / `departments` / `doctors` / `doctor_slots` / `appointments`（utf8mb4，UTC 时间，必要约束与索引）
  - `V2__m1_tables.sql`：`user_preferences`（version 乐观锁）/ `contents`（review_status + 有效期）
  - `V3__patient_tables.sql`（复核补齐）：`auth_sessions`（refresh 一次一换、revoked/refresh_used、access/refresh 双哈希唯一索引）/ `health_records`（category 枚举、version 乐观锁、(user_id,idempotency_key) 唯一）/ `family_members`（proxy_status 默认 NONE——添加≠授权）/ `family_invitations`（token_hash 唯一、一次性、TTL）
    - **dev 本地库例外**：dev 库在 V3 前已应用 dev 种子 V9000/V9001（更高版本号），故 dev profile 开 `flyway.out-of-order: true` 允许 V3 补跑；**生产迁移顺序恒为 V1→V2→V3→V4，无 out-of-order**。
  - `V4__m2_tables.sql`（M2）：`consultations` / `consultation_messages`（generation_status 草稿→确认、(user_id,idempotency_key) 唯一）/ `ai_tasks`（业务侧权威行、error_retryable、终态守卫）/ `care_plan_requests`（同键重放）/ `custom_voices` / `voice_preferences` / `tts_cache`（HMAC 缓存键）/ `asr_inputs`（只留审计元数据，不存音频字节）
  - `V5__m3_tables.sql`（M3）：`wards`（病区→科室，医生授权范围由此推导）/ `beds`（一床一占用者；`occupant_display_name` 只存**已脱敏**展示名；version 乐观锁 + `last_idempotency_key`/`last_request_digest`/`last_note` 记录最近一次分配）/ `appointment_status_events`（状态流转审计，只追加；(operator_user_id,idempotency_key) 唯一兼作重放凭据）/ `deletion_requests`（`retained_items_json` 受理时定格保留例外）；并 ALTER `consents` 追加 `idempotency_key`/`request_digest`/`withdraw_reason` 与 `(user_id, idempotency_key)` 唯一约束（历史行保持 NULL，不影响既有数据）
  - `V6__m4_audit.sql`（M4）：`audit_events` 审计事件表（**只追加**：actor_user_id 可空 / action=路径模板 / object_type / outcome=SUCCESS·DENIED·FAILED / status_code / request_id / client_ip / server_time）；不落请求与响应正文（docs/v4/03 §39「不可含原始健康内容」）；索引按 actor/object/action/request 四维查询建立
  - `V7__frontend_contract_fields.sql`（前端数据依赖补齐，2026-10-17）：逐列 ALTER（H2 兼容）——`departments` +`hospital_name/building/floor/area/room_no`；`appointments` +`location/hospital_name`（历史行按科室回填）；`health_records` +`source/doctor_name/abnormal`；`family_members` +`gender/phone_masked`；`contents` +`content_type/cover_url/video_url/duration_sec/read_time_sec`；新表 `home_block_config`（首页 QUICK_SERVICES 运营配置，首批 8 条与前端 `SERVICES` 对齐，缺配置时服务端回退内置 8 项）
- dev 种子：`src/main/resources/db/dev/V9000__dev_seed.sql`（**仅 dev profile 加载**
  = `spring.flyway.locations` 在 dev 下追加 `classpath:db/dev`；生产不含此目录）
  - 4 科室（消化内科 / 呼吸内科 / 心血管内科 / 骨科）+ 每科室 2 位医生 + 每医生未来 7 天上午/下午号源（capacity 5）
  - `V9001__m1_dev_seed.sql`：4 条养生科普内容（3 条 APPROVED/HUMAN_REVIEWED + 1 条 DRAFT 演示不可见）
  - `V9002__m3_dev_seed.sql`（M3）：把 `doc-gastro-1`（林建平）绑定到 dev 账号 `u-dev-user-2`（使"code 含 dev-user-2"的医生登录可真实命中任职关系）+ 3 个病区（消化内科一/二病区、呼吸内科一病区）+ 5 张床位（含 1 张已占用，用于演示脱敏展示名）
  - `V9003__frontend_contract_seed.sql`（前端契约联调种子，2026-10-17）：15 个 ACTIVE 科室（覆盖前端 `triage-kb` 科室名）+ `dep-emergency`（INACTIVE，用于验证"停诊科室不下发"）+ 22 位医生与其未来 7 天上午/下午号源（两段 `INSERT…SELECT`，不用 `LATERAL`）+ 9 条 APPROVED 科普（6 图文 + 3 视频，`video_url/cover_url` 指向 `/api/gw/assets/*`）+ 预约 `location/hospital_name` 回填 + `user_profiles` 性别/生日 + 血压类 `health_records.abnormal=0`；旧 `cont-dev-001~003` 置 `RETIRED`（避免与新内容重复）

## 严格反序列化（契约 additionalProperties:false 落地）

Spring Boot 默认关闭 `FAIL_ON_UNKNOWN_PROPERTIES`，仅给 DTO 标 `@JsonIgnoreProperties(ignoreUnknown=false)` 形同虚设。故全局启用严格反序列化（`JacksonStrictConfig`）：

- **契约严格 DTO**（无注解即拒绝未知字段）：`WechatLoginRequest`、`HealthRecordCreateRequest`、`FamilyMemberCreateRequest`、`FamilyInvitationCreateRequest`、`ConsultationCreateRequest`、`MessageCreateRequest`、`InputConfirmationRequest`、`CarePlanRequest`（M2 四域）、`ConsentGrantRequest`、`DeletionRequestCreateRequest`（M3）。
- **契约外补充 / 宽松 DTO**（显式 opt-out）：`AppointmentCreate/UpdateRequest`、`TriageRequest`、`EmergencyCheckRequest`、`PhoneBindRequest`、`ProfileUpdateRequest`、`PreferencesUpdateRequest`、`HealthRecordUpdateRequest`、`CancelRequest`、`FamilyMemberUpdateRequest`、`AppointmentStatusUpdateRequest`、`BedAssignmentRequest`、`WithdrawRequest`（M3 三个 body 契约未声明 `additionalProperties:false` → 宽容）。

## 一键自检

```text
cd backend/business-service
mvnw -q test                      # 单测（不依赖数据库）
curl http://127.0.0.1:8088/actuator/health
node ../../tools/check-v4-contracts.js   # 仓库级契约门禁
```

## 反例红线（总纲 §9-5，违反即返工）

不改契约 / 不越所有权（`edge-gateway/**`、`ai-service/**`、`deploy/**`、`miniprogram/**`）；
不伪造数据；不 `200 + 空对象`；不把未实现说成已实现；dev 种子不进生产迁移。
