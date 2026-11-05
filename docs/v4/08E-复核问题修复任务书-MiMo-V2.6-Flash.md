# 08E - 复核问题修复任务书（MiMo 执行 · Agent-D 复验）

> 编号：08E ｜ 日期：2026-10-15 ｜ 状态：**待 MiMo 执行**
> 来源：MiMo 三项复核问题分析（网关白名单 21 条 / resource.js 字段 / dev 密码）→ Agent-D 核实（§1）→ 本任务书
> 执行：**MiMo-V2.6-Flash** ｜ 复验：**Agent-D（DeepSeek-V4.1-Flash）**（交叉审计：M 执行、D 复核）
> 关联：M1 集成门验收单 `08D`；证据目录 `backend/deploy/run/fix-2026-10-15/`（新建）

---

## 0. 摘要（执行者先读）

| 编号 | 修复项 | 涉及文件 | 目标（硬标准） |
|---|---|---|---|
| **F1** | 网关路由语义对齐（文档 ×3 + 门禁工具重写） | `AI_CONTEXT.md`、`README.md`、`miniprogram/config/api.js`、`tools/check-v4-contracts.js` | 契约门禁 `warnings=1 → 0`，且负向测试可证新校验有效 |
| **F2** | `resource.js` 字段对齐契约 | `miniprogram/services/resource.js` | 字段与 `ResourceManifest` 契约逐一对齐，旧字段名 0 残留 |
| **F3** | 凭据口径核验 | —（**零改动**，核验关闭） | 三条硬证据记录在案（§4） |

**执行顺序**：F1 → F2 → F3（F3 仅确认，不写码）。全部完成后按 §8 填回执，交 Agent-D 复验。

---

## 1. 核实结论（Agent-D，2026-10-15）

MiMo 分析的**根因判断全部成立**；其中两处修复策略经数据核验后**修正**（修正理由见下，执行时以本任务书为准）。

### 1.1 问题 1（网关白名单冲突 · 21 条）——成立，修复策略修正 ⚠️

**已核实的事实（与 MiMo 一致）**：
- 实跑 `node tools/check-v4-contracts.js`：`CONTRACT_CHECK_OK business=48 ai=5 ops=59 uniqueOperationIds=59 warnings=1`，RC=0。单条 warning 内含 **21 条**路径（auth×3、me、doctor/login、departments… 起）。
- 21 条分解经逐条验算与数据吻合：**4 条跨行误报**（`/api/v1/bed|doctor/**` 因原文跨行被正则丢弃 → doctor/login、doctor/list、doctor/by-department、bed/update/{id} 冤报）+ **2 条复数缺口**（`/api/v1/doctors/{id}/slots`、`/api/v1/beds` 匹配不上单数前缀）+ **15 条真文档漂移**（其余）。
- `backend/edge-gateway/app/main.py` 代码面核实：`/api/gw/**` 网关自身，其余 `/api/**` **全量代理 business-service**（`forward(..., settings.business_url)`）；全仓库 `JAVA_PREFIXES` 仅存在于**旧文档**（AI_CONTEXT §0 / 根 README / api.js 注释 / edge-gateway README 对比处 / 08A），**代码零命中**。新网关不向客户端暴露 ai-service（仅健康探针抽查 `/internal/health/live`）。

**修正点（执行依据）**：
1. ❌ 不采用"修正则跨行 + 补复数前缀"的治标方案——因为该 warning 的**推理前提本身已失效**：V4 网关不做上游白名单分流，"其余 /api/** → Python 会被转错"这一推论不成立。正确做法 = **§2.5 将工具中白名单校验段整体重写为 V4 语义校验**。
2. ❌ 不做"路径在哪个契约里 base 就=什么"的强映射校验——现状存在 **8 条合法过渡态**（4 条 base=python 已收敛到 business 契约：`voice/asr`、`voice/tts`、`voice/voices`、`voice/voices/default`；4 条 base=java 仍为 legacy：`doctor/list`、`doctor/by-department`、`/api/appoint/updateStatus`、`/api/v1/bed/update/{id}`），强映射会制造新的 false positive。只保留**零误伤**校验（base 枚举 + gateway 形状）。
3. ✅ "§0 改写为新路由语义"采纳，范围扩展：同类旧语义还存在于 `README.md`（28/29/34 行）与 `api.js` 头注释（4-7/13-16 行），一并对齐。
4. ❌ "挂进启动前门禁"**本次不采纳**：会把 node+PyYAML 依赖引入一键启动前置链（缺失即服务起不来，失败模式代价高），属架构级变更应另案评估；维持"验收时手工跑"的既有惯例（M0/M1 均如此）。

