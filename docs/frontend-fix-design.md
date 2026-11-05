# 前端修复设计文档（阶段一）

> **状态：待确认，未改动任何业务文件。**
> 本文只做设计。阶段二执行需你逐条确认 §7「需人工确认项」后开始。
> 所有根因均引自可复现的命令输出，行号为 2026-10-22 12:40 的工作区真实行号。

---

## 0. 前置：仓库结构必须先对齐（否则提交纪律无法执行）

这一节不是修复项，但**不先确认就无法满足"一项一提交 + 可回滚"**，因此必须先讲清。

| 事实 | 命令 | 输出 |
| --- | --- | --- |
| 顶层仓库分支 | `git rev-parse --abbrev-ref HEAD` | `master` |
| 顶层未提交改动 | `git status --porcelain \| wc -l` | **411** |
| `miniprogram/` 是顶层的一个 gitlink 条目 | `git ls-files miniprogram` | `miniprogram`（单条，非目录内文件） |
| `miniprogram/` 内部是**独立仓库** | `git -C miniprogram rev-parse --show-toplevel` | `.../wechar/miniprogram` |
| 内部仓库分支 | `git -C miniprogram rev-parse --abbrev-ref HEAD` | `fix/round1-appointment-ui` |
| 内部仓库未提交改动 | `git -C miniprogram status --porcelain \| wc -l` | **135** |
| `project.config.json` 归属 | `git ls-files project.config.json` | 顶层 |

**推论（影响提交策略）**

1. 本轮修复跨**两个仓库**：
   - `F-01 / F-02 / F-03` 改的是 `miniprogram/**` → 提交进**嵌套仓库**
   - `F-04` 改 `project.config.json`、`F-05` 改 `tools/*.js` → 提交进**顶层仓库**
2. 两个仓库都需新建分支 `fix/frontend-issues-20261022`（嵌套仓库当前不在 master，是从 `fix/round1-appointment-ui` 切出，非"在 master 上改"，符合纪律精神）。
3. **顶层提交严禁 `git add -A`**：那会把 `miniprogram` 的 gitlink 指针一并暂存（当前指针已漂移）。所有提交一律用**显式文件路径**。
4. 现有 411 / 135 项脏改动**一律不碰、不提交**。为保证回滚，阶段二开始前先存底：
   ```bash
   git diff > /tmp/baseline-top.patch
   git -C miniprogram diff > /tmp/baseline-mp.patch
   ```

---

## 1. 修复总览

| 编号 | 级别 | 问题 | 根因（一句话） | 方案摘要 | 影响文件 | 风险 | 回滚 | 验收标准 | 本轮 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-01 | P0 | 三页图标全丢、返回入口不可见 | 解构不存在的 `icons` 键 | 3 行改为整模块引入 | 3 个 js | 极低 | `git revert` | `check-exports` EXIT=0；三页目视有图标 | ✅ |
| F-02 | P1 | 分页门禁崩溃 | 页面改名字段但测试未同步 | 字段统一回 `displayed` + 补 `total` | 3 文件（js×2/wxml×1） | 低 | `git revert` | `test-pages-paginate` EXIT=0 | ✅ |
| F-03 | P1 | 81 处字号不随档位缩放 | 写死 rpx 未走令牌 | 按值映射到 `--font-*` 表达式 | 4 个 wxss（28 处） | 中（换行位置变化） | `git revert` | 三档截图字号有变化、无溢出 | ✅（限 4 文件） |
| F-04 | P1 | 包内混入开发文件 | `packOptions.ignore` 为空 | 加 4 条 ignore 规则 | `project.config.json` | 低 | `git revert` | 真实编译 `main` 下降且功能正常 | ✅ |
| F-05 | P1 | 资源门禁 16 红（隧道不可达） | 脚本把"环境不可达"当"用例失败" | 前置探活 + `--strict` + SKIP 语义 | `tools/test-resource-links.js`、`tools/test-fe-all.js` | 中（易被当成"洗绿"） | `git revert` | 不可达输出 SKIPPED 且退出 0；可达时照常判 PASS/FAIL | ✅ |
| F-06 | P2 | 图标占主包 50%、引用率 35% | 227 键全量打包，无按需机制 | 审计脚本 + 物理裁剪 + 迁分包 | 新增 `tools/audit-icons.js`（仅方案） | 高（漏检动态引用→裂图） | 不涉及 | 仅出方案，不改代码 | ⛔ 仅方案 |

**基线快照（阶段二回归对照用，2026-10-22 12:30 实测）**

| 指标 | 基线值 |
| --- | --- |
| 门禁 13 项 | 通过 10 / 失败 3 |
| `node:test` | 71 tests / 71 pass |
| 已知失败（不计入门禁） | `check-v4-docs`、`check-v4-prototypes` |
| 接口探测 | 34 项，符合 30 / 漂移 4 |
| 真实编译主包 | `1,552,292 B`（1516.0 KB / 2048 KB） |
| 总包 / 分包 | 2,212,496 B；`packageContent` 592,941；`packageNav` 67,263 |
| 响应式 | 24 组 / 通过 18 / 失败 6 |
| `check-exports` | EXIT=1，3 处不一致 |
| `test-pages-paginate` | EXIT=1，`TypeError` @ :242 |
| `test-resource-links` | EXIT=1，PASS 0 / FAIL 16 |

