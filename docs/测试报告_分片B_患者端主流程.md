# 测试报告 · 分片 B —— 患者端 TabBar 与主流程（静态只读审查 + 离线单测）

- 执行日期：2026-10-29
- 方法：只读静态审查（Grep 定位 + 关键文件精读，未修改任何页面/服务/样式源码）+ 新增离线单测 `tools/test-patient-flows-audit.js`（打桩 wx/getApp/Page/storage，node 实跑）
- 范围：pages/home、consultation、health、triage、triage/result、appointment、consult、consult/picker、tv/cast；services/triage.js、home.js、appointment.js、speech.js、ai.js、careplan.js（如涉）；utils/triage-engine.js、paginate.js、apt-status.js、datetime.js、err-text.js
- 越界声明：登录4页 / 医生端8页 / 个人中心10页 / 分包3页未审（属其他分片）
- 导诊引擎准确性已由 `tools/test-triage.js`（322 项）覆盖，本分片不重复，只补页面层逻辑

---

## 1. 新增离线单测执行结果

脚本：`tools/test-patient-flows-audit.js`　运行命令：`node tools/test-patient-flows-audit.js`

```
==================== 结果 ====================
PASS: 41
FAIL: 0
```

- 覆盖：① services/triage.js answerNav 路线应答 11 例（含「不要」否定先判红线回归）；② 首页 _route() 四宫格/8宫格跳转映射 13 项（含 ?text= encodeURIComponent 深链）；③ consultation _appendMsg 增量 messages[i] 路径 + 60 条裁剪；④ consultation/triage THINKING 态防重复提交；⑤ appointment goStep 状态机推进 + onSubmit 防重复 + 缺号源校验。
- 配套回归：`node tools/check-project.js` 全部通过（js 语法 69 个 / json 41 个 / 图标 168 处 / 无禁址）。

---

## 2. 用例表（PAT-xxx）

