# 医疗健康 AI 微信小程序

> 原生微信小程序前端项目
> 当前版本：V1.8（导诊直推科室 + 院内导航从大门开始；手势识别与数字人已下线）

---

# 1. 项目状态

| 项目 | 状态 |
| --- | --- |
| 平台 | 微信小程序 |
| 开发方式 | 原生 WXML + WXSS + JS（禁止 Vue/React/UniApp） |
| 当前阶段 | V1.17 —— 患者端首页按参考图复刻（彩色 PNG 图标 + 症状快选词直达结论）+ 平板实测三修；院内导诊从**医院大门**起步；手势识别 / 数字人已下线 |
| **后端** | **统一网关单入口**：`config/env.js` 的 `gateway`（网关 :8080 反向代理 Python:8001 / Java:8088），代码禁止出现 8001/8088 |
| 视觉基准 | **楚大夫蓝调 · 效果图对齐版（2026-10-18，按 `design-output/` 29 张效果图 + 设计规范说明.md）**：主蓝 `#0B6EF8` / 浅蓝 `#3E8CFF` / 浅底 `#E4F1FF` / 页面底 `#F3F8FF` / 主文本 `#14264C`；薄荷绿 `#54C8A7`；hero=淡蓝渐变 `#D9EEFE→#B6DDFE`。**唯一色源 = `app.wxss` page 令牌块**，旧值（`#165DFF`/`#F5F7FA`/`#1D2129`/`#D7E9FA`/`#00024E`）已全仓归零。改造说明见 `docs/效果图对齐改造_20261018.md` |
| 图标 | **PNG**（`utils/icons.js` 219 键 = 67 基础字形 × 蓝/灰/白 + 18 个彩色变体）。微信 `<image>`/tabBar **不支持 SVG**，也不支持给 PNG 着色（无 tintColor），故"同形状不同色"只能预生成多份 PNG；`tools/build-icon-colors.py` 按 alpha 通道派生彩色变体（色板 = 装饰五色） |
| 适老化 | 三档字号（standard/large/xlarge）+ 高对比 + 大字模式 |
| 角色路由 | 登录页双身份 → 患者端 TabBar / 医生端工作台自动跳转 |
| TabBar | 首页 / AI问诊 / AI养生 / 我的（已配置，纯文字） |
| 后端安全基线 | **2026-10-23 四模块优化已完成**：legacyLoginEnabled/CORS 生产关闭、AI 鉴权 static+强 token fail-fast、附件签名密钥 fail-fast、账号注销 30 天物理清除定时任务（每日 11:30）、INTERPRET 缓存修复、消息中心与院内导航（indoor-map.json 同源派生）保障；并修复医生列表 SQL 越权（VIEW_SELECT WHERE 锚点）与东八区 keyset 时区错位。详见 `项目优化总结报告-2026-10-23.md` 与 `测试用例调整建议-2026-10-23.md` |

---

# 1.1 后端契约（实测已通）

| 服务 | 用途 | 入口 | 状态 |
| --- | --- | --- | --- |
| **统一网关 :8080** | **前端唯一入口**（`config/env.js` → `gateway`：`local`=PC 模拟器直连 / `development`=ChmlFrp 隧道 / `production`=正式域名） | V4 路由：`/api/gw/**` 网关自身；其余 `/api/**` 全量代理 business-service（不再按旧白名单分流） | ✅ 对照 V4 `backend/edge-gateway`（2026-10-15） |
| Python FastAPI :8001 | 导诊/问诊/养生生成/ASR/Qwen3-TTS | 仅内网可达，由 business-service 编排调用（**前端禁止直连/禁止出现 8001**） | ✅ |
| Java Spring Boot :8088 | 医生/挂号/床位/用户 | 由网关转发（原直连 8088 已改走网关，路径不变） | ✅ |
| **资源库（V14/V18/V20）** | 248 条资源元数据（DB 只存 key/路径/mime/sha256/status/delivery，**不存 BLOB**） | `GET /api/v1/resources/{key}` 流式返回；清单只下发 `delivery=remote` 的 11 条（banner/科普图/5 张封面/登录页小安），**219 个图标 + 3 个视频走本地** | ✅ 2026-10-21（`docs/资源库分类规则_20261019.md`） |
| **健康档案附件** | 检查资料上传/查看/删除（私密，签名 URL） | `POST /api/v1/attachments`（≤10MB，jpg/png/webp/pdf）、`GET /api/v1/attachments/{key}?expires=&sig=`（缺参 400 / 过期 410 / 错签 403 / 不存在 404 / 正常 200 `no-store`） | ✅ 2026-10-19 判定修复（`docs/资源端点鉴权与附件签名修复_20261019.md`） |
| ~~Unity 手势 :8787~~ | ~~手势识别~~ | **已下线（2026-09-13）**：前端不再代理 `/gesture/**`，相关页面/服务已删除 | ❌ 前端不再依赖 |
| **后端接入指南** | 前端/联调/部署接口说明 | `docs/后端接入指南_20261021.md`：统一网关、AI、ASR、挂号取消、消息、医生工作台、账号安全、Ollama 与剩余差异 | ✅ 2026-10-21 |
| **后端接入文档（八项能力落地单）** | 逐项「能不能通 / 卡在哪 / 改哪个文件 / 怎么验收」+ 数据库结构 | `docs/后端接入文档_20261021_V21.md`：funasr 语音、AI 问诊/养生、档案解读（真实模型）、取消挂号、消息中心、账号安全、**排班与在线状态（V22 已落地）**、首页数值、DB 36 表 DDL | ✅ 后端 8 项全就绪（ASR 端到端实测通过；V22 排班 4 端点实测通过）；余下为前端接线 |
| **待优化问题清单（GPT 交付版）** | 前端代码质量 + 体验问题按 P0/P1 排序 | `待优化问题清单_交付GPT版.md`：主包大小/无用 JS/图片超限、挂号抽屉修复、输入框遮挡、TabBar 调整 | ✅ 2026-10-22 整理 |
| **数据库表结构总览** | 33 张表按业务模块分类 | `数据库表结构总览_20261022.md`：用户/挂号/健康/AI/床位/内容/审计 7 大模块 | ✅ 2026-10-22 |
| **院内知识库注入（M3）** | 四执行器（triage/chat/careplan/interpret）按场景把院内事实**追加**进 system prompt（追加不替换红线）；静态 JSON，**非**向量检索 | `backend/ai-service/config/hospital-knowledge.json`（env `AI_KNOWLEDGE_BASE_PATH`）；预算 triage/careplan 300、chat/interpret 400 tokens | ✅ 2026-10-22（52 项集成测试；文件缺失/JSON 损坏自动降级为通用 prompt，任务不中断） |
| **RAG 入库 pipeline（2026-10-22）** | 科普内容切片 → Qdrant（**独立 CLI**，不挂 HTTP 路由、默认 dry-run） | `backend/ai-service/scripts/rag_ingest.py`：稳定 point id（uuid5(doc_id::chunk_id)）→ 重跑是覆盖不是新增；完整元数据；批量重试；`--delete-version` 精确回滚；非本机 Qdrant 必须 `--allow-remote` | ✅ 本地端到端验证（7 篇 → 34 片段；幂等/升版清理/回滚归零全通）；**未对生产写入**（Qdrant 未部署） |
| **TTS 性能与缓存（2026-10-22）** | 产物缓存优先（同文本同音色直接复用文件）+ `stream()` 流式落盘（首字节可观测）+ 进程级 TCP 连接池 | `AI_TTS_STREAM`（别名 `TTS_STREAM`）默认 `true`；流式失败自动降级旧 `save()`；**返回契约不变** | ✅ 实测 N=10：缓存命中 **0.2ms** / 冷启动 1.8~1.9s（首字节 ~1.2s）；回滚 `TTS_STREAM=false` |

**关键契约（踩坑记录）**：
1. ⚠️ **前端只维护 `gateway` 一个地址**；`request.js` 里 base 取值 `gateway`/`python`/`java` 三者解析出的都是同一 `ENV.gateway`（base 仅表达"该能力最终由哪个上游产出"）。V4 网关下 `/api/gw/**` 归网关自身、其余 `/api/**` 全量代理 business-service；ai-service 仅内网可达。新增路径按契约登记，旧 `JAVA_PREFIXES` 白名单模型已废弃。
2. ⚠️ **TTS 已由 edge-tts(MP3) 换成 Qwen3-TTS(WAV)**：`POST /api/v1/voice/tts`（multipart：text/voice/raw），`raw=0` 返回 JSON 含 `audio_base64/voice_id/engine/degraded`；`/api/v1/voice/tts/edge` 保留为兼容别名（返回已变 wav）。`engine` ∈ sidecar/local/placeholder，`degraded=true` 或 `engine=placeholder` 时前端提示占位音质但不阻断（小程序无 SpeechSynthesis 兜底）。
3. ⚠️ **音色管理 6 接口**（§6.3）：列表走网关别名 `GET /api/gw/voices`；设默认 `POST /api/v1/voice/voices/default`（立即持久化）；试听 `POST /api/v1/voice/voices/preview`（form-data → WAV 二进制）。音色 id 见对照表（speaker_test / preset_bright|gentle|deep|child|news / clone_*），本地记忆 storage `wb_voice`。
4. ⚠️ ~~**手势挂号编排（§4）**~~ **已下线（2026-09-13）**：`pages/gesture` 与 `services/gesture.js` 已删除，`api.js` 中 GW_SESSION_*/GW_GESTURE_SIMULATE/GW_DISPATCH/GW_DEPARTMENTS/GW_AUDIO 一并移除；网关健康检查拆到新的 `services/gateway.js`（仅保留 GW_HEALTH / GW_ROUTES）。
5. ⚠️ **超时策略**：aiTimeout 90s / ttsTimeout 120s / carePlanTimeout 180s（LLM deep 实测 57s，TTS 首次预热 20~30s）。
6. ⚠️ 医生登录字段是 `username`（不是 phone）；风险判定用 POST 不是 GET（GET 405）；医生口令 `13900139001 / doc123`。
7. 预约状态流转：`POST /api/appoint/updateStatus { id, status }`，status ∈ 待就诊/就诊中/已完成。
8. ⚠️ 网关地址只改 `config/env.js` 一处：**`local`**=PC 模拟器直连本机 :8080（不经穿透；全仓唯一允许的本机地址 = `DEV_DIRECT` 行，扫描器按标记放行）；**`development`**=隧道联调（域名失效只改其 `gateway`）；**`production`**=正式 HTTPS+备案+小程序合法域名。真机走局域网直连时，把 `DEV_DIRECT` 值改为 PC 局域网 IP 即可（保持同一行标记）。
9. ⚠️ **`<image>` 加载网络图走的是 `downloadFile` 合法域名，不是 `request` 域名**；三类（request/downloadFile/uploadFile）都填 `qv56gv32944.vicp.fun`。开发者工具「不校验合法域名」只对工具/调试生效，真机预览/体验版必校验 —— 真机验证前必须关掉该勾选。
10. ⚠️ **院内知识库改完必须重启 ai-service**：`hospital-knowledge.json` 在 `build_*_executor()` 时加载一次（进程内按绝对路径缓存），无热更新；预算按 `len(content)×1.5` 估算，**超预算整条丢弃**（不切半句），低优先级片段可能长期不生效 → 核对要看 INFO 日志的「已用/预算/丢弃数」。知识库是人工维护的静态事实，**不要**写患者数据或内部口令。
12. ⚠️ **RAG 入库的 5 条硬规则**（2026-10-22）：①**顺序不可颠倒**——装 Qdrant → 按 embedding 维度建 collection → 装 embedding 模型 → `rag_ingest.py --apply` 写入 → 才开 `AI_RAG_ENABLED`；②**point id 由 `doc_id::chunk_id` 派生**（与版本/内容长度无关），所以重跑安全、版本升级靠 `--version` 区分、旧版靠 `must_not(version=当前)` 清；③**默认 dry-run**，写库必须显式 `--apply`，非本机 Qdrant 还需 `--allow-remote`（否则 exit=2）；④**回滚用 `--delete-version V --apply`**，⚠️ 该参数**不需要** `--from-kb/--input`（若与输入源互斥必填会直接 exit=2，回滚不可用）；⑤**当前 RAG 仍未开启**（无 Qdrant、无 embedding 模型），线上不得假设有向量召回。
11. ⚠️ **TTS 性能三层 × 实测口径**（2026-10-22）：①产物缓存（`sha256(text|voice|locale).mp3`）命中 **0.2ms**，冷启动 **1.8~1.9s**，命中率是唯一数量级收益；②流式 `stream()` 首字节中位 **1.2s**（≈总耗时 68%），**不改变** 返回的 `audioUrl` 契约；③edge-tts 的 WebSocket **每次新建 TCP**（3 次合成=3 次建连，实测），共享连接池只省 DNS/对象（3.8ms，噪声内）——**不得宣称连接复用或提速**。回滚：`TTS_STREAM=false`（或 `AI_TTS_STREAM=false`）回到旧 `save()` 路径。日志看 `cached= / mode= / firstByteMs= / totalMs=`。

---

# 1.2 AI 能力矩阵与性能开关（2026-10-22 复核 + 配置开启）

> 事实来源：`backend/ai-service` 代码 + `backend/deploy/env.local`（唯一被 `orchestrator.ps1` 加载的配置文件）。
> 详细核对表（含量化证据与 9 条旧报告作废项）见 `docs/AI性能事实复核_20261022.md` 与 `docs/开发日志.md`。

| 能力 | 状态 | 代码位置 | 默认 | deploy 现值 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **RAG 检索** | ✅ 已实现 / 开关控制 | `executors/rag.py`（redis/qdrant 双后端）、`capabilities.py:probe_redis/probe_qdrant` | `AI_RAG_ENABLED=false` | **true（Redis 演示，2026-10-24）** | 演示版=Redis 存向量 + 服务端余弦 top-k（Redis 3.x 无原生索引，`protocol=2`）；入库脚本 `backend/ai-service/tools/rag_redis_seed.py`（已跑通，16 条）；生产切 Qdrant 见 `docs/运维/Qdrant与RAG生产上线runbook.md`；原生向量索引可升级 Redis Stack 8 |
| **院内知识库** | ✅ 已落地 / 版本化 | `knowledge.py`、`config/hospital-knowledge.json` | 默认路径生效（无开关） | 生效（**v3**，院方受控信息替换；reviewStatus=ai_checked_pending_clinical_review，TODO 5 项） | 四执行器追加注入；改文件需重启；维护见「知识库维护」 |
| **ASR** | ✅ 单例 + 预热 / 开关控制 | `voice.py:get_asr_model` / `preload_asr_model` | `AI_ASR_PRELOAD=false` | **true（已写入，待 restart 生效）** | 单例恒启用；预热实测 27.21s（后台），首请求 27.9s→0.76s |
| **TTS** | ✅ 连接池 + 流式 | `voice.py:_tts_connector` / `_synthesize_streaming` | `AI_TTS_STREAM=true` | true | WS 无法跨请求复用（实测 3 合成=3 建连），不宣称提速 |
| **内容缓存** | ✅ 已实现 / 开关控制 | `cache.py`、`tasks.py:_process` | `AI_CACHE_ENABLED=false` | **true（已写入，待 restart 生效）** | 命中 80%（4/5），未命中 8488.8ms → 命中 97.1ms |
| **LLM 并发 / 流式** | ✅ 已实现 / 开关控制 | `tasks.py`（worker 池 + supervisor）、`http_client.py`（进程级单例 client）、`_llm.py:generate_text`（`stream` 开关） | `AI_LLM_WORKER_POOL_SIZE=1` / `AI_LLM_STREAM=false` / `AI_LLM_HTTP_CLIENT_REUSE=true` | 单 worker（默认，向后兼容）；调优 `pool>1`+`stream=true`+`reuse=true` → QPS≈4.6×、P95≈4.6×、流式首 token P50≈171ms | 三开关各自独立可回滚；流式失败自动回退非流式（WARN + metrics，返回契约不变） |

**配置表（性能开关）**：

| 变量 | 默认 | 生产值 | 依赖前提 | 回滚方式 |
| --- | --- | --- | --- | --- |
| `AI_CACHE_ENABLED` | `false` | **`true`** | `AI_CACHE_PATH` 目录可写；`AI_TENANT_SECRET` 固定（否则重启换键、旧条目失效） | 改 `false` + `restart.bat`（缓存文件可留可删） |
| `AI_CACHE_TTL_SECONDS` | `3600` | `3600` | — | 改回默认即可 |
| `AI_TENANT_SECRET` | 空（进程内随机） | **固定 32B hex（仅存 `env.local`）** | — | 换密钥 = 旧缓存全部失效（可接受） |
| `AI_ASR_PRELOAD` | `false` | **`true`** | `AI_ASR_ENGINE=funasr` + `AI_ASR_MODEL_PATH` 权重存在；CPU 环境 848MB 常驻 | 改 `false` + `restart.bat`（回到懒加载） |
| `AI_RAG_ENABLED` | `false` | **`true`（Redis 演示）** | Redis 可达 + 索引已入库（`tools/rag_redis_seed.py`）+ `nomic-embed-text` | 改 `false` + 重启回滚；生产切 `AI_RAG_STORE=qdrant` |
| `AI_RAG_STORE` / `AI_REDIS_URL` / `AI_REDIS_KEY_PREFIX` | `redis` / `redis://127.0.0.1:6379/0` / `ai:rag:` | **`redis`（演示）** | Redis 3.x 无原生向量索引 → 服务端余弦 top-k；生产可切 `qdrant` 或升级 Redis Stack 8 | — |
| `AI_QDRANT_URL` / `AI_QDRANT_COLLECTION` / `AI_EMBEDDING_MODEL` | `127.0.0.1:6333` / `health_kb` / `nomic-embed-text` | 未启用（rag_store=redis） | 同上 | 生产切回时启用 |
| `AI_LLM_WORKER_POOL_SIZE` | `1` | `1`（默认，严格串行、向后兼容；调优可 `>1`） | 队列 `AI_QUEUE_MAX` 提供一级背压、httpx 连接池为二级背压，避免打爆 Ollama | 改 `1` + `restart`（回到单 worker；`>1` 时异常退出自动回退单 worker） |
| `AI_LLM_STREAM` | `false` | `false`（默认非流式；调优可 `true`） | Ollama `/api/generate` 支持 NDJSON `stream=true` | 改 `false` + `restart`（回到纯非流式；流式失败已自动回退非流式） |
| `AI_LLM_HTTP_CLIENT_REUSE` | `true` | `true`（默认进程级单例复用；回滚可 `false`） | 连接池 `AI_LLM_HTTP_POOL_MAX_CONNECTIONS` / `_KEEPALIVE`；shutdown `close_http_client()` 释放 | 改 `false` + `restart`（回到每次新建一次性 client，等价旧版） |
| `AI_LLM_HTTP_POOL_MAX_CONNECTIONS` / `_KEEPALIVE` / `_TIMEOUT_SECONDS` / `_MAX_RETRIES` | `100` / `20` / `30` / `0` | 同左（复用开启时生效） | — | 改回默认即可 |

**配置生效与审计**：
- 唯一生效文件是 `backend/deploy/env.local`（`.gitignore:*.local`）。`env.example` 只是模板；`.env.ai-service.example` **不被加载且未入库**，其值与代码默认相反，禁止照抄。
- 每次启动打一行 `启动配置摘要 | version=… | cache=on|off | cacheBackend=json | cacheTtlSeconds=… | cacheTenantSecret=configured|auto-random | rag=… | qdrantCollection=… | embeddingModel=… | knowledgeVersion=… | asrEngine=… | asrPreload=… | ttsEngine=… | ttsStream=… | llmSmall=… | llmLarge=… | queueMax=… | concurrency=1 | llmConcurrency=… | llmStream=on|off | llmHttpReuse=on|off | llmHttpPool=100/20 | taskTimeoutSeconds=…`（**不含**地址/路径/密钥）。
- 验收脚本：`python tools/verify-ai-switches.py {config|cache|asr|rag} --base http://127.0.0.1:8001`（禁用环境代理，避免本机 `http_proxy` 造成假 502）。

**数据链路（RAG 读写分离）**：
- **读侧（已实现）**：`RAG` 任务 `POST /internal/v1/tasks` → `executors/rag.py`（Ollama `/api/embeddings` → Qdrant `points/search` → 失败降级空结果）；CHAT 侧经 `_retrieve_context()` 转成 `citations`。
- **写侧（未实现，P1）**：仓库**没有**入库 pipeline。计划形态：`scripts/kb-ingest.py --source <json> --collection health_kb`，流程 `切片 → embedding（同一模型/维度）→ Qdrant upsert`；
  幂等策略：`point id = sha256(documentId|chunkId)` 的稳定哈希，重复导入即覆盖（upsert），不用自增 id；`--dry-run` 打印将写入的条数与维度，失败不删旧数据。
  ⚠️ 在写侧落地前，Qdrant collection 由人工创建，**向量维度必须与 `nomic-embed-text` 实际输出一致**（不要凭记忆填 768）。

**知识库维护（`config/hospital-knowledge.json`，当前 `hospital-knowledge-v3`，2026-10-23）**：

| 场景 | 预算 | 注入内容（v3） | 实测用量 |
| --- | --- | --- | --- |
| `triage` | 300 tokens | 本院科室（白名单口径）、症状→科室映射、**科室位置（DB）** | 256（85%） |
| `chat` | 400 tokens | 预约号源规则、退号建档、**急诊24h（院方确认）**、报告时效（院方提供）、禁忌红线 | 397（99%） |
| `careplan` | 300 tokens | 营养筛查（NRS 2002）与运动能力边界（院方提供）、慢病随访、复查提醒 | 290（97%） |
| `interpret` | 400 tokens | 血脂/血常规/尿常规术语、**成人参考范围（模拟 LIS 口径，8 项）** | 397（99%） |

- **真实来源**：DB `departments`（科室名/位置/擅长，16 条）· `config/triage-departments.json`（导诊白名单 6 科室）· **院方提供受控信息（2026-10-23，模拟脱敏）**：急诊开放时间（24h）、门诊号源规则、退号/建档规则、检查报告时效、营养/运动能力边界、LIS 参考区间（8 项，模拟口径）。**仍无受控来源 / 保持占位（metadata.todo 5 项）**：医院真实名称（现为模拟名「XX市中心医院」）、精确号源排班、退号精确截止时刻、病理/外送项目时限、本院 LIS 原始导出表；地址与电话按院方要求保持模拟、不写入知识库。
- **复核状态**：`reviewStatus=ai_checked_pending_clinical_review`（受控源核对，`clinicalReview: false`，**非临床审核**）；后续人工核验追加 `humanReview` 记录，不覆盖 AI 记录。
- **版本**：改内容必须 **bump `version`**（`hospital-knowledge-vN`）——版本会写入任务 `knowledgeSnapshot` 并参与缓存键，不 bump 会继续命中旧答案；同时更新 `metadata.reviewedBy/reviewedAt/reviewStatus`。
- **review 流程**：① 改 JSON（条目可带可选字段 `source`/`status`/`departments`）→ ② bump `version` → ③ `python tools/check-knowledge-base.py`（schema/预算/科室白名单/隐私/内部信息）→ ④ `pytest tests/test_knowledge_base_content.py tests/test_knowledge_injection.py -q` → ⑤ 重启 ai-service → ⑥ 启动摘要出现新 `knowledgeVersion`。
- **占位说明**：`status=partial|todo` 的条目**仍会注入**，但文案已改为不承诺表述；院方给值后需同改 `content` + `status` 并删除对应 `metadata.todo` 项。**禁止**为了"看起来完整"而编造院名、电话、地址、排班或参考范围。

**降级策略（开关失败时）**：

| 开关/能力 | 失败表现 | 兜底行为 | 用户可见影响 |
| --- | --- | --- | --- |
| `AI_CACHE_ENABLED` | 缓存文件损坏/不可写 | 启动 WARNING + 跳过缓存，任务照常执行 | 无（仅变慢） |
| `AI_ASR_PRELOAD` | 权重缺失/加载失败 | 预热失败只 WARN，首次请求懒加载 | 首次 ASR 慢（约 28s），之后正常 |
| `AI_RAG_ENABLED` | Qdrant/embedding 不可达 | 检索返回空，`provenance=RAG_RETRIEVAL_FAILED`，CHAT 照常回答 | `citations` 为空，回答质量下降（不给假引用） |
| 知识库注入 | 文件缺失/JSON 损坏 | 退回原始 prompt（WARNING） | 无（少院内口径） |
| TTS 流式 | WS 异常/无音频 | 清残片 → 降级 `save()` 重试一次 → 仍失败 `TTS_UNAVAILABLE` | 首次失败可能多花一次合成时间 |

---


# 2. 工程目录

```text
miniprogram/
├── app.js / app.json / app.wxss
├── project.config.json / sitemap.json
├── utils/mock-data.js        开发档演示兜底数据源（仅 MOCK_FALLBACK=true 且后端不可用时经 withFallback 使用；生产档禁用）
├── pages/auth/login          统一身份认证（患者/医护双身份）
├── pages/home                首页（V3.1 页面2：AI 健康助手卡 + 导诊 + 双卡 + 投屏 + 预约动态）
├── pages/consultation        AI 问诊（本地规则 + 思考链动画 + 打字机 + 紧急提示）
├── pages/health              AI 养生·小安（体质测评 + 三天方案 + 投屏）
├── pages/profile             我的（6 入口：挂号记录/健康档案/我的问诊/电视连接/家庭成员/设置）
│   ├── records               挂号记录（合并本地新预约缓存）
│   ├── health-records        健康档案（基本信息/就诊记录/检验报告）
│   ├── consultations         我的问诊/咨询
│   ├── family                家庭成员管理
│   └── settings              系统设置与关于（字号三档/高对比/语音/缓存/协议）
├── pages/tv/cast             智能电视投屏（设备连接 + 功能切换 + 大屏预览）
├── pages/triage(+result)     智能导诊（本地症状规则匹配）
├── pages/appointment         分步挂号（科室→医生→时段→确认→成功，本地预约号）
└── pages/doctor/workbench    医生工作台（深海青 #164E63，鉴权拦截 + 叫号/完成本地流转）
```

---

## 2.1 后端一键启动与图形面板（`backend/deploy`）

后端三服务（business :8088 / ai :8001 / gateway :8080）的启动、停止、状态、排障**统一走 `backend/deploy`**，不要在别处另造一套命令。行为规格与逐条边界见 `backend/deploy/README.md`。

| 入口 | 作用 |
| --- | --- |
| `start-gui.bat` | **图形化常驻面板**（WinForms）：窗口启动后**不退出**，600ms 自动刷新；四视图 = 服务状态矩阵 / 请求流水 / 服务日志 / 操作输出 |
| `start-all.bat` | 命令行一键启动（business → ai → gateway，跑完即退出） |
| `stop-all.bat` | 停止（**只回收本工具拉起的进程**，不碰 IDE/手工启动的实例） |
| `status.bat` / `restart.bat` | 状态矩阵（PID / 端口 / 健康 / 日志路径）/ 先停后启 |

面板要点：