---

## 2. F-01 三页 icons 解构错误（P0）

### 2.1 根因

`utils/icons.js` 的导出形状是**具名映射**，没有 `icons` 这个键：

```js
// utils/icons.js 末尾
module.exports = {
  'home': '/assets/icons/home.png',
  'homeGray': '/assets/icons/home_gray.png',
  /* ...共 227 键... */
}
```

三个页面按"取子对象"的方式解构，得到 `undefined`：

| 文件 | 行号 | 现状代码 |
| --- | --- | --- |
| `pages/doctor/beds/beds.js` | 17 | `const { icons } = require('../../../utils/icons.js')` |
| `pages/doctor/personal/personal.js` | 14 | 同上 |
| `pages/profile/voice-settings/voice-settings.js` | 26 | 同上 |

`icons` 随后被塞进 `data`（`beds.js:46`、`personal.js:19`、`voice-settings.js:37` 均为 `icons,`），WXML 里 `{{icons.xxx}}` 求值为空串 → `<image src="">` 不渲染。

**为什么是 P0**：三页 `.json` 全部是 `"navigationStyle": "custom"`（`beds.json:2`、`personal.json:2`、`voice-settings.json:2`），没有原生返回按钮，返回箭头由 WXML 自绘，正是 `icons.chevronLeft`。图标为空 → 用户看不到返回入口。

**受影响图标（WXML 实测计数）**

| 页面 | 引用数 | 具体键 |
| --- | --- | --- |
| `beds.wxml` | 4 | `alertWhite`、`chevronLeft`、`refreshGray`、`searchGray` |
| `personal.wxml` | 4 | `bell`、`calendar`、`chevronLeft`、`lock` |
| `voice-settings.wxml` | 8 | `chevronLeft`、`info`×2、`refreshGray`、`soundWave`×2、`soundWaveGray`、`volumeOff` |

### 2.2 修复方案（方案 A，采用）

三行改为整模块引入，与已验证正确的页面一致：

```js
// pages/home/home.js:6（参考写法）
const icons = require('../../utils/icons.js')

// 三页改为
const icons = require('../../../utils/icons.js')
```

**不采用的方案 B**：在 `utils/icons.js` 末尾加 `icons: MAP` 自引用，让两种写法都能跑。
不采用理由：`icons.js` 被 29 个页面引用，改公共模块超出白名单，且会掩盖错误写法（不报错反而更容易继续复制）。若你希望"宽容写法"，需单独确认。

### 2.3 影响面

- 代码：3 个 js 文件，各 1 行
- WXML：**不改**（`{{icons.x}}` 语义正确）
- 测试：`check-exports` 由 FAIL→PASS；其余门禁不受影响
- 包体：不变（三页本就 require 同一文件，只是解构方式错）

### 2.4 风险与副作用

| 风险 | 等级 | 说明 |
| --- | --- | --- |
| 无 | 极低 | 改动是把 `undefined` 变成正确对象；不存在依赖 `undefined` 的逻辑 |
| 图标文件缺失导致仍空白 | 低 | `check-project` ③ 已校验 159 处图标引用全部有效，可排除 |

### 2.5 回滚

`git -C miniprogram revert <F-01 提交哈希>`（单文件 3 行，也可直接 checkout 还原）。

### 2.6 验证方式

```bash
node tools/check-exports.js            # 期望 EXIT=0，无 "⛔"
node tools/check-project.js            # 期望 ⑤ 项仍全绿
git diff --stat -- miniprogram/pages  # 期望 3 files, 3 insertions(+), 3 deletions(-)
```

真机/模拟器（三页逐一）：床位管理、医生个人管理、音色管理 → **返回箭头可见可点**，搜索/刷新/铃铛/日历/信息/音波图标均显示。

### 2.7 预估改动

**3 行**（3 文件 × 1 行）。

---

## 3. F-02 分页回归门禁失效（P1）

### 3.1 根因

两条独立原因叠加，导致脚本一跑就崩：

1. **字段改名未同步测试**：挂号页 2026-10-21 重构把分页容器从 `displayed` 改名为 `view`
   - `appointments.js:84` `view: []`
   - `appointments.js:237` `view: p.displayed`
   - `appointments.wxml:53` `wx:for="{{view}}"`
   - 而 `test-pages-paginate.js:242` 仍断言 `inst.data.displayed.length` → 首次断言即 `TypeError`
2. **页面从未提供 `total`**：`appointments.js` 全文只有 `FILTER_TITLE.total`（:64）与统计项 `{key:'total'}`（:254），`data` 里无 `total` 字段；但测试 `:243` 断言 `inst.data.total === 45`