### 1.2 问题 2（resource.js 字段）——成立，两处补充/修正

**已核实的事实（与 MiMo 一致）**：
- 契约 `business-openapi.yaml` L2420-2449：`items[]` 必填 `key/level/mime/size/sha256`，另有 `url/version/expiresAt/fallbackKey`；`level` 为 A/B 枚举。
- `miniprogram/services/resource.js` L27-36 读取的是 `item.fallback`（→ 应为 `fallbackKey`）、`item.bytes`（→ `size`）、`item.critical`（→ `level`）——三个名字全错，逐行核实无误。

**修正点（执行依据）**：
1. 措辞修正：MiMo 称"sha256 也没读"——**半对**。`sha256: item.sha256 || ''`（L32）**已读取并存储**；缺的是契约要求的**下载后校验动作**（全项目无下载链路，属后续项，本次除外）。`version` 确实未读，本次补上。
2. "把响应字段比对纳入门禁"**不采纳**（工具-前端字段耦合过重、无法低成本严格化）；替代 = 代码内注释锚定契约 + 本任务书字段对照表（§3.1）复验。
3. 补充事实（MiMo 未标注，影响验收方式）：`resource.js` **当前无任何调用方**（全项目 grep：无 require 引用、storage key `wb_resource_manifest` 仅本文件）→ 影响面为"潜伏缺陷（未触发）"，无需热迁移；但因无运行时链路，验收以**静态**为主（见 §3.4）。
4. 范围收敛：`level` 降级策略执行、sha256 实际校验 → **除外**（无消费方 / 无链路，登记 TODO 注释即可）。

### 1.3 问题 3（dev 密码）——成立，但**无需修复**（零改动关闭）

**已核实的硬证据（比 MiMo 的判读更强）**：
- `backend/deploy/env.local` L10：`MYSQL_PASSWORD=<dev 口令，已脱敏>`；
- **实测连库**：`mysql.exe -h 127.0.0.1 -u wechar_dev wechar_dev -e "SELECT 1"` → `ok=1`，schema 14 表（口令即 <dev 口令，已脱敏>，与 env.local 一致）；
- `DEV_LOG.md` L4257 坑 6 记录属实（任务书早期给的 `WcDev_2026_local` 曾被库拒）；
- **`WcDev_2026_local` 在现行文档中已无残留**（`docs/v4/`、`backend/` 全文 grep 仅命中 DEV_LOG 历史条目本身）。

**修正点（执行依据）**：
- ❌ "改任务书/文档为 <dev 口令，已脱敏>"**不采纳**——**口令值不得写入任何入库文档**（dev 弱口令 + 隧道公网可达场景下这是安全红线）；单一事实源 = `env.local`（不入库）+ 本机库实际。
- ❌ "三处原子切换"不需要——现状本已一致。
- 附注：本工作目录（含三层父目录）**无 git 仓库**，"env.local 不入库"现阶段无风险载体；未来建仓时以 `.gitignore` 保证（登记为注记，不在本次范围）。

### 1.4 共同根因点评（Agent-D）

MiMo 的"多份事实源各自演化"判断成立，更精确的表述：**V4 架构升级（网关语义换代 + 契约化）已完成实现面，但历史描述性文档与新增工具校验未同步退役——旧模型的投影仍在新体系里活跃**。修复方向 = 让每一份事实源显式收敛到 V4 语义（文档改叙述、工具改校验、旧词只保留"已废弃"对比语境）。

---

## 2. F1 修复任务：网关路由语义对齐

### 2.1 唯一事实（所有修改以此为准）

> V4 网关（`backend/edge-gateway`）：`/api/gw/**` 网关自身；其余 `/api/**` **全量代理 business-service（8088）**；ai-service（8001）**仅内网可达**（`/internal/**`），客户端不直连；上游编排在 business-service 内部完成；迁移期旧路径经网关兼容层翻译（`backend/edge-gateway/COMPAT.md`）；**旧 `JAVA_PREFIXES` 白名单模型已废弃**。

### 2.2 修改一：`AI_CONTEXT.md` §0（原 L62-64）

原文（3 行，整段替换）：

