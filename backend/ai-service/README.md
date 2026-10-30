# ai-service（后端实施 · Agent-D 交付物 D2）

内部 AI 任务服务。**仅本机/内网可达**：客户端永不调用，网关不为其配置对外路由（契约 `x-boundary`）。

- 契约（冻结，实施依据）：`backend/contracts/ai-openapi.yaml`
- 实施纪律与分工：`docs/v4/08-后端实施双Agent总纲.md`、`docs/v4/08A-Agent-D任务书-DeepSeek-V4.1-Flash.md`
- 边界：业务权威记录在 Spring Boot/MySQL；本服务只持有可重建的中间态（任务状态/结果）。

## 状态（诚实声明）

`0.1.0-m3`（M3 · 运行产物回收就绪；M2 能力不变）：
- 已实现并测试：任务提交/查询/取消、完整状态机（QUEUED→RUNNING→SUCCEEDED|FAILED|CANCELLED|EXPIRED）、
  幂等键（同键同载荷复用、同键异载荷 409）、过期（总超时预算 + 结果保留期）、
  健康探针（live/ready，按能力分档）、服务令牌开关（off/static；jwks 拒绝启动）。
- **M1 新增**：`TRIAGE` 执行器（科室推荐「补充档」）——见下方「任务类型与结果契约」。
- **M2 新增**：`CHAT`（问诊对话）· `CARE_PLAN`（照护建议）· `TTS`（语音合成）· `ASR`（语音识别）
  四个执行器——见下方「任务类型与结果契约」；四者均实现**快降级**（秒级结构化失败，不让上游等待）。
- **M2 新增（D2.4）**：**内容寻址缓存**（`app/cache.py`）——键 `HMAC-SHA256(tenantSecret, taskType|tenantId|inputDigest|modelId|modelVersion|quantization|promptTemplateVersion|policyVersion|knowledgeSnapshot|voice|locale|generationParameters)`（对齐 `docs/v4/04` §9.2；`tenantId` 为 §9.2 之外的**收窄**：本服务只有一个进程级 secret，不并入 tenantId 无法隔离同进程内多租户）。命中即回填结果、**不调执行器**（`cached=true`）；只缓存成功且**非拒答**的 `TRIAGE`/`CHAT`/`CARE_PLAN`。Redis 缺 → 本机 JSON 文件（`runtime/cache.json`，非权威、重启可失）。**默认关**（`AI_CACHE_ENABLED`），deploy 显式开启。
- **M3 新增（M4 硬化前瞻）**：**周期清理与产物回收**（`app/retention.py` + `TaskService.sweep()`，`main` 以 `asyncio` 周期任务驱动）——
  ① 把超时未终结的任务推进为 `EXPIRED`；② 按 `AI_TASK_RETENTION_SECONDS` 裁剪历史任务（含失效幂等索引）；
  ③ 回收「未被在库任务 `result.audioUrl` 引用 + 已过 `AI_TTS_ARTIFACT_TTL_SECONDS`」的 TTS 产物。
  **与「每 50 个任务顺手裁剪」互补**：后者只在有流量时触发，本机制保证**空闲也回收**。全部为**非权威中间态**，回收不影响正确性。
- **仍未实现**：`RAG` 执行器（无检索链路，登记在案）。未注册执行器的任务以 `CAPABILITY_UNAVAILABLE` 快速失败。
- 存储：`runtime/tasks.json`（原子替换；可重建中间态，非业务数据）。

> M2 已定稿口径（用户裁定 2026-10-15）与遗留边界（见文末 TODO）：
> ① **O-10 已定稿**：生产默认 `AI_TTS_ENGINE=edge`（edge-tts：轻量、外部依赖少、首包快）；仅当对
>    音色自然度/情感表现要求极高时才换 Qwen3-TTS（需另接适配器）。未配置仍 **TTS_UNAVAILABLE**，不播占位音。
> ② **audioUrl 可达性已落地**：`audioUrl = AI_TTS_PUBLIC_BASE + AI_TTS_PUBLIC_PATH + /{file}?token=`。
>    对外部署把 BASE 指向客户端可达入口（经网关单入口 = 网关对外域名）、PATH 设为网关公开通道
>    `/api/gw/tts/audio`（网关按显式白名单转发到本服务内部签名通道，**不**公开 `/internal/**` 前缀本身）；
>    未设 BASE 时落回内网默认（仅供本机自测，真机不可达）。
> ③ ASR 音频引用（`asr:{id}`）取用依赖 `AI_ASR_AUDIO_DIR` 目录约定，未配置即能力如实不可用。
> ④ **O-03 铁律（权限先于缓存命中）**：本服务仅内网 `/internal/**` 可达；缓存命中发生在
>    business-service 完成租户隔离/鉴权/角色校验**之后**的任务受理流程内；缓存键含 `tenantId`。
>    缓存**不得**下沉到网关或任何对客户端暴露的路径上。

## 启动

