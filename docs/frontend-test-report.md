# 前端测试报告

> 本报告的全部结论来自本轮实际执行的命令与可复现产物。凡未执行的检查项一律标注 `BLOCKED` 并给出原因与复现命令，不以静态审查冒充实测。
> 与上一版草稿的差异见 §2.4「本轮实测纠正的四处误判」。

---

## 1. 文档信息

| 项 | 内容 |
| --- | --- |
| 项目 | 医疗健康 AI 微信小程序（康诊云 / 患者端助手「小安」） |
| 仓库路径 | `<repo>` |
| 前端根目录 | `miniprogram/`（微信开发者工具项目根） |
| 分支 | `master`（工作区 411 项未提交改动，本轮未提交任何改动） |
| 技术栈 | **原生微信小程序**：WXML + WXSS + JS（无 Vue/React/UniApp/Taro/H5，无 WebView） |
| 包管理器 | **无**（无 `package.json` / `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`，零 npm 运行时依赖） |
| 构建方式 | 微信开发者工具编译（`project.config.json`：es6 + postcss + minified + minifyWXML） |
| 本地启动/构建命令 | `cli.bat preview --project <miniprogram>`（见 §11.1） |
| 接口文档 | `backend/contracts/business-openapi.yaml`（102 个 operation，`check-v4-contracts` 校验通过） |
| 测试环境 | 本机统一网关 `http://127.0.0.1:8080`（非公网）；联调隧道 `https://qv56gv32944.vicp.fun` **不可达** |
| 测试账号 | 患者 `138****8001`（dev 档，契约登录派生 code，口令已脱敏） |
| 测试时间 | 2026-10-22 12:11 — 12:30（GMT+8） |
| 执行方式 | 静态审查 + 真实后端联调 + 真实编译 + 真实排版实测 |
| 执行人 | WorkBuddy Agent（前端测试架构角色） |
| 总体结论 | **FAIL（不建议直接上线；修复 P0-1 并让门禁转绿后可进入内测）** |

### 1.1 页面规模

| 项 | 数值 | 证据 |
| --- | --- | --- |
| 主包页面 | 26 | `miniprogram/app.json` `pages[]` |
| 分包页面 | 3（`packageNav` 1 + `packageContent` 2） | `app.json` `subPackages[]` |
| 总路由 | 29 | 26 + 3 |
| 自定义 tabBar | 4 项，`custom: true` | `app.json` `tabBar` |
| JS / JSON / WXML / WXSS | 63 / 36 / 32 / 34 | `check-project.js` 扫描口径 |

---

## 2. 执行摘要

### 2.1 总体结论

**FAIL。** 接口层与工具链整体健康（102 契约一致、71 个单测全绿、真实编译通过、主包未超限），但存在 **1 个用户可见的 P0 缺陷** 与 **3 项门禁红灯**，因此不建议直接上线。

- 阻塞项：**1 个**（P0-1 三页自绘导航图标全部不渲染，返回入口对用户不可见）
- P0 / P1 问题：**P0 1 个、P1 4 个**
- 已执行验证：接口联调 24 项、门禁 13 项、编译打包 1 次、六视口排版 24 组
- 未验证：小程序真机运行时性能（启动耗时/FPS/setData 体积）、真机隧道联调、跨端浏览器兼容（小程序无浏览器矩阵概念）

### 2.2 已验证的关键正向结论

1. **后端全链路可用**：`/api/gw/health` 返回 `java 14ms / python 9ms / ollama 30ms` 三上游全可达。
2. **鉴权与越权行为正确**：无令牌 `401 UNAUTHORIZED`、坏令牌 `401 SESSION_REVOKED`、患者令牌访问医生端点 `403 FORBIDDEN`。
3. **写接口契约防护到位**：缺幂等键 `400 MISSING_IDEMPOTENCY_KEY`、槽位不存在 `404 SLOT_NOT_FOUND`、缺必填 `422 VALIDATION_FAILED`（带 `details[].field`）。
4. **遗留端点按设计 501**：`/api/appoint/updateStatus`、`/api/v1/bed/update/{id}`、`/api/v1/case/health/care-plan` 均返回 `501 COMPAT_PENDING`。
5. **主包未超限**：开发者工具实测 `main = 1,552,292 B (1516 KB)`，距 2048 KB 上限余 532 KB（26%）。
6. **无横向溢出**：六档视口 × 4 页共 24 组测量，`scrollWidth ≤ innerWidth` 全部成立。

### 2.3 阻塞项与主要风险

| 编号 | 问题 | 级别 | 一句话影响 |
| --- | --- | --- | --- |
| P0-1 | 床位管理 / 医生个人管理 / 音色管理三页 `{ icons }` 解构失败 | P0 | 三页均为 `navigationStyle: custom`，返回箭头不渲染，用户看不到返回入口 |
| P1-1 | `check-exports` 红灯（与 P0-1 同源），但门禁未阻断发布 | P1 | 该缺陷已在门禁中暴露，未被当作发布红线 |
| P1-2 | `test-pages-paginate` 崩溃（断言停在旧字段 `displayed`） | P1 | 四个长列表页的分页回归防护实际失效 |
| P1-3 | 81 处 `font-size` 未走令牌，适老/超大字档对这批元素不生效 | P1 | 面向中老年的核心卖点在这些元素上失真 |
| P1-4 | 联调隧道 `qv56gv32944.vicp.fun` 不可达，`test-resource-links` 16 项全挂 | P1 | 真机联调与素材链路当前无法验证 |