| ID | 维度 | 前置 | 步骤（审查路径） | 预期 | 实测 | 证据 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PAT-001 | U | — | home.wxss hero 区布局 | 问候语不被小安头像压住 | ✅ 符合：flex 行布局，greet flex:1/min-width:0，徽章 flex-shrink:0，同流不重叠 | home.wxss:83-111 | P2 |
| PAT-002 | F | — | home.js QUAD → _route | 四宫格 4 入口跳转正确 | ⚠️ 功能✅（导诊→triage / 预约→switchTab appointment / 在线问诊→picker / 报告→health-records）；标签与任务书口径差异（实际=AI智能导诊/预约挂号/在线问诊/报告查询，以设计稿01为准） | home.js:40-45,243-266；单测② | P2 |
| PAT-003 | F | — | 首页快选词 chips → onQuickChip | 深链 triage?text= 预填且 encodeURIComponent | ✅ 符合 | home.js:245；单测②深链例 | P1 |
| PAT-004 | F | — | home.js SERVICES 8 宫格 → _route | 每个入口跳转正确 | ❌ 8 项中 checkup/care 静默死块（BUG-1）；archive 绕路（BUG-2）；其余 6 项正确 | home.js:48-60,268-269,277-281 | P1 |
| PAT-005 | F | — | 健康提示横滑卡 kbVideos → goVideo | → 科普详情 detail?id= | ✅ 符合 | home.js:358 | P1 |
| PAT-006 | F | — | 全部健康科普 goKnowledge | → knowledge 列表分包页 | ✅ 符合 | home.js:275 | P1 |
| PAT-007 | F | — | 首页 banner 点击 goTriage | → 导诊页 | ✅ 符合（banner 为导诊入口） | home.wxml:214；home.js goTriage | P2 |
| PAT-008 | S | 输入红旗症状 | triage.js send() → local.emergency | 红旗本地优先识别，不等后端 | ✅ 符合：send 先查 local.emergency 直接 _raiseEmergency | triage.js:252；triage-engine.js:369-374 | P0 |
| PAT-009 | S | 红旗触发 | _raiseEmergency | 弹窗 + 一键拨打120 + 主推荐切急诊科 | ✅ 符合：showModal「拨打120」→ makePhoneCall；primary.dept 强制急诊科 | triage.js:382-408；engine:369-374,444-460,481-483 | P0 |
| PAT-010 | F | 普通症状 | services/triage.js analyze | 一句话直出科室；仅全科兜底补问一次 | ✅ 符合：local.question 仅追问一次 | services/triage.js:123-125 | P1 |
| PAT-011 | S | 首次进导诊 | _privacyCheck → 用户取消 | 「仅本地分析」零后端调用 | ✅ 符合：取消→_remoteAllowed=false；analyze 走 useRemote===false 分支不发请求 | triage.js:118-136；services/triage.js:128-132 | P0 |
| PAT-012 | F | 结果卡后问路线 | answerNav 各应答词 | 否定先判：「不要」不得误判 yes | ✅ 符合：NAV_NO 先于 NAV_YES；单测 11 例全过 | services/triage.js:49-55；单测① | P0 |
| PAT-013 | F | 路线询问卡 | onNavaskYes/No + 打字应答 | 按钮或打字「要/是/好/不用」均可 | ✅ 符合：按钮与 send() ⓪ 分支同一 answerNav 链路 | triage.js:226-238,433-444 | P1 |
| PAT-014 | F | 进问诊 Tab | consultation onLoad → 欢迎语 | 进门固定一句话开场 | ⚠️ 符合（欢迎语开场），但现行=多轮真实后端 AI 问诊（第2轮起 TRIAGE，置信度≥0.7 出卡，兜底全科医学科），非任务书「直推导诊」——系 2026-10-24 重写，口径差异登记 | consultation.js:35-36,345-361 | P2 |
| PAT-015 | F | 问诊首屏 | quickList 渲染 | 4 个可点症状示例 | ✅ 符合：胃疼反酸/咳嗽有痰/胸闷心慌/腰疼膝盖 | consultation.js:79；consultation.wxml:178 | P1 |
| PAT-016 | R | 连发消息 | _appendMsg 至第 61 条 | 60 条上限裁剪，保留最新 | ✅ 符合：单测灌满 60 条后第 61 条裁剪回 60、last.id=61 | consultation.js:316-326；单测③ | P1 |
| PAT-017 | R | 连发消息 | _appendMsg setData 调用形态 | 增量 messages[i] 数据路径，禁止整数组 setData | ✅ 符合：patch 键为 messages[0]，无裸 messages 键；裁剪时才整数组 | consultation.js:323-325；单测③ patch keys | P1 |
| PAT-018 | R | AI 回复中再点发送 | send() status 判断 | 发送中禁再发 | ✅ 符合：status!=='IDLE' 直接 return；单测验证消息不追加 | consultation.js:364；triage.js:222；单测④ | P1 |
| PAT-019 | F | 挂号流程 | goStep 链 | dept→doctor→time→confirm→done | ✅ 符合：选科室→doctor(1)、选医生→time(2)、goConfirm→confirm(3)+抽屉、提交成功→done(4) | appointment.js:230,279,383,477；单测⑤ | P1 |
| PAT-020 | R | 挂号提交 | onSubmit 幂等键 | 提交中禁再点；同内容重试复用幂等键 | ✅ 符合：submitting 守卫 + submitSig 绑定 slotId+patientName | appointment.js:439,458,462-466；单测⑤ | P1 |
| PAT-021 | R | 号源 409 | onSubmit catch | 弹窗提示 + 回退号源列表重选 | ✅ 符合：showModal「号源已满」→ goStep('time')+_loadSlots | appointment.js:486-497 | P1 |
| PAT-022 | F | 会话 CLOSED | _applyConsultation / onSend | 医生卡「已结束」+ 底栏只读条 + 停轮询 | ✅ 符合：closed→tipText 只读条；onSend 拦截 toast；spinner 停 | consult.js:226,236-237,402-405；consult.wxml:51,56,178 | P1 |
| PAT-023 | R | 发送被 409 拦 | onSendText catch code===409 | 切终态 + 停轮询 + 原文还用户 | ✅ 符合：closed:true/status:CLOSED/_stopPolling/_stopLive | consult.js:453-465 | P1 |
| PAT-024 | F | 唤起键盘 | input adjust-position / kbHeight | 整屏不上顶，只上移输入栏+补占位 | ✅ 符合：adjust-position={{false}} + bindkeyboardheightchange + cs-bar translateY + kb-spacer | consult.wxml:198-202,213；consult.js:418-425 | P1 |
| PAT-025 | F | 投屏连接/断开 | onConnect | 连接写 wb_tv，断开清理 | ⚠️ 写/删缓存正确，但 saved 未回显、设备列表恒空致 UI 不可达（BUG-4） | cast.js:30,63,67 | P2 |
| PAT-026 | R | 后端不可用 | home/appointment/health 降级 | 开发=演示数据，上线=错误态，绝不伪造 | ✅ 符合：home _applySummaryFailed 分档；appointment withFallback 仅目录读取、提交不降级；health 降级收口 careplan 服务 | home.js:222-238；appointment.js:231,296；health.js:190 | P1 |
| PAT-027 | R | 各页错误展示 | errText 接入点 | 错误文案只走 utils/err-text.js | ❌ 不符：consultation.js _onAiFail 直出 err.message/code（BUG-3）；其余 6 处接入点合规 | consultation.js:539-543；对照 appointment.js:195,262,321,499、consult.js:469、health.js:240 | P1 |
| PAT-028 | R | 长列表分页 | require 形态 | paginate 具名对象导出，解构导入 | ✅ 符合：module.exports={PAGE_SIZE,paginate}；4 个调用方均 const { paginate } = require(...) | paginate.js:51；doctor/appointments.js:27 等 4 处 | P2 |
| PAT-029 | U | 图标纪律 | 9 个在审 wxml 全量扫描 | 禁 emoji 作图标 | ✅ 符合：命中字符全部位于注释行，渲染面零 emoji | python 扫描输出（本目录无输出文件，结论：0 渲染命中） | P2 |
| PAT-030 | U | 字号三档 | app.wxss token + 页面块 | standard/large/xlarge 三档 | ✅ 符合：--font-title 40/44/52rpx + 页面 theme-large/xlarge 覆盖块 | app.wxss:59,79,93；home.wxss:855-874 | P2 |
| PAT-031 | U | 平板断点 | ≥600px/≥900px 块 | rpx 尺寸 px 重写 | ✅ 符合：图标/砖/标题尺寸 px 化 | home.wxss:645-675；app.wxss:1053,1067 | P2 |
| PAT-032 | U | 状态表达 | 医生卡状态/急诊条 | 不只颜色，图标+文字 | ✅ 符合：statusText+statusCls 双轨；急诊条含文字+按钮 | appointment.js:246-256；triage.wxml:13-16 | P2 |
| PAT-033 | U | 横屏 | page-shell 语义 | home/consultation/appointment 双栏 | ✅ 符合：三条件（横屏+宽屏+竖屏）生效；appointment shell-cols | home.wxss:777；appointment.wxml:10-12 | P2 |
| PAT-034 | R | 列表加载 | skeleton 组件 | 骨架屏→数据到达隐藏 | ⚠️ appointment 有 skeleton；home 汇总加载无骨架屏、生产失败静默空态（BUG-5） | appointment.wxml:148；home.wxml 无 skeleton 引用 | P2 |
| PAT-035 | F | 选医生→发起问诊 | picker _gotoConsult | 带 doctorId/doctorName 深链 consult 指定模式 | ✅ 符合；挂号完成 goConsult 同参回跳 | picker.js:106-114,44-52；appointment.js:516-524 | P1 |
| PAT-036 | F | AI 养生问答流 | health onQuickAsk/onPick/_generate | 主题重开轮次、防跳题、阶段提示、拒答不做空方案 | ✅ 符合：qi 校验防旧 chip 误记；idempotency key；refused 单独 modal | health.js:112-126,145-159,164-250 | P1 |
| PAT-037 | R | health 消息流 | _appendMsg | 增量 + 60 条裁剪 | ✅ 同 consultation 口径 | health.js:340-350 | P2 |
| PAT-038 | F | 导诊结果页 | result onLoad/onCall120/onBook | 空报告态/120/挂号/导航深链/清空 | ✅ 符合 | result.js:31-34,91-95 | P1 |