```text
backend/ai-service/.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

**启动必看一行**：每次启动都会打

```text
启动配置摘要 | version=… | cache=on|off | cacheBackend=json | cacheTtlSeconds=… | cacheTenantSecret=configured|auto-random |
rag=on|off | qdrantCollection=… | embeddingModel=… | knowledgeVersion=… | asrEngine=… | asrPreload=on|off |
ttsEngine=… | ttsStream=on|off | llmSmall=… | llmLarge=… | queueMax=… | concurrency=1 | llmConcurrency=1 | llmStream=off | llmHttpReuse=on | llmHttpPool=100/20 | taskTimeoutSeconds=…
```

用于核对「开关到底开没开、缓存用什么后端、模型/集合/知识库版本是什么」；**不含** URL、磁盘路径、密钥值
（`AI_TENANT_SECRET` 只说 configured/auto-random）。验收脚本：`python tools/verify-ai-switches.py {config|cache|asr|rag} --base …`。

## 环境变量（前缀 AI_）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_HOST` / `AI_PORT` | 127.0.0.1 / 8001 | 绑定地址（仅回环） |
| `AI_AUTH_MODE` | off | off=开发档；static=固定令牌（`AI_SERVICE_TOKEN`）；jwks=未实现（拒绝启动） |
| `AI_OLLAMA_URL` | http://127.0.0.1:11434 | 本机模型服务（就绪探针用） |
| `AI_SMALL_MODEL` / `AI_LARGE_MODEL` | qwen2.5:0.5b / qwen2.5:7b | 资源档位对应模型（就绪探针用） |
| `AI_STORE_PATH` | runtime/tasks.json | 任务存储文件 |
| `AI_RESULT_TTL_SECONDS` | 3600 | 终态结果保留期（过期 → EXPIRED） |
| `AI_TASK_TIMEOUT_SECONDS` | 300 | 任务总超时预算（超时 → EXPIRED） |
| `AI_QUEUE_MAX` | 100 | 队列上限（满 → 429 QUEUE_FULL） |
| `AI_TRIAGE_TIMEOUT_SECONDS` | 20 | TRIAGE 单次生成调用的独立短超时（快降级；不占满任务总预算） |
| `AI_CHAT_TIMEOUT_SECONDS` | 30 | CHAT 单次生成调用超时（超时 → `MODEL_TIMEOUT`） |
| `AI_CAREPLAN_TIMEOUT_SECONDS` | 60 | CARE_PLAN 单次生成调用超时 |
| `AI_TTS_ENGINE` | none | none=未配置（→ `TTS_UNAVAILABLE`）/ edge=edge-tts（需本地可导入 `edge_tts`）。**生产默认取 edge**（O-10 定稿） |
| `AI_TTS_TIMEOUT_SECONDS` | 30 | TTS 合成超时（引擎异常一律结构化降级）；**2026-10-22 起真正下传到引擎** `receive_timeout`，仅流式档生效 |
| `AI_TTS_STREAM` / `TTS_STREAM` | true | **流式合成开关（性能/回滚）**：true=共享连接池 + `stream()` 增量落盘（首字节可观测）；false=旧 `save()` 路径。两个变量名等价 |
| `AI_LLM_WORKER_POOL_SIZE` | 1 | **LLM 并发 worker 池大小（性能/回滚）**：>1 时启用多协程 worker 池并发消费任务队列，并启 supervisor 监督异常退出；`1`=旧行为（严格串行，向后兼容）。队列 `AI_QUEUE_MAX` 提供一级背压、httpx 连接池 `max_connections` 为二级背压 |
| `AI_LLM_STREAM` | false | **Ollama 流式开关（性能/回滚）**：true=优先走 `stream=true` NDJSON 累积（可观测首 token）；流式中途失败**自动回退非流式**（WARN + metrics 计数，返回契约不变）。false=始终非流式（旧行为）。`transport` 注入（测试）也走流式，回退同样走注入通道 |
| `AI_LLM_HTTP_CLIENT_REUSE` | true | **httpx 连接复用开关（性能/回滚）**：true=进程级单例 `AsyncClient`（连接池/超时/重试可配，shutdown 释放）；false=每次调用新建一次性 client（旧行为）。两者错误映射一致（统一 `_post_ollama_generate`） |
| `AI_LLM_HTTP_POOL_MAX_CONNECTIONS` | 100 | 复用开启时的连接池上限（`httpx.Limits.max_connections`）；与 worker 池协同，避免打爆 Ollama |
| `AI_LLM_HTTP_POOL_KEEPALIVE` | 20 | 连接池 keep-alive 连接数（`httpx.Limits.max_keepalive_connections`） |
| `AI_LLM_HTTP_TIMEOUT_SECONDS` | 30 | 复用 client 的读超时（`httpx.Timeout` 主值，connect 仍取探针超时） |
| `AI_LLM_HTTP_MAX_RETRIES` | 0 | 底层传输层重试次数（`httpx.AsyncHTTPTransport(retries=)`）；默认 0 不重试，避免与执行器级快降级叠加 |
| `AI_TTS_VOICE_MAP` | （空） | 业务音色 ID → 引擎音色映射，如 `qwen3-female-1=zh-CN-XiaoxiaoNeural`；未命中回退默认 |
| `AI_TTS_DEFAULT_VOICE` | zh-CN-XiaoxiaoNeural | 默认引擎音色 |
| `AI_TTS_OUTPUT_DIR` | runtime/tts | 合成产物目录（非权威，重启可失） |
| `AI_TTS_PUBLIC_BASE` | http://127.0.0.1:8001 | `audioUrl` 基址：对外部署须指向客户端可达入口（经网关 = 网关对外域名）；未设则内网默认、真机不可达 |
| `AI_TTS_PUBLIC_PATH` | /internal/v1/tts/audio | `audioUrl` 路径前缀：对外部署经网关公开通道时设 `/api/gw/tts/audio`（该通道转发到本服务内部签名通道） |
| `AI_TTS_URL_TTL_SECONDS` | 600 | 短期签名 URL 有效期 |
| `AI_TTS_URL_SECRET` | （空） | 签名密钥；空则进程内随机生成（重启后旧 URL 失效） |
| `AI_ASR_ENGINE` | none | none=未配置（→ `CAPABILITY_UNAVAILABLE`）/ funasr=本地 FunASR 权重 |
| `AI_ASR_MODEL_PATH` | （空） | FunASR 权重路径（不存在 → 能力如实不可用） |
| `AI_ASR_TIMEOUT_SECONDS` | 60 | ASR 识别超时 |
| `AI_ASR_AUDIO_DIR` | （空） | 音频引用目录（`asr:{id}` → `{id}.wav|mp3|m4a|pcm|ogg|webm`）；未配置 → 能力如实不可用 |
| `AI_CACHE_ENABLED` | false | 内容寻址缓存开关（D2.4）。默认关：dev/测试不共享全局缓存文件；deploy 显式开启 |
| `AI_CACHE_PATH` | runtime/cache.json | 缓存落盘路径（非权威数据；损坏即丢弃重建） |
| `AI_CACHE_TTL_SECONDS` | 3600 | 缓存条目 TTL（过期即失效） |
| `AI_TENANT_SECRET` | （空） | 缓存键 HMAC 租户密钥；空则进程内随机（重启换键，旧条目自然失效） |
| `AI_TASK_RETENTION_SECONDS` | 86400 | 历史任务保留期（`sweep` 超出即裁剪；含失效幂等索引） |
| `AI_SWEEP_INTERVAL_SECONDS` | 60 | 周期清理间隔；`0`=关闭周期清理（仍有「每 50 任务」兜底裁剪） |
| `AI_TTS_ARTIFACT_TTL_SECONDS` | 3600 | TTS 产物保留期：未被在库任务引用且超时的 `.mp3` 才回收 |
| `AI_RAG_ENABLED` | false | RAG 特征开关（M3）：false=不注册 RAG 执行器、`citations` 恒空（与旧版行为一致）；true=按下列参数启用向量检索 |
| `AI_QDRANT_URL` / `AI_QDRANT_COLLECTION` | http://127.0.0.1:6333 / health_kb | Qdrant 连接与集合名（仅开关开启时探测/检索） |
| `AI_QDRANT_TIMEOUT_SECONDS` / `AI_QDRANT_API_KEY` | 3 / （空） | 单次检索超时 / 可选取证 |
| `AI_EMBEDDING_MODEL` | nomic-embed-text | Ollama 托管的 embedding 模型（需预先 pull，未就绪 → 检索降级） |
| `AI_RAG_TOP_K` / `AI_RAG_SCORE_THRESHOLD` / `AI_RAG_MAX_RETRIES` | 3 / 0.7 / 2 | 返回条数 / 相似度下限 / 失败重试次数 |
| `AI_KNOWLEDGE_BASE_PATH` | config/hospital-knowledge.json | **院内知识库注入层**（静态 JSON，与 RAG 互补，见下节）；文件缺失/损坏 → 自动降级为通用 prompt |