- **请求流水**解析网关访问日志 `backend/deploy/logs/gateway.log`，逐条显示 方法 / 路径 / 状态码 / 客户端 / 说明；`2xx` 判成功、`4xx` 客户端错误、`5xx` 服务端错误。
- **上游失败单列不重复**：一次失败在日志里会产生「5xx 访问行 + `edge-gateway.proxy` 上游告警行」两条，面板把告警行**合并进同一条请求**（判定改「上游失败」、说明保留 `ConnectError` 等），不新增行、不重复计数；路径被 compat 层改写时按「方法 + 状态码」宽松匹配并标注真实上游路径。
- **两级判定**：服务级 `正常 / 降级 / 异常 / 端口被占用 / 未启动`；请求级 `成功 / 跳转 / 客户端错误 / 服务端错误 / 上游失败`。
- **口径唯一**：健康接受码、端口探测、PID 存活全部来自 `scripts/deploy-common.ps1`，与 `orchestrator.ps1` **同一份实现**——面板说健康即命令行说健康。
- **只观察与转发**：启动 / 停止 / 重启 / 冒烟检查一律以子进程调 `orchestrator.ps1`，面板内不重复实现编排逻辑；**不做守护 / 自动重启**。
- **生产部署（docker/k8s）与 RAG 上线**：见 `docs/运维/Qdrant与RAG生产上线runbook.md`（状态=待执行；含 Qdrant 部署/入库/配置注入/阈值标定/观察/回滚/压测，依赖院方真实信息清单）。
- **「时间」列是观测时间**（uvicorn 访问日志本身不含时间戳），不是请求真实发生时刻。
- **操作成败以退出码为准**：编排器退出前把真实退出码回写 `run\_gui-op-rc.txt`（PS5.1 的 `Process.ExitCode` 常为 `$null`），面板据此显示「成功 / 运行期失败 / 前置未过 / 未知」；操作输出恒按 UTF-8 解码并跨轮次保留半个汉字，不再出现整页乱码。
- **日志轮转不阻断启动**：上一个实例的 stdout 句柄仍持有 `logs\<名>.log` 时只告警、跳过轮转并继续追加，不会把已经起来的服务判成「启动异常」。
- `隐藏健康探测请求` 默认勾选：探测请求（含其上游失败行）不进流水视图，避免淹没业务请求。
- 无界面自检（自动化验证用）：`powershell -NoProfile -ExecutionPolicy Bypass -File backend\deploy\scripts\gui.ps1 -SelfTest`，打印状态矩阵 / 请求流水 / 计数，退出码 0 = 采集链路正常。

---

# 3. 设计系统（楚大夫蓝调 · design-output 效果图对齐版 2026-10-18）

> 唯一色源 = `miniprogram/app.wxss` 的 `page{--*}`；改色只动那里（页面 wxss 已 0 处硬编码色值）。

| Token | 色值 | 用途 |
| --- | --- | --- |
| `--primary` | `#0B6EF8` | 医疗科技蓝：主按钮 / 选中态 / 链接 / 品牌 |
| `--primary-dark` | `#0A5AD8` | 按下态 |
| `--accent` | `#3E8CFF` | 辅助高亮 |
| `--accent-soft` | `#E4F1FF` | 浅蓝底板：chip / 信息条 / 次按钮 / 图标底板 |
| `--mint` / `--mint-soft` / `--mint-text` | `#54C8A7` / `#E0F7F0` / `#178F6B` | 成功、已完成、问诊中（**小字必须用 `--mint-text`**，`--mint` 仅作底色） |
| `--accent-green` | `#00B42A` | 在线 / 空闲等可用状态 |
| `--accent-amber` / `--amber-soft` / `--amber-text` | `#FF8C00` / `#FFF4E5` / `#CC6600` | 待处理、号源紧张、紧急提示 |
| `--accent-red` | `#F53F3F` | 危险 / 删除 / 急诊预警 |
| `--bg` | `#F3F8FF` | 全局页面背景 |
| `--card` | `#FFFFFF` | 卡片 |
| `--text-main` | `#14264C` | 深海军蓝：标题 / 正文 |
| `--text-sub` | `#5064A0` | 次要文字（**有意偏离规范的 `#8A9BB8`**：后者对比度仅 2.8:1，不达正文 4.5:1） |
| `--text-weak` | `#828CA0` | 白卡说明 |
| `--text-placeholder` | `#B0BEC5` | 输入框 placeholder |
| `--border` | `#E4E9F0` | 分割线 |

圆角：`--radius-lg 32rpx(16px)` 卡片 / `--radius-md 24rpx(12px)` 图标底板与输入框 / `--radius-sm 16rpx(8px)` 标签。

三档字号（title/h2/body/caption，rpx）：
`standard` **40/34/30/24** → `large` 适老 **44/36/32/26** → `xlarge` 无障碍 **52/42/38/30**。
切换入口：我的 → 系统设置与关于 → 字体大小；登录页也有「开启适老/无障碍大字登录」。
页面根 view 统一 `theme-{{theme}}`，全局实时生效（app.js `setTheme` + storage 持久化）。

---

# 4. 页面结构（主包 21 页 + 2 个分包：packageNav / packageContent）

```text
pages/auth/login            登录（患者一键 / 医护工号 doc123）
pages/home/home             TabBar 首页
pages/consultation/consultation  TabBar AI问诊
pages/health/health         TabBar AI养生
pages/profile/profile       TabBar 我的
pages/tv/cast/cast          投屏
pages/triage/triage         智能导诊
pages/triage/result/result  导诊结果
pages/appointment/appointment  分步挂号
pages/profile/records       挂号记录
pages/profile/health-records  健康档案
pages/profile/consultations  我的问诊/咨询
pages/profile/family        家庭成员
pages/profile/settings      系统设置与关于（含服务状态健康卡）
pages/profile/voice-settings  音色管理（列表/试听/设默认/重扫）
pages/doctor/workbench/workbench  医生工作台

分包：
packageNav/     院内导航（平面图+路径，**起点医院大门**；**14 个目的地**）  1 页（+ assets/floor1.png 24KB）
```

---

# 5. 核心流程

## 登录与角色路由

```text
登录页（选身份）
├── 我是患者 → 微信手机号一键登录 → switchTab 首页（TabBar 患者端）
└── 我是医护人员 → 工号+密码（13900139001/doc123）→ reLaunch 医生工作台

登录态持久化（72 小时免重复登录）：
- 登录成功写入 wb_role / wb_user / wb_login_at（登录时间戳），有效期 72 小时。
- 冷启动 onLaunch 校验：在有效期内自动恢复登录态，并跳过登录页直接进入对应端；
  超过 72 小时则自动清除登录态，回到登录页重新登录。
- 退出登录 / 清除缓存时同步清理或保留 wb_login_at（清除缓存保留登录态）。


## 首页 → 功能闭环

```text
AI智能导诊 → 一句话说症状 → **直接推荐科室** → 追问「需要我告诉您怎么去吗？」
           → 答「要」→ 院内导航页（带科室参数，路线从**医院大门**开始生长）