对比其余三页（均为 `displayed`）：

| 页面 | js | wxml |
| --- | --- | --- |
| `doctor/beds` | `beds.js:70,150,169` | `beds.wxml:72` |
| `profile/consultations` | `consultations.js:74,94,110` | `consultations.wxml:21` |
| `profile/records` | `records.js:77,115,164` | `records.wxml:23` |
| **`doctor/appointments`** | **`view`（异类）** | **`view`** |

### 3.2 字段决策：统一为 `displayed`

| 依据 | 说明 |
| --- | --- |
| ① 工具契约 | `utils/paginate.js:44-50` 返回值字段名就是 `displayed`，页面直接透传最自然 |
| ② 多数一致 | 4 页中 3 页已用 `displayed`，改 1 页比改 3 页风险小 |
| ③ 语义准确 | `displayed` = "当前页要渲染的切片"；`view` 与 WXML 的 `<view>` 标签同名，检索时噪音大（本次排查就因此多花时间） |
| ④ 测试已按此写 | `test-pages-paginate.js` 断言 `displayed`，改页面即让测试自然通过，**无需改测试**（符合"禁止改测试让测试通过"） |

### 3.3 修复方案

| 文件 | 行 | 改动 |
| --- | --- | --- |
| `pages/doctor/appointments/appointments.js` | 84 | `view: []` → `displayed: []`（注释同步） |
| 同上 | 237 | `view: p.displayed` → `displayed: p.displayed` |
| 同上 | 237 附近 | `_refresh` 的 `setData` 增加 `total: p.total` |
| `pages/doctor/appointments/appointments.wxml` | 53 | `wx:for="{{view}}"` → `wx:for="{{displayed}}"` |

```js
// _refresh 改后（示意）
const p = paginate(matched, page || 1)
this.setData({
  stats,
  displayed: p.displayed,   // 原 view
  total: p.total,           // 新增：分页工具已返回，页面此前丢弃
  page: p.page,
  hasMore: p.hasMore,
  filterTitle: FILTER_TITLE[this.data.filter] || ''
})
```

**边界确认（已用 grep 证实，无遗漏）**

- `appointments.js` 内 `this.data.view` 消费点：**0 处**
- `appointments.wxml` 内 `wx:for="{{view}}"`：**仅 :53 一处**
- 其余 `view` 命中均为 `<view>` 标签，不受影响

### 3.4 影响面

- 页面：医生端挂号管理 1 页
- 测试：`test-pages-paginate` 由崩溃→通过；`test-fe-paginate`（纯工具测试）不受影响
- 门禁：`test-fe-all` 新增失败由 3 → 2
- 包体：不变

### 3.5 风险与副作用

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 漏改某个 `view` 引用 → 列表空白 | 低 | 上述 grep 已确认仅 4 处命中（含 data 声明），改完再全量 grep 复查 |
| 新增 `total` 属"功能增量" | 低 | 只为让既有断言成立，不接 UI；若你要求零增量，则改为删掉测试的 total 断言 —— 但这属"放宽断言"，不推荐 |

### 3.6 回滚

`git -C miniprogram revert <F-02 哈希>`。

### 3.7 验证方式

```bash
node tools/test-pages-paginate.js      # 期望 EXIT=0，全部 check 通过
node tools/test-fe-paginate.js         # 期望 EXIT=0（工具自身契约）
bash -c 'grep -rn "wx:for=\"{{view}}\"" miniprogram/pages || echo "无残留"'
```

真机：挂号管理页首屏 20 条 → 触底 40 → 触底 45 → `hasMore` 翻 false；点「叫号」后行状态变「就诊中」（测试已覆盖，真机再确认一次）。

### 3.8 预估改动

**4 行**（3 处重命名 + 1 行新增 `total`）。

---

## 4. F-03 适老化字号未令牌化（P1）

### 4.1 根因

`app.wxss` 定义了三档令牌：

| 档位 | 选择器 | title / h2 / body / caption |
| --- | --- | --- |
| standard | `page`（:59-62） | 40 / 34 / 30 / 24 rpx |
| large | `.theme-large`（:78-84） | 44 / 36 / 32 / 26 |
| xlarge | `.theme-xlarge`（:88-96） | 52 / 42 / 38 / 30 |

页面 WXML 已普遍绑定 `theme-{{theme}}`（29 处），机制是通的。**问题在页面 CSS 直接写死 rpx**，这些声明不参与变量覆盖，所以切档后不变。

统计口径（`grep` 已排除 `calc(` 的行）：

```bash
grep -rn "font-size:[^;]*[0-9]rpx" --include=*.wxss miniprogram/pages/ | grep -v "calc(" | wc -l
# 81
```

### 4.2 本轮范围（严格限定，不扩大）