---

## 3. Bug 条目

### [P1] 常用服务「体检服务 / 居家护理」点击静默无任何反馈（PAT-004）
- 位置：miniprogram/pages/home/home.js:72（`NOT_READY` 定义）；home.js:277-281（`_route` default 空分支）
- 根因：`NOT_READY = { checkup: '体检服务', care: '居家护理' }` 已定义但全仓未被任何分支引用（grep 仅命中定义行本身）；`_route('checkup'/'care')` 落到 `default: break`，无 toast、无 modal、无跳转。
- 复现：首页 → 常用服务宫格 → 点「体检服务」或「居家护理」→ 页面无任何响应。
- 影响：8 宫格中 2 个入口为死块；适老用户反复点击无感知，违背 home.js:71 注释「给中文说明，不做假跳转」的设计意图。
- 建议：`_route` 增 `case 'checkup': case 'care': wx.showModal({ title: NOT_READY[key], content: '该服务正在筹备中，敬请期待', showCancel: false })`。
- 证据：`const NOT_READY = { checkup: '体检服务', care: '居家护理' }`（home.js:72）；单测②「体检服务/居家护理：当前静默无跳转」锁定现状，修复后断言需同步改为「弹出中文说明」。

### [P1] consultation 错误文案直出 err.message/err.code，绕过 err-text.js（PAT-027）
- 位置：miniprogram/pages/consultation/consultation.js:539-543（`_onAiFail`）
- 根因：`const m = (err && (err.message || err.code)) || '网络异常'` 直接拼成「AI 助手暂时没能回答（NETWORK_ERROR）。」展示；本文件顶部 require 清单未引入 `utils/err-text.js`。
- 复现：后端不可用 / 网关 5xx / 超时 → AI 问诊发送失败 → 失败气泡括号内出现 `NETWORK_ERROR`、`TIMEOUT` 或英文后端原文。
- 影响：违反 RULE #13/#27 红线（用户文案禁英文报错、禁 HTTP 码）；适老用户看不懂英文码。
- 建议：改为 `wx.showToast({ title: errText(err, 'AI 助手暂时没能回答，请重试'), icon: 'none' })`，并在顶部 `require` err-text.js。
- 证据：consultation.js:539-543 原文；对照合规实现 appointment.js:499 `'挂号失败：' + errText(err, '请重试')`。

