# Agent-M 任务书 —— MiMo-V2.6-Flash（业务权威面）

> 前置阅读：`docs/v4/08-后端实施双Agent总纲.md`（本任务书是它的执行细则，冲突时以总纲与契约中更严格者为准）
> 身份：`DEV_LOG` 条目前缀 `[M]`；汇报沿用项目格式（完成 / 修改 / 验证 / 日志 / 下一步）。
> **所有权（写）**：`backend/business-service/**`（含迁移脚本与 dev 种子）；可新增 tools 后端自检脚本。
> **禁改**：`backend/edge-gateway/**`、`backend/ai-service/**`、`backend/deploy/**`、`backend/contracts/**`、`miniprogram/**`。

---

## 1. 契约面（唯一事实源 · 不得自行发明字段）

- `backend/contracts/business-openapi.yaml`：**除 `edge-gateway` 标签外的全部路径**（auth / me / patient / catalog / appointment / consultation / ai-task / triage / care-plan / voice / content / doctor / home / internal）。
- AI 编排：按 `docs/v4/03` §7 与 `ai-openapi.yaml`（由 D 实现）；**轮询 `GET /internal/v1/tasks/{id}` 是唯一权威**（O-02 未定稿）。
- 信封 / 幂等 / 错误语义以契约为准：`requestId` 贯穿、`Idempotency-Key`（相同键不同载荷 → `409`）、**严禁 `200 + 空对象`**。

---

## 2. 里程碑任务（M 侧清单）

### M0 —— 骨架与数据库基线

| # | 任务 | 要点 |
|---|---|---|
| M0.1 | 工程骨架 | Spring Boot 3.x + Java 17 + **Maven Wrapper**（`mvnw`/`mvnw.cmd` 入工程，不依赖系统 mvn）；包结构按 `docs/v4/03` §2 的依赖方向（可单模块多包）；profile = `dev`；`/actuator/health` 最小暴露；统一错误处理 + `requestId` 贯穿；**启动命令/端口/健康 URL/环境变量清单交给 D**（对应总纲 §8.6） |
| M0.2 | Flyway 基线 + 核心表 v0 | `users` / `user_profiles` / `consents` / `departments` / `doctors` / `appointments`（含必要约束与索引）；字符集 utf8mb4；时间与命名按 `docs/v4/03` §5 |
| M0.3 | dev 种子 | 4 个科室（消化内科 / 呼吸内科 / 心血管内科 / 骨科）+ 医生 + 号源；**仅 dev profile**，不得进入生产迁移 |
| M0.4 | 未实现端点的体面返回 | 骨架期所有未实现路径 → **一致且可识别的"未实现"错误**（不许空 200、不许静默）；进度登记在 business-service README |

**M0 收口 DoD**：业务服务可被 `start-all` 拉起且健康 UP；`DEV_LOG [M]` 证据表。

### M1 —— 患者核心链路

| # | 任务 | 要点 |
|---|---|---|
| M1.1 | auth | 契约形态不变；dev 提供可用的登录换取方案（微信登录待真实凭证时降级为开发档，**在 README 声明**）；refresh/logout |
| M1.2 | me / patient 域 | `/api/v1/me`、健康档案、家庭成员（按契约分域实现） |
| M1.3 | catalog | departments、`{departmentId}/doctors`、`{doctorId}/slots` |
| M1.4 | appointment | 创建（幂等键）/ 我的列表 / 取消 / 按幂等键查询；状态机与乐观锁按契约 |
| M1.5 | home / resources | `/api/v1/home/summary`（不返回超出展示所需的健康明细）、`resources/manifest` |
| M1.6 | triage | `recommendations`（**本地规则先跑**，基线可参考 `miniprogram/utils/triage-kb.js`，移入服务端处标注 O-07 待医学审核）、`emergency-checks`（轻量快速） |

### M2 —— AI 对话与语音（编排 D 的 ai-service）

| # | 任务 | 要点 |
|---|---|---|
| M2.1 | consultations | 创建（返回会话 + 任务；命中红线先回 `safety.emergency`，不阻塞）、消息、确认（`confirmations`）、详情、列表 |
| M2.2 | ai-task | 查询 + SSE 透传（断线回轮询为权威） |
| M2.3 | voice | `asr`（文本必须经用户确认后才入流程）、`tts`（失败降级文字）、`voices` 系列、`models` |
| M2.4 | care-plans | 输出定位为生活方式建议，不构成处方 |

### M3 —— 医生端与合规面

doctor/login、workbench、`appointments/{id}/status`（乐观锁）、beds、health-records、family-members 邀请、consents、deletion-requests、contents、`internal/v1/callbacks`（**O-02 定稿后**；此前以轮询为准）。

### M4 —— 硬化与验收

鉴权/授权（IDOR 抽查）、幂等冲突、乐观锁并发、审计、限流、契约测试（逐路径对两契约）、迁移回滚演练。

---

## 3. 验证命令（模板）

```text
cd backend/business-service && mvnw -q test
curl -s http://127.0.0.1:8088/actuator/health
node tools/check-v4-contracts.js
集成（经网关）: curl -s http://127.0.0.1:8000/api/v1/home/summary
```

---

## 4. 与 D 的对接（I-1 / I-3）

| 方向 | 内容 | 时点 |
|---|---|---|
| M → D | 启动命令 / 端口 / 健康 URL / 环境变量清单 / 构建产物路径（对应总纲 §8.6 表） | M0 收口 |
| M 用 D | ai-openapi 任务创建/轮询/取消；SSE 事件语义；降级错误码表 | M0 收口起 |

---

## 5. 反例清单（违反即返工）

- 把 AI 直接暴露给客户端（绕过自身编排）；在服务内复制 legacy 实现（那是网关兼容层的职责）。
- `200 + 空对象` / 静默吞错 / 未实现说成已实现；把 dev 种子写进生产迁移。
- 改契约或越所有权改动（`edge-gateway/**` 等）。