```text
⚠️ 0. 统一网关路由（《前端适配说明》§2）：/api/gw/** 网关自身；/api/v1/bed|doctor/**、
      /api/appoint/**、/api/user/**、/api/health/plan/** → Java；其余 /api/** → Python。
      Python/Java 都占 /api/v1，网关靠后端 JAVA_PREFIXES 白名单区分。
```

目标文本（按此落地，可微调标点，语义不得变）：

```text
⚠️ 0. 统一网关路由（V4 · edge-gateway）：/api/gw/** 网关自身；其余 /api/** 全量代理
      business-service(8088)，不再按旧 JAVA_PREFIXES 白名单分流；ai-service(8001) 仅内网可达
      （/internal/**），客户端不直连。迁移期旧路径经网关兼容层翻译（backend/edge-gateway/COMPAT.md）。
```

> 落地后通读该节，确认无其他"→ Java / → Python / 白名单"类旧述残留。

### 2.3 修改二：`miniprogram/config/api.js` 头注释

**（a）** 原 L4-7：

```text
 * base 取值与含义（统一网关版 · 2026-09-10）：
 *   'gateway'    网关自身路由（/api/gw/**）
 *   'python'     → 网关转发到 Python FastAPI（导诊/问诊/养生/语音/音色）
 *   'java'       → 网关转发到 Java Spring Boot（挂号/医生/床位/用户）
```

目标：

```text
 * base 取值与含义（V4 网关 · 2026-10-15 修订）：
 *   'gateway'    网关自身路由（/api/gw/**）
 *   'python'     AI 能力产出（导诊/问诊/养生/语音/音色；V4 经 business 编排，客户端不直达）
 *   'java'       Spring Boot 业务产出（挂号/医生/床位/用户）
```

**（b）** 原 L13-16：

```text
 * ⚠️ 网关白名单提醒（说明 §2）：Python 与 Java 都占 /api/v1 前缀，靠后端白名单区分：
 *    /api/v1/doctor/**、/api/v1/bed/** → Java
 *    /api/v1/case/**、/api/v1/voice/**、/api/v1/consultation/** → Python
 *    新增同名叶子路径时需后端在 gateway/server.py 的 JAVA_PREFIXES 补白名单。
```

目标：

```text
 * ⚠️ V4 网关路由：/api/gw/** 归网关自身；其余 /api/** 全量代理 business-service（统一出口，
 *    不再按旧 JAVA_PREFIXES 白名单分流）。base 仅表达"该能力最终由哪个上游产出"（供排查对照）。
 *    迁移期旧路径由网关兼容层翻译（backend/edge-gateway/COMPAT.md）；新增路径按契约登记
 *    （backend/contracts/），不得绕过网关。
```

### 2.4 修改三：`README.md`

**（a）** 原 L28（组件表行"统一网关 :8000"最后一格）：