### [P2] 首页「健康档案」入口绕路到「我的」Tab，未直达档案页（PAT-004）
- 位置：miniprogram/pages/home/home.js:268-269
- 根因：`case 'archive': wx.switchTab({ url: '/pages/profile/profile' })`；同屏 `case 'reports'`（报告查询）却直达 `/pages/profile/health-records/health-records`（266 行）——两入口同页目标，行为不一致。
- 复现：首页 → 常用服务 → 健康档案 → 落到「我的」Tab，需再点一次才到档案页。
- 影响：多一次无效跳转；入口语义与落点不符。
- 建议：`case 'archive'` 改 `wx.navigateTo({ url: '/pages/profile/health-records/health-records' })`。
- 证据：home.js:266（reports 直达）vs 268-269（archive 绕路）；README 口径：健康档案 = pages/profile/health-records。

### [P2] appointment 本地搜索「命中医生反查科室」失效（PAT-019 旁支）
- 位置：miniprogram/pages/appointment/appointment.js:368-370（`_applyFilter`）
- 根因：医生对象在 247-255 行 map 时只存 `deptName` 未存 `deptId`；369 行 `deptIds[d.deptId] = 1` 恒为 undefined，`deptIds` 键恒为字符串 "undefined"，370 行科室反查永不命中。
- 复现：选医生步骤输入医生姓名 → 医生列表正确命中，但科室宫格不展开该医生所属科室。
- 影响：本地搜索联动缺一半；不阻断挂号主流程。
- 建议：247-255 行 map 时补 `deptId: dept.id`。
- 证据：`deptIds[d.deptId] = 1`（appointment.js:369）；医生对象字段列表（248-255）无 deptId。

