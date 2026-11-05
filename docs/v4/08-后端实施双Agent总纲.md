# 后端实施 · 双 Agent 总纲（V4 实施系列 08）

> **文档性质**：实施分工、协作协议与一键启动规格。本文**不表示后端已经实现**；一切"完成/通过"结论必须由代码、测试与运行结果共同支持。
> **版本**：V1.0 · 2026-10-14 · 状态：**已确认（2026-10-14）· 开工待命**（确认结论见 §10；待 Ollama 本体就绪 + 用户下发开工指令）
> **配套**：`08A-Agent-D任务书-DeepSeek-V4.1-Flash.md` · `08B-Agent-M任务书-MiMo-V2.6-Flash.md`

---

## 摘要（一分钟版）

1. **谁做什么**：Agent-D（DeepSeek-V4.1-Flash）= 统一网关 + AI 服务 + 一键启动；Agent-M（MiMo-V2.6-Flash）= 业务服务（Spring Boot）+ 数据库。
2. **按什么干**：`backend/contracts/` 两份 OpenAPI 契约是唯一事实源；`docs/v4/03/04` 是实施指南；本系列是执行细则。
3. **怎么算完**：5 个里程碑（M0~M4），每门由用户主持验收；每任务必须过本服务测试 + 契约校验 + DEV_LOG 记录。
4. **一键启动**：双击 `backend/deploy/start-all.bat` 拉起三服务并逐一确认健康；另有 stop / status / restart；规格全文见 §8。

---

## 1. 目标与交付物

### 1.1 目标

在仓库内落地 V4 目标后端三件套（统一网关 / 业务服务 / AI 服务）+ **一键启动程序**，让小程序可以在本机一键拉起全套服务、经统一网关（:8000）完成联调；后续平滑平移到服务器与生产拓扑（`docs/v4/05`）。

### 1.2 交付物总表

| 编号 | 交付物 | 落点目录（已确认，§10） | 负责 | 契约面（事实源） |
|---|---|---|---|---|
| **D1** | 统一网关 edge-gateway | `backend/edge-gateway/` | Agent-D | `business-openapi.yaml` · `edge-gateway` 标签 + `x-migration` 转发表 |
| **D2** | AI 服务 ai-service | `backend/ai-service/` | Agent-D | `ai-openapi.yaml` 全部（5 条） |
| **D3** | **一键启动程序**（start/stop/status/restart + 初始化引导） | `backend/deploy/` | Agent-D（M 提供接入参数） | 本文件 §8 |
| **M1** | 业务服务 business-service | `backend/business-service/` | Agent-M | `business-openapi.yaml` 除 `edge-gateway` 标签外的全部 |
| **M2** | 数据库迁移与种子 | `backend/business-service/**/db/migration/` | Agent-M | `docs/v4/03` §3/§5、`docs/v4/07` |
| **X1** | 契约一致性（持续保持） | `tools/check-v4-contracts.js` 保持通过 | 共同 | 两契约 + `miniprogram/config/api.js` |

### 1.3 明确不做（本轮）

- 不改 `miniprogram/**`（前端迁移为独立工作流；过渡期兼容见 §6）。
- 不把 MinIO / Redis / Qdrant 做成硬依赖（缺失必须可降级，见 §7）。
- 不产出生产部署形态（HTTPS、备案域名、容器化——O-04/O-05 未决）。
- 不修改 `backend/contracts/**`（**冻结**；变更只能走 O 项流程 + 用户确认）。

---

## 2. 事实源与现状

### 2.1 事实源（自上而下，冲突时以契约为准并立即修订文档）

| 层级 | 文件 | 用途 |
|---|---|---|
| 机器可读契约 | `backend/contracts/business-openapi.yaml` / `ai-openapi.yaml` | 路径、信封、字段、错误语义的**唯一权威** |
| 实施指南 | `docs/v4/03`（业务）/ `04`（AI）/ `05`（运维）/ `07`（隐私） | 约束与边界；不重复契约 |
| 门禁与纪律 | `docs/v4/06`、`WORKBODY_AGENT_RULES.md`、`AI_CONTEXT.md` | 测试矩阵；低 Token 与真实性红线 |
| 本文档系列 | `08 / 08A / 08B` | 分工与执行细则；与契约冲突时同样让位于契约 |

