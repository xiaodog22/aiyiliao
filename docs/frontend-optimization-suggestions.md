# 前端优化建议文档

> 配套《前端测试报告》（`docs/frontend-test-report.md`）。本文按 **P0 → P3** 排序，每条含证据、影响、可执行步骤、示例、预计收益、验收标准与是否阻塞上线。
> 未给出实测数字的收益一律标注「估算」，不冒充实测。

## 0. 索引与优先级定义

| 级别 | 定义 | 本轮条目 |
| --- | --- | --- |
| P0 | 用户可见的功能/导航损坏，必须修完才能发布 | O-01 |
| P1 | 质量网失效或适老化/可维护性硬伤，发布前应修 | O-02 ~ O-05 |
| P2 | 一致性、宽屏表现、可访问性覆盖，迭代内修 | O-06 ~ O-09 |
| P3 | 工程治理与工具链补齐 | O-10 ~ O-12 |

| 编号 | 标题 | 维度 | 级别 | 阻塞上线 |
| --- | --- | --- | --- | --- |
| O-01 | 三页 `{ icons }` 解构错误导致自绘导航图标全丢 | 代码质量 / 普适性 | P0 | 是 |
| O-02 | `test-pages-paginate` 断言过期，分页回归防护失效 | 代码质量 | P1 | 是（门禁红线） |
| O-03 | 81 处 `font-size` 未令牌化，适老/超大字档局部失效 | 普适性 / 可访问性 | P1 | 是 |
| O-04 | 图标资源占主包 50%，227 键仅 80 键被静态引用 | 开销 | P1 | 否（但挤压余量） |
| O-05 | 联调隧道不可达，真机链路无法验证 | 接口 | P1 | 是（验证阻塞） |
| O-06 | 长列表分页字段命名分叉（`view` vs `displayed`） | 普适性 | P2 | 否 |
| O-07 | 首页 banner 插画在宽屏不随卡片增高 | 响应式 | P2 | 否 |
| O-08 | 高对比模式仅在设置页生效 | 可访问性 | P2 | 否 |
| O-09 | 响应信封 `code` 类型不统一 + 同义字段冗余 | 接口 | P2 | 否 |
| O-10 | 门禁缺少 lint / format / typecheck / 覆盖率 | 代码质量 | P3 | 否 |
| O-11 | 包内混入开发脚本与文档（`miniprogram/tools`、`.trae`） | 开销 | P3 | 否 |
| O-12 | 首页预下载两个分包，与首屏抢带宽 | 性能 | P3 | 否 |

---

## P0

### O-01 三页 `{ icons }` 解构错误导致自绘导航图标全丢

- **维度**：代码质量 / 普适性
- **严重级别**：**P0**
- **证据**
  - `miniprogram/pages/doctor/beds/beds.js:17` `const { icons } = require('../../../utils/icons.js')`
  - `miniprogram/pages/doctor/personal/personal.js:14` 同上
  - `miniprogram/pages/profile/voice-settings/voice-settings.js:26` 同上
  - `miniprogram/utils/icons.js` 导出的是具名映射（`home`、`homeGray`… 共 227 键），**不存在 `icons` 键** → 解构结果为 `undefined`
  - 三页 `*.json` 均为 `"navigationStyle": "custom"` → 无原生返回按钮，返回箭头由 WXML 自绘
  - WXML 实际引用：`beds.wxml` `icons.chevronLeft / icons.searchGray / icons.refreshGray / icons.alertWhite`；`personal.wxml` `icons.bell / icons.calendar / icons.chevronLeft / icons.lock`；`voice-settings.wxml` `icons.chevronLeft / icons.info / icons.soundWave / icons.volumeOff`
  - 门禁佐证：`node tools/check-exports.js` → `❌ 发现 3 处导入/导出不一致`（EXIT=1）
- **影响**
  - 用户：三页返回入口**不可见**（点击区可能仍在，但无视觉引导），中老年用户极易卡死；床位页搜索/刷新、音色页提示/音波图标同时丢失
  - 维护：同一模块两种导入写法并存，新人照抄哪一页都可能出错
- **优化建议**
  1. 三处改为整模块引入（与 `pages/home/home.js:6`、`pages/doctor/workbench/workbench.js:21` 一致）
  2. 在 `utils/icons.js` 末尾**额外导出一个 `icons` 自引用**作为兜底（可选，减少此类误用）
  3. 把 `check-exports` 纳入发布红线（见 O-02 的 CI 部分）