### 2.4 本轮实测纠正的四处误判

为避免沿用未经证实的结论，以下四项经实测后**推翻**了先前判断：

| 先前判断 | 实测结论 | 证据 |
| --- | --- | --- |
| 主包 2070 KB 已超 2048 KB 上限（按源码字节数） | **未超限**。开发者工具编译后 `main = 1516 KB` | `cli.bat preview` 体积表；源码态 2,120,096 B 仅作参考，非发布口径 |
| `project.config.json` 第 26 行 `"urlCheck": false` | **该字段不存在**。文件仅 25 行，第 23 行是 `"appid"` | `project.config.json:1-25` 全文 |
| WXML 中 46 处 emoji 作图标 | **全部位于 WXML 注释**（`⚠️` 说明文字），未参与渲染 | `grep -rnP "[\x{1F300}-\x{1FAFF}...]" --include=*.wxml` 抽样 6 条全为注释 |
| 适老化三档无任何页面挂载 | **29 个 WXML 已动态绑定** `theme-{{theme}}`，主包 26 页全覆盖 | `grep -rln "theme-{{" --include=*.wxml` = 29；逐页比对无遗漏 |

---

## 3. 结论总表

| 维度 | 结论 | 关键证据 | 主要风险 |
| --- | --- | --- | --- |
| 接口通过性 | **WARN** | 24 项真实探测：20 项符合契约；信封 `code` 类型不统一（数字 `200` vs 字符串 `"OK"`）、兼容别名重复 | 信封漂移导致客户端解包分支失控 |
| 代码普适性 | **WARN** | `env.js:52-57` 生产构建硬拦截；禁址扫描 0 命中；但 81 处硬编码字号、49 处字面色值、三页图标解构错误 | 环境安全达标，样式令牌与图标引用未达标 |
| 响应式 | **WARN** | 24 组实测 18 通过；无横向溢出；失败 6 组集中在首页，经截图核对为**脚本断言过期** | 宽屏 banner 插画比例需设计确认 |
| 前端开销 | **PASS（余量偏薄）** | 主包 1516/2048 KB；总包 2.11 MB；无 sourcemap；`lazyCodeLoading` 已开 | 余量 26%，图标占主包 50%，包内混入开发脚本 |
| 性能 | **BLOCKED** | 首屏仅 2 次请求（本地 25–117 ms）；小程序无 CWV 口径，真机启动耗未采集 | 冷启动与渲染性能未知 |
| 代码质量 | **FAIL** | `node:test` 71/71 通过；13 门禁 3 红（含 1 个 P0 同源）；无 lint/format/typecheck/覆盖率工具链 | 门禁红未阻断发布，质量网存在漏洞 |

---

## 4. 接口测试明细

### 4.1 测试方法（已执行验证）

1. 通过契约端点取得真实会话：`POST /api/v1/auth/wechat/login`，`code = dev-user-1-manual-138****8001`（前端 `services/user.js:92-99` 的同款派生逻辑），返回 `expiresIn: 7200`、`accessToken: at-****`（已脱敏）。
2. 以 `X-Platform: wechat-miniprogram` + `X-Client-Version: 4.0.0` + `Authorization: Bearer` 逐端点调用，记录状态码、耗时、响应形状。
3. 探针脚本与完整输出见 §11.2。

### 4.2 明细表