### [P2] 投屏页连接态不回显，且设备列表恒空致连接/断开 UI 不可达（PAT-025）
- 位置：miniprogram/pages/tv/cast/cast.js:30（`saved` 读出后未使用）；:34（`devices: []` 硬编码）
- 根因：onLoad 读 `wb_tv` 存进局部变量 `saved` 后从未 setData 回页面；设备列表恒空 → `onConnect` 永远没有可点击的设备行，写/删 `wb_tv` 的实际路径在 UI 上不可达。
- 复现：手动写过 wb_tv 后进投屏页 → 仍显示「尚未发现设备」；页面上点不到任何设备。
- 影响：投屏连接/断开当前不可操作（页面注释已声明未接真实发现协议，属演示限定）；首页/我的页连接角标所依赖的状态在本页无法回显。
- 建议：`saved` 非空时注入一行已连接设备并标记 `connected:true`；或在真实协议接入前隐藏连接区并保留说明。
- 证据：`const saved = wx.getStorageSync('wb_tv') || null`（cast.js:30）后无第二处 saved 引用；`devices: []`（:34）。

### [P2] 首页汇总加载无骨架屏，生产档失败为静默空态（PAT-034）
- 位置：miniprogram/pages/home/home.wxml（全文无 skeleton 组件引用）；home.js:222-238
- 根因：首页无骨架屏；`_applySummaryFailed` 在生产档仅渲染空预约卡，无显式错误态与重试入口。
- 复现：弱网/后端不可用（生产档）→ 打开首页 → 预约区直接空白，无加载中、无「点击重试」。
- 影响：与通用「骨架屏→错误态+重试」口径略弱；用户无法区分「没挂号」与「加载失败」。
- 建议：预约卡加载中用 `<skeleton>`；失败空态增加「点击重试」按钮。
- 证据：home.wxml grep skeleton/loading/error 仅命中 banner 图 binderror（215 行）。

### [P2] consultation.js 文件头注释与现行实现漂移（文档债）
- 位置：miniprogram/pages/consultation/consultation.js:2-7
- 根因：头部仍写「V1.9 一句话直推导诊」，实际 2026-10-24 已重写为多轮真实后端 AI 问诊（第 2 轮起 TRIAGE、置信度阈值 0.7、兜底全科医学科）。
- 影响：后续维护者按旧注释改代码会误判链路。
- 建议：更新头部注释为现行多轮链路说明。
- 证据：consultation.js:345-361 旧实现废弃注释；:35-36 TRIAGE_MIN_CONFIDENCE=0.7。

---

## 4. 口径差异登记（非缺陷，备查）

1. **四宫格标签**：现行实现为「AI 智能导诊 / 预约挂号 / 在线问诊 / 报告查询」（home.js:40-45），任务书描述为「智能问诊/预约挂号/AI养生/报告查询」——以设计稿 01-首页.png 与 V1.19 为准，非缺陷。
2. **问诊主流程**：现行=多轮真实后端 AI 问诊（非「一句话直推导诊」），系 2026-10-24 重写（DEV_LOG 已载），导诊页仍承担「一句话直出科室」能力（PAT-010）。
3. **挂号预约号**：任务书「本地预约号写 wb_new_appointments」已过时——现走后端契约 AppointmentCreate，预约号取 `res.id`；`wb_new_appointments` 无写入点（records.js:168 注释确认死代码已移除）。

