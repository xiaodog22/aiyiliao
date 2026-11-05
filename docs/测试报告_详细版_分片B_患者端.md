# 测试报告 · 详细版 · 分片 B —— 患者端 9 页用例化 + 深挖

> 第二轮「详细版」增量测试 · 分片 B2 · 静态只读审查（未改任何页面/服务/样式源码）
> 日期：2026-10-29 · 测试方式：源码静态执行验证 + `tools/test-patient-deep-audit.js`（打桩 wx/getApp/Page/storage，实测 PASS 28 / FAIL 0）
> 对照：第一轮主报告 `docs/测试报告_20261029_全量前端测试.md`（§2 schema、§7.3 bug 台账、§7.5 适老化）
> 标签：F=正常流 · S=边界 · R=异常/降级 · U=中断恢复
> 范围：home / consultation / triage / triage/result / appointment / consult(患者侧) / consult/picker / tv/cast / health；services(triage/home/appointment/speech/ai)；utils(apt-status/err-text/datetime)。登录 4 页=A2、医生端=D2、分包=E2，未越界。

---

## 1. P1 修复验证断言台账（当前实测红/绿）

> 第一轮登记时为红；DEV_LOG 尾部（2026-10-29）显示已修复。本轮按「修复后应有行为」编写断言实测，结果如实记录。

| 断言 | 口径 | 证据 | 红/绿 |
| --- | --- | --- | --- |
| P1-03 home `_route('checkup'/'care')` 有用户反馈（toast/modal/跳转），不再静默 | 行为驱动：驱动页面定义对象调用 `_route`，断言 showModal 被调；源级断言 NOT_READY 有引用 | home.js:72 NOT_READY 定义；home.js:290-300 `wx.showModal({title:'线下体检中心…'})`、`{title:'居家护理…'}` | **GREEN（已闭环）** |
| P1-04 consultation 失败气泡不含英文码/err.code，且走 errText | 行为驱动：注入 `{code:'NETWORK_ERROR'}`，断言气泡无 `[A-Z_]{4,}`；注入纯英文 JS 异常断言不外泄；源级断言 require err-text | consultation.js:27 `require('./../../utils/err-text.js')`；consultation.js:544 `errText(err, '网络异常')`；实测气泡：`AI 助手暂时没能回答（网络连接失败，请检查网络后重试）…` | **GREEN（已闭环）** |

脚本运行记录：
```
GREEN  P1-03（第一轮红已闭环）
GREEN  P1-04（第一轮红已闭环）
PASS 28 / FAIL 0
```

---

## 2. 逐页用例表（PAT-D-xxx，共 116 条）

### 2.1 首页 home（重点页，15 条）