## 端点

**契约路径（共 5 条，ai-openapi.yaml）**：
`POST /internal/v1/tasks` · `GET /internal/v1/tasks/{taskId}` · `POST /internal/v1/tasks/{taskId}/cancel`
`GET /internal/health/live` · `GET /internal/health/ready`
（健康探针按契约**不经**统一信封；就绪 `degraded` 仍返回 200，`down` 才 503。）

**契约外·内部通道（1 条，非客户端契约，登记在案）**：
`GET /internal/v1/tts/audio/{filename}?token=exp.sig` —— 取回 TTS 合成产物。
- 文件名白名单（16~64 位十六进制 + `.mp3`）防路径穿越；签名绑定文件名与过期时间；
- 校验失败 403、文件不存在/非法名 404（均走统一错误信封）；
- **该通道只服务本机/内网**；客户端取用走**网关公开通道** `GET /api/gw/tts/audio/{filename}?token=exp.sig`（edge-gateway 显式白名单转发，见其 README）——本服务内部路径**不**直接对外暴露。

## 降级矩阵（M2 口径）

| 能力 | 状态来源 | 行为 |
|---|---|---|
| ollama（LLM） | 由探针实测 | 在位→available；缺失→degraded(探针)/unavailable |
| redis / qdrant | unavailable | 未启用（内存承担，非硬依赖） |
| asr_model | 由 `AI_ASR_ENGINE` + 权重路径实测 | 就绪→available；未配置/路径不存在→unavailable（**不伪造转写**） |
| tts_provider | 由 `AI_TTS_ENGINE` + 依赖可导入性实测 | 就绪→available；未配置→unavailable（**不播占位音**） |

> 引擎标识**如实返回**（O-10）：未配置即 `none`，就绪即 `edge` / `funasr`，不含糊。

## 任务类型与结果契约（D → M 登记表）

> 任务类型枚举以 `ai-openapi.yaml` 为准（不改契约）；本表登记**已接入的执行器**及其 `result` 形状，
> 供 business-service 编排对接。提交/轮询仍是唯一交互方式（O-02 回调未定稿前不实现回调方向）。

| taskType | 状态 | 输入 | result 形状 | 失败语义（快降级） |
|---|---|---|---|---|
| `TRIAGE` | ✅ M1 | `inputInline` 症状文本 | 见下 | 见下 |
| `CHAT` | ✅ M2 | `inputInline` 本轮对话文本 | 见下 | 见下 |
| `CARE_PLAN` | ✅ M2 | `inputInline` 目标+约束文本 | 见下 | 见下 |
| `TTS` | ✅ M2 | `inputInline` 文本 + `voice` + `locale` | 见下 | 见下 |
| `ASR` | ✅ M2 | `inputRef`（`asr:{id}`）+ `locale` | 见下 | 见下 |
| `RAG` | ✅ M3（开关控制） | `inputInline` 查询文本 | `documents[]`（`documentId`/`chunkId`/`content`/`score`/`metadata`） | `AI_RAG_ENABLED=false` 时不注册执行器 → `CAPABILITY_UNAVAILABLE`（快速失败）；开关开启但 Qdrant/embedding 不可达 → 空结果，CHAT 侧降级为空 `citations` |

**TRIAGE result（`result` 字段，promptTemplateVersion=`triage-supplement-v2`）**：