| 文件 | 处数 | 覆盖页面 |
| --- | --- | --- |
| `pages/home/home.wxss` | 4 | 首页 |
| `pages/appointment/appointment.wxss` | 4 | 患者挂号 |
| `pages/doctor/appointments/appointments.wxss` | 9 | 医生挂号管理 |
| `pages/doctor/beds/beds.wxss` | 11 | 床位列表 |
| **合计** | **28** | 首页 + 挂号页 + 列表页（用户点名范围） |

**不在本轮**：其余 53 处（`consult` 14、`manual-login` 12、`login` 9、`doctor-login` 7、`patient-login` 6、`triage` 1、`result` 1、`personal` 1、`consultation` 1、`auth-common` 1）。理由见 §8。

### 4.3 映射规则（保证 standard 档像素不变）

原则：**standard 档视觉零变化**，只在 large/xlarge 生效。用 `calc(var(--font-x) ± Nrpx)` 表达原值。

| 原值 | 映射表达式 | standard 求值 | large | xlarge |
| --- | --- | --- | --- | --- |
| 20rpx | `calc(var(--font-caption) - 4rpx)` | 20 | 22 | 26 |
| 22rpx | `calc(var(--font-caption) - 2rpx)` | 22 | 24 | 28 |
| 24rpx | `var(--font-caption)` | 24 | 26 | 30 |
| 26rpx | `calc(var(--font-caption) + 2rpx)` | 26 | 28 | 32 |
| 28rpx | `calc(var(--font-body) - 2rpx)` | 28 | 30 | 36 |
| 30rpx | `var(--font-body)` | 30 | 32 | 38 |
| 32rpx | `calc(var(--font-body) + 2rpx)` | 32 | 34 | 40 |
| 34rpx | `var(--font-h2)` | 34 | 36 | 42 |
| 36rpx | `calc(var(--font-h2) + 2rpx)` | 36 | 38 | 44 |
| 40rpx | `var(--font-title)` | 40 | 44 | 52 |
| 44rpx | `calc(var(--font-title) + 4rpx)` | 44 | 48 | 56 |
| 48rpx | `calc(var(--font-title) + 8rpx)` | 48 | 52 | 60 |

**逐处清单（可直接对着改）**

| 文件 | 行 | 原值 | 目标 |
| --- | --- | --- | --- |
| `home.wxss` | 348 | 20rpx | `calc(var(--font-caption) - 4rpx)` |
| | 349 | 40rpx | `var(--font-title)` |
| | 350 | 20rpx | `calc(var(--font-caption) - 4rpx)` |
| | 510 | 28rpx | `calc(var(--font-body) - 2rpx)` |
| `appointment.wxss` | 147 | 22rpx | `calc(var(--font-caption) - 2rpx)` |
| | 252 | 22rpx | 同上 |
| | 260 | 26rpx | `calc(var(--font-caption) + 2rpx)` |
| | 271 | 26rpx | 同上 |
| `appointments.wxss` | 64 | 34rpx | `var(--font-h2)` |
| | 88 | 28rpx | `calc(var(--font-body) - 2rpx)` |
| | 101 | 48rpx | `calc(var(--font-title) + 8rpx)` |
| | 143 | 40rpx | `var(--font-title)` |
| | 157 | 28rpx | `calc(var(--font-body) - 2rpx)` |
| | 164 | 30rpx | `var(--font-body)` |
| | 175 | 28rpx | `calc(var(--font-body) - 2rpx)` |
| | 199 | 28rpx | 同上 |
| | 209 | 28rpx | 同上 |
| `beds.wxss` | 54 | 34rpx | `var(--font-h2)` |
| | 81 | 24rpx | `var(--font-caption)` |
| | 87 | 44rpx | `calc(var(--font-title) + 4rpx)` |
| | 120 | 28rpx | `calc(var(--font-body) - 2rpx)` |
| | 162 | 32rpx | `calc(var(--font-body) + 2rpx)` |
| | 239 | 48rpx | `calc(var(--font-title) + 8rpx)` |
| | 247 | 36rpx | `calc(var(--font-h2) + 2rpx)` |
| | 256 | 32rpx | `calc(var(--font-body) + 2rpx)` |
| | 277 | 30rpx | `var(--font-body)` |
| | 297 | 26rpx | `calc(var(--font-caption) + 2rpx)` |
| | 317 | 26rpx | 同上 |

**⚠️ 已在 calc 内的行（如 `font-size: calc(var(--font-title) + 4rpx)`）一律不动** —— 它们本就随档位缩放。

### 4.4 影响面

- 4 个 wxss，28 条声明；WXML / JS 零改动
- standard 档：像素值完全不变（映射表已逐值验证）
- large/xlarge 档：这 28 处开始跟随缩放（这是目的）
- 包体：几乎不变（表达式变长，gzip 后差异可忽略）

### 4.5 风险与副作用