- **示例**

```js
// ❌ 现状（三页同款）
const { icons } = require('../../../utils/icons.js')

// ✅ 修正
const icons = require('../../../utils/icons.js')
```

```js
// utils/icons.js 末尾（可选兜底：让两种写法都能拿到映射）
const MAP = { /* ...227 键... */ }
module.exports = Object.assign({ icons: MAP }, MAP)
```

- **预计收益**：恢复 3 页共 12 处图标渲染；消除 1 个 P0；`check-exports` 转绿（新增失败从 3 降到 2）
- **验证方式与验收标准**
  ```bash
  node tools/check-exports.js        # 期望 EXIT=0，无 ⛔ 输出
  node tools/check-project.js        # 期望仍全绿
  ```
  真机/模拟器打开床位管理、医生个人管理、音色管理 → 返回箭头、搜索、刷新、铃铛、日历、信息、音波图标均可见
- **是否阻塞上线**：**是**

---

## P1

### O-02 `test-pages-paginate` 断言过期，分页回归防护失效

- **维度**：代码质量
- **严重级别**：P1
- **证据**
  - `node tools/test-pages-paginate.js` → `TypeError: Cannot read properties of undefined (reading 'length')` @ `tools/test-pages-paginate.js:242`，退出码 1
  - 断言读 `inst.data.displayed.length`，但挂号页已改名：`pages/doctor/appointments/appointments.js:84` `view: []`、`:237` `view: p.displayed`
  - 另外三页仍是 `displayed`：`beds.js:70`、`consultations.js:74`、`records.js:77`
- **影响**
  - 维护：四个长列表页的「首屏 20 条 / 触底追加 / 按钮点了没反应」三类回归**当前无人看守**，脚本一跑就崩，等于该防护网失效
  - 用户：字段改名若再漏改 WXML，会直接表现为列表空白
- **优化建议**
  1. 断言改为读页面真实字段（挂号页用 `view`），或先统一字段（见 O-06）再统一断言
  2. 断言前加空值守卫，避免一处失败导致后续用例全部不执行
  3. 在 `test-fe-all.js` 里把「崩溃」与「断言失败」分开统计
- **示例**

```js
// tools/test-pages-paginate.js:242 附近
const rows = inst.data.view || inst.data.displayed || []
check('[挂号] 首屏只渲染 20 条', rows.length === 20, '实得 ' + rows.length)
```

```js
// 更稳的写法：先断言容器存在，再断言长度
check('[挂号] 分页容器已初始化', Array.isArray(rows), '实得 ' + typeof rows)
if (!Array.isArray(rows)) return
```

- **预计收益**：恢复 4 页 × 约 12 条断言的回归防护；`test-fe-all` 新增失败从 3 降到 1
- **验证方式与验收标准**
  ```bash
  node tools/test-pages-paginate.js   # 期望 EXIT=0
  node tools/test-fe-all.js           # 期望「新增失败」仅剩 test-resource-links
  ```
- **是否阻塞上线**：**是**（作为门禁红线；不修则发布缺少分页兜底）

---

### O-03 81 处 `font-size` 未令牌化，适老/超大字档局部失效

- **维度**：普适性 / 可访问性
- **严重级别**：P1
- **证据**
  - 统计命令：`grep -rn "font-size:[^;]*[0-9]rpx" --include=*.wxss pages/ | grep -v "calc(" | wc -l` → **81**
  - 分布：`consult.wxss` 14、`manual-login.wxss` 12、`beds.wxss` 11、`appointments.wxss` 9、`login.wxss` 9、`doctor-login.wxss` 7、`patient-login.wxss` 6、`home.wxss` 4
  - 对照：令牌定义在 `app.wxss:59-62`（standard）、`:78-84`（`.theme-large`）、`:88-96`（`.theme-xlarge`）；页面已 29 处绑定 `theme-{{theme}}`（挂载没问题）
  - 例：`pages/appointment/appointment.wxss:147` `font-size: 22rpx;`
- **影响**
  - 用户：切到「放大一档 / 超大」后，这 81 处文字**保持不变**，出现同屏字号断层（标题变大、辅助文字不变），适老化卖点打折
  - 维护：设计改字号要逐文件搜改，易漏
