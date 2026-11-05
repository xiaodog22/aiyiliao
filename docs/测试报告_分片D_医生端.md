# 分片 D 测试报告 —— 医生端 8 页（只读静态审查 + 离线单测）

- 审查日期：2026-10-29
- 范围：`pages/doctor/{workbench,appointments,beds,personal,consult,schedule,account-security,messages}` 三件套 + `components/doctor-tab-bar` + `services/doctor.js` + `services/session.js`
- 方法：静态审查（Grep 定位 + 逐件读，证据带 `文件:行号`）+ 离线单测 `tools/test-doctor-pages-audit.js`（打桩 wx/getApp/Page/storage/request，node 实跑）
- 红线：未修改任何页面/服务/样式源码；新增仅 `tools/test-doctor-pages-audit.js` 与本报告

---

## 0. 结论速览

| 项 | 结果 |
| --- | --- |
| 新增离线单测 | `node tools/test-doctor-pages-audit.js` → **PASS=31 / FAIL=1**（退出码 1） |
| 唯一红灯 | DOC-B[consult]：consult.onLoad 缺角色鉴权拦截（深链直达可绕过客户端门） |
| Bug 统计 | **P0 = 0，P1 = 1，P2 = 3** |
| 契约漂移说明 | 叫号状态流转实际走 `POST /api/v1/doctor/appointments/{id}/status`（非旧 `/api/appoint/updateStatus`，后者网关 compat pending=501，前端已不调用） |

---

## 1. 用例表（DOC-xxx）

