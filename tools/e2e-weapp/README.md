# 小程序联调测试套件（E2E + JMeter 5.4.1）

把「微信开发者工具自动化」与「Apache JMeter 5.4.1 网关压测」串成一条可复跑的本地链路。
**零业务代码改动**：本目录之外不修改任何页面/服务，`miniprogram/` 主包不受影响。

## 文件职责

| 文件 | 作用 |
| --- | --- |
| `config.js` | 唯一配置入口。网关地址从 `miniprogram/config/env.js` 的 `DEV_DIRECT` 解析，健康路径从 `config/api.js` 的 `GW_HEALTH` 解析；**不硬编码地址端口** |
| `preflight.js` | 环境自检：Node / 网关 / DevTools CLI / 服务端口 / automator SDK / JMeter / JDK / 插件，逐项给 OK·MISS·SKIP 与原因 |
| `e2e.spec.js` | 官方 `miniprogram-automator` 的两条 UI 旅程：首页→导诊、预约挂号页结构 |
| `jmeter/gateway-smoke.jmx` | 只用 JMeter 内置组件的测试计划；全部参数走 `-Jgw.*` 属性 |
| `run-jmeter.js` | 生成 CLI 命令、执行、解析 JTL（RFC4180）、判定退出码与非 2xx |
| `run-newman.js` | Postman CLI / Newman 适配器；runner 或 collection 缺失即 SKIP，不伪造结果 |
| `mcp/server.js` | 零依赖 stdio MCP server，把三条链路暴露成 5 个工具，供 DSH NEXT 调用 |
| `run-all.js` | 编排 + 生成 `artifacts/e2e-weapp/report-*.md` 与统一 schema `report-*.json` |

## 用法

```bash
node tools/e2e-weapp/preflight.js                 # 只看环境
node tools/e2e-weapp/run-all.js                  # 一键：自检 → E2E → JMeter → 报告
node tools/e2e-weapp/run-all.js --dry-run         # 强制离线自检（不向后端发请求）
node tools/e2e-weapp/run-all.js --users=10 --loops=5   # 后端在线时放大压测
node tools/e2e-weapp/run-jmeter.js --dry-run     # 只跑 JMeter 离线自检
node tools/e2e-weapp/run-newman.js --collection=<绝对路径.json>   # 只跑接口回归（也可用 E2E_POSTMAN_COLLECTION）
```

后端不在线时会自动切到 `--dry-run`：只产生一个明确标注的 `SELF-CHECK` 样本，
**不制造连接失败样本、不伪造性能数据**；该样本仅用于验证 JMX 可加载、JTL/HTML 报告链路可跑通。

## 环境要求与开关

| 项 | 要求 | 不满足时 |
| --- | --- | --- |
| Node | ≥ 18 | E2E SKIP |
| 微信开发者工具 | Windows/macOS，设置 → 安全设置 → **开启服务端口**（CLI/HTTP） | E2E SKIP |
| CLI 路径 | `WECHAT_DEVTOOLS_CLI` 指向 `cli.bat` / `cli`，或位于默认安装路径 | E2E SKIP |
| automator SDK | `npm install --prefix tools/e2e-weapp miniprogram-automator` | E2E SKIP |
| 项目 | `WECHAT_PROJECT_PATH`（默认 `miniprogram/`），须含有效 `project.config.json` | E2E SKIP |
| 自动化端口 | `WECHAT_AUTO_PORT`（默认 9420，即 `cli auto --auto-port`） | 由 SDK 自行处理 |
| JMeter | 5.4.1，`JMETER_HOME` 指向安装目录 | JMeter SKIP |
| JDK | Java 8+（本机 JDK 17 可运行 CLI；Java 15+ 移除了 Nashorn，本 JMX 用 Groovy 不受影响） | JMeter SKIP |
| 网关 | `E2E_GATEWAY_URL` 可覆盖；默认取 `env.js` 的 `DEV_DIRECT` | 自动 dry-run |

后端启动（约 25s，启动与验证建议放在同一条命令内）：

```powershell
backend/deploy/scripts/orchestrator.ps1 -Action start
```

## 输出

- `artifacts/e2e-weapp/report-latest.md`（及带时间戳的版本）：环境表、UI/接口/压测三段明细、结论与待办
- `artifacts/e2e-weapp/report-latest.json`：**统一结果 schema**（`runId / generatedAt / gateway / ready / environment[] / stages[]`）；每条 stage 固定 `stage(ui|api|load) / tool / status / samples / errors / p95_ms / assertions / artifacts[] / reason`
- `artifacts/e2e-weapp/jmeter-*/`：JTL、命令、stdout/stderr 日志（仅真实压测模式生成 HTML Dashboard）
- `artifacts/e2e-weapp/e2e-*/`：用例截图（截图失败单独记 warning，不掩盖断言结果）