- **优化建议**
  1. 按语义映射替换为令牌表达式：标题 `calc(var(--font-title) + 0rpx)`、卡片标题 `var(--font-h2)`、正文 `var(--font-body)`、辅助 `var(--font-caption)`
  2. 保留设计稿的 ±2~4rpx 微调时，写成 `calc(var(--font-caption) + 2rpx)`，仍随档位缩放
  3. 加一条自研门禁 `check-font-tokens`（正则扫 `font-size:\s*\d+rpx`），并入 `test-fe-all`
- **示例**

```css
/* ❌ 现状 */
.tip-text { font-size: 22rpx; }

/* ✅ 修正（随三档缩放，且保留原视觉差） */
.tip-text { font-size: var(--font-caption); }          /* 24rpx 基准 */
.tip-text--tight { font-size: calc(var(--font-caption) - 2rpx); }
```

```js
// tools/check-font-tokens.js（建议新增，约 30 行）
const fs = require('fs'), path = require('path')
let bad = []
for (const f of walk('miniprogram')) {
  if (!f.endsWith('.wxss') || f.endsWith('app.wxss')) continue
  fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    if (/font-size:\s*\d+rpx/.test(l)) bad.push(f + ':' + (i + 1))
  })
}
if (bad.length) { console.error('硬编码字号 ' + bad.length + ' 处\n' + bad.slice(0, 20).join('\n')); process.exit(1) }
```

- **预计收益**：81 处字号随三档生效；`consult`/`beds`/`appointments` 三个高频页的适老一致性补齐；后续设计改版只需改一处令牌
- **验证方式与验收标准**
  - 新增门禁 EXIT=0（硬编码字号归零）
  - 真机把档位切到 `xlarge`，逐页对比：同一区块内不应出现「标题变大、说明文字不变」的断层
  - 文字不截断、不溢出容器（超大字档下重点看按钮与徽章）
- **是否阻塞上线**：**是**（面向中老年的产品，字号不随档位变化属核心体验缺陷）

---

### O-04 图标资源占主包 50%，227 键仅 80 键被静态引用

- **维度**：开销
- **严重级别**：P1
- **证据**
  - `assets/icons`：227 个 PNG，合计 0.77 MB；主包实测 1516 KB → 图标占 **50%**
  - `utils/icons.js` 227 键；全仓静态引用（`icons.xxx` / `icons['xxx']`）命中 **80 键**，未命中 **147 键**（`homeGray`、`chatWhite`、`leafGray`、`heart`…）
  - 主包源码态 PNG 合计 1.24 MB，占源码总量 45.9%；全仓无 webp
- **影响**
  - 性能：主包每增 100 KB，弱网冷启动下载约 +0.2~0.5 s（估算，未真机实测）
  - 维护：图标库与设计稿脱节，删错会影响未发现的动态引用
- **优化建议**
  1. **先确认再删**：147 键中有一部分是运行时拼 key（如 `icons[k + 'Gray']`）、自定义 tabBar、或 `data-*` 动态取值，必须人工复核后再裁剪
  2. 把确认为死的图标迁到 `packageContent/assets`（分包内按需下载），而非直接删除
  3. 新增图标走 `tools/build-icons.js` 时统一压缩（PNG 量化到 8-bit 调色板），单图控制在 3 KB 内
  4. 评估 webp：小程序基础库已支持，预计 PNG → webp 可再降 30~50%（估算）
- **示例**

```bash
# 1) 列出未命中键（人工复核动态引用）
node -e "..."   # 见测试报告 §11 的口径；输出 147 键清单

# 2) 确认无用后迁包（不是删）
git mv miniprogram/assets/icons/<name>.png miniprogram/packageContent/assets/icons/
# 同步修改 utils/icons.js 指向 /packageContent/assets/icons/<name>.png
```

- **预计收益**：若裁剪 100 个图标（按均值 3.4 KB/个）→ 主包约 **-340 KB**，余量从 532 KB 提升到约 870 KB（估算）；冷启动下载时间同比下降
- **验证方式与验收标准**
  - `cli.bat preview` 体积表 `main` 下降且 ≤ 2048 KB
  - `check-project.js` ③ 图标引用仍全绿；逐页走查无空白图
  - 真机冷启动耗时对比（优化前/后各 5 次取中位数）
- **是否阻塞上线**：否（但主包余量仅 26%，功能继续叠加会触顶）