```json
{
  "recommendedDepartments": [
    {"departmentName": "消化内科", "reason": "腹痛、腹泻提示消化道症状", "confidence": 0.8}
  ],
  "provenance": "AI_GENERATED",
  "limitations": "AI 补充建议，不构成诊断；就诊科室以院内分诊规则与医生面诊为准。",
  "promptTemplateVersion": "triage-supplement-v2"
}
```

调用方（business-service）注意事项：
- **科室名需核对**：`departmentName` 是模型建议名（提示词给了常见科室参考，非硬白名单），
  上游应先用本院科室目录核对/映射为 `departmentId`，未命中即丢弃该条——不降级不猜测。
- **补充档语义**：本任务只做补充；「本地红旗先跑、命中即返回」由业务侧编排承担，
  本服务不接急诊判定链；`provenance` 在上游契约层应标记为 `AI_GENERATED`。
- `confidence` 是模型自评排序分（0~1），**不是医学置信度**，契约层不得展示为「确诊概率」。

**TRIAGE 快降级语义**（`error` 字段；秒级失败，不让上游无限等待）：

| 条件 | code | dependency | retryable | 说明 |
|---|---|---|---|---|
| ollama 不可达 / 模型未安装 | `CAPABILITY_UNAVAILABLE` | `ollama` | true | 探针缓存 5s 内毫秒级返回 |
| 生成调用超时（默认 20s） | `MODEL_TIMEOUT` | `ollama` | true | 独立短超时，不占满任务总预算 |
| 输出非 JSON / 缺结构 | `MODEL_OUTPUT_INVALID` | `ollama` | false | 不缝合半成品 |
| 输入为空 | `INVALID_INPUT` | — | false | 提交方错误 |

**CHAT result（promptTemplateVersion=`consultation-chat-v5`）**：

```json
{
  "text": "建议先记录症状出现的时间与进食关系；若持续加重请线下就诊。",
  "citations": [],
  "provenance": "AI_GENERATED",
  "refused": false,
  "refusalReason": null,
  "language": "zh-CN",
  "hasTimestamps": false
}
```

- `citations` **恒为空数组**（本服务无检索链路）：**不编造来源**，`provenance=AI_GENERATED`；
- 拒答语义：`refused=true` + `refusalReason`（超范围/要求诊断处方时）；
- `language` 只透传模型给出的值，模型不给 → `null`（不猜测）；`hasTimestamps` 恒 `false`。

**CARE_PLAN result（promptTemplateVersion=`care-plan-v1`）**：

```json
{
  "suggestions": [{"title": "固定就寝时间", "detail": "每天同一时间上床，睡前一小时远离屏幕。", "provenance": "AI_GENERATED"}],
  "limitations": "以上为生活方式与膳食参考，不构成处方、治疗方案或用药指导；出现不适请及时就医。",
  "refused": false,
  "refusalReason": null,
  "provenance": "AI_GENERATED"
}
```

- `limitations` **恒含「不构成处方」**（业务侧 red-line 断言依赖此文案，改动需与 M 侧同步）；
- 非拒答但无有效建议 → 收口为**结构化拒答**（`refused=true` + `refusalReason`），不用空数组冒充「没有建议」；
- 建议条目上限 5 条；脏条目（非对象/无标题正文）丢弃。

**TTS result**：

```json
{"audioUrl": "http://127.0.0.1:8001/internal/v1/tts/audio/<sha16>.mp3?token=<exp>.<sig>", "language": "zh-CN"}
```

- **不内联音频字节**；`audioUrl` = `AI_TTS_PUBLIC_BASE` + `AI_TTS_PUBLIC_PATH` + `/<sha16>.mp3?token=<exp>.<sig>`（短期签名，TTL `AI_TTS_URL_TTL_SECONDS`）；
- 相同「文本+音色+语言」命中本地产物 → `cached=true`（不重复消耗算力）；
- **命中契约（修正 2026-10-15，N-5）**：命中 = 产物**存在且非空**。0 字节残留（历史失败产物）既不算命中、也不得留在盘上——先删再重合成。否则该文本会被**永久毒化**（每次跳过合成 → 每次判空失败），现场即因此产生恒 503。
- **原子落盘**：`voice.synthesize` 先写 `{name}.part`，成功且非空才 `replace()` 到目标名；失败/空产出删临时文件并抛错——半成品永不成为缓存产物；执行器另在异常路径**纵深清理** `out_path`。
- 引擎未配置/合成失败 → `TTS_UNAVAILABLE`（`dependency=tts_provider`，retryable=true），**不播占位音**；失败原因记入日志（`err=<类型>: <原因>`）便于定位。

**ASR result**：

```json
{"transcript": "胃胀三天，饭后明显", "language": "zh-CN", "hasTimestamps": false}
```

- `language`/`hasTimestamps` 只透传模型真实给出的值（不提供即 `null`/`false`）；
- 权重未就绪 / 音频引用不可取 → `CAPABILITY_UNAVAILABLE`（`dependency=asr_model`，retryable=true）；
- 转写只是**草稿**：必须经用户确认才能进入诊疗流程（本服务不落任何库）。

**M2 四类执行器快降级语义（`error` 字段）**：

| 条件 | code | dependency | retryable | 适用 |
|---|---|---|---|---|
| 模型服务不可达 / 模型未安装 | `CAPABILITY_UNAVAILABLE` | ollama | true | CHAT / CARE_PLAN |
| 生成调用超时 | `MODEL_TIMEOUT` | ollama | true | CHAT / CARE_PLAN |
| 输出非 JSON / 缺必需结构 | `MODEL_OUTPUT_INVALID` | ollama | false | CHAT / CARE_PLAN / ASR |
| 输入为空 | `INVALID_INPUT` | — | false | CHAT / CARE_PLAN / TTS |
| 引擎未配置 / 合成失败或产物为空 | `TTS_UNAVAILABLE` | tts_provider | true | TTS |
| 权重未就绪 / 音频不可取 / 识别失败 | `CAPABILITY_UNAVAILABLE` | asr_model | true | ASR |