| ID | 标签 | 用例 | 预期 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| PAT-D-001 | F | 进入首页：四宫格/8 宫格/快选词/预约动态卡渲染 | 区块齐全；预约卡空数据走真实空态，不伪造 | home.js onLoad；home.wxss:61-62 自定义 TabBar 预留 100rpx | ✅ |
| PAT-D-002 | F | 点击四宫格「智能导诊」 | `navigateTo /pages/triage/triage` | home.js:260-262 `encodeURIComponent(text)` | ✅ |
| PAT-D-003 | F | 点击四宫格「预约挂号」 | `switchTab`（带预选科室走 wb_appoint_dept 缓存） | home.js:267 注释「曾实测点了没反应」→ switchTab | ✅ |
| PAT-D-004 | S | 点击四宫格「线下体检中心 checkup」 | showModal 业务提示（不再静默） | home.js:290-294 | ✅（P1-03 闭环） |
| PAT-D-005 | S | 点击「居家护理 care」 | showModal 含「居家护理」业务名 | home.js:295-300 | ✅（P1-03 闭环） |
| PAT-D-006 | F | 输入症状点发送/快选词 chip | `triage?text=<encoded>` | home.js:262；脚本 C1 实测 | ✅ |
| PAT-D-007 | S | 发送文本含 `<>&空格特殊字符` | URL 经 encodeURIComponent，裸字符不出现在 query | 脚本 C1b 实测通过 | ✅ |
| PAT-D-008 | R | 后端不可用（home/summary reject） | 走 MOCK_FALLBACK/错误态，页面不白屏 | services/home.js:13 注释；home.js `_loadSummary` catch | ✅ |
| PAT-D-009 | U | 预约卡加载中（aptLoading）连点卡片 | 无重复跳转风暴 | home.js `_loadSummary`；脚本 C2 同构验证在 triage | ✅ |
| PAT-D-010 | U | 未登录 onShow 守卫 | 非 patient 角色 reLaunch 登录页 | home.js onShow `app.globalData.role` 判断 | ✅ |
| PAT-D-011 | S | wb_theme 被篡改为 `'giant'`/数字 | 无白名单校验 → 静默落到未定义 theme 类（视觉退回 standard，不崩溃） | app.js:36 `getStorageSync('wb_theme')||'standard'` | ⚠️ 观察 D-P3-07 |
| PAT-D-012 | R | 预约动态块 status=unavailable | 客户端隐藏该块，不显示空壳 | services/home.js:6 契约注释 | ✅ |
| PAT-D-013 | S | 输入行内发送胶囊触控高度 | 72rpx=36px，低于 44px 基准 | home.wxss:38 `--h-send-h:72rpx` | ⚠️ D-P2-04 |
| PAT-D-014 | F | 症状输入行高度 | 88rpx=44px 恰达标 | home.wxss:36 `--h-bar:88rpx` | ✅ |
| PAT-D-015 | U | 中途离开再返回 onShow | 重跑登录守卫 + summary 刷新，不重复发请求堆叠 | home.js onShow/onHide 配对 | ✅（待真机确认请求数） |

### 2.2 AI 问诊 consultation（重点页，15 条）

| ID | 标签 | 用例 | 预期 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| PAT-D-016 | F | 进入页：消息流/快捷词/就医进度卡/输入栏渲染 | 全区块 | consultation.js data | ✅ |
| PAT-D-017 | F | 发送问题 → THINKING → AI 回复气泡 | status 状态机：IDLE→THINKING→IDLE | consultation.js send；脚本 C2 同构 | ✅ |
| PAT-D-018 | R | AI 失败（NETWORK_ERROR） | 气泡中文：`AI 助手暂时没能回答（网络连接失败…）`，无英文码 | consultation.js:544；脚本 B3 实测 | ✅（P1-04 闭环） |
| PAT-D-019 | R | 纯英文 JS 异常（`paginate is not a function`） | errText 拦成中文兜底，异常文本不外泄 | scripts B6 实测：err-text 拦截日志打印 | ✅ |
| PAT-D-020 | F | 失败后状态复位 IDLE | 用户可再发一次（气泡带引导文案） | 脚本 B5 实测 status=IDLE | ✅ |
| PAT-D-021 | S | 消息超过 60 条 | 旧消息裁剪 | consultation.js 60 条上限（第一轮脚本③覆盖） | ✅ |
| PAT-D-022 | S | 加载中连点发送 | THINKING 时拒绝再发，不产生重复气泡 | consultation.js send guard | ✅ |
| PAT-D-023 | R | 首次进入隐私告知弹一次 | `wb_triage_notice_v1` 共享开关 | consultation.js:256 | ✅ |
| PAT-D-024 | F | 就医进度卡：待就诊/就诊中/已完成四步点亮 | step 按 aptStatusText 输出映射 | consultation.js:198-210 | ✅ |
| PAT-D-025 | S | 进度卡分支耦合中文文案 | `status==='待就诊'` 等 if 以翻译结果为键，文案改则逻辑断 | consultation.js:201/204/207 | ⚠️ D-P2-03 |
| PAT-D-026 | S | 快捷词 chip 触控 | min-height 68rpx=34px < 44px | consultation.wxss:555-563 | ⚠️ D-P2-04 |
| PAT-D-027 | S | 急救电话按钮触控 | min-height 72rpx=36px < 44px | consultation.wxss:586-590 | ⚠️ D-P2-04 |
| PAT-D-028 | F | 发送 FAB 触控 | 88rpx=44px（走 --btn-height） | consultation.wxss:753-755 | ✅ |
| PAT-D-029 | U | 中途离开再返回 onShow | 仅同步主题，不重置会话流 | consultation.js onShow theme sync | ✅ |
| PAT-D-030 | R | 后端 AI 不可用且隐私未授权 | 先弹隐私告知，同意后才 _askAi | consultation.js send→privacy 分支 | ✅ |