我要看病（挂号）→ 科室→医生→时段→确认 → 本地生成预约号 → 挂号记录页可见
AI问诊（TabBar）→ 进门固定一句话 → 用户回一句 → **直接分诊出科室**（分级/依据/备选/挂号；不再多轮追问）
AI养生 → 体质辨识 → 三天方案（膳食/功法/睡眠）→ 投屏
智能电视投屏 → 连接设备 → 切换功能 → 大屏预览
```

---

# 6. 数据策略

- **页面业务数据一律来自后端契约端点**（经 `services/*.js` → `services/request.js`）：挂号、问诊、健康档案、家庭成员、
  我的信息（/me）、首页汇总（/home/summary）、医生列表等；未返回字段留空不显示，未开通能力如实提示。
- `utils/mock-data.js` 仅作**开发档降级兜底**（MOCK_FALLBACK=true 且后端不可用时经 `withFallback` 使用；
  生产档禁用）——页面代码里不得再直接 `app.MOCK.*` 作为常态数据源。
- 挂号提交的新预约写入 `wx.setStorageSync('wb_new_appointments')`，挂号记录页合并展示。
- 投屏连接状态存 `wb_tv`，首页/我的页显示已连接状态。
- 健康科普内容随包发布（`utils/knowledge-kb.js`，院内宣教材料，非后端接口数据）。

---

# 7. 当前问题

```text
1. TTS/ASR 已接入统一网关（Qwen3-TTS WAV + FunASR），但依赖后端在线；
   后端未启动时按钮友好提示，朗读失败绝不阻断主流程（speak 永不 reject）
2. 导诊 / 问诊 / 挂号为本地演示数据，非真实医疗建议
3. 医生端床位管理为演示占位（工作台入口弹窗说明）
4. 投屏为本地模拟（DLNA/局域网协议待接入）
5. ✅ 手势识别与 Live2D 数字人已于 2026-09-13 下线（入口/页面/服务/分包全部移除）；
   后端 `avatar-backend/`、素材 `mao/` 与 Unity :8787 未受影响，前端不再引用。
6. 院内导航为 1F 示意平面图：起点固定为**医院大门**，急诊科为独立绿色通道（不在本图内，
   传 dept=急诊科 时给明确指引而非"未找到"）。
```

---

# 8. 下一步

```text
1. 微信开发者工具打开 miniprogram/ 预览，走通 登录→首页→各功能 全流程
2. 对照 V3.1 说明书打磨视觉细节（动画节奏、Safe Area、胶囊避让）
3. 按需接入真实后端（替换 mock-data.js）或微信 TTS 插件
4. 上线前：配置合法域名（本项目纯前端无需 request 域名，仅语音/TTS 插件需要）
```

# 8.1 新增需求：Live2D 数字人实时语音对话页（V1.1 本地版，待启动 POC）

```text
文档    ：docs/数字人对话_技术评估与实施方案.md（V1.1 本地全链路版）
难度    ：4/5（V0 无真打断为 3/5）；最短板 = 小程序音频能力
场景    ：个人主体 + 无备案 + 本地全链路（内部演示/技术验证/比赛路演），不可正式发布
主选路线：原生 canvas type="webgl" 移植 Cubism 4 + 单条 WSS（ngrok 已有）+ FastAPI 网关编排
全链路  ：FunASR 1.0.27（ASR，本机已装）→ Ollama qwen2.5:7b（0.5b 降级）→ Edge TTS 7.2.8（TTS，已装）
模型    ：mao/（Cubism4 猫娘）已就绪 —— asm.js Core + 8 表情 + 7 动作 + 物理；⚠️无 ParamMouthOpenY
          需 Up/Down 组合模拟口型；纹理 4096²/7.9MB 必须压缩（→2048² ≤2MB）
3D 资产 ：models/（airdela PMX/GLB、VRM 23-26MB）非 Live2D，本期不采用
已否决  ：web-view 内嵌 H5（个人主体不支持业务域名 + postMessage 仅后退/销毁/分享触发）
风险    ：ngrok 长连接稳定性（POC 首日验证，备选局域网 IP）、CPU 下 7b 首 token 慢（降 0.5b）
里程碑  ：M0 POC 1 周 → V0 演示 2 周 → V1 连续对话 2~3 周 → V2 打磨 1~2 周（3~4 人 · 6~8 周）
```

# 8.2 M0 POC 进度（2026-08-30 启动；V0 编排完成 2026-08-31）

```text
✅ V0 后端编排（挂载进 :8000 主应用 ai_medical_system-merged，统一网关）：
   avatar/ 模块 = config + session + orchestrator + services{llm,tts} + routers{ws_avatar,rest}
   - text_input → Ollama 0.5b 流式（/api/generate）→ 句级切分 → EdgeTTS 逐句 mp3 → tts_end + emotion
   - audio_start/二进制/audio_end → FunASR 独立服务（:8005，avatar-backend/.venv）→ asr_final → 同上
   - interrupt → cancel 编排任务 → interrupted（生成立即终止，实测 1.1s 无残留帧）
   - 会话/轮次：session.py 内存窗口 10 轮 + 30min 过期；打断轮截断入库
   - 全链路实测（预热）：ASR 1.7s + LLM 首token 0.25~0.7s + 首句 TTS ~1.9s ≈ 端到端 ~4s（CPU）
✅ 小程序端 V0：avatar.js 接真实链路（chips 文字输入 + 录音上行 + 逐句 WebAudio 队列播放
   + 打断清队列 + SPEAKING 弱口型驱动 + 渲染 rAF 循环）
✅ 渲染核心（node 验证）：官方 asm.js core 5.1.0 加载 mao_pro.moc3 + 蒙皮变形 PASS
✅ 延迟实测（CPU）：Ollama 0.5b 首token 2.3s(冷)/0.25s(预热)；EdgeTTS 1.1s；FunASR 3.5s(冷)/1.7s(预热)
✅ 纹理：4096²→2048² 2.64MB；分包 packageAvatar 1.11MB<2MB
✅ 渲染修复（2026-08-31 09:50）：core drawables 的 vertexPositions/vertexUvs/indices 实为「普通 Array，
   元素为每 drawable 独立 TypedArray」（源码确认 new Array + 逐项 Float32Array/Uint16Array），渲染器原
   误用 .subarray() 导致渲染循环崩溃、模型画不出 → 改按索引取 D.vertexPositions[i]；另补 canvas 物理尺寸
   （CSS×dpr）设置，防 viewport 0×0。
✅ 渲染修复二（2026-08-31 10:10）：① 分包内文件 fs.readFileSync 在基础库 3.17 报 permission denied
   （已知坑）→ moc3 改 base64 内联 JS 模块（packageAvatar/assets/mao/moc3-base64.js，require 加载，
   870KB→1.16MB，分包 1.39MB<2MB，原 moc3 已删）；② 压缩版 live2dcubismcore.min.js 的 UMD 在
   CommonJS 下不导出 Live2DCubismCore（浏览器靠 var 全局提升）→ 文件末尾追加 CJS 导出补丁，
   node 实测 core 5.1.0 加载 moc3 PASS（260 drawables / 128 params）；③ onUnload 防御 destroy。
✅ 挂号同步（2026-08-31 10:15）：患者端 appointment onSubmit 从「写本地缓存」改为真实后端
   POST /api/appoint/submit（实测返回 挂号成功），医生端 APPOINT_LIST 实时可见；记录页 records.js
   改拉后端 APPOINT_LIST（按 phone 过滤）+ 本地缓存兜底；services/appointment.js formatTime 支持
   字符串日期（原对字符串调 getFullYear 会崩）。
✅ 数字人页布局整理（2026-08-31 10:30）：自定义导航（navigationStyle:custom）补安全距离——
   avatar.js 计算状态栏/底部安全区（safeTop/safeBottom，px→rpx）→ wxml 内联 style 应用；
   topbar 右侧预留 220rpx 胶囊避让区、degrade-tip 移到状态栏下方；
   字幕与快捷问题 chips 共用同一槽位且**互斥**（对话结束清空字幕，`_teardownPlayback/_backToIdle`
   均清 userSubtitle/aiSubtitle），统一置于底部控件上方 250rpx；控件置底 + 安全区 →
   组件不再互相遮挡，canvas z-index:0 最底层。
✅ 渲染根因修复（2026-08-31 10:50）：**模型画到屏幕外** —— moc3 顶点是归一化小值
   （实测 x∈[-0.6,0.6]、y∈[-2,1]），而 `_calcMatrix` 原按 canvasinfo 像素单位（5800×8400）
   投影 → 裁剪坐标恒为 (-2,0)，模型绘制在视口左外侧，FPS 正常但看不到人物。
   修复：矩阵改为按顶点包围盒自适应（等比适配画布 + 10% 边距 + y 翻转），node 验证
   35/35 顶点全部落入 [-1,1]；render() 补 gl.clearColor(0,0,0,0)+clear 防残影累积。
   排查点核对：① 清屏已补 ✓；② 视口/矩阵已修（核心）✓；③ 纹理 createImage + 主包
   /assets/mao/0.png 路径正确，texIndex 唯一为 0 ✓。
⬜ 待用户：小程序模拟器/真机验证（渲染 + 真实对话 + 打断 + 挂号同步）；路演 ngrok 指向 8000 即可
```

> ⚠️ 端口说明：**avatar 已统一到 :8000**（主应用挂载，ngrok→8000 业务+数字人共用一条隧道）；
> FunASR 独立服务 **:8005**（仅本机内部，启动：`avatar-backend/.venv/Scripts/python.exe asr_server.py`，模型常驻）；
> 8003 已彻底下线。

> ⚠️ 端口说明（2026-08-30 统一网关版）：avatar 网关已从独立网关进程并入「AI医疗病历生成系统」主应用，
> 数字人路由（/ws/avatar、/api/poc/*、/static/mao）随主应用统一监听 **:8000**；
> 开发者工具/模拟器连 ws://127.0.0.1:8000 即可；真机需局域网 IP，或经 ngrok 隧道 → 8000（业务与数字人共用）。
> 流式 ASR **:8006**（asr_wss.py，V1 流式 2pass，仅本机内部，随网关 :8000 自启；独立启动：
> `avatar-backend/.venv/Scripts/python.exe asr_wss.py`）。

---

# 8.3 V1 进度（流式 2pass + 鉴权 + 内容安全 + ASR 随网关自启）

```text
✅ V1 流式 ASR 2pass（avatar-backend/asr_wss.py，独立进程 :8006）：
   - 流式 paraformer-zh-streaming（funasr 经典 AutoModel，client 驱动端点，无需 fsmn-vad）
   + 离线 2pass paraformer-zh 整段重识别纠正；协议 start / 二进制 PCM16 / end → started / partial / final
   - 模型加载优化：直接指向 modelscope 本地缓存 snapshot 目录（绕开 hub，避死代理），启动 ~38s（不再重下 990MB）；
     已修两 bug：self.pcm 未累积致 final 空、partials _pending 缓冲错位致 partial 恒为 0
   - 冒烟实测：partial 段数=7（欢迎大→…→型这一）+ final 正确「欢 迎 大 家 来 体 验 达 摩 院 推 出 的 语 音 识 别 模 型」
✅ V1 鉴权（app/avatar/security/ticket.py）：HMAC-SHA256 一次性 ticket（issue/verify，TTL 60s，used 防重放）；
   rest.py 新增 POST /api/avatar/ticket；ws_avatar hello 做 AUTH_ENABLED 校验（默认关，上线开）
✅ V1 内容安全（app/avatar/safety.py）：filter_input（自残/制毒/开方）+ 沿用 filter_output；
   接进 ws_avatar text_input 与音频回合；默认 SAFETY_ENABLED 关，上线开
✅ V1 ASR 随网关自启（main.py lifespan + config）：网关启动自动拉起 asr_wss.py 子进程（独立 venv，端口占用则跳过），
   关闭时回收；ASR_AUTOSTART 默认 1（关设 0）。前端 fetchTicket 改连本地 :8000（同 WS 网关，修复 Failed to fetch）
⚠️ 部署注意：AUTH/SAFETY 默认关，需手动开环境变量才真正拦截；ASR :8006 由网关自启，
   也可独立 `avatar-backend/.venv/Scripts/python.exe asr_wss.py`（run_smoke.sh 一键冒烟）
```

---

> ⚠️ **「省电模式」是结果不是原因**：角标由 `fps < 18` 触发的自研降级逻辑点亮（DEV_LOG 第三十六批）。
> 项目是**原生微信小程序**，无 UniApp 的 `autoSleep` / `powerSaveMode` / `targetFps` 配置项，套用无效。

# 8.4 数字人渲染性能（2026-09-01）

```text
瓶颈：260 drawable（150 可见）× ~11 次 GL 调用 ≈ 1760 次/帧，且 UV/索引静态却每帧重传；
      叠加软件光栅化下的填充率压力 → 模拟器实测 9fps。
✅ 合并几何：_buildMergedGeometry() 把 260 件顶点/UV/索引合进 2 个 buffer（+padding 应对 ANGLE 边界严检），
   posBuf = [全部顶点位置 | 全部UV]，每帧只 bufferData 一次全量上传；**索引保持局部顶点号**（GL 定位 = offset + index*stride，索引带 base 会与 offset 叠成双重偏移）。
   → 每帧 GL 调用 1760 → 762（离线实测 6012 顶点 / 23817 索引，Uint16 足够，无需扩展）
✅ renderOrder 缓存（静态属性，init 排一次，杜绝每帧 260 临时对象 + 排序）
✅ 状态缓存：blendFunc 按模式切换下发、bindTexture 靠图集唯一收敛到 1 次
✅ setResolutionScale(k)：按系数缩画布物理像素（CSS 尺寸不变、等比故不变形），治填充率
✅ 分级降级：fps<18 连续回调 3 档（0.75 → 0.6 → 0.4），帧率同步 30 → 25 → 20fps
✅ 渲染循环帧率节流 + dt 改真实经过时间（降帧后动画速度不变慢）

⚠️⚠️ 合并几何必守的四条（违反即「模型碎裂 / 贴图乱飞」，2026-09-01 真机复验确认）：
   1. `vertexAttribPointer` 的 **stride 必须显式传 8**，绝不能传 0。
      部分小程序 WebGL 内核在 stride=0 时**忽略 offset** → 全部 drawable 从 buffer 第 0 字节
      取数据 → 顶点/UV 全盘错位。旧实现每件重传到起始处（offset 恒 0）故从未暴露。
   2. 只用 `bufferData(target, TypedArray, usage)` **一次性全量上传**。
      禁用 `bufferData(target, size:number, usage)` + `bufferSubData` 组合（部分内核偏移未生效）。
      位置段与 UV 段合并进同一个 Float32Array `_merged`，`_posData`/`_uvData` 为其 subarray 视图。
   3. **索引必须保持局部顶点号（0..vc-1），绝不预加 base**。
      GL 顶点定位 = attributeOffset + index*stride；vertexAttribPointer 的 offset=base*8 已定位到
      该件起点，索引再 +base 会叠成**双重偏移** → 顶点全部读到 base 个之后 → 撕裂碎片+贴图乱飞；
      且 ANGLE 校验 offset+maxIndex*stride 需要 96192+base*8 字节 → 0x502 not big enough。
      （验证脚本必须按此定位模型比对，纯「全局索引」模型会漏掉此错——已踩。）
   4. **buffer 末尾留 padding**：`_merged` +4 floats（16B）、`_idxData` +1 元素。
      ANGLE 后端（小程序 WebGL 走 ANGLE/D3D）对 DYNAMIC_DRAW 的边界检查比 WebGL 规范更严，
      把「访问 end == buffer size」判越界 → 报 `0x502 GL_INVALID_OPERATION: Vertex buffer is
      not big enough`。诊断可看 `gl.getBufferParameter(BUFFER_SIZE)` 的实际 size。

工具：node tools/check-require.js                   相对 require 解析校验
      node avatar-backend/verify_merge_geometry.js  离线验证合并几何（7 项断言，含渲染等价性）
```

---

# 8.5 骨架屏 + 联网降级（2026-09-02）

```text
✅ 骨架屏组件 components/skeleton/（通用，loading/type/rows 三属性）：
   - type：list（列表行）/ stats（统计数字块）/ card（大卡片，默认）
   - 动画只用 opacity 脉冲（sk-blink 1.2s），符合「动画只动 opacity」真机不闪屏规范
   - 已接入：挂号记录（records，list）、医生工作台概览（workbench，stats）
✅ 联网降级（最小设计，唯一开关在 config/env.js）：
   - MOCK_FALLBACK = true  → 开发阶段：后端连不上 → request 层自动回退固定演示数据
     （mock-data.js），骨架屏结束后直接展示演示数据，不弹错、不阻断开发
   - MOCK_FALLBACK = false → 上线阶段：后端连不上 → 原样报错，页面骨架屏结束后
     展示错误态 + 重试按钮，绝不混入伪造数据（上线前改这一处即可）
   - services/request.js 新增 withFallback(promise, mockFactory)：
     成功透传；开发阶段失败返回 mockFactory()（返回 null 则原样抛错）；上线阶段原样 reject
✅ 已接入降级的页面：
   - records 挂号记录：dev 用 APPOINTMENTS 兜底（转成后端字段结构过统一归一化）；上线失败 → 错误态+重新加载
   - workbench 医生工作台：dev 用 MOCK.DOCTOR.overview 兜底；上线失败 → 错误态+重试（原有）
   - appointment 挂号提交：dev 后端挂 → 模拟提交成功写本地缓存（流程不中断）；上线失败 → toast
   - consultation AI问诊：dev 后端挂 → 本地演示回复（不打科室卡，避免与打字机索引冲突）；上线失败 → toast
   - health AI养生 care-plan：dev 用 MOCK.WELLNESS 三天方案兜底（结构兼容 _normalize）；上线失败 → 弹窗
⚠️ 注意：consultation 开发降级只给文本回复，勿调 _fallbackDept —— 其 _pushDeptCard 同步追加消息
   会与打字机 setInterval 的 messages.length-1 索引冲突，导致 AI 文本空白（已注释在代码中）。
⚠️ 开发者工具依赖分析（2026-09-02 修复）：components/skeleton 被静态分析误判为无依赖文件报
   「已被代码依赖分析忽略」→ project.config.json 已关 `ignoreDevUnusedFiles`/`ignoreUploadUnusedFiles`
   （均 false）+ `packOptions.include` 显式包含 `components/skeleton/`。⚠️ include 元素必须为对象
   `{ "type": "folder", "value": "components/skeleton" }`（新版工具报「字段需为 object」，字符串写法无效）。
   新增组件目录后若再报此类错，按此两处检查。
```

---

# 8.6 13.2 寸 OPPO Pad 5 Pro 全站适配 + 真实图标替代 emoji（V1.7）

```text
✅ 真实图标（禁用 emoji）
   - 新增 tools/fetch-icons.js（长期工具，从 iconify API 抓取 Lucide 线性图标）
   - 工具链：fetch-icons.js → tools/icons-lucide.js（SVG inner）→ build-icons.js（合并入 icons.js）
            → svg2png.py（Pillow 自研光栅化）→ assets/icons/*.png
   - 图标数：40 → 65（PNG：164 → 195，三色：主蓝 #165DFF / 灰 #86909C / 白 #FFFFFF）
   - 来源：Lucide（https://lucide.dev，ISC，Feather 续作，24×24 stroke 2 描边风格与项目一致）
   - 替换覆盖 9 个页面：settings（9 处）· health-records（3）· cast（5 处 wxml + 4 处 functions 数据）
     · consultation / triage（👍👎）· result · avatar（控制区 4 处 + statusDot 6 状态）
     · appointment（★ 评分）· consultation.js 文案 emoji ⚠️
   - 数字人页控制图标统一使用 White 版（深色蓝渐变背景需要高对比）
   - 全站 wxml emoji 扫描（grep Extended_Pictographic）0 命中

✅ 13.2 寸 Pad 大屏档（app.wxss 新增 @media (min-width: 900px)）
   - 目标：OPPO Pad 5 Pro 3392×2400 @315ppi / 7:5 → windowWidth ≈ 1200pt（竖屏）/ 1696pt（横屏）
   - 字号放大：standard title 26 / h2 22 / body 18 / caption 15 / btn 56（不再 ÷2，大屏需更大）
   - 大字档比例保持 1 / 1.25 / 1.5：large 32/27/22/18, btn 70；xlarge 38/32/26/21, btn 84
   - 圆角与间距加大：radius-lg 16 / radius-md 12 / radius-sm 8 / space-page 24
   - 内容限宽：750 → 960px（避免两侧大片留白；横屏更舒展）
   - fixed 对齐：auth-back-btn calc(50% - 460px)；fab-zone calc(50% - 452px)
   - 适老化触控：.row min-height 48px（HIG 命中区）；.card padding 36rpx
   - 源序在 600px 之后，大屏档特异性更高，手机（375pt）与 iPad（768pt）档不受影响

✅ 适老化强化
   - 命中区 ≥ 48px（触控安全），按钮 ≥ 56px；状态用图标+文字双通道
   - 三档字号档在 Pad 上保持比例差；高对比度 .high-contrast 保留
   - 行高、字重、留白针对 13.2" 大屏重新校准（人眼距远 30-40cm 需要更大字号）

⚠️ 路径深度修复（V1.7 内）：result.js / cast.js 初版写成 `../../utils/icons.js`（两级错），
   check-require 第一轮报 REQUIRE_FAIL；改为 `../../../utils/icons.js`（三级）后 REQUIRE_OK。
   ⚠️ 凡新增页面 require 工具/服务层，三级是常态，必须用 check-require 验证。
```

---

# 8.7 统一网关 / 手势挂号 / Qwen3-TTS 适配（V1.7 · 2026-09-11）

> 依据《前端适配说明 · 统一网关 / 手势挂号 / Qwen3-TTS 音色》（2026-09-10 变更）逐条落地。

## 改造清单（对照说明 §8 Checklist）

| 项 | 落地 |
| --- | --- |
| 全局 baseURL 统一 | `config/env.js` 新增 `gateway` 唯一入口；`fastapi`/`springboot` 变为兼容别名；`request.js` 的 base 三值（gateway/python/java）全部解析到 `ENV.gateway`；全仓无 8001 |
| 直连 8088 改走网关 | api.js 全部 java 路径经网关转发（路径不变） |
| TTS 按 WAV 处理 | `services/speech.js` 重写：`POST /api/v1/voice/tts`（multipart, raw=0）→ `audio_base64` → 按文件头判 RIFF/ID3 后缀写临时文件 → InnerAudioContext；404/405 自动退到兼容别名 `/tts/edge` |
| TTS 传 voice 参数 | `speak(text, {voice})`，缺省读 storage `wb_voice`；响应 `voice_id/engine/degraded` 经 `onMeta/onDegraded` 上抛 |
| 降级处理 | `degraded=true` 或 `engine=placeholder` → 页面提示占位音质，照常播放不阻断；网关 `tts` 事件 `url=null` → 只提示文字结果 |
| 超时 ≥ 90s | env.js：aiTimeout 90s / ttsTimeout 120s / carePlanTimeout 180s / gesture 30s / dispatch 60s |
| 手势挂号模块 | 新页 `pages/gesture/gesture`（SSE 主通道 + 11 类事件 + prompt 弹症状输入 + register 挂号单 + tts 播放 + 进度条/手部提示） |
| /gesture 离线判断 | 健康轮询 `upstreams.unity_gesture.ok` + 会话快照 `gesture_source==='fallback'` → 「模拟模式」角标（琥珀）；在线 → 「真实识别」（绿） |
| 健康角标 | 手势页顶部角标轮询 8s；设置页新增「服务状态」卡（网关/Python/Java/手势/大模型 五项） |
| 音色管理界面 | 新页 `pages/profile/voice-settings`（分组列表/试听/设为默认/重扫目录）+ 设置页入口 |

## 新增/改动文件

```text
config/env.js              gateway 唯一入口 + 五档超时；数字人 avatar 默认随网关同源
                           （AVATAR_TUNNEL_OVERRIDE 留空=跟随 gateway，支持专用 WS 隧道）
config/api.js              base 语义改为 gateway/python/java；新增 GW_*（12 条）+ VOICE_*（6 条）
services/request.js        getBase 统一网关；新增 del / postForm(手写 multipart+UTF-8) /
                           getBinary / url / withPath / rawEnvelope / encodeUTF8 / decodeUTF8
services/speech.js         TTS 重写（WAV+voice+降级）+ playArrayBuffer + speakUrl + synthesize
services/gesture.js  [新]  SSE 客户端（enableChunked + onChunkReceived + retry 重连 + poll 降级）
                           + /api/gw/** 全量封装（start/stop/status/symptom/simulate/dispatch/health...）
services/voice.js    [新]  音色管理（list/setDefault/save/remove/reload/preview）
pages/gesture/*      [新]  手势挂号页（固定一屏：仅事件流滚动；状态区在 scroll-view 外）
pages/profile/voice-settings/* [新] 音色管理页（含 skeleton 骨架屏 + 错误重试）
pages/home/*               首页新增「手势挂号（免打字）」入口卡
pages/profile/settings/*   设置页新增「音色管理」入口 + 「服务状态」健康卡
app.json                   注册 2 个新页（pages 总数 15 → 17）
```

## 技术要点 / 踩坑

1. **小程序没有 EventSource**：用 `wx.request({ enableChunked: true })` + `RequestTask.onChunkReceived`
   逐块读流，按 `\n\n` 切帧、解析 `event:`/`data:`/`retry:`，注释行（`: ping` 心跳）忽略；
   网关 `retry: 2000` 对应本端断流重连间隔，重连后网关立即补推 session 快照。
   环境不支持分块或 8s 无数据 → 自动降级 `mode='poll'`（3s 轮询 status，事务事件改走 dispatch）。
2. **`/api/gw/session/status` 的 `gesture` 字段与 `data` 同级**：request.js 新增 `rawEnvelope`
   选项不脱壳，gesture.js 自己拆 `body.data` / `body.gesture`。
3. **multipart 必须自己拼**（小程序 wx.request 不支持无文件的 form-data）：request.js 内置
   UTF-8 编码器拼 `Content-Disposition` 体（含代理对），boundary 随机，规避中文乱码。
4. **手势帧高频推送**：UI 刷新按「关键值变化 + 200ms 节流」双重条件，值未变不 setData。
5. **TTS 文件后缀不再写死 .mp3**：按文件头判定（RIFF→wav / ID3|0xFFEx→mp3），避免内核按
   扩展名解码失败。
6. **挂号单号可能为空**：Java 落库异步，前端显示「已生成，稍后可在挂号记录查看」，不编造单号。

## 待真机验证

- SSE 长连接在真机（2.20.2+ 基础库）的分块下发与断流重连；
- 网关隧道（ChmlFrp）对 SSE 流式响应的缓冲行为（若整包下发则探活窗口会自动降级轮询）；
- 模拟模式完整链路：simulate → decision → register → tts 播放；
- 音色试听/切默认后的问诊播报音色是否立即生效。

---

# 8.8 院内导航（静态平面图 + 路径指示 · 2026-09-12）

> 需求：一张静态 1F 平面图作底图，用户点目的地 → 图上画出明显路线 + 文字步骤 + 语音播报。
> 需求建议里提到 wx-tilemap / okeevis-render 等第三方组件；本项目**不引入**，
> 改为「自绘平面图 + 自研 Canvas 2D 渲染」，零依赖、包体可控（底图 20.5KB 走分包）。

## 关键决策（与建议方案的差异）

| 建议 | 本项目做法 | 原因 |
| --- | --- | --- |
| wx-tilemap 覆盖层（自带手势/飞行） | 不用。自研 pan/pinch（touchstart/move/end） | 本项目原生栈、无 npm 构建（project.config `nodeModules:false`）；引入第三方库需开 npm 构建并增大主包 |
| image 底图 + DOM marker + canvas 叠层 | **底图 + 路径 + 标记全部画在同一张 canvas** | 小程序 canvas 是原生组件，放进 movable-view/image 的 transform 图层时真机（尤其 iOS）不跟随位移 → "图动了线不动"。同层绘制从根上规避 |
| 路径数据手填坐标 | **由 tools/floorplan-src.json 一次生成底图 PNG + 路径 JS** | 手绘一张图 + 手填一套坐标，改一处忘一处 → "线飘在墙外"。单一数据源保证永远对齐 |
| 底图放主包 | 放 **packageNav 分包** | 主包 1.66MB / 2MB，必须给主包留余量 |

## 构建链（改坐标只改一个文件）

```text
tools/floorplan-src.json            唯一真源：外墙/房间/门洞/区名/目的地/路径折线（像素坐标）
        │
        ├─ python tools/build-floorplan.py        → miniprogram/packageNav/assets/floor1.png（1440×860，21.3KB）
        │                                           （Pillow 绘制，2x 超采样 + LANCZOS；含 --check 自检）
        └─ python tools/build-floorplan.py        → miniprogram/packageNav/data/indoor-map.js（自动生成，勿手改）
                                                    （坐标换算成百分比；含距离/步骤/反向步骤文案）

python tools/preview-indoor-nav.py   离线渲染等价预览：用与 nav.js 相同公式合成"底图+路径+标记"，
                                     并做标记名重叠检测；改路线后据此肉眼验收（scale=0.45 模拟真机观感）
```

## 页面与交互（packageNav/pages/nav/nav）

```text
渲染：canvas type="2d"（同层渲染，支持圆角裁剪）；底图 drawImage + 路径生长动画 + 标记 pill
      动画：按路径长度截取 0→1（约 900ms），完成后画段中方向箭头 + 起终点圆点；不做持续循环动画（省电）
手势：单指拖动 / 双指缩放（锚点为手指中点）/ 点击命中标记（屏幕 34px 半径，适老化）
     缩放 0.4~2.2，按钮兜底（缩小/放大/复位/重播路线）——长者不一定会双指
配色（2026-10-16 基调对齐）：门诊 `#0B6EF8` · 检查 `#00B42A` · 服务 `#FF7D00` · 治疗 `#9566FA` · 设施 `#86909C`（起点服务台 `#00B42A`）
      状态不只靠颜色：标记名 pill 文本 + 卡片分类文字
一屏布局：顶部信息 / 地图 flex:1 / 缩放条 / 提示 / 分类 chips / 目的地横向卡片条；
         路线详情为**半屏弹层**（fixed，wx:if 直接切换、无过渡动画）→ 不撑开主布局，无高度跳变
步骤：① 从门诊大厅 · 服务台出发 ② 直行，走约 8 米 ③ 向左转，走约 20 米 … ④ 到达内科诊区
      （由脚本按"正交段 + 转向叉积"自动生成；支持「返回大厅」反向路线）
语音：speech.speak(步骤拼接文案)，尊重设置页「语音朗读」开关；失败只提示不阻断
深链：pages/triage/result 的「查看院内路线」→ /packageNav/pages/nav/nav?dept=科室名
      （DEPT_MAP 把 呼吸内科/心血管内科… 映射到目的地，未命中给友好提示）
数据：13 个目的地，自「服务台」出发，全部正交且只走走廊/大厅（build-floorplan.py --check 强制校验）
      门诊：消化内科 / 呼吸内科 / 心血管内科 / 骨科 / 儿科诊区
      检查：放射科 / 检验科    服务：药房 / 挂号缴费    治疗：输液室    设施：电梯厅 / 楼梯间 / 卫生间
      ⚠️ 前 4 个是**后端真实科室**（GET /api/gw/departments 实测：呼吸内科/心血管内科/消化内科/骨科），
        平面图上各有**独立房间**（不是笼统映射到"内科诊区"）
科室匹配（三级，尽力不落空）：① 精确表 DEPT_MAP ② 关键字规则 DEPT_RULES（专科优先，泛内科/外科兜底）
      ③ 名称互相包含；都不中 → 友好提示"未找到 XX 的具体位置，请从下方选择目的地"
入口：首页卡 / 导诊结果「查看院内路线」/ **挂号成功页** / **手势挂号单**（后两者带刚挂的科室直达）
```

## 验证

```text
python tools/build-floorplan.py --check     13 条路径正交 + 拐点都在通行区 + 终点在房间内
node -e 科室匹配断言                       后端 4 个真实科室 4/4 直达各自房间（含别名/规则兜底）
python tools/preview-indoor-nav.py          全尺寸与真机 scale 双档渲染，标记名重叠检测：无
node tools/check-require.js                 46 js / 69 require → REQUIRE_OK
node -e 数据断言                            坐标/距离/步骤/图标/分类 全部合规
包体：主包 1.66MB（余量 350KB）· packageAvatar 0.29MB · packageNav 0.10MB · 合计 2.04MB（上限 20MB）
```

---

# 8.9 AI 智能导诊优化（V1.8 · 2026-09-12）

> 目标：症状采集与自然语言理解 → 知识库科室匹配与分级建议 → 急诊危重识别与预警 → 结果清晰反馈，
> 并说明准确性 / 合规性 / 隐私保护 / 多轮对话四方面的设计考量。

## 优化前的问题（实测，非推测）

| 问题 | 证据 |
| --- | --- |
| **导诊页无任何入口** | 全仓搜索 `pages/triage/triage` 仅命中 app.json 注册，首页等页面均未跳转 → 整个模块不可达 |
| **导诊报告页是死页** | `pages/triage/result` 同样无人跳转（只被自己注释引用） |
| **急诊识别形同虚设** | `API.TRIAGE_EMERGENCY`（`/consultation/emergency/check`）**从未被调用**；且实测该接口对「胸口压榨样疼」返回 `is_emergency:false`、`matched_keywords:[]`（**漏判典型心梗红旗**） |
| **本地兜底过弱** | 只有 5 条关键词规则、单一科室、无分级、无理由、无误判防护（"没有发热"会被判成发热） |

## 新增架构（三层，零第三方依赖）

```text
utils/triage-kb.js       纯知识库：15 类红旗症状 / 18 个科室元信息 / 15 条症状-科室加权知识条
                         + 槽位词典（部位·时长·程度·伴随·人群）+ 否定词 + 追问模板 + 五级分级定义
utils/triage-engine.js   纯函数推理引擎（无 wx 依赖，可 node 单测）：槽位抽取 / 红旗判定 /
                         加权科室打分 / 分级 / 追问决策 / 后端结果融合 / 报告结构
services/triage.js       服务层：本地优先 + 后端 AI（emergency-check、recommend-department）融合；
                         隐私存储（本机记录 + 一键清除）、质量计数（只存计数不存文本）
pages/triage/triage      症状采集对话页（理解回执 / 追问 / 结果卡 / 急诊预警卡 + 常驻红条）
pages/triage/result      导诊报告页（分级 → 急救指引 → 科室与依据 → 症状回顾 → 下一步 → 免责隐私）
```

## 四项功能落地

1. **症状采集与 NLU**：逐轮抽取 5 类槽位并**即时回执**「已理解：部位/时长/程度/伴随/人群」；
   支持**否定识别**（命中词前 5 字窗口含"没有/无/不/否认"→ 不计分）；
   多轮上下文累积（历史轮次合并理解，第二轮出现红旗会立即升级）。
2. **知识库匹配与分级**：科室**加权打分**（主诉词 ×1.3 强化、24 个科室候选、儿童人群修正——
   儿童 → 儿科诊区加分、其它科室减半）；输出 主推荐 + 2 个备选 + **可解释理由**（命中了哪些词、
   持续多久、伴随什么）+ 匹配度；五级分级：紧急 / 较急(今日) / 一般(1~3 天) / 常规(门诊) / 居家观察。
3. **急诊危重识别与预警**：15 类红旗（急性胸痛、卒中 FAST、呼吸困难、意识障碍/抽搐、活动性大出血、
   剧烈头痛、过敏休克、中毒中暑溺水电击、严重外伤、急腹症、婴幼儿发热、孕产急症、自伤风险、
   大面积烧伤、高热惊厥）；命中即 **① 不等后端立即返回 ② 常驻红色预警条 + 弹窗 ③ 一键拨打 120
   ④ 主推荐强制切「急诊科」⑤ 停止继续闲聊**；后端报急同样升级（并同步切急诊科）。
4. **结果清晰反馈**：对话内结构化结果卡（分级徽标 → 科室/楼层 → 依据 → 建议 → 去挂号/院内路线/完整报告）
   + 独立「导诊报告」页（含症状回顾与下一步清单）；建议可语音播报。

## 四方面设计考量

**① 准确性（多信号加权 + 可解释 + 双通道交叉验证）**
- 不用单一关键词命中：主诉位置加权、人群修正、否定识别、红旗一票否决（不被分数稀释）；
- 双通道：本地规则 + 后端 AI，**急诊信号取并集**（任一报警即报警），科室以 AI 为主、本地为备选，
  一致时标注"AI 与规则一致"提升可信度；
- 可解释：给出判断依据与匹配度，不做"黑箱结论"；
- 可观测：本机统计（总量/急诊数/AI 命中率/本地兜底率/科室分布），只存计数、不存症状原文；
- 已知局限：知识库为规则型、覆盖常见主诉，罕见病与非典型表现会落到「全科医学科」并提示补充信息。

**② 合规性（不越界 + 免责全程可见）**
- 只输出**分诊建议**，不做诊断、不判断病情、不给药物与剂量；
- 免责声明三处常驻：对话页底部、结果卡脚注、报告页"免责与隐私说明"卡片（统一文案由服务层提供，避免各写各的）；
- 红旗场景**一律引导线下急救**，绝不出现"在家观察"；
- 人群风险单列（婴幼儿 / 孕产妇 / 老年人），并提示"以医院现场分诊为准"。

**③ 隐私保护（最小必要 + 本地优先 + 可删除）**
- 只把**症状文本**发给院内导诊服务（截断 200/500 字），**不上传姓名、手机号等身份信息**；
- 页面顶部用户信息本身已脱敏（刘*斌 / 138********8001）；
- 首次进入弹**隐私告知**，用户可选"仅本地分析"（此后不调用后端，纯离线出结论）；
- 导诊记录仅存本机 storage（最多 20 条），报告页提供**一键删除本机记录**；
- 质量统计只累加计数，不落原始症状文本。

**④ 多轮对话交互（一次只问一个问题，问到点上就停）**
- 缺什么问什么，优先级 时长 → 程度 → 部位 → 伴随；**每轮只问一个**并给快捷选项（长者不必打字）；
- 追问上限 2 轮（`MAX_FOLLOWUP`），问过的不重复问；
- **红旗或强匹配（非兜底科室且分数≥10）时不再追问**，直接给结论——避免"问诊问卷化"拖慢急症；
- 用户可随时点「生成结果」跳过追问；信息不足时明确标注"还在了解情况"而不是硬给科室。

## 验证

```text
node tools/test-triage.js        158 项断言全绿（含服务层 stub 集成）
  红旗 15/15 命中且必为 emergency；否定 4 例不误判；科室 14 例全对；分级 6 例合规；
  追问：会问/不重复/有上限/红旗不问；上下文累积；AI 融合 6 例（含后端报急升级）
  服务层：红旗命中时"未调用后端"（抢时间）；后端全挂仍出本地结论；后端报急即升级 + 主推荐切急诊科
node tools/check-require.js      49 js / 73 require → REQUIRE_OK
接口实测（经网关）：emergency/check 200（3.3s）、recommend-department 200（3.4s，clinic=消化内科门诊）
```

# 8.10 取消手势/数字人 + 导诊直推科室 + 院内导诊从大门开始（2026-09-13）

> 四条需求一次性落地：① 导诊说完症状**直接推荐科室**并追问"要不要告诉您怎么去"；
> ② 取消手势识别；③ 取消数字人（含首页入口按钮）；④ 院内导诊**从医院大门开始**。

## 一、AI 导诊（pages/triage）

| 变更 | 说明 |
| --- | --- |
| 直接推荐科室 | `triage-engine.analyze` 的追问门槛由「强匹配 score≥10 才停问」改为「**匹配到任何科室就停问**」（`matched = dept !== 兜底 && score > 0`）；只有完全识别不出归属（落全科医学科）才补问一个问题 |
| 路线询问 | 结果卡之后新增 `navask` 消息卡：`需要我告诉您去「XX」怎么走吗？` + 两个按钮 |
| 答「要」 | `onNavaskYes` → `wx.navigateTo('/packageNav/pages/nav/nav?dept=XX')`，进页即选中该科室并生长路线 |
| 答「不用」 | `onNavaskNo` → 回一句兜底去处（首页院内导航 / 来院导航），不打断对话 |
| 只在可导航时问 | 仅 `result.navigable === true`（1F 平面图有独立房间）才追问，避免导到不存在的地方 |

## 二、取消手势识别

- 删除 `pages/gesture/`（4 文件）、`services/gesture.js`，`app.json` 注销页面。
- **网关健康检查按职责拆出** → 新增 `services/gateway.js`（`health()` / `routes()`，仅 GW_HEALTH / GW_ROUTES）；
  `pages/profile/settings` 改用它，并从健康角标中移除「手势识别」一项（现为 网关 + Python + Java + 大模型）。
- `config/api.js` 删除 GW_SESSION_START/STOP/STATUS/STREAM/SYMPTOM、GW_GESTURE_SIMULATE、GW_DISPATCH、GW_DEPARTMENTS、GW_AUDIO。
- `config/env.js` 删除 `gestureTimeout` / `dispatchTimeout`。

## 三、取消数字人（含首页入口按钮）

- 删除 `packageAvatar/` 分包（含 Live2D 渲染器/core/资源加载器）与 `services/avatar.js`，`app.json` 注销分包。
- 删除首页 `AI 数字人对话（Live2D）`卡片与 `goAvatar()`；删除登录页 DEBUG-ONLY 调试入口
  （wxml 块 + `goAvatarDebug` + `onLoad` 内 `loadSubpackage('avatar')` 预下载，删除清单三处一次清干净）。
- `config/env.js` 删除 `avatarWs` / `avatarApi` / `avatarAssets` 与 `AVATAR_TUNNEL_OVERRIDE`。
- 后端 `avatar-backend/`、素材 `mao/`、Unity :8787 **保持不动**（前端不再引用，便于将来恢复）。
- 备份：`.workbuddy/backup/2026-09-13-remove-gesture-avatar/`（14 文件 / 382KB，可随时取回）。

## 四、院内导诊从大门开始（packageNav）

| 项 | 变更前 | 变更后 |
| --- | --- | --- |
| 起点 | 门诊大厅 · 服务台（720,600） | **医院大门**（720,770，南侧 110 宽门洞处），id `gate` |
| 路径首点 | 全部 `[720,600]` | 全部 `[720,770]`（沿中轴进楼后分发） |
| 大门标识 | 图外写"正门" | 图外写「**医院大门**」，图上起点标记名同步取自 `MAP.ORIGIN.name` |
| 步数/距离 | 消化内科 44m | 消化内科 53m（多出进门的 17m 直行段）；骨科 26m 单段直达 |
| 到院动线 | 无 | 门诊类目的地在路线详情里加提示：**先在「挂号 / 缴费」取号，再去诊室** |
| 急诊 | dept=急诊科 → "未找到" | 给明确指引：绿色通道独立入口、不在本图内、急危重症拨 120 |
| 返回 | "返回大厅" | "返回大门"（`reversed` 文案与 `stepsBack` 全同步） |

- 单一真源 `tools/floorplan-src.json` 改坐标 → 重跑 `python tools/build-floorplan.py` 同时产出
  底图 `floor1.png`（24.0KB）+ 数据 `indoor-map.js`，保证图线与坐标永不脱节。

## 五、验证

```text
node tools/check-require.js        42 js / 60 require → REQUIRE_OK（手势/数字人 8 个 js 已移除）
node tools/test-triage.js          171 项断言全绿（158 → 171：新增"直推科室不追问"9 项 + 服务层直推 3 项 + 兜底补问口径）
python tools/build-floorplan.py --check   13 个目的地路径全部正交且在通行区内
python tools/preview-indoor-nav.py        全尺寸/真机观感两档 → 标记名重叠：无
node --check                       miniprogram 全部 js 语法 OK；全部 json 可解析
禁址扫描                            无 127.0.0.1 / localhost / 8001 / 8088（命中项均为注释与超时毫秒数）
WXML 配平 / WXSS 花括号 / 图标引用      4 个改动 wxml + 2 个 wxss 全部 OK，图标 key 与 PNG 均存在
```

## 六、待真机复验

- 导诊："胃疼反酸" → 结果卡 → 路线询问 → 答「要」→ 院内导航直达消化内科（起点为大门）；
- 答「不用」的回话、以及"就是有点不舒服"这类无法识别输入的**单次补问**；
- 大门起点标记与"医院大门"字样在 13.2 寸 Pad 上的清晰度、路线生长动画是否被弹层遮挡。

---

# 8.11 AI 问诊改为「一句话直推导诊」（2026-09-13）

> 需求：进入页面机器人固定输出一句话 → 等用户回复 → 用户回的这一句**直接进导诊**，
> 不再做信息追问与补充，直接调导诊接口推荐科室。

## 一、页面流程（pages/consultation）

| 步骤 | 行为 |
| --- | --- |
| ① 进门 | 固定开场白：`您好，我是 AI 导诊助手。请用一句话描述您的不适（例如"胃疼反酸一周了"），我会直接为您推荐就诊科室。` |
| ② 等待 | 输入框可用；首屏额外给 4 个**可点症状示例**（胃疼反酸一周了 / 咳嗽有痰三天 / 胸闷心慌 / 腰疼膝盖疼），长者不必打字 |
| ③ 回复后 | 直接分诊（`THINKING` → 结果卡），**不追问、不补充、不做多轮** |
| ④ 结果卡 | 分级徽标 + 时限 + 推荐科室（匹配度/楼层/科室简介）+ 判断依据 + 备选科室 + 建议 + 「挂号」按钮 |
| ⑤ 急诊 | 红条 + 预警文案 + 弹窗 + 「拨打120」按钮（不引导去排队挂号） |

## 二、实现要点

- **复用同一套分诊**：页面调 `services/triage.js` 的 `analyze(text, { forceResult: true, useRemote })`，
  走「本地引擎 0ms 先出结论 + 并发 `emergency/check` / `recommend-department` 融合」，
  任一后端失败自动降级为本地规则结论（卡片标注「本地规则结果（AI 暂不可用）」）。
- **删掉旧的多轮会话链路**：不再调 `consultation/start|continue`（含"会话过期→累计对话重新 start"兜底），
  `sessionId` 状态、`_recommend`、`_fallbackDept`（写死 5 条规则）一并移除；
  `request.js / api.js / env.js` 三个 require 从页面卸掉（页面不再直接发请求）。
- **打字机改为可回调**：`_typeAi(content, done)` 输出结束后回调（急诊路径用来紧接着弹预警框）。
- **顺带修掉两个真问题**：
  1. 🔒 **隐私开关此前是失效的** —— `useRemote` 只传不判，"仅本地分析"仍会把症状发到后端。
     现 `services/triage.js` 在联网前判 `o.useRemote === false` → **零后端调用**直接出本地结论；
     问诊页也会在首次进入弹一次隐私告知（与导诊页共用 `wb_triage_notice_v1`）。
  2. 快捷服务行「来院导航」原来只弹"暂未开通"，现真正跳院内导航页（起点医院大门）。

## 三、验证

```text
node tools/test-triage.js     174 项全绿（171 → 174：新增"仅本地分析零后端调用"3 项）
node tools/check-require.js   42 js / 58 require → REQUIRE_OK
node --check                  consultation.js 语法 OK；WXML 配平 / WXSS 花括号配平 / 18 个事件绑定全部有实现
桩环境冒烟（Page+wx+后端桩，离线跑页面逻辑）：
  ① 开场白固定输出 ✓  ② 首屏 4 示例 ✓  ③ 一句话后 3 条消息（用户句 + 结果卡）且无 ask 消息 ✓
  ④ 同意隐私 → 后端调用 emergency/check + recommend-department 两次，卡片标注"匹配度：较高（AI 与规则一致）" ✓
  ⑤ 选"仅本地分析" → 后端调用 0 次，卡片标注"本地规则结果" ✓
  ⑥ 红旗输入 → 红条 + 打字机预警 + 「检测到紧急情况」弹窗 ✓
```

## 四、待真机复验

- 输入框 placeholder 与首屏示例在 13.2 寸 Pad 上的一屏可见性；
- 结果卡分级徽标 + 依据区在「大字模式」下的换行；
- TTS 播报（分级 + 科室 + 建议）与音色切换是否同导诊页一致。

---

# 8.12 科室卡后追问路线：答「要」直接进院内导航（2026-09-14）

> 需求：直接出科室后，还要追问「是否要告诉你 XX 科室怎么走」，等用户回答「是 / 要」时，
> 自动跳转到院内导航界面并显示去这个科室的路线。

## 一、交互

```text
用户：胃疼反酸一周了
AI  ：[结果卡] 一般 · 建议近 1~3 天就诊 / 建议就诊：消化内科 / 判断依据… / [挂号]
AI  ：[路线询问卡] 需要我告诉您去「消化内科」怎么走吗？   [要，带我去] [不用了]
用户：点「要，带我去」 或 直接打字「要 / 是 / 好 / 可以 / 带我去」
→ 自动跳转 packageNav/pages/nav/nav?dept=消化内科 → 该科室被选中并生长蓝色路线（起点=医院大门）
用户：打字「不用 / 不要 / 算了」
→ 不跳转，回一句兜底去处（来院导航 / 首页院内导航），对话不中断
```

## 二、实现

| 要点 | 说明 |
| --- | --- |
| 两条入口一致 | `pages/triage`（AI 智能导诊）与 `pages/consultation`（TabBar AI 问诊）都出这张路线询问卡 |
| 只在能导时问 | 仅 `result.navigable === true`（1F 平面图有独立房间）才追问，避免导到不存在的地方 |
| 待答态 | 出卡时记 `_pendingNavDept = 科室`；`send()` 第 ⓪ 步先判"这句是不是在回答"，是则**不再拿去分诊** |
| 打字也能答 | `services/triage.js` 新增并导出 `answerNav(text)` → `'yes'｜'no'｜''`；**先判否定再判肯定**（"不要"里含"要"，顺序反了会把人误送进导航） |
| 点按钮留痕 | 点按钮会先往对话里补一条用户消息（「要，带我去」/「不用了」），返回时能看到自己答了什么 |
| 说新症状 | 待答时用户又说了一句症状（`answerNav` 返回空串）→ 丢弃待答态，按新的分诊输入处理 |

## 三、验证

```text
node tools/test-triage.js     198 项全绿（174 → 198：新增"路线应答词"24 项，含
                              「不要/不用了」不得判成 yes、长句不当应答）
node tools/check-require.js   42 js / 58 require → REQUIRE_OK
桩环境冒烟（Page + wx + 后端桩，跑真实页面逻辑）：
  ① 问诊页消息序列 = 开场白 → 用户句 → dept 卡 → navask(消化内科) ✓
  ② 点「要，带我去」→ /packageNav/pages/nav/nav?dept=%E6%B6%88%E5%8C%96%E5%86%85%E7%A7%91 ✓ 待答态已清 ✓
  ③ 打字「要」→ 同上跳转 ✓；④ 打字「不用」→ 不跳转 + 兜底回话 ✓
  ⑤ 待答时说新症状 → 重新分诊出卡，跳转 0 次 ✓
  ⑥ 导诊页（triage）同款：消息序列含 navask，打字「要」→ 跳转 ✓
node --check / WXML 配平 / WXSS 花括号 / 图标 / 事件绑定 全部通过
```

## 四、待真机复验

- 点「要，带我去」后分包下载 + 页面跳转的耗时（首次会拉 `packageNav`）；
- 从导航页返回后对话区滚动位置与"要，带我去"留痕的可见性；
- 「大字模式」下路线询问卡两个按钮的文字是否换行。

---

# 8.13 带路追问覆盖全科室 + 全科医学科上图（2026-09-14）

> 问题：上一批做了「结果卡后追问要不要带路」，但真机上说「我的肚子不舒服」→ 推荐「全科医学科」→
> **没有弹出追问**。根因是追问门槛 `navigable` 只在「1F 平面图有独立房间」的 8 个科室为 true，
> 而全科医学科（导诊兜底科室、命中率最高）与 2F~4F 的 9 个专科都不在其中。

## 一、改了什么

| 改动 | 说明 |
| --- | --- |
| **全科医学科上图** | `tools/floorplan-src.json` 新增 1F 房间（门诊大厅内，800,535，300×110）+ 目的地 `gp`（x950,y590）；路线 `医院大门 → 直行 9 米 → 向右转 12 米`，全程 20 米 |
| **navigable 语义重写** | 由「1F 有房间」改为「**能否带路**」：1F 有房间 = 直达；2F~4F = 先到电梯厅再换层；**只有急诊科为 false**（绿色通道独立入口，不引导排队） |
| **导航页两级带路** | `nav.js` 新增 `_resolveDept()`：2F~4F 的科室自动落到「电梯厅」，并生成换层提示「「皮肤科」在门诊楼 2F：请先在「挂号 / 缴费」窗口取号，再按下方路线到「电梯厅」，乘电梯上 2 楼后按楼层指示牌找到诊室」 |
| **楼层单一真源** | 楼层只有 `utils/triage-kb.js` 的 `floor` 一处；nav 页直接 require 它，严禁再抄一份楼层表 |
| **全科不再被送去呼吸内科** | `DEPT_RULES` 里 `全科` 原混在「泛内科 → 呼吸内科」规则内，已拆出单列 `→ gp` |
| **换层提示 UI** | 路线详情弹层新增 `.nv-tip-floor`（暖色 + 上行图标）；每次选目的地/关闭弹层都会重置，不留上一个科室的提示 |
| **文案校准** | 导诊结果页「不在平面图内」的兜底提示改为急诊专指口径（现在只有急诊不可导） |

## 二、效果

```text
19 个科室 → 18 个都会追问「需要我告诉您去「XX」怎么走吗？」（仅急诊科不给带路）
答「要」后一定有路可走：
  1F 科室（9 个，含全科医学科）→ 直接出到诊室门口的路线
  2F~4F 科室（9 个）→ 先出 1F 段路线到「电梯厅」+ 明确写出"上 N 楼"
```

## 三、验证

```text
node tools/test-triage.js                241 项全绿（198→241，新增 ⑪「院内导航带路」43 项；
                                         含不变式：知识库里每个"可带路"科室都不许解析落空）
node tools/test-nav-page.js              31 项全绿（新增常驻工具：导航页接线 —— 1F 直达不误报换层、
                                         2F~4F 落电梯厅且写明上 N 楼、带「门诊」后缀、返回大门步骤仍在）
python tools/build-floorplan.py --check  14 个目的地路径全部正交且在通行区内
python tools/preview-indoor-nav.py       全尺寸 / 真机 scale 双档 → 标记名重叠：无
node tools/check-require.js              REQUIRE_OK（⚠️ 绘图脚本用 D:/anaconda3.0/python.exe 跑）
```

---

# 8.14 分诊准确性修复：「肚子疼」不再答全科医学科（2026-09-14）

> 反馈：问「肚子疼」推荐的是全科医学科，应该是消化内科。实测是两个叠加缺陷，且**不止肚子**。

## 一、实测到的两个缺陷

| 输入 | 修复前 | 原因 |
| --- | --- | --- |
| 肚子疼 | 消化内科 ✅ | —— |
| **肚子痛 / 肚痛 / 肚子胀 / 腹部不适** | **全科医学科，分级「居家观察」** | 消化内科只登记了「肚子疼」一种说法，同义口语全漏；**抓不到症状 → 连分级都掉到"居家观察"（安全风险）** |
| **我的肚子不舒服 / 眼睛不舒服 / 牙不舒服 / 腰不舒服 / 嗓子不舒服…** | **全科医学科** | 「不舒服/难受」是**全科医学科的兜底词**，而句子里的部位词（肚子/眼睛/牙/腰）**没有任何科室权重** → 有明确部位的输入被当成"未分化" |

⚠️ 这不是个案：**所有「部位 + 不舒服」的说法都答全科医学科**。
联网时后端 AI 会给对（「消化内科门诊」），但用户截图那次卡片写着「本次为本地规则结果（AI 暂不可用）」，
隐私开关选「仅本地分析」时更是**零后端调用** —— 本地这一侧必须自己答对。

## 二、修复（数据为主 + 一条零回归面的兜底校正）

| 改动 | 说明 |
| --- | --- |
| 补齐腹痛口语变体 | 消化内科 w6 组加 `肚子痛/肚痛/肚疼/腹部痛/腹部疼`；w5 组加 `肚子胀/肚胀/腹部胀` |
| 新增 **`PART_PRIMARY`（部位 → 首选科室）** | 10 条常识映射：腹部→消化内科、口腔→口腔科、眼部→眼科、耳部/鼻部→耳鼻喉科、咽喉→呼吸内科、腰背部/四肢关节→骨科、泌尿→泌尿外科、皮肤→皮肤科 |
| 新增 `applyPartPrimary()` | **只在"没有任何科室命中"或"最高分就是全科医学科"时生效**（即眼看要落到全科了）→ 用部位把科室拉正。<br>⚠️ **零回归面**：前置条件决定了它改不到任何已能判专科的输入；分数「原分+1、下限 7、封顶 11」（部位只是兜底校正，不许宣称"匹配度较高"）；部位词会作为一次"命中"写进判断依据 |
| 部位词典拆分 | `身上` 从「皮肤」里拆出（'身上/全身' → **全身**）：「身上不舒服」是全身性的，不该被当成皮肤问题 |
| 有意保留的边界 | **胸部、头部不登记**（可能是呼吸也可能是心脏；"头不舒服"确实不足以定科）——猜错比老实送全科更糟；真的未分化（"就是有点不舒服"/"乏力"）仍走全科医学科 |

## 三、效果

```text
肚子疼/肚子痛/肚痛/肚疼/腹痛/腹部痛/肚子胀   → 消化内科（分级=常规·门诊，不再"居家观察"）
我的肚子不舒服/肚子有点不舒服/胃不舒服        → 消化内科 8（原来 全科医学科 7），依据「您提到了「肚子」，属于消化系统表现」
眼睛/牙/腰/膝盖/鼻子/耳朵/皮肤/嗓子不舒服      → 眼科/口腔科/骨科/骨科/耳鼻喉科/耳鼻喉科/皮肤科/呼吸内科
孩子·宝宝肚子不舒服 → 儿科诊区    孕妇·怀孕肚子不舒服 → 妇产科     老人肚子不舒服 → 消化内科
就是有点不舒服/全身不舒服/身上不舒服/乏力      → 仍然 全科医学科（不许乱猜）
本地与后端结论一致 → 结果卡显示「匹配度：较高（AI 与规则一致）」
```

## 四、验证

```text
node tools/test-triage.js   294 项全绿（241→294，新增 ③b「口语变体 + 部位兜底校正」53 项：
                            8 个腹痛口语变体全对且不许掉到 selfcare / 13 例「部位+不舒服」各归对科室 /
                            5 例无部位仍走全科 / 5 例已判专科不被改动）
node tools/test-nav-page.js 31 项全绿 · check-require OK · check-ui UI_CHECK_OK · 42 js 语法 OK
接口实测                    recommend-department 对上述输入均返回「消化内科门诊」→ 与本地一致
```

---

# 8.15 院内导航平板端排版/穿透/无声修复（2026-09-14）

> 真机（13.2" 平板）反馈：排版崩坏、底部按钮点不动、元素穿透重叠、语音播报没声音。

## 一、根因（逐条实测）

| 现象 | 根因 |
| --- | --- |
| **「按指引沿蓝色路线…」压在「返回大门」按钮上**（穿模）+ **按钮点不动** | `.nv-sheet` 只写了 `max-height: 56vh` —— **没有确定高度**。flex 容器高度不确定时 `flex:1` 子项无法解析：步骤区（`flex:1 + min-height:120rpx`）按内容铺开、溢出卡片；`scroll-view` 溢出不裁切 → **连同自己的图层画到后续兄弟节点（按钮行）之上，并抢走那块区域的点击**。两者同源，不是两个 bug |
| 平板上地图被挤没、目的地卡片巨大 | 本页固定尺寸大量用 `rpx`，而 **rpx 随屏宽等比放大**：1200pt 宽平板上 1rpx≈1.6px → 目的地条 `176rpx`=281px、卡片 `240rpx`=384px。全局 900px 断点只缩放 Token，**管不到页面里写死的 rpx** |
| 半屏弹层盖住地图/缩放工具/分类/目的地条 | 覆盖式浮层：平板竖屏 56vh≈950px，下半屏全被糊住 → "看得到路线却换不了目的地" |
| 语音播报没声音、也没提示 | 后端 TTS 实测正常（返回 RIFF/WAV）。客户端：① ArrayBuffer 写入误传 `encoding:'binary'`；② 赋值 `src` 后立刻 `play()`，部分机型资源未就绪 → 空操作；③ 失败提示写进 `.nv-hint`，而 hint 行**被详情面板完全盖住** → 用户感知为"没反应/没声" |

> 带路追问本身是好的（截图里页面已带着"消化内科"打开 = 追问 → 跳转成立），本次把它固化成常驻用例防退化。

## 二、修复

| 改动 | 说明 |
| --- | --- |
| 详情区**确定高度** | `.nv-sheet`: `max-height` → `height: 56vh` + `overflow: hidden`（溢出兜底裁切） |
| 步骤区**可收缩的滚动容器** | `.nv-steps`: `flex:1 1 auto; height:0; min-height:0; overflow:hidden` |
| 操作区**独立层级** | `.nv-sheet-ops`: `position:relative; z-index:1; background:var(--card)` —— 按钮永远在滚动区之上且不透明 |
| 平板断点 | `@media (min-width: 900px) and (min-height: 700px)`：① 写死的 rpx 尺寸全部改 px；② 详情改**就地占位面板**（`position: static`，地图让位、分类与目的地条留在上方 → **结构上不可能遮挡**）；③ 加高度条件排除横屏手机 |
| 步骤区回顶 | 换目的地/切方向时 `stepScrollTop` 0/1 交替 → 回到第一条步骤 |
| 画布重测 | `_watchWide/_relayout/onResize`：平板上面板挤动地图高度后 canvas 必须重设 backing store，否则画面拉伸；顺带支持旋转屏幕 |
| 播报可感知 | 点击即 toast「正在合成语音…」；失败/降级改走 toast；播报文案带上目的地；`speech.js` 修 ArrayBuffer 写入 + `onCanplay` 再播一次 |

## 三、验证（Chrome 无头实测盒模型，不是"看着差不多"）

```text
node tools/preview-nav-page.js           真实排版离线预览（同源 CSS + iframe 精确视口 + 盒模型实测）
node tools/preview-nav-page.js --measure 输出几何与重叠判定
  平板 1200×1696：body 无横向溢出；6 项重叠检查**全部 false**（指引行 bottom 1580 < 按钮行 top 1590；
                详情面板不压 chips/目的地条/缩放工具）；地图 680×776
  手机 375×812 ：指引行 bottom 663 < 按钮行 top 734（修前两者重叠）；按钮 169+167px 铺满内容区不出界
node tools/test-nav-page.js              62 项全绿（31→62）：+ 带路闭环 3 例 + 样式守则 7 项
node tools/test-triage.js                294 项全绿 · check-require REQUIRE_OK · check-ui UI_CHECK_OK
```

新增工具：`tools/preview-nav-page.js`（改导航页样式后必跑；⚠️ Chrome 无头窗口最小宽约 512px，
故用**指定尺寸的 iframe** 承载页面来获得真实视口）。

---

# 8.16 平板双栏改造：从「手机界面放大」到「医疗 Dashboard」（V1.12 · 2026-09-15）

外部评审提出 5 个方向（平板适配 / 界面视觉 / 操作逻辑 / 显示效果 / 性能）共 10 条建议。
本轮落地 **P0 + P1 前端项**；导航页双栏与后端接口类（overview）刻意不做，见"刻意不做"。

## 一、和前一轮适配的关系（重要）

上一轮（README §8.6）的平板策略是**收窄限宽 720px 单列居中**，并留下一条实测教训：
「960px 限宽 + 字号/徽章放大 → 卡片又宽又空，呈『手机界面放大』的怪感」。

本轮不是推翻它，而是补上它缺的那一半：**单列拉宽会空，双栏不会**。
所以：

| 页面类型 | 平板策略 |
|---|---|
| 需要"一屏放两件事"的 5 个核心页 | `.page-shell` → **1180px 双栏**（主栏 + 360px 侧栏） |
| 其余 16 个页面（记录/设置/音色/床位…） | **保持 720px 单列**，一行都没动 |

## 二、全局框架（`app.wxss`，opt-in 零回归）

```text
.page-shell          → 平板限宽 1180px（默认 .page 仍是 720px）
.shell-cols          → 平板变 flex row + gap 24px；手机是普通块级流
.shell-main          → flex:1 + min-width:0（必须能收缩，否则顶破双栏）
.shell-side          → 360px，order:2 恒在右侧
.side-only           → 手机 display:none（"平板才有意义"的侧栏内容）
```

**关键设计：所有 shell 规则只在 `≥900px 且 ≥700px` 生效**，所以手机端的 DOM 顺序就是渲染顺序，
给页面加 `.page-shell` 不会改变手机布局。

⚠️ **高度条件不是可选项**：横向握持的手机（926×428）宽度也 ≥900 —— 只判宽度会把它排成双栏。
`app.wxss` 原 900px 断点（只判宽度，管 Token 缩放）本身没问题，但**双栏控制必须另起一个带高度的断点**。

## 三、五个页面的改造

| 页面 | 手机 | 平板 |
|---|---|---|
| `pages/home` | 单列（不变） | 左=AI助手/导诊/挂号/问诊·养生；右=**我的预约动态 + 院内导航** |
| `pages/consultation` | 进度卡在上、对话在下（不变） | 左=对话+输入条；右=就医进度 + **最近一次分诊结论**（科室/分级/匹配度/预约挂号/院内导航） |
| `pages/appointment` | 单列分步（不变） | 左=选择区（科室/医生**两列网格**、时间**3→4 列**）；右=**预约摘要**（实时同步选中态 + 同款 CTA） |
| `pages/doctor/workbench` | 卡片 + FAB（不变） | 左=统计看板 + 功能面板；右=**快捷操作**（FAB 的三个动作），**平板隐藏 FAB** |
| `packageNav/pages/nav` | — | **不动**（上一轮刚修好，见"刻意不做"） |

问诊页平板侧的排布做法：侧栏 DOM 放在**前面**（手机上进度卡必须在对话上方），
平板断点里用 `.consult-side { order: 2 }` 翻到右边 —— 靠 order 解耦，不靠改 DOM。

## 四、视觉规范（§7）

- ~~页面底 `#F5F7FA` / 卡片白 / 主蓝 `#165DFF` 保留~~ → **2026-10-16 更新**：页面底 `#F1F8FD` / 卡片白 / 主蓝 `#0B6EF8`（D-01 裁决 A 跟随参考图）；
- **卡片内边距 24px、间距 20px、圆角 14px、阴影极弱**（`--shadow-card: 0 2px 8px rgba(22,93,255,.06)`）；
- 统计卡之间用**浅灰 1px 分隔线**（`.ov-item + .ov-item::before`），不用大块阴影；
- ⚠️ 这些值在 900px 档**必须写 px**：原来写的 `32rpx/24rpx` 在 1200pt 平板上渲染成约 **51px/38px**，
  卡片被撑得又大又空（与 nav 页 KNOWN_ISSUES #18 同一个坑）。

## 五、性能（§10）

```text
① 聊天气泡不再整数组 setData
   原来：messages: this.data.messages.concat(msg)   ← 每轮把整个数组重传到视图层（O(n)）
   现在：_appendMsg() 用数据路径只推新增那一条        ← messages[7] = {...}（O(1)）
   并加 60 条上限（超出做一次整体裁剪，均摊成本极低）
   ⚠️ 逐字打字机那条路径本来就用的是 messages[n].content，未受影响

② 医生工作台概览加 30s 缓存（模块级 _ovCache）
   进工作台不再每次都把全部预约拉回来只为数 3 个数字；「重试」走 loadOverview(true) 绕过缓存

③ services/appointment.js 的 _allDoctors 缓存加 5 分钟 TTL
   原来缓存永久有效 → 医生停诊后用户会一直看到过期的可预约医生
```

## 六、刻意不做（附理由）

| 建议 | 为什么不在这轮做 |
|---|---|
| 导航页改「左大地图 + 右步骤」 | nav 上一轮刚做完"就地占位面板"，且 `tools/test-nav-page.js` 有 7 项**样式守则断言**（详情必须 static 面板/必须裁溢出/步骤区必须 height:0+flex+min-height:0）。改双栏要同步改断言 + 重跑 `preview-indoor-nav.py` 的重叠检测，属独立批次 |
| 后端加 `GET /appointment/overview` | 属接口变更，要后端配合；本轮先用前端 30s 缓存削掉重复开销 |
| 医生列表 4~6 列 / 订单分页 | 当前后端医生总量小、挂号列表已走真实接口，等数据量上来再做 |
| 点击医生不再"秒跳时间选择" | 会改挂号状态机（手机端同样受影响），超出本轮范围；右栏摘要已能给到"选中态 + 摘要更新"的反馈 |

## 七、验证

```text
node tools/preview-pad-pages.js --measure   12 组全过（4 页 × 平板/手机/横屏手机）
  平板 1200×1696：主栏 756 + 侧栏 360（workbench 796+360），并排、无横向溢出、无重叠
  手机 375×812  ：shell-cols display=block（单列）、body 375/375
  横屏手机 926×428：height<700 → 双栏不生效，仍是单列
node tools/preview-pad-pages.js             生成 12 张截图（tools/_pad_*.png）
node tools/test-nav-page.js                 62 项全绿（打桩补了"整条追加"数据路径支持）
node tools/test-triage.js                   294 项全绿 · check-require REQUIRE_OK
node tools/preview-nav-page.js --measure     导航页重叠/空白检查全 false（未被 app.wxss 改动带崩）
全量 42 个 js node --check 通过 · 禁址扫描仅剩 env.js/request.js 的说明性注释
```

新增工具：`tools/preview-pad-pages.js`（改这几个页面的平板样式后必跑；
与 `preview-nav-page.js` 同源：rpx→px 同源 CSS + 指定尺寸 iframe + Chrome 无头盒模型实测）。

---

# 8.17 院内导航平板端：让地图用满宽度，而不是"左地图 / 右步骤"（V1.12 · 2026-09-15）

外部评审把院内导航列为 P0，建议做「左侧大地图 + 右侧路线步骤」双栏。**实测后否掉了这个方案**，
理由是本页地图的比例（下面第一节），改用"用满宽度 + 地图与详情平分高度"。

## 一、先量比例，再决定布局

| 量 | 值 |
| --- | --- |
| 平面图基准 | `baseW/baseH = 1440 × 860`（**约 1.67:1 横向**，`data/indoor-map.js`） |
| 缩放方式 | `_fitView()`：`min(vw/baseW, vh/baseH)`（contain），并夹在 `[0.45, 1]` |
| 平板可用区（旧） | `.page` 把内容限宽 **720px** → 地图 **680×776** |
| 旧的实际绘制 | `min(680/1440, 776/860) = 0.472` → 平面图只画 **680×406** → **卡片里 48% 是空白** |

**结论**：竖屏平板上把地图塞进 760px 宽的左栏、拉满 1400px 高，平面图会缩成 760×454 —— 卡片里
**约 68% 是空白**。对一个横向平面图来说，"双栏"是把地图做小，不是做大。

## 二、改法

1. **根节点挂 `page-shell`**（`nav.wxml`）：平板用满 1180px（手机端 `.page-shell` 只是
   `box-sizing`，零回归）。→ 地图 **1140** 宽，画布比例终于和平面图对上。
2. **地图与详情平分剩余高度**（`nav.wxss` 平板档）：`.nv-sheet { flex: 1 1 0 }`（basis 必须是 `0`，
   写 `auto` 会按内容撑开、把地图挤小）；地图给 `flex: 1.2 1 0` 略多一点。
3. **地图卡留出工具栏内边距**（`padding-bottom: 62px`）：平面图铺满后，底部工具栏会压住图下沿的
   标注（实测 **"医院大门"被盖掉一半**）—— 这是"地图变大"带出来的新问题，必须一起修。
4. **步骤区回到"可收缩滚动区"**：面板高度已确定，故用 `height: 0 + flex: 1 + min-height: 0`
   （⚠️ 这正是手机端踩过的"文字穿模 + 按钮点不动"同源写法，不能只写 `flex: 1`）。
5. **新增未选目的地空状态**（`.nv-side-empty`）：把本该留白的下半屏变成"该做什么"的指引
   （适老化：每页答"我在哪 / 该做什么"）。手机端 `display: none`，完全不占位。
6. **横屏平板单独一档**（`orientation: landscape`）：可用高度只有 1200px，"地图 + 详情"竖直平分后
   地图只剩 385px 高 → 平面图缩成 648×387（**43% 空白**）、步骤区被压成 **86px 的一条缝**。
   横屏改为「地图 `min-height: 743px` + 详情 `min-height: 430px` + 页面自身滚动」：
   **743 = 平面图理想高度 681（= 1140 ÷ 1.674）+ 工具栏内边距 62**。
   > 代价：横屏不再严格"一屏"（手机与平板竖屏仍是一屏）。横屏平板是三档里最少用的握持方式，
   > 用一次短滚动换"地图铺满 + 步骤可读"，这个交换是划算的。

## 三、实测（Chrome 无头 + 盒模型，三档）

| 档 | 地图卡 | 画布 | 平面图实绘 | **空白率** | 详情/步骤 |
| --- | --- | --- | --- | --- | --- |
| 平板竖屏 1200×1696 | 1140×740 | 1140×678 | 1135×678 | **0%**（旧 48%） | 1140×605 / 步骤 311 |
| 平板横屏 1696×1200 | 1125×743 | 1125×681 | 1125×672 | **1%**（旧 43%） | 1125×672 / 步骤 333（旧 86） |
| 手机 375×812 | 343×573 | 343×573 | 648×387 | -28%（0.45 下限放大后裁切显示） | 固定弹层 375×455 |

手机档：布局与改动前**逐项一致**（`nv-map 343×573`、`nv-tools y140-178`、空状态 **0×0**）。

## 四、验证

```text
node tools/preview-nav-page.js 呼吸内科 --measure      三档全部检查 false（新增地图空白率 / 工具栏压图）
node tools/preview-nav-page.js 消化内科 --empty --measure  空状态平板 1140×609、横屏 1125×430、手机 0×0
node tools/test-nav-page.js                            74 项全绿（62 → 74，新增 12 条样式守则）
node tools/preview-pad-pages.js --measure              12 组全过（上一批四页未受影响）
node tools/test-triage.js                              294 项全绿
node tools/check-require.js                            REQUIRE_OK · 全量 42 个 js 语法通过
```

新增样式守则（防回归）：根节点必须挂 `page-shell`、空状态手机不占位、平板详情 `flex-basis: 0`、
平板步骤区 `height: 0 + min-height: 0`、**存在横屏档且地图/详情都有高度下限**、
**存在空状态节点**。工具侧新增两个断言：**地图空白率 > 25%** 与 **缩放工具栏压住平面图**。

## 8.18 长列表客户端分页（P1 · 2026-09-15）

建议里的「长列表首屏不要一次全部渲染」（挂号订单 / 问诊历史 / 健康记录 / 床位）落地：

- 新增 `miniprogram/utils/paginate.js`：`paginate(all, page, size)` 切分全量数组，默认 `PAGE_SIZE = 20`。
- 四个列表页（医生端 `appointments`/`beds`、患者端 `profile/consultations`/`profile/records`）改为：
  **拉全量 → 首屏只切 20 条进 `displayed` → 上拉 `onReachBottom` 追加下一页**；`data` 由 `list` 拆成
  `all / displayed / page / hasMore / total`，WXML 绑定 `displayed`，底部加「上拉加载更多 / 已显示全部 N 条」。
- 全局样式 `.load-more / .load-all`（app.wxss）。
- 不改业务逻辑：叫号/完成就诊仍操作 `all` 后按当前页重切 `displayed`；记录页的 phone 过滤 + 本地缓存合并保留。

> ⚠️ **本模块是对象导出，必须具名解构**：`const { paginate } = require('../../utils/paginate.js')`。
> 上线时四个页面写成了 `const paginate = require(...)`（默认导入）→ 运行时抛
> `paginate is not a function`，整屏只剩错误提示；另有 5 处 `all: p.all` 因返回体无 `all` 字段而恒为
> `undefined`（按钮点了没反应）。**完整复盘见 §8.23。**

```bash
# 分页逻辑自测
node tools/test-pages-paginate.js   # 推荐：48 项，含页面级取数/触底追加/叫号状态流转
node -e "const {paginate}=require('./miniprogram/utils/paginate.js'); const a=Array.from({length:45},(_,i)=>({id:i})); console.log(paginate(a,1).displayed.length, paginate(a,3).hasMore)"
# 预期：20 false（首屏 20 条；第三页累计 45 条、hasMore 翻 false）
# ⚠️ 注意上面这行用的是**具名解构**；页面里当初用的是默认导入，所以自测绿了、页面照样炸
```

---

## 8.19 分诊准确性再修：口语「疼」不再一律答全科医学科（2026-09-15）

用户反馈「什么问题都回答全科」。真机问题**不在后端**（实测网关 `recommend-department` 对
「我肚子疼」返回**消化内科门诊**、「咳嗽发烧」返回**呼吸内科门诊**，从不返回全科），
也**不在这次登录改动**（本次只改了 `app.js` / `login.js`；导诊文件停留在 2026-09-14）——
而是**本地知识库的口语词缺口**：

| 说法 | 修复前 | 原因 |
| --- | --- | --- |
| **头疼** | ❌ 全科医学科 | `神经内科` 登记的是**书面「头痛」**，不认口语「头疼」 |
| **脖子疼 / 颈椎疼 / 肩膀疼** | ❌ 全科医学科 | `骨科` 登记「脖子痛/肩膀痛」，且部位兜底表**没有「颈肩」** |
| **头有点疼 / 头很疼 / 头好疼** | ❌ 全科医学科 | 引擎是**连续子串**匹配，「头疼」中间夹副词就散了 |
| **手疼 / 胳膊疼** | ❌ 全科医学科 | 部位词典没登记 手/胳膊 |

**修复（三层，逐层加深）**

1. **补口语变体**：`神经内科` 加 `头疼/偏头痛/头胀/头沉/脑袋疼/脑仁疼`；`骨科` 加
   `脖子疼/肩膀疼/颈椎疼/膝盖疼/关节疼/腿疼/脚跟疼/颈痛/颈疼`。
2. **补部位兜底**：`PART_PRIMARY` 新增「颈肩 → 骨科」；「四肢关节」补 `手/胳膊/手腕`；
   `SLOT_DICT.part` 同步补 `手/胳膊/手臂/手腕`。
3. **夹副词不敏感**（治本）：新增 `normalizeLoose()`，**只给 `scoreDepartments`（症状词匹配）用**，
   折叠 `有点/有一点/很/好/挺/比较/特别/非常` → 「头有点疼」归一成「头疼」即命中。

> ⚠️ **为什么不能全局删副词**：`SLOT_DICT.severity` 正是用「有点/稍微/一点点/不太/很痛/非常痛」
> 当关键词，红旗词里也有「按下去很疼」——全局删除会把**「很痛」的急诊级别删没**（安全回归）。
> 所以只开症状词这一条宽松通道，并写进 `test-triage.js` ⑧ 护栏测试。

**效果**：37 条常见口语集里「落全科」**22% → 14%**，且剩下的 4/5 条（难受/不舒服/乏力/全身没劲）
是**真的未分化、本就该走全科医学科**（属正确行为）；仅「头不舒服」是知识库**刻意保守排除**的一项。

```bash
node tools/test-triage.js   322 项全绿（294→322：新增 ⑥「疼」口语变体 13 项 + 边界 3 项、
                            ⑦夹副词 8 项、⑧红旗/分级安全护栏 4 项）
```

---

## 8.20 登录态持久化：72 小时免重复登录（2026-09-15）

- `app.js`：新增 `SESSION_TTL_MS = 72h`；`setLogin` 写 `wb_login_at`（登录时间戳）；
  `onLaunch` 恢复时校验，**超过 72h 自动 `logout()`** 清除登录态；新增 `isLoggedIn()` / `_isSessionExpired()`。
- `pages/auth/login`：`onLoad` 若 `isLoggedIn()` 为真 → `reLaunch(getRoleEntry())` **跳过登录页**
  （这才是「不用重新登录」的可见效果；此前冷启动总会停在登录页）。
- `pages/profile/settings`：`onClearCache` 清存储前先读出 `wb_login_at`、清后写回 → **清缓存不丢登录态**。
- 口径：**固定窗口**（自登录起 72h，非滑动），纯前端时间戳；接后端 Token 后换成服务端过期时间。

---

# 8.21 平板双栏改为「横屏专属」（竖屏回落单列）

**问题**：上一轮把首页 / 问诊 / 挂号 / 医生工作台改成 `≥900px 且 ≥700px` 双栏，条件只判了尺寸、没判方向 ——
**平板竖屏**（1200×1696）也会排成双栏：内容只占上半屏、主栏又被 360px 侧栏挤窄，下半屏一大片留白
（实测：首页竖屏"侧栏底到视口底" 仍空着，横屏反倒空 756px —— 见下）。

**规则**（按用户口径）：**横屏用改造后的版式，竖屏回到改造之前的版式**。

**改法**：所有"这批新增的平板版式"断点统一加 `and (orientation: landscape)`：

| 文件 | 断点用途 |
| --- | --- |
| `app.wxss` | 双栏外壳 `.page-shell/.shell-cols/.shell-main/.shell-side/.side-only` |
| `pages/home/home.wxss` | 图标/卡片尺寸改回 px + Dashboard 两列 |
| `pages/consultation/consultation.wxss` | 左对话 + 右就医助手 + `order` 翻边 |
| `pages/appointment/appointment.wxss` | 左选择 + 右摘要 + 时间 4 列 |
| `pages/doctor/workbench/workbench.wxss` | Dashboard + 右栏快捷操作（横屏才隐 FAB） |

**竖屏落回什么**：`app.wxss` 里更早的 `@media (min-width: 900px)`（Token 放大 + `.page` 720px 限宽居中）——
即双栏改造之前的版式，零新增样式。

**为什么导航页例外**：导航页**竖屏也保留满宽 1180px**（它是**单列满宽**、不是双栏）。平面图是 1440×860 横向图，
`_fitView()` 按 contain 缩放：回退到 720px 后地图缩成 656×392，卡片内空白率由 12% 涨到 **50%**，
与"减少留白"的目标相反，所以不跟着回落。

**验证**：`node tools/preview-pad-pages.js --measure` 由 3 档视口扩到 **4 档**（横屏平板 1696×1200 / 竖屏平板 1200×1696 / 手机 / 横屏手机），
判定条件与 CSS 逐字对齐（`w>=900 && h>=700 && w>h`），并新增 **底部留白**、**侧栏底到视口底**、**主栏宽度占比**三个量化指标 →
**16/16 通过**：横屏平板双栏、竖屏平板单列、手机与横屏手机单列。
⚠️ 竖屏档（`padPortrait`）是常驻回归守卫：谁把 `orientation` 去掉，它立刻 FAIL。

---

# 8.22 健康科普模块（图文 + 提示视频，走分包）

**为什么走分包**：主包已 **1.76MB / 上限 2MB**，视频与封面必须放分包才不会撑爆主包。

**结构**

```text
miniprogram/utils/knowledge-kb.js              内容库（6 篇图文 + 3 个提示视频；CATEGORIES/FEED/byId/filterFeed）
miniprogram/packageContent/pages/knowledge    科普列表（分类 6 档 × 类型 全部/图文/提示视频）
miniprogram/packageContent/pages/detail       科普详情（图文分节正文 / video 播放 + 要点侧栏 + 相关科普）
miniprogram/packageContent/videos/*.mp4|jpg   3 个视频（各约 55KB）+ 封面
tools/build-health-videos.py                  生成脚本（Pillow 逐帧画要点卡 → ffmpeg libx264，640×360/12fps）
```

**内容**（院内宣教材料，**不是后端数据**——后端目前没有内容/视频接口）

- 提示视频：七步洗手法 / 在家量血压 4 个要点 / 起床三步曲（防跌倒），每个 4 屏 × 2.6 秒，带淡入与进度点
- 图文：高血压的一天 / 糖尿病饮食三个拳头 / 感冒还是流感 / 家里 6 个跌倒高发点 / 常见用药冲突 / 体检报告箭头

**入口**：首页「健康提示（短视频）」横滑卡（点卡直接进视频详情）+「全部健康科普」卡（进列表）。
`app.json` 配 `preloadRule`：进首页即后台预下载 `packageContent`（252KB），点开不等待。

**踩坑（重要）**：首页属于**主包**，最初把视频封面（`/packageContent/videos/*.jpg`）直接用在首页横滑卡上 ——
**主包页面不能引用分包资源**，分包未下载时会全部裂图。已改为主包内的图标徽章（`kb-badge` + 右下角视频角标），
封面与 mp4 只在包内页面使用。

**降级**：`<video binderror>` 触发时显示可见的失败说明（不静默、不留白屏），并给出线下路径。

**验证**：分包页面四件套齐全；内容库自检（图标键有效 / 视频与封面文件存在 / 每条含摘要与要点 / 分类筛选）；
主包 1.757MB、packageContent 252KB、合计 2.09MB（均在限内）。

---

# 8.23 长列表页运行时崩溃修复 + 错误态配色重做（V1.16 · 2026-09-16）

用户截图反馈：医生端「挂号管理」整屏只有一句「加载失败：paginate is not a function　重试」。

## 8.23.1 根因（两处，都在上一批分页改造里）

| # | 问题 | 表现 | 为什么没被测出来 |
|---|---|---|---|
| 1 | `utils/paginate.js` 是**对象导出** `{ PAGE_SIZE, paginate }`，四个页面却写成 `const paginate = require(...)`（默认导入） | 一调用就抛 `paginate is not a function`，整屏只剩错误提示 | `node --check` 只查语法、`check-require.js` 只查路径；而 §8.18 的自测片段**恰好用了具名解构**，于是自测绿、页面红 |
| 2 | `paginate()` 返回体里**没有 `all` 字段**，而 4 个文件共 5 处写了 `all: p.all` | `data.all = undefined` → `onCall/onFinish` 取不到行数据 → **叫号/完成按钮点了没反应** | 不报错、不白屏，纯"静默失效"，比报错更难查 |

## 8.23.2 修复

- `utils/paginate.js`：`paginate()` **回传归一化后的 `all`**（调用方一次 `setData` 就能存下全量与切片）；
  模块头写清"对象导出、必须具名解构"。
- 四个页面统一改 `const { paginate } = require('../../../utils/paginate.js')`。
- **错误文案中文化**：新增 `utils/err-text.js` → `errText(err, fallback)`。
  原来页面写 `error: err.message`，而 `err.message` 可能是后端原文、也可能是**本地 JS 异常**（就是那句英文）
  → 等于把英文/堆栈/HTTP 码直接怼给用户。规则：已知 code（`NO_BASE_URL / NETWORK_ERROR / TIMEOUT /
  HTTP_ERROR / PARSE_ERROR`）给确定中文；无 code 时**只有 message 含中文才允许展示**，纯 ASCII 一律换
  fallback，并把原文 `console.warn`（不静默吞错）。已接入 `appointments / beds / records / workbench /
  voice-settings`。

## 8.23.3 配色与触控重做

原错误态直接复用 `.empty` —— 用**最弱的灰** `--text-weak #86909C`（在页面底 `#F5F7FA` 上对比度约 **3.0:1**，
不达正文 4.5:1），"重试"还只是个蓝色文字链（触控目标远小于 88rpx 规范）。

| 项 | 改前 | 改后 |
|---|---|---|
| 容器 | 复用 `.empty` | 全局新增 `.state`（整屏）/ `.error-inline`（卡片内局部失败） |
| 视觉锚点 | 无 | **圆形图标徽章**：错误 = 实心主蓝 + `alertWhite`；空态 = 浅灰 + `searchGray` |
| 标题 | 无层级（与正文同色同号） | `.state-title`：`#00024E` / 600 字重 |
| 说明文字 | `--text-weak` 22rpx（还被页面级样式覆盖过） | `--text-sub #4E5969`（**≈7.4:1**）/ 26rpx |
| 重试 | `<text class="retry">` 文字链 | `.btn.btn-primary` 实心按钮，高 88rpx（`--btn-height`） |
| 空态文字对比 | 3.0:1 | 7.4:1 |
| 状态表达 | 靠颜色 | **图标 + 文案 + 颜色**（色觉障碍同样可辨，符合规则 4） |

顺手清掉的死样式与不当文案：`appointments.wxss`/`beds.wxss` 里把 `.empty` 覆盖成 22rpx 最弱灰的页面级样式、
`records.wxss` 的 `.error-box` 系列、`workbench.wxss` 的 `.loading-line/.error-line/.retry`（均已无引用）；
`beds.wxml` 里把接口路径写给用户看的空态（「接入 /api/v1/bed/list 后…」→「床位信息接入后会显示在这里」）。

## 8.23.4 新增三道守卫（这类问题静态查不出，只能靠工具）

```bash
node tools/check-exports.js        # 导入形状/导出名：默认导入"对象导出"的模块后当函数调用 → 报错
                                   # （已用坏夹具反向验证：会红，退出码 1）
node tools/test-pages-paginate.js  # 四个长列表页冒烟：打桩 wx/getApp/Page，真实跑 取数 → 触底 → 叫号（48 项）
node tools/check-project.js        # 语法 / json / icons.X 必须存在且页面 data 带 icons / 全局类被页面重复定义 / 禁址
```

守卫反向验证：临时抽掉 `paginate()` 的 `all` 回传 → `test-pages-paginate.js` 立即变红；还原 → 48/48 绿。

---

# 8.24 首页复刻收尾：平板实测三修（V1.17 · 2026-09-16）

按参考图重写患者端首页（`pages/home` 三件套 + 7 个彩色 PNG 图标 + 症状快选词直达结论）后，
跑平板排版实测暴露 3 个问题。**修复前首页 4 档全红，修复后 16/16 全绿。**

## 8.24.1 三个根因

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | 首页「问候语被小安压住」= true（4 档全红，**实测唯一根因**） | `.hm-greet/.hm-sub` 用 `padding-right` 躲绝对定位的小安——但 **padding 属于 border box，`getBoundingClientRect()` 不会因此变窄**；且占位值 `300rpx/150px` 小于 `gutter + 小安实际宽度`（超大字号档 314rpx/141px） | 改 `max-width: calc(100% - var(--h-ai-reserve))`（真实收窄）；占位提到 `340rpx/190px` |
| 2 | 首页侧栏卡片徽章变**巨块**、标题折 3 行 | `app.wxss` 的 ≥600px 档只把 **CSS 变量** rpx→px，**全局工具类**漏转：`.ic-sm 32rpx` 在 1696px 视口 = **72px**、`.icon-badge 88rpx` = **199px** | 该档补一组图标类 px 等价覆盖（`ic-*` 12/16/22/28px、`.icon-badge` 44px、`.section-header::before` 4×16px），影响 12 页（含登录页） |
| 3 | 导航页**竖屏**掉回 720px → 地图空白 **3% → 42%**（连带回归） | `.page-shell{max-width:1180px}` 在 §8.21 被限定为**横屏专属**（双栏外壳），而 nav 页**共用 `page-shell`**、自身断点**不分朝向** | nav.wxss 在 `@media (min-width:900px) and (min-height:700px)` 内**自声明** `.nvpage{max-width:1180px}` |

> ⚠️ 第 2 条与既有约定不冲突：app.wxss 明确「**布局**尺寸类硬编码 rpx（`.card` 内边距等）
> 继续等比，视觉留白略大可接受」。本次只补**图标类**（`.card` 另有 24px 覆盖，未动）。

## 8.24.2 两道新守卫（这两个问题原本都"测试绿、界面红"）

```bash
node tools/test-nav-page.js        # 新增静态断言：nav.wxss 必须自声明 1180px（74 → 75 项）
node tools/preview-nav-page.js     # 新增终判 RESULT: NAV_PREVIEW_OK/FAIL
                                   #（此前「❗地图空白超过 25%」只打印、不判定 → 回归无人发现）
```

反向验证：临时抽掉 nav.wxss 的 1180px → 静态测试 `FAIL`（NAV_PAGE_FAIL）、实测 `✗ tablet：地图空白超过 25%`
（NAV_PREVIEW_FAIL）；还原 → 双双转绿。

## 8.24.3 验证结果

```text
check-project 全通过（47 js / 29 json / 109 处图标引用 / 无全局类重复 / 禁址无命中）
check-require REQUIRE_OK · check-exports 全对得上 · test-triage 322 绿
test-nav-page 75 绿 · test-pages-paginate 48/48
preview-pad-pages --measure 16/16 PAD_LAYOUT_OK · preview-nav-page --measure 3/3 NAV_PREVIEW_OK
A/B：改 app.wxss 图标块前后跑 nav 实测，失败项完全一致 → 无回归
```

## 8.24.4 已知未改（非本批引入，实测基线与修复前一致）

- nav 页**手机档**详情浮层会压住分类 chips / 目的地条 —— 手机端是**底部半屏浮层**设计（自带「关闭」按钮），
  已从终判里**显式排除**，不是缺陷。
- `.img-arrow / .state-badge / .error-inline-*` 等其余全局工具类同样未转 px（宽屏偏大），
  本批只覆盖首页与导航页实际用到的；是否统一补齐待定。

---

# 8.25 首页接入设计交付素材（V1.18 · 2026-09-17）

设计交付 7 张图（背景渐变 / 智能导诊 banner / 小安 3D 头像 / 底部导航图标 / 3×3 服务图标九宫格 /
版式骨架 / 目标界面）。首页版式上一批已对齐参考图，本批把**占位换成真实素材**。主包当时余量 244KB，
必须做严格取舍。

## 8.25.1 素材落地取舍

| 交付图 | 处理 | 结论 |
|---|---|---|
| 小安头像卡 | 抠圆 → `assets/home/ai-doctor.png` 216×216 | ✅ 用（页面上显示 150rpx ≈ 2.9x） |
| 智能导诊 banner | 只取白卡内的医院插画 → `banner-hospital.jpg` 480×312 | ✅ 用 |
| 3×3 服务九宫格 | 取前 8 格抠圆 → `svc-*.png` × 8 | ✅ 用（第 9 格是空位） |
| 蓝色渐变背景 | 不落地 | 用两层 CSS 渐变复刻（右上径向光斑 + 顶部线性带），**省 46KB** |
| 底部导航线性图标 | 不落地 | tabBar 现用 `home/chat/leaf/user` 蓝灰双态 PNG 已等价、且更规范（81×81 透明底） |
| 版式骨架 | 不落地 | 仅作布局参照 |

合计新增 **55.7KB**；主包 1.804 → **1.860MB（余量 143KB）**。

## 8.25.2 新增 `tools/build-home-assets.py`

源图归档 `tools/_assets_src/`（**不进小程序包**）；脚本：裁切 → 圆形蒙版 → 缩放 → PNG-8 量化。
改设计稿后重跑即可，但 `shrink` 参数必须重测（见下）。

**抠圆的坑（本批调试主要成本）**：`shrink` = 蒙版半径相对裁切框的内缩量，**不能想当然**——
- 直接按「圆底连通域 bbox」裁 → 圆底外还带一圈渐隐，成品**圆外一圈浅色残影**；
- 小安头像按肉眼的 R=200 裁 → 圆**下方拖出一条白色月牙**（原图圆底连着白色装饰）。

正解：先出「同尺寸多种 shrink 的洋红底试版对照图」一次看准 → 头像 `shrink=18`（视觉半径 ≈182）、
服务图标 `shrink=10`；裁完再去掉多余边距，让圆正好填满输出图。
九宫格圆心用**降采样 + 连通域**求得（列中心 368/958/1544、行中心 342/920/1494），比阈值投影稳。

## 8.25.3 代码改动

- `home.js`：新增素材路径表 `A`；`SERVICES` 改为命名约定 `svc-<key>.png`（去掉 tint/iconPath），`withIcon()` 只服务四宫格。
- `home.wxml`：小安 → `.hm-ai-face-img`；banner 右侧 → `.hm-banner-art-img`；8 宫格 → `.hm-svc-ic`（素材自带浅蓝圆底，不再套 `.hm-tile`）。
- `home.wxss`：删 `--h-face-ic / --h-ring / --h-ring-ic / --h-svc-ic`；增 `--h-banner-art-w/h`（220×143rpx，
  与素材 480×312 **同比**——不同比会被 `aspectFill` 切构图）。
  ⚠️ 背景两层渐变时 `background-size` **必须分层写** `100% 100%, 100% var(--h-band)`，否则径向层被压成一条。
- `tools/preview-pad-pages.js`：首页骨架改用**真实素材**（`src="../miniprogram/assets/home/*"`）+ 四宫格真实图标
  —— 截图从此反映真实观感，不再全是灰块。

## 8.25.4 验证

```text
check-project 全通过（47 js / 29 json / 107 处图标引用 / 禁址无命中）
check-require REQUIRE_OK · test-triage 322 绿 · test-nav-page 75 绿 · test-pages-paginate 48/48
preview-pad-pages 16/16 PAD_LAYOUT_OK（手机 / 横屏手机 / 竖屏平板 / 横屏平板）
主包 1.860MB / 2.000MB（余量 143KB）
```

真机待验：四宫格与 8 宫格各入口跳转、快选词 `?text=` 直达结论、横屏↔竖屏回落、提示视频播放。

---

# 8.26 智能导诊 banner 重做：插画满高出血（V1.19 · 2026-09-17）

首屏那块「智能导诊 · 精准就医」原先是个**内嵌小缩略图**（宽 220rpx = 卡片宽 32%、带圆角、四周留白），
与设计稿的「插画贴卡片右下角满高出血」差得远。本批按设计稿重做构图。

## 构图对齐设计稿

| 元素 | 改前 | 改后 | 设计稿 |
|---|---|---|---|
| 插画占比（卡片宽） | 32%，内嵌 + 圆角 | **76%**，贴右下角出血（右/下由卡片圆角裁） | 72% |
| 插画高度 | 143rpx 固定（四周留白） | **= 卡片高（满高）** | 满高 |
| 楼占卡片高 | ~107%（**楼底被卡片下沿切掉**） | **69%**（楼基在卡片 97% 处） | 69% |
| 「更懂你的 / 健康助手」 | 插画上方另起一行、正体 | 斜体 + 左倾 8° + 收笔弧线，**叠在天空区右上** | 手写体叠在天空区 |
| 标题色 | `--primary-dark #0E4FD9` | `#0E1E45` 深蓝（设计稿取色） | 深蓝 |

## 三个坑（都不看会踩）

1. **素材比值决定楼会不会被切**。容器比值 = 520rpx/300rpx = **1.733**。
   原素材 480×312 = 1.538，**窄于**容器 → `aspectFill` 按宽缩放 → 楼被放大到卡片高的 ~107%、楼底被切。
   出图时按容器比值（660×381 = 1.732）就完全不裁切。
2. **`<image>` 是替换元素，`top:0 + bottom:0` 撑不起高度**（高度依固有比例，微信端还会塌成默认 320×240）。
   正解：卡片 `min-height` 与插画 `height` **用同一个变量** `--h-banner-h`，宽度 = 高 × 1.732。
3. **卡片右侧 padding 必须归零**：留了 padding，绝对定位的插画就只能贴到 padding 内缘，出不了血。

## 素材重裁

`tools/build-home-assets.py`：`BAN_BOX` 从 `(940,340,1800,900)` 恢复到插画真边界 `(659,365,1615,855)`
（原先从 x=940 起裁，把插画左边裁掉了）；新增 `BAN_SKY=62` 在顶部补天空 —— 天空是平滑水平渐变，
**把首行竖向拉伸**续接即可无缝（比留白或纯色填充自然）。

## 验证

```text
check-project 全通过 · check-require REQUIRE_OK · check-exports exit 0
test-triage 322 绿 · test-nav-page 75 绿 · test-pages-paginate 48/48
preview-pad-pages 16/16 PAD_LAYOUT_OK（新增 banner 两条断言）
主包 1.871MB / 2.000MB（余量 132KB）
```

新增守卫（负向验证过：把插画高改小 → 手机档立刻变红）：
- `首页banner插画占卡片高比 ≥ 0.95`
- `❗banner插画未贴右下角`（底边/右边与卡片差 > 1px 即判失败）

---

---

# 8.27 院内导航按设计稿重做（患者端 16-院内导航 · 2026-10-21）

> 触发：第 9 个复刻页面。原实现（§8.8）的版式与设计稿不符：顶部是「当前楼层/从/到 + 分类 chip + 目的地卡片条 + 下半屏路线弹层」，
> 而设计稿是**三张竖排卡**（路线信息卡 / 平面图卡 / 路线指引卡），一屏装得下。本次按设计稿重做 UI，
> **保留**原有 canvas 自绘引擎（底图+路线+标记同层绘制，自实现 pan/pinch）。

## 8.27.1 版式（设计稿 1391×3014 实测 → rpx）
| 区块 | 设计实测 | 实现 |
| --- | --- | --- |
| 页面留白 | 左右 20 / 顶 24 | `.nvpage{padding:24rpx 20rpx}` |
| 路线信息卡 | 高 148、内边距 30/44、标签 28、值 34 | `.nvi`（三栏 216 / 200 / 余量） |
| 平面图卡 | 高 696（内边距 20 + 画布 656） | `.nvm` + `.nvm-stage{height:656rpx}` |
| 楼层胶囊 | 204×50、左 20 / 底 19 | `.nvm-floor` |
| 浮动按钮 | 圆形 64、右 16 / 底 23 / 间距 30 | `.nvm-btn` |
| 路线指引卡 | 标题 40、步骤 34、编号 38、行距 38、语音行 101、分割线通栏 | `.nvr*` |

## 8.27.2 与设计稿的差异（逐条）
- **楼层**：设计稿左下角「1F/2F/3F」是静态胶囊 → 做成可展开的横向楼层 tab。1F 有底图；2F/3F 只有科室清单，
  给出「先按 1F 指引到电梯厅，乘电梯上 N 楼」的换层动线，**不伪造平面图**。
- **搜索**：设计稿没有搜索条 → 目的地选择做成弹层（信息卡「到」整格可点），内含输入框 + 搜索按钮 + 常用词 + 分类 + 结果列表；
  俗称可搜（厕所→卫生间、化验→检验科、电梯→电梯厅、缴费→挂号 / 缴费）。
- **浮动按钮**：设计稿只有 +/−；按需求补第三个「回到当前位置」（按钮组因此整体上移 92rpx）。
- **距离信息**：设计稿无「距离」→ 楼层/距离放在路线卡标题行右侧（不额外占高度）。
- **移除**「返回大门」与半屏路线弹层（设计稿没有）；步骤列表就地展示。
- **底图**仍是项目自有 `floor1.png`（1440×860 横向），与设计稿的示意平面图不同源：按宽度铺满画布、上下留图纸底色（`--bg`），
  属**素材差异**而非样式差异。

## 8.27.3 数据
- 科室：`GET /api/v1/departments`（`appointmentService.listDepartmentsC`）→ 后端科室全名（如「呼吸内科门诊」）、楼层分组、搜索关键词。
- 坐标/路线/步数/距离：本地 `packageNav/data/indoor-map.js`（路线本地计算，不调后端）。
- 设施（卫生间/电梯/楼梯…）：契约里没有设施表，只有本地一份真源，**不伪造接口**。

## 8.27.4 验证
```text
node tools/check-project.js        js 63 / json 36 / 图标 150 处 / 无重复类 / 无禁址  → 全部通过
node tools/test-pages-contract.js  37 / 37
node tools/test-triage.js          322 / 322  TRIAGE_OK
node tools/test-nav-page.js        80 / 80    NAV_PAGE_OK（②带路闭环不变；③样式守则按新版式重写）
node tools/test-fe-all.js          新增失败 0（2 项 KNOWN-FAIL 历史项）
```
离线渲染核对（无头 Chrome，750 / 375 / 1024 三档）：三张卡的卡带位置与设计稿差 ≤ 2rpx；
375 档下平面图线宽 / 起点标记 / 旗帜气泡与设计稿同比例。

---

# 8.28 页面复刻进度总表（第 1~23 页 · 2026-10-21）

> 依据 `页面复刻文档_DeepSeek版.md` §四 的页面顺序，逐页「对照设计稿 → 补全 → 数据对接 → 自检 → 断点」。
> 第 1~8 页集中在 2026-10-20 完成（明细见 `DEV_LOG.md` 同日期条目），第 9 页见 §8.27。
> ⚠️ **两轮的关系**：全站页面在 **2026-10-19** 已做过一轮像素级复刻（见 DEV_LOG 同日 5 条）；本轮（第 1~9 页）是按本文件 §四 的**第二轮逐页深对齐** —— 重新逐项校验、补缺失 UI、接真数据、补 ≥600px 断点、跑自检。因此第 10~16 页标「10-19 已复刻 · 本轮未重做」，不是"从没做过"。

| 序 | 页面 | 设计稿 | 主文件 | 数据来源 | ≥600px | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 首页 | 患者端/01-首页.png | `pages/home` | home · resource · knowledge-kb | ✅ | 已复刻 |
| 2 | AI 智能导诊 | 患者端/02-AI智能导诊.png | `pages/triage` | triage · speech · user | ✅ | 已复刻 |
| 3 | 预约挂号 | 患者端/03-预约挂号.png | `pages/appointment` | appointment · user | ✅ | 已复刻 |
| 4 | AI 问诊（Tab） | 患者端/B-TabBar补充/04-AI问诊首页.png | `pages/consultation` | triage · speech · user | ✅ | 已复刻 |
| 5 | AI 养生（Tab） | 患者端/B-TabBar补充/05-AI养生.png | `pages/health` | careplan · speech | ✅ | 已复刻 |
| 6 | 我的 / 个人中心 | 患者端/07-个人中心.png | `pages/profile` | user | ✅ | 已复刻 |
| 7 | 登录页 | 患者端/A-认证/01-登录页.png | `pages/auth/login` | user · doctor · resource | ✅ | 已复刻 |
| 8 | 医生端工作台 | 医生端/01-医生工作台.png | `pages/doctor/workbench` + `components/doctor-tab-bar` | user · doctor | ✅ | 已复刻 |
| 9 | 院内导航 | 患者端/F-导航与科普/16-院内导航.png | `packageNav/pages/nav` | **departments** · indoor-map(本地) · speech | ✅ | 已复刻（§8.27） |
| 10 | 健康科普列表 | 患者端/F-导航与科普/17-健康科普列表.png | `packageContent/pages/knowledge` | knowledge-kb（本地内容库） | ✅ | 已复刻（§8.29） |
| 11 | 科普详情 | 患者端/F-导航与科普/18、19-科普详情 | `packageContent/pages/detail` | knowledge-kb · content（远端视频） | ✅ | 已复刻（§8.30） |
| 12 | 健康档案 | 患者端/05-健康档案.png | `pages/profile/health-records` | user（health-records · attachments · interpret） | ✅ | 已复刻（§8.31） |
| 13 | 挂号记录（我的就医安排） | 患者端/06-我的就医安排.png | `pages/profile/records` | user（appointments/me） | ✅ | 已复刻（§8.32） |
| 14 | 我的问诊 | 患者端/C-个人中心/07-我的问诊.png | `pages/profile/consultations` | user（consultations） | ✅ | 已复刻（§8.33） |
| 15 | 家庭成员（家庭成员管理） | 患者端/C-个人中心/08-家庭成员.png | `pages/profile/family` | user（family-members 增删查） | ✅ | 已复刻（§8.34） |
| 16 | 个人信息 | 患者端/C-个人中心/09-个人信息.png | `pages/profile/personal-info` | user（me · extended · avatar · account） | ✅ | 已复刻（§8.35） |
| 17 | 系统设置 | 患者端/C-个人中心/10-系统设置.png | `pages/profile/settings` | gateway（gw/health 轮询）+ 本地存储 | ✅ | 已复刻（§8.36） |
| 18 | 在线问诊（会话页） | 患者端/04-在线问诊.png | `pages/consult` | user（consultations 详情/消息 · attachments） | ✅ | 已复刻（§8.37） |
| 19 | 医生端·挂号管理 | 医生端/E-医生端/13-挂号管理.png | `pages/doctor/appointments` | doctor（appointments 列表/状态流转） | ✅ | 已复刻（§8.38） |
| 20 | 适老化首页（theme-large / xlarge） | 患者端/08-适老化首页.png | `pages/home`（大字档 CSS + 问候文案分支） | home · resource · knowledge-kb | ✅ | 已复刻（§8.39） |
| 21 | 医生端·床位管理 | 医生端/E-医生端/14-床位管理.png | `pages/doctor/beds` | doctor（beds 列表 / assignment 入住） | ✅ | 已复刻（§8.40） |
| 22 | 医生端·个人管理 | 医生端/E-医生端/15-医生个人管理.png | `pages/doctor/personal` | me（当前用户）/ doctor（退出） | ✅ | 已复刻（§8.41） |
| 23 | 音色管理 | 患者端/C-个人中心/11-音色管理.png | `pages/profile/voice-settings` | **本地存储**（`services/voice.js` 本地版：`wb_voice` / `wb_voice_rate` / `wb_voice_hidden`） | ✅ | 已复刻（§8.42） |
| 24 | 其他页面 | 患者端/C-个人中心 06~10、D-投屏/12 | 见 §四 | — | — | ⏳ 10-19 已复刻 · 本轮未重做 |

**复刻统一口径（9 页共同遵守）**
1. **尺寸**：设计稿 1391px 宽 = 750rpx（1rpx ≈ 1.8547px），逐页按实测 rpx 落值；色彩 / 圆角 / 阴影 / 字号一律走 `app.wxss` 的 `page{}` 令牌，页面 wxss 里零字面色值（只允许语义白 `#FFFFFF`）。
2. **≥600px**：手机档写 rpx；断点段把该页**每一个**含 rpx 的选择器折成 px（÷2，含 `calc(…rpx)`），宽屏单列 375px 居中（`workbench` 额外保留平板左栏）。
3. **数据**：一律经 `services/*`；接口路径先注册进 `config/api.js`；页面内不散写业务数据，没有接口的入口如实提示「待接入」。
4. **冲突**：设计稿与「复刻文档」不一致时**以设计稿为准**，并写在该页 wxml 顶部注释里（例：第 8 页「今日工作」方块、第 9 页搜索改为「到」单元格进弹层）。
5. **图标**：只用 `utils/icons.js`，禁止 emoji / 字符箭头；缺字形走 `tools/build-icon-colors.py` 重着色 + 登记。
6. **回归**：改完必跑 `tools/check-project.js` + `tools/test-pages-contract.js` + `tools/test-fe-all.js`。

**遗留（与页面无关的工具债）**：`tools/preview-pad-pages.js` 的静态骨架未同步到第 8/9 页的版式。

# 8.29 第 10 页 · 健康科普列表（`packageContent/pages/knowledge`，2026-10-21）

设计稿：`design-output/患者端/F-导航与科普/17-健康科普列表.png`（1391×3014，1rpx ≈ 1.8547px，逐元素实测）。

**本轮实测修正（6 处）**

| # | 位置 | 改前 | 改后（实测依据） |
| --- | --- | --- | --- |
| 1 | hero 顶部留白 | `40rpx` | `82rpx`（hero 顶 319 → 标题字形顶 483 = 164px） |
| 2 | hero 主标题字号 | 硬编码 `52rpx`（适老化三档失效） | `calc(var(--font-title) + 16rpx)` = 56rpx（字形高 106px） |
| 3 | 搜索框上间距 | `32rpx`（紧跟标题，与设计稿差异最大） | `105rpx`（副标题底 691 → 搜索框顶 902 = 211px，大片留白给插画） |
| 4 | hero 右侧插画 | `flex` 平铺，把 hero 撑到 492rpx | `position:absolute` → hero 407rpx（设计稿 405rpx，误差 0.5%） |
| 5 | 卡片封面高 | `250rpx` | `288rpx`（实测 532px；卡片整体 340×425rpx） |
| 6 | 卡片文字区内距 | `20/20/22rpx` | `20/24/28rpx`（实测 49/48/53px） |

其余按实测落值：chip 高 48rpx、chip 字号 `--font-caption`、chip 间距 17rpx、chip 内距 9/24rpx、卡片 gap 20rpx、元信息字号 `--font-caption`；hero 由 `.grad-hero` 渐变改为纯色 `--primary`（多点采样恒为 (31,123,248)，非渐变），搜索框投影由深色改**白色提亮光晕**（实测框下亮度递增）。

**结构与代码**
- `kb-chip` 48rpx 低于 88rpx 触控线 → `::after` 上下各扩 20rpx 热区；`scroll-view` 默认 `overflow:hidden` 会裁掉热区，故容器加 `padding:20rpx 0` + `margin:-20rpx 0 6rpx` 抵消，视觉位置不变。
- 视频播放键由 `icons.videoWhite`（摄像机字形）改为 **CSS `border` 三角**（设计稿为纯白三角、无底圈），0 新增素材。
- 空态重做：图标 +「没有找到相关内容」+ 关键词可清空；不再用单行文字占位。
- 删死代码：`data.counts`、`data.type`、`onType()`、`_all[].durationLabel`、`_all[].meta`（wxml 均未引用）。
- `knowledge.json` 改白底黑字导航栏（设计稿状态栏/导航区纯白），与 `packageNav` 同范式。

**≥600px**：新增 600px 断点（原文件只有 900px），全部 rpx 折 px（÷2，含 `border-width`、`::after` 热区）；竖屏 600~899px 主栏 `max-width:375px` 居中，hero 由通栏出血改为圆角卡；横屏 ≥900px 转 3 列、主栏 720px。

**偏离项（3 条，待确认）**
1. **分类 chip 与数据不一致**：设计稿为「睡眠/饮食/运动/季节养生/慢病管理」，`utils/knowledge-kb.js` 实际分类为「睡眠/慢病管理/用药安全/老年照护/日常防护/就医指导」。按「不伪造数据」保留真实分类（强行对齐会让 4 个分类下的内容不可达）。若要对齐设计稿需先扩充科普库内容。
2. **视频封面素材**：3 个视频的 `cover` 指向 `videos/*.jpg`（视频首帧截图，16:9 带字幕），`aspectFill` 进 4:3 卡片会裁掉画面左侧文字。属素材缺陷，未擅自替换；建议后续单独出 3 张 4:3 封面。
3. **hero 插画**：设计稿为「心形描边 + 叶片 + 底部云朵」定制插画，此处用 `icons.heartWhite`（opacity .28）+ `icons.leafWhite` 叠加近似，云朵未还原（0 新增素材原则）。

# 8.30 第 11 页 · 科普详情（`packageContent/pages/detail`，2026-10-21）

设计稿两张：`18-科普详情图文.png` / `19-科普详情视频.png`（1391×3014）。同一页面按 `type` 分支承载两种版式。

**最大结构变更：改 `navigationStyle: custom`**
设计稿 18 的导航栏右侧是「收藏 + 分享」，原生导航栏放不进自定义按钮 → 自绘吸顶导航栏（与 `triage` / `workbench` / `consultation` 同范式）。页面根节点用内联 `padding-top: navH px`（`statusBarHeight + 44`）给吸顶栏让位。

**按实测重标（1rpx ≈ 1.8547px）**

| 元素 | 实测 | 落值 |
| --- | --- | --- |
| 导航栏内容中心 | y 230px | statusBar + 88rpx，图标 36/40rpx |
| 右上两图标中心距 | 183px | 99rpx（88rpx 热区 + 11rpx 间隙） |
| 图文标题 | 字形高 73px、行距 104px | `--font-title` + line-height 1.4 |
| 图文 meta | 字形高 45px | `--font-caption`，margin-top 16rpx |
| 通栏封面 | 1277×676px | 688×364rpx（边距 31rpx，`widthFix` 不裁切） |
| 正文行距 | 94px ÷ 30rpx | line-height 1.7 |
| 节间距 | 145px | 78rpx（首节 50rpx） |
| 小贴士块 | 1276×236px | 688×127rpx，`--accent-soft` 底 + `--radius-md` |
| 视频通栏黑底 | 921px 高 | 497rpx（比例 1.51:1，16:9 画面 letterbox） |
| 视频白卡 | 1307px 宽 | 705rpx，`--radius-lg` + `--shadow-card` |
| 相关推荐标题 | 字形高 65px | `--font-h2` |
| 相关卡片封面 | 290px 高 | 156rpx，图上文下、卡片无白底 |

**图文/视频差异（同一页面两套流）**
- 图文：标题 → meta → 通栏封面 → 分节正文 → 小贴士 → 相关推荐
- 视频：通栏播放器 → 白卡（标题/meta/摘要）→ 观看提示 → 相关推荐

**新增素材**：`assets/icons/share.svg` → `share.png` / `share_gray.png` / `share_white.png`（走 `miniprogram/tools/svg2png.py` 的 `render_svg`，3 色一次生成），已在 `utils/icons.js` 登记 `share` / `shareGray` / `shareWhite`。设计稿的分享键是「方框 + 上箭头」，原有 `send`（纸飞机）语义不符。

**点赞 / 收藏（本地存储，无后端）**：`kb_star_ids` / `kb_like_ids` 两个数组，按 id 存。顶部星标与底部「收藏」共用同一 storage key，改任一处两处同步变色。Storage 读写全部包 `try/catch`（脏数据/配额满不影响详情页渲染）。

**分享**：两处分享按钮都是 `<button open-type="share">`（普通 view 触发不了微信分享面板），配 `onShareAppMessage` 返回 `{title, path}`。

**≥600px**：新增完整断点（原文件只有 900px），全部 rpx 折 px（÷2，含 `calc(…rpx)`、`border-width`、`::before` 圆点尺寸）；主栏 375px 居中；**吸顶导航栏与底部栏同为 fixed，用 `left:50% + margin-left:-187.5px` 收进主栏**（否则横贯整个窗口）。

**偏离项（4 条，待确认）**
1. **导航栏标题**：设计稿 18 无标题（大标题紧随其后），19 有「视频科普」。为同时满足「返回 + 标题 + 分享」，图文页补「健康科普」、视频页用「视频科普」。
2. **分类 chip**：设计稿 meta 是纯灰字（科室 · 时长 · 日期），没有 chip。按复刻要求补 `category` 小胶囊，内嵌在 meta 行首，不额外占行。
3. **小贴士位置**：设计稿把它插在第二、三节之间；代码放在正文末尾 —— 不按节数硬编码插入位置（各篇 sections 数 4~6 不等）。
4. **视频 meta 缺科室与日期**：设计稿 19 是「营养科 · 5分30秒 · 2026-10-08」，但 `VIDEOS` 条目没有 `source` / `publishedAt` 字段，按「不伪造数据」只显示「视频时长 11 秒」。要对齐需给 `utils/knowledge-kb.js` 的 3 条视频补这两个字段（内容侧改动）。

# 8.31 第 12 页 · 健康档案（`pages/profile/health-records`，2026-10-21）

设计稿：`患者端/05-健康档案.png`（1391×3014）。**版式整体替换**：原实现是「筛选 chip + 左侧时间轴 + 记录卡」，设计稿是「个人信息卡 + 分类宫格 + 报告卡流 + 加密说明条」。

**实测落值**

| 元素 | 实测 | 落值 |
| --- | --- | --- |
| 卡片左右边距 | 41px | 24rpx（比全局 32rpx 窄，卡片流信息密度高） |
| 卡片间距 | 34px | 18rpx |
| 个人信息卡 | 269px 高 | 145rpx，白底 + primary rgba 渐变 |
| 头像 | — | 96rpx 圆形 |
| 姓名 / 副标题 | 字形 59px / 37px | `--font-h2` / `--font-caption` |
| 分类宫格卡 | 555px 高 | 299rpx，3 列网格 |
| 图标底板 | — | 88rpx + `--radius-md` |
| 报告卡 | 480~515px 高 | 259~278rpx |
| 卡片标题 | 约 32rpx | `calc(var(--font-body) + 2rpx)`，两行截断 |
| 加密说明条 | 197px 高 | 106rpx |

**修掉一个功能性死链（重点）**
`wxml` 里 AI 解读块引用了 `onInterpret` / `interpreting` / `interpretFail` / `interpretation` —— **`health-records.js` 里这四个全都不存在**（历史回退时 js 被改回、wxml 没同步）。表现为「AI 解读」按钮点了完全无反应、结果区永远空白。本轮补全：`services/user.js#interpretRecord` 本来就有，页面侧接上 501 降级文案（后端未实现时明确提示，不伪造解读文本）。

**补齐设计稿的按钮置灰态**
设计稿 05 里「胸部X光片 · 待审核」的两个按钮是灰的。本轮加 `locked` 字段（`hasReport && status !== READY`）：视觉置灰但**点击仍落到 handler**，由 handler 给「报告尚未出具」的中文提示 —— 避免做成点了没反应的死按钮。后端未下发 `reportStatus` 时**不锁**（就诊记录这类条目本来就没有报告状态）。

**其他**
- 分类宫格保留「由实际返回类别动态生成」，不硬编码设计稿那 5 个固定入口（点了会没有数据）。
- 个人信息卡补右箭头 → 跳 `pages/profile/personal-info`（原来整卡不可点）。
- 「上传检查资料」在设计稿里没有，弱化为卡内文字链接（保留 V9 既有能力）。
- 删掉时间轴相关样式（`.tl-*` 全组）；`hrc-page` 边距改 24rpx。
- `health-records.json` 导航栏改白底（设计稿 05 是白导航栏）。

**≥600px**：补完整断点，全部 rpx 折 px（÷2，含 `calc(…rpx)`、`border-width`）；主栏 375px 居中。

**偏离项（4 条，待确认）**
1. **分类宫格条目**：设计稿固定 5 个（检验报告/检查报告/就诊记录/用药记录/诊断记录），实际按后端 `category` 动态生成（6 种枚举）。硬编码会出现「点进去没数据」的假入口。要对齐需后端把 `EXAM` 拆成检验/检查两类。
2. **指标概览卡（BMI/血压/血糖）未做**：设计稿 05 没有这个区块，`/api/v1/health-records` 也只返回记录列表（无结构化指标）。要做得先加契约。
3. **就诊记录 / 报告分类 tab 未做**：设计稿是宫格筛选 + 单一卡片流，没有 tab；且 `/api/v1/visits`、`/api/v1/reports` 两个端点**在 `config/api.js` 里都不存在**。
4. **报告卡副信息只有「类别 · 日期」**：设计稿是「本院区 · 门诊检验 / 2026-10-15 上午」，契约没有机构、科室、时段字段，不编造。

# 8.32 第 13 页 · 挂号记录 / 我的就医安排（`pages/profile/records`，2026-10-21）

设计稿：`患者端/06-我的就医安排.png`（1391×3014）。本页此前是按**另一张**参考图 `患者端/C-个人中心/06-挂号记录.png` 对齐的（wxss 顶部旧注释），本轮改以用户指定的 06 为准。

**实测落值**

| 元素 | 实测 | 落值 |
| --- | --- | --- |
| 卡片左右边距 | 51px | 24rpx（与第 12 页健康档案统一） |
| 科室标题 | 字形 70px | `--font-title`（40rpx） |
| 医生行 | 字形 49px | `calc(var(--font-caption) + 2rpx)` = 26rpx ⚠️ 原为 `--font-h2` |
| 院区行 | 字形 46px | `--font-caption` |
| 日期块 | 约 88rpx 总高 | padding `24rpx 20rpx`（原 16rpx 偏矮） |
| 操作按钮 | — | `min-height: 76rpx`（设计稿更矮，按触控线保底） |

**关键修正：医生行字号**
原实现给医生行 `--font-h2`（34rpx），实测只有 49px=26rpx —— 比设计稿大 8rpx，会把「陈医生」顶成第二个主标题。设计稿里医生行与院区行**字号几乎一样**（49 vs 46px），层级是靠**字重 600 + 深色** vs **400 + 灰**拉开的，不是靠字号。

**其他**
- tab 计数改用全局 `.seg-tab-count`（原来直接拼在文字里，字号与 tab 主体相同，看不出层级）。
- 空态补「去挂号」CTA + 日历图标（原来只有文案，没有去向）。
- 「加载更多」补 CSS 虚线转圈（设计稿 06 有 spinner，纯 CSS 实现，0 新增素材）。
- 医生职称走容错：契约 `AppointmentData` **没有 `doctorTitle`**，有值才拼成「陈医生 · 副主任医师」，没有就只显示姓名。
- 补 `rc-page` 根类 → 页面边距 24rpx + 600px 断点可收主栏。

**≥600px**：新增完整断点（原文件只有 900px 横屏一档），全部 rpx 折 px（÷2，含 `border-width`）；主栏 375px 居中。顺带清掉 900px 档里与 600px 档冲突的字号覆盖（16/14px vs 13/11px）。

**偏离项（3 条，待确认）**
1. **tab 只有 3 个**：设计稿是「全部 / 待就诊 / 已完成」，用户要求 5 个（多「就诊中 / 已取消」）。设计稿为准 → 保留 3 个。要加需先确认这两个状态的枚举值。
2. **「取消预约」只弹提示**：`config/api.js` 与 `services/` 里**都没有患者侧取消端点**（只有医生端 `DOCTOR_APPTS_STATUS` 和兼容层 `APPOINT_UPDATE`=501）。按「不伪造成功」降级为 toast「取消预约待后端开放」。
3. **医生职称显示不全**：契约无 `doctorTitle`，实际只会显示「陈医生」，拼不出「· 副主任医师」。

# 8.33 第 14 页 · 我的问诊（`pages/profile/consultations`，2026-10-21）

设计稿：`患者端/C-个人中心/07-我的问诊.png`（1391×3014，1rpx ≈ 1.8547px，逐元素实测）。原实现骨架已接近，本轮按实测重标 + 修三处功能问题。

**实测落值**

| 元素 | 实测 | 落值 |
| --- | --- | --- |
| 页面左右留白 | 52px | 28rpx（卡片间隙 46px → 24rpx） |
| 卡片圆角 | 30px（弧长实测，不是 32rpx） | 16rpx（`--radius-sm`） |
| 卡片内距 | 65/66px | 36rpx（分隔线内缩同缘，实测 117..1276） |
| 标题 | 字宽 85px/字 | `calc(var(--font-title) + 6rpx)` = 46rpx |
| 状态徽章 | 底 243×99px、字宽 56px、圆角 20px | 30rpx / 内距 `8rpx 20rpx` / 圆角 12rpx（**圆角矩形，不是全局 `.badge` 的胶囊**） |
| 日期行 | 字高 46px、间距 74px | `--font-h2`（34rpx）/ 上间距 20rpx |
| 摘要行 | 单行、字宽 57px | `calc(var(--font-body) + 2rpx)` / 上间距 32rpx |
| 分隔线 | 摘要→线 95px、线→字 45rpx、字→卡底 47rpx | `margin-top:45rpx` + `padding:36rpx 0 38rpx` |
| 「查看详情」 | 字宽 66px/字，右对齐 | `--font-h2` + `chevronRight` 图标（20rpx） |
| 卡片总高 | 774px（417rpx） | 离线渲染 206.5px（208.5px 目标，误差 1%） |

**三处功能修正**

1. **状态文案与配色按设计稿改口径**：`ACTIVE → 问诊中`（`--accent-soft` 底 / `--primary` 字）、`CLOSED → 已完成`（`--mint-soft` / `--mint-text`）、`ARCHIVED → 已结束`（`--bg` / `--text-weak`）。原实现是「进行中 / 已结束 / 已归档」，且配色只认中文文案 —— 后端下发枚举时徽章会全部落灰。
2. **日期行改为「日期 + 本地时间」**：设计稿是 `2026-10-15 14:30`，原实现只有 `fmtDate` 的日期。
3. **点卡片进会话页**：原 `onView` 只弹 `showModal`（注释说「无 detail 页路由」），实际 `pages/consult/consult` 早在 `onLoad` 里接 `consultationId` 参数 → 改 `navigateTo`。会话消息未实现时由该页自带的错误态兜底，不伪造对话。

**其他**
- 空态补「去问医生」CTA（`switchTab` 到 AI 问诊，因为它不在普通页栈）+ `chatGray` 图标。
- 徽章配色改为 `tone` 字段在 JS 侧算好（`blue`/`mint`/`gray`），wxml 不再写三元判断；演示数据直接下发中文时按文案兜底。
- 标题兜底链：`title` → `departmentName + '咨询'` → `在线问诊`（契约里 `title` 可空，不编造科室）。
- `json` 导航栏：标题 `我的问诊/咨询` → **`我的问诊`**（设计稿），白底黑字。

**≥600px**：补齐完整断点（原文件 0 个断点），全部 rpx 折 px（÷2），主栏 375px 居中；另加 ≥900px 横屏档（主栏放宽 420px、圆角 12px、字号 +1~2px），两档均 **0 处 rpx 残留**。

**测试同步**：`tools/test-pages-contract.js` 的问诊用例原锁的是旧口径（`ACTIVE→进行中`、`CLOSED→已结束`、日期仅到天）。按设计稿改为 `问诊中 / 已完成` + `日期 时间` 正则，并**新增**一条徽章配色断言（`ACTIVE=blue / CLOSED=mint`）。该文件用例数 37 → 38。

**偏离项（3 条，待确认）**
1. **状态筛选 tab 未做**：设计稿没有 tab（三张卡直接平铺展示三种状态）。要加需确认放在导航栏下方还是吸顶，以及「进行中 / 已完成」是否要带计数（第 13 页有计数角标）。
2. **医生头像 / 姓名 / 科室未上卡**：设计稿卡片只有「科室标题 + 状态 + 时间 + 摘要」。契约 2026-10-19 已追加 `doctorName / doctorTitle / departmentName / accepting`，要加是产品增强项，不是复刻项。
3. **页面底色**：设计稿实测 `#ECF4FF`（比全局 `--bg #F3F8FF` 稍蓝），为守住「唯一色源」仍用 `--bg`，未新增令牌。

# 8.34 第 15 页 · 家庭成员（`pages/profile/family`，2026-10-21）

设计稿：`患者端/C-个人中心/08-家庭成员.png`（1391×3014，1rpx ≈ 1.8547px，逐元素实测）。

**版式整体替换**：原实现是「全局 `.notice-bar` 实心浅蓝条 + 白卡（头像/姓名/称谓/meta）」。设计稿是 **顶部通栏浅蓝渐变带 + 半透明提示面板** → 白卡（头像/姓名/**关系徽章在右上**/年龄段·授权态）→ 卡内**通栏**分隔线 + 左右裸文字操作 → **贴底**描边胶囊按钮 + 授权说明。

