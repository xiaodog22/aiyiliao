# 一键启动程序（后端实施 · Agent-D 交付物 D3）

规格来源：`docs/v4/08-后端实施双Agent总纲.md` §8（行为规格逐条实现）。

## 用法

| 入口 | 作用 |
|---|---|
| `start-all.bat` | 双击/命令行启动全套（默认档：business → ai → gateway） |
| `stop-all.bat` | 停止（**仅回收本工具启动的进程**） |
| `status.bat` | 状态矩阵（PID / 端口 / 健康 / 日志路径） |
| `restart.bat` | 先停后启 |

可选参数（跟在 bat 后面，如 `start-all.bat -Setup -Yes`）：

| 参数 | 作用 |
|---|---|
| `-Setup` | 首次初始化：创建 venv、安装依赖（走 `config.json` 的 `pipIndexUrl` 镜像）、预构建业务服务（有 mvnw 且无 jar 时） |
| `-SkipAI` | 本次不启动/检查 AI 服务 |
| `-Smoke` | 启动后冒烟（GET `/api/gw/health`、`/api/gw/routes`；**只读、无副作用**） |
| `-Yes` | 免交互（`-Setup` 的确认提示跳过） |

> 双击运行时窗口结束会停住等你按键（传参数调用则不停）。

## 图形面板（常驻窗口）

`start-gui.bat`（双击）打开 WinForms 常驻面板；**启动完成后窗口不退出**，持续自动刷新。

| 入口 | 作用 |
|---|---|
| `start-gui.bat` | 打开图形面板（内部以 `-STA` 启动 `scripts\gui.ps1`） |
| `scripts\gui.ps1 -SelfTest` | 无界面自检：跑一轮采集并打印状态矩阵 / 请求流水 / 计数（供自动化验证） |

工具栏按钮（全部转交 `orchestrator.ps1` 子进程执行，面板不重复实现编排逻辑）：