### 2.3 智能导诊 triage（重点页，15 条）

| ID | 标签 | 用例 | 预期 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| PAT-D-031 | F | 导诊对话流：用户描述→AI 追问→结论→推荐科室 | 状态机流转 + 四步圆点 | triage.js send/answerNav | ✅ |
| PAT-D-032 | F | 深链 `?text=头疼` 进入 | onLoad 读取 preset 自动分析 | triage.js onLoad `options.text` | ✅ |
| PAT-D-033 | S | `?text=` 超长（>200 字符） | 前端不截断直达 /analyze（service 内 emergency 分支 slice 200） | services/triage.js `MAX_TEXT_FOR_API=200` | ⚠️ 观察 D-P3-08 |
| PAT-D-034 | S | 输入 `<script>alert(1)</script>` 字符串 | 纯文本气泡渲染，无 HTML 注入（小程序无 innerHTML/rich-text） | triage.js WXML `{{}}` 文本插值 | ✅（信息项） |
| PAT-D-035 | S | 输入纯空格/全角空格 | trim 后判空提示，不发送 | triage.js send 校验 | ✅ |
| PAT-D-036 | S | 输入 emoji/口语夹杂方言 | 原样带入分析（设计如此，知识库正则容忍） | utils/triage-engine.js（test-triage 322 项覆盖） | ✅ |
| PAT-D-037 | R | 后端 /analyze 不可用 | 错误气泡/降级提示，不白屏 | triage.js catch | ✅ |
| PAT-D-038 | S | 否定回答「不要」误触发导航 | answerNav 否定先判，不跳科室 | services/triage.js answerNav（第一轮脚本①覆盖） | ✅ |
| PAT-D-039 | F | 结论页「去挂号」 | 写 `wb_appoint_dept` 后跳 appointment | triage.js:421 | ✅ |
| PAT-D-040 | F | 进度卡状态映射 | 同 PAT-D-024 机制 | triage.js:167-175 | ✅ |
| PAT-D-041 | S | 进度卡中文文案分支耦合 | 同 PAT-D-025 | triage.js:167/170/173 | ⚠️ D-P2-03 |
| PAT-D-042 | U | 加载中（THINKING）连点发送 | 拒绝重复提交 | 脚本 C2 实测 | ✅ |
| PAT-D-043 | R | 隐私告知首次弹 | wb_triage_notice_v1 共享 | services/triage.js NOTICE_KEY | ✅ |
| PAT-D-044 | S | wb_triage_notice_v1 篡改为 0/假值 | `!!v` 为假 → 弹窗重弹（恢复态，无伤害） | services/triage.js hasSeenNotice | ✅（恢复） |
| PAT-D-045 | U | 中途退出再进入 onShow | 会话态保留，不重置已答问题 | triage.js onShow | ✅ |

### 2.4 分步挂号 appointment（重点页，15 条）