---

### O-05 联调隧道不可达，真机链路无法验证

- **维度**：接口
- **严重级别**：P1
- **证据**
  - `curl -I https://qv56gv32944.vicp.fun/api/gw/health` → `HTTP 000`，`time_total 1.35s`（连接失败）
  - `node tools/test-resource-links.js` → `PASS 0 · FAIL 16`，16 项全部 `fetch failed`
  - 同一批端点在本地网关正常：`http://127.0.0.1:8080/api/gw/health` → 200，`java 14ms / python 9ms / ollama 30ms`
  - `config/env.js:32` 当前 `BUILD_ENV = 'development'`，指向该隧道
- **影响**
  - 验证：真机（手机经公网）无法联调，`test-resource-links` 永久红，掩盖真实回归
  - 发布：若误用 `development` 档打包，用户侧将整体不可用（虽有生产档 `throw` 兜底，但依赖人工改档）
- **优化建议**
  1. 短期：重启花生壳映射并把内网主机改回当前本机 IP（历史曾误配为失效的 `10.103.103.101`）
  2. 中期：给 `test-resource-links` 增加 `--base` 参数，CI 默认打本地网关，隧道仅作可选
  3. 长期：dev 档也走可配置的 `BASE_URL` 注入，减少对固定隧道的依赖
- **示例**

```bash
# 连通性判据（先修映射再验）
curl -sS -m 8 -o /dev/null -w "%{http_code} %{time_total}\n" https://<隧道域名>/api/gw/health
# 期望 200；当前 000

# 让资源链接自测可指向本地
node tools/test-resource-links.js --base http://127.0.0.1:8080
```

- **预计收益**：恢复 16 项资源链路断言；真机联调可复现
- **验证方式与验收标准**：隧道 200 + `test-resource-links` 16/16 PASS + 真机扫码登录成功
- **是否阻塞上线**：**是**（验证阻塞：真机链路未验证前不应发布）

---

## P2

### O-06 长列表分页字段命名分叉（`view` vs `displayed`）

- **维度**：普适性
- **严重级别**：P2
- **证据**：`appointments.js:84,237` 用 `view`；`beds.js:70,150`、`consultations.js:74,94`、`records.js:77,115` 用 `displayed`；四个页面共用 `utils/paginate.js`（其返回值字段是 `displayed`）
- **影响**：维护成本高，测试断言必须逐页区分（正是 O-02 的直接诱因）；新人复制代码易混用
- **优化建议**：统一为 `displayed`（与 `paginate()` 返回字段同名），挂号页改 2 处 js + 对应 wxml 的 `wx:for`
- **示例**

```js
// appointments.js：view → displayed
data: { displayed: [] }
// _refresh()
this.setData({ stats, displayed: p.displayed, page: p.page, hasMore: p.hasMore })
```

```xml
<!-- appointments.wxml -->
<view wx:for="{{displayed}}" wx:key="id">
```

- **预计收益**：四页同一套断言模板；O-02 可一并收敛
- **验收标准**：`grep -rn "view:" pages/doctor/appointments/` 无分页容器；`test-pages-paginate.js` 断言统一读 `displayed`
- **是否阻塞上线**：否

---

### O-07 首页 banner 插画在宽屏不随卡片增高

- **维度**：响应式
- **严重级别**：P2
- **证据**
  - 六视口实测插画占卡高比：360 → 0.76、375 → 0.77、768 → 0.63、1024 → 0.53、1440 → 0.30、**1920 → 0.25**（项目脚本期望 ≥ 0.95）
  - `pages/home/home.wxss:47-49` `--h-banner-h: 132rpx`、`--h-banner-art-w: 228rpx`；`:523-529` `.hm-banner-art { width: var(--h-banner-art-w); height: var(--h-banner-h); }` 为固定尺寸
  - `:660-661` 宽屏折 px 后仍为固定 66px / 114px
- **影响**：宽屏（平板横屏/桌面微信）banner 卡片被文字撑高，插画停在左上角一小块，视觉失衡；不影响功能
- **优化建议**：宽屏档把插画改为 `height: 100%` + `object-fit: contain` 贴右下角；或让卡片高度由插画决定（`min-height` 改为 `height`）
- **示例**