---

## 5. 页面核对表

### 页面 miniprogram/pages/home/home
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| hero 问候语不被小安徽章压 | U | ✅ | home.wxss:83-111 | flex 行布局，非绝对定位 |
| 四宫格 4 入口 | F | ⚠️ | home.js:40-45,243-266 | 跳转全对；标签口径见 §4-1 |
| 快选词 ?text= 深链 | F | ✅ | home.js:245 | encodeURIComponent |
| 8 宫格常用服务 | F | ❌ | home.js:48-60,277-281 | checkup/care 死块 BUG-1；archive 绕路 BUG-2 |
| 健康提示横滑卡→detail | F | ✅ | home.js:358；home.wxml | scroll-x 横滑 |
| 全部健康科普→knowledge | F | ✅ | home.js:275 | |
| banner→导诊 | F | ✅ | home.wxml:214 | |
| 降级 MOCK_FALLBACK | R | ✅ | home.js:222-238 | 开发演示/上线空态 |
| 骨架屏 | R | ⚠️ | home.wxml 无 skeleton | BUG-5 |

### 页面 miniprogram/pages/triage/triage
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 红旗本地优先→弹窗+120+急诊科 | S | ✅ | triage.js:252,382-408；engine:369-374,444-460 | 后端报急同样切急诊科 |
| 隐私开关首次弹窗/仅本地零后端 | S | ✅ | triage.js:118-136；services/triage.js:128-132 | 取消即 _remoteAllowed=false |
| 一句话直出科室/仅补问一次 | F | ✅ | services/triage.js:123-125 | |
| answerNav 否定先判 | F | ✅ | services/triage.js:49-55 | 单测 11 例 |
| 路线按钮/打字应答 | F | ✅ | triage.js:226-238,433-444 | |
| 发送中防重复 | R | ✅ | triage.js:222；单测④b | |
| 增量 setData+60 裁剪 | R | ✅ | triage.js _appendMsg | 同 consultation 口径 |
| 侧栏动作面板 | F | ✅ | home.js:277 onMore | |

### 页面 miniprogram/pages/triage/result/result
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 空报告空态 | R | ✅ | result.js:31-34 | |
| 一键120/挂号/导航深链 | F | ✅ | result.js:91-95 | encodeURIComponent |
| 朗读降级提示 | R | ✅ | result.js speak 降级 toast | |
| 清空报告二次确认 | F | ✅ | result.js onClear | |

### 页面 miniprogram/pages/consultation/consultation
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 进门欢迎语开场 | F | ✅ | consultation.js onLoad | 多轮真实 AI 链路，见 §4-2 |
| 4 个症状示例可点 | F | ✅ | consultation.js:79；wxml:178 | |
| 60 条裁剪 | R | ✅ | consultation.js:316-326；单测③ | |
| 增量 setData messages[i] | R | ✅ | consultation.js:323-325；单测③ | |
| 防重复提交 | R | ✅ | consultation.js:364；单测④ | |
| 路线询问卡 | F | ✅ | consultation.js navask；wxml:167-168 | |
| 错误文案 err-text | R | ❌ | consultation.js:539-543 | BUG-3（P1） |
| 隐私闸门（开发档） | S | ✅ | consultation.js:254-255 | |
| 无 _fallbackDept 伪造科室 | R | ✅ | grep 无命中 | 旧本地引擎已下线 |

