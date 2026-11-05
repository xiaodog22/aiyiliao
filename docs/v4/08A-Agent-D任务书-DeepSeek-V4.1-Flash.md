# Agent-D 任务书 —— DeepSeek-V4.1-Flash（平台与 AI 运行面）

> 前置阅读：`docs/v4/08-后端实施双Agent总纲.md`（本任务书是它的执行细则，冲突时以总纲与契约中更严格者为准）
> 身份：`DEV_LOG` 条目前缀 `[D]`；汇报沿用项目格式（完成 / 修改 / 验证 / 日志 / 下一步）。
> **所有权（写）**：`backend/edge-gateway/**`、`backend/ai-service/**`、`backend/deploy/**`；可新增 tools 后端自检脚本。
> **禁改**：`backend/business-service/**`、`backend/contracts/**`、`miniprogram/**`；现有前端门禁脚本判定语义（唯一例外：M0 工具同步项，由你执行、用户复核）。

---

## 1. 契约面（唯一事实源 · 不得自行发明字段）

| 实现对象 | 契约文件 | 覆盖 |
|---|---|---|
| edge-gateway | `backend/contracts/business-openapi.yaml` | `edge-gateway` 标签（`/api/gw/health`、`/api/gw/routes`、`/api/gw/voices`）+ 全局信封与错误语义 + `x-migration` 转发表 |
| ai-service | `backend/contracts/ai-openapi.yaml` | 全部：`POST /internal/v1/tasks`、`GET /internal/v1/tasks/{taskId}`、`POST /internal/v1/tasks/{taskId}/cancel`、`GET /internal/health/{live,ready}` |

与 M 的对接（I-1）：**轮询 `GET /internal/v1/tasks/{id}` 是唯一权威状态路径**（O-02 回调未定稿；定稿前不实现回调方向）。

已定默认值（对应待决事项）：
- O-03：缓存键统一用 `tenantSecret` 命名。
- O-10：`engine` 字段**如实返回**实际引擎（占位档就标 `placeholder`，不许含糊）。
- 服务签名（`serviceSignature` / `X-Service-Signature`）：**留开关**，dev 默认关，启动日志必须打印其开关状态。

---

## 2. 里程碑任务（D 侧清单）

### M0 —— 骨架与一键启动（你是本里程碑的关键路径）

| # | 任务 | 要点 |
|---|---|---|
| D0.1 | 网关工程 | `backend/edge-gateway/`（建议 FastAPI/Starlette，与 ai-service 同栈）；配置外置（上游表 business:8088）；路由策略 = **除 `/api/gw/**`（自身）外全量代理 business**（V4 目标态，与旧 `JAVA_PREFIXES` 白名单相反——README 写清楚差异）；`/api/gw/health`（上游可达摘要，**不泄露内网地址/版本细节**）、`/api/gw/routes`（前缀→归属） |
| D0.2 | legacy 兼容层 | 按 `x-migration.entries` + `api.js` 建转发表；维护 `COMPAT.md` 活表（legacy → 新路径 → 状态 → 移除条件）；**范围**：至少覆盖前端当前实际调用的 legacy 项，优先级在 M0 集成门由用户确认 |
| D0.3 | ai-service 工程 | FastAPI + `requirements.txt`（锁版本）+ `.venv` 规范；5 个内部端点全部可跑通（任务持久最小实现：内存/文件均可，但**状态机完整** QUEUED→RUNNING→SUCCEEDED\|FAILED\|CANCELLED\|EXPIRED，取消幂等）；健康端点**区分"进程活着"与"模型可用"**（按能力分档） |
| D0.4 | **一键启动程序（D3）** | 按总纲 §8 全部行为规格实现：start/stop/status/restart + `-Setup` 初始化 + `config.json` + `env.example/env.local` + 日志滚动 + PID 管理；通过总纲 §8.4 五场景 |
| D0.5 | 工具同步 | `tools/check-v4-docs.js` 骨架告警改口（**先报用户**，复核后改） |

**M0 收口 DoD**：总纲 §5.1 M0 集成门 4 条全过 + `DEV_LOG [D]` 证据表 + I-1/I-3 冻结记录。

### M1 —— 患者核心链路（D 侧支撑）

| # | 任务 | 要点 |
|---|---|---|
| D1.1 | triage 远端补充 | 导诊远端任务（科室推荐补充档）；**服务端"本地红旗先跑"属 M 侧编排**，D 只做远端能力与降级返回；无模型/超时 → 快速结构化降级，不让 M 侧无限等待 |
| D1.2 | emergency 支撑（归属在 M0 门对齐） | 轻量、快速、无生成；失败必须快 |
| D1.3 | 网关全量代理与错误信封映射 | 上游错误 → 统一信封的映射表（写进 edge-gateway README） |

### M2 —— AI 对话与语音

| # | 任务 | 要点 |
|---|---|---|
| D2.1 | 任务执行器 | `consultation.generate` / `careplan.generate` / `tts.synthesize` 等（类型清单与 M 收敛后**登记在 ai-service README**，不改契约） |
| D2.2 | SSE 事件 | accepted/status/delta/safety/completed/error；**不伪造百分比**；`X-Accel-Buffering: no` 语义；断线一律回轮询兜底 |
| D2.3 | 语音适配器 | ASR：权重视就绪（缺 → `CAPABILITY_UNAVAILABLE`）；TTS：引擎如实（缺 → `TTS_UNAVAILABLE`，**不播占位音**） |
| D2.4 | 内容寻址缓存 | 键按 `docs/v4/04` §9（HMAC(tenantSecret, ...)）；Redis 缺 → 本机 LRU/文件实现，重启可失（非权威数据） |

### M3 —— 医生端与合规面（D 侧）

网关不缺项；若无新增职责 → 提前执行 M4 硬化项（任务 TTL / 清理 / 限流）。

### M4 —— 硬化与验收

| # | 任务 | 要点 |
|---|---|---|
| D4.1 | 启动硬化 | 故障演练脚本：依次中断依赖（MySQL 除外）→ 验证"可降级矩阵"；`stop-all` 干净度 |
| D4.2 | 安全抽查 | 输入长度/编码/注入检测前置；日志脱敏抽查（不得出现原文/凭据） |
| D4.3 | 文档收口 | `edge-gateway/README.md`、`ai-service/README.md`（启动、端点、降级矩阵、环境变量清单） |

---

## 3. 验证命令（模板）

```text
node tools/check-v4-contracts.js
backend/deploy/start-all.bat && backend/deploy/status.bat
curl -s http://127.0.0.1:8000/api/gw/health
curl -s http://127.0.0.1:8001/internal/health/ready
ai-service 测试：backend/ai-service/.venv/Scripts/python.exe -m pytest backend/ai-service/tests -q
```

---

## 4. 双向交付清单

| 方向 | 内容 | 时点 |
|---|---|---|
| D → M | ai-openapi 冻结确认；任务类型登记表；SSE 语义；降级错误码表；ai-service 环境变量清单 | M0 收口 |
| M → D | business-service 启动命令 / 端口 / 健康 URL / 环境变量清单 / 构建产物路径（对应总纲 §8.6） | M0 收口 |
| D → 前端联调 | `COMPAT.md` 转发表 | M0 起持续 |

---

## 5. 反例清单（违反即返工）

- 改契约字段或自行发明响应结构；改 `miniprogram/**`；改 `business-service/**`。
- `200 + 空对象`、静默吞错、把降级说成成功；启动脚本默认杀非自管进程。
- 未过 `check-v4-contracts.js` 就宣称完成。
