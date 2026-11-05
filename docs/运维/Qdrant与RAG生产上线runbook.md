# Qdrant 与 RAG 生产上线 Runbook

> 状态：**待执行**（2026-10-23 登记）。本文档只描述**生产环境**（docker/k8s）的 Qdrant + RAG 上线步骤；
> 本地开发验证用的是 Qdrant v1.19.0 官方 Windows 二进制（`deploy/run/qdrant-local/`，已 gitignore），**不在本文档范围**。
> 文中所有「待确认」项依赖院方真实信息（服务器配额 / 备份存储 / 监控通道 / 镜像可用版本），见第 8 节清单，未确认前不得据本文档开工。

---

## 0. 前置事实（2026-10-22 实测，勿凭印象改写）

| 项 | 现状 |
| --- | --- |
| 开关 | `AI_RAG_ENABLED` 代码默认 `false`；deploy 现值 `false`（前置未满足，硬约束不得开启） |
| 端到端 | 本地真实 Qdrant v1.19.0 已跑通全链路：43 chunks 入库（7 篇图文 34 节 + 3 视频 9 tips）、citations 正常返回、降级正确、Qdrant 重启后自动恢复检索 |
| 阈值 | `AI_RAG_SCORE_THRESHOLD` **代码默认 0.7**（实测过高，本地 top≈0.63）；本地验证值 **0.5 仅本地有效，生产必须重新标定**（第 4 节） |
| 向量 | embedding = Ollama `nomic-embed-text`（维度 48，Cosine），collection = `health_kb` |
| 降级 | Qdrant DOWN → 任务 SUCCEEDED + `RAG_RETRIEVAL_FAILED` + 0 docs，不中断主流程（已验证） |
| 入库脚本 | 生产标准 = `backend/ai-service/scripts/rag_ingest.py`（幂等 / 按 version 回滚 / 远端保护）；`ingest_knowledge_kb.py` 为早期脚本，无 version 元数据，仅可用于建 collection 引导 |
| 上线顺序 | **不可颠倒**：装 Qdrant → 按 embedding 维度建 collection → 装 embedding 模型 → 入库 → 才开开关 |

---

## 1. Qdrant 部署（Docker）

### 1.1 镜像版本锁定
- 生产一律固定 tag `qdrant/qdrant:v<主>.<次>.<补丁>`，**禁止 latest / floating tag**。
- 起点锁定：本地验证过的 `v1.19.0`【待确认：院方镜像仓库实际可用版本，须 ≥ 本地验证版本】。
- 升级流程：新 tag 先在灰度/测试环境跑「入库 + 检索回归」→ 通过后才改生产 tag，并在 DEV_LOG 记录版本变更。

### 1.2 持久卷挂载
- `/qdrant/storage`（数据）与 `/qdrant/snapshots`（快照）**分别挂独立持久卷**；快照卷容量可小于数据卷。
- 非 root 运行需预先 `chown` 挂载目录（按部署账户实测）。

```yaml
# 参考 docker-compose 片段（落盘后按院方环境调整网络/镜像名）
services:
  qdrant:
    image: qdrant/qdrant:v1.19.0        # 锁定版本，禁止 latest
    restart: unless-stopped
    volumes:
      - qdrant-data:/qdrant/storage
      - qdrant-snap:/qdrant/snapshots
    environment:
      - QDRANT__SERVICE__API_KEY=${QDRANT_API_KEY}   # 生产建议启用；写入 AI_QDRANT_API_KEY 对应值
    ports:
      - "6333:6333"    # REST；生产仅内网可达
      - "6334:6334"    # gRPC（当前 rag.py 走 REST，可不暴露）
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://127.0.0.1:6333/readyz || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  qdrant-data:
  qdrant-snap:
```

### 1.3 资源限制
- 起步建议：**CPU 2 核 / 内存 4 GB**（本知识库量级足够），`reservation` 与 `limit` 同时设置，防止 Qdrant 与 ai-service（qwen2.5/Ollama）抢占资源；上线后按第 5 节指标回调。
- 超过 10 万向量或并发检索上升后再评估扩容，别提前堆资源。

### 1.4 健康检查
- 探针：`GET /readyz`（就绪，依赖存储挂载正常）为主，`GET /livez`（存活）为辅；compose `healthcheck` 见上（interval 30s / timeout 5s / retries 3）。
- 就绪前不注册到任何负载入口；`/internal/health` 之外不对客户端暴露 Qdrant（ai-service 仅内网可达）。