## TTS 性能与缓存（2026-10-22）

**三层结构**（缓存优先，逐层降级）：

| 层 | 机制 | 实测（本机 CPU，edge-tts 真实网络，N=10 + 预热 1 次） |
|---|---|---|
| ① 产物缓存 | `{sha256(text\|voice\|locale)[:16]}.mp3` 存在且非空即命中，`cached=true` | **中位 0.2ms**（冷启动 1928.0ms → 命中 0.2ms，约 1/9600） |
| ② 流式落盘 | `Communicate.stream()` 分片到达即写 `.part`，成功后原子 replace | **首字节中位 1222.5ms**，总耗时中位 **1799.0ms**（占比 ~68%） |
| ③ 连接池 | 进程级 `aiohttp.TCPConnector(limit=8, ttl_dns_cache=300)` | 中位收益 **3.8ms（落在噪声内）**；**WS 每次仍新建 TCP**：3 次合成 = 3 次建连（实测） |

> ⚠️ **连接复用做不到，是库能力限制**：edge-tts 7.3.1 每次合成都对
> `wss://speech.platform.bing.com` 做**新的 WebSocket 升级**，`aiohttp` 不会复用已升级的 socket。
> 共享 `TCPConnector` 只能省掉每次的会话对象与 DNS 解析，**不宣称降低连接建立时间**。
> 因此本轮的优化选型是**流式输出**（可观测首字节 + 无音频快速失败），连接池仅作结构性收敛。

**优化前后（同机同网，数值为中位）**：

| 档位 | 首字节 | 总耗时 | 说明 |
|---|---|---|---|
| 旧路径 `save()`（`TTS_STREAM=false`） | 不可观测（`n/a`） | 1948.3ms（1594.7~2143.0） | 整段写完才知道结果，无音频只能事后暴露 |
| 流式 `stream()`（新默认） | **1222.5ms** | 1799.0ms（1438.4~2165.3） | 首字节≈总耗时 68%，剩余为尾包/落盘/原子替换/签名 |
| 缓存命中 | — | **0.2ms** | 纯文件 + 签名，无网络、无引擎调用 |

**开关与降级**：

- `AI_TTS_STREAM`（兼容别名 **`TTS_STREAM`**）默认 `true`；**回滚**：`TTS_STREAM=false` → 完全回到旧 `save()` 路径
  （不建连接池、不调 `stream()`、保持旧 `Communicate(text, voice)` 调用签名，便于逐字节对照）。
- 流式失败（WS 断开、引擎异常、只收到元数据没有音频）→ 清 `.part` → **自动降级非流式重试一次** →
  仍失败才由执行器转 `TTS_UNAVAILABLE`；**返回契约不变**（`result` 仍是 `{audioUrl, language}`，不内联字节）。
- 超时：`AI_TTS_TIMEOUT_SECONDS`（默认 30）现在**真正作用到引擎层**（`receive_timeout`，此前只声明未生效）；
  仅新路径生效，旧路径保持原样便于回滚对照。

**日志字段**（每次任务一行，便于抓首字节与命中率）：

```text
ai-service.voice          TTS 合成完成 | mode=stream | firstByte=1222.5ms | total=1799.0ms | bytes=48960 | fallback=-
ai-service.executors.tts  TTS 完成 task=... engine=edge cached=False mode=stream firstByteMs=1222.5 totalMs=1799.0 bytes=48960
ai-service.executors.tts  TTS 完成 task=... engine=edge cached=True mode=cache firstByteMs=n/a totalMs=0.2 bytes=48960
```

> `mode` 取值：`stream`（流式）/ `save`（旧路径或降级后）/ `cache`（命中）/ `injected`（注入的自定义合成器）；
> `fallback` 记录流式失败后降级的异常类名（`-` 表示未降级）。旧路径与缓存档没有首字节观测点 → 打印 `n/a`，**不编造**。

**测试**：`tests/test_tts_streaming.py`（**10 项**）—— 流式全量落盘 + 首字节 / connector 与超时确实下发 /
流式失败降级 `save` / 开关关闭只走 `save` / 旧版无 `stream()` 自动退档 / 双失败不留产物 / 只收元数据按失败处理 /
连接池同 loop 复用、跨 loop 重建 / 执行器缓存命中不重复合成且契约不变。
实测脚本：`tools/bench-tts.py --runs 10 --warmup 1`（真实网络）。

## LLM 并发与流式（2026-10-22）

**动机**：旧版 `tasks.py` 单 worker 严格串行、`_llm.py` 每次新建 `httpx.AsyncClient`、Ollama 始终 `stream=False`。
在 CPU 单机 + 多并发问诊场景下吞吐受限。本轮在不破坏兼容与可降级前提下优化：

| 维度 | 旧行为 | 新行为（默认保守） | 新行为（调优） |
|---|---|---|---|
| worker 池 | 单 worker 串行 | `AI_LLM_WORKER_POOL_SIZE=1`（默认，**行为不变**） | `>1`（多协程并发消费队列 + supervisor） |
| httpx client | 每次新建一次性 client | `AI_LLM_HTTP_CLIENT_REUSE=true`（进程级单例，可回滚为 off） | 同左，连接池 `100/20` |
| Ollama 流式 | `stream=False` | `AI_LLM_STREAM=false`（默认，非流式） | `true`（流式优先，失败回退非流式） |