**实测落值**

| 元素 | 实测 | 落值 |
| --- | --- | --- |
| 顶部渐变带 | 导航底 346 → 约 760，`#E1F1FF` 渐隐到页底（约 407px） | `linear-gradient(180deg, --accent-soft → --bg)`，`padding 32/28/40rpx` |
| 提示面板 | 695×162rpx；填充≈白 25% 叠在蓝带上 + 1px 亮白描边 | `rgba(255,255,255,.3)` + `1rpx rgba(255,255,255,.85)`，圆角 16rpx，内距 32/36rpx |
| 面板图标 | ink 107×139px（58×75rpx）、图标→文字 66px | 60×72rpx + `margin-left:36rpx` |
| 面板文字 | 行距 87px（lh≈1.57） | `--font-body`（30rpx）/ 1.57 |
| 卡片 | 留白 28rpx、圆角 44px=24rpx、间距 54px=29rpx | 同上（`--radius-md`） |
| 头像 | 250px=135rpx，圆底 (231,243,255)、人形 (218,227,242) | 135rpx；**CSS 人形占位**（`--accent-soft` + `--border`），0 新增素材 |
| 姓名 | 字宽 78px/字 = 42rpx | `calc(var(--font-title) + 2rpx)` |
| 副行 | 30rpx，姓名→副行 53px | `--font-body` / `margin-top:16rpx` |
| 关系徽章 | 168×99px = 91×53rpx，字 28rpx，圆角 20px | 28rpx / `10rpx 18rpx` / 圆角 12rpx（**圆角矩形，非胶囊**） |
| 分隔线 | **通栏**（x 55..1340 = 卡宽），非内缩 | 卡不设横向 padding，操作行自带 `padding:0 40rpx` |
| 操作行 | 214px=115rpx；文字 30rpx/600，左蓝右红 | `min-height:115rpx`（>88rpx 触控线） |
| 添加按钮 | 1227×180px = 662×97rpx，2px 主蓝描边、全胶囊 | `height:97rpx` + `border:2rpx` + `radius:999rpx`，字 34rpx |
| 授权说明 | 24rpx | `--font-caption` / `--text-weak` |