| ID | 维度 | 前置 | 步骤/审查路径 | 预期 | 实测 | 证据 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DOC-A1 | F/R | — | `require(utils/paginate.js)` 具名解构 | 拿到的是函数 | ✅ | test-doctor-pages-audit.js；appointments.js:27 `const { paginate } = require(...)` | P1 |
| DOC-A2 | F | — | `paginate(arr,1).all` 回传全量 | all.length=45 | ✅ | 单测 DOC-A2 | P1 |
| DOC-A3 | F | — | displayed/total/hasMore 齐备 | 20/45/true | ✅ | 单测 DOC-A3；appointments.js:285-292 | P1 |
| DOC-A4 | F | — | 模块为对象导出 | typeof object | ✅ | 单测 DOC-A4 | P1 |
| DOC-B-workbench | F | role=patient | onLoad | reLaunch 登录 | ✅ | workbench.js:72-76 | P0 |
| DOC-B-appointments | F | role=patient | onLoad | reLaunch 登录 | ✅ | appointments.js:102-106 | P0 |
| DOC-B-beds | F | role=patient | onLoad | reLaunch 登录 | ✅ | beds.js:87-91 | P0 |
| DOC-B-personal | F | role=patient | onLoad | reLaunch 登录 | ✅ | personal.js:26-30 | P0 |
| DOC-B-schedule | F | role=patient | onLoad | reLaunch 登录 | ✅ | schedule.js:39-43 | P0 |
| DOC-B-account-security | F | role=patient | onLoad | reLaunch 登录 | ✅ | account-security.js:23-27 | P0 |
| DOC-B-messages | F | role=patient | onShow | reLaunch 登录 | ✅ | messages.js:33-37 | P0 |
| DOC-B-consult | F | role=patient，深链 `consult?id=x` | onLoad({}) | reLaunch 登录 | ❌ **未拦截** | consult.js:57-85（无 role 判断）；单测 DOC-B[consult] 红灯 | P1 |
| DOC-C1 | F/R | doctor | 列表拉取后 data.all | 非空 | ✅ | appointments.js:155-164；单测 DOC-C1 | P1 |
| DOC-C2 | F | apt1=PENDING | 初态 | canCall=true | ✅ | appointments.js:72-77；单测 DOC-C2 | P1 |
| DOC-C3/C4 | F | 点叫号 | onCall | POST 流转→CHECKED_IN | ✅ | appointments.js:322-324,362；doctor.js:184-193；单测 DOC-C3/C4 | P0 |
| DOC-C5 | R | 叫号请求 | 检查请求头 | 带 Idempotency-Key | ✅ | doctor.js:192；request.js:474；单测 DOC-C5 | P1 |
| DOC-C6 | F | 叫号成功 | 乐观更新 | apt1→CHECKED_IN,canFinish | ✅ | appointments.js:344-381；单测 DOC-C6 | P1 |
| DOC-C7 | F | `_submitting=true` | 再点叫号 | 忽略，不发请求 | ✅ | appointments.js:339；单测 DOC-C7 | P1 |
| DOC-C8 | F | 409 版本冲突 | onCall | 行状态回滚 | ✅ | appointments.js:383-391；单测 DOC-C8 | P1 |
| DOC-D1 | F/R | ACTIVE 会话 | onCloseConsult→二次确认 | 弹 showModal→POST /close | ✅ | consult.js:450-463；doctor.js:274-280；单测 DOC-D1 | P0 |
| DOC-D2 | R | /close 请求 | 检查请求头 | 带 Idempotency-Key | ✅ | doctor.js:279；单测 DOC-D2 | P1 |
| DOC-D3 | F | close 成功 | 成功分支 | status=CLOSED+锁输入+停轮询+拉 system_notice | ✅ | consult.js:464-479；单测 DOC-D3 | P0 |
| DOC-D4 | F | close 返回 409 | catch 409 | 当已结束收口，不报错 | ✅ | consult.js:480-491；单测 DOC-D4 | P1 |
| DOC-D5 | F | close 返回 404 | catch 404 | 不收口，保留 ACTIVE，提示非本人 | ✅ | consult.js:492-497；单测 DOC-D5 | P1 |
| DOC-D6 | F | `closing=true` | onCloseConsult | 不弹确认/不发请求 | ✅ | consult.js:452；单测 DOC-D6 | P1 |
| DOC-U1 | U | — | 医生端图标来源 | 全部 utils/icons.js，无 emoji 作图标 | ✅ | workbench.wxml:15 注释；doctor-tab-bar/index.js:19-44（Gray/active 成对）；Grep 无渲染态 emoji | P2 |
| DOC-U2 | U | — | 错误文案出口 | 只走 err-text.js，不直出 err.message | ✅ | workbench.js:214；appointments.js:167；beds.js:131；consult.js:371,557；均经 errText | P1 |
| DOC-U3 | U | — | 危险色令牌 | 用 var(--danger-text)，不用不存在的 var(--danger) | ✅ | consult.wxss:67,337；Grep 全医生端无 `var(--danger)`（无 -text） | P2 |
| DOC-U4 | U | ≥600/≥900px | 断点 px 重写 | rpx 在宽屏折 px | ✅ | workbench.wxss:581(≥600px),579 注释；appointments.wxss:8,215 | P2 |
| DOC-U5 | U | 横屏平板 | 工作台双栏 | page-shell+shell-cols | ✅ | workbench.wxml:17(`page-shell`),41(`shell-cols`),73(`shell-main`) | P2 |
| DOC-U6 | F | 已结束会话 | 输入区 | 输入栏替换为只读条，不再渲染 input | ✅ | consult.wxml:157-160(wx:if CLOSED 只读条),160(block wx:else 才渲染 input)；consult.wxss:374 | P1 |
| DOC-U7 | F | 键盘弹起 | adjust-position | =false，kbHeight 顶输入栏、页面不位移 | ✅ | consult.wxml:169 `adjust-position="{{false}}"`；consult.wxml:14 padding-bottom={{kbHeight}}；consult.js:433-443 | P1 |

---

## 2. Bug 条目