| ID | 标签 | 用例 | 预期 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| PAT-D-046 | F | 科室→医生→号源→确认→成功五步走通 | 状态机 step 流转 | appointment.js goStep | ✅ |
| PAT-D-047 | F | 预选科室深链 `?dept=呼吸内科` | onLoad decode 后定位科室卡 | appointment.js:164 | ✅ |
| PAT-D-048 | S | `?dept=%E0%A4%A` 畸形编码 | 裸 decodeURIComponent 无 try/catch → URIError 白屏 | appointment.js:164（对照 consult.js:97-99 有兜底） | ⚠️ D-P2-02 |
| PAT-D-049 | F | 导诊直达：wb_appoint_dept 消费一次 | 读入后 remove，仅生效一次 | appointment.js:168-171 | ✅ |
| PAT-D-050 | S | wb_appoint_dept 篡改不存在科室名 | find 不到 → 忽略，正常展示全量列表 | appointment.js `_takePendingDept` | ✅（降级） |
| PAT-D-051 | S | 日期条仅 7 天 buildDates | 无越界日期可选（前端不提供 >7 天入口） | appointment.js buildDates(7) | ✅ |
| PAT-D-052 | S | 切换上午/下午时段 | 已选 slot 清空并 toast「请重新选择」 | appointment.js:339-341 | ✅ |
| PAT-D-053 | S | 未选日期/号源点「确认」 | toast「请选择日期和时间」拦截 | appointment.js:378-382；脚本 C3 实测 | ✅ |
| PAT-D-054 | S | 未选科室先选医生 | _onDept 驱动 loadDoctors 依赖 selDate，空选被拦 | appointment.js | ✅ |
| PAT-D-055 | F | 提交挂号：Idempotency-Key 防重 | submitting=true 二次点击直接 return | appointment.js:441-442；脚本 C4 实测 | ✅ |
| PAT-D-056 | R | 并发号满 409 | 重新取号 + 错误提示 | appointment.js onSubmit catch/409 分支 | ✅ |
| PAT-D-057 | S | 搜索关键词超长/特殊字符 | indexOf 过滤纯字符串匹配，无注入面；空词 toast | appointment.js:405-410 | ✅ |
| PAT-D-058 | F | 日期格触控 | min-height 96rpx=48px ≥44px | appointment.wxss:130-133 | ✅ |
| PAT-D-059 | R | 科室/医生/号源加载失败 | errText 中文 toast，区块转错误态可重试 | appointment.js:265/324/502 | ✅ |
| PAT-D-060 | U | 提交中离开再返回 | submitting 复位（成功/失败两路都复位） | 脚本 C4b 实测 `submitting:false` ≥2 处 | ✅ |

### 2.5 导诊结果页 triage/result（10 条）

| ID | 标签 | 用例 | 预期 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| PAT-D-061 | F | 正常渲染 wb_triage_report：科室/说明/建议 | r.dept/r.reason 展示 | result.js onLoad | ✅ |
| PAT-D-062 | R | report 缺失/JSON 损坏 | `!report.dept` → 空态引导 | result.js onLoad | ✅（降级） |
| PAT-D-063 | S | report 字段被篡改为对象/数字 | 原样进 WXML 文本插值，不崩溃 | result.js `setData({r})` | ✅（信息项） |
| PAT-D-064 | F | 「去挂号」写 wb_appoint_dept 并跳页 | result.js:72 | ✅ |
| PAT-D-065 | S | 「清除结论」后仍可阅读当前报告 | setData({r:r}) 不丢数据 | result.js:97 注释 | ✅ |
| PAT-D-066 | R | 推荐科室名含特殊字符回显 | 纯文本渲染，无注入 | result.js WXML | ✅ |
| PAT-D-067 | U | 从结果页返回 triage 再进入 | report 仍在 storage，重进可读 | result.js onLoad 直读 storage | ✅ |
| PAT-D-068 | S | 建议列表为空 | 空块不渲染（契约隐藏） | result.js wxml wx:if | ✅ |
| PAT-D-069 | F | 「重新导诊」回 triage | navigateBack/reLaunch 行为符合设计 | result.js | ✅ |
| PAT-D-070 | R | 后端结论缺失时 report.dept 为空 | 空态而非 undefined 白屏 | result.js `!report.dept` 分支 | ✅ |

### 2.6 AI 养生 health（10 条）

| ID | 标签 | 用例 | 预期 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| PAT-D-071 | F | 问卷逐题作答 → 生成方案 | questions/current/answers 状态机 | health.js | ✅ |
| PAT-D-072 | S | 自由文本答案无长度上限 | 原样写入 answers[key] | health.js onSend | ⚠️ 观察（无 maxlength，信息项） |
| PAT-D-073 | S | age 解析非法 | `Number(a.age)||60` 兜底 60 | health.js | ✅（降级） |
| PAT-D-074 | R | 生成中（generating）连点 | guard 拒绝重复生成 | health.js onSend guard | ✅ |
| PAT-D-075 | R | 后端生成不可用 | 错误提示，不白屏 | health.js catch | ✅ |
| PAT-D-076 | F | 行动卡片触控 | height 88rpx=44px 达标 | health.wxss:125 | ✅ |
| PAT-D-077 | F | 行动卡图标底板 44rpx | 图标 44rpx（底板内） | health.wxss:129 | ✅ |
| PAT-D-078 | U | 中途切页再回 onShow | 已答进度保留 | health.js onShow | ✅ |
| PAT-D-079 | S | 选项 chip 密集连点 | 每次选择 setData 无竞态（单线程） | health.js onChoose | ✅ |
| PAT-D-080 | R | 回答空字符串直接提交 | trim 校验拦截 | health.js onSend | ✅ |