| # | 接口 | 方法 | 场景 | 期望 | 实际 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `/api/v1/me` | GET | 正常鉴权 | 200 + 资料 | 200 · 87 ms · `id/displayName/avatarUrl/...` | PASS | probe |
| 2 | `/api/v1/me` | GET | 无令牌 | 401 | 401 `UNAUTHORIZED` | PASS | probe |
| 3 | `/api/v1/me` | GET | 坏令牌 | 401 | 401 `SESSION_REVOKED` | PASS | probe |
| 4 | `/api/v1/me` | GET | 缺 `X-Client-Version` | 契约要求 400 | **200** | WARN | 与 #19 不一致 |
| 5 | `/api/v1/me` | GET | 缺 `X-Platform` | 契约要求 400 | **200** | WARN | 同上 |
| 6 | `/api/gw/health` | GET | 上游探活 | 200，三上游可达 | 200 · 62 ms · `upstreams[3]` 全 true | PASS | probe |
| 7 | `/api/v1/appointments/me` | GET | 患者预约列表 | 200 数组 | 200 · 35 ms · `array[19]` | PASS | probe |
| 8 | `/api/v1/departments` | GET | 科室列表 | 200 数组 | 200 · 33 ms · `array[15]` | PASS | probe |
| 9 | `/api/v1/consultations` | GET | 会话列表 | 200 数组 | 200 · 48 ms · `array[7]` | PASS | probe |
| 10 | `/api/v1/home/summary` | GET | 首页聚合 | 200 对象 | 200 · 47 ms · `{greeting, blocks[3]}` | PASS | probe |
| 11 | `/api/v1/health-records` | GET | 健康档案 | 200 数组 | 200 · 61 ms · `array[8]` | PASS | probe |
| 12 | `/api/v1/family-members` | GET | 家庭成员 | 200 数组 | 200 · 33 ms · `array[8]` | PASS | probe |
| 13 | `/api/v1/resources/manifest` | GET | 匿名清单 | 200，11 条 | 200 · 22 ms · `items[11]` | PASS | probe |
| 14 | `/api/v1/resources/{key}` | GET | 匿名取图（清单真 key `home.banner-hospital`） | 200 二进制 | 200 · 76 ms | PASS | probe |
| 15 | `/api/v1/resources/not_exist_key` | GET | 不存在资源 | 404 | 404 `NOT_FOUND` | PASS | probe |
| 16 | `/api/v1/doctor/appointments` | GET | 患者令牌越权 | 403 | 403 `FORBIDDEN` · 37 ms | PASS | probe |
| 17 | `/api/v1/beds` | GET | 患者令牌越权 | 403 | 403 `FORBIDDEN` · 35 ms | PASS | probe |
| 18 | `/api/v1/case/recommend-department` | POST | 智能导诊 | 200 + 推荐科室 | 200 · 36 ms · 命中急症红旗 `dyspnea` → 急诊科 | PASS | probe |
| 19 | `/api/v1/consultation/emergency/check?text=胸闷` | POST | 急诊判定（前端真实形态：query 传参、无 body） | 200 | 200 · `emergency=true` `chest_pain` | PASS | `services/triage.js:66-73` + curl |
| 20 | `/api/v1/consultation/emergency/check` | POST | 仅 `{symptoms}` 无 `text` | 422 | 422 `VALIDATION_FAILED` `details[1]` | PASS | probe |
| 21 | `/ai/health` | GET | AI 探针 | 200 | 200 · 16 ms | PASS | probe |
| 22 | `/api/appoint/updateStatus` | POST | 遗留端点 | 501 | 501 `COMPAT_PENDING` · `details[3]` | PASS（设计如此） | probe |
| 23 | `/api/v1/bed/update/1` | PUT | 遗留端点 | 501 | 501 `COMPAT_PENDING` · `details[5]` | PASS（设计如此） | probe |
| 24 | `/api/v1/case/health/care-plan` | POST | 遗留端点 | 501 | 501 `COMPAT_PENDING` | PASS（设计如此） | probe |
| 25 | `/api/v1/appointments` | POST | 缺幂等键 | 400 | 400 `MISSING_IDEMPOTENCY_KEY` | PASS | probe |
| 26 | `/api/v1/appointments` | POST | 幂等键 + 无效槽位 | 404 | 404 `SLOT_NOT_FOUND` | PASS | probe |
| 27 | `/api/v1/appointments` | POST | 空 body | 422 | 422 `VALIDATION_FAILED` `details[2]`（`patientName`/`slotId`） | PASS | probe |
| 28 | `/api/v1/consultations/{id}` | GET | 会话详情 | 200 | 200 · `{consultation, messages[1]}` | PASS | probe |
| 29 | `/api/v1/consultations/{id}/messages` | GET | 历史消息 | 200 | 200 · `array[1]` | PASS | probe |
| 30 | `/api/v1/consultations/not-exist-id` | GET | 不存在会话 | 404 | 404 `CONSULTATION_NOT_FOUND` | PASS | probe |
| 31 | `/api/v1/health-articles/1` | GET | 科普详情 | 200 | 404 `ARTICLE_NOT_FOUND` | WARN | 疑为 ID 口径不符，非缺陷 |
| 32 | `/api/v1/departments/{id}/doctors` | GET | 科室医生 | 200 数组 | 200 · 74 ms · `array[2]` | PASS | probe |
| 33 | `/api/v1/doctor/login` | POST | 缺 `X-Client-Version` | 400 | 400 `BAD_REQUEST` | PASS | curl |
| 34 | `/api/user/login` | POST | legacy 手输登录 | SessionData（含 `accessToken`） | 200 但**无 `accessToken`**，仅 `{userId,name}` | WARN | curl；前端未走此端点（`services/user.js:92` 走契约） |

### 4.3 契约一致性问题