### [P1] consult（在线问诊·医生侧）onLoad 缺角色鉴权拦截，深链可绕过客户端门（DOC-B-consult）
- 位置：`miniprogram/pages/doctor/consult/consult.js:57-85`
- 根因：其余 7 页均在 onLoad（messages 在 onShow）首行判 `app.globalData.role !== 'doctor' → reLaunch 登录`；consult.onLoad 只做状态栏/参数解码，无任何角色判断即进入 `loadMessages`/`loadList`。
- 复现：患者已登录（role=patient）→ 任意途径跳转 `/pages/doctor/consult/consult?id=<会话id>`（如外部二维码/调试器直接编译目标页）→ 直接进入医生聊天 UI，无 reLaunch。
- 影响：与「全 8 页 onLoad 鉴权拦截」设计不一致。**数据层有兜底**：loadMessages 对非本人/未接诊返回 404 → consult.js:367-375 置 noAccess 锁输入并提示，故不会泄露他人消息；但 UX 门与他页不统一，患者角色会先看到医生侧空壳界面。
- 建议：在 consult.onLoad 开头补 `if (app.globalData.role !== 'doctor') { wx.reLaunch({url:'/pages/auth/login/login'}); return }`，与其余 7 页对齐。
- 证据：
  ```js
  // consult.js:57 —— 对比 appointments.js:103 / workbench.js:73 均有 gate
  onLoad(options) {
    const q = options || {}
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}
    this._gone = false
    this.setData({ icons, theme: app.globalData.theme || 'standard', ... })
    // ↑ 全程无 role 判断
  ```
  单测输出：`✗ DOC-B[consult] 非doctor深链直达被拦截→reLaunch登录 ← 实得 reLaunch=[]（consult.onLoad 缺角色拦截）`

### [P2] 鉴权门仅在 onLoad、不在 onShow 复核；role 为内存态可被本地伪造（DOC-B 系列）
- 位置：workbench.js:72(onLoad) vs 97(onShow 无复核)；其余页同。
- 根因：角色判定用内存 `app.globalData.role`（workbench.js:73），非每次进入校验；`services/session.js:4` 明确 access token 仅内存、wb_role_hint 仅「非权威提示」。
- 影响：客户端门是 UX 提示而非安全边界；服务端按 DB 任职关系判定角色（doctor.js:9-10 无 ACTIVE 任职→403），伪造本地 role 拿不到任何医生数据。**结论：设计内可接受，非漏洞**，仅记录。
- 建议：维持现状；如需纵深，可在各页 onShow 补一次轻量复核。

### [P2] KNOWN_ISSUES #3「床位管理为演示占位」已与代码漂移（DOC beds）
- 位置：AI_CONTEXT.md KNOWN_ISSUES #3（文字）；实际 beds.js:111-142,202-233 已接真实契约 `GET /api/v1/beds` + `POST /api/v1/beds/{bedId}/assignment`（expectedVersion+幂等键，409 刷新重试）。
- 根因：床位页已从演示占位迁移到契约端点，但 AI_CONTEXT 未同步更新；beds.wxml 也无「演示占位」说明。
- 影响：文档误导后续审查/路演口径。
- 建议：更新 AI_CONTEXT KNOWN_ISSUES #3 为「床位已接契约端点」。

### [P2] appointments 错误态同时渲染占位骨架条与错误卡，轻微冗余（DOC-U4/错误态）
- 位置：appointments.wxml:36 `wx:elif="{{error}}" class="ast-skel ast-skel-mute"` 与 appointments.wxml:42 `wx:if="{{error}}" class="state"` 同时命中。
- 根因：列表区在 error 时先渲染一条静默骨架条，下方又渲染完整 `.state` 错误卡（图标+中文+实心重试按钮，appointments.wxml:42-46）。
- 影响：视觉上多出一条浅灰占位条，不影响功能与重试。
- 建议：列表区 `wx:elif` 去掉 error 分支（error 已由 .state 块承担）。

---

## 3. 页面核对表