```text
| 按 `/api/gw/**`、`/api/v1/bed|doctor/**`、`/api/appoint/**`、`/api/user/**` 路由转发 | ✅ 对照《前端适配说明》2026-09-10 |
```

目标：

```text
| V4 路由：`/api/gw/**` 网关自身；其余 `/api/**` 全量代理 business-service（不再按旧白名单分流） | ✅ 对照 V4 `backend/edge-gateway`（2026-10-15） |
```

**（b）** 原 L29（组件表行"Python FastAPI :8001"第三格）：

```text
| 由网关转发（**前端禁止直连/禁止出现 8001**） | ✅ |
```

目标：

```text
| 仅内网可达，由 business-service 编排调用（**前端禁止直连/禁止出现 8001**） | ✅ |
```

**（c）** 原 L34（关键契约第 1 条）整条替换：

```text
1. ⚠️ **前端只维护 `gateway` 一个地址**；`request.js` 里 base 取值 `gateway`/`python`/`java` 三者解析出的都是同一 `ENV.gateway`（base 仅表达"该能力最终由哪个上游产出"）。V4 网关下 `/api/gw/**` 归网关自身、其余 `/api/**` 全量代理 business-service；ai-service 仅内网可达。新增路径按契约登记，旧 `JAVA_PREFIXES` 白名单模型已废弃。
```

### 2.5 修改四：`tools/check-v4-contracts.js` §⑤ 重写

**删除**：现 L331-360 整段（`// 网关白名单：…` 注释起，到 `if (ctx) { … }` 块结束）——含 `const ctx = read(CONTEXT)`、`javaPrefixes` 正则解析、orphans 校验与对应 warning。若确认 `CONTEXT` 常量（L28）无其他引用，一并删除（先 grep 验证）。

**替换为**（行为规格，代码风格自定；参考结构如下）：

```js
// V4 网关语义：/api/gw/** 网关自身；其余 /api/** 全量代理 business-service。
// base 表达"该能力最终由哪个上游产出"，不再是路由分流依据（旧 JAVA_PREFIXES 白名单已废弃）。
// 校验：base 取值合法；base=gateway 的路径必须以 /api/gw/ 开头且已在 business 契约登记。
const BASE_ENUM = ['gateway', 'java', 'python']
const bizPaths = new Set(
  Object.keys((business && business.doc && business.doc.paths) || {}).map(norm)
)
for (const [p, e] of uniq) {
  const where = `api.js ${p}（base=${e.base}）`
  if (!BASE_ENUM.includes(e.base)) { fail(`${where}: base 取值非法`); continue }
  if (e.base === 'gateway') {
    if (!p.startsWith('/api/gw/')) fail(`${where}: base=gateway 但路径不属于 /api/gw/**`)
    else if (!bizPaths.has(norm(p))) fail(`${where}: base=gateway 但未在 business 契约登记`)
  }
}
```

**设计说明（重要，防止过度实现）**：
- `base='java'/'python'` 与契约归属**不做映射强校验**：其一，归属完整性已由 L310-313"每条路径必须有归属（契约或 x-migration）"覆盖；其二，现状 8 条合法过渡态（§1.1 修正点 2）会被强映射误伤。**不得**实现"base 与契约一一对应"类规则。
- 输出格式、退出码语义（fail→RC=1；warning 不阻断）保持不变。修改后其余输出应与基线逐字符一致，仅 `warnings=1 → 0`。

### 2.6 F1 验收

1. `node tools/check-v4-contracts.js` → 预期：`CONTRACT_CHECK_OK business=48 ai=5 ops=59 uniqueOperationIds=59 warnings=0`、RC=0、**无任何 `!` 行**。
2. `node tools/check-v4-docs.js` → 预期 `DOC_CHECK_OK routes=24 prompts=24 docs=7 warnings=0`、RC=0（回归确认）。
3. **负向测试（必做，证明新校验不是空摆设）**——两阶段，四步：
   - **注入**：在 `api.js` 网关段附近**新增两行**（不动任何现有条目）：
     ```js
     const NEG_TEST_A = { base: 'gw2', path: '/api/v1/contents' }              // NEGATIVE-TEST 枚举违例
     const NEG_TEST_B = { base: 'gateway', path: '/api/v1/triage/recommendations' } // NEGATIVE-TEST 形状违例
     ```
   - **验证**：跑工具 → 预期 RC=1、恰好报 **2 个 `✗`**（含义：base 取值非法 ×1；base=gateway 但路径不属于 /api/gw/** ×1）。
   - **还原**：用精确 Edit **删除这两行**（禁止 sed/脚本批量替换），`node --check miniprogram/config/api.js` 通过。
   - **复跑**：再跑工具 → 回到全绿 `warnings=0`、RC=0（还原干净）。
4. 语境审计：全仓库 grep `JAVA_PREFIXES` → 该词只允许出现在"已废弃 / 与旧对比"语境；禁止出现在"现行路由规则"陈述中。（允许出现：`backend/edge-gateway/README.md`、`docs/v4/08A`、本任务书 08E；`AI_CONTEXT.md`/`README.md`/`api.js` 修改后的文本中如保留该词，必须带"已废弃/不再"字样。）

---

## 3. F2 修复任务：`resource.js` 字段对齐

### 3.1 契约字段对照表（唯一事实源：`business-openapi.yaml` L2420-2449）

| 契约字段 | 必填 | 前端现状（L27-36） | 修正后 |
|---|---|---|---|
| `key` | ✅ | `item.key` ✅ | 保持 |
| `level`（A/B） | ✅ | ❌ 读 `item.critical`（布尔） | `level: item.level \|\| ''` |
| `mime` | ✅ | `item.mime` ✅ | 保持 |
| `size` | ✅ | ❌ 读 `item.bytes` | `size: Number(item.size \|\| 0)` |
| `sha256` | ✅ | 已存但无校验（除外项） | 保持存储 |
| `url` | — | `item.url` ✅ | 保持 |
| `version` | — | ❌ 未读 | `version: item.version \|\| ''` |
| `expiresAt` | — | `item.expiresAt` ✅ | 保持 |
| `fallbackKey` | — | ❌ 读 `item.fallback` | `fallbackKey: item.fallbackKey \|\| ''` |

### 3.2 改动点（精确）

1. **L27-36** `saveManifest` 的 item 映射：按 §3.1"修正后"列改写（字段顺序建议与契约一致；`fallback`/`bytes`/`critical` 三个旧名**彻底移除**）。
2. **L57** `resolveResource`：`builtinFallback || (item && item.fallback) || ''` → `builtinFallback || (item && item.fallbackKey) || ''`。
3. **L64** `fallbackFor`：`(item && item.fallback) || builtinFallback || ''` → `(item && item.fallbackKey) || builtinFallback || ''`。
4. **缺字段断言**（不阻断，模块"绝不阻断"原则）：映射前逐项检查 required 五字段（key/level/mime/size/sha256），缺失时 `console.warn('[resource] manifest item 缺字段: <字段名>（key=<item.key>）')`，不 throw、不改变返回值。
5. **缓存键升级**：`MANIFEST_KEY` 由 `'wb_resource_manifest_v1'` → `'wb_resource_manifest_v2'`；`saveManifest` 成功保存后执行一次 `wx.removeStorageSync('wb_resource_manifest_v1')`（清理旧字段形状缓存；加一行注释）。
6. **文件头注释**增补两行（锚定契约 + 登记 TODO）：
   ```text
   * 字段形状以 backend/contracts/business-openapi.yaml ResourceManifest 为唯一事实源
   *   （key/level/mime/size/sha256 必填；url/version/expiresAt/fallbackKey 可选）。
   * TODO(接入下载链路时)：按契约实现 sha256 下载后校验（校验失败回退内置或上一有效版本）。
   ```

### 3.3 除外项（不得实现）

- `level` 降级策略执行（当前无消费方；仅存字段）。
- sha256 实际校验动作（无下载链路；仅 TODO 注释）。
- 不改任何其他前端文件。

### 3.4 F2 验收

1. `node --check miniprogram/services/resource.js` → RC=0。
2. `node tools/check-require.js` → `RESULT: REQUIRE_OK`（基线：49 个 js / 83 处 require）。
3. `node tools/check-exports.js` → 全部对得上（基线：49 个 js）。
4. 旧字段名残留 grep：`resource.js` 内 `item.fallback`（独立出现，允许 `fallbackKey`）/ `item.bytes` / `item.critical` / `fallback:` / `bytes:` / `critical:` → **0 处**。
5. 调用方复核：grep 全项目 `services/resource` 的 require → 仍为 0（与基线一致，不引入新调用方）。
6. （**可选，推荐尝试**）用一个临时 node 脚本 mock `wx`（getStorageSync/setStorageSync/removeStorageSync）跑 `saveManifest(契约样例) → readCachedManifest() → fallbackFor()` 字段链路断言；若依赖链（request.js）mock 成本过高，超过合理时间即放弃、改静态复核，**不阻塞**。临时脚本用完删除或存入证据目录。

---

## 4. F3 核验关闭项：凭据口径（零改动）

- 不写任何代码、不改库、不改 env.local、不改文档。
- 执行者义务：复核 §1.3 的三条证据仍成立（env.local=<dev 口令，已脱敏>；库可连；无 `WcDev_2026_local` 残留），并在回执中确认。
- 若发现任何不符，**停止并回报**，不得自行切换口令。

---

## 5. 除外项汇总（明确不做）

1. 不改 `backend/contracts/*.yaml`（冻结）、不改 `edge-gateway` 代码/`COMPAT.md`、不改 `business-service`/`ai-service` 代码、不改 `deploy` 脚本。
2. 不改 08A/08B/08C/08D 历史文档、不改 `DEV_LOG.md` 历史条目（新增记录只允许追加）。
3. 不实现 sha256 校验、level 策略、不做"响应字段比对进工具"、不挂 deploy 启动前门禁（均见 §1/§2 修正理由）。
4. 不动版本号（本轮为修复轮，`APP_VERSION` 维持 `0.1.0-m1`）。

---

## 6. 总验收标准与证据落盘

**基线（Agent-D 已实测，2026-10-15 上午）→ 目标**：

| 检查 | 基线（修复前） | 目标（修复后） |
|---|---|---|
| `tools/check-v4-contracts.js` | `…warnings=1`、RC=0（21 条警告） | `…warnings=0`、RC=0 |
| 负向注入（两行） | — | RC=1、恰好 2 个 `✗`；还原后复跑全绿 |
| `tools/check-v4-docs.js` | `DOC_CHECK_OK … warnings=0`、RC=0 | 不变 |
| `tools/check-require.js` | `REQUIRE_OK`（49 js/83） | 不变 |
| `tools/check-exports.js` | 全对（49 js） | 不变 |
| `node --check resource.js` | RC=0 | RC=0 |

**证据目录（新建）**：`backend/deploy/run/fix-2026-10-15/`，建议文件：

- `01-contract-check-after.txt`（修复后全绿输出）
- `02-contract-check-negative.txt`（负向注入输出）
- `03-contract-check-restored.txt`（还原后全绿复跑）
- `04-doc-check-after.txt`
- `05-front-guards.txt`（node --check + check-require + check-exports 输出）
- `06-grep-audit.txt`（JAVA_PREFIXES 语境审计 + resource 旧字段 0 残留）

所有文本证据以 UTF-8 落盘（PowerShell 用 `Out-File -Encoding UTF8`）。

---

## 7. 约束与纪律

1. **编码**：所有被编辑文件保持 UTF-8（无 BOM）；不要给 `.js`/`.md` 引入 BOM。
2. **编辑纪律**：同一文件多处修改**串行**执行（防并发 Edit 竞态丢失）；用精确 Edit，不用 sed/脚本批量替换。
3. **工具链**：若 PATH 无 node，用 `C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`；契约工具依赖 Python+PyYAML（本机 `D:\anaconda3.0\python.exe` 可用）。
4. **不改历史**：所有"修复后"结论以新证据+回执记录，不得回改既有验收单/日志。
5. **范围锁定**：只做 F1/F2/F3 定义的动作；发现新问题→记录到回执"遗留观察"，不顺手修。

---

## 8. 回执与签署

### 8.1 MiMo 执行回执（执行者填写）

| # | 项 | 结果 | 证据指针 |
|---|---|---|---|
| F1 | 文档 ×3 对齐 | ☑ | `AI_CONTEXT.md` §0 三行整段替换为 V4 语义（无旧述残留，grep 核验）；`miniprogram/config/api.js` 头注释 (a)(b) 两块替换（负向测试注入行已精确删除，残留 0）；`README.md` L28/L29/L34 三处按 §2.4 目标文本落地 |
| F1 | 工具 §⑤ 重写 | ☑ | `backend/deploy/run/fix-2026-10-15/01-contract-check-after.txt`（warnings=0、RC=0、无 `!` 行）/ `02-…` / `03-…` |
| F1 | 负向测试（注入→验证→还原→复跑） | ☑ | `02-contract-check-negative.txt`（RC=1、恰好 2 个 `✗`：枚举违例 ×1 + 形状违例 ×1）→ 精确 Edit 删两行 → `03-contract-check-restored.txt` 复跑全绿（warnings=0、RC=0） |
| F1 | JAVA_PREFIXES 语境审计 | ☑ | `06-grep-audit.txt`：修改的 3 文件均带"已废弃/不再"字样，允许清单合规 |
| F2 | 字段对齐 + 断言 + 缓存键升级 | ☑ | `05-front-guards.txt`（node --check RC=0）、`06-grep-audit.txt`；缓存键升 `wb_resource_manifest_v2` 并 `removeStorage` 旧 v1；`07-resource-mock-test.js` mock 链路断言 `MOCK_TEST_OK`（saveManifest→readCachedManifest→fallbackFor/resolveResource + 缺字段告警） |
| F2 | 旧字段名 0 残留 / 无新调用方 | ☑ | `06-grep-audit.txt`：`item.fallback`/`item.bytes`/`item.critical`/`fallback:`/`bytes:`/`critical:` 全部 0 处；`services/resource` require 仍为 0（与基线一致） |
| F3 | 三条证据复核确认 | ☑ | 三条证据复核仍成立：① `env.local` `MYSQL_PASSWORD=<dev 口令，已脱敏>` ✓ ② 实测连库 `SELECT 1`=1、schema 14 表 ✓ ③ `WcDev_2026_local` 在现行文档/配置中 0 残留——全仓 grep 仅 3 处命中，全部位于本任务书 08E 自身 L56/L57/L261（§1.3 核实结论的叙述性引用，非现行配置残留），按 §4 在回执中确认关闭（零改动）。证据：`08-f3-credential-evidence.txt` |
| — | 其余守卫（docs/require/exports）无回归 | ☑ | `04-doc-check-after.txt`（DOC_CHECK_OK routes=24 prompts=24 docs=7 warnings=0）/ `05-front-guards.txt`（REQUIRE_OK 49 js/83、check-exports 全对 49 js） |

遗留观察（若有）：
1. `.workbuddy/memory/MEMORY.md:20` 与 `.workbuddy/memory/2026-10-15.md` 仍为旧白名单语义陈述（`JAVA_PREFIXES` 分流式表述）——**不属 08E 任务书修改清单，按 §7.5 范围锁定未改**，登记为遗留观察，建议后续（Agent-D 或另案）决定是否收敛。
2. 基线复跑 `node tools/check-v4-docs.js` 与契约工具输出均与 §6 基线逐项对照一致（仅 `warnings=1 → 0` 差异，符合"其余输出逐字符一致"要求）。

### 8.2 Agent-D 复验签署（复验者填写）

- 复验执行：**☑ 已复验（2026-10-15 16:07–16:20）** ｜ 复验结论：**☑ 通过**
- 复验要点：基线逐项复跑对照 / 负向测试有效性抽查 / 范围外改动扫描（契约、网关代码、历史文档零触碰）
- 复验记录：
  1. **修改文件逐行核验**（非仅看回执打勾）：`check-v4-contracts.js` §⑤（现 L330-347：`BASE_ENUM` 枚举 + gateway 形状/契约登记校验；原白名单段与 `CONTEXT` 常量已删除；归属/僵尸条目/迁移目标/internal 禁入校验原样保留；输出格式与退出码语义未变）；`AI_CONTEXT.md` §0（L62-64 与 §2.2 目标文本一致）；`README.md` L28/29/34 与 §2.4 一致；`api.js` L4-7/L13-16 与 §2.3 一致；`resource.js`（9 字段契约名对齐 + `REQUIRED_FIELDS` 缺字段告警不抛错 + 缓存键 `wb_resource_manifest_v2` 并清理 v1 + `resolveResource`/`fallbackFor` 均改读 `fallbackKey` + 头部契约锚定与 sha256 TODO）——与 §3.2 六项改动点逐项吻合。
  2. **守卫复跑**（证据 `09-d-reverify-guards.txt`）：`CONTRACT_CHECK_OK business=48 ai=5 ops=59 uniqueOperationIds=59 warnings=0`、RC=0（与修复前基线逐字符一致，仅 warnings 1→0）；`DOC_CHECK_OK … warnings=0`；`REQUIRE_OK`(49 js/83)；check-exports 全对；`node --check` resource.js/api.js RC=0；**独立复跑 mock 测试** `MOCK_TEST_OK`、RC=0。
  3. **负向测试独立复现**（证据 `10-d-reverify-negative.txt` / `11-d-reverify-restored.txt`）：注入 NEG_TEST_A/B → `CONTRACT_FAIL 2 处问题`（base 取值非法 ×1 + base=gateway 形状违例 ×1）、RC=1 → 用精确 Edit 还原 → 复跑全绿 `warnings=0`、`NEG_TEST` 残留 0、api.js 语法 OK——新校验被证明真实有效，非空摆设。
  4. **范围外改动扫描**（证据 `12-d-scope-audit.txt`）：契约 yaml(10-14 20:56)、edge-gateway 代码(01:23-01:27)、COMPAT.md(01:27)、ai-service 代码(01:22)、deploy 脚本(01:02)、08A-08D(≤02:06)——全部在 08E 执行窗口（10:46-10:53）之外，**零越界改动**。
  5. **JAVA_PREFIXES 复核**：运行时代码（py/java/前端逻辑）**零命中**；工具注释 1 处为"已废弃"对比语境；文档命中（AI_CONTEXT/README/api.js/edge-gateway README/08A/08E/DEV_LOG）全部为"已废弃/不再/与旧对比"语境，合规。
  6. MiMo 遗留观察-1（`.workbuddy/memory/` 内旧白名单语义）→ 由 Agent-D 于本轮（16:20 前后）自行收敛（记忆文件属 Agent-D 维护面，不属业务代码）。
- 复验者：**Agent-D（DeepSeek-V4.1-Flash）**，2026-10-15 16:20