### 2.2 仓库现状（2026-10-14 实测）

- 后端：`backend/` 下**只有** `contracts/`（两份 draft 契约），**没有任何实现代码**。
- 前端：`miniprogram/config/api.js` 约一半路径已是新契约形态，其余为 legacy（迁移债，`x-migration` 有逐条映射）。
- 文档：`docs/v4/01~07` + V4 说明书（含待决事项 O-01~O-10）。
- Git：仓库**未初始化**（无 .git）→ 本轮以"约定"替代版本控制：秘密文件不入库、日志只追加。

### 2.3 本机环境实测（决定运行档位）

| 依赖 | 实测结果 | 结论 |
|---|---|---|
| Java | 17.0.14 LTS | ✅ 满足 Spring Boot 3.x |
| Maven | **未安装** | 用 **Maven Wrapper**（`mvnw`/`mvnw.cmd` 随工程提交，不依赖系统 mvn） |
| Python | 3.13.x（多个安装并存） | ✅；AI 服务使用**独立 venv**：`backend/ai-service/.venv` |
| Node | 22.x | ✅（前端工具链） |
| MySQL | 8.0.41（`D:\mysql\MySQL Server 8.0`），**3306 监听中**；root 带密码（无密码探测被拒） | ✅ 服务已具备；凭据由用户提供（§8.2），库名建议 `wechar_dev` |
| Ollama | **模型已就绪**：`D:\ollama_models`（qwen2.5:0.5b + 7b，4.8G，`OLLAMA_MODELS` 已配置）；**本体缺失**（PATH 三处残留均不存在）、11434 未监听 | ⏳ 用户先重装本体再开工；未就绪时按"降级档"运行 |
| ffmpeg | N-126207（`/d/ffmpeg-master-latest-win64-gpl-shared/bin`，在 PATH） | ✅ 语音转码可用 |
| Redis / Qdrant | 未部署（端口未监听） | 按"可降级"设计（`docs/v4/04` §10/§12） |

> 本机无 NVIDIA GPU（既有事实）：模型档以 CPU 可运行为准，容量与延迟一律以实测为准。

---

## 3. 目标架构与目录布局

```text
微信小程序（现状，本轮不改）
  └─ 统一网关 edge-gateway :8000        ← 前端唯一入口（/api/gw/** 自身 + 反向代理 + legacy 兼容层）
       ├─ business-service :8088        ← 业务权威（Spring Boot / MySQL）
       │     └─ 内部调用（服务签名 + 轮询）→ ai-service
       └─ ai-service :8001              ← AI 执行（FastAPI，仅本机/内网可达）
```