### 页面 pages/doctor/workbench/workbench
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| onLoad 角色拦截 | F | ✅ | workbench.js:72-76 | 非 doctor→reLaunch 登录 |
| 今日概览数据链路 | F | ✅ | workbench.js:176-216 | listAppointments→本地聚合 WAITING/IN_PROGRESS/DONE，30s 缓存，force 绕过缓存 |
| 概览错误态+重试 | U | ✅ | workbench.wxml:144-147 同域 error-inline；workbench.js:214 errText | 卡片内局部失败实心重试 |
| 待办派生（签到/问诊） | F | ✅ | workbench.js:235-311 | CHECKED_IN 今日数 + ACTIVE 且 assignedDoctorId 数；两路独立降级 |
| 宫格/入口跳转 | F | ✅ | workbench.js:359-377 ROUTES | 8 个 key 映射真实页；无页者 toast 如实提示 |
| 深海青主题/令牌 | U | ✅ | workbench.wxml:10,579 | 页面级主题 + ≥600px rpx→px |
| 横屏双栏 .page-shell | U | ✅ | workbench.wxml:17,41,73 | page-shell+shell-cols+shell-main |
| 空态 | U | ✅ | workbench.wxml:169-171 | todo-empty 图标+文字 |

### 页面 pages/doctor/appointments/appointments
| 功能点（设计要求） | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| paginate 对象导出回归 | F | ✅ | appointments.js:27 | `const { paginate } = require(...)`，回归安全 |
| 列表分页/触底 | F | ✅ | appointments.js:129-136,172-198 | 服务端 cursor 优先、本地切片兜底，按 id 去重 |
| 叫号→就诊中→已完成 | F | ✅ | appointments.js:322-329,338-398 | onCall→CHECKED_IN / onFinish→COMPLETED，乐观更新+失败回滚 |
| 状态流转端点 | R | ✅ | doctor.js:184-193 | 实为 POST /api/v1/doctor/appointments/{id}/status；旧 /api/appoint/updateStatus 已不调用（appointments.js:18-19） |
| 409 错误处理 | F | ✅ | appointments.js:385-391 | VERSION_CONFLICT 提示并刷新；幂等重用提示已提交 |
| 错误卡+实心重试 | U | ✅ | appointments.wxml:42-46 | .state + state-badge-primary + .btn.btn-primary 重试 |
| 空态 | U | ✅ | appointments.wxml:75-78 | state-badge-gray + 中文空态文案 |
| 防连点 | F | ✅ | appointments.js:339 | `if(this._submitting) return` |

### 页面 pages/doctor/beds/beds
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| onLoad 拦截 | F | ✅ | beds.js:87-91 | — |
| 数据链路 | F | ✅ | beds.js:111-142,202-233 | 契约 GET /api/v1/beds + POST assignment（expectedVersion+幂等键） |
| 演示占位说明 | U | ⚠️ | AI_CONTEXT #3 vs beds.js | 已接真实端点，#3「演示占位」过时（见 P2 Bug） |
| 安排入住防重/409 | F | ✅ | beds.js:177,198,203,225-230 | assigning 锁 + 409 刷新 |
| 入口/返回 | F | ✅ | beds.js:100-107 | 栈底回工作台 |

### 页面 pages/doctor/personal/personal
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| onLoad 拦截 | F | ✅ | personal.js:26-30 | — |
| 展示/保存 | F | ✅ | personal.js:57-84 | GET /me，失败保留登录态资料 |
| 敏感信息脱敏 | F | ✅ | personal.js:79 | phone 只取 maskedPhone（138****0000），明文不落前端 |
| 入口跳转 | F | ✅ | personal.js:95-104 | schedule/account-security/messages 均真实页 |
| 退出登录二次确认 | F | ✅ | personal.js:106-118 | showModal confirm→app.logout+reLaunch |