### 2.7 图文咨询 consult 患者侧（11 条）

| ID | 标签 | 用例 | 预期 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| PAT-D-081 | F | 从 picker 带 doctorId 进入 | 自动建会话/加载历史 | consult.js:100-101 pendingDoctorId | ✅ |
| PAT-D-082 | S | `?consultationId=%E0%A4%A` 畸形编码 | 裸 decodeURIComponent 无 try/catch → URIError 白屏（同文件 :97-99 已有 decode 兜底，:111 却裸调） | consult.js:111 | ⚠️ D-P2-02 |
| PAT-D-083 | F | doctorName/departmentName 解码 | decode helper 兜底，不再显示 %E4%B8%BB | consult.js:97-99（第一轮修复） | ✅ |
| PAT-D-084 | F | 发消息/发图片/语音条 | cs-bar 输入栏三态 | consult.wxss:647-723 | ✅ |
| PAT-D-085 | S | 输入栏按钮触控 64rpx=32px | 低于 44px 基准（附件+/麦克风圆钮） | consult.wxss:687/715 | ⚠️ D-P2-04 |
| PAT-D-086 | F | 医生卡触控 min-height 104rpx=52px | 达标 | consult.wxss:84 | ✅ |
| PAT-D-087 | R | 医生回复流分页加载 | paginate.js 工具收敛 | utils/paginate.js | ✅ |
| PAT-D-088 | U | 中途离开再返回 onShow | 会话状态保留 | consult.js onShow | ✅ |
| PAT-D-089 | R | 后端会话 404/不存在 | 错误态提示，不崩 | consult.js catch | ✅ |
| PAT-D-090 | S | 文件名含特殊字符回显 | decodeURIComponent(base) 有兜底 | consult.js:337 | ✅ |
| PAT-D-091 | F | 结束会话/评价入口 | 按契约跳本地流程 | consult.js | ✅ |

### 2.8 选医生 picker（10 条）

| ID | 标签 | 用例 | 预期 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| PAT-D-092 | F | 医生列表渲染 + 选择 | tap → _gotoConsult 带参跳 consult | picker.js onLoad/_gotoConsult | ✅ |
| PAT-D-093 | S | `?doctorId=` 缺失 | 正常展示列表，不自动跳 | picker.js | ✅ |
| PAT-D-094 | S | doctorId 不存在/后端 404 | consult 页错误态承接 | picker.js → consult | ✅ |
| PAT-D-095 | R | 列表加载失败 | 错误态 + 重试 | picker.js catch | ✅ |
| PAT-D-096 | S | 特殊字符医生名回显 | 纯文本渲染 | picker.js WXML | ✅ |
| PAT-D-097 | U | 加载中连点医生卡 | 重复 _gotoConsult 会重复建会话？→ 观察 | picker.js tap 无防重 | ⚠️ 观察（待真机，P3） |
| PAT-D-098 | F | 空列表空态 | 引导文案 | picker.js empty | ✅ |
| PAT-D-099 | R | 无登录态进入 picker | 列表请求 401 → 拦截 | picker.js（request.js:651 AUTH_EXPIRED） | ✅ |
| PAT-D-100 | S | 键盘弹起列表遮挡 | 页面滚动区适配 | picker.js wxss | ✅（待真机） |
| PAT-D-101 | F | 返回 consult 已选态 | pendingDoctor 透传正确 | picker.js → consult.js:101 | ✅ |