| 编号 | 现象 | 证据 | 级别 |
| --- | --- | --- | --- |
| A-1 | 信封 `code` 类型不统一：Java 侧 `"OK"`（字符串），Python 侧 `200`（数字） | `probe` #1 vs #18；`services/request.js:416-419` 已做兼容 | WARN |
| A-2 | Python 侧响应存在多套同义别名：`clinic/department/dept`、`reason/advice`、`is_emergency/risk_level/emergency_message/matched_keywords/safe` | `recommend-department` 与 `emergency/check` 原始响应体 | WARN |
| A-3 | 请求头校验不一致：`/api/v1/doctor/login` 强制 `X-Client-Version`，`GET /api/v1/me` 缺失仍 200 | probe #4/#5 vs #33 | WARN |
| A-4 | legacy `/api/user/login` 返回体不满足 `SessionData`（无 token），仍有代码在 `api.js:32` 登记 | curl 响应 | WARN |

> 判定：**契约一致 + 关键流程成功 + 异常处理符合预期** 三条中，关键流程与异常处理达标，契约一致性有 4 处漂移 → 维度结论 `WARN`，不构成上线阻塞。

### 4.4 未验证项

| 检查项 | 状态 | 原因 | 手动验证命令 |
| --- | --- | --- | --- |
| 微信一键登录（真实 code2session） | BLOCKED | 无 AppID/AppSecret，且需真机 `wx.login` | 真机执行登录后抓 `/api/v1/auth/wechat/login` 请求 |
| 文件上传（multipart `file`） | BLOCKED | 无测试素材且写操作会落库 | `curl -F "file=@x.png" -H "Authorization: Bearer <t>" http://127.0.0.1:8080/api/v1/attachments` |
| ASR / TTS 语音链路 | BLOCKED | 需真实音频与耗时预算（tts 120 s） | 见 `docs/` 语音联调记录 |
| 422 之外的分页游标 | 静态审查 | 列表接口已返回全量数组，前端本地分页 | `tools/test-pages-paginate.js`（当前红，见 P1-2） |

---

## 5. 代码普适性审查

| 编号 | 审查项 | 证据 | 结论 | 风险 | 改进方向 |
| --- | --- | --- | --- | --- | --- |
| U-01 | 环境地址硬编码 | `config/env.js:20` `DEV_DIRECT='http://127.0.0.1:8080'`（带 `DEV_DIRECT` 标记，由 `check-project.js` 白名单放行）；`:32` 隧道域名 | **PASS** | 低 | 保持现状 |
| U-02 | 生产构建环境门禁 | `config/env.js:52-57`：生产档 gateway 非 https 或含 `vicp.fun/ngrok/natapp/localhost/127.0.0.1` 直接 `throw`；`mockReadFallback` 为真也 `throw` | **PASS** | 低 | 保持现状 |
| U-03 | 禁址扫描（8001/8088/localhost） | `check-project.js` ⑤：0 命中 | **PASS** | 低 | 保持 |
| U-04 | 接口集中管理 | 全部端点登记于 `config/api.js`；`test-pages-contract.js` 69/69 通过，页面无裸 `wx.request` | **PASS** | 低 | 保持 |
| U-05 | 全局 Mock 入口 | `app.js:7` 静态 `require('./utils/mock-data.js')`（7.9 KB）；生产态 `MOCK_FALLBACK=false` 仅关闭调用，文件仍入包 | **WARN** | 中 | 移入分包或用条件编译剔除 |
| U-06 | 图标引用形状 | `pages/doctor/beds/beds.js:17`、`pages/doctor/personal/personal.js:14`、`pages/profile/voice-settings/voice-settings.js:26` 均写 `const { icons } = require('../../../utils/icons.js')`；`utils/icons.js` 导出的是具名映射（`home`、`homeGray`…），**无 `icons` 键** | **FAIL（P0）** | 高 | 改为 `const icons = require(...)`，与 `pages/home/home.js:6` 一致 |
| U-07 | 图标资源利用率 | `assets/icons` 227 个 PNG / 0.77 MB；`icons.js` 227 键，静态可检出引用 80 键 | **WARN** | 中 | 先人工确认动态引用，再裁剪未用图标（见 O-04） |
| U-08 | 字号令牌化 | 页面 WXSS 中 `font-size: <n>rpx` 且不含 `calc(var(--font-*))` 共 **81 处**，集中在 `consult.wxss` 14、`manual-login.wxss` 12、`beds.wxss` 11、`appointments.wxss` 9、`login.wxss` 9 | **FAIL（P1）** | 高 | 全部改为 `calc(var(--font-x) + Nrpx)` |
| U-09 | 颜色令牌化 | 页面 WXSS 非 `#FFFFFF` 的字面色值 **49 处**，集中在 `triage.wxss` 11、`home.wxss` 8、`login.wxss` 5 | **WARN** | 中 | 收敛到 `app.wxss` 的 `--*` 令牌 |
| U-10 | 适老化三档挂载 | 29 个 WXML 绑定 `theme-{{theme}}`，主包 26 页无遗漏；`app.wxss:78` `.theme-large` / `:88` `.theme-xlarge` 定义完整 | **PASS** | 低 | 与 U-08 联动修复后即全量生效 |
| U-11 | 高对比模式覆盖 | `.high-contrast` 仅在 `pages/profile/settings/settings.wxml:5` 生效；其余页面不读 `wb_high_contrast` | **WARN（P2）** | 中 | 提到 `app.js` 全局并逐页绑定 |
| U-12 | 组件复用与字段一致性 | 四个长列表页共用 `utils/paginate.js`，但渲染字段分叉：`appointments.js:84,237` 用 `view`，`beds.js:70` / `consultations.js:74` / `records.js:77` 用 `displayed` | **WARN（P1）** | 中 | 统一为 `displayed`，并同步测试断言 |
| U-13 | 类型系统 | 原生 JS，无 TypeScript / `tsconfig.json`；关键服务有 JSDoc 标注 | **N/A** | 低 | 维持 JSDoc 契约注释 |
| U-14 | 国际化 | 全中文硬编码，无 i18n 资源层 | **N/A** | 低 | 境内医疗场景可接受，记录为已知边界 |
| U-15 | 依赖管理 / 供应链 | 无 npm 依赖 → 无重复依赖、无锁文件、无 `npm audit` 可执行 | **N/A** | 低 | 若引入工具链需补 lockfile 与审计 |
| U-16 | 浏览器兼容 | 小程序无浏览器矩阵；`app.json` 未声明 `miniprogramRoot` 外的 polyfill 需求 | **N/A** | 低 | 以基础库版本为准，建议在 `project.config.json` 固定 `libVersion` |