## DSH NEXT 集成（skill / MCP）

按 2026-11-14 的安装，资产全部落在本工作区，未改 DSH 应用本体、未写 `~/.dsh/`：

- **Skill**：`.agents/skills/wechar-unified-test/SKILL.md`（DSH 工作区级 skill 目录，实证与本工作区既有 `lead-*` skill 同格式）。
- **MCP**：`mcp/server.js`（stdio、零依赖）+ `mcp/mcp-servers.json`（可导入片段）。在 DSH 的 MCP 面板新增 server 即可；可选官方/第三方 server 见 `mcp/mcp-optional.json`。
- **工具**：`wechar_preflight` / `wechar_run_all` / `wechar_run_jmeter` / `wechar_run_newman` / `wechar_report`；JMeter 工具默认离线自检，显式 `dryRun:false` 才真实压测。
- 握手自检、版本与授权边界详见 **[mcp/README.md](mcp/README.md)**。

本机微信开发者工具实际装在 `D:\OpenWeChar\微信web开发者工具\`（非默认路径），已加入 `config.js` 探测候选；环境变量 `WECHAT_DEVTOOLS_CLI` 可覆盖。

## 典型场景

1. **日常回归**：后端在线 + 工具开着服务端口 → `run-all.js`，UI 结构断言 + 网关健康冒烟一起出报告。
2. **容量摸底**：`--users/--loops` 放大，或把 JMX 复制到 CI 用 Maven/Taurus/Jenkins 调度；本套件提供可直接加载的 `.jmx`。
3. **发版前**：`miniprogram-ci` 上传体验版 → JMeter 压后端 → Minium / MiniTest 云测做真机回归。

## 限制

- JMeter 5.4.1 打包 Log4j 2.13.3，受 **CVE-2021-44228** 影响；只允许本机/内网使用，生产建议 5.4.2+ / 5.6.x。
- 本机 `lib/ext` 未装 Plugins Manager / jpgc 插件，因此 JMX **刻意只用内置组件**；若引入第三方线程组，所有压力机必须同步 jar。
- JMeter 是协议层工具，不渲染 WXML、不执行小程序 JS；前端体验由 E2E 覆盖，两者不能互相替代。
- E2E 两条旅程只断言结构，分诊结果、号源列表等数据类断言须在后端在线后补充。
- 微信开发者工具无 Linux 版、需 GUI 登录态；纯 Linux CI 请改用 `miniprogram-ci` + MiniTest 云测。

## 本机实测（2026-11-13）

| 项 | 实测结果 |
| --- | --- |
| 环境 | Node 22.22.2；系统 JDK 17 + 本机 JDK 1.8.0_261（JMeter 子进程注入）；Apache JMeter 5.4.1 |
| 后端 | 网关 8080、business 8088、ai 8001 均未在线 → 主流程自动离线自检 |
| 开发者工具 | 11-13 CLI 未找到 / 53389 未监听；11-14 已定位 `D:\OpenWeChar\微信web开发者工具\cli.bat`、服务端口 52133 在线，仍缺 `miniprogram-automator` → E2E SKIP |
| JMeter 离线自检 | **PASS (SELF-CHECK)**：JMX 加载成功、1 样本、0 非 2xx、493ms |
| 真实压测分支 | 强制 2 并发 × 2 循环验证链路：4 样本全部连接失败（后端离线，预期），JTL + HTML Dashboard 均生成 |
| HTML 报告坑 | JDK 17 下报 `Begin size 0 is not equal to fixed size 5`（5.4.1 报告生成器已知缺陷）；注入 JDK 8 后生成成功 |
| MCP 握手 | 11-14 实测 `initialize` / `tools/list` / `tools/call` 三请求：3 条响应、5 个工具、`preflight` isError=false |
| 统一报告 | `report-latest.json` 3 段（ui/api/load）；后端离线时 ui/api=SKIP、load=PASS (SELF-CHECK)，不伪造数据 |
| 门禁 | `node tools/check-project.js` 全绿：禁址扫描 0 命中、主包 1.363MB、图片+音频 184.5KB |

补齐 E2E 剩余两步（服务端口与 CLI 路径本机已就绪）：
① `npm install --prefix tools/e2e-weapp miniprogram-automator`（装依赖需你单独授权）；
② `node tools/e2e-weapp/run-all.js`。
接口回归另需提供 Postman Collection 文件，并设置 `E2E_POSTMAN_COLLECTION` 或传 `--collection=<绝对路径.json>`。

后端在线后重跑（不加 `--dry-run`）即可得到真实网关性能数据；放大压测用 `--users=N --loops=N`。