### 1.5 备份策略
- **每日快照**：`POST /collections/health_kb/snapshots`（collection 级），产物落 `/qdrant/snapshots`，随后**定时同步至院方指定异地存储**【待确认：存储位置与同步方式】。
- **恢复演练**：每季度 1 次从快照恢复演练，记录 RPO（快照窗口）与 RTO（恢复时长）。
- 保留策略：近 7 天每日快照 + 每月保留 1 个【待确认：按院方运维要求调整】。
- 备份命令示例（调度方自定，建议独立脚本 + 失败告警）：

```bash
curl -X POST http://<qdrant>:6333/collections/health_kb/snapshots?wait=true
# 快照文件落在 /qdrant/snapshots，由院方同步任务搬运到异地
```

---

## 2. 入库（生产执行）

### 2.1 脚本选型（重要）
| 脚本 | 幂等 | version 元数据 | 按 version 回滚 | 远端保护 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `scripts/rag_ingest.py` | ✅ uuid5(`doc_id::chunk_id`) | ✅ 进 payload | ✅ `--delete-version` | ✅ 默认 dry-run + 非本机需 `--allow-remote` | **生产标准，只用它** |
| `scripts/ingest_knowledge_kb.py` | ✅ sha256(chunkId) | ❌ 无 | ❌ 无法按 version 删 | ❌ 直接写 | 仅首次建 collection 引导；**勿用于生产入库** |

⚠️ 两个脚本 point id 算法不同，**同一 collection 混跑会并存重复点**（内容相同、id 不同）。生产从初始化起就统一用 `rag_ingest.py`。

### 2.2 执行前检查
1. Qdrant 就绪：`GET /readyz` = 200，collection `health_kb` 已按维度 48 建好（`GET /collections/health_kb`）。
2. embedding 可用：`AI_EMBEDDING_MODEL` 指向的模型已 `ollama pull`（生产为 nomic-embed-text）。
3. 版本号明确：本次入库 version 取 `kb-YYYYMMDD`（如 `kb-20261023`），写进 payload，回滚按它删。
4. 在**业务低峰窗口**执行；日志落盘留档（脚本日志已脱敏：正文最多 20 字预览，不落全文）。

### 2.3 执行步骤（rag_ingest.py）
```powershell
cd backend/ai-service

# 1) 先看计划（dry-run，不联网不写库）
.venv/Scripts/python.exe scripts/rag_ingest.py --from-kb ../../miniprogram/utils/knowledge-kb.js `
    --version kb-20261023 --qdrant-url http://<qdrant>:6333 --embedding-model nomic-embed-text

# 2) 核对计划里的 docs/chunks/batches/sample（id 由 doc_id::chunk_id 派生，稳定）

# 3) 正式写库：远端 Qdrant 必须显式 --allow-remote（否则 exit=2 拒绝）
.venv/Scripts/python.exe scripts/rag_ingest.py --from-kb ../../miniprogram/utils/knowledge-kb.js `
    --version kb-20261023 --qdrant-url http://<qdrant>:6333 --embedding-model nomic-embed-text `
    --apply --allow-remote
# 退出码：0 = 全部成功；1 = 有失败（已记账，重跑即覆盖，不会重复）
```
- 变量也可走环境注入：`AI_QDRANT_URL` / `AI_EMBEDDING_MODEL` / `AI_QDRANT_COLLECTION`（默认 health_kb）/ `AI_QDRANT_API_KEY` / `AI_OLLAMA_URL`，脚本默认读环境变量。
- 生产建议先 `--limit 2` 小批量试写一个临时 collection 验通，再全量。

### 2.4 幂等验证
- point id = `uuid5(固定命名空间, "{doc_id}::{chunk_id}")`，与内容长度 / 运行次数 / 版本号无关 → **重跑是覆盖不是新增**。
- 验证方法：
  1. `GET /collections/health_kb/points/count?exact=true` → count 应等于本次 chunks 数（约 43）。
  2. 原样重跑一次 2.3 步骤 → count **不增**（若增加说明点 id 不稳定或混用了脚本，立即停）。
  3. 抽查 payload：`version` = 本次值、`content_hash` 与源一致。

### 2.5 回滚（按 version 删）
```powershell
# 回滚：删除指定 version 的全部点（--apply 才执行；远端需 --allow-remote）
.venv/Scripts/python.exe scripts/rag_ingest.py --delete-version kb-20261023 `
    --qdrant-url http://<qdrant>:6333 --apply --allow-remote

# 只删某个 doc：追加 --delete-doc <doc_id>
# dry-run 先看：去掉 --apply 即可（回滚模式不需要输入源，互斥组不是 required）
```
- ⚠️ 语义坑（KNOWN_ISSUES #31 已记录）：Qdrant filter 的空 `must_not` 表示「不排除」；入库时清旧版用 `must(doc_id) + must_not(version=当前)`，**别把 must_not 写成匹配**（会让删除恒为 0）。
- 回滚后立即 2.4 校验 count 归零，再决定是否重跑 2.3 恢复上一版本。

