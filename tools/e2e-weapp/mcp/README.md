# 安装说明：DSH NEXT × wechar 统一测试

## 0. 「装到哪」的结论

桌面快捷方式 `DSH NEXT.lnk` 对应的应用本体是 `D:\deepseek h\DSH NEXT\DSH NEXT.exe`（Electron，244 MB）。
按本机基线，该目录**只读，不修改、不覆盖、不删除**；所以扩展没有写进应用目录，也没有写 `~/.dsh/`（凭据目录，写入需单独授权）。

全部落在你指定的工作区 `D:\asr_chaoshanhua\asr_chaoshanhua_V01\_V01\wechar`：

| 资产 | 路径 | 谁来发现 |
| --- | --- | --- |
| Skill | `.agents/skills/wechar-unified-test/SKILL.md` | **DSH 工作区级 skill 目录**。实证：`app.asar` 内含 `.agents/skills` / `.dsh/skills` / `SKILL.md` 字符串，且本工作区已有 6 个同格式 skill（`lead-*` 等） |
| MCP server | `tools/e2e-weapp/mcp/server.js` | 由 DSH 的 MCP 配置启动（stdio，零依赖） |
| MCP 配置片段 | `tools/e2e-weapp/mcp/mcp-servers.json` | 需你在 DSH 的 MCP 面板导入（见 §2） |
| 可选 MCP | `tools/e2e-weapp/mcp/mcp-optional.json` | 含占位符/需联网，逐项确认后再用 |
| 适配器 + 统一报告 | `tools/e2e-weapp/run-newman.js`、`run-all.js`、`artifacts/e2e-weapp/report-latest.{md,json}` | MCP server 调用 |

> 为什么没直接写 MCP 配置文件：实测 `app.asar` 内 `mcpServers` 出现 202 次，但没有 `.mcp.json` / `mcp.json` 等配置文件名，只有 `mcp_connect` / `mcp_message` / `mcp_disconnect` 协议方法，`~/.dsh/` 全深度也没有 MCP 配置文件 —— 配置由应用内部存储、经 UI 管理。猜路径写文件只会静默失效，所以改为「标准片段 + UI 导入」。

## 1. Skill

`.agents/skills/wechar-unified-test/SKILL.md` 已在位，frontmatter 与本工作区既有 skill 一致（`name` / `description` / `allowed-tools` / `metadata`）。
内容是三方统一编排 SOP：唯一入口命令、三条链路就绪条件、统一结果 schema、6 条红线、本机已知坑。DSH 打开本工作区即可发现，不需要重启应用（如未出现，重开会话）。

⚠️ `.agents/` 已被本仓 `.gitignore:54` 忽略（与工作区既有 6 个 `lead-*` skill 一致，是既有约定）。所以 skill **本机可用但不随 git 提交**；跨机器复用需装到 `~/.dsh/skills/`（写入该目录需你单独授权）或由你决定是否取消忽略。其余资产都在 `tools/e2e-weapp/`，会随仓库走。

## 2. 导入 MCP（唯一需要你手动做的一步）

在 DSH NEXT 的 MCP / 工具设置里新增一个 **stdio** server，填入：

```json
{
  "mcpServers": {
    "wechar-unified-test": {
      "command": "node",
      "args": ["D:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/tools/e2e-weapp/mcp/server.js"],
      "cwd": "D:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar"
    }
  }
}
```

（内容即 `mcp-servers.json`。若 DSH 提供「导入 JSON」，直接选该文件即可。）
零依赖、不联网、不改环境变量、不需要 API Key —— 导入后立即可用。

### 暴露的工具

| 工具 | 作用 | 副作用 |
| --- | --- | --- |
| `wechar_preflight` | 只读环境自检 | 无 |
| `wechar_run_all` | 自检 → UI E2E → 接口回归 → JMeter → 报告 | 写 `artifacts/e2e-weapp/` |
| `wechar_run_jmeter` | 单独跑 JMeter 5.4.1 | **默认离线自检**；只有显式 `dryRun:false` 才真实压测 |
| `wechar_run_newman` | 单独跑 Postman CLI / Newman | 需提供 collection；runner 缺失即 SKIP |
| `wechar_report` | 读 `report-latest.md` / `.json` | 无 |

安全设计：所有参数走白名单与数组式 `spawnSync`（不拼 shell）、并发数限 1~1000；JMeter 默认离线，避免 Agent 一句话就误触发压测。

### 自检（不依赖 DSH）

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"1"}}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"wechar_preflight","arguments":{}}}' \
 | node tools/e2e-weapp/mcp/server.js
```

应返回 `serverInfo.name = wechar-unified-test`、5 个工具、以及环境自检表；stderr 只打一行 ready 日志，不污染协议。

## 3. 可选 MCP（`mcp-optional.json`，默认不启用）

| Server | 类型 | 前置 | 为什么默认不启用 |
| --- | --- | --- | --- |
| `wechat-devtools` | 官方 | 开发者工具 ≥ Nightly Electron `2.02.2607032`、已登录、服务端口开启、从「设置→安全」复制 Token | 本机 CLI 未找到、工具未运行；Token 刷新即失效 |
| `jmeter` | 第三方 npm | `JMETER_HOME` + 联网装包 | 多按 5.6.x 验证，5.4.1 未实测；与本地 `server.js` 功能重叠 |
| `postman-local` | 官方 | 联网装包 + `POSTMAN_API_KEY` | 需账号凭据；只有本地模式能访问本机网关 |
| `postman-remote` | 官方 HTTP | OAuth | 远端访问不到 `localhost`；工具调用计入套餐额度；结果上传属对外发送数据 |

⚠️ 后四项涉及**装依赖 / 对外发请求 / 使用凭据**，按你的授权规则需单独确认后才可做；本轮一律未执行。

## 4. 结果对接

`report-latest.json` 是统一 schema：`runId / generatedAt / gateway / ready / environment[] / stages[]`。
`stages[]` 固定 `stage(ui|api|load) / tool / status / samples / errors / p95_ms / assertions / artifacts[] / reason`。
JTL 按 RFC4180 解析；Newman 读 JSON reporter；三者结果**不合并成单一通过率**（语义不同）。

## 5. 边界

- 未改 `D:\deepseek h\DSH NEXT\` 应用本体，未写 `~/.dsh/`，未装任何 npm/pip 依赖，未改环境变量，未做 git 写操作。
- 微信开发者工具的 GUI 登录、服务端口、MCP Token 只能由你在界面上完成；Postman Collection 需你提供文件。
- JMeter 5.4.1 含 Log4j 2.13.3（CVE-2021-44228），仅限本机内网；JDK 17 下 HTML 报告缺陷已由套件注入 JDK 8 子进程绕开。