```css
@media (min-width: 600px) {
  .hm-banner { min-height: auto; }
  .hm-banner-art {
    width: auto;
    height: 100%;
    max-height: 132px;
    object-fit: contain;
    object-position: right bottom;
  }
}
```

- **预计收益**：1920 档插画占比从 0.25 提升到 ≥ 0.9；宽屏视觉与手机端一致
- **验收标准**：`node tools/preview-pad-pages.js --measure` 的 `banner插画高比` ≥ 0.95（六档）；目视 1440/1920 无留白突兀
- **是否阻塞上线**：否

> 备注：同一脚本报「常用服务四宫格行数 = 2（期望 1）」属**断言过期** —— 该区共 8 项，每行 4 个必然 2 行，`tools/_pad_home_phone.png` 目视一致。应更新脚本期望值为 2 行，不要改页面。

---

### O-08 高对比模式仅在设置页生效

- **维度**：可访问性
- **严重级别**：P2
- **证据**：`grep -rln "high-contrast" --include=*.wxml .` 仅命中 `pages/profile/settings/settings.wxml:5`；`grep -rln "wb_high_contrast" --include=*.js .` 仅 `settings.js`
- **影响**：用户在设置页开启高对比后，返回其他页面立刻失效，产生「设了没用」的观感；对低视力用户是实质缺陷
- **优化建议**：把 `highContrast` 提到 `app.globalData`，在 `app.js` 读取 storage 并在各页 `onShow` 注入；根节点统一 `class="page theme-{{theme}} {{highContrast ? 'high-contrast' : ''}}"`
- **示例**

```js
// app.js
globalData: { highContrast: false },
onLaunch() {
  this.globalData.highContrast = !!wx.getStorageSync('wb_high_contrast')
}
```

```js
// 各页 onShow（或抽成 utils/page-mixin.js 统一注入）
this.setData({ highContrast: app.globalData.highContrast })
```

- **预计收益**：高对比覆盖率从 1 页提升到 26 页
- **验收标准**：`grep -rln "high-contrast" --include=*.wxml` ≥ 26；开启后逐页目视文字/底色反转且对比度 ≥ 4.5:1
- **是否阻塞上线**：否

---

### O-09 响应信封 `code` 类型不统一 + 同义字段冗余

- **维度**：接口
- **严重级别**：P2
- **证据**
  - Java 侧：`/api/v1/me` → `{"code":"OK"}`；Python 侧：`/api/v1/case/recommend-department` → `{"code":200,"msg":...,"message":...}`
  - 同义字段：`clinic` / `department` / `dept` 三份相同值；`is_emergency` / `emergency` / `risk_level` / `emergency_message` / `matched_keywords` / `safe`
  - 客户端已兼容：`services/request.js:416-419 isOkCode()` 同时认 `200/0/'200'/'0'/'ok'`
- **影响**：客户端解包逻辑分支多、易回归；响应体体积增加（列表接口更明显）；契约文档与实现不一致
- **优化建议**：网关层统一包一层契约信封（`code: "OK"`），Python 侧别名仅在过渡期保留并加 `deprecated` 标记；前端 `isOkCode` 保留兼容但新增「非标准 code」告警日志
- **示例**

```js
// request.js：对非标准成功码留痕，便于灰度期发现新漂移
function isOkCode(code) {
  if (code === 200 || code === 0 || code === '200' || code === '0') {
    if (typeof console !== 'undefined') console.warn('[request] 非标准成功码 ' + code)
    return true
  }
  return typeof code === 'string' && code.trim().toLowerCase() === 'ok'
}
```

- **预计收益**：契约一致性从 4 处漂移收敛到 0；响应体瘦身（估 10~20%）
- **验收标准**：`node tools/check-v4-contracts.js` 保持 `warnings=0`；`grep` 全仓成功码只剩 `"OK"`；旧别名有下线计划
- **是否阻塞上线**：否

---

## P3

### O-10 门禁缺少 lint / format / typecheck / 覆盖率

- **维度**：代码质量
- **证据**：无 `package.json` / 无 `eslintrc` / 无 `tsconfig.json` / 无 c8 配置；`check-styles` 只查类名覆盖不查 CSS 语法；`check-project` 的 JS 检查仅 `node --check`（语法层）
- **影响**：未定义变量、未使用参数、样式语法错误只能靠人眼；P0-1 这类「解构不存在的键」本可由 `no-undef` 类规则提前拦住
- **建议**（按性价比排序）
  1. 先加 **Stylelint**（覆盖 O-03 的硬编码字号/色值，规则 `declaration-property-value-allowed-list`）
  2. 再加 **ESLint**（`no-undef` / `no-unused-vars` / `no-dupe-keys`），仅对 `miniprogram/**/*.js`
  3. 覆盖率用 `c8 node --test`，先出报告不设阈值，稳定后再设 60% 门槛