| 按钮 | 等价命令 | 说明 |
|---|---|---|
| 启动全部 | `orchestrator.ps1 -Action start` | 与 `start-all.bat` 同一条链路 |
| 停止全部 | `orchestrator.ps1 -Action stop` | 只回收本工具拉起的进程 |
| 重启 | `orchestrator.ps1 -Action restart` | 先停后启 |
| 冒烟检查 | `orchestrator.ps1 -Action start -Smoke` | 只读打点，不产生副作用 |
| 刷新 | 立即触发一轮采集 | 自动刷新关闭时用手动刷新 |
| 打开日志目录 | 资源管理器打开 `logs\` | 排查现场用 |

开关：`自动刷新`（默认开，600ms 一轮）· `关闭面板时停止服务`（**默认关**，勾选后关窗顺带停服）。

四个视图：

| 视图 | 内容 | 数据源 |
|---|---|---|
| 服务状态矩阵 | 服务 / 端口 / PID / 进程 / 健康探测 / 判定 / 说明 | `config.json` + `run\*.pid` + 健康探测 |
| 请求流水 | 时间 / 方法 / 路径 / 状态码 / 判定 / 客户端 / 说明 | 网关访问日志 `logs\gateway.log` |
| 服务日志 | 按文件选择，增量尾部追加 | `logs\*.log` / `*.error.log` |
| 操作输出 | 编排器 stdout/stderr 实时导入 | `run\_gui-op-out.txt` / `_gui-op-err.txt` |

**两级判定**

- **服务级**：`正常`（探测 200）· `降级`（接受码但非 200，如网关 503）· `异常`（进程在但探测失败）· `端口被占用` · `未启动`。
- **请求级**：`成功`（2xx）· `跳转`（3xx）· `客户端错误`（4xx）· `服务端错误`（5xx）· `上游失败`（网关告警的
  `上游不可达 / 上游超时 / 上游异常`，并入同一请求那一行，**不重复计数**）。

**同一请求只显示一行**：网关日志里一次失败会产生两条记录——访问日志的 `5xx` 行与 `edge-gateway.proxy` 的上游告警行。
面板把后者作为**补充说明合并**到前者（`判定 = 上游失败`、`说明 = ConnectError` 等）；两侧路径无法对齐时
（网关 compat 翻译层改写过路径）按「方法 + 状态码」宽松匹配，并在说明里标注真实上游路径。

**口径一致性**：健康接受码、端口探测、PID 存活全部取自 `scripts\deploy-common.ps1` —— 与 `orchestrator.ps1`
共用同一份实现，保证「面板说健康」与「命令行说健康」**永远是同一判定**（消除双口径分歧）。

**边界**

- 面板**只观察与转发操作**：启动 / 停止 / 重启 / 冒烟一律以子进程调用 `orchestrator.ps1`，不在面板里重复实现编排逻辑。
- 不做守护 / 自动重启（与 `start-all.bat` 的既有边界一致）：面板是**监控台，不是进程守护**。
- 「时间」列是**观测时间**（uvicorn 访问日志本身不含时间戳），不是请求发生的真实时刻。
- 「隐藏健康探测请求」默认勾选：探测路径的请求（含其上游失败行）从流水视图隐藏，避免淹没业务请求。
- 关闭窗口即退出面板；是否顺带停止服务由工具栏「关闭面板时停止服务」复选框决定（**默认不勾**）。
- **操作成败判定**：面板读到「操作结束」时，退出码取自编排器自己回写的 `run\_gui-op-rc.txt`（启动时传 `-RcFile`），
  **不依赖 PowerShell 的 `Process.ExitCode`** —— PS5.1 下该属性常为 `$null`，曾导致任何操作都显示「退出码 —— 异常」。
- **操作输出恒按 UTF-8 解**（编排器启动即钉 `[Console]::OutputEncoding = UTF8`），且用有状态解码器：
  读到的最后半个汉字留到下一轮再解，不再因为「截断 → 误判 GBK」把整页输出变成乱码。

## 退出码

| 码 | 含义 | 处理 |
|---|---|---|
| `0` | 全绿（就绪 / 已在运行跳过） | — |
| `1` | 有服务**运行期失败**（启动后退出 / 健康等待超时） | 看 `logs\<名>.log` 尾部提示 |
| `2` | **前置未过**：全局前置拦截（MySQL 不可达 / venv 未初始化 → **不启动任何服务**、不留半启动状态）；或个别服务前置缺失（产物未交付 / 端口冲突 → 其余服务照常启动） | 按行内中文指引处理 |

> 例：Agent-M 的 `business-service` 尚未交付期间，`start-all.bat` 会正常拉起 ai + gateway，
> business 显示"产物未交付"，整体退出码 `2` —— 这是**预期中间态**，不是脚本故障。

## 行为要点（与规格逐条对应）

1. **前置检查**：端口占用 / venv / mvnw / Java / MySQL 可达 / 日志目录可写。其中 **venv 未初始化 与 MySQL 不可达为全局门**（任一不通过 → 中文指引 + 退出码 2 + **不启动任何服务**，不留半启动状态）；产物未交付 / 端口冲突为逐服务跳过。
2. **启动顺序** business → ai → gateway（入口最后；任一上游失败不阻止网关启动）。
3. **健康等待**：逐服务轮询（默认 90s，可配 `healthTimeoutSeconds`）；**进程提前退出会立即判定失败**（不等满超时）；超时标记失败并继续。
4. **幂等**：已在运行（健康 OK）→ 跳过（**含由 IDE/手工启动的实例**——健康可达即跳过；`stop-all` 绝不回收非本工具进程）；端口被占且健康失败 → 冲突提示（**不杀进程**）；网关健康允许 `503`（上游全不可达但进程存活）→ 按“降级”接受（`config.json` 的 `healthAcceptStatus`）。
5. **进程管理**：只管理 `run\<名>.pid` 记录的进程；停止先温和（taskkill /T）、10 秒未退再强制（/F）。
6. **日志**：`logs\<名>.log` + `logs\<名>.error.log`；每次启动滚动备份（保留最近 5 份）；**轮转失败不阻断启动**
   （旧实例的 stdout 句柄仍持有日志时只告警、继续追加，不再把服务判成「启动异常」）。
7. **配置唯一处**：`config.json`（端口/命令/健康 URL/超时/镜像）；秘密只放 `env.local`。
8. **不越界**：不改系统环境、不写注册表、不装全局依赖；脚本不打印任何凭据。
9. **环境泄漏防护**：启动前移除工作环境注入的 `SERVER__PORT`（防 Spring relaxed binding 抢占 `server.port` 致业务绑定错误端口），并在未显式指定时钉住 `SERVER_PORT`（`env.local` 可覆盖）。

## 文件

```text
backend/deploy/
├── start-all.bat / stop-all.bat / status.bat / restart.bat
├── start-gui.bat                   # 图形面板双击入口（-STA 启动 scripts/gui.ps1）
├── scripts/orchestrator.ps1        # 实际逻辑（PowerShell 5.1 兼容）
├── scripts/gui.ps1                 # WinForms 常驻面板（状态矩阵 / 请求流水 / 服务日志 / 操作输出）
├── scripts/deploy-common.ps1       # 共享工具：路径常量 + 健康/端口/pid 判定口径（orchestrator 与 gui 同一份）
├── scripts/fault_drill.py          # M4·D4.1 依赖中断故障演练（真实打停 + 幂等补起 + 干净度）
├── scripts/accept-frontend-contract.ps1  # 前端契约十条验收（启动→打点→汇总→可选停止）
├── resources/                      # 静态素材目录（经 /api/gw/assets 分发；前端适配见 docs/v4/09）
├── config.json                     # 唯一配置点
├── env.example                     # 环境变量模板（复制为 env.local 填写）
├── logs/  run/                     # 运行态（滚动日志 / PID）
└── README.md
```

## 资源副本生成（部署前必跑，否则资源端点全 404）

`backend/deploy/resources/` 是**构建产物**（已 gitignore），里面是 `miniprogram/` 包内
图片的**服务端副本**。`resource_asset.file_path` 相对这个目录，`GET /api/v1/resources/{key}`
就是从这里流式读文件 —— **目录不存在或为空，端点全部 404**（应用启动时还会因
`app.resources.dir` 校验失败而直接起不来）。

```bash
# ① 盘点：列出新增 / 内容变更 / 副本缺失（不写文件）
python tools/resource-import.py --check