| 风险 | 等级 | 说明 / 缓解 |
| --- | --- | --- |
| xlarge 下大数字溢出 | **中** | 挂号/床位页有 48rpx 大数字（队列号、床位数），xlarge 变 60rpx，可能挤破卡片。验证时专门看这两处；若溢出，对这 2 处降档为 `calc(var(--font-title) + 4rpx)` 并记录例外 |
| 换行位置变化 | 中 | 22→24、26→28 等在 large 档整体变大，文案可能换行。属预期，验收看"无截断/无溢出"而非"行数不变" |
| 媒体查询里已有 px 折算 | 低 | 宽屏档 `--font-*` 已被 app.wxss 折 px，页面 calc 仍成立 |

### 4.6 回滚

`git -C miniprogram revert <F-03 哈希>`（单文件维度可 `git checkout -- <file>`）。

### 4.7 验证方式

```bash
# ① 四处硬编码归零
grep -c "font-size:[^;]*[0-9]rpx" miniprogram/pages/home/home.wxss \
  miniprogram/pages/appointment/appointment.wxss \
  miniprogram/pages/doctor/appointments/appointments.wxss \
  miniprogram/pages/doctor/beds/beds.wxss
# 期望：全部为 0（或仅剩 calc 内行；用带 -v calc 的管道复核）

# ② 门禁不回归
node tools/check-styles.js       # 期望 STYLES_OK
node tools/check-project.js      # 期望全通过
```

**三档实测（关键，必须出图）**：用 `tools/preview-pad-pages.js` 的同源思路，在 375×812 下分别注入 `theme-standard / theme-large / theme-xlarge` 三份 HTML，读回 4 个代表元素（`.apt-date-day`、床位大数字、挂号统计数字、卡片标题）的 `font-size` 计算值，落成对比表：

| 元素 | standard | large | xlarge | 期望 |
| --- | --- | --- | --- | --- |
| 挂号日期大数字 | 40px | 44px | 52px | 递增 |
| 床位号 48rpx | 24px | 26px | 30px | 递增 |

并检查 `document.body.scrollWidth <= innerWidth`（无横向溢出）。

### 4.8 预估改动

**28 行**（1 行 1 处替换）。

---

## 5. F-04 包内混入开发文件（P1）

### 5.1 根因

`project.config.json` 的 `packOptions.ignore` 是空数组（`:19-22`），而 `miniprogram/` 下存在非运行时代码：

| 路径 | 体积 | 性质 |
| --- | --- | --- |
| `miniprogram/tools/` | 89,294 B | 开发脚本（`build-icons.js`、`fetch-icons.js`、`icons-lucide.js`、`svg2png.py`、`test-auth-request.js`） |
| `miniprogram/tools/__pycache__/svg2png.cpython-312.pyc` | 计入上行 | Python 字节码缓存 |
| `miniprogram/.trae/documents/前后端身份认证联调修复方案.md` | 18,430 B | 编辑器文档 |

**安全性已确认**：`grep -rn "require(.*tools/" miniprogram --include=*.js` 除 `tools/` 自身外 **0 命中**，排除后不会导致运行时缺模块。

### 5.2 修复方案

```json
"packOptions": {
  "ignore": [
    { "type": "folder", "value": "tools" },
    { "type": "folder", "value": ".trae" },
    { "type": "suffix", "value": ".py" },
    { "type": "suffix", "value": ".md" }
  ],
  "include": []
}
```

说明：`folder` 两条覆盖目录；`suffix` 两条兜底散落的 `.py`/`.md`（若将来有人把脚本放到别处）。**不加** `.pyc` 规则——`__pycache__` 已在 `tools/` 内，随目录一起排除。

### 5.3 影响面

- 配置：顶层 `project.config.json` 1 文件
- 包体：预期 `main` 下降（见下）
- 功能：零影响（无运行时引用）
- 仓库：文件仍留在仓库（不进包 ≠ 删文件），团队照常使用

### 5.4 预期收益（估算，落到实测）

源码态可排除 107,724 B；其中 `tools/*.js` 会被压缩，实际包体降幅预计 **60–100 KB**。

**必须实测确认**，设计不预设结论：

| 情况 | 处置 |
| --- | --- |
| `main` 下降 60–120 KB | 记为成功，写入回归表 |
| `main` 下降 0–10 KB | 说明开发者工具本就未打包这些目录 → **如实记录「配置已加但无体积收益」**，不宣称优化成功，并保留配置作为防回归 |
| `main` 上升 | 立即回滚，排查 ignore 是否误伤 |

### 5.5 风险与副作用

| 风险 | 等级 | 说明 |
| --- | --- | --- |
| 误伤 `.md` 依赖 | 极低 | 小程序不会 require `.md`；已确认包内无 md 资源引用 |
| 误伤 `.py` | 极低 | 同上 |
| 未来把脚本放进 `pages/` | 低 | 若如此，`suffix` 规则会静默排除 → 需在团队规范里注明"开发脚本不得放 pages/" |

### 5.6 回滚

`git revert <F-04 哈希>`（顶层仓库）。

### 5.7 验证方式