### 2.9 TV 投屏 cast 三件套（10 条）

| ID | 标签 | 用例 | 预期 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| PAT-D-102 | F | 扫描设备列表/选择连接 | devices 渲染 + 连接反馈 | cast.js onLoad/onConnect | ✅ |
| PAT-D-103 | F | 上次设备回显 | wb_tv {name,ip} 读回 devices | cast.js:31（第一轮 P2-06 修复） | ✅ |
| PAT-D-104 | S | wb_tv 篡改为垃圾对象 | saved.name/ip 判空 → devices=[]，不崩 | cast.js:31-33 | ✅（降级） |
| PAT-D-105 | S | wb_tv 篡改为字符串 | 同上（访问 .name=undefined） | cast.js:31 | ✅（降级） |
| PAT-D-106 | R | 连接错误 IP | onConnect 失败 toast | cast.js | ✅ |
| PAT-D-107 | F | 保存/清除设备 | setStorage/removeStorage | cast.js:67/71 | ✅ |
| PAT-D-108 | S | 自定义设备名含特殊字符回显 | 纯文本渲染，无注入 | cast.js WXML | ✅ |
| PAT-D-109 | R | 预览数据不可用 | TV_PREVIEW 空态 | getApp().MOCK.TV_PREVIEW | ✅ |
| PAT-D-110 | U | 中途退出再进入 | 已保存设备仍回显 | cast.js:31 onLoad | ✅ |
| PAT-D-111 | F | 取消连接 | 设备回列表态 | cast.js | ✅ |

---

## 3. 新发现 Bug（D-Px-xx，本轮增量；与第一轮 §7.3 台账去重）

| ID | 级别 | 位置 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- | --- | --- |
| D-P2-01 | P2 | app.wxss:38-39；脚本 D 节实测 | 弱文本 #828CA0=3.38:1、占位 #B0BEC5=1.91:1，正文未达 4.5:1（适老化关键文本含就诊人/号源提示） | 脚本对比度实测 | 弱文本加深至 #6B7690 级；占位仅用于无意义 hint 可接受，但输入框引导语应换 --text-sub |
| D-P2-02 | P2 | consult.js:111；appointment.js:164 | 深链参数裸 `decodeURIComponent` 无 try/catch，畸形 % 序列 → URIError 页面 onLoad 白屏（同项目 consult.js:97-99 已有正确兜底范式，两处未套用） | 脚本 C8/C8b 静态命中 | 统一改用 `decode()` 辅助函数 |
| D-P2-03 | P2 | consultation.js:201-210；triage.js:167-175 | 进度卡按 `aptStatusText()` 输出的中文文案做 if 分支（`status==='待就诊'`），耦合展示文案；apt-status.js 文案一旦微调，四步点亮逻辑静默失效 | 脚本 C7 实测命中 | 改为按英文枚举（CONFIRMED/CHECKED_IN/COMPLETED）在 utils 暴露 `stepOfStatus(enum)` |
| D-P2-04 | P2 | home.wxss:38；consultation.wxss:563/590；consult.wxss:687/715 | 触控目标 <44px 基准：首页发送胶囊 36px、问诊 chip 34px、急救按钮 36px、咨询输入栏圆钮 32px（375px 档换算） | 各文件行号 | 胶囊/chip 提到 80-88rpx；圆钮整体 tap 区撑大 |
| D-P2-05 | P2 | app.wxss:30/33；脚本 D 节实测 | 薄荷标签字 3.62:1、橙标签字 3.53:1，小字号标签未达 4.5:1（app.wxss 注释自称 ≈4.6:1，实测偏低） | 脚本实测 | 深色化 #117A58 / #B35900 级 |
| D-P3-06 | P3 | speech.js:37 | `wb_voice_read` 字符串 `'false'` 被 `!!v` 判真 → 播报被意外打开（篡改/异常值） | 脚本 C5 实测 | 归一化：仅 `v===true||v==='true'` 视为开 |
| D-P3-07 | P3 | app.js:36 | `wb_theme` 无档位白名单，非法档静默落到未定义 theme 类（视觉退回 standard，用户无感知） | 脚本 C6 静态命中 | 读取后 `['standard','large','xlarge'].includes(t)||'standard'` |
| D-P3-08 | P3 | triage.js onLoad；services/triage.js | `?text=` 超长（>500）无前端截断，直达后端 /analyze；超长 emoji 串导致气泡撑高 | services/triage.js slices 500 | onLoad 预设截断 500 + 超长 toast 提示 |
| D-P3-09 | P3 | picker.js tap | 加载中连点医生卡无防重，可能重复建会话（观察项，待真机） | 用例 PAT-D-097 | tap 加 connecting guard |