**结构要点**
- **按钮贴底**：设计稿内容只占 2/3 屏，按钮在底部。用 `min-height:100vh` + `flex-column` + `footer { margin-top:auto }` 实现，**不用 fixed**（避免滚动时遮住列表）。
- **头像三层降级**：契约 `avatarUrl`（短期签名 URL）→ `<image binderror>` 回退 → CSS 人形占位。原实现硬编码 `/assets/img/avatar-default.png`（深蓝底白人形，与设计稿的浅蓝灰占位差异明显）。
- **副行兼容**：设计稿是「年龄段 · 授权态」；`ageBand` 缺失时退到 `phoneMasked`（都是后端真实字段，不编造）。
- **授权文案**：`GRANTED → 已授权`（原为「已授权代管」，设计稿是「已授权」），`NONE → 未授权`。
- 「管理健康档案」按真实授权态分文案：已授权 → 说明「成员档案独立视图尚未上线」；未授权 → 说明不能代管。**不做假跳转**（`health-records` 页尚无 `memberId` 入参）。

**添加成员：从「两步系统弹窗」改成真正的表单浮层**
原实现是 `wx.showActionSheet` 选关系 → `wx.showModal({editable})` 输姓名（两次系统弹窗、不能填手机号）。现改为半屏浮层：姓名 + 关系 chips（父亲/母亲/配偶/子女/其他）+ 手机号（选填，11 位校验）+ 提交在途禁用（`loading` + 关闭拦截）。
- **不发契约外字段**：`FamilyMemberCreate` 是 `additionalProperties:false`，只发 `displayName / relation / phone?`。
- **身份证号不采集**：契约无该字段（发了会 400），且违反「最小必要」；浮层里明写「身份证号不在本页采集：成员身份在对方授权时核验」。