- **示例**

```json
{
  "scripts": {
    "lint": "eslint miniprogram --ext .js",
    "stylelint": "stylelint \"miniprogram/**/*.wxss\"",
    "coverage": "c8 node --test tools/test-fe-*.js",
    "gate": "npm run lint && npm run stylelint && npm run coverage && node tools/test-fe-all.js"
  }
}
```

- **预计收益**：把 3 类高频缺陷（未定义引用、硬编码样式、无用变量）左移到提交前
- **验收标准**：`npm run gate` 一条命令跑完全部门禁；首次接入允许存量告警但需登记基线
- **是否阻塞上线**：否

---

### O-11 包内混入开发脚本与文档（`miniprogram/tools`、`.trae`）

- **维度**：开销
- **证据**：`miniprogram/tools` 89 KB（含 `svg2png.py`、`__pycache__/svg2png.cpython-312.pyc`、`test-auth-request.js` 等）；`miniprogram/.trae/documents/*.md` 18 KB；`project.config.json` `packOptions.ignore` 为空数组
- **影响**：白白占用主包体积（约 107 KB 源码态）；`.py`/`.md` 进入小程序包属明显工程瑕疵，审核也可能追问
- **建议**：优先用 `packOptions.ignore` 排除；更彻底是把开发脚本移出 `miniprogram/`
- **示例**

```json
// project.config.json
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

- **预计收益**：主包 −100 KB 左右（估算）；包内不再出现源码类文件
- **验收标准**：`cli.bat preview` 体积表 `main` 下降；解包后 `tools/`、`.trae/` 不存在
- **是否阻塞上线**：否

---

### O-12 首页预下载两个分包，与首屏抢带宽

- **维度**：性能
- **严重级别**：P3
- **证据**：`app.json` `preloadRule` → `"pages/home/home": { "network": "all", "packages": ["packageContent", "packageNav"] }`；两分包合计 646 KB（`packageContent` 579.0 KB + `packageNav` 65.7 KB）
- **影响**：首屏图未出完即开始下载 646 KB 非首屏资源，弱网下会推迟首屏可交互时间（未真机实测，属风险而非既证事实）
- **建议**：`network` 改为 `"wifi"`；或仅预下载 `packageNav`（65.7 KB，导航入口更常用），`packageContent` 等用户点「健康科普」再下
- **示例**

```json
"preloadRule": {
  "pages/home/home": { "network": "wifi", "packages": ["packageNav"] },
  "packageContent/pages/knowledge/knowledge": { "network": "all", "packages": ["packageContent"] }
}
```

- **验收标准**：真机弱网（1.5 Mbps）冷启动首屏可交互时间不劣于现状；`packageContent` 首次打开仍有分包加载提示
- **是否阻塞上线**：否

---

## 附：执行顺序建议

```text
第 1 步（当天，收 P0）
  O-01 图标解构 → node tools/check-exports.js 转绿 → 三页真机目视

第 2 步（1~2 天，收门禁）
  O-02 修测试断言 → O-05 起隧道 → test-fe-all 新增失败清零
  O-06 顺带统一字段（与 O-02 同一批改）

第 3 步（发布前）
  O-03 字号令牌化（81 处，按文件分批）+ 新增 check-font-tokens
  O-11 packOptions.ignore

第 4 步（迭代内）
  O-04 图标裁剪/迁移（先人工复核 147 键）
  O-07 宽屏 banner、O-08 高对比全局化、O-09 信封收敛

第 5 步（治理）
  O-10 工具链接入、O-12 预下载策略
```

**发布前最小验收命令**

```bash
node tools/check-exports.js && \
node tools/check-project.js && \
node tools/test-pages-paginate.js && \
node tools/test-fe-all.js && \
"D:/OpenWeChar/微信web开发者工具/cli.bat" preview --project miniprogram
```

期望：前四条 EXIT=0，最后一条输出 `√ preview` 且 `main` ≤ 2048 KB。