### 页面 pages/doctor/consult/consult
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| onLoad 角色拦截 | F | ❌ | consult.js:57-85 | **唯一缺拦截页，见 P1 Bug** |
| 会话列表 accepting/in_list | F | ✅ | consult.js:121-141,220-258 | assigned/accepting 派生，认领池先接诊 |
| 聊天发送/轮询 | F | ✅ | consult.js:392-424,513-559 | CHAT 4s/LIST 8s；发送 409 自动收口 |
| 结束问诊闭环 | F | ✅ | consult.js:450-503 | showModal→closeConsultation→成功锁输入/停轮询/loadMessages 拉 system_notice |
| 409 当已结束 | F | ✅ | consult.js:483-491 | 收口为 CLOSED，不报错 |
| 404 非本人 | F | ✅ | consult.js:492-497 | 不收口，提示「不属于您」 |
| 已结束态导航灰字+只读输入条 | U | ✅ | consult.wxml:24,157-160；consult.wxss:374 | CLOSED 替换 input 为只读条 |
| 键盘适配 | U | ✅ | consult.wxml:169；consult.js:433-443 | adjust-position=false + kbHeight padding-bottom |
| var(--danger-text) | U | ✅ | consult.wxss:67,337 | 无裸 var(--danger) |

### 页面 pages/doctor/schedule/schedule
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| onLoad 拦截 | F | ✅ | schedule.js:39-43 | — |
| 数据链路 | F | ✅ | schedule.js:55-85 | GET /api/v1/doctor/schedule |
| 保存/在线开关幂等 | F | ✅ | schedule.js:148-178,88-100 | saving 锁 + expectedVersion 乐观锁 + 幂等键；409 提示重载 |
| 空态/休诊 | U | ✅ | schedule.js:73 | 无排班天 hasSchedule=false，保存不提交 |
| 错误态 | U | ✅ | schedule.js:83 | errText 中文 |

### 页面 pages/doctor/account-security/account-security
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| onLoad 拦截 | F | ✅ | account-security.js:23-27 | — |
| 功能完整性 | F | ✅ | account-security.js:34-49 | GET /me 展示 maskedPhone/phoneBound；无密码体系不伪造密码框（注释 line 5-6） |
| 防重复提交 | F | ✅ | account-security.js:56-68 | 退出登录 showModal 确认；本页无写按钮 |
| 退出登录 | F | ✅ | account-security.js:56-68 | — |

### 页面 pages/doctor/messages/messages
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 角色拦截 | F | ✅ | messages.js:33-37(onShow) | 无 onLoad，拦截放 onShow（每次进入校验） |
| 列表/未读 | F | ✅ | messages.js:46-74 | unread-count + listMessages 并行 |
| 标记已读/跳转 | F | ✅ | messages.js:76-90,92-98 | 乐观已读 + refType=consultation 跳会话 |
| 错误态 | U | ✅ | messages.js:51 | errText 中文 |

### 组件 components/doctor-tab-bar
| 功能点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 图标来源 | U | ✅ | index.js:19-44,59-61 | layoutGrid/users/bell/user × Gray/active 成对，来自 utils/icons.js |
| 平级切换防堆栈 | F | ✅ | index.js:78-84 | redirectTo，fail 回落 reLaunch（避免「点了没反应」） |
| 当前项不重复跳 | F | ✅ | index.js:68 | key===current 直接 return |

---

## 4. 离线单测运行摘要

命令：`node tools/test-doctor-pages-audit.js`
结果：**PASS=31 / FAIL=1**（退出码 1）

```
===== test-doctor-pages-audit.js =====
PASS=31  FAIL=1
失败明细：
  ✗ DOC-B[consult] 非doctor深链直达被拦截→reLaunch登录  ← 实得 reLaunch=[]（consult.onLoad 缺角色拦截）
```

覆盖：A paginate 对象导出回归(4) / B 8 页鉴权拦截(13) / C 叫号状态流转守卫(8) / D 结束问诊 409/404/防重(6)。
唯一失败即第 2 节 P1 Bug 的可执行回归锁。

---

## 5. 修复建议（优先级）

1. **P1**：consult.onLoad 开头补角色拦截（与其余 7 页同形）。
2. **P2**：更新 AI_CONTEXT KNOWN_ISSUES #3（床位已接真实端点）；appointments.wxml 错误态去掉多余 ast-skel-mute 分支；（可选）onShow 复核 role。