**≥600px**：补齐完整断点（原文件只有 5 行零散覆盖），全部 rpx 折 px（÷2，含 `border-width`、`margin-left:-19.5px`）；主栏 375px 居中；**浮层在宽屏收进 375px 主栏**（否则横贯 1200px）。

**测试同步**：`tools/test-pages-contract.js` 的家庭用例原锁「未授权代管 / 已授权代管」，按设计稿改为「未授权 / 已授权」；并**新增 2 条**浮层必填校验断言（空姓名、未选关系，纯前端不触网）→ 用例 38 条变 **40** 条。

**偏离项（4 条，待确认）**
1. **无「编辑」入口**：设计稿操作行只有「管理健康档案 / 移除成员」。契约 `PATCH /family-members/{id}` 已就绪，要加编辑（复用同一浮层 + PATCH）随时可做 —— 但那会变成三项操作，偏离设计稿的左右分列。
2. **卡片不展示手机号**：设计稿副行是「年龄段 · 已授权」；`phoneMasked` 只在 `ageBand` 缺失时兜底。
3. **未采集身份证号**：契约无该字段（会 400）+ 最小必要原则，改为在浮层里明确告知不采集。
4. **提示区图标**：设计稿是「成人 + 儿童」双人定制插画，复用 `icons.users`（0 新增素材），造型略有差异。