| 目录 | 职责 | 入口 | 健康 | 日志 |
|---|---|---|---|---|
| `backend/edge-gateway/` | /api/gw/**、代理、legacy 兼容层 | `app/main.py` | `GET /api/gw/health` | `deploy/logs/gateway.log` |
| `backend/business-service/` | 客户端全部业务路径（除 /api/gw/**） | `mvnw` / 打包 jar | `GET /actuator/health`（最小暴露） | `deploy/logs/business.log` |
| `backend/ai-service/` | 内部 AI 任务（5 条） | `uvicorn app.main:app` | `GET /internal/health/{live,ready}` | `deploy/logs/ai.log` |
| `backend/deploy/` | 一键启动程序 + 配置 + 运行态 | `start-all.bat` | `status.bat` | `deploy/logs/` |

端口约定：**8000 / 8088 / 8001**（与前端现状及契约一致；改动只允许发生在 `deploy/config.json` 一处）。

---

## 4. 双 Agent 分工

### 4.1 角色

| 角色 | 模型 | 定位 | 负责交付 |
|---|---|---|---|
| **Agent-D** | DeepSeek-V4.1-Flash | **平台与 AI 运行面**（Python） | D1 网关 · D2 AI 服务 · D3 一键启动 |
| **Agent-M** | MiMo-V2.6-Flash | **业务权威面**（Java） | M1 业务服务 · M2 数据库 |

分工理由：① 语言与目录天然隔离，可并行、无文件冲突；② 契约面一一对应（D=网关段+AI 契约，M=业务契约）；③ 一键启动由持网关与最重运行依赖的一方（D）收口。

> 如需对调两角色：交换两份任务书的执行方即可，分工结构不变。

### 4.2 文件所有权矩阵（硬性）

| 路径 | Agent-D | Agent-M | 规则 |
|---|---|---|---|
| `backend/edge-gateway/**` | **写** | 读 | |
| `backend/ai-service/**` | **写** | 读 | |
| `backend/deploy/**` | **写** | 读（向其提供接入参数） | |
| `backend/business-service/**` | 读 | **写** | |
| `backend/contracts/**` | 只读 | 只读 | 冻结；变更 → 记 O 项 + 报用户 |
| `miniprogram/**` | 禁 | 禁 | 本轮一律不改 |
| `tools/**` | 可**新增**后端自检脚本 | 可**新增** | 不得改动现有前端门禁脚本的判定语义（唯一例外：M0 工具同步项 §9-④） |
| `README.md` / `AI_CONTEXT.md` | 追加* | 追加* | *仅里程碑收口时；`DEV_LOG.md` 随时追加 |

### 4.3 边界接口（两个 Agent 之间唯一的对接面）

| 编号 | 接口 | 提供方 | 使用方 | 冻结时点 |
|---|---|---|---|---|
| I-1 | `ai-openapi.yaml`（任务创建/查询/取消 + 健康） | D | M | M0 收口 |
| I-2 | `business-openapi.yaml` 的 `edge-gateway` 段 | D | 前端 | M0 收口 |
| I-3 | **启动接入契约**（§8.6：命令/端口/健康 URL/环境变量清单） | M 提供 | D 消费 | M0 收口 |
| I-4 | legacy 转发表与字段映射（`COMPAT.md`） | D | 前端联调 | M0 起持续 |

### 4.4 协作纪律

1. 每个任务收尾：跑本服务测试 + `node tools/check-v4-contracts.js` + 追加 `DEV_LOG.md`（条目前缀 `[D]` / `[M]`）。
2. 阻塞处理：`DEV_LOG` 追加 `[D][BLOCKED]`/`[M][BLOCKED]` 条目并写清"需要谁做什么"；**不猜测、不越界改动**。
3. 跨所有权或契约变更：停相关实现，先报用户决策。
4. 真实性红线（违反即返工）：伪造数据 / 静默吞错 / `200 + 空对象` / 把"未实现"表述成"已上线"。
5. 里程碑集成门由用户主持，双方提交"证据表"（命令 + 原始输出 + 时间 + 环境）。

---

## 5. 里程碑与门禁

### 5.1 里程碑总览（细则见 08A / 08B 任务书）

| 里程碑 | 主题 | D 侧要点 | M 侧要点 | 集成门（全部通过才前进） |
|---|---|---|---|---|
| **M0** | 骨架与一键启动 | 网关（gw/health\|routes + 代理 + legacy 表）；ai-service（5 端点 + 健康 + 任务最小状态机）；**一键启动三件套** | Spring Boot 骨架（mvnw + actuator + 统一错误 + requestId）；Flyway 基线 + 核心表 v0 + dev 种子 | ① `start-all` 全绿 ② `/api/gw/health` 上游可达 ③ `check-v4-contracts` 通过 ④ 工具同步完成 |
| **M1** | 患者核心链路 | triage 远端补充 + emergency 支撑；网关全量代理与错误信封映射 | auth/me/catalog/appointments/home/triage/resources | E2E：登录→首页→科室→号源→预约；导诊「肚子疼」→消化内科 |
| **M2** | AI 对话与语音 | 任务执行器（consultation/careplan/tts）+ SSE + ASR/TTS 适配 + 缓存 | consultations/messages/confirmations、ai-tasks（含 SSE 透传）、voice/\*、care-plans | E2E：一句话问诊→任务→结果；TTS 出 URL 或降级文字；ASR 转写→用户确认 |
| **M3** | 医生端与合规面 | 网关不缺项 + 任务侧支撑 | doctor/\*、beds、records、family、consents、deletion、contents、internal 回调（O-02 后） | 医生端 E2E + 越权抽查 + 删除请求闭环 |
| **M4** | 硬化与验收 | 启动硬化（故障演练）、缓存/安全测试、文档收口 | 鉴权/幂等/审计/限流抽查、迁移回滚演练、契约测试 | `docs/v4/06` 对应后端门禁逐条（未过项如实标注） |

### 5.2 门禁规则

- 每门 = 完成方自验 + 用户（或另一方）复验；**未过门不进入下一里程碑**。
- 每门产出一张证据表写入 `DEV_LOG.md`；"部分完成"必须如实标记进度百分比。
- **M0 验收执行细则**：见 `docs/v4/08C-M0集成门验收单.md`（用户主持版：P1/P2 前置 + Step A–D + 签署区）。
- **M1 / M2 / M3 验收执行细则**：分别见 `docs/v4/08D-M1集成门验收单.md`（已 Approved）/ `docs/v4/08G-M2集成门验收单.md`（已完整通过并归档）/ `docs/v4/08H-M3集成门验收单.md`（另立独立成单，D 侧已执行、M 侧待落盘）。

---

## 6. 过渡期兼容策略（legacy ↔ 新契约）

1. **单一实现**：新服务只实现契约路径；legacy 一律**不复制**到服务内部。
2. **网关兼容层**：按 `x-migration.entries` 逐条处置——能等价转发的转发（含必要的响应字段适配）；不能的返回明确错误 + 迁移说明（**不造假数据**）。每条标注 `deprecated` 与移除条件（前端迁移完成即删）。
3. **范围界定**：以 `miniprogram` **当前实际调用**为准（`api.js` + services），不追求 100% legacy 覆盖；覆盖清单与优先级在 M0 集成门由用户确认。
4. **O-09 处置**：白名单口径以契约为准；校准 `AI_CONTEXT.md` §0 说明与 `api.js` 注释（改前报用户）。
5. 活跃表维护在 `backend/edge-gateway/COMPAT.md`（legacy → 新路径 → 状态 → 移除条件）。

---

## 7. 运行与依赖策略（低配先行）

| 级别 | 依赖 | 缺失时表现 |
|---|---|---|
| 硬依赖 | MySQL | 业务服务就绪失败（进程存活、明确报错）；`start-all` 前置检查拦截 |
| 能力依赖 | Ollama / ASR 权重 / TTS 引擎 / Redis / Qdrant | **不阻断启动**：对应能力 `ready` 为 degraded/unavailable，相关端点**快速失败**返回结构化错误；其余能力不受影响 |

- 禁止启动时联网下载未锁定哈希的资源（`docs/v4/05` §3.1）。
- 禁止用降级掩盖失败：错误必须点名错误码（如 `TTS_UNAVAILABLE`、`CAPABILITY_UNAVAILABLE`）。

---

## 8. 一键启动程序规格（D3 · 必读）

### 8.1 入口

| 文件（`backend/deploy/`） | 用途 |
|---|---|
| `start-all.bat` | 双击/命令行启动全套（默认档） |
| `stop-all.bat` | 停止（仅自管进程） |
| `status.bat` | 状态矩阵（PID / 端口 / 健康 / 日志路径） |
| `restart.bat` | = stop + start |
| `README.md` | 人读说明：首次使用、参数、排障 |

可选参数：`-Setup`（首次初始化：建 venv、装依赖、构建业务服务）、`-SkipAI`（不启动 AI）、`-Smoke`（启动后冒烟）、`-Yes`（免交互）。

### 8.2 配置与秘密

- `deploy/config.json`：端口、各服务命令、健康 URL、超时（**唯一配置点**）。
- `deploy/env.example`（入库模板）/ `deploy/env.local`（真实值，**不得入库**）；MySQL 连接写入其中（建议库名 `wechar_dev`）。
- 日志：`deploy/logs/<service>.log`，每次启动滚动备份（保留最近 5 份）。
- 运行态：`deploy/run/<service>.pid`。

### 8.3 行为规格（逐条可实现）

1. **前置检查**（不通过 → 中文指引 + 退出码 2，不留半启动状态）：端口占用、Java、驱动命令存在性、MySQL 可达、venv 存在、日志目录可写。
2. **启动顺序**：business-service → ai-service → edge-gateway（入口最后；任一上游失败**不阻止**网关启动，健康如实体现）。
3. **健康等待**：逐服务轮询健康 URL（默认 60s/服务，可配），超时标记 FAILED 并继续（不无限等待）。
4. **幂等**：已运行（健康 OK）→ 跳过并明示；端口占用但健康失败 → 冲突提示（**不得默认杀进程**）。
5. **进程管理**：只管理自己启动的进程（PID 文件）；停止先优雅（≤10s）后强制；不牵动用户手工启动的进程。
6. **输出**：每服务 1 行摘要 + 日志路径；结束打印总耗时与下一步提示。
7. **退出码**：`0` 全绿 / `1` 有服务失败 / `2` 前置未过。
8. **冒烟（-Smoke）**：GET `/api/gw/health`、`/api/gw/routes` + config 登记的无鉴权只读接口；**只读、无副作用**。
9. **安全边界**：不改系统环境、不写注册表、不装依赖（`-Setup` 除外且事前声明）；脚本不得打印任何凭据。
10. **Windows 原生**：bat 调 PowerShell；`chcp 65001` + 实测 Win10/11 控制台可读；路径含空格可运行。

### 8.4 验收场景（M0 集成门的一部分）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 冷启动（无任何服务） | 三服务全绿；矩阵全 OK；打印总耗时 |
| 2 | 重复 `start-all` | 幂等：全部跳过，无重复进程 |
| 3 | 中途杀掉 ai-service → `status` | ai 显示 FAILED；网关健康体现 degraded |
| 4 | 缺 MySQL / venv 未初始化 | 前置拦截 + 中文修复指引；退出码 2 |
| 5 | `stop-all` | 三端口释放、PID 清理；非自管进程不受影响 |

### 8.5 不做

- 不做守护/自动重启；不接管 MySQL 等外部服务的生命周期；不做 Linux 版（后续按需）。

### 8.6 启动接入契约（I-3 · M→D）

| 项 | business-service | ai-service | edge-gateway |
|---|---|---|---|
| 启动命令 | `mvnw spring-boot:run`（dev）/ `java -jar target/*.jar`（包模式，缺失先构建） | `.venv\Scripts\python.exe -m uvicorn app.main:app --port 8001` | `python -m uvicorn app.main:app --port 8000` |
| 端口 | 8088 | 8001 | 8000 |
| 健康 URL | `GET /actuator/health` → `{"status":"UP"}` | `GET /internal/health/live` + `/ready` | `GET /api/gw/health` |
| 环境变量 | 由 `env.local` 注入（Spring 标准名 `SPRING_DATASOURCE_*` 等；M 在 README 登记完整清单） | `AI_*` 前缀（D 登记清单） | `GW_*` 前缀（D 登记清单） |

### 8.7 联调通道（本机 → 小程序）

一键启动后，小程序经隧道访问本机网关：**沿用现有隧道方案指向 `127.0.0.1:8000`**；前端只改 `miniprogram/config/env.js` 的 dev `gateway` 一处（隧道域名变化同样只改这一处）。真机与开发者工具均按此通道验证。

---

## 9. 全局纪律（两 Agent 共同）

1. **DoD 模板**（每任务）：实现 + 本服务测试 + 契约校验 + `DEV_LOG` 追加 + 汇报（完成/修改/验证/日志/下一步）。
2. **验证频率**：每任务最小验证；每里程碑全量验证（`start-all` + 冒烟 + 对应契约域用例）。
3. **文档更新**：`README.md`/`AI_CONTEXT.md` 只在里程碑收口改（由该门指定一方执行，避免双写）；`DEV_LOG.md` 只追加、不改写。
4. **工具同步（M0 内置）**：`tools/check-v4-docs.js` 中"后端骨架不应存在（本轮不生产）"的告警 → 改为"按里程碑允许存在"——由 D 修改、用户复核。
5. **反例清单**（发现即判定返工）：改 `miniprogram/**`；改契约；越所有权写文件；伪造数据；`200 + 空对象`；未验证就宣称通过。

---

## 10. 确认结论（2026-10-14 已确认）

| # | 事项 | 结论 | 备注 |
|---|---|---|---|
| 1 | 分工与目录命名 | ✅ 按建议执行 | D=平台与 AI 运行面；M=业务权威面；目录 `backend/{edge-gateway,business-service,ai-service,deploy}` |
| 2 | 兼容策略 | ✅ 网关兼容层·先覆盖率在用项 | 覆盖清单在 M0 集成门按前端实际调用确认（§6） |
| 3 | 依赖档（Ollama） | ⏳ 用户**先安装本体**再开工 | 模型已就绪（`D:\ollama_models`，qwen2.5:0.5b/7b）；本体缺失（PATH 残留、11434 未监听） |
| 4 | 依赖档（MySQL） | ⏳ 开工后二选一 | A：用户填 `env.local`；B：执行「建库+专用账号」SQL；库名建议 `wechar_dev` |
| 5 | M0 开工 | ⏸ **暂不开工** | 待 Ollama 就绪 + 用户下发指令；开工方式（本会话 Agent-D / 新会话）待定 |

---

## 11. 开工提示词（复制到两个 Agent 会话）

【Agent-D（DeepSeek-V4.1-Flash）】

```text
你是 Agent-D（DeepSeek-V4.1-Flash），负责「平台与 AI 运行面」。
严格执行项目根目录 WORKBODY_AGENT_RULES.md 的最省 Token 模式。
先读：
1. docs/v4/08-后端实施双Agent总纲.md
2. docs/v4/08A-Agent-D任务书-DeepSeek-V4.1-Flash.md
3. backend/contracts/ai-openapi.yaml
4. AI_CONTEXT.md / README.md / DEV_LOG.md 最后 30~80 行
不要全项目扫描、不要读完整日志。
读完后 5 行内汇报：当前里程碑 / 首个任务 / 涉及文件 / 风险 / 计划。
等我下发「开始 M0」。
```

【Agent-M（MiMo-V2.6-Flash）】

```text
你是 Agent-M（MiMo-V2.6-Flash），负责「业务权威面」。
严格执行项目根目录 WORKBODY_AGENT_RULES.md 的最省 Token 模式。
先读：
1. docs/v4/08-后端实施双Agent总纲.md
2. docs/v4/08B-Agent-M任务书-MiMo-V2.6-Flash.md
3. backend/contracts/business-openapi.yaml
4. AI_CONTEXT.md / README.md / DEV_LOG.md 最后 30~80 行
不要全项目扫描、不要读完整日志。
读完后 5 行内汇报：当前里程碑 / 首个任务 / 涉及文件 / 风险 / 计划。
等我下发「开始 M0」。
```

---

## 12. 本文件不作出的承诺

- 不表示后端已实现、已联调或已上线；不改变 `docs/v4/01~07` 的既有结论。
- 不证明任何性能、容量、安全、医疗或合规目标达成；相关结论一律以实测与人工确认（O-07/O-08 等）为准。
- 08/08A/08B 是**执行细则**；与契约冲突处，以契约（机器可读事实源）为准并立即修订本文档。