**三处回滚开关各自独立**：`LLM_WORKER_POOL_SIZE=1` 回到单 worker；`LLM_STREAM=false` 回到纯非流式；
`LLM_HTTP_CLIENT_REUSE=false` 回到每次新建 client。任意组合可逐档对照旧版。

**架构要点**：

- **worker 池 + supervisor**（`app/tasks.py`）：`pool_size` 个 `_run_worker` 协程消费 `asyncio.Queue`；`pool_size>1` 时启
  `_supervise` 每 0.5s 巡检，worker 异常退出 → WARN + 回收 → **重启单 worker 并退出监督**（单 worker 不再监督，行为退化为旧版）。
  队列 `maxsize=AI_QUEUE_MAX` 为一级背压，httpx 连接池 `max_connections` 为二级背压，避免打爆 Ollama。
- **httpx 进程级单例**（`app/http_client.py`）：`ollama_client(settings, transport=)` 上下文管理器——
  `reuse=false` 返回 `None`（调用方走一次性 client）；`transport` 注入→一次性独立 client（测试契约稳定）；
  `reuse=true`→单例（不关闭，shutdown 统一 `close_http_client()` 释放）。`main.lifespan` 关闭序：
  `service.stop()` → `close_http_client()` → `close_tts_connector()`。
- **流式 + 降级**（`app/executors/_llm.py`）：`settings.llm_stream=true` 时优先 `_generate_streaming`
  （`stream=true` NDJSON 累积，记录首 token 延迟 metrics）；流式中途失败（连接错误 / 流式 4xx/5xx / 空响应）→
  抛 `_StreamFallback` → 捕获后 WARN（`LLM 流式失败，回退非流式`）+ `metrics().record_stream_fallback()` +
  回落非流式（`_post_ollama_generate`，错误码一致）。**返回契约不变**。triage 执行器同步复用同一 client，删除本地自建 client。

**内部可观测端点**（非契约，登记在案）：`GET /internal/metrics/llm` 返回
`firstTokenSamples/P50/P95Ms`、`streamOk`、`streamFallback`、`lastFallbackError`。

**压测（隔离真实 LLM 波动：`tools/stub-ollama-llm.py` 桩 + `tools/bench-llm.py`，本机 CPU）**：

| 场景 | 配置 | QPS | P50 | P95 | 错误率 | 备注 |
|---|---|---|---|---|---|---|
| BEFORE | pool=1, stream=off, reuse=off | 1.05 | 15097ms | 28320ms | 0% | 旧行为基线 |
| AFTER | pool=4, stream=on, reuse=on | **4.82** | 5209ms | 6159ms | 0% | 首 token P50=171ms / P95=297ms（streamOk=30, fallback=0） |
| DEGRADE | AFTER 配置 + 桩强制流式 500 | 4.53 | 5169ms | 6517ms | 0% | **streamFallback=30 → PASS**（全量回退非流式，用户零报错） |

> 相对增益：**QPS ≈ 4.6×**、**P95 ≈ 4.6×**；流式首 token P50≈171ms。单任务绝对延迟含 ~1.8s 固定 harness/sandbox
> 开销（两模式一致，属预存噪声），故**相对增益为信号、绝对延迟不作为验收**。DEGRADE 场景证明：Ollama 流式端点
> 故障时，全部请求透明回退非流式、错误率仍为 0，且 metrics 计数到 `streamFallback`，验证了降级闭环。

**测试**：`tests/test_llm_concurrency_http.py`（**6 项**）—— 默认单 worker（len==1、supervisor None、并发 max==1）/
池并发（pool=4 出现并发）/ http 复用单例（reuse=on 同对象、off 返回 None）/ 流式首 token 记录 /
流式失败回退非流式（WARN + fallback 计数）/ worker 异常回退单 worker（monkeypatch 抛 RuntimeError → 回退单 worker且任务仍完成）。
构造 `reset_llm_state` autouse fixture（`reset_client` + `reset_metrics`）保证测试隔离。

**兼容性红线**：错误码（`MODEL_TIMEOUT` / `CAPABILITY_UNAVAILABLE` / `MODEL_UNAVAILABLE` / `MODEL_OUTPUT_INVALID`）与
响应契约不变；`transport` 注入测试路径行为稳定；`reuse=false` / `stream=false` / `pool=1` 任一回落即完全等价于旧版。

## 院内知识库注入层（M3 · 2026-10-22）

**定位**：`config/hospital-knowledge.json` 是**静态、版本化、人工维护**的院内事实（本院科室、门诊时间、能力边界、检验术语），
启动时加载一次，按场景拼进 system prompt。**它不是 RAG**——无向量、无检索、无外部依赖；两者互补：
静态层保证「本院口径」正确，RAG 负责「知识条文」召回（开关控制）。

**配置形状**：`version` + `metadata` + `scenarios.<scene>.{budgetTokens, knowledge[].{topic,content,priority}}`。
**新增字段全部可选**（缺省不影响加载，v1 旧格式仍可用）：条目级 `source`（来源）/`status`（verified|partial|todo）/`departments`（仅 triage，声明涉及科室，用于与导诊白名单对账）；
`metadata` 级 `reviewedBy`/`reviewedAt`/`reviewStatus`/`source[]`/`todo[]`（复核痕迹与待核实清单）。

| 场景 | 注入执行器 | 预算（tokens） | v2 内容 | 实测用量 |
|---|---|---|---|---|
| `triage` | TRIAGE | 300 | 本院科室（白名单）、症状→科室、科室位置 | 256（85%） |
| `chat` | CHAT | 400 | 预约号源、禁忌红线、挂号退号、急诊指引、报告时效 | 319（80%） |
| `careplan` | CARE_PLAN | 300 | 营养/运动边界（不承诺式）、慢病随访、复查提醒 | 244（81%） |
| `interpret` | INTERPRET | 400 | 血脂/血常规/尿常规术语、通用参考范围（标非 LIS） | 376（94%） |