# ② 生成：复制服务端副本 + 生成 Flyway 迁移（INSERT 新增 + UPDATE 内容变更）
python tools/resource-import.py --write --version <下一个版本号>

# ③ 重启后端让 Flyway 执行
start-all.bat restart

# ④ 四方对账（DB / 副本 / 包内源 / 前端 icons 引用）
python tools/check-resource-consistency.py
```

**要点**：
- `--check` 检测到差异时退出码为 **2**（不是失败，是"有待处理变更"）；缺失/重复/mime 非法为 **1**。
- 换图标流程：改 `miniprogram/assets/icons/*.png`（或 `icons.js` 加键）→ `--write` → 重启。
  脚本对**已登记条目**也会比对 sha256，源变了会覆盖副本并在迁移里生成 `UPDATE` 拉正 `size/sha256`。
- **不要手改** `V*__resource_asset_catalog.sql`，也不要手改副本文件（会被下次 `--write` 覆盖）。
- 包内原件**不移动、不删除**：前端 `bundlePath` 兜底依赖它们（`delivery=local` 的 234 条完全走包内）。

## 故障演练（M4 · D4.1）

对**运行中的三服务**执行真实打停与恢复，验证降级语义（运行态探针为准）：

```text
backend/ai-service/.venv/Scripts/python.exe backend/deploy/scripts/fault_drill.py --deploy backend/deploy --out backend/deploy/run/<目录>
```

矩阵：网关宕→business 直连仍 UP；ai 宕→经网关 TTS 503 `CAPABILITY_UNAVAILABLE`；business 宕→经网关 503 `UPSTREAM_UNAVAILABLE`；
stop-all 后 8000/8001/8088 无 LISTENING 残留；恢复一律走 `start-all.bat` 幂等补起。退出码 0=全绿。
⚠️ 会真实停起服务，勿在联调高峰执行；证据样例 `run/m4-d-side-2026-10-16/`。

## 前端契约验收（docs/前端数据依赖与后端接口需求_20261017.md §7）

```text
backend\deploy\scripts\accept-frontend-contract.ps1            # 启动三服务 → 十条打点 → 汇总
backend\deploy\scripts\accept-frontend-contract.ps1 -SkipStart  # 服务已在跑，只打点
backend\deploy\scripts\accept-frontend-contract.ps1 -StopAfter  # 打点后停服（CI/一次性验证用）
```

- **一条命令内完成启动+验收**：验收必须在同一进程内跑完（子进程随后台命令回收，跨命令端口会消失）。
- 退出码 0 = 十条全通过；1 = 有未通过项（明细看 `run/_accept-frontend-contract.txt`）。
- 判据与文档 §7 逐条对应；`PASS*` = 按文档口径**已声明**的通过项（当前仅第 8 条资源清单）。
- 第 8 条（`/api/v1/resources/manifest` 的 `url`）：**M1 无 CDN，`url` 恒为 null**，A 级资源以 `bundlePath`/`fallbackKey`
  兜底（契约 description 已写明）；脚本判据收敛为「每条要么有 `url`、要么有 `fallbackKey`」，避免把设计取舍误判成失败。
- 第 9 条医生登录依赖 dev 种子 `V9002` 把 `doc-gastro-1` 绑定到 `u-dev-user-2`：`code` 必须含 `dev-user-2`
  （`DevWechatSessionProvider` 约定），否则按"未登记任职关系"返 **403**（这是契约行为，不是缺陷）。

**2026-10-17 实测（本轮修复后）**：10/10 通过 —— 邀请 4 条 / 旧登录 `code=200`+`开发用户甲` / 预约 16 条首条
`location=门诊楼 1F 东区` / `gender=MALE,birthDate=1962-05-12` / 科普 9 条（ARTICLE+VIDEO）/ 科室 15 个（floor 全非空）/
QUICK_SERVICES 8 项 / 清单 7 项（fallbackKey 7、url 0，按设计）/ 医生工作台 summary 四字段齐全 /
`gw/health` = `ok`（upstreams `java,python,ollama`）。原始输出见 `run/_accept-frontend-contract.txt`。

## 排障速查

| 现象 | 处理 |
|---|---|
| `venv 未初始化` | `start-all.bat -Setup -Yes` |
| 双击 `start-gui.bat` 闪退，报「一元运算符"-"后面缺少表达式」/「意外的标记」 | `.ps1` 文件被写了**两个 BOM**（`EF BB BF EF BB BF`）→ 头部 `<#` 注释块失效、注释被当代码解析。修复：把文件另存为「UTF-8 带 BOM」**一次**；校验：文件头应为 `EF BB BF` 后紧跟 `3C 23`（`<#`），第 4 字节不得再是 BOM |
| 启动时提示「日志被占用，本次跳过轮转」 | 上一个实例的 stdout 句柄还持有 `logs\<名>.log`（该句柄不授予 `FILE_SHARE_DELETE`，`Move-Item` 必然失败）。已改为**只告警不中断**，新日志继续追加；若服务随后仍起不来，按端口占用/健康失败处理 |
| 面板「操作输出」出现乱码（如「锛氬彟涓€涓繘绋」） | 旧版把 UTF-8 输出按 GBK 解（读到半个汉字 → 严格解码失败 → 永久锁死 GBK）。现为「编排器输出恒 UTF-8 + 有状态解码 + 尾部残字节留到下一轮」；若仍乱码，那是**服务自身**日志的编码问题，看「服务日志」页签 |
| 面板显示「操作结束：退出码 未知」 | 编排器未回写 `run\_gui-op-rc.txt`（多半是旧版脚本或脚本在写 rc 前被杀）。用 `status.bat` 复核矩阵，或看「操作输出」里的汇总行 |
| 端口占用且健康失败 | `status.bat` 看 PID；用任务管理器/`taskkill` 处理被占端口的**非本工具**进程 |
| `MySQL 不可达` | 启动 MySQL 服务；或核对 `env.local` 的 `MYSQL_HOST/MYSQL_PORT` |
| 启动成功但某服务 FAIL | 看 `logs\<名>.log` 与 `<名>.error.log` 尾部 |
| 报「已添加项。字典中的关键字」 | 旧版 PowerShell 在「环境存在大小写重复变量」时的已知缺陷；脚本启动时已自动合并，正常不应出现，若仍出现请反馈 |
| 业务服务绑定到奇怪端口（如 59981） | 已内置环境泄漏防护（移除 `SERVER__PORT` + 钉住 `SERVER_PORT`）；若仍出现请反馈并附 `logs\business.log` |
| 某服务显示「已在运行…跳过」但你想重启它 | 它多半由**外部实例**提供（如 IDE 里跑着）：本工具不会接管外部进程——请先在外部停掉，再 `start-all.bat` |
| 首装依赖很慢 | `config.json` 的 `pipIndexUrl` 已默认清华镜像；可换/留空用官方源 |

## 验收状态（2026-10-15 · M0 集成门）

- **M1 补记（2026-10-15 01:29–01:34）**：一键启动复跑全绿——真实 business 全链路就绪 3/3（29s）+ 冒烟 2/2 + start/stop 均 `RC=0`；经网关五条 legacy 路径全部实测（真实 MySQL 数据）；证据索引见 `run/m1-2026-10-15/README.md`。
- **全绿终版执行（2026-10-15 01:02–01:06）**：由本工具完整拉起 business（Flyway V1→V2→V9000→V9001 全新应用）——
  SC1 冷启动 `RC=0`（就绪 3/3、28 秒、冒烟 2/2）· SC2 纯幂等 `RC=0`（三项跳过、0 秒）· SC3 杀 ai → 网关 `degraded`（java=true/python=false）→ 恢复 `RC=0` · SC4a/b 前置拦截 `RC=2`（venv 缺失 / MySQL 不可达，零端口占用）· SC5 `RC=0`（端口释放、pid 清空）；**bat 真实入口复跑 start/stop 均 `RC=0`**。
- **证据**：`run/e2e-2026-10-14/_v8r3-*`、`_v8r4-bat-verify.txt`（索引见该目录 `README.md`）；被阻断的中间尝试见 `run/e2e-2026-10-14/blocked-attempts/`。
- **I-3 启动接入契约已核对**：业务服务 `mvnw.cmd spring-boot:run` / `java -jar`、端口 8088、健康 `GET /actuator/health`（`{"status":"UP"}`）；环境变量以 Agent-M 登记的 `MYSQL_URL / MYSQL_USER / MYSQL_PASSWORD`（+ `SERVER_PORT / SPRING_PROFILES_ACTIVE`）为准，见 `env.example`。
- **环境处置记录（2026-10-15）**：dev 库重基线（备份 `_v8r-db-before-rebaseline.sql`，解除新增迁移与已应用 V9000 的 out-of-order）；`wechar_dev` 口令与 `env.local` 对齐（登录验证通过）；工作环境注入的 `SERVER__PORT` 已由脚本内置防护。

## 未完成项

- 不做守护/自动重启；不接管 MySQL 等外部服务生命周期；不做 Linux 版（后续按需）。
- 收尾项（M0 门签署后）：orchestrator 中 venv/MySQL 的旧「逐服务检查」已被全局门覆盖，做减法去掉双语义。