---

## 3. 配置注入（环境变量，不写死）

| 变量 | 默认（代码） | 生产注入值 | 说明 |
| --- | --- | --- | --- |
| `AI_RAG_ENABLED` | `false` | `true` | 总开关；关闭即整体回退无 RAG（第 6 节） |
| `AI_QDRANT_URL` | `http://127.0.0.1:6333` | 生产内网地址 | 仅内网可达，不暴露公网 |
| `AI_EMBEDDING_MODEL` | `nomic-embed-text` | 与生产 Ollama 一致的模型名 | 与入库时同一模型，混用会维度/语义不一致 |
| `AI_RAG_SCORE_THRESHOLD` | `0.7`（偏高） | **第 4 节标定后的值** | **禁止沿用代码默认 0.7 或本地 0.5** |
| `AI_QDRANT_TIMEOUT_SECONDS` | `3` | 按链路实测调（env.local 注释给过 10） | 超时后走降级路径 |
| `AI_QDRANT_API_KEY` | `""` | 启用 api-key 时填 | 密钥只注入环境，不落库 |
| `AI_QDRANT_COLLECTION` | `health_kb` | 保持默认 | — |

- **注入方式**：生产走容器 env / `backend/deploy/env.local`（orchestrator 唯一加载的配置文件）；**禁止硬编码进代码，禁止写进前端 `env.js`**。
- 生效方式：改 `env.local` 后执行 `backend/deploy/restart.bat`；docker 部署则重建容器。`AI_RAG_ENABLED` 与 `AI_RAG_SCORE_THRESHOLD` 当前为进程启动时读取，**不支持热更新**，变更必须重启。
- ⚠️ `.env.ai-service.example` 不被任何脚本加载且未入库（其值与代码默认相反），**勿照抄**。

---

## 4. 阈值标定（真实流量重标 AI_RAG_SCORE_THRESHOLD）

- 现状：`0.5` 仅为本地验证值（nomic-embed-text 中文医疗查询 top≈0.63）；代码默认 0.7 实测过高（会大量丢命中）。**生产上线前必须在真实流量上重标，禁止直接带 0.5/0.7 上线。**

### 4.1 采样
- 采集 ≥1000 条真实 query（覆盖主要科室与问法；样本不足标定无效）。
- 采样通道（现无批量 score 采集端点，择一）：
  1. **响应采样**：RAG 命中时响应 `citations[].score` 已有值——接日志/业务侧抽样收集 score + 是否命中；
  2. **全量触发**：临时设 `AI_RAG_SCORE_THRESHOLD=0`（全量返回）跑 1~3 天，从 citations 收集 score 分布，期间用「离线人工标注」判断相关性。
  - 若需要长期采样，后续可加「score 分布」内部指标端点（本轮不实现，先按上述抽样）。

### 4.2 分布与切点
1. 画 score 直方图，记录 **P50 / P95 / P99**。
2. 人工标注样本「命中是否相关」（建议抽 200~300 条打标），对比相关/不相关两组的 score 分布。
3. 选取能最大化「精确率 + 召回」的切点；**分阶段上线**：先在 P50~P95 之间取保守切点，观察 1 周（第 5 节），再收紧到理想切点。

### 4.3 产出
- 标定报告落 `docs/运维/`：样本量、分布图、P50/P95/P99、标注结果、选定切点与理由；DEV_LOG 记录变更。

---

## 5. 上线后观察

- **直接可读**：`GET /internal/metrics/llm`（ai-service 内部端点）返回：
  `firstTokenP50Ms / firstTokenP95Ms / streamOk / streamFallback / lastFallbackError`。
- **citations 非空率 / RAG 降级率**：当前**无内置计数器**，用两种手段观测：
  1. 日志采样：检索结果带 `provenance`（`RAG_RETRIEVED` / `RAG_NO_RESULTS` / `RAG_RETRIEVAL_FAILED`），按样本统计；
  2. 业务响应抽样：统计响应中 citations 非空的比例。

