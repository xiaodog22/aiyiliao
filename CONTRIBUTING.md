# 贡献指南

感谢关注。本项目是**原生微信小程序 + 三服务后端**的医疗健康演示项目，代码风格与数据边界都比较严格，
提交前请先读完本页，能省掉一轮返工。

> 本项目为**技术演示与教学用途**，不构成医疗器械，不用于真实诊疗。
> 提交任何内容即表示你同意以 [MIT](LICENSE) 许可发布。

---

## 1. 环境要求

| 组件 | 版本 | 用途 |
|---|---|---|
| JDK | **17** | `backend/business-service`（Spring Boot 3） |
| Node.js | **22.x** | `tools/` 校验脚本（无根 `package.json`，脚本用内置模块） |
| Python | **3.11+** | `backend/edge-gateway`（FastAPI 统一网关）、`backend/ai-service` |
| MySQL | **8.0**（utf8mb4） | 业务库，Flyway 自动建表 |
| 微信开发者工具 | 最新稳定版 | 小程序预览与真机调试 |
| Ollama（可选） | 最新 | 本地大模型；未启动时 AI 解读返回 503，属预期 |

仓库**没有**根级 `package.json` / `pom.xml`，四个部分各自构建，不要试图在根目录 `npm install` 或 `mvn package`。

---

## 2. 本地启动

```bash
# 1) 配置：复制模板后填本机值（env.local 已被 .gitignore 排除，永远不会入库）
cp backend/deploy/env.example backend/deploy/env.local

# 2) 后端三件套（顺序 business -> ai -> gateway）
backend/deploy/scripts/orchestrator.ps1 -Action start     # Windows PowerShell
# 停止：-Action stop

# 3) 小程序：用微信开发者工具打开 miniprogram/ 目录
#    模拟器联调把 config/env.js 的 BUILD_ENV 设为 'local'（直连 127.0.0.1:8080）
```

必须由环境变量提供的密钥（缺失即启动失败，这是刻意设计的 fail-fast）：

- `PHONE_KEY_BASE64`（32 字节）
- `APP_ATTACHMENT_SIGN_SECRET`
- `AI_SERVICE_TOKEN`（≥32 字符，business 与 ai 同名注入）

密钥只写在 `backend/deploy/env.local`，**不要提交**。

---

## 3. 代码红线（评审会直接打回）

| # | 规则 | 说明 |
|---|---|---|
| 1 | 原生栈 | 禁止 Vue / React / UniApp / WebView 包裹；只写 WXML + WXSS + JS |
| 2 | 地址集中 | 唯一 baseURL 在 `miniprogram/config/env.js`，唯一路径表在 `config/api.js`；页面禁止 `wx.request`，禁止出现 `127.0.0.1` / `:8088` / `:8001` |
| 3 | 图标 | 只用 `miniprogram/utils/icons.js`（PNG 键表），**禁止 emoji 当图标** |
| 4 | 颜色 | 页面 WXSS 零字面色值（仅允许 `#FFFFFF`），色源统一在 `app.wxss` 的 CSS 变量 |
| 5 | 字号 | 页面禁止写死字号，用 `calc(var(--font-title) + Nrpx)` 这类变量组合 |
| 6 | 文案 | 用户可见错误文案只走 `utils/err-text.js`，禁止把英文异常或 HTTP 码直接渲染 |
| 7 | 数据 | 页面数据一律经 `services/`；禁止在页面内散写业务数据，禁止伪造接口数据 |
| 8 | 断点 | `@media (min-width:600px)` 内所有含 rpx 的选择器必须 ÷2 折 px（含 `border-width`） |
| 9 | 迁移 | Flyway **只能版本递增追加**；已应用的迁移文件禁止修改（checksum 会崩），修正用新版本 |

完整规范见 [`WORKBODY_AGENT_RULES.md`](WORKBODY_AGENT_RULES.md) 与 [`AGENTS.md`](AGENTS.md)。

---

## 4. 数据库改动

1. 结构变更放 `backend/business-service/src/main/resources/db/migration/V<n>__*.sql`；
2. 仅开发环境用的种子放 `src/main/resources/db/dev/V90<n>__*.sql`（只随 dev profile 加载）；
3. 已应用的迁移**永不修改**，需要修正就追加新版本（参见 `V9011__demo_family_proxy_grant.sql` 的写法）；
4. 写数据前先 `SELECT` 预演，单批事务，先备份，每批准备回滚；
5. 演示数据必须带「演示」标识，**禁止**真实患者信息、真实医生签名、医院公章、可扫码的官方报告二维码。

---

## 5. 提交前必须跑的验证

```bash
node tools/check-project.js                       # 语法/JSON/图标/禁址/包体 六项门禁
node tools/test-fe.js                             # 前端单元测试
backend/business-service/mvnw -o test             # 后端 319 项
backend/edge-gateway/.venv/Scripts/python.exe -m pytest backend/edge-gateway/tests -q
```

改动面更窄时按 `AGENTS.md` §4「验」执行最小验证，但**不可省略**。
当前仓库未配置 CI，以上命令是唯一门禁来源，PR 描述里请贴出实际输出。

---

## 6. 提交信息与分支

- 分支：`main` 保持可运行；改动走 `feat/<简述>`、`fix/<简述>`、`docs/<简述>`。
- 提交信息用 `<type>: <中文或英文简述>`，`type` ∈ `feat|fix|docs|refactor|test|chore|perf`。
- 一个提交只做一件事；格式化与业务改动分开提交。
- PR 请说明：改了什么、为什么、跑了哪些验证、有什么已知限制。

---

## 7. 不接受的内容

- 真实患者病历、身份证号、手机号、检查报告原件；
- 任何密钥、口令、`env.local`、微信 appid/secret、数据库备份；
- 医院公章、医生签名图、可指向真实机构的报告版式；
- 与项目无关的二进制大包、压缩包、视频素材；
- 为通过测试而放宽断言、删除历史记录或关闭数据约束的改动。

---

## 8. 安全问题

请勿在公开 Issue 中披露漏洞，按 [`SECURITY.md`](SECURITY.md) 的渠道私下报告。
