# edge-gateway（后端实施 · Agent-D 交付物 D1）

前端唯一入口：`/api/gw/**`（网关自身）+ 全量反向代理到 business-service + legacy 兼容层。
- 契约面：`backend/contracts/business-openapi.yaml`（`edge-gateway` 标签 + `x-migration`）
- 配置唯一处：`backend/deploy/config.json`（环境变量 `GW_*` 可覆盖）
- 实施纪律：`docs/v4/08` §6（单一实现、不双写）与 §8（一键启动）

## 路由策略（V4 目标态，注意与旧白名单相反）

| 路径 | 去向 |
|---|---|
| `/api/gw/**` | 网关自身（`/api/gw/undefined` 返回 404，不代理） |
| `/health` | 网关健康（x-migration：探针收敛到网关） |
| `/api/**` 其余 | **全量代理 business-service**（不按旧 `JAVA_PREFIXES` 白名单分流） |
| legacy 旧路径 | 经兼容层翻译后进 business-service（见 `COMPAT.md`） |
| `/api/gw/tts/audio/{filename}` | **TTS 产物公开通道**（M2/O-10）：显式白名单校验后转发到 ai-service 内部签名通道 `/internal/v1/tts/audio/{filename}` |
| `/api/gw/assets/{filename}` | **静态素材公开通道**（前端适配）：白名单图片从 `backend/deploy/resources/` 直接分发（ETag/304 + sha256 头） |

> ⚠️ 与旧版网关（`JAVA_PREFIXES` 白名单、Python 直连）语义**相反**：新网关不再向客户端暴露
> ai-service。`/api/gw/health` 仍探测两个上游（java/python）作为诊断摘要。

## 行为要点

- **流式回传（D2.2 SSE 语义）**：响应 raw 字节直通，SSE（`GET /api/v1/ai/tasks/{id}/events`）**不被缓冲**；
  上游 `Cache-Control: no-store` / `X-Accel-Buffering: no` 等头原样透传（只剥逐跳头与 `content-length`/`content-encoding`），
  网关侧不注入、不改写、不聚合事件；**断线恢复一律回 `GET /api/v1/ai/tasks/{id}` 轮询兜底**（事件流不作为权威状态）。
  网关不伪造 `delta`/百分比：阶段名与进度全部来自上游（契约 `progressPhase` 是阶段名，不是百分比）。
- **兼容响应适配（M1）**：legacy 条目可声明 `responseAdapter`（`compat.py`）；仅作用于 **2xx + JSON** 响应，
  以「**加字段**（保留新契约字段）+ 信封降级（`code:"OK"` → 数字 `200`）」方式返回遗留形状；
  非 JSON / 非 2xx 一律原样透传。旧前端 `request.js` 的 unwrap 只认 `code===200/0`，故 legacy 成功响应必须降级。
- 出站统一 `accept-encoding: identity`；不透传逐跳头、`content-length`、`content-encoding`。
  **出站头一律小写归一后写入 dict**（HTTP 头大小写不敏感，同名视为同一个头）：`headerOverrides` 是**覆盖**而非追加，
  否则上游会收到两条 `X-Platform`（Spring 取第一个 → 契约 const 校验失败 → 422）。用例 `tests/test_proxy_headers.py` 钉死该语义。
- 代理客户端 `trust_env=False`：**本地/内网上游不走环境代理**（防 `HTTP_PROXY/ALL_PROXY` 劫持回环连接；生产同理）。
- 失败语义见下方「错误信封映射表」（统一信封 `code/message/requestId/retryable/serverTime`）。
- `/api/gw/routes` 需要 `Authorization` 头（联调口径；令牌校验属 Spring Boot，M4 收口）。
- `/api/gw/tts/audio/{filename}` 是**唯一**向客户端开放的 ai-service 通道（**不**公开 `/internal/**` 前缀本身）：
  文件名先过网关白名单 `^[0-9a-f]{16,64}\.mp3$`（非法即 404，不下发上游）；**不要求登录态**——鉴权由
  ai-service 签发的**短期签名 token** 承担（音频元素无法携带 `Authorization` 头）；网关不解 token、不缓存、不改写响应体。