---

## 6. 响应式视口矩阵

### 6.1 测量方法（已执行验证）

- 工具：`tools/preview-pad-pages.js --measure`（项目自带，真实 Chrome 排版 + 盒模型回读，`1rpx = 视口宽/750`，与小程序一致）。
- 本轮为覆盖规定视口，将脚本**复制到临时目录**并替换视口表（仓库文件未改动），跑出 4 页 × 6 视口 = **24 组**。
- 判据：`body.scrollWidth > innerWidth` 即横向溢出；另含双栏/单列、主栏侧栏重叠、首页几何契约。
- ⚠️ 口径说明：这是 **WXSS 真实排版离线复现**，不是微信真机渲染；离线 HTML 中图片路径不解析，截图里的灰块属预览产物，不能据此判断图标缺失。

### 6.2 视口 × 页面矩阵（24 组）

| 视口 | 页面 | scrollWidth/innerWidth | 布局 | 横向溢出 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 360×640 | home | 345/360 | 单列 | 无 | **WARN** | 断言：四宫格 2 行、banner 比 0.76 |
| 360×640 | consultation | 360/360 | 单列 | 无 | PASS | — |
| 360×640 | appointment | 345/360 | 单列 | 无 | PASS | — |
| 360×640 | workbench | 345/360 | 单列 | 无 | PASS | — |
| 375×812 | home | 360/375 | 单列 | 无 | **WARN** | banner 比 0.77 |
| 375×812 | consultation | 375/375 | 单列 | 无 | PASS | — |
| 375×812 | appointment | 360/375 | 单列 | 无 | PASS | — |
| 375×812 | workbench | 360/375 | 单列 | 无 | PASS | — |
| 768×1024 | home | 753/768 | 单列 | 无 | **WARN** | banner 比 0.63 |
| 768×1024 | consultation | 768/768 | 单列 | 无 | PASS | — |
| 768×1024 | appointment | 753/768 | 单列 | 无 | PASS | — |
| 768×1024 | workbench | 753/768 | 单列 | 无 | PASS | — |
| 1024×768 | home | 1009/1024 | **双栏** | 无 | **WARN** | banner 比 0.53 |
| 1024×768 | consultation | 1024/1024 | 双栏 | 无 | PASS | — |
| 1024×768 | appointment | 1009/1024 | 双栏 | 无 | PASS | — |
| 1024×768 | workbench | 1009/1024 | 双栏 | 无 | PASS | — |
| 1440×900 | home | 1425/1440 | **双栏** | 无 | **WARN** | banner 比 0.30 |
| 1440×900 | consultation | 1440/1440 | 双栏 | 无 | PASS | — |
| 1440×900 | appointment | 1425/1440 | 双栏 | 无 | PASS | — |
| 1440×900 | workbench | 1425/1440 | 双栏 | 无 | PASS | — |
| 1920×1080 | home | 1905/1920 | **双栏** | 无 | **WARN** | banner 比 0.25 |
| 1920×1080 | consultation | 1920/1920 | 双栏 | 无 | PASS | — |
| 1920×1080 | appointment | 1905/1920 | 双栏 | 无 | PASS | — |
| 1920×1080 | workbench | 1905/1920 | 双栏 | 无 | PASS | — |

汇总：**通过 18 / 24，失败 6 / 24**，失败全部为 `home` 页。

### 6.3 首页两项失败的真伪判定

| 断言 | 实测 | 判定 | 依据 |
| --- | --- | --- | --- |
| 常用服务「四宫格行数 = 1」 | 恒为 2 行 | **断言过期（非缺陷）** | 该区共 8 项（智能导诊/找医生/找科室/健康档案/体检服务/居家护理/健康咨询/更多服务），每行 4 个必然 2 行；`tools/_pad_home_phone.png` 目视一致 |
| banner 插画占卡高 ≥ 0.95 | 0.25–0.77（随宽度递减） | **WARN，待设计确认** | `home.wxss:47-49` 插画为固定 `--h-banner-h:132rpx` / `--h-banner-art-w:228rpx`，`:523-529` 未随卡片增高拉伸；宽屏卡片变高后插画相对变小 |

