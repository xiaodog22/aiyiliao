# 前端修复执行记录（阶段二）

> 执行时间：2026-10-22 12:42 — 13:10（GMT+8）
> 分支：`fix/frontend-issues-20261022`（顶层 + 嵌套 `miniprogram` 各一个，均从各自 HEAD 切出）
> 还原点：顶层 `69197a4e`、嵌套 `347254d`；基线补丁 `/tmp/baseline-top.patch`、`/tmp/baseline-mp.patch`
> **提交状态：仅 F-04 完成提交，其余因仓库既有脏改动受阻（见 §5）**

---

## 1. 修复总览

| 编号 | 状态 | 提交 | 改动文件 | 行数 | 回归 |
| --- | --- | --- | --- | --- | --- |
| F-01 | **DONE**（代码）/ 提交受阻 | 无 | 3 | 3 | PASS（`check-exports` + 运行时断言） |
| F-02 | **DONE**（代码）/ 提交受阻 | 无 | 2 页面文件 + 3 测试脚本 | 页面 6 行；测试 5 处 | PASS（57/57、69/69） |
| F-03 | **PARTIAL** | 无 | 4 | 28 | PASS（三档 8/8）；宽屏档未覆盖 |
| F-04 | **PARTIAL**（配置已加，生效性未证实） | `0e806cb9` | 1 | 6 | 无从证明（探针无变化） |
| F-05 | **DONE**（代码）/ 提交受阻 | 无 | 2 | ~40 | PASS（4 场景全验） |
| F-06 | **SKIPPED** | — | 0 | 0 | 仅方案（设计文档 §7） |

---

## 2. 每项修复详情

### F-01 三页 icons 解构错误

**根因**：`utils/icons.js` 导出的是 227 个具名键的映射，没有 `icons` 这一个键；三页 `const { icons } = require(...)` 得到 `undefined`，而三页均 `navigationStyle: custom`，返回箭头正是 `icons.chevronLeft`。

**改动（3 行，每文件 1 行）**

```diff
- const { icons } = require('../../../utils/icons.js')
+ const icons = require('../../../utils/icons.js')
```

文件：`pages/doctor/beds/beds.js:17`、`pages/doctor/personal/personal.js:14`、`pages/profile/voice-settings/voice-settings.js:26`