**内容维护门禁**：`python tools/check-knowledge-base.py`（schema / 四场景 / 预算 / `triage.departments ⊆ 导诊白名单` /
手机号·身份证·邮箱·银行卡·姓名占位 / URL·IP·端口·磁盘路径 / todo 与 status 一致性），退出码非 0 即拒绝提交。
改内容必须 **bump `version`**（进缓存键）；未核实事实**不得写成断言**，只能进 `metadata.todo`。

**预算算法**（`app/knowledge.py`）：估算 tokens = `len(content) × 1.5`（中文粗略口径）；片段按 `priority` 降序**贪心**入列，
一旦放不下即 `break`（**不切半句**，避免注入残缺语义）；裁剪量与「已用/预算」写 INFO 日志，便于线上核对注入体积。

**注入方式**：`system = _SYSTEM_PROMPT + "\n\n院内知识库：\n" + knowledge_text` —— **追加不替换**（红线/JSON 约束原样保留），
用户 `prompt` 不受影响（知识不混进用户输入）。同一进程内按配置路径缓存 `KnowledgeLoader` 实例（`get_knowledge_loader()`）。

**降级矩阵**：

| 故障 | 行为 | 日志 |
|---|---|---|
| 配置文件不存在 | 退回原始 prompt，生成照常 | WARNING（路径） |
| JSON 解析失败 / 缺 `version`、`scenarios` | 同上（不半加载） | WARNING（错误类型） |
| 场景不存在 / 片段为空 | 同上 | WARNING（可用场景列表）/ INFO |
| 全部片段超预算 | 返回已入选部分（可能为空串） | INFO（预算/已用/丢弃数） |

> 降级只影响「提示词是否带院内事实」，**不影响任务状态**：不抛异常、不改造错误码、不伪造 `citations`。
> 日志只记 `scenario`/`version`/tokens，不落患者标识或症状原文。

**测试**：`tests/test_knowledge_base_content.py`（**14 项**：四场景/预算/元数据/白名单/隐私/v1 兼容）
+ `tests/test_knowledge_injection.py`（**52 项**）= 加载器 7 + 单例工厂 2 + 注入生效 16（四执行器 × 真实请求体断言）
+ 超预算截断 10（预算 400 保留中优先级 / 预算 300 丢弃，含日志留痕与边界等号）+ 缺失降级 17（缺失/损坏 × 四执行器 + 启动不阻断）。
断言对象是**真正发往 Ollama 的请求体**（`httpx.MockTransport`），防止「prompt 拼好了但传了原文」这类静默失效。

## RAG 入库 pipeline（2026-10-22）

**定位**：`scripts/rag_ingest.py` 是**独立 CLI**，负责把科普内容写进 Qdrant（读路径在 `app/executors/rag.py`）。
它**不挂任何 HTTP 路由**、**不常驻**、**默认只打印计划**——生产数据只会在显式 `--apply` 时被改写。

**输入**：前端科普内容库 `miniprogram/utils/knowledge-kb.js` 的 `ARTICLES`（`--from-kb`，用 node 读 CommonJS）
或已切好的 JSON（`--input`）。实测切片规模：**7 篇 → 34 个片段**（默认 `--max-chars 400`，按 `sections[].h/p` 切，不跨节）。

```text
# 1) 看计划（不联网、不写库）
.venv/Scripts/python.exe scripts/rag_ingest.py --from-kb ../../miniprogram/utils/knowledge-kb.js
# 2) 小批量试写（先建好 collection，维度=embedding 模型维度）
.venv/Scripts/python.exe scripts/rag_ingest.py --from-kb ../../miniprogram/utils/knowledge-kb.js \
    --apply --limit 2 --collection health_kb_test
# 3) 全量
.venv/Scripts/python.exe scripts/rag_ingest.py --from-kb ... --apply --version kb-20261022
# 4) 回滚：按 version 删除（也可加 --delete-doc 只删某篇）
.venv/Scripts/python.exe scripts/rag_ingest.py --delete-version kb-20261022 --apply
```

**核心机制**：

| 机制 | 实现 | 作用 |
|---|---|---|
| 稳定 point id | `uuid5(固定命名空间, "{doc_id}::{chunk_id}")` | 与内容长度/运行次数/版本号无关 → 重跑是**覆盖**不是新增 |
| 双字段名 payload | `documentId/chunkId/content/title`（`rag.py` 检索读）+ `doc_id/chunk_id/version/dept/scene/permission/ingested_at/content_hash/content_len`（审计/幂等/回滚） | 一份数据同时满足两套读取约定 |
| 默认 dry-run | 不带 `--apply` 只打印计划 | 防误写 |
| 远端保护 | Qdrant 非本机地址必须显式 `--allow-remote`，否则 **exit=2** | 防误写生产 |
| 指数退避重试 | embedding / upsert 各 3 次；单条失败只记账不中断，退出码 1 提示重跑 | 可重跑，不吞错 |
| 旧版本清理 | 入库成功后按 `doc_id` + `version≠当前` 删除残留 | 版本升级不叠加 |
| 日志脱敏 | 只打印 doc_id/chunk_id/字符数/维度/命中数，正文 ≤20 字预览 | 不落全文 |

**本地验证**（真实 HTTP，桩替代 Qdrant/Ollama，`tools/stub-qdrant-ollama.py`）：

```text
入库 kb-test-a → upserted=34/3批，count=34
同版本重跑   → count=34（不翻倍）
升 kb-test-b → 版本分布 {'kb-test-b': 34}（旧版已清）
--delete-version kb-test-b --apply → count=0
非本机 Qdrant → [拒绝] exit=2
```