# 8.35 第 16 页 · 个人信息（`pages/profile/personal-info`，2026-10-21）

设计稿：`患者端/C-个人中心/09-个人信息.png`（1391×3014，1rpx ≈ 1.8547px，逐元素实测）。

设计稿只有 **三行 + 一句说明**：头像（圆头像 + 箭头）/ 姓名（右值 + 箭头）/ 手机号（「已绑定 138****1234」 + 箭头）。原实现已接近，但行度量、分隔线口径、头像占位与手机号展示都不对。

**实测落值**

| 元素 | 实测 | 落值 |
| --- | --- | --- |
| 卡片边距 / 圆角 | 43px / 约 30px | 24rpx / **16rpx**（`--radius-sm`，比前几页的 24rpx 更小） |
| 导航底 → 卡片 | 53px | 28rpx |
| 头像行 / 普通行 | 264px / 206~211px | **142rpx** / **112rpx** |
| 行内距 | 55px（标签墨迹左缘 98 = 卡左 43 + 55） | 30rpx |
| 标签 | 55px/字，粗体 | 30rpx / 600 |
| 姓名值 | 53px/字 | 30rpx |
| 手机号值 | 48px/字 | 26rpx（`--font-caption + 2rpx`） |
| 分隔线 | **左侧内缩 30rpx、右侧通到卡片边缘**（x 98..1346 / 卡宽 43..1348） | `::before` + `left:30rpx; right:0` |
| 箭头 | ink 22×42px，值→箭头 43px，右缘距卡右 29rpx | 24rpx 图标 / `margin-left:22rpx` |
| 头像 | 170px = 92rpx 圆 | 92rpx |
| 卡下说明 | 29 字单行占 1174px = 317px@375 | **22rpx**（`--font-caption - 2rpx`），上间距 36rpx |

**四个实质修正**

1. **手机号改为展示真实脱敏号**：契约 `User.maskedPhone`（F8 就是给这一页用的）此前完全没读，只显示「已绑定」。现在 `已绑定`（`--text-weak`）+ `138****1234`（`--text-sub`）两段并排，与设计稿一致。
2. **分隔线口径**：原用 `border-bottom`（左右都到边）。设计稿是 iOS 分组列表口径 —— **左侧内缩、右侧到卡片边缘**，改用 `::before` 绝对定位（顺便避开微信 `button::after` 默认边框互踩）。
3. **头像占位**：原用 `avatar-default.png`（深蓝底白人形）。改三层降级：`avatarUrl` → `binderror` → CSS 人形（`--accent-soft` 圆底 + `--border` 人形）。
4. **姓名行行尾补箭头**：设计稿每行右端都有箭头。`input type="nickname"` 保留微信昵称快填，箭头 `bindtap` 把 `focus` 置真以聚焦输入框。
   ⚠️ 连带修了一个**真 bug**：新增 `onNameInput` 后，`onNameBlur` 里的「值没变就不保存」判断会因为 data 已经被输入过程改写而永远成立 → **姓名永远存不下去**。改为与 `this._savedName`（上次保存成功值）比较。

**保留设计稿外的两块（重要）**：`联系与住址`（邮箱/住宅/户籍）与 `身份与医保`（实名/医保绑定）是 V8 已上线能力，删掉属功能回退 → **保留**，但统一到同一套卡片度量（24rpx 边距 / 16rpx 圆角 / 30rpx 行内距 / 内缩分隔线），视觉上与设计稿同族。

**≥600px**：补齐完整断点（原文件只有 5 行零散覆盖），全部 rpx 折 px（÷2，含 `::before` 的 `left/height`、`margin-left:-13.5px` 半像素值）；主栏 375px 居中。

**验证**：`check-project` 全通过（63 js / 36 json / 156 图标引用 / 无重复全局类 / 禁址无命中）· `test-pages-contract` 40/40（本页暂无契约用例）· 离线渲染 375×812：卡片 183px（设计稿 185.2px）、三行 70/55/56px（71.2/55.5/56.9px）均在 1% 内；说明文字单行不换行。

**偏离项（2 条，待确认）**
1. **多出两块内容**：设计稿只有三行；`联系与住址`、`身份与医保` 为保留的既有能力。若要严格一致，需要把这两块迁到独立页（当前无路由）。
2. **姓名不是「点击跳转」而是原地编辑**：设计稿箭头语义像跳页，但改名只是单字段，且 `type="nickname"` 是微信官方快填能力，跳页会丢掉它 → 保留原地输入 + 箭头聚焦。

# 8.36 第 17 页 · 系统设置（`pages/profile/settings`，2026-10-21）

设计稿：`患者端/C-个人中心/10-系统设置.png`（1391×3014，1rpx ≈ 1.8547px，逐元素实测）。

设计稿是 iOS 分组列表口径：**白卡 + 灰标题（无灰底）+ 细分隔线**，三张卡（服务状态 / 通用设置 / 关于与隐私）+ 卡外居中红字「账号注销」。

**实测落值**

| 元素 | 实测 | 落值 |
| --- | --- | --- |
| 页面边距 / 卡片间隙 | 44px / 35px | 24rpx / 20rpx |
| 卡片圆角 | 弧 22px | **12rpx**（比全站 32rpx 明显更方） |
| 卡片内距 | 53px（标签墨迹左缘 97 = 卡左 44 + 53） | 28rpx |
| 分组标题 | 高 133px、字 50px/字 | 72rpx / 28rpx（`--font-caption + 4rpx`） |
| 分组标题分隔线 | **通栏**（x 46..1345 = 整卡宽） | `margin:0 -28rpx` + `border-bottom` |
| 行高 | 148~152px | 80rpx → **按 88rpx 触控线取 88rpx**（见偏离项 1） |
| 行分隔线 | **左侧内缩 50px、右侧到卡片边缘** | `::before` + `left:0; right:-28rpx` |
| 行标签 | 55px/字 | 30rpx / 500 |
| 行右值 / 辅助文案 | 52px / 51px | 28rpx / 28rpx（值蓝、文案灰） |
| 箭头 | ink 22×38px，右缘距卡右 55px | 36rpx 图标（PNG 内 ink 恰为 12×20rpx）+ `margin-right:-10rpx` |
| 开关 | 145×80px | 原生 switch `scale(.8)`（右缘对齐 28rpx 内距） |
| 状态点 / 状态字 | 28px / 48px/字 | 15rpx / 26rpx（点↔字间距 15rpx） |
| 账号注销 | 54px/字，卡下 86px 起 | 30rpx / 600 / `--accent-red`，`margin-top:24rpx` + 88rpx 行高 |

**结构要点**

1. **不复用全局 `.card` / `.row` / `.group-head`**：本页圆角 12rpx（全局 32rpx）、标题无灰底（全局 `.group-head` 是 #F7F9FC 色带）、行内距 28rpx（全局 32rpx）。复用会静默覆盖全局值（`check-project ④` 守这条）→ 全部自建 `st-*`。
2. **服务状态四态**：设计稿出现「在线 / 未知 / 检查中 / 离线」。映射为 `reachable=true→在线`、`false→离线`、字段缺失→未知、首次探针未回→检查中、网关自报 `degraded`→检查中。文字色走 `--mint-text / --amber-text / --text-weak`（`--accent-green #00B42A` 与 `--accent-amber #FF8C00` 在白底仅 2.8:1 / 2.2:1，只配给圆点）。
3. **字号三档「选中高亮」**：设计稿只给了「字号模式 → 标准 ›」一行，原生 `showActionSheet` 标不出当前档 → 改为**半屏浮层**，三档各带字号预览（30/36/44rpx）与勾选（`icons.check`），选中标签转主蓝。
4. **高对比度真落地**：`.high-contrast` 令牌此前全仓**只定义、从未挂到任何根节点**。本页读写 `wb_high_contrast` 并挂到页面根节点 → 至少本页的对比度开关是真生效的（其余页仍待统一，见偏离项 3）。

**顺手修掉的两个坑**
- **清缓存会连无障碍偏好一起清掉**：`onClearCache` 原来只抢救登录态 / 主题 / 朗读偏好，现在补 `wb_high_contrast`。
- **删死代码 `onFeedback`**（wxml 从未引用）。

**补设计稿外一行**：`退出登录`（单行卡，居中）。理由：设计稿只有「账号注销」，但**患者端全仓没有退出入口** —— `pages/profile/profile.js` 有 `onLogout` 实现却从未挂到 wxml，等于死链。`app.logout()` 已实现，接上即可（`reLaunch` 回登录页）。

**≥600px**：补齐完整断点，全部 rpx 折 px（÷2，含 `::before` 的 `right:-14px`、`margin-right:-5px`）；断点内字号令牌已是 px，故 `calc(var(--font-*) + Nrpx)` 一律改写为 `+ Npx`（混单位会整条失效）。

**验证**：`check-project` 全通过（63 js / 36 json / 157 图标引用 / 无重复全局类 / 禁址无命中）· `test-pages-contract` 40/40（本页暂无契约用例）· 离线渲染：卡片 x 12..362.5（设计稿 11.9..362.9）、行标签左缘 26.5（26.3）、状态字右缘 348.5（349）、行右值右缘 333.5（333.7）。

**偏离项（4 条，待确认）**
1. **行高 88rpx 而非实测 80rpx**：13 个可点行按 80rpx 只有 40px，低于「触控目标 ≥ 88rpx」硬约束 → 统一上浮 8rpx（三张卡合计 +104rpx）。
2. **服务状态只有 3 行**：设计稿是「统一网关 + 服务一~四」5 行占位名。真实上游只有 `python`（AI 问诊/语音）与 `java`（挂号/医生）→ 保留真实名，不编造「服务三/四」。
3. **高对比度只在设置页生效**：`.high-contrast` 需逐页挂根节点，全仓统一属跨页改造，本轮未做。
4. **通知设置（消息通知/预约提醒/科普推送）与「退出登录」以外的项未加**：设计稿无通知三类开关，且订阅消息需后端下发模板 ID（`requestSubscribeMessage` 全仓 0 处）→ 不伪造开关。

# 8.37 第 18 页 · 在线问诊会话（`pages/consult`，2026-10-21）

设计稿：`患者端/04-在线问诊.png`（1391×3014，1rpx ≈ 1.8547px，逐元素实测）。
⚠️ 这是**医患对话页**，不是 TabBar 入口 `pages/consultation`（第 4 页）。

设计稿口径：自绘导航（返回 + 居中标题，右侧胶囊由微信自绘）→ 医生信息卡（头像 / 姓名 + 职称胶囊 / 科室 · 互联网医院 / 右上接诊态 / 分隔线 / 等待提示）→ 对话流（日期分隔 · 系统胶囊 · 右蓝气泡 + 已发送 · 左白气泡 · 文件卡 · 正在输入）→「本次问诊」摘要卡 → 底部输入栏（＋ / 输入框 / 语音 / 发送）。

**实测落值**

| 元素 | 实测 | 落值 |
| --- | --- | --- |
| 导航栏 / 标题 | 内容中心 y≈124rpx，标题墨迹 131×30.7 | 88rpx 栏高 + 34rpx/700 + 绝对居中 |
| 返回箭头 | 墨迹 19×33，左缘 25.9 | 56rpx 盒（PNG ink 31×54/96 → 18×31.5）+ 热区 88rpx |
| 医生卡 | x 24.8~725、y 198~447（高 249） | 圆角 32rpx、内距 28/30、`margin-top:22rpx` |
| 头像 | 直径 104，左缘 54 | 104rpx 圆 + `--accent-soft` 底 + `icons.user` 56rpx |
| 姓名 / 职称胶囊 | 墨迹高 35 / 胶囊 122×34 | 40rpx/700 · 24rpx 蓝字 + 高 34 + 圆角 8 |
| 接诊态 | 绿点 14 + 字，右上 | 绝对定位 `top:4rpx`，文字 `--mint-text`、点 `--mint` |
| 分隔线 / 等待提示行 | y=357 / 357~447 | `margin:26rpx -4rpx 0` / 内距 22+26，转圈 28rpx CSS 环 |
| 日期分隔 | 文字 491~511，两侧短线 56 | 22rpx 灰字 + `56×1rpx` 线 + 上下 40/24 |
| 系统提示胶囊 | 宽约 480（按内容收缩） | `display:table` + `margin:auto` + `--accent-soft` |
| 用户气泡 | 532×112、右缘 725、圆角 24 | `max-width:76%`、内距 20/24、32rpx/1.5、右下 8rpx + 尾巴 |
| 已发送 | 右端 700，字 22 | `padding-right:22rpx`，`--text-weak` |
| 文件卡 | 415×140、图标底 76 | `width:415rpx` + 内距 30 + 圆角 24 + 76rpx 图标底板 |
| 摘要卡 | 1117~1440（高 323）、标题行 83 | 标题内距 24/24、行高 69（内距 10）、卡底 34 |
| 摘要列宽 | value 统一从 280 起 | label 固定 224rpx |
| 输入栏 | 高 144（含 60 安全区）、控件 64 | 内距 20/24 + `env(safe-area-inset-bottom)` |
| ＋ / 语音 | 圆 50，热区需 88 | 视觉 50 + `::after` 外扩 19rpx |
| 发送 | 123×64 蓝底白字 | `min-width:116rpx` / 高 64 / 圆角 999 / 28rpx 600 |

**结构要点**

1. **导航改自绘**（`navigationStyle:custom`）：设计稿导航栏左侧是品牌蓝返回箭头，原生导航栏只能给灰色系统箭头；标题绝对定位居中，右侧胶囊由微信渲染、不重复画。
2. **数据入口换成详情端点**：新增 `CONSULTATION_DETAIL`（`GET /api/v1/consultations/{id}`，契约 `getConsultation`，Java 控制器已实现）→ 一次拿到医生卡四字段 + 消息；该端点 501/网络异常时回退「列表 + 消息」两条老通道，**404 直接报错**（会话不存在/越权，不能拿列表里的别的会话顶替）。
3. **修掉三个历史缺陷**：
   · `IMAGE_NOTE` 消息原来**把 objectKey 当气泡正文渲染**（界面上直接出现 `attachments/2026/10/xxx.pdf`）→ 改为只渲染文件卡；
   · `onVoice` 在 wxml 里绑了但 js **从未实现**（死按钮）→ 补齐录音 + ASR 转写回填（与第 4 页同一套 `speechService` 交互）；
   · 页面靠原生导航栏，无自定义标题栏 → 按设计稿补自绘导航 + 系统状态栏让位。
4. **「正在输入…」只在真有生成任务时出现**：发送成功后以「自己这条落库后的条数」为基准轮询消息（4s×12≈48s），涨一条即停；不是常驻装饰。
5. **处方/检查建议卡**：`message.structured` 存在且条目非空才渲染（`kind:PRESCRIPTION|EXAM`），无条目 → 回落普通气泡，不做关键词猜测（契约暂无该字段，见偏离项 2）。
6. **发送失败回填原文**：网络失败时把用户刚敲的内容写回输入框，不让人重打一遍。

**≥600px**：整段折 px（÷2），含伪元素 `right:-4px / width:9px` 与 `border-width:1px`；断点内 69 个含 rpx 选择器逐个重声明（脚本核对 0 遗漏、0 残留 rpx）。

**验证**：`check-project` 全通过 · `test-pages-contract` **56/56**（新增 16 条问诊室用例：医生字段映射 / 日期分隔只插 1 条 / IMAGE_NOTE 不泄 objectKey / 结构化卡 / 剩余时间缺失不渲染 / 详情 501 回退）· 离线渲染对齐（渲染↔设计稿）：卡片 202~437↔198~447、气泡 193~733↔199.5~732.7、文件卡 311~725/高 138↔308.4~723.6/高 140、摘要卡高 322↔323、输入栏顶 1509↔1476（差值为预览无安全区）。

**偏离项（5 条，待确认）**
1. **医生卡内容目前是占位**：契约已加 `doctorName/doctorTitle/departmentName/accepting`（2026-10-19），但后端 `ConsultationData` DTO 与 SQL 未跟 → 真机显示「接诊医生 / 互联网医院 / 待接诊」。页面已按契约接线，后端补 DTO 即自动生效（不伪造「陈医生」）。
2. **处方/检查建议卡是前瞻实现**：契约 `Message.contentType` 只有 TEXT / VOICE_TRANSCRIPT / IMAGE_NOTE / SAFETY_NOTICE，没有结构化回复类型 → 页面只在服务端下发 `message.structured` 时渲染，否则永远不出现空卡片。要正式上线需扩契约。
3. **「剩余时间」默认不显示**：设计稿「问诊剩余29分钟」需要服务端给 `remainingMinutes` / `expiresAt`，契约没有 → 页面不按 `createdAt` 自己推算倒计时（会算错），字段到位即出。
4. **表情按钮未做**：设计稿输入框右侧有笑脸键（表情面板），小程序无系统表情面板 API，自绘面板属新组件 → 本轮留空，输入框相应加宽约 80rpx。
5. **中性灰底用品牌浅蓝代替**：设计稿系统提示胶囊 `#EEF2F8`、输入框 `#EEF2F9` 是中性灰；页面零字面色值约束下统一取 `--accent-soft`（色相偏蓝），与全站色板一致。

# 8.38 第 19 页 · 医生端挂号管理（`pages/doctor/appointments`，2026-10-21）

**设计稿**：`医生端/E-医生端/13-挂号管理.png`（1391×3014，1rpx ≈ 1.8547px，逐元素 PIL 实测）。

**版式**：自绘导航（返回 + 居中「挂号管理」，右侧胶囊由微信自绘）→ 概览/筛选卡（四列：待就诊 / 就诊中 / 已完成 / 今日总数）→ 患者卡（大号候诊序号 + 右上状态徽章 → 姓名 → 就诊时间 → 内缩分隔线 → 右下动作按钮）。

**改了什么**
- 四文件重写（`appointments.wxml/wxss/js/json`），导航改 `navigationStyle:custom`（设计稿返回箭头是品牌蓝，原生只给灰箭头）。
- **概览四列即筛选**：点「待就诊」只看候诊、点「今日总数」回全量；统计与列表**同源**（都按契约枚举 `rawStatus` 分组），保证「点某列看到的条数 = 该列显示的数字」。
- **展示顺序按状态分组**：服务端是 `ORDER BY s.start_time ASC`（纯时间序），会把「已完成」插在中间；页面只改展示顺序（待就诊 → 就诊中 → 终态，同组按时间），不动数据。
- **队列序号**：契约只有 `queueNumber`（整数），设计稿的「A015」里 A 是诊室前缀、契约无此字段 → 不猜字母，只补足 3 位（015），无号显示「—」。
- **状态流转**（叫号 / 完成就诊）：乐观更新 + 失败回滚；幂等键按 `(预约, 目标状态, 版本)` 生成；409 区分 `VERSION_CONFLICT`（提示并刷新）与 `IDEMPOTENCY_KEY_REUSE`；`_submitting` 防连点。
- **拉当日队列必须带 `date=`**：不传时第四列「今日总数」其实是「全部」，数字与标题对不上。

**修掉的历史缺陷**
1. `rawStatus` 曾被执行态 `status`（中文）覆盖 → 统计前三列恒为 0，只有「今日总数」对；现按契约枚举分组。
2. 旧的 `/api/appoint/list`、`/api/appoint/updateStatus` 是网关 compat pending（501），缺版本号/幂等头 → 改走契约端点 `/api/v1/doctor/appointments` 与 `…/{id}/status`。
3. 医生端口径不复用患者端 `apt-status.js`：患者端要区分「待确认/待就诊」（PENDING/CONFIRMED），医生队列设计稿只有三档徽章 → 本页做展示层归并（PENDING+CONFIRMED → 待就诊蓝），**不改 `rawStatus`**。

**实测落值（rpx）**：卡边距 24.8 / 圆角 24 / 卡内距 36 / 概览卡 194~382 / 患者卡 406~782（高 375）/ 序号 40rpx·700 / 姓名 30rpx·600 / 时间 28rpx / 徽章 117×48（圆角 12）/ 动作按钮 116×50 / 分隔线内缩 35。

**≥600px**：整段折 px（÷2）；脚本核对「基础 17 个含 rpx 选择器 → 断点 17 个重声明、0 遗漏、0 残留 rpx」。

**验证**：`check-project` 全通过 · `test-pages-contract` **69/69**（新增 13 条医生队列用例）· 离线渲染对照（渲染↔设计稿）：序号 66~162↔66.9~157.4、徽章 600~739/410~469↔599.6~739.2/409.8~469.1、按钮 600~689/690~739↔599.6~688.5/696.6~746.8、患者卡 404~773↔407~780。