### 页面 miniprogram/pages/appointment/appointment
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 状态机 dept→doctor→time→confirm→done | F | ✅ | appointment.js:230,279,383,477；单测⑤ | |
| 防重复提交+幂等键 | R | ✅ | appointment.js:439,458,462-466；单测⑤ | |
| 409 号源已满回退 | R | ✅ | appointment.js:486-497 | |
| 错误文案 err-text | R | ✅ | appointment.js:195,262,321,499 | |
| 搜索过滤 | F | ⚠️ | appointment.js:357-372 | 医生反查科室失效 BUG-4（P2） |
| skeleton/error-card | R | ✅ | appointment.wxml:99,148 | |
| page-shell 横屏 | U | ✅ | appointment.wxml:10-12 | |
| goNav/goConsult 深链 | F | ✅ | appointment.js:511-524 | encodeURIComponent |

### 页面 miniprogram/pages/consult/consult（患者侧）
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| CLOSED 终态医生卡「已结束」 | F | ✅ | consult.js:226,236-237；wxml:51 | |
| CLOSED 底栏只读条+停轮询 | R | ✅ | consult.js:402-405；wxml:178 | |
| 发送 409→终态 | R | ✅ | consult.js:453-465 | |
| 键盘适配 adjust-position=false | F | ✅ | consult.wxml:198-202,213；consult.js:418-425 | |
| 发送防重复 | R | ✅ | consult.js:401,443,471 | sending 守卫 |
| 失败原文归还用户 | R | ✅ | consult.js:468-469 | errText 合规 |
| 历史会话只读语义 | F | ✅ | consult.js:242 closed→remainingText='' | |

### 页面 miniprogram/pages/consult/picker/picker
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 医生列表+科室过滤 | F | ✅ | picker.js:61-90 | |
| →consult 指定医生模式深链 | F | ✅ | picker.js:106-114 | |
| 挂号 done 页直跳带参 | F | ✅ | appointment.js:516-524 | |
| 错误态 errText | R | ✅ | picker.js:66 | |
| 不指定医生跳过 | F | ✅ | picker.js:102-104 | |

### 页面 miniprogram/pages/health/health
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 问答流幂等启动/主题重开 | F | ✅ | health.js:98-126 | |
| 防旧 chip 跳题 | F | ✅ | health.js:148-149 qi 校验 | |
| care-plan 阶段提示/拒答不做空方案 | R | ✅ | health.js:176-224 | |
| 错误文案 errText | R | ✅ | health.js:240-242 | |
| 增量 setData+60 裁剪 | R | ✅ | health.js:340-350 | |
| onUnload 清定时器/TTS | R | ✅ | health.js:85-95 | |
| 导航 600ms 锁 | R | ✅ | health.js:370-375 | |

### 页面 miniprogram/pages/tv/cast/cast
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 连接写 wb_tv / 断开清理 | F | ✅ | cast.js:63,67 | |
| 已连接状态展示 | F | ❌ | cast.js:30 saved 未回显 | BUG-6（P2） |
| 设备发现演示诚实空态 | R | ✅ | cast.js:27-29,46-48 | 不伪造搜到设备 |
| onConnect 可达性 | F | ❌ | cast.js:34 devices 恒空 | UI 无触发路径 BUG-6 |
| 功能切换预览 | F | ✅ | cast.js:74-79 | |

---

## 6. 汇总

- **P0：0 项**（安全红线：红旗本地优先/一键120/隐私零后端/否定先判/防重复提交 全部 ✅）
- **P1：2 项**（BUG-1 常用服务死块无反馈；BUG-2 consultation 错误文案绕过 err-text.js）
- **P2：5 项**（健康档案绕路 / 搜索反查科室失效 / 投屏不可达+不回显 / 首页无骨架屏 / consultation 头注释漂移）
- 新增离线单测：`tools/test-patient-flows-audit.js`，**PASS 41 / FAIL 0**；`tools/check-project.js` 全绿。
- 修复优先级建议：先修 BUG-2（英文报错红线）→ BUG-1（死块一行接线）→ 其余 P2 排期。