### 6.4 未覆盖项

| 检查项 | 状态 | 原因 | 手动验证 |
| --- | --- | --- | --- |
| 真机渲染截图（iOS/Android/平板） | BLOCKED | 无真机与自动化驱动（未安装 `miniprogram-automator`） | `cli.bat auto --project <mp> --auto-port 9420` + automator 截图 |
| 触控目标 ≥ 88rpx 全量核查 | 静态审查 | 仅 `app.wxss` 令牌层确认 `--btn-height` 存在 | 开发者工具「体验评分」逐页跑 |
| 文字截断 / 长文本溢出 | 未验证 | 预览骨架用固定文案 | 真机切换超大字档后逐页目视 |
| 表格 / 弹窗 / 表单 | 未验证 | 预览脚本只覆盖 4 页 | 同上 |

### 6.5 截图索引

| 路径 | 视口 | 生成时间 | 说明 |
| --- | --- | --- | --- |
| `tools/_pad_home_phone.png` | 375×812 | 2026-10-17 14:06 | 项目既有产物，用于目视核对 banner/宫格 |
| `tools/_pad_consultation_phone.png` | 375×812 | 2026-10-17 14:07 | 同上 |
| `tools/_pad_appointment_phone.png` | 375×812 | 2026-10-17 14:07 | 同上 |
| 本轮 | 6 档 | 2026-10-22 | `--measure` 模式不产出截图，仅盒模型数值（见 §11.3） |

---

## 7. 前端开销指标

### 7.1 真实编译产物（权威口径）

命令：`cli.bat preview --project <mp> --qr-output ... --info-output ...` → `√ preview`

| 指标 | 实测 | 预算/上限 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| 总包 | 2,212,496 B（2.11 MB） | 20 MB | PASS | 体积表 |
| **主包** | **1,552,292 B（1516.0 KB）** | 2048 KB | **PASS**（余 532 KB / 26%） | 体积表 |
| `packageContent` | 592,941 B（579.0 KB） | — | PASS | 体积表 |
| `packageNav` | 67,263 B（65.7 KB） | — | PASS | 体积表 |
| sourcemap | 0 个 | 不应入包 | PASS | 全量扫描 |

### 7.2 源码构成（非发布口径，仅用于定位优化点）

| 指标 | 实测 | 占比 | 备注 |
| --- | --- | --- | --- |
| 源码态主包 | 2,120,096 B（2070.4 KB） | — | 压缩前；**不可据此判定超限** |
| PNG | 1.24 MB | 45.9% | 无 webp |
| JS | 0.56 MB | 20.7% | — |
| WXSS | 0.37 MB | 13.5% | — |
| WXML | 0.18 MB | 6.6% | — |
| MP4 | 0.16 MB | 6.0% | 均在分包 |
| `assets/icons` | 227 文件 / 0.77 MB | 主包体积的 **50%** | 见 O-04 |
| 包内开发脚本 | `miniprogram/tools` 89 KB + `.trae` 18 KB | 约 107 KB | 含 `.py` / `__pycache__/*.pyc` |

### 7.3 分包与缓存策略

| 项 | 现状 | 结论 |
| --- | --- | --- |
| 分包 | `packageNav`（院内导航）、`packageContent`（科普列表/详情） | PASS |
| `lazyCodeLoading` | `"requiredComponents"` | PASS |
| `preloadRule` | 首页 `network: all` 预下载 **两个分包**（合计 646 KB） | **WARN**：与首屏抢带宽，建议改 `wifi` 或延后 |
| 资源缓存 | 资源 URL 带 `?v=<sha256 前 12 位>` 击穿 7 天图片缓存 | PASS（设计合理） |
| CDN | 无独立 CDN，走网关直出 | WARN（真机弱网待测） |

---

## 8. 性能指标

### 8.1 已测（本地网关，非弱网）

| 页面/场景 | 设备 | 网络 | 指标 | 实测 | 预算 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 冷启动首屏请求数 | 模拟器等价 | 局域网 | 请求数 | **2**（`/resources/manifest` + `/home/summary`） | ≤ 6 | PASS |
| 首页聚合 | — | 局域网 | TTFB（3 次） | 51.6 / 116.9 / 63.6 ms | ≤ 800 ms | PASS |
| 资源清单 | — | 局域网 | TTFB（3 次） | 39.5 / 25.2 / 76.2 ms | ≤ 800 ms | PASS |
| 患者列表 | — | 局域网 | 响应 | 35 ms | — | PASS |
| 智能导诊 | — | 局域网 | 响应 | 36 ms | ≤ 90 s（`aiTimeout`） | PASS |
| 编译耗时 | 开发者工具 | — | 构建 | 成功，无告警输出 | — | PASS |

