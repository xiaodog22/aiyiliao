# AGENTS.md — AI 工作入口（项目速览 + 省 Token 操作规定）

> 任何 AI 在本仓库开始工作前，**只读本文件即可开工**。
> 详细上下文按需取用（见第 5 节「文档体系」），不要全文通读大文件。

---

## 1. 项目是什么

**医疗健康 AI 微信小程序**（代号：楚大夫 / 患者端 AI 助手「小安」）

- 形态：原生微信小程序（WXML + WXSS + JS，**禁止 Vue/React/UniApp**），面向中老年适老化（大字三档/高对比）
- 后端：**统一网关单入口** —— `miniprogram/config/env.js` 的 `gateway`（:8000 反代 Python FastAPI :8001 + Java Spring Boot :8088）；前端代码禁止出现 8001/8088/127.0.0.1/localhost
- 核心能力：智能导诊（本地规则引擎 + 后端 AI 融合）、AI 问诊、AI 养生、分步挂号、院内导航（canvas）、健康科普、音色管理（Qwen3-TTS）、医生工作台
- 当前版本：以 `AI_CONTEXT.md` 为准（约 V1.19，2026-10 中旬；README 可能滞后）
- 已下线（勿碰）：手势识别、Live2D 数字人（2026-09-13 前端已删，后端/素材仅作备份）

## 2. 目录地图（只认这些，别乱扫）

| 目录 | 是什么 | 可否改动 |
| --- | --- | --- |
| `miniprogram/` | 前端主项目（pages / services / utils / config / components / 分包） | ✅ 日常改动区 |
| `backend/` | edge-gateway(:8000) / business-service(:8088) / ai-service(:8001) | ⚠️ 仅联调或改契约时 |
| `tools/` | 构建 + 验证脚本（check-*.js / test-*.js / build-*.py） | ✅ 改动前先查有没有现成脚本 |
| `docs/` | 方案 / 契约 / 验收文档 + `历史设计规范/`（1.md~5.md、LAYOUT_PLAN.md） | ⚠️ 只读为主 |
| `avatar-backend/` `mao/` `models/` | 已下线数字人相关（备份） | ❌ 不碰 |
| `design-output/` `ui-design-runs/` | 设计交付存档 | ❌ 不碰 |

## 3. 快速上下文（读到这就停）

按序读取，**读完即停**，禁止继续往下翻：

1. 本文件（AGENTS.md）
2. `AI_CONTEXT.md` —— 唯一上下文索引：版本 / 技术栈 / 后端契约 / 设计令牌 / 路由 / 红线 / 已知坑 / 验证脚本清单
3. `DEV_LOG.md` **尾部 30~80 行** —— 最近进展（该文件 433KB，禁止整读）

## 4. 省 Token 操作规定（硬性执行）

### 读
1. 任务启动只读：AGENTS → AI_CONTEXT → DEV_LOG 尾部，不再多读。
2. **定位优先于阅读**：用搜索定位目标函数 / 类 / 选择器 / API 名，禁止整文件、整目录读入。
3. **渐进式恢复**：日志尾部读不到答案才向前 +100 行，禁止一次全读。
4. 只读与任务相关的文件；无关目录一律不扫。
5. 已确认结论不重复推导：版本 / 架构 / 契约以 AI_CONTEXT 为准。

### 改
6. 最小修改：一次只改任务相关文件，禁止顺带重构 / 改名 / 搬目录。
7. 修改前先确认影响范围；无理由不动 API、目录、UI 体系。
8. 复用既有体系：颜色令牌只改 `app.wxss` 的 page 块；图标只用 `utils/icons.js`（**禁止 emoji 作图标**）；错误文案只用 `utils/err-text.js`；页面数据一律走 `services/`（禁止页面内散写业务数据）。

### 写（输出）
9. 默认输出格式，每项一行：`完成 → 修改 → 验证 → 日志 → 下一步`。
10. 禁止重复贴已存在代码、禁止重复解释已记录结论。

### 验
11. 改动后跑最小验证：`node --check` + `tools/check-project.js` + 对应 `tools/test-*.js`。
12. 验证只覆盖改动面，但**不可省**（省 token 不得牺牲正确性）。

### 记
13. 任务完成后：只更新 `README.md` 受影响节 + 追加 `DEV_LOG.md` 尾部，禁止重写全文。
14. 小任务（改色 / 改字 / 间距）不重新理解整个项目，按 L1 流程直接做。

## 5. 文档体系（各司其职，别混淆）

| 文件 | 作用 | 体积 | 何时读 |
| --- | --- | --- | --- |
| AGENTS.md（本文件） | AI 入口：项目速览 + 省 token 规定 | 小 | 每次任务 |
| AI_CONTEXT.md | 上下文索引（版本 / 契约 / 红线 / 坑） | 45KB | 每次任务 |
| DEV_LOG.md | 开发日志（增量追加） | 433KB | 只读尾部 |
| README.md | 项目状态 / 目录 / 流程 | 102KB | 按节查阅 |
| WORKBODY_AGENT_RULES.md | 完整 AI 工程规范（42 节，含任务分级 L1~L3） | 16KB | 有分歧或大任务时查 |

---

<!-- software-certificate-skill:start -->
## Software Certificate Skill

When a task involves 软件著作权、软著材料、操作手册、源程序材料或自动截图，read and follow `D:/asr_chaoshanhua/wechar/.agents/skills/software-certificate-skill/SKILL.md`. Resolve every referenced script, asset and reference relative to `D:/asr_chaoshanhua/wechar/.agents/skills/software-certificate-skill`. Use the bundled deterministic scripts instead of recreating them.
<!-- software-certificate-skill:end -->