**上线顺序（不可颠倒）**：装 Qdrant → 按 embedding 模型维度建 collection → 装 embedding 模型（如 `nomic-embed-text`）→
本 CLI `--apply` 写入 → 才开 `AI_RAG_ENABLED`。顺序颠倒只会得到空召回（RAG 任务走 `RAG_RETRIEVAL_FAILED` 降级）。
⚠️ 当前本机 **Qdrant 未部署、Ollama 无 embedding 模型**，故 `AI_RAG_ENABLED` 仍为 false，**未对生产写入过任何数据**。
桩 `tools/stub-qdrant-ollama.py` 无鉴权无持久化，**仅供本机自测，禁止指向生产**。


## 测试

```text
backend/ai-service/.venv/Scripts/python.exe -m pytest backend/ai-service/tests -q
```

M2 覆盖率：**53 个用例**（M0/M1 基线 21 + M2 生成/语音 17：CHAT 6 / CARE_PLAN 3 / TTS 4 / ASR 3 / 就绪探针如实 1
+ D2.4 内容寻址缓存 11：键设计 2 / 规范化 1 / 端到端命中与隔离 4 / 拒答不入缓存 1 / 默认关 1 / 存储与 TTL 2
+ TTS 产物卫生 4（`tests/test_tts_artifact_hygiene.py`，N-5 回归）：0 字节残留不当命中且被替换 / 失败不留产物且后续重试可成功 / 空产出不得当成功 / `synthesize` 原子性）。

M3 覆盖率：**63 个用例**（M2 的 53 + **运行产物回收 10**：`tests/test_retention.py`——sweep 过期/裁剪/
保留近期任务/同步清幂等索引 4；产物回收：删过期无引用 / 保留被引用 / 保留未过期 / 不碰非法文件名 / 目录缺失为 no-op 5；
引用来源解析 1）。

M4 覆盖率：**79 个用例**（M3 的 63 + **D4.2 安全抽查 16**：`tests/test_security_spotcheck.py`——
`redact()` 纯函数掩码（Bearer/Token:/Idempotency-Key 值/手机号/身份证/邮箱/无敏感内容原样/幂等）与
`install_redaction()` 全局过滤器端到端（lifespan 挂钩后日志落盘前已掩码，`taskId`/`model` 等诊断字段不受影响））。
日志脱敏接入：`app/redact.py` + `main.py` lifespan `install_redaction()`（幂等，无配置项，恒启用）。
`tests/test_cache.py` 覆盖：确定性、租户/输入/模型/模板/策略/音色任一变化即换键、非白名单类型与空输入不参与、
「有点疼」≠「非常疼」（不做宽松折叠）、二次提交命中缓存（模型调用次数不增）、拒答不入缓存、TTL 过期、文件重载。

M3 增补（2026-10-22）：**RAG 特征开关 6 项**（`tests/test_rag_integration.py`：默认关 / 关时执行器快速失败 /
CHAT 空 citations / 开时真实 citations / Qdrant 不可达降级 / embedding 失败降级）
+ **院内知识库注入 52 项**（`tests/test_knowledge_injection.py`，分组见上节）
+ **TTS 流式/缓存 10 项**（`tests/test_tts_streaming.py`，见「TTS 性能与缓存」节）
+ **配置开启配套 8 项**：启动摘要 3（`test_startup_summary.py`）、独立 RAG 任务阶段名 2（`test_rag_task_phase.py`）、
知识库版本入缓存键 3（`test_cache_knowledge_version.py`）
+ **知识库内容契约 14 项**（`test_knowledge_base_content.py`，见「院内知识库注入层」节）。
+ **RAG 入库 pipeline 17 项**（`test_rag_ingest.py`：稳定 point id 1 / 幂等重跑不翻倍 1 / 旧版本清理 1 /
元数据齐全 1 / 索引文本带小节标题 1 / 重试与可重跑 3 / 切片策略 2 / dry-run 与远端保护 4 /
回滚 CLI 与端到端 HTTP 链路 3，见「RAG 入库 pipeline」节）。

**当前全量：208 项**（`.venv/Scripts/python.exe -m pytest tests -q` → `208 passed`）。
+ **LLM 并发/流式 6 项**（`tests/test_llm_concurrency_http.py`，见「LLM 并发与流式」节）。
⚠️ `test_m2_executors.py::test_tts_success_cache_and_signed_audio_route` 依赖本机 `edge_tts` 联网合成，
并发/网络抖动时偶发单点失败（隔离运行与连续两次全量均通过），**不是知识库改动的回归面**。

## TODO（移交 M2 收尾 / 用户裁定）

- [x] O-10 定稿（2026-10-15 用户裁定）：生产默认 `AI_TTS_ENGINE=edge`；`audioUrl` 可达基址经 `AI_TTS_PUBLIC_BASE` + `AI_TTS_PUBLIC_PATH` 指向网关公开通道 `/api/gw/tts/audio`
- [ ] ASR 音频取用通道定稿：`AI_ASR_AUDIO_DIR` 目录约定需与 M 侧「临时文件即时清理」策略对齐（否则 ASR 恒降级）
- [x] 内容寻址缓存（D2.4）：HMAC 键（§9.2 字段集）+ 本机 JSON 实现（Redis 缺失降级）；**默认关**，deploy 以 `AI_CACHE_ENABLED=true` 开启
- [x] O-03 定稿（2026-10-15 用户裁定「权限先于缓存命中」）：**架构上已满足**——本服务仅内网 `/internal/**` 可达，缓存命中发生在业务侧鉴权之后；键含 `tenantId`。验收口径见 `docs/v4/08G` 判据 ④（缓存不得下沉到对客户端暴露的路径）
- [ ] `RAG` 执行器接入（检索链路 + Citation 真实性校验）
- [ ] 输入安全前置（提示注入/越权引用/医疗红线）