| 指标 | 口径 | 起步告警建议（按基线调整） |
| --- | --- | --- |
| `streamOk` | 流式成功比例 | 相对上线前基线下降 >5% 告警 |
| 首 token 延迟 | `firstTokenP50Ms` / `firstTokenP95Ms` | P95 超过基线 1.5× 告警 |
| citations 非空率 | 带引用结果占比（日志/响应抽样） | 低于采样期基线 X% 告警【待基线】 |
| RAG 降级率 | `RAG_RETRIEVAL_FAILED` 占比 | 持续上升 → 查 Qdrant 健康与网络 |

- 上线前先取**无 RAG 基线**（延迟/错误率）用于对比；前 3 天每日核对，一周后按基线固化告警阈值。

---

## 6. 回滚

- **一键回滚（无 RAG）**：`AI_RAG_ENABLED=false` → `backend/deploy/restart.bat`（或重建容器）→ 走无 RAG 路径，服务不中断，对外契约不变。
- **Qdrant 不可用**：降级路径**已验证**——检索失败返回 `RAG_RETRIEVAL_FAILED` + 0 docs，任务 SUCCEEDED；Qdrant 恢复后自动恢复检索，无需人工干预。
- 回滚触发判定：citations 非空率骤降 / 首 token 延迟明显恶化 / 5xx 或降级率上升且指向 RAG 链路。
- 数据层回滚：见 2.5（按 version 删）。

---

## 7. 压测（worker 池）

### 7.1 已认证基线（2026-10-22 本机实测，勿随意改写）
- **worker 池 size=3 + i5-13500K + qwen2.5:0.5b 安全**（deploy 现值 `AI_LLM_WORKER_POOL_SIZE=3`，supervisor 监测异常自动回退单 worker）。
- 参考数据（`tools/bench-llm.py`，stub 桩隔离真实 LLM）：
  - BEFORE（pool=1/stream=off）：QPS 1.05，P95 28320ms
  - AFTER（pool=4/stream=on/reuse=on）：QPS 4.82，P95 6159ms，首 token P50≈171ms
  - DEGRADE（流式强制 500）：错误率 0%，全量透明回退非流式 → PASS

### 7.2 触发重测条件（满足任一必须重测，不得沿用旧结论）
- 模型升级到 **7b 及以上**；
- 并发要求高于当前基线（如 pool > 3 或高峰期并发超出本机余量）；
- 上线 RAG 检索链路后（增加 embedding + 检索耗时）。

### 7.3 压测方案（变更后执行）
1. **桩压测**（快、隔离真实模型）：`backend/ai-service/tools/stub-ollama-llm.py` + `tools/bench-llm.py`，先确认并发/流式/降级行为不回归。
2. **真流量阶梯**：并发 1 → 3 → 6 → 10 逐级，每级稳定 2 分钟；记录 `GET /internal/metrics/llm` 的 firstToken P50/P95、streamOk，及 CPU/内存、Ollama 队列。
3. **通过标准**：P95 首 token 达标（相对基线不劣化）、无 5xx、CPU 不持续 >85%（与机器上其他服务共存前提下按实测调整）。
4. **记录**：压测结果（机器配置 / 模型 / worker 数 / 并发档 / QPS / P95）追加 DEV_LOG，结论只认实测。

---

## 8. 依赖院方真实信息（待确认清单，未确认不开工）

- [ ] Qdrant 部署所在服务器的资源配额、账户与目录约定
- [ ] 生产可用 qdrant 镜像版本（≥ v1.19.0 已验证值）
- [ ] 备份/快照的异地存储位置与同步方式、保留周期
- [ ] 监控告警通道（是否接入现有采集，告警收件人）
- [ ] 生产 Ollama 实例地址与 embedding 模型清单（与 AI_EMBEDDING_MODEL 对齐）
- [ ] 是否启用 Qdrant api-key（涉及 AI_QDRANT_API_KEY）
- [ ] 生产调度/执行入库脚本的机器与账号（含 --allow-remote 使用人）

---

## 9. 变更记录

| 日期 | 变更 | 状态 |
| --- | --- | --- |
| 2026-10-23 | 首次成文（依据 2026-10-22 本地端到端验证 + AI_CONTEXT 0f + rag_ingest.py 实测契约） | 待执行 |