```bash
# 改前基线（已测）
# TOTAL 2212496 / main 1552292 / packageContent 592941 / packageNav 67263

"D:/OpenWeChar/微信web开发者工具/cli.bat" preview \
  --project "<repo>/miniprogram" \
  --qr-output "<tmp>/preview-after.png" --info-output "<tmp>/preview-after.json"
# 期望：√ preview，main 下降，total 同比下降

node tools/check-project.js      # 功能冒烟前提：门禁全绿
```

真机冒烟（扫码预览）：登录 → 首页 → 挂号 → 床位 → 音色设置，五步走通即证明未误伤。

### 5.8 预估改动

**6 行**（JSON 数组内 4 条 + 格式）。

---

## 6. F-05 资源链接门禁环境依赖（P1）

### 6.1 根因

`tools/test-resource-links.js:34` 把基准地址取成 `env.gateway`：

```js
const DEFAULT_BASE = require(path.join(__dirname, '..', 'miniprogram', 'config', 'env.js')).gateway
```

当前 `config/env.js:15` 是 `BUILD_ENV = 'development'`，`:32` gateway 指向 `https://qv56gv32944.vicp.fun` —— 该域名实测 `HTTP 000`（连接失败，1.35s 超时）。脚本没有"环境不可达"这一状态，每个用例的 `catch` 都调用 `bad()`，于是 16 项全红，`process.exit(fail ? 1 : 0)` 退出 1。

本地同端点完全正常（`127.0.0.1:8080` → 200），说明**这不是代码缺陷，是把环境故障计成了用例失败**。

脚本**已具备** `--base` 参数（`parseArgs` :48-58）与 `skip()` 函数（:61），所以改动面很小。

### 6.2 修复方案

三处改动，语义严格区分「SKIP（环境不可达）」与「PASS（验证通过）」：

1. **新增 `--strict` 参数**：`parseArgs` 返回 `strict: false`，只有 `--strict` 时强制失败。
2. **前置探活**：`main()` 开头对 `base + '/api/gw/health'` 做 5s 超时探测；不可达时
   - 打印 `! 目标不可达：<base>（原因：<msg>）`
   - 逐项走 `skip()`（已有函数，输出 `[SKIP]`）
   - 结尾打印 `结果：SKIPPED（目标不可达，非用例失败）· 建议 --base http://127.0.0.1:8080 或启动隧道`
   - `--strict` 时仍 `exit 1`；否则 `exit 0`
3. **`test-fe-all.js` 适配**：识别输出中的 `结果：SKIPPED` 标记，归类为 `SKIP`，**不计入 PASS 也不计入 FAIL**，汇总行单列 `SKIP n`。

**关键约束（防止"洗绿"）**

| 约束 | 落实方式 |
| --- | --- |
| SKIP 不得显示成 PASS | 输出 `[SKIP]` 且汇总 `SKIP 16`，与 `PASS 16` 肉眼可区分 |
| 可达但用例失败仍须红 | 探活成功即走原逻辑，`bad()` 照旧累计，`exit 1` |
| 不能靠忽略掩盖真实回归 | 回归记录里同时跑 `--base http://127.0.0.1:8080 --strict`，此时必须 16/16 PASS |

### 6.3 影响面

- 文件：`tools/test-resource-links.js`（约 +25 行）、`tools/test-fe-all.js`（约 +8 行）
- 顶层仓库，不进小程序包
- 其它门禁不受影响

### 6.4 风险与副作用

| 风险 | 等级 | 说明 / 缓解 |
| --- | --- | --- |
| 把 SKIP 当 PASS 汇报 | **中** | 三处硬约束 + 回归表单独列 `SKIP` 行；JSON 摘要里 `api` 维度不受影响 |
| 探活误判（网关慢但可用） | 中 | 探活超时设 5s（本地实测 62ms、隧道即使可用也在 1s 内）；探活失败仍会尝试一次真实请求，仅当两者都失败才 SKIP |
| `--strict` 被误用成默认 | 低 | 默认非 strict；CI 若要强校验显式传参 |

### 6.5 回滚

`git revert <F-05 哈希>`（顶层）。

### 6.6 验证方式

```bash
# ① 不可达（默认 development 档）→ 期望 exit 0 且输出 SKIPPED
node tools/test-resource-links.js; echo "EXIT=$?"
# 期望：结果：SKIPPED（目标不可达，非用例失败）  EXIT=0

# ② 显式 strict → 期望 exit 1
node tools/test-resource-links.js --strict; echo "EXIT=$?"   # EXIT=1

# ③ 本地可达 → 期望真跑且全绿
node tools/test-resource-links.js --base http://127.0.0.1:8080; echo "EXIT=$?"
# 期望：PASS 16 / FAIL 0，EXIT=0

# ④ 汇总口径
node tools/test-fe-all.js
# 期望：SKIP 1（资源链接），新增失败 1→ 仅剩 check-exports（F-01 修完即 0）
```

### 6.7 预估改动