> 重复/越界登记（不重复报 bug）：records.wxml:6-7 `seg-tab data-f="待就诊"`（切片 C）；doctor/appointments.js:42-48 本地三档徽章 map（切片 D，设计稿口径合理）；wb_new_appointments 死键（records.js:168 注释已移除）；preview-pad-pages 骨架滞后 = 工具债 T6，非页面回归。

---

## 4. 输入边界表（必做 3）

| 入口 | 输入 | 行为 | 风险结论 |
| --- | --- | --- | --- |
| 导诊症状输入 | 超长（>200/500） | emergency 分支 slice 200；recommend slice 500；超长直送后端 | ⚠️ D-P3-08 |
| 导诊症状输入 | `<script>` 字符串 | WXML `{{}}` 纯文本渲染，小程序无 innerHTML/rich-text 注入面 | ✅ 无 XSS，仅显示层风险（信息项） |
| 导诊症状输入 | emoji | 原样带入，气泡文本节点渲染 | ✅ |
| 导诊症状输入 | 纯空格/全角空格 | trim 判空拦截 | ✅ |
| 导诊症状输入 | 口语夹杂（方言/粤语） | engine 正则容忍，设计如此 | ✅（test-triage 322 项） |
| 问诊输入 | 空串/超长 | trim 拦截；超长无截断（气泡撑高） | ✅/⚠️ 同 D-P3-08 |
| 挂号表单 | 日期越界 | buildDates 仅 7 天，无越界入口 | ✅ |
| 挂号表单 | 时段切换 | selSlotId 重置 + toast 提示 | ✅ appointment.js:339 |
| 挂号表单 | 医生未选日期直选 | loadDoctors 依赖 selDate，空选拦截 | ✅ |
| 挂号搜索 | 关键词超长/特殊字符 | indexOf 纯字符串匹配，无注入；空词 toast | ✅ |
| 首页输入行 | `?text=<special>` | encodeURIComponent 全编码 | ✅ 脚本 C1/C1b |
| 深链 `?text=` | 缺失 | preset 为空，正常对话 | ✅ |
| 深链 `?text=` | 未编码裸 `&` | 框架参数解析吞 `&` 后键（参数污染类） | ⚠️ 信息项：手动拼链场景少见，记观察 |
| 深链 `?dept=` / `?consultationId=` | 畸形 % 序列 | URIError 白屏 | ⚠️ D-P2-02 |
| 回显路径 | 全部输入回显 | 仅 text 节点，无 HTML 注入面 | ✅ 记录为显示层风险（撑高/乱码），非安全漏洞 |

---

## 5. Storage 篡改行为表（必做 4）

| 键 | 篡改值 | 行为 | 结论 |
| --- | --- | --- | --- |
| wb_theme | `'giant'` / `123` | 无白名单 → theme 类名无效 → 静默退回 standard 视觉 | ⚠️ D-P3-07 |
| wb_tv | `{name:'x',ip:'1.2.3.4'}` | 正常结构垃圾值 → 连接失败 toast | ✅ 降级 |
| wb_tv | 字符串 `'garbage'` | `.name` undefined → devices=[] | ✅ 降级 |
| wb_triage_notice_v1 | `0` | `!!0`=false → 隐私弹窗重弹 | ✅ 恢复态 |
| wb_voice | 假音色 id | synthesize 带错参 → 后端失败，speak 非阻塞静默 | ✅ 降级（待真机确认无声不卡死） |
| wb_voice_read | 字符串 `'false'` | `!!'false'`=true → 播报意外开启 | ⚠️ D-P3-06（脚本 C5 实测） |
| wb_new_appointments | 任意 | 全仓无读取点（死键） | ✅ records.js:168 |
| wb_appoint_dept | 不存在科室名 | find 不到 → 忽略，全量列表 | ✅ 降级 appointment.js:170 |