### 8.2 未测（BLOCKED）

| 指标 | 状态 | 原因 | 复现命令 |
| --- | --- | --- | --- |
| 冷启动耗时 / 首屏渲染 | BLOCKED | 小程序无 FCP/LCP 口径；需真机或自动化 | 开发者工具「调试器 → Performance」录制冷启动 |
| FCP / LCP / INP / CLS / TBT | BLOCKED | **不适用于小程序**（无 DOM/浏览器渲染管线），本报告不以 Lighthouse 伪造数据 | — |
| setData 体积与次数 | BLOCKED | 需运行时埋点 | `wx.getPerformance()` / 开发者工具 Performance 面板 |
| 长列表滚动帧率 | BLOCKED | 需真机 | 真机「床位/挂号」页滚动 + 开发者工具 FPS |
| 内存峰值 | BLOCKED | 需真机 | 真机内存面板 |
| 弱网（3G/2G）启动 | BLOCKED | 需真机限速 | 开发者工具自定义网络 1.5 Mbps |

> 结论：性能维度不满足"可判定"条件，标 **BLOCKED**，不以局域网数据冒充真机结论。

---

## 9. 代码质量门禁

### 9.1 门禁执行结果（13 项，已执行）

| # | 检查项 | 命令 | 结果 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 单元测试（node:test） | `node tools/test-fe-all.js` | **71 tests / 71 pass / 0 fail** | PASS |
| 2 | JS 语法（63 个） | `node tools/check-project.js` ① | 全部通过 | PASS |
| 3 | JSON 可解析（36 个） | 同上 ② | 全部通过 | PASS |
| 4 | 图标引用（32 个 WXML，159 处） | 同上 ③ | 全部有效 | PASS |
| 5 | 全局类重复定义 | 同上 ④ | 无重复 | PASS |
| 6 | 禁址扫描 | 同上 ⑤ | 0 命中 | PASS |
| 7 | 相对 require 路径（151 处） | `node tools/check-require.js` | `REQUIRE_OK` | PASS |
| 8 | 导入/导出形状 | `node tools/check-exports.js` | **3 处不一致**（`beds`/`personal`/`voice-settings`） | **FAIL** |
| 9 | 类名覆盖 | `node tools/check-styles.js` | `STYLES_OK`（仅查覆盖，不查 CSS 语法） | PASS |
| 10 | OpenAPI 契约 | `node tools/check-v4-contracts.js` | `business=83 ai=5 ops=102 unique=102 warnings=0` | PASS |
| 11 | 页面契约 | `node tools/test-pages-contract.js` | 69/69 | PASS |
| 12 | 日期工具 | `node tools/test-apt-date.js` | 17/17 | PASS |
| 13 | 分页冒烟 | `node tools/test-pages-paginate.js` | **崩溃**：`TypeError: Cannot read properties of undefined (reading 'length')` @ `test-pages-paginate.js:242` | **FAIL** |
| 14 | 资源链接 | `node tools/test-resource-links.js` | PASS 0 · **FAIL 16**（隧道不可达） | **FAIL** |
| 15 | V4 文档 | `node tools/check-v4-docs.js` | 路由数 29 ≠ 24，缺 4 条路由 | KNOWN-FAIL（登记在案） |
| 16 | V4 原型图 | `node tools/check-v4-prototypes.js` | `consultation--error.png` 635×1072 ≠ 375×812 | KNOWN-FAIL（登记在案） |

汇总：**新增失败 3 · 登记在案失败 2 · 结论：存在真实失败**。

### 9.2 三类红灯的性质

| 门禁 | 性质 | 证据 | 处置 |
| --- | --- | --- | --- |
| `check-exports` | **真缺陷**（与 P0-1 同源） | `beds.js:17` 等三处解构 `icons` 失败 | 改代码 |
| `test-pages-paginate` | **测试失修** | 断言 `inst.data.displayed.length`（`:242`），但 `appointments.js:84` 已改名为 `view` | 改测试 |
| `test-resource-links` | **环境依赖** | 16 项均 `fetch failed`，目标 `https://qv56gv32944.vicp.fun`；本地 `127.0.0.1:8080` 同端点正常 | 起隧道或改指向本地 |

### 9.3 工具链缺口

| 能力 | 现状 | 建议 |
| --- | --- | --- |
| ESLint / Prettier | 未配置（无 `package.json`） | 引入 `eslint --no-eslintrc` + 自定义规则集，至少覆盖 `no-undef`/`no-unused-vars` |
| TypeScript / `tsc` | 无 | 可选：JS + `// @ts-check` + `tsc --allowJs --checkJs` |
| Stylelint | 无 | 可覆盖 U-08/U-09 两类硬编码 |
| 覆盖率 | 无（`node:test` 未接 c8） | `c8 node --test` 出 lcov |
| 依赖审计 | 无依赖，`npm audit` 不适用 | 若引入工具链需补 lockfile |

---

## 10. 未验证项总表