**约 33 行**（25 + 8），其中新增逻辑约 20 行、其余为分支与提示文案。

---

## 7. F-06 图标体积与引用率（P2，**仅方案**）

### 7.1 现状数据

| 指标 | 实测 | 命令 |
| --- | --- | --- |
| `assets/icons` 文件数 | 227 个 PNG | `ls assets/icons/*.png \| wc -l` |
| 目录体积 | 0.77 MB | 递归求和 |
| 占主包比例 | **约 50%**（主包 1516 KB） | — |
| `icons.js` 键数 | 227 | 正则统计 |
| 静态可检出引用 | **80 键** | `icons.x` / `icons['x']` / `icons[x]` |
| 未命中 | **147 键**（65%） | 差集 |

### 7.2 为什么不能直接删

小程序**没有打包期 tree-shaking**：`icons.js` 里的字符串路径不会因为"没被引用"而自动从包内移除，反之删文件也不会自动删键。但反过来，**动态引用**会让静态扫描误判：

- `icons[item.icon]`（自定义 tabBar、服务卡片）
- `icons[k + 'Gray']`（拼色后缀）
- WXML 里 `{{icons[someKey]}}`

因此必须先审计、后人工确认。

### 7.3 方案（三步，本轮不执行）

**第 1 步：审计脚本 `tools/audit-icons.js`（新增，约 60 行）**

输出三张表：
1. `used`：静态命中键 + 命中位置（文件:行）
2. `dynamic`：所有非字面量访问点（`icons[...]` 内含变量），**必须人工确认**
3. `unused`：既未静态命中、也不在 dynamic 上下文的键 + 对应 PNG 体积

**第 2 步：人工确认与物理裁剪**

- 确认 `dynamic` 清单里可能覆盖的键（如 `*Gray`/`*White`/`*Mint` 全部后缀）
- 对确认无用的键：删除 `icons.js` 条目 + 删除对应 PNG
- 顺序必须是「先删键再删文件」，否则运行时会拿到不存在路径

**第 3 步：溢出到分包（可选）**

确实不常用但必须保留的图标，迁到 `packageContent/assets/icons/`，由用到它们的页面（科普详情）承担下载。

### 7.4 预期收益（估算，需实测）

| 场景 | 删除数量 | 预估主包降幅 | 备注 |
| --- | --- | --- | --- |
| 保守 | 100 键 | ≈ 340 KB | 按均值 3.4 KB/个 |
| 中性 | 130 键 | ≈ 440 KB | — |
| 激进（上限） | 147 键 | ≈ 500 KB | 若动态引用确实很少 |

目标：`main` 从 1516 KB 降到 **≤1200 KB**（余量从 26% 提到 41%）。

### 7.5 风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 动态引用漏检 → 某页图标裂开 | **高** | 审计脚本必须打印 dynamic 上下文；裁剪后 29 页逐页走查；保留 `git revert` |
| 删键后 `check-exports` 报未定义 | 中 | 删键前先跑 `check-exports`，删后必跑 |
| 与设计稿对不上（要恢复图标） | 中 | 保留一次 `git revert` 能力；或在仓库留 `icons.removed.json` 清单便于回填 |

### 7.6 本轮处置

**不改代码。** 待你确认后再排期（建议紧跟 F-04 之后，单独一轮做，因为它需要逐页走查时间）。

---

## 8. 修复顺序、依赖与不执行项

### 8.1 顺序与依赖

```
F-01（独立，最先，收 P0）
  └─> 门禁 check-exports 转绿
F-02（依赖 F-01 之后的字段决策：统一 displayed）
  └─> 不改测试，改页面 4 行
F-03（独立，可并行分析，但提交需独立）
F-04（独立，需真实编译两次：改前/改后）
F-05（独立，需先确认"SKIP 不等于 PASS"的口径）
F-06（仅方案，不进本轮）
```

**为什么 F-02 要在 F-01 之后**：两者都要跑 `test-fe-all` 做回归。F-01 先修可让 `check-exports` 先转绿，避免"两个红混在一起看不出谁引起的"。字段决策本身不依赖 F-01，但**回归基线**依赖。

### 8.2 不执行项与原因

| 项 | 原因 | 后续计划 |
| --- | --- | --- |
| F-03 剩余 53 处 | 其中 35 处集中在 4 个登录页（`login`/`doctor-login`/`patient-login`/`manual-login`/`auth-common`）。登录页是已验收版本，改字号会动版式，需单独回归窗口；用户点名范围为"首页、挂号页、列表页" | 单列 F-03b，下一轮做，先出三档截图再改 |
| F-06 图标裁剪 | 需人工确认 147 键 + 逐页走查，本轮时间不够且风险高（漏检即裂图） | 本轮只出方案（§7），确认后单独一轮 |
| O-06 之外的优化建议（高对比全局化、banner 宽屏、信封收敛） | 不在本次白名单 | 见 `docs/frontend-optimization-suggestions.md` O-07~O-12 |