- `/api/gw/assets/{filename}` 是**静态素材公开通道**（前端适配，`docs/v4/09` §4.2）：公开只读（图片元素无法携带
  `Authorization` 头）；四道白名单（文件名 `^[a-z0-9][a-z0-9._-]{0,79}$` 禁斜杠与 `..` + 扩展名 png/jpg/jpeg/webp/**mp4**
  + 目录穿越双保险 + 单文件 ≤4MiB）；响应带 `ETag`/`Cache-Control`/`X-Resource-Sha256`/`X-Resource-Size`，
  支持 `If-None-Match` 304 与 HEAD；目录取 `config.json.assets.dir`（默认 `backend/deploy/resources`）或 `GW_ASSETS_DIR`。
  `mp4` 供科普视频 `<video>` 播放（前端 `knowledge-kb` 视频条目）；仅此一类媒体扩展名，音频仍走 TTS 签名通道。
- `/api/gw/health` 是三上游探针聚合（`java`=business / `python`=ai / `ollama`=本地大模型 `/api/tags`）：
  任一不可达则整体 `degraded`（业务与 AI 均可达但 ollama 不可达也只降级，不判故障——导诊有本地规则兜底）；
  探针地址取 `config.json.upstreams.ollama` 或 `GW_OLLAMA_URL`，路径 `GW_OLLAMA_PROBE_PATH`（默认 `/api/tags`）。
- 代理读超时默认 220s（`deploy/config.json` 可配），大于前端三档超时（90/120/180s）。
- **限流（M4 硬化前瞻，默认关）**：固定窗口计数，按客户端标识（`X-Forwarded-For` 首跳 / 直连地址）计数；
  命中 → 429 + `Retry-After`。定位是**保护上游**，不是配额计费；探针路径（`/health`、`/api/gw/health`）**豁免**，
  避免编排器的健康轮询被自己限死。配置：`config.json.rateLimit` 或 `GW_RATE_LIMIT_*`。

## 错误信封映射表（D1.3）

| # | 场景 | 网关行为 | HTTP | code | retryable | 备注 |
|---|---|---|---|---|---|---|
| 1 | business-service 连不上（拒绝连接/DNS 失败） | 网关生成信封 | 503 | `UPSTREAM_UNAVAILABLE` | true | `trust_env=False` 保证本地不被环境代理劫持 |
| 2 | 上游任一超时（连接/读取/写入/池等待） | 网关生成信封 | 504 | `UPSTREAM_TIMEOUT` | true | 含 `ConnectTimeout`；读超时默认 220s |
| 3 | 其他传输层错误（协议异常等） | 网关生成信封 | 502 | `UPSTREAM_ERROR` | true | — |
| 4 | 上游业务 4xx/5xx（统一错误信封） | **原样透传**（状态码+响应体） | 原样 | 原样（如 `VALIDATION_FAILED`） | 原样 | **不双重包装**；错误路径无响应适配 |
| 5 | `/api/gw/**` 未定义路径 | 网关生成信封 | 404 | `NOT_FOUND` | false | 网关自身域优先，不落代理 |
| 6 | `/api/gw/routes` 缺 `Authorization` | 网关生成信封 | 401 | `UNAUTHORIZED` | false | M4 收口正式令牌校验 |
| 7 | legacy 条目未完成迁移（pending） | 网关生成信封 | 501 | `COMPAT_PENDING` | false | 含里程碑与迁移说明；**不可等价转发**时随 `details` 逐条给出原因（`COMPAT_BLOCKER`，见 `COMPAT.md` #17/#18） |
| 8 | legacy 条目已废弃（dropped） | 网关生成信封 | 410 | `COMPAT_DROPPED` | false | 不会以旧语义复活 |
| 9 | 翻译器/适配器名称缺失（部署错误） | 网关生成信封 | 500 | `COMPAT_TRANSLATOR_MISSING` / `COMPAT_ADAPTER_MISSING` | false | 条目自洽性由测试用例覆盖 |
| 10 | 网关内部未处理异常 | 网关生成信封 | 500 | `INTERNAL_ERROR` | false | 记录日志，不回显堆栈 |
| 11 | 触发网关限流（M4 前瞻，默认关） | 网关生成信封 | 429 | `RATE_LIMITED` | true | 附 `Retry-After` 秒数；探针路径豁免 |

**边界说明**
- 上游返回**非 JSON** 的 4xx/5xx（如容器默认错误页）同样按 #4 原样透传；legacy 客户端错误路径只读 `message/msg`，无需适配。
- 响应适配失败（结构不符/解析失败）→ 原样透传 + warning 日志：不中断用户链路，不吞错。

## 启动

```text
backend/edge-gateway/.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

环境变量：`GW_BUSINESS_URL` / `GW_AI_URL` / `GW_PORT` / `GW_PROXY_TIMEOUT_SECONDS` / `GW_CONFIG_PATH` / `GW_RATE_LIMIT_ENABLED` / `GW_RATE_LIMIT_PER_MINUTE` / `GW_RATE_LIMIT_WINDOW_SECONDS` / `GW_ASSETS_DIR`。

## 测试

```text
backend/edge-gateway/.venv/Scripts/python.exe -m pytest backend/edge-gateway/tests -q
```

联调替身（仅测试用途，非业务实现）：`tests/mock_business.py`（8088 端口回显，用于代理/兼容层验证；含 SSE 替身端点 `/api/v1/ai/tasks/{id}/events`）。

**M2 · D2.2 SSE 验证（`tests/test_m2_sse.py`）**：断言网关对事件流**原样流式透传**——
① `content-type: text/event-stream` 保留；② 上游 `Cache-Control: no-store` / `X-Accel-Buffering: no` 原样到达；
③ 响应**无 `content-length`**（Starlette 的流式分支特征；对照用例证明走响应适配器的 legacy 路径会被读齐 → 有 `content-length`）；
④ 三段事件（accepted/status/completed）顺序完整到达。

**M2 · O-10 TTS 产物通道验证（`tests/test_m2_tts_audio.py`）**：断言 `/api/gw/tts/audio/{filename}` ——
① 合法名 + 合法签名 → 200 `audio/mpeg` 且**字节原样透传**（不套业务信封）；② 非法签名 → 403 **原样透传**
（校验在 ai-service 侧，网关不越权判定）；③ 非白名单文件名（长短/后缀/非十六进制）→ **404，不下发上游**。

**M3 · 网关「不缺项」核验 + legacy 处置留痕（`tests/test_m3_coverage.py`）**：把「不缺项」做成可执行断言——
① 15 条 M3 契约路径（医生端/床位/档案/家庭/同意/删除/内容）**不被任何兼容条目拦截**，且经全量代理**确实到达上游**
（用 mock 回声的 `method`/`path` 佐证）；② `#17`/`#18` 两条 legacy 路径必须 **501 + 逐条原因**，且**不得**被转发到上游
（回归护栏：若误转发会拿回 mock 回声 → 判失败）；③ `#18` 的**方法差异**（前端 `PUT` vs x-migration `POST`）两种注册都已承接。

**M4 前瞻 · 限流（`tests/test_ratelimit.py`）**：纯函数层（窗口重置 / 键隔离 / 桶清理 / 客户端标识优先级）+ 集成层
（429 信封与 `Retry-After` / 默认关不拦截 / 探针豁免）。

**M4 · D4.2 安全抽查（`tests/test_security_spotcheck.py`）**：① 路径注入/目录穿越载荷**不被代理展开**（原样字节转发，上游自判 404/405）；
② `redact.py` 日志脱敏——`Bearer`/`Token:`/`Idempotency-Key` 值、手机号、身份证、邮箱在**任何日志落盘前**被掩码
（`install_redaction()` 在 lifespan 挂全局 Filter，幂等；普通诊断字段 `taskId`/`model`/计数不受影响，保留排障能力）；
③ 掩码规则自身（`redact()` 纯函数）对边界输入幂等。

## 故障演练（M4 · D4.1）

真实打停 + 幂等补起的依赖中断演练（降级语义以**运行态探针**为准）：

```text
backend/ai-service/.venv/Scripts/python.exe backend/deploy/scripts/fault_drill.py \
  --deploy backend/deploy --out backend/deploy/run/<证据目录>
```

矩阵：网关宕→business 直连仍 UP；ai 宕→经网关 TTS `503 CAPABILITY_UNAVAILABLE`（快降级）；
business 宕→经网关 `503 UPSTREAM_UNAVAILABLE`；stop-all 后 8000/8001/8088 无 LISTENING 残留；
全程用 `start-all.bat` 幂等补起（健康即 `already` 跳过）。证据样例：`backend/deploy/run/m4-d-side-2026-10-16/`。

## 未完成项（按里程碑）

- ✅ M1：五条兼容条目激活（急诊检查/科室推荐/医生列表/按科室/旧登录）：请求翻译 + 响应适配 + 信封降级；
  错误信封映射表（D1.3）见上（M1 轮 30 个 pytest 用例；M2 轮 +2 SSE +3 TTS 产物通道 → 35 个）。
- M2：会话/任务/养生/音色预览等 pending 条目激活；**SSE 语义（D2.2）已就位**——全量代理分支对 `/api/v1/ai/tasks/{id}/events` 原样流式透传（无需兼容条目；证据 `tests/test_m2_sse.py`）；**TTS 产物公开通道（O-10 定稿）已就位**——`/api/gw/tts/audio/{filename}` 白名单转发（证据 `tests/test_m2_tts_audio.py`）；该轮共 35 个 pytest 用例。
- ✅ **M3（D 侧，本轮）**：**网关不缺项核验就位**——15 条 M3 契约路径全覆盖且不被兼容层拦截（证据 `tests/test_m3_coverage.py`）；
  `/api/appoint/updateStatus` 与 `/api/v1/bed/update/**` 经核验**不可等价转发**（缺乐观锁版本 / 状态枚举不可双射 / `patientRef` 禁传姓名 / 缺幂等头）
  → **保持 `pending` + `blockers`**（不代填、不伪造），前端须迁移；**方法差异**（前端 PUT vs x-migration POST）两种注册均承接。本轮累计 **83** 个 pytest 用例。
- M4：`/api/gw/routes` 的令牌校验收口；**限流已提前落地**（默认关，`deploy` 显式开启）；**D4.1 故障演练就位**（`deploy/scripts/fault_drill.py`，证据 `run/m4-d-side-2026-10-16/`）；**D4.2 日志脱敏 + 安全抽查就位**（`app/redact.py` + `tests/test_security_spotcheck.py`）；审计待做。
- **前端适配轮（2026-10-16，增量）**：**静态素材公开通道就位**——`/api/gw/assets/{filename}`（证据 `tests/test_assets.py`，10 例；该轮累计 **104** 个 pytest 用例）；配套文档 `docs/v4/09-前端适配与资源外置.md` + 链接自测 `tools/test-resource-links.js` / `docs/v4/09-资源链接自测页.html`。