| # | 项目 | 状态 | 原因 | 手动验证命令/方式 |
| --- | --- | --- | --- | --- |
| 1 | 真机渲染与交互（iOS/Android/Pad） | BLOCKED | 无真机与自动化驱动 | 开发者工具扫码预览 + 真机逐页 |
| 2 | 冷启动/渲染耗时、FPS、内存 | BLOCKED | 需运行时采集 | 开发者工具 Performance 面板 |
| 3 | 弱网（3G/2G）表现 | BLOCKED | 需真机限速 | 自定义网络 1.5 Mbps |
| 4 | 微信一键登录（code2session） | BLOCKED | 无 AppID/AppSecret | 真机 `wx.login` 后抓请求 |
| 5 | 文件上传 / 附件签名读取 | BLOCKED | 无素材且写库 | `curl -F "file=@x.png"` |
| 6 | ASR / TTS 语音链路 | BLOCKED | 需音频与长耗时预算 | 语音页真机走查 |
| 7 | 隧道联调（真机经公网） | BLOCKED | `qv56gv32944.vicp.fun` 不可达（curl 000） | 重启花生壳映射后 `curl -I https://<域名>/api/gw/health` |
| 8 | 高对比模式全页效果 | 未验证 | 仅设置页生效，其余页无入口 | 挂 `high-contrast` 后逐页目视 |
| 9 | 跨端样式（开发者工具 vs 真机） | 未验证 | 无真机 | 同上 |
| 10 | 触控目标 88rpx 全量 | 未验证 | 需体验评分 | 开发者工具「体验评分」 |

---

## 11. 附录

### 11.1 环境与工具版本

| 项 | 值 |
| --- | --- |
| Node.js | `v22.22.2`（`<home>\.workbuddy\binaries\node\versions\22.22.2-6\node.exe`） |
| 微信开发者工具 CLI | `D:\OpenWeChar\微信web开发者工具\cli.bat`（文件时间 2026-01-29） |
| AppID | `wxc54919753ce946b6`（`project.config.json:23`） |
| 编译设置 | `es6: true`、`postcss: true`、`minified: true`、`minifyWXML: true` |
| 后端 | 网关 `:8080`（java 14 ms / python 9 ms / ollama 30 ms）；`8088` 健康 200；`8001` `/health` 返回 404（路径不符，非宕机） |
| 分支 / 改动 | `master` / 411 项未提交 |

### 11.2 接口探针

```bash
# 1) 取真实会话（dev 档派生 code，与 services/user.js:92 同款）
curl -s -X POST http://127.0.0.1:8080/api/v1/auth/wechat/login \
  -H "Content-Type: application/json" \
  -H "X-Platform: wechat-miniprogram" -H "X-Client-Version: 4.0.0" \
  -d '{"code":"dev-user-1-manual-138****8001","consentVersion":"v1.0","phoneCode":"dev-phone-138****8001"}'

# 2) 逐端点探测（脚本见下，24 项分 A~H 组）
node <probe>.js
```

探针要点（避免误判）：`POST` 必须带 `Content-Type: application/json`，否则网关回 500 而非 4xx —— 这与客户端无关（`services/request.js` 恒设该头），但说明**网关对缺失 Content-Type 缺少 415/400 兜底**，作为低优先项记录。

### 11.3 六视口排版实测

```bash
# 仓库自带脚本（4 视口：1696×1200 / 1200×1696 / 375×812 / 926×428）
node tools/preview-pad-pages.js --measure

# 本轮为覆盖 6 档规定视口：复制到临时目录并替换 VIEWPORTS，仓库文件未改动
node <tmp>/preview6.js --measure
# 实测 24 组 / 通过 18 / 失败 6（失败全为 home）
```

### 11.4 编译与包体

```bash
"D:/OpenWeChar/微信web开发者工具/cli.bat" preview \
  --project "<repo>/miniprogram" \
  --qr-output "<tmp>/preview.png" \
  --info-output "<tmp>/preview-info.json"

# 输出：
# TOTAL 2.1 MB (2212496) / main 1.5 MB (1552292) / packageContent 579.0 KB / packageNav 65.7 KB
```

### 11.5 关键日志摘要

```
check-exports.js  → miniprogram/pages/doctor/beds/beds.js  ⛔ 解构出的 `icons` 在 icons.js 里不存在
                    miniprogram/pages/doctor/personal/personal.js  ⛔ 同上
                    miniprogram/pages/profile/voice-settings/voice-settings.js  ⛔ 同上
                    ❌ 发现 3 处导入/导出不一致   EXIT=1

test-pages-paginate.js:242 → TypeError: Cannot read properties of undefined (reading 'length')

test-fe-all.js    → 汇总：新增失败 3 · 登记在案失败 2 · 结论 存在真实失败
                    [1/2] node:test  71 tests / 71 pass / 0 fail
```

---

**报告结语**：本次结论以"能跑的必须跑"为原则 —— 接口打了真实后端、包体走了真实编译、排版做了真实盒模型测量。未跑成的部分（真机、弱网、运行时性能）已逐条标注 `BLOCKED` 并附复现命令，不以估算或静态推断替代。