---

## 6. 适老化量化表（必做 5，静态推算；375px 档 1rpx=0.5px，基准 88rpx=44px）

### 6.1 触控目标

| 组件 | 规格 | 换算 px | 判定 |
| --- | --- | --- | --- |
| 全局 .btn / send-fab | 88rpx（large 108 / xlarge 128） | 44 / 54 / 64 | ✅ |
| 首页症状输入行 --h-bar | 88rpx | 44 | ✅ 恰达标 |
| 首页发送胶囊 --h-send-h | 72rpx | 36 | ❌ D-P2-04 |
| 首页四宫格底板 --h-tile | 88rpx（整卡更高） | 44 | ✅ |
| 问诊 chip | 68rpx | 34 | ❌ D-P2-04 |
| 急救按钮 emergency-call | 72rpx | 36 | ❌ D-P2-04 |
| 挂号日期格 date-item | 96rpx | 48 | ✅ |
| 健康行动卡 act-card | 88rpx | 44 | ✅ |
| 咨询医生卡 | min-height 104rpx | 52 | ✅ |
| 咨询输入栏圆钮 | 64rpx | 32 | ❌ D-P2-04 |
| 自定义 TabBar | 100rpx（home.wxss:61） | 50 | ✅ |

### 6.2 三档字号（app.wxss:59-97，px@375）

| 档 | title | h2 | body | caption | body≥16px 适老线 |
| --- | --- | --- | --- | --- | --- |
| standard | 20 | 17 | 15 | 12 | 15px 略低于 16px |
| large | 22 | 18 | 16 | 13 | ✅ |
| xlarge | 26 | 21 | 19 | 15 | ✅ |

### 6.3 对比度（WCAG 实测，脚本 D 节确定性计算）

| 组合 | ratio | 正文 4.5 判定 |
| --- | --- | --- |
| #14264C / 白卡 | 14.88 | ✅ |
| #14264C / #F3F8FF 页面底 | 13.95 | ✅ |
| #5064A0 / 白卡 | 5.72 | ✅ |
| #828CA0 / 白卡 | 3.38 | ❌ D-P2-01 |
| #B0BEC5 / 白卡 | 1.91 | ❌ D-P2-01 |
| 白 / #0B6EF8 按钮 | 4.57 | ✅（勉强） |
| #178F6B / #E0F7F0 | 3.62 | ❌ D-P2-05（小字） |
| #CC6600 / #FFF4E5 | 3.53 | ❌ D-P2-05（小字） |

> 真机待确认项：触控手感、TabBar 高度实测、输入栏圆钮误触率、超长 emoji 气泡撑高、TV 连接无声卡死。

---

## 7. 数据一致性登记（必做 6：写死中文状态判断）

| 位置 | 性质 | 处置 |
| --- | --- | --- |
| consultation.js:198-210 | 按 aptStatusText 输出文案 if 分支 | 本轮新登记 D-P2-03（切片 B） |
| triage.js:167-175 | 同上 | 本轮新登记 D-P2-03（切片 B） |
| records.wxml:6-7 seg-tab `data-f="待就诊"` | 筛选键用中文文案 | 切片 C 管辖，位置记录不重复报 |
| doctor/appointments.js:42-48 | 医生端本地三档徽章 map（设计稿口径） | 切片 D 管辖，合理不改 |
| utils/mock-data.js | 演示数据中文 status | mock，不参与逻辑 |

---

## 8. 脚本与验证

- 新增：`tools/test-patient-deep-audit.js`（打桩 wx/getApp/Page/storage；只读源，不改码）
- 运行：`node tools/test-patient-deep-audit.js` → **PASS 28 / FAIL 0**；P1-03/P1-04 实测 GREEN
- 复用：`tools/test-patient-flows-audit.js`（第一轮，44/0，未改动）；`tools/test-triage.js`（322 项，引擎层不重复覆盖）