### 8.3 提交计划（阶段二，逐项一提交）

| 项 | 仓库 | 分支 | 提交信息 | 预计文件 |
| --- | --- | --- | --- | --- |
| 分支创建 | 两个仓库 | `fix/frontend-issues-20261022` | — | — |
| F-01 | 嵌套 `miniprogram` | 同上 | `fix(F-01): 三页图标改为整模块引入，恢复自绘导航图标` | 3 |
| F-02 | 嵌套 | 同上 | `fix(F-02): 挂号页分页字段统一为 displayed 并补 total` | 3 |
| F-03 | 嵌套 | 同上 | `fix(F-03): 首页/挂号/床位 28 处字号收敛到字体令牌` | 4 |
| F-04 | 顶层 | 同上 | `fix(F-04): packOptions.ignore 排除开发脚本与文档` | 1 |
| F-05 | 顶层 | 同上 | `fix(F-05): 资源链接自测增加探活与 SKIP 语义` | 2 |
| 文档 | 顶层 | 同上 | `docs: 前端修复设计文档` | 1（本文件） |

纪律：显式路径 `git add <file>`；**不 add** `miniprogram` gitlink、`.trae`、截图、临时脚本；**不 push**。

---

## 9. 阶段二全量回归计划（修复完成后执行）

| # | 项目 | 命令 | 对照基线 |
| --- | --- | --- | --- |
| 1 | 13 项门禁 | 逐项跑，记退出码 | 10 通过 / 3 失败 |
| 2 | `node:test` | `node tools/test-fe-all.js` | 71/71 |
| 3 | 接口探测 | 34 项探针复跑 | 30 符合 / 4 漂移 |
| 4 | 真实编译包体 | `cli.bat preview` | main 1,552,292 B |
| 5 | 响应式 24 组 | `preview-pad-pages.js --measure`（6 视口副本） | 18 通过 / 6 失败 |
| 6 | 三档字号实测 | 三份 HTML 注入 + 读计算值 | 新增项 |

输出 `docs/frontend-fix-record.md`，含回归对比表（指标 / 修复前 / 修复后 / 变化 / 结论）。

---

## 10. 需人工确认项（**确认后才进入阶段二**）

| # | 待确认 | 我的建议 | 不确认的影响 |
| --- | --- | --- | --- |
| C-1 | 分支策略：两个仓库都建 `fix/frontend-issues-20261022`（嵌套仓库从 `fix/round1-appointment-ui` 切出，非 master） | 同意 | 无法满足"禁止 master 直改" |
| C-2 | 工作区 411 / 135 项脏改动一律不提交，仅用显式路径提交本项文件 | 同意 | 提交会裹入他人改动，无法逐项回滚 |
| C-3 | F-02 字段统一方向 = `displayed`（改 1 页而非 3 页） | `displayed` | 若选 `view`，需改 3 页 + 改测试断言，风险更大 |
| C-4 | F-02 允许在页面 `_refresh` 增加 `total: p.total`（1 行，仅为满足既有断言，不接 UI） | 同意 | 否则只能删测试断言（属放宽，不建议） |
| C-5 | F-03 范围限定 4 文件 28 处，剩余 53 处另开 F-03b | 同意 | 一次改 81 处需重测全部登录页，回归面过大 |
| C-6 | F-04 若实测 `main` 降幅 ≈0，是否保留 ignore 配置 | 保留（防回归） | 若要求"没收益就撤销"，则回滚该提交 |
| C-7 | F-05 的 SKIP 语义是否会与你现有 CI 判定冲突（SKIP 退出码 0） | 同意 + `--strict` 供 CI 强校验 | 若 CI 把 0 当 PASS，需改为退出码 3 并在 CI 特判 |
| C-8 | F-06 仅出方案，本轮不动代码 | 同意 | 若要求本轮做，需额外 2~3 小时逐页走查 |
| C-9 | 阶段二是否允许我生成截图（写入 `docs/shots/`，体积可能达数百 KB） | 允许但限 6 张、每张 ≤200 KB | 无截图的验收只能靠命令行输出，说服力弱 |

---

## 11. 阶段二执行前检查（不产生改动）

```bash
# 1) 两个仓库的还原点
git rev-parse HEAD && git -C miniprogram rev-parse HEAD

# 2) 存底当前脏改动（不入库）
git diff > /tmp/baseline-top.patch
git -C miniprogram diff > /tmp/baseline-mp.patch

# 3) 建立分支
git checkout -b fix/frontend-issues-20261022
git -C miniprogram checkout -b fix/frontend-issues-20261022

# 4) 确认分支与工作区
git rev-parse --abbrev-ref HEAD
git -C miniprogram rev-parse --abbrev-ref HEAD
```

---

**本阶段到此暂停。** 请对 §10 的 C-1 ~ C-9 给出确认或修改；确认后我按 §8.1 顺序执行，每项一提交、每项立即回归、失败即停。