**验证**

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node tools/check-exports.js` | **0** | `✅ 导入形状与导出名全部对得上` |
| `node tools/check-project.js` | **0** | ③ 图标引用 159 处全部有效；⑤ 禁址 0 命中 |
| 运行时断言（真实 require 三页） | **0** | 三页 `data.icons` 均 `227 键, chevronLeft=/assets/icons/chevronLeft.png` |

运行时断言脚本要点（临时脚本，未入库）：打桩 `wx`/`getApp`/`Page`，`require` 三个页面文件，检查 `cfg.data.icons.chevronLeft` 是 `.png` 路径。修复前三页该值为 `undefined`。

**未做**：真机截图。开发者工具需登录交互，本轮用运行时断言替代；如需人眼确认，扫 `cli.bat preview` 二维码后进三页。

---

### F-02 分页回归门禁失效

**根因（三条，比设计文档多两条）**

1. 页面字段改名未同步测试：`appointments.js` 用 `view`，其余三页与 `paginate()` 用 `displayed`
2. **页面从未提供 `total` 字段**，而测试断言 `total === 45`
3. **测试桩 `setData` 只接一个参数**，吞掉了页面的 `setData(patch, cb)` 回调 —— 挂号页 `onLoad` 用回调触发 `fetch()`，因此取数从未发生，`all` 恒为空。这是"一跑就崩"的真正起点
4. 另有两处测试侧漂移：叫号传 `dataset.index`（页面已改为 `dataset.id`）；床位桩返回 legacy `{list}`（页面读契约 `{beds}`）

**字段决策：统一为 `displayed`**（依据：`paginate()` 返回字段名、4 页中 3 页已是、测试已按此写 → 改 1 页而不是改 3 页 + 改断言）

**改动**

| 文件 | 改动 |
| --- | --- |
| `appointments.js:84` | `view: []` → `displayed: []` |
| `appointments.js:237` | `view: p.displayed` → `displayed: p.displayed`，并新增 `total: p.total` |
| `appointments.wxml:52,53,72` | `{{view` → `{{displayed`（3 处） |
| `beds.js` `_applyFilter` | 新增 `total: p.total`（1 行，对称补齐） |
| `tools/test-pages-paginate.js` | `setData` 桩支持回调（**未改任何断言**）；床位桩改契约形状；叫号/完成改 `dataset.id`；问诊 3 处期望对齐页面现状；1 处断言从 `displayed[0]` 改为按 id 定位 |
| `tools/test-pages-contract.js` | 5 处 `inst.data.view` → `inst.data.displayed` |

**测试改动逐条说明（均为对齐页面，不放宽严格度）**

| 原断言 | 改为 | 依据 |
| --- | --- | --- |
| `displayed[0].status === '就诊中'` | 按 `id==='apt1'` 找到该行再断言 `就诊中` | 页面 `_sortRows` 按状态分组排序，该行会下沉，index 0 不再是它 |
| 问诊 `ACTIVE → 进行中` | `→ 问诊中` | `consultations.js:26` `STATUS_TEXT`，注释写明"设计稿 07 的三个词" |
| 问诊 `CLOSED → 已结束` | `→ 已完成` | 同上；`已结束` 对应 `ARCHIVED` |
| `dateText` 匹配 `yyyy-MM-dd` | 匹配 `yyyy-MM-dd HH:mm` | 页面已带时分；正则仍是全串锚定 |
| 详情 `dataset.index` + `showModal` | `dataset.id` + `navigationTo` 带 `consultationId` | 页面 `onView` 读 `dataset.id` 并 `navigateTo` |

**验证**

| 命令 | 退出码 | 输出 |
| --- | --- | --- |
| `node tools/test-pages-paginate.js` | **0** | `通过 57 / 共 57` |
| `node tools/test-pages-contract.js` | **0** | `通过 69 / 共 69` |
| `node tools/test-fe-paginate.js` | **0** | todo 0 |
| 残留扫描 `{{view` / `data.view` | — | 仅剩 `health-records.wxml:54`（第 5 页，不在白名单，见 §4） |

---

### F-03 适老化字号令牌化

**改动**：4 文件 28 处 `font-size: <n>rpx` → 令牌表达式，保证 standard 档像素不变。

| 文件 | 处数 |
| --- | --- |
| `pages/home/home.wxss` | 4 |
| `pages/appointment/appointment.wxss` | 4 |
| `pages/doctor/appointments/appointments.wxss` | 9 |
| `pages/doctor/beds/beds.wxss` | 11 |

映射：`20→calc(--font-caption - 4rpx)`、`22→-2rpx`、`24→--font-caption`、`26→+2rpx`、`28→calc(--font-body - 2rpx)`、`30→--font-body`、`32→+2rpx`、`34→--font-h2`、`36→+2rpx`、`40→--font-title`、`44→+4rpx`、`48→+8rpx`。

**实测（375 视口，真实 Chrome 计算值；app.wxss + 页面 wxss 内联，rpx 按 0.5 折 px）**

| 元素 | standard | large | xlarge | 判定 |
| --- | --- | --- | --- | --- |
| home 日期大数字 `.apt-date-day` | 20px | 22px | 26px | PASS |
| home 日期小字 `.apt-date-mon` | 10px | 11px | 13px | PASS |
| 挂号统计数字 `.ast-v` | 24px | 26px | 30px | PASS |
| 挂号统计标签 `.ast-label` | 14px | 15px | 18px | PASS |
| 挂号导航标题 `.dapt-nav-title` | 17px | 18px | 21px | PASS |
| 床位统计数字 `.bds-v` | 22px | 24px | 28px | PASS |
| 床位床号 `.bed-no` | 24px | 26px | 30px | PASS |
| 床位统计标签 `.bds-label` | 12px | 13px | 15px | PASS |

**8/8 通过**，且 standard 列与改前硬编码值完全一致（无视觉回归）。

**限制（重要）**：`@media (min-width:600px)` 内仍有约 30 处 `font-size: <n>px` 硬编码（如 `home.wxss:723-725`、`appointments.wxss:222-236`）。这些宽屏覆盖会把令牌效果抵消 —— 在 ≥600px 设备上切三档，字号**不会变**。已实测确认（800px 窗口下三档均为 20px）。属新发现，超出本轮白名单（§4 F-03b）。

---

### F-04 包内混入开发文件

**改动**（`project.config.json`，+6/-1）

```json
"ignore": [
  { "type": "folder", "value": "tools" },
  { "type": "folder", "value": ".trae" },
  { "type": "suffix", "value": ".py" },
  { "type": "suffix", "value": ".md" }
]
```

**验证与结果（结论对我不利，如实记录）**

| 项目 | 改前 | 改后 |
| --- | --- | --- |
| TOTAL | 2,212,496 B | 2,213,111 B |
| main | 1,552,292 B | 1,552,907 B |
| packageContent | 592,941 B | 592,941 B |
| packageNav | 67,263 B | 67,263 B |

main **增加 615 B**，而非下降。原因分析：615 B 与 F-02/F-03 的代码增量吻合（28 处 `calc(...)` 比 `Nrpx` 长），说明 **ignore 规则没有带来体积变化**。

**探针实验（决定性证据）**：临时追加 `{ "type": "folder", "value": "assets/icons" }`（已知 0.77 MB）后再编译，体积**逐字节不变**（2,213,111 / 1,552,907）。若规则生效，main 至少应掉 700 KB 以上。结论：**在 `cli.bat preview` 口径下无法证明 `packOptions.ignore` 生效**，可能被构建缓存命中，或该字段仅对「上传/真机包」生效。

因此 F-04 记为 **PARTIAL（配置已加，生效性未证实）**，不宣称降体。需要人工在开发者工具「详情 → 本地设置 → 上传时压缩/忽略」或解包真机包核对。

---

### F-05 资源链接门禁环境依赖

**改动**

1. `tools/test-resource-links.js`：新增 `--strict`；`main()` 开头加 5s 探活；不可达时输出 `[SKIP]` + `结果：SKIPPED（目标不可达，非用例失败）` + `exit 0`；`--strict` 时 `exit 1`
2. `tools/test-fe-all.js`：识别 `结果：SKIPPED`，单列 `SKIP` 计数，**不计入 PASS 也不计入 FAIL**，汇总行改为「新增失败 / 环境跳过 / 登记在案失败」

**四场景验证**

| 场景 | 命令 | 退出码 | 输出 |
| --- | --- | --- | --- |
| 隧道不可达（默认） | `node tools/test-resource-links.js` | **0** | `[SKIP] 目标不可达：https://qv56gv32944.vicp.fun（fetch failed）` / `结果：SKIPPED` |
| 强制校验 | 加 `--strict` | **1** | `结果：FAIL（--strict 已开启：目标不可达即判失败）` |
| 本地网关可达 | `--base http://127.0.0.1:8080` | **0** | `PASS 16 · FAIL 0`（含 ETag `304✓` 复用） |
| 汇总口径 | `node tools/test-fe-all.js` | **0** | `SKIP test-resource-links.js（环境不可达，未执行；不计 PASS/FAIL）` |

---

## 3. 回归对比表

| 指标 | 修复前 | 修复后 | 变化 | 结论 |
| --- | --- | --- | --- | --- |
| 门禁 13 项（pass/fail/skip） | 10 / 3 / 0 | **12 / 0 / 1** | +2 pass，-3 fail | 达标（skip 不计通过） |
| `node:test` | 71/71 | 71/71 | 不变 | PASS |
| `check-exports` | EXIT=1，3 处不一致 | **EXIT=0** | 修复 | PASS |
| `test-pages-paginate` | EXIT=1 崩溃 | **EXIT=0，57/57** | 修复 | PASS |
| `test-pages-contract` | EXIT=0，69/69 | EXIT=0，69/69（曾因改名短暂 60/69，已同步） | 不变 | PASS |
| `test-resource-links` | EXIT=1，FAIL 16 | **SKIP（exit 0）**；本地 base 下 16/16 PASS | 语义修正 | PASS |
| `check-v4-docs` / `check-v4-prototypes` | KNOWN-FAIL | KNOWN-FAIL | 不变 | 登记在案 |
| 接口探测 | 32 项，28 符合 / 4 漂移 | **32 项，逐条状态码完全一致** | 无变化 | 无回归 |
| 真实编译 main | 1,552,292 B | 1,552,907 B | **+615 B** | 未超限（余 26%） |
| 总包 | 2,212,496 B | 2,213,111 B | +615 B | 未超限 |
| 响应式 24 组 | 18 通过 / 6 失败 | 18 通过 / 6 失败 | 通过数不变；**无横向溢出** | 失败项同前，且为断言过期 |
| banner 插画占卡高（1920） | 0.25 | **0.69** | 改善（字号变化带来） | 仍 < 0.95 断言 |
| 宽屏三档字号 | 未测 | **不生效**（px 覆盖） | 新发现 | 见 §4 F-03b |

---

## 4. 未修复项与原因

| 项 | 状态 | 原因 | 后续 |
| --- | --- | --- | --- |
| **F-03b 宽屏 px 覆盖** | 未修 | 约 30 处 `font-size: <n>px` 位于 `@media (min-width:600px)`，会把三档字号钉死。改动会动到已验收的宽屏版式，超出本轮白名单 | 下一轮：按同样映射改成 `calc(var(--font-*) ± Npx)`，逐档截图 |
| F-03 剩余 53 处（登录页为主） | 未修 | 35 处在 4 个登录页 + auth-common，改字号会动登录版式，需单独回归窗口 | 单独一轮 |
| **第 5 页 `view` 命名** | 未修 | `health-records.wxml:54` 也用 `view`，但该页不在"四页"白名单 | 建议纳入下一轮统一 |
| F-06 图标裁剪 | 仅方案 | 需人工确认 147 键 + 逐页走查，漏检即裂图 | 见设计文档 §7 |
| 宽屏 banner 插画 | 未修 | 断言期望 ≥0.95 属设计口径，需产品确认是"断言过期"还是"真缺陷" | 见测试报告 §6.3 |
| 真机截图 | 未做 | 需开发者工具登录 + 扫码，无法脚本化 | 人工补 |

---

## 5. 提交受阻说明（关键）

**F-01 / F-02 / F-03 / F-05 未提交。** 不是遗漏，是仓库现状不允许"一项一提交"：

| 仓库 | 阻断原因 | 证据 |
| --- | --- | --- |
| 嵌套 `miniprogram` | 三个页面文件与挂号页**本身就有大量未提交改动**，我的修复夹在其中。基线补丁里 `beds.js` 已有 741 行改动，且 `+const { icons } = ...` 正是那批未提交工作引入的。单独提交必然裹入他人 561~741 行 | `/tmp/baseline-mp.patch` |
| 顶层 `tools/` | `test-pages-paginate.js` 有 132 行**既有未提交改动**（非本次）；`test-resource-links.js`、`test-fe-all.js`、`test-pages-contract.js` 处于**未跟踪**状态，提交即"首次入库整个文件" | `git diff --stat`、`git status --porcelain` |

**已发生的处置（需你知情）**：F-04 首次提交时，索引里已有**此前被暂存的 117 个文件**，被一并带入（9454 行）。发现后已 `git reset --soft HEAD~1` + `git restore --staged .` 撤回重做，只提交 `project.config.json` 一个文件。那 117 个文件已退回未暂存状态（`??`），**内容未丢失**。副作用：你原先的暂存状态被清空。

**三个可选方案（需你选一个，我才继续提交）**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A（推荐） | 保持现状：代码已修好、回归全绿，提交等你另行处置那批脏改动 | 无 commit 哈希可追溯 |
| B | 把"既有未提交工作"先做一个基线提交，再逐项提交我的 diff | 基线提交含他人 561~741 行，需你认领 |
| C | 我把每项改动导出成独立 patch（`docs/patches/F-0x.patch`），由你择机 `git apply` | 多一套 patch 文件需维护 |

---

## 6. 回滚指引

| 场景 | 命令 |
| --- | --- |
| 撤销 F-04 | `git revert 0e806cb9` |
| 撤销嵌套仓库全部修复（回到本轮开始前） | `git -C miniprogram checkout -- .` **会连同既有 741 行重构一起丢弃，禁止单独使用**；应改用 `git -C miniprogram apply -R /tmp/baseline-mp.patch` 反向应用，或直接从 `/tmp/baseline-mp.patch` 恢复 |
| 撤销顶层全部修复 | `git apply -R /tmp/baseline-top.patch`（同样只回退到本轮开始前） |
| 恢复本轮开始前的完整工作区 | 两个仓库分别 `git apply` 对应基线补丁（补丁只含未提交改动，不含已提交历史） |

> ⚠️ 因为修复落在"未提交状态之上"，**不要用 `git checkout -- <file>` 做单项回滚**，它会把文件退回到 HEAD（缺失那 741 行重构），导致页面直接报错。

---

## 7. 遗留风险

1. **无法逐项回滚**：嵌套仓库的修复没有独立提交，回滚粒度只能到"本轮全部"。这是当前最大工程风险。
2. **F-04 未证实生效**：`packOptions.ignore` 在 CLI 预览下无效，真实上传包是否排除 `tools/` 未知。若无效，主包里仍有 89 KB 开发脚本 + 18 KB 文档。
3. **宽屏三档失效**：平板横屏/桌面微信下，切"放大/超大"字号不变 —— 实测已确认，属面向中老年产品的实质缺陷。
4. **测试桩保真度**：本轮给 `setData` 补了回调支持，但桩仍不模拟渲染时序（回调同步执行）。页面若依赖"回调在渲染后"的行为，桩测不出来。
5. **`check-styles` 不查 CSS 语法**：F-03 改的是 CSS 值，若表达式写错，该门禁不会报错。缓解：本轮用真实 Chrome 计算值实测（8/8），但只覆盖 8 个代表元素。
6. **暂存区被清空**：F-04 重做过程中清掉了你原有的 117 个已暂存文件（内容未丢，状态变为未暂存）。

---

## 8. 本轮产出的临时物（未入库）

| 路径 | 用途 |
| --- | --- |
| `/tmp/baseline-top.patch`、`/tmp/baseline-mp.patch` | 本轮开始前的未提交改动快照（回滚依据） |
| `/tmp/gateout/verify-icons.js` | F-01 运行时断言 |
| `/tmp/gateout/fixfont2.js`、`fixhome.js` | F-03 批量替换（带计数校验） |
| `/tmp/gateout/measure-font.js` | F-03 三档字号实测 |
| `/tmp/gateout/preview6.js` | 六视口排版实测（仓库脚本副本，仅改视口表） |
| `/tmp/gateout/probe.js` | 32 项接口探测 |
| `/tmp/gateout/preview-f04.json` | F-04 编译体积 |

---

## 9. 提交策略与回滚（2026-10-22 18:10 补充）

### 9.1 策略选择：**C + A**

| 方案 | 内容 | 是否采用 |
| --- | --- | --- |
| A | 保持现状，代码已修、回归全绿，不提交 | **采用** |
| B | 先把"既有未提交工作"做成基线提交，再逐项提交我的 diff | 暂不采用，等你确认 741 行归属 |
| C | 每项改动导出独立 patch，由你择机 `git apply` | **采用** |

**选 C+A 的理由**

1. **C 能给出可追溯的粒度，且不污染历史**：4 项修复各自成 patch，反向应用已逐个验证通过（§9.3），想回滚哪项就回滚哪项 —— 这正是 A 方案缺的那一块。
2. **A 避免把别人的 741 行打包进我的提交**：`beds.js` 的 `const { icons } = ...` 本身就是那批未提交重构引入的；若为提交而先做"基线提交"，等于我替他人认领了 561~741 行。
3. **B 的时机取决于你的判断**：那 741 行是否完整、是否该入库，只有你知道。等你确认后再转 B，届时 `docs/patches/F-0x.patch` 可直接 `git apply` 落到正确位置。

### 9.2 patch 清单（`docs/patches/`）

| 文件 | 仓库 | 内容 | 反向校验 |
| --- | --- | --- | --- |
| `F-01.patch` | miniprogram | 3 文件 3 行（icons 整模块引入） | EXIT=0 |
| `F-02-pages.patch` | miniprogram | 3 文件 +10/-6（displayed + total） | EXIT=0 |
| `F-02-tests.patch` | 顶层 | 2 文件 +67/-28（setData 桩、床位桩、断言对齐） | EXIT=0 |
| `F-03.patch` | miniprogram | 4 文件 28 处字号令牌化 | EXIT=0 |
| `F-05.patch` | 顶层 | 2 文件 +37/-5（探活 + SKIP + 汇总分类） | EXIT=0 |
| `workspace-full.patch` | 顶层 | 全部未提交改动（含二进制，18.8 MB） | 未校验（体量大） |
| `workspace-full-miniprogram.patch` | miniprogram | 全部未提交改动（含二进制，1.1 MB） | 未校验 |
| `workspace-untracked.txt` | 两仓库 | 未跟踪文件清单（250 行） | — |
| `baseline-mp.patch` | miniprogram | 本轮开始前快照（112 个文件，完整） | 见 §9.4 |
| `baseline-top.patch` | 顶层 | 本轮开始前快照（**已截断，见 §9.4**） | 不可用 |

应用方式：

```bash
# 嵌套仓库三件套
git -C miniprogram apply ../../docs/patches/F-01.patch
git -C miniprogram apply ../../docs/patches/F-02-pages.patch
git -C miniprogram apply ../../docs/patches/F-03.patch

# 顶层两件
git apply docs/patches/F-02-tests.patch
git apply docs/patches/F-05.patch
```

### 9.3 反向校验（`git apply --check -R`）

| patch | 退出码 |
| --- | --- |
| F-01 | 0 |
| F-02-pages | 0 |
| F-03 | 0 |
| F-02-tests | 0 |
| F-05 | 0 |

### 9.4 基线补丁的真实性（重要）

- `baseline-mp.patch`：112 个 `diff --git`，与嵌套仓库 112 个已跟踪改动文件**数量一致**，判定完整。
- `baseline-top.patch`：**已截断**。它停在 `manual_操作手册待转PDF.docx` 的二进制 hunk（`index 25d204f4..00000000` 后无内容），且 `grep -c "^diff --git a/tools/"` = **0** —— 说明 `tools/` 下所有改动**都不在这份补丁里**。
  原因：生成时 `git diff` 命中 docx 的 textconv 驱动失败（`fatal: unable to read files to diff`），输出被截断，当时的 `wc -c` 只看到 1.3 MB 并未报错。
  **后果**：不能用它回滚顶层 `tools/`。顶层回滚请用 `docs/patches/F-02-tests.patch` 与 `F-05.patch` 的 `-R`。

真实绝对路径（复制前）：`<home>\AppData\Local\Temp\baseline-mp.patch`、`<home>\AppData\Local\Temp\baseline-top.patch`；已复制到 `docs/patches/`。

### 9.5 回滚速查

| 想回滚 | 命令 |
| --- | --- |
| 只撤 F-03 | `git -C miniprogram apply -R docs/patches/F-03.patch` |
| 只撤 F-01 | `git -C miniprogram apply -R docs/patches/F-01.patch` |
| 只撤 F-02 | `git -C miniprogram apply -R docs/patches/F-02-pages.patch` + `git apply -R docs/patches/F-02-tests.patch` |
| 只撤 F-05 | `git apply -R docs/patches/F-05.patch` |
| 撤 F-04 | `git revert 0e806cb9` |
| 撤回本轮全部 | 按上面四项逐个 `-R` |

> ⚠️ 仍禁止 `git checkout -- <file>`：会把文件退回 HEAD，丢掉那 741 行既有重构。

---

## 10. 补证结果（2026-10-22 18:00–18:30）

### 10.1 A 组：HEAD 状态

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| `git stash list` | 两仓库均**无 stash** | 空输出 |
| F-01 的 `const { icons } = ...` 是否在 HEAD | **不存在** | `git show HEAD:pages/doctor/beds/beds.js` 第 9 行已是 `const icons = require(...)`；`voice-settings.js` 第 12 行同 |
| 那它从哪来 | **仅存在于工作区**，由 10-21/22 那批未提交页面重构引入 | `git diff HEAD` 中该行为 `+`；且基线补丁 `beds.js` 有 741 行改动 |
| `personal.js` | HEAD 里**完全没有 icons**（旧版是演示页），icons 是工作区新加的 | `git show HEAD:pages/doctor/personal/personal.js` 仅 4 个 require，无 icons |
| `test-pages-paginate.js` | HEAD 中 `inst.setData = (patch) => {`（单参数）**已存在**，即"吞回调"缺陷在 HEAD 就有；但 HEAD 的页面不用 setData 回调，所以 HEAD 时门禁是绿的 | `git show HEAD:tools/test-pages-paginate.js:94` |

**含义**：F-01 的修复不是"改回旧写法"，而是把工作区重构里写错的导入恢复成与 HEAD 一致的形状；F-02 的桩缺陷是历史遗留，被新的 `setData(cb)` 写法触发。

### 10.2 D 组：补证

**F-01 截图 —— BLOCKED**

已完成的自动化链路（可复现）：

```bash
"D:/OpenWeChar/微信web开发者工具/cli.bat" islogin          # {"login":true}
"D:/OpenWeChar/微信web开发者工具/cli.bat" auto --project <mp> --auto-port 9420   # √ auto
npm i miniprogram-automator        # 0.13.0，装到临时目录
node shot.js                       # automator.connect 成功、evaluate 成功
```

受阻点：
- `miniProgram.reLaunch(route)` 抛 `Uncaught [object Object]`（错误对象不可读），页面停在登录页/空白；
- `miniProgram.screenshot({path})` 存在但**永不 resolve**（IDE 内项目未进入编译态，模拟器区是欢迎面板）。

已保留证据图：`docs/shots/F-01-BLOCKED-devtools-empty.png`（可看到 IDE 里项目未编译）。
**未产出三页有效截图，不冒充通过。**

人工补图命令（IDE 打开项目、模拟器出画面后）：

```bash
"D:/OpenWeChar/微信web开发者工具/cli.bat" open --project <mp>
# 在 IDE 中手动进入 床位管理 / 医生个人管理 / 音色管理，各截一张
# 或：node tools/preview-pad-pages.js  # 仅版式，不含图标（图片路径不解析）
```

**F-03b 800px 实测（已执行）**

| 元素 | 375px：std / large / xlarge | 800px：std / large / xlarge |
| --- | --- | --- |
| `.apt-date-day` | 20 / 22 / 26 px（PASS） | 20 / 20 / 20 px（**FAIL**） |
| `.apt-date-mon` | 10 / 11 / 13 px | 10 / 10 / 10 px |
| `.ast-v` | 24 / 26 / 30 px | 24 / 24 / 24 px |
| `.ast-label` | 14 / 15 / 18 px | 14 / 14 / 14 px |
| `.dapt-nav-title` | 17 / 18 / 21 px | 17 / 17 / 17 px |
| `.bds-v` | 22 / 24 / 28 px | 22 / 22 / 22 px |
| `.bed-no` | 24 / 26 / 30 px | 24 / 24 / 24 px |
| `.bds-label` | 12 / 13 / 15 px | 12 / 12 / 12 px |
| 通过率 | **8/8** | **0/8** |

**F-03b 范围（29 处 `font-size: <n>px`，全部在 `@media (min-width:600px)` 内）**

| 文件 | 处数 |
| --- | --- |
| `pages/home/home.wxss` | 3（:723-725） |
| `pages/appointment/appointment.wxss` | 6（:614-634） |
| `pages/doctor/appointments/appointments.wxss` | 9（:222-236） |
| `pages/doctor/beds/beds.wxss` | 11（:343-385） |
| **合计** | **29** |

**F-02 覆盖范围**

`test-pages-paginate.js` 只加载 4 页（appointments / beds / consultations / records，见 :252/:306/:320/:356），`grep -c health-records` = **0**。所以：
- 第 5 页 `health-records.wxml` 的 `view` 命名**不在分页契约测试覆盖内**；
- 因此不改它也不影响 57/57；
- 已单列 **F-02b**（不改代码，仅登记）：`health-records.wxml:54` 的 `{{view}}` 与 `paginate()` 的 `displayed` 语义分叉，建议下一轮与其余四页统一。

### 10.3 C 组：状态修正

| # | 修正 |
| --- | --- |
| 9 | F-04：DONE → **PARTIAL（配置已加，生效性未证实）** |
| 10 | 门禁 skip 1 项 = `test-resource-links.js`；原因 = 目标 `https://qv56gv32944.vicp.fun` 探活 5s 失败（`fetch failed`），按 F-05 语义记 SKIP，不计 PASS/FAIL |
| 11 | 接口"34→32"：**32 才是实际条目数**（A 6 + B 6 + C 3 + D 2 + E 3 + F 3 + G 3 + H 6 = 32）。上一轮报告写 34 属计数错误（把分组标题行计入），本轮更正；状态码分布 17×200 / 1×400 / 2×401 / 2×403 / 5×404 / 2×422 / 3×501，修复前后逐条一致 |
| 12 | 响应式两次均 18/24 的原因：6 个失败**全部是 home 页的两条几何断言** —— ①常用服务"四宫格行数=2（期望1）"，该区 8 个条目每行 4 个必然 2 行，属断言过期；②banner 插画占卡高 <0.95。F-03 只改字号，不改变行数判定；banner 比值虽从 0.25 升到 0.69（宽度 1920），仍低于阈值。故通过数不变，与 F-03 无因果关系 |
| 13 | 第 5 页选 **F-02b 单列**（理由见 §10.2 末） |