**偏离项（4 条，待确认）**
1. **概览四列做成了可点筛选**：设计稿是纯静态数字，无筛选控件。本轮让四列可点（点列即筛），选中态只换文字色、不加额外控件。若要严格还原静态，需撤掉 `bindtap`。
2. **患者手机号与头像不渲染**：设计稿有「王** 138****1234」与头像，契约 `Appointment` 为 `additionalProperties:false`（只有 patientName/queueNumber/startTime/status 等）→ 不本地拼假号、不画假头像。
3. **「签到」与「叫号」合并为一个「叫号」**：契约状态机没有独立的 CHECKED_IN 之外的签到态，`PENDING/CONFIRMED → CHECKED_IN` 即「签到+叫号」一步到位。
4. **日期切换未做**：设计稿导航栏右侧是微信胶囊，无日期控件；后端已支持 `date` 参数，本页固定拉当日。要加日期选择器需先出交互稿。

# 8.39 第 20 页 · 适老化首页（`theme-large` / `theme-xlarge`，2026-10-21）

按 `design-output/患者端/08-适老化首页.png`（1391×3014）重做 home 页大字档，**标准档不受影响**。

**结构（单列，自上而下）**：问候「您好」→ 副问候「今天感觉怎么样？」→ 症状卡（44rpx 标题 + 144rpx 浅蓝输入区 + 发送/语音输入双按钮）→ 2×2 线性宫格 → 「紧急情况请拨打120」提示条。

**实测落值**：问候 72rpx·700 / 副问候 34rpx / 卡标题 44rpx / 输入区 144rpx（内距 32rpx、占位字贴顶）/ 按钮高 88rpx·字 36rpx（等宽 flex:1、间距 32rpx）/ 宫格图标 96rpx（去底板、透明）/ 标签 34rpx / 提示条 28rpx 内距 + 44rpx 图标 + 36rpx 文字；`theme-xlarge` 各值再放一档（变量 override，不新增结构分支）。

**实现要点**
1. **问候文案按档分支**（`home.js`）：大字档固定「您好 / 今天感觉怎么样？」（页面静态文案，不伪造后端 `greeting`）；标准档仍是「姓名，您好！」+ 后端 `greeting`（空则不占位）。
2. 08 稿底色是均匀浅蓝（≈#EDF5FF）→ 白底 + `rgba(11,110,248,0.06)` 叠加，不引入新色值。
3. 提示条图标新增 `alert_amber.png`（`tools/build-icon-colors.py` 重着色 #FBA036）+ `icons.alertAmber`。
4. 平板：大字档强制单列 720px 居中（横屏也不排双栏）；所有 rpx 尺寸在 ≥600px 折 px。

**偏离项（3 条）**
1. 设计稿按钮高 148px≈80rpx；按 `--btn-height` 令牌落地 88rpx（手机）/ 108rpx（large 平板），满足 ≥88rpx 触控。
2. 宫格行距实测 35px≈19rpx，取 20rpx；图表间距 43px≈23rpx，取 24rpx。
3. 提示条实测高 216px≈116rpx；按 28rpx 内距 + 36rpx×1.5 行高算出 ≈112rpx。

**验证**：`check-project` 全通过 · `check-styles` OK · `test-pages-contract` **69/69** · `node --check home.js` 通过。

# 8.40 第 21 页 · 医生端床位管理（`pages/doctor/beds`，2026-10-21）

按 `design-output/医生端/E-医生端/14-床位管理.png`（1391×3014，1rpx ≈ 1.8547px）重做，口径＝**设计稿 + 增强**（统计条与病区筛选取自用户确认）。

**结构**：自定义导航（返回 + 居中「床位管理」）→ 四列统计（总床位/占用/空闲/待消毒）→ 病区横滑筛选（仅 ≥2 个病区出现）→ 图例（空闲绿/占用蓝/维修灰，出现待消毒或已预留时再追加）→ 2 列床位卡（空闲白底绿描边+安排入住；占用 168rpx 蓝带渐变+患者脱敏名；待消毒浅橙；维修中中性灰；已预留整卡浅蓝渐变）。

**实测落值**：页边距 24rpx / 卡宽 340rpx / 列间距 24rpx / 卡高 404rpx / 圆角 24rpx / 床号 48rpx·700 / 状态 36rpx·600 / 患者名 32rpx / 图例圆点 24rpx·文字 32rpx·组间距 88rpx（整组居中）/ 占用蓝带 168rpx。蓝带用 `rgba(11,110,248,0.86→0.56)` 叠加白底实现，零新色值。

**实现要点**
1. 状态映射集中在 `BED_META`（AVAILABLE/OCCUPIED/RESERVED/CLEANING/OUT_OF_SERVICE → 中文+配色+可否入住），模板不写英文判断；未识别枚举落「维修中」中性展示。
2. 数据走 `services/doctor.js#listBeds`（GET /api/v1/beds）；入住走 `assignBed`（ASSIGN + `expectedVersion` 乐观锁 + 抽屉级幂等键）；409/版本冲突 → 提示「状态已变化」并刷新，不在前端猜新状态。
3. 契约 `Bed` 只有 `label`（无 bedNo），映射里 `bedNo || label` 兼容；患者只取 `occupantDisplayName`，缺失不渲染。
4. 病区名/床位号缺失一律不补假值。
5. 平板断点：所有含 rpx 的选择器（含卡高 404→202px、蓝带 168→84px）逐条折 px。

**偏离项（4 条）**
1. 「安排入住」设计实测 95px≈51rpx，按 ≥88rpx 触控下限落地 88rpx。
2. 设计稿 105 床（空闲）无按钮、106 床「维修\*\*」用蓝底 —— 判定为设计稿自相矛盾：所有 AVAILABLE 统一带按钮；维修中按图例用中性灰，蓝底给 RESERVED。
3. 统计条与病区筛选是增强项（设计稿无），单病区时筛选不出现。
4. 统计「占用」含 OCCUPIED + RESERVED（均不可再分配）；「维修中」不入四列，四项之和可能小于总床位。

**验证**：`check-project` 全通过 · `check-styles` STYLES_OK · `test-pages-contract` **69/69** · `node --check beds.js` 通过。

# 8.41 第 22 页 · 医生端个人管理（`pages/doctor/personal`，2026-10-21）

按 `design-output/医生端/E-医生端/15-医生个人管理.png`（1391×3014）重做。

**结构**：自绘导航（白底 + 蓝色返回 + 居中「个人管理」）→ 浅蓝渐变医生卡（112rpx 头像 + 姓名/职称同行 + 科室 + 脱敏手机）→ 账号管理分组（排班设置 / 账号安全 / 消息通知）→ 版本号 → 退出登录。

**实测落值**：页边距 50px≈27rpx（落 24rpx）/ 卡高 520px=280rpx / 头像 196px≈106rpx（落 112rpx）/ 姓名字形 84px→48rpx·700 / 职称 30rpx / 科室 32rpx / 手机 28rpx / 分组头 146px=79rpx / 行高 220px=119rpx（落 116rpx）/ 行图标 44rpx / 分隔线左缩进 57px≈31rpx（与 32rpx 卡内距对齐）/ 导航 88rpx + 标题 34rpx。

**实现要点**
1. `personal.json` 改 `navigationStyle: custom`：原实现是系统导航蓝底白字，与设计稿「白底 + 蓝箭头 + 深色居中标题」不符。
2. 数据接 `GET /api/v1/me`（`services/user.js#getMe`）：姓名/头像/`maskedPhone` 以服务端为准；登录态只作首屏兜底，避免请求期间空卡。手机号只用 `maskedPhone`，明文不落前端。
3. 科室/职称**无接口下发**（`User` 契约 additionalProperties:false，不含 departmentName/title）→ 有值才渲染，不编造；已在遗留清单登记需要的后端能力。
4. 三个入口均为占位（无对应页面），统一 toast「待接入」，与既有约定一致。
5. 退出登录为设计稿外新增（需求要求，且是医生端唯一退出路径），做成白底红字全宽按钮。

**与需求清单的差异（已与用户确认）**
1. 标题用设计稿「个人管理」，不是「个人中心」。
2. 功能列表用设计稿 3 项（排班设置/账号安全/消息通知），不改成需求的 4 项；「个人资料」由上方医生卡承载。
3. 「隐私设置」归入「账号安全」，不单独成行。

**验证**：`node --check personal.js` 通过 · `check-project` 全通过（63 JS / 36 JSON / 158 处图标 / 禁址零命中）· `check-styles` STYLES_OK · `test-pages-contract` **69/69**。

# 8.42 第 23 页 · 音色管理（`pages/profile/voice-settings`，2026-10-21）

按 `design-output/患者端/C-个人中心/11-音色管理.png`（1391×3014）重做；数据改为**纯本地存储**（用户需求口径）。

**设计稿实测**（1391px = 750rpx，1rpx ≈ 1.8547px）：页边距 43px≈23rpx（落 24rpx）/ 导航条 163px→88rpx / 导航标题字高 63px（≈18.3px）/ 当前音色卡 393..775 × 43..1348（高 382px→206rpx，蓝边 6px→3rpx，圆角 30px→16rpx）/ 卡内图标墨迹 126×145px / 名称 40rpx·700 / 副标题字高 46px（≈13px）/ 当前卡试听胶囊 237×92px→128×50rpx / 区块标题「可选音色」字高 59px（≈17px）/ 列表卡 1012..2031，三行各约 336px→181rpx、分割线 2px→1rpx / 行名称字高 63px（≈18.3px）/ 行描述字高 44px（≈12.8px）/ 列表胶囊 214×84px→115×46rpx。

**改动**
1. `voice-settings.wxml`：导航 + 当前音色蓝边卡（声波图标 / 名称 / 「当前默认音色」/ 试听）+「可选音色」列表（图标 + 名称 + 描述 + 试听 + 设为默认 / 删除 + 选中态）+ 语速调节 + 保存 + 待保存提示 + 「恢复默认音色列表」。
2. `voice-settings.wxss`：按实测重写；卡片圆角 / 边框 / 胶囊尺寸逐项对齐；≥600px 段全部折 px（÷2）并加 `max-width: 375px; margin: 0 auto`（同 `family` / `records` 口径，导航条内容同步居中）。
3. `voice-settings.js`：去掉 loading / error / 重试（本地读取同步完成）；新增 `pending` 选中态、`_refresh()` 统一重建列表、语速三档 0.8 / 1.0 / 1.2。
4. `voice-settings.json`：移除已不用的 `skeleton` 组件登记。
5. `services/voice.js`：**整支重写为本地版**（新增 `catalog()` / `save()` / `remove()` / `restore()`；保留 `list()` 的 `groups` + `current` 形状，`pages/profile/settings.js` 的「音色」行不用改）。

**为什么改本地（有据）**：契约虽有 `/api/v1/voice/voices…`（`contracts/business-openapi.yaml:1844`），但 `backend/business-service` 全目录 grep `voice` **零命中**，`edge-gateway` 只把 `/api/gw/voices` 转发给业务服务（`main.py:207`）→ 旧的远端实现对任何环境都必然失败，页面只能渲染「音色列表加载失败」。音色目录因此内置为常量（四个音色全部取自设计稿），选中音色 / 语速 / 删除记录落 `wb_voice` / `wb_voice_rate` / `wb_voice_hidden`。⚠️ 与《UIUX 说明书 V4》§8.17「列表内容来自服务端」冲突，已记入遗留清单，后端就绪后只需把 `catalog()` 换回远端。

**相对需求的三处取舍**
1. 列表含「当前音色」一行（设计稿只有非当前的 3 行）—— 为满足「每个音色卡片含选中态」；要 1:1 只需一行 filter。
2. 每行加 44rpx 音色图标（设计稿列表无图标）—— 为满足「每张卡含预览图/图标」，代价是行内名称左沿由 32rpx 推到约 92rpx。
3. 「设为默认」（即时）与「保存」（选中 + 语速）两条生效路径并存 —— 设计稿只有前者、需求要求后者；已在遗留清单请产品二选一。

**试听**：无 `previews` 实现、包内无可分发音频 → 走 `services/speech.js#speak()` 合成固定示例句（`/api/v1/voice/tts`），语速用当前档位（改完语速能立刻听出差别）；语音服务不可用时只提示「暂时无法试听」，不伪造音频。

**验证**：`check-project` 全通过（63 JS / 36 JSON / 159 处图标 / 无重复类 / 禁址零命中）· `check-styles` STYLES_OK · 新增 `tools/test-voice-local.js` **25/25** · 无头 Chrome 手机 375×812 与平板 834×1112 渲染核对（图存 `tools/_voice_settings_phone.png` / `_voice_settings_pad.png`；手机档卡左沿 12px、名称左沿 94.5px，设计稿折算 11.6px / 93.0px）。

# 8.39 医生工作台联调三问题修复（挂号口径 / 问诊同步 / 伪造消息，2026-10-24）

**反馈**：① 首页待就诊=6 但挂号管理=0、看不到挂号人员；② 在线问诊没有患者端聊天界面、无法同步；③ 消息中心显示患者端没发送的「胃疼反酸询问」。

**根因与修复（均已 API 实测）**：

1. **首页 6 vs 挂号管理 0**：两页口径不一致（首页曾拉全量历史、挂号管理只统计当日），且患者挂的号是**明天 10-25**（ap-77ba83c9… 已写库），当日过滤导致医生今天看不到。→ 两页统一为「今天及未来」口径（不带 date 拉全量 + 前端按 `startTime >= 今日 00:00` 过滤），挂号管理第四列「今日总数」改「全部」。
2. **在线问诊无聊天/不同步**：医生端 consult.js 本有 LIST/CHAT 双模式，但 CHAT 无新消息轮询；列表按后端 created_at ASC（旧在前）。→ 新增 4s 轮询（条数变化才刷新，onHide 停/onShow 续），列表按 lastMessageAt 倒序；工作台「在线问诊待回复」由误用的患者端 `listMyConsultations()` 改为医生端 `listConsultations()` 并只数 `assignedDoctorId` 非空 ACTIVE。
3. **「胃疼反酸询问」**：V9004/V9006 种子的伪造链（cons-dev-001 + cmsg-dev-001 + msg-doc-apply-001/msg-dev-001/002，2026-10-20 时间戳），患者端从未发送；张三真实会话 cn-a1c6e6ae… 的标题/首两条消息为乱码（直接 API 中文完好，损坏疑似在开发者工具/隧道段，未定位）。→ 已删伪造链与乱码消息、title 改「在线问诊」；备份 `.backup/2026-10-24_dev_seed_cleanup_backup.sql`；新增 `V9009__cleanup_fake_seed.sql` 防止新库重建。

**验证**：node --check × 3 + `tools/check-project.js` 全通过；API 实测医生会话列表 7 条（无 cons-dev-001）、cn-a1c6e6ae 标题在线问诊/消息 0 条、医生消息中心仅剩真实 CONSULT_APPLY、患者消息中心仅剩真实挂号成功消息、预约列表含张三 PENDING 10-25 ✓。

**遗留**：乱码根因需真机复现；后端 listByDoctor 排序仍 created_at ASC（前端已纠正）；三处前端改动仅 node --check 未真机渲染验证。

# 8.44 结束问诊 + 输入法只顶输入栏（2026-10-24）

**反馈**：① 在线问诊没有「结束」按钮，医生处理完无法收口；② 点输入框时整页被顶上去（自绘导航、患者卡一起走），应只上移输入框。

## 8.44.1 结束问诊（医生工作站）

- 新增 `POST /api/v1/doctor/consultations/{id}/close`（`Idempotency-Key` 必填，与 accept 同口径）：
  `consultations.status` → `CLOSED` + 写一条 `system_notice`「医生已结束本次问诊，祝您早日康复…」+ 患者消息中心通知。
  不存在/非本人 → 404（不泄露存在性）；已结束 → 409 `CONSULTATION_CLOSED`；缺幂等键 → 400。
- **写入收口**：新增 `requireWritable(row)`（ACTIVE 才可写），挂在 `send` / `confirm` / `saveTranscriptDraft` / `recommendDepartment` 上。
  收口前只有归属校验，医生结束后患者仍能继续发消息（消息落进一个医生列表已看不到的会话里）。
- 医生端会话页导航右上「结束」→ `wx.showModal` 二次确认（「确定结束」红字 / 「继续问诊」取消）→
  成功后锁输入、停轮询、拉一次消息显示服务端写入的系统提示，并在本地把状态切成「已结束」；409 视为已结束（幂等），404 提示「不属于您」。
- 患者端：`Consultation.status=CLOSED` → 医生卡「已结束」灰标、提示行不转圈、底部输入栏换成只读条「本次问诊已结束」；
  发送被 409 拒绝时同样切终态并停轮询。已结束会话不再出现在医生待处理列表（`listByDoctor` 只查 ACTIVE）。
- **连带修复**：`CatalogRepository.findDoctorUserId` 在医生 `user_id IS NULL`（未绑定账号）时
  因 `stream().findFirst()` 的 `Optional.of(null)` 抛 NPE → 指定该医生发起问诊返回 500；现过滤 null，稳定返回 404 `DOCTOR_NOT_FOUND`。

## 8.44.2 输入法适配（两页一致）

- `input` 一律 `adjust-position="{{false}}"`：不再让微信把整页顶上去。
- 键盘高度取自 `bindfocus` / `bindkeyboardheightchange` 的 `e.detail.height`（px）→ `data.kbHeight`：
  - 医生端 `pages/doctor/consult`：`.dc-page` 内联 `padding-bottom: {{kbHeight}}px`（`height:100vh` + `box-sizing:border-box`）→ 内容区变矮、输入栏上移、导航与患者卡原地不动；
  - 患者端 `pages/consult`：`.cs-bar`（`position:fixed`）`transform: translateY(-{{kbHeight}}px)`，页面尾部加等高 `.cs-kb-spacer` 占位，最后一条消息仍能滚到输入栏上方；键盘态下 `.cs-bar-kb` 去掉 safe-area 内边距（否则输入栏与键盘间多 34px 空隙）。
- `bindblur` 归零；键盘变化后自动滚到底（医生端 `scroll-into-view`、患者端 `pageScrollTo`）。
- 另修：医生端两处 `var(--danger)` 在 `app.wxss` 里**不存在**（只有 `--danger-text`），`var()` 解析失败会静默继承正文色 → 统一改 `var(--danger-text)`。

**验证**：新增 `DoctorCloseConsultTest`（2 项，H2 + 真实 Controller/Service/SQL）覆盖
「结束 → 患者端 CLOSED + 两条系统提示 + 医生列表消失 + 患者再发 409」与「越权 404 / 重复 409 / 缺幂等键 400」；
问诊相关 5 个测试类共 14 项全绿。8089 header 模式实例实测：
`close=200 {"status":"CLOSED"}` → 患者详情 `status=CLOSED`、消息 `user / system_notice(已接诊) / system_notice(已结束)`、
患者再发 `409 CONSULTATION_CLOSED`、医生列表 `in_list=false`；未绑定医生建会话 `404 DOCTOR_NOT_FOUND`（原 500）。
前端 `node --check` + `check-project` + `check-require` + `test-nav-page`(80) 全绿；`check-styles` 仅剩 picker 页既有 `cp-doc-arrow`。
375×812 两态截图复核（导航「结束 / 已结束」单行不折行、状态标签与姓名不重叠、只读条贴底）。

**遗留**：结束不可撤销（无「重新开启」）；患者端历史会话仍可查看但不可发送；窄屏 + 键盘同时出现时未做真机验证。

# 8.45 首页四宫格真机变单列修复（2026-10-25）

**现象**：体验版真机首页四项入口变一列、每张卡只占左半、右侧整片空白（开发者工具模拟器 2×2 正常）。

**根因**：不是宽度算错，是**换行**。`gap: var(--h-s5)`(24rpx) + 两张 `calc(50% - 12rpx)` 之和正好等于容器宽，
真机 rpx→px 亚像素取整后多出约 1px → `flex-wrap` 把第二列挤到下一行。
（PIL 量真机截图：内容列 505px、卡 244px≈48.3%＝半宽；图标 88rpx≈66px 反推 1rpx≈0.75px，卡宽本身正确。）

**修法**（`pages/home/home.wxss`）：容器不用 `gap`，改 `justify-content: space-between`；
卡宽保留设计值 `calc(50% - var(--h-s2))`（两列合计 100%−24rpx，严格小于容器），并加 `49.6%` 兜底；
行间距改由卡 `margin-bottom` 提供；宽屏/平板/适老化各档同步去掉 `gap`。

**教训**：WXSS 里「`gap` + 两个 50% 减 gap/2」属于临界布局，模拟器不复现、真机必炸。
两列以上栅格一律用「剩余空间分配（space-between）」或固定百分比，别让两列之和贴着 100%。

# 8.46 全量前端测试问题修复（P0×1 + P1×7 + P2×17，2026-10-29）

**来源**：`docs/测试报告_20261029_全量前端测试.md` §7.3 去重清单（分片 A~E）。

| 组 | 修复要点 | 关键文件 |
| --- | --- | --- |
| P0-01 登录无验证 | 档位白名单 + fail-closed（`ENV_KEYS` 校验、`DEV_ONLY` 替代 `!== 'production'`）；dev 派生 code 判据改白名单；三个手输页 onLoad 生产档整页拦截；新增发版门禁 `tools/check-build-env.js` | `config/env.js`、`pages/auth/*`、`tools/check-build-env.js` |
| P1 患者端 | 手输登录补协议勾选；首页 checkup/care 弹中文说明；问诊错误文案走 `err-text`；首页预约卡骨架 + 失败重试；archive 直达档案 | `patient-login.js`、`home.js/.wxml/.json`、`consultation.js` |
| P1 会话/医生端 | 退出登录先 `POST /api/v1/auth/logout` 撤后端会话（Bearer+幂等键，顺序不能反）；医生 consult 补角色拦截 | `app.js`、`services/request.js`、`doctor/consult.js` |
| **P1 撤销残留 + P2 适老化（2026-10-30）** | logout 在 access 内存失效（2h 过期/进程回收）时，先用本地 refresh **静默换 access 再撤销**，并用 `session.getEpoch()` 丢弃退出期间回来的刷新结果（令牌不复活）；适老化触控 6 条提到 80~88rpx（断点内 40~44px）；登录四页字号全部走 `--font-*`、manual-login 输入框 88rpx、合规小字换 `--text-sub`；深链改 `safeDecode` 兜底；进度卡改按契约英文枚举分支 | `services/request.js`、`services/session.js`、`app.js`、`pages/auth/*`、`pages/doctor/{appointments,workbench}`、`pages/{home,consultation}`、`pages/{consult,appointment,triage,consultation}.js` |
| P1 音色 | 设默认 **PUT** `/api/v1/voice/voices/default`（POST 会 405）；试听 `POST /voices/{id}/previews`；远端音色可设默认/删除；清缓存保留音色与语速 | `services/voice.js`、`voice-settings.js`、`settings.js`、`config/api.js` |
| P1 科普 | 列表补「全部/图文/视频」类型 tab，`_apply` 走 `KB.filterFeed(cat,type)` | `knowledge.js/.wxml/.wxss` |
| P2 | 会话时效收紧、workbench onShow 复查、投屏回显、医生搜索反查科室、取消预约防重、文案/口径对齐、导航楼层与先取号提示 | 见 DEV_LOG 2026-10-29 条目 |
| 工具债 | T1 `cp-doc-arrow` 死标记删除；T7 医生端夹具改动态日期（原写死 2026-09/10 被「今天及未来」过滤） | `picker.wxml`、`test-pages-paginate.js`、`test-pages-contract.js` |

**验证**：`node tools/test-fe-all.js` → 新增单测 71/71、门禁 **23 项 PASS 21 + KNOWN-FAIL 2**（v4 历史债）、无新增失败（2026-10-30 复跑）；
分片审计 login 56/0、patient 44/0、profile 52/0、doctor 32/0、knowledge-filter 6/0；`test-pages-paginate` 57/57、`test-pages-contract` 70/70；
`test-triage` 322/322、`test-nav-page` 80/80、`preview-nav-page --measure` OK。

**未闭环**：后端 `spring.profiles.default: dev` 使隧道暴露实例接受 dev 派生 code（建议部署侧 `SPRING_PROFILES_ACTIVE=prod`）；
发版门禁未接 CI；T5 资源库 7 图标需跑 `resource-import.py --write`；T6 平板预览骨架待按新版式重定基线。

# 8.47 后端 P0 加固与发版门禁（2026-10-29）

**背景**：`spring.profiles.default: dev` + `DevWechatSessionProvider` 只认 code 形态 ⇒ 经隧道暴露的实例
任何人都能 `curl '{"code":"dev-user-1"}'` 拿到真会话，与小程序构建档位无关。

**加固（两条同时生效）**
1. 默认档位改 `prod`（`application.yml`）：dev 必须由部署侧显式声明；漏配 → 生产实现（缺 AppID 时登录 503）。
2. 新增 `DevLoginGuard`（`@Profile("dev")`）：`APP_AUTH_DEV_LOGIN_ENABLED` + `APP_AUTH_DEV_LOGIN_KEY` + 请求头
   `X-Dev-Login-Key` 三者齐备才放行 dev 派生 code，否则 403 `DEV_LOGIN_FORBIDDEN`。itest 档不装配。

**发版门禁**：`node tools/check-build-env.js` → 必须 **exit=0**（production + 正式 HTTPS + 后端安全默认）；
联调包用 `--allow-dev`（只降级档位/网关两项，安全默认仍强制）。完整步骤见
`docs/发版与真机复测清单_20261029.md`。

**验证**：后端 45 类 / 308 用例全绿（新增 `DevLoginGuardTest` 5 项）；前端 `test-fe-all` 无新增失败；
`check-v4-contracts` 12→0（回写 6 条医生问诊契约、删 6 条僵尸迁移条目）。


# 9. 文档索引

```text
AI_CONTEXT.md
WORKBODY_AGENT_RULES.md
DEV_LOG.md
docs/后端迁移适配文档_20261025.md
docs/项目介绍文档_医疗健康AI微信小程序_20261025.md
docs/交接文档_20261025.md
docs/测试报告_20261029_全量前端测试.md（主报告：计划+执行结果+登录专项+34页矩阵+修复计划）
docs/发版与真机复测清单_20261029.md（发版必跑项 / KNOWN-FAIL 台账 / 真机复测清单）
docs/测试报告_分片A_登录鉴权.md / 分片B_患者端主流程.md / 分片C_个人中心.md / 分片D_医生端.md / 分片E_分包与工具链.md
docs/测试报告_脚本执行结果.md
docs/测试报告_20261029_全量前端测试_详细版.md（第二轮详细版：逐页用例化+适老化/边界/导航/体积量化+修复状态总表+真机待核项）
docs/数字人对话_技术评估与实施方案.md
docs/后端改进_数字人适配.md
docs/真机验证清单_M0POC.md
design-output/医疗_AI_智能健康小程序_UIUX_原型设计与界面说明书_V3.1_修正版.md
design-output/医疗_AI_智能健康小程序_UIUX_原型设计与界面说明书_V4.md
docs/历史设计规范/（1.md~5.md、LAYOUT_PLAN.md）
软件著作权申请资料/操作手册工作稿/（manual_操作手册待转PDF.docx、手册DOCX最新版.docx）
```

---

# 10. README 维护原则

- 不保存完整代码 / 完整日志 / 已废弃方案。
- 只保存当前仍然有效的项目知识。
- 后端联调相关历史知识（NATAPP/FastAPI/SpringBoot/接口表）已随 V1.6 纯前端化移除。
