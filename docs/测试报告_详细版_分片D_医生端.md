# 分片 D 详细版测试报告 —— 医生端 8 页（第二轮·深挖）

- 审查日期：2026-10-29
- 范围：`pages/doctor/{workbench,appointments,beds,personal,consult,schedule,account-security,messages}` + `components/doctor-tab-bar` + `services/doctor.js` + `services/session.js`
- 方法：只读静态审查（证据带 `文件:行号`）+ 离线单测 `tools/test-doctor-deep-audit.js`（打桩 wx/Page/Component/storage，require 真实 app.js + 真实 services + 真实页面跑逻辑）
- 红线：未修改任何页面/服务/样式源码；新增仅 `tools/test-doctor-deep-audit.js` 与本报告
- 与第一轮关系：第一轮 `docs/测试报告_分片D_医生端.md` 的唯一红灯（P1-06 consult 缺拦截）在本轮回测时**已修复转绿**；P2-03（workbench onShow 会话复查 + 缺失 loginAt 收紧）**已修复转绿**。本轮新增深挖：逐页用例化、输入边界、storage 篡改、适老化量化。

---

## 0. 结论速览

| 项 | 结果 |
| --- | --- |
| 本轮新增离线单测 | `node tools/test-doctor-deep-audit.js` → **PASS=34 / FAIL=0**（退出码 0） |
| 第一轮脚本复跑 | `test-doctor-pages-audit.js` → **PASS=32 / FAIL=0**（原 31/1，P1-06 红灯转绿） |
| 用例数 | **97 条**（workbench 12 / appointments 15 / beds 11 / personal 11 / consult 15 / schedule 12 / account-security 10 / messages 11） |
| 新发现 bug | **P0=0 / P1=0 / P2=2 / P3=4**（全部为适老化触控目标与小健壮性项） |
| 修复验证断言 | 断言①②③ **3/3 全绿**（任务书预期"当前红"，实测修复已落地，记录真实红绿） |
| storage 篡改 | 页面层 8 页门放行（伪造 wb_role=doctor 进得去）；数据层 `ensureAccessToken` 本地 `AUTH_REQUIRED`、**零网络**（已实测） |

---

## 1. 修复验证断言表（P1-06 / P2-03，当前真实红绿）

| # | 断言 | 任务书预期 | 实测结果 | 证据 |
| --- | --- | --- | --- | --- |
| ① | consult.onLoad 在 role!=='doctor' 时 reLaunch 登录页 | 红（轮一：reLaunch=[]） | 🟢 **绿**：patient→reLaunch `/pages/auth/login/login`；doctor→放行 | consult.js:61-64；脚本 `DOC-D-A[consult]` ×2 |
| ② | 8 页 onLoad/onShow 全部有角色拦截 | 7 绿 1 红 | 🟢 **绿**：8/8 全过（patient 全 reLaunch、doctor 全放行） | 脚本 `DOC-D-A[*]` ×16 |
| ③ | workbench.onShow 对过期会话（wb_login_at 超 72h）执行登出/重定向 | 红（onShow 不复查） | 🟢 **绿**：过期→reLaunch 登录 + `isLoggedIn()` 内部 logout 清 wb_role；新鲜会话→放行 | workbench.js:100-103；app.js:55-64；脚本 `DOC-D-B2/B4/B5` |
| 连带 | `isLoggedIn()` 缺失 loginAt 按失效（AUTH-25 收紧） | 红（原 `!loginAt → return false`=未过期） | 🟢 **绿**：缺失 loginAt → false 且清 wb_role | app.js:59；脚本 `DOC-D-B3` |

> 说明：DEV_LOG 尾部（2026-10-29）记载「doctor 32/0（原 31/1，红灯转绿）」与本轮实测一致——P1-06/P2-03 在两轮之间已被修复，本轮脚本为**回归锁**而非红灯复现。

---

## 2. 鉴权拦截逐页证据（8 页 onLoad/onShow）

| 页面 | hook | 拦截代码位置 | patient→reLaunch | doctor→放行 |
| --- | --- | --- | --- | --- |
| workbench | onLoad + onShow | onLoad workbench.js:73-76；onShow :100-103（追加 `!app.isLoggedIn()`） | ✅ | ✅ |
| appointments | onLoad | appointments.js:103-106 | ✅ | ✅ |
| beds | onLoad | beds.js:88-91 | ✅ | ✅ |
| personal | onLoad | personal.js:27-30 | ✅ | ✅ |
| consult | onLoad | consult.js:61-64（**本轮复测确认已补**） | ✅ | ✅ |
| schedule | onLoad | schedule.js:40-43 | ✅ | ✅ |
| account-security | onLoad | account-security.js:24-27 | ✅ | ✅ |
| messages | onShow | messages.js:34-37（无 onLoad，每次进入校验） | ✅ | ✅ |

---

## 3. 逐页用例表（DOC-D-xxx，标签 F/S/R/U）

### 3.1 pages/doctor/workbench（12 条）

| ID | 维度 | 步骤/审查路径 | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- |
| DOC-D-001 | F | onLoad 拉 /me + /doctors + /doctor/appointments 三路 | 姓名/头像渲染，科室职称同名唯一才显示 | ✅ | workbench.js:131-158；:152-155 同名多人不猜 |
| DOC-D-002 | F | 概览聚合：WAITING/IN_PROGRESS/DONE | 按 rawStatus 英文枚举分组统计 | ✅ | workbench.js:34-36,201-204 |
| DOC-D-003 | R | 过期历史预约 | startTime<今日0点 不计入 | ✅ | workbench.js:199-200 |
| DOC-D-004 | R | 概览 30s 缓存 + force 绕过 | 重复进入不重复请求；下拉刷新直拉 | ✅ | workbench.js:30,184-187,224-226 |
| DOC-D-005 | F | 待办派生：CHECKED_IN 今日数 + 已分配 ACTIVE 会话数 | 两路独立降级 | ✅ | workbench.js:259-289 |
| DOC-D-006 | F | 待办「处理」跳转 | CHECKIN→appointments；CONSULT_REPLY→consult | ✅ | workbench.js:320-331 |
| DOC-D-007 | F | 宫格 onQuick ROUTES 8 key | 均映射真实页；无页者 toast 如实提示 | ✅ | workbench.js:365-383 |
| DOC-D-008 | R | onShow 复查会话 | 过期/role 被清→reLaunch 登录 | ✅ | workbench.js:100-103（脚本 B5） |
| DOC-D-009 | R | onShow 未读数 | unreadCount 失败不阻断页面 | ✅ | workbench.js:108-110 |
| DOC-D-010 | U | 错误态 .error-inline 实心重试 | 卡片内局部失败 | ✅ | workbench.js:220 errText |
| DOC-D-011 | U | 快捷宫格触控 | .tw-tile 126rpx=63px ≥44px | ✅ | workbench.wxss:316-317 |
| DOC-D-012 | U | 待办「处理」胶囊触控 | .todo-btn 112×50rpx | ❌ 50rpx=25px 不达 44px | workbench.wxss:414-416（见 D-P2-02） |

### 3.2 pages/doctor/appointments（15 条·重点页）

| ID | 维度 | 步骤/审查路径 | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- |
| DOC-D-013 | F | onLoad 角色拦截 | patient→reLaunch | ✅ | appointments.js:103-106 |
| DOC-D-014 | F | fetch 拉队列（今天及未来） | 前端过滤 startTime≥今日0点 | ✅ | appointments.js:151-154,201-204 |
| DOC-D-015 | F | 服务端 cursor 续拉 | 有 nextCursor→_appendMore；按 id 去重 | ✅ | appointments.js:129-136,172-198,183-184 |
| DOC-D-016 | F | 四列概览与筛选同源 | 点列筛选条数=列数字 | ✅ | appointments.js:62-66,279-295,302-310 |
| DOC-D-017 | F | 叫号 onCall | PENDING/CONFIRMED→CHECKED_IN | ✅ | appointments.js:72-77,322-324,347-356 |
| DOC-D-018 | F | 完成就诊 onFinish | CHECKED_IN→COMPLETED | ✅ | appointments.js:327-329 |
| DOC-D-019 | S | 状态流转带 Idempotency-Key | key=docappt-{id}-{to}-{version} | ✅ | appointments.js:359；doctor.js:196 |
| DOC-D-020 | S | 防连点 | _submitting=true 再点忽略 | ✅ | appointments.js:339 |
| DOC-D-021 | R | 409 VERSION_CONFLICT | 行状态回滚 + toast + fetch 刷新 | ✅ | appointments.js:383-391 |
| DOC-D-022 | R | IDEMPOTENCY_KEY_REUSE | 提示「已提交过」 | ✅ | appointments.js:386-389 |
| DOC-D-023 | F | 乐观更新以服务端为准 | 返回后同步 version | ✅ | appointments.js:364-379 |
| DOC-D-024 | F | 候诊序号 queueNumber | 1-2 位补 0 到 3 位；空→「—」 | ✅ | appointments.js:250-254 |
| DOC-D-025 | U | 行用 id 定位非 index | 筛选切片下不错位 | ✅ | appointments.js:340（注释 :336） |
| DOC-D-026 | U | 叫号/完成按钮触控 | .apt-btn height | ❌ 50rpx=25px 不达 44px | appointments.wxss:192-204（见 D-P2-01） |
| DOC-D-027 | U | 统计列整列触控 | ast-col≈160rpx=80px | ✅ | appointments.wxss:72-85 |

### 3.3 pages/doctor/beds（11 条）

| ID | 维度 | 步骤/审查路径 | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- |
| DOC-D-028 | F | onLoad 拦截 + fetch 床位列表 | GET /api/v1/beds | ✅ | beds.js:88-91,116 |
| DOC-D-029 | R | fetch 连点保护 | _loading 期间忽略重试 | ✅ | beds.js:112-113 |
| DOC-D-030 | F | 状态映射 BED_META | 未知状态按维修中中性展示不猜语义 | ✅ | beds.js:24-30,241-243 |
| DOC-D-031 | F | 病区筛选 | ≥2 病区才出 tabs；当前病区消失回落全部 | ✅ | beds.js:121-124,160-164 |
| DOC-D-032 | F | 四列统计 buildStats | OCCUPIED/RESERVED 计占用 | ✅ | beds.js:272-287 |
| DOC-D-033 | S | 安排入住 patientRef 空值拦截 | 空→抽屉内错误提示不发请求 | ✅ | beds.js:204-208 |
| DOC-D-034 | S | 抽屉内重试复用同一幂等键 | idemKey 打开抽屉时生成一次 | ✅ | beds.js:187,215 |
| DOC-D-035 | S | assigning 锁 | 提交中不可重复提交/不可关抽屉 | ✅ | beds.js:177,198,203 |
| DOC-D-036 | R | 409 版本冲突 | 关抽屉 + toast「床位状态已变化」+ fetch | ✅ | beds.js:225-230 |
| DOC-D-037 | F | 失败错误态清空 | all/wards/wardId/displayed/legend 全复位 | ✅ | beds.js:128-138 |
| DOC-D-038 | U | 操作按钮/输入框触控 | 88rpx=44px | ✅ | beds.wxss:114,271,306 |

### 3.4 pages/doctor/personal（11 条）

| ID | 维度 | 步骤/审查路径 | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- |
| DOC-D-039 | F | onLoad 拦截 | patient→reLaunch | ✅ | personal.js:27-30 |
| DOC-D-040 | F | 先用登录态兜底渲染再拉 /me | 资料卡不空白 | ✅ | personal.js:49-51,57-63 |
| DOC-D-041 | S | 手机号只认 maskedPhone | 明文不落前端 | ✅ | personal.js:79 |
| DOC-D-042 | F | /me 失败保留登录态资料 | 不弹错 | ✅ | personal.js:62（catch 静默） |
| DOC-D-043 | F | 头像 resolveAvatar | 相对路径转网关绝对地址，失败回落默认头像 | ✅ | personal.js:82；AI_CONTEXT #21 |
| DOC-D-044 | F | 三入口跳转 | schedule/account-security/messages 真实页 | ✅ | personal.js:95-104 |
| DOC-D-045 | S | 退出登录二次确认 | showModal confirm→logout+reLaunch | ✅ | personal.js:106-118 |
| DOC-D-046 | S | 退出联动 doctorService.logout | 清模块态 + wb_doctor | ✅ | personal.js:113；doctor.js:29-32 |
| DOC-D-047 | F | 真实版本号 wx.getAccountInfoSync | 低版本 try/catch 兜底 1.0.0 | ✅ | personal.js:36-42 |
| DOC-D-048 | U | 科室/职称不编造 | /me 无该字段则不显示该行 | ✅ | personal.js:77-78；workbench.js:7-8 |
| DOC-D-049 | R | 栈底返回 | onBack→reLaunch workbench 不假装 navigateBack | ✅ | personal.js:86-92 |

### 3.5 pages/doctor/consult（15 条·重点页）

| ID | 维度 | 步骤/审查路径 | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- |
| DOC-D-050 | S | onLoad 角色拦截（轮一 P1-06） | patient 深链→reLaunch | ✅ 本轮复测已补 | consult.js:61-64 |
| DOC-D-051 | F | 深链 ?id= 直达会话 | 骨架渲染 + loadMessages + 列表静默补齐 | ✅ | consult.js:76-91 |
| DOC-D-052 | F | 会话列表认领池 | 未接诊行点击→先接诊再进会话 | ✅ | consult.js:228-237,240-265 |
| DOC-D-053 | S | 接诊 acceptingId 按行防重 | 一行进行中其他行不受影响 | ✅ | consult.js:242 |
| DOC-D-054 | F | 列表按 lastAt 倒序 | 最新消息置顶（微信惯例） | ✅ | consult.js:163-165 |
| DOC-D-055 | F | 静默刷新整体替换第一页 | cursor 同步重置避免重复加载更多 | ✅ | consult.js:166-167 |
| DOC-D-056 | R | 消息 404 noaccess | 锁输入 + 提示「尚未接诊或不属于您」 | ✅ | consult.js:371-383 |
| DOC-D-057 | F | 结束问诊二次确认 | confirmText=确定结束 / cancelText=继续问诊 | ✅ | consult.js:461-466 |
| DOC-D-058 | S | 结束带幂等键 | closeConsultation body 空但 header 带键 | ✅ | doctor.js:278-284 |
| DOC-D-059 | R | 结束成功 | CLOSED + 锁输入 + 停轮询 + 拉 system_notice | ✅ | consult.js:471-486 |
| DOC-D-060 | R | 结束 409（已被结束） | 当已结束收口不报错 | ✅ | consult.js:490-498 |
| DOC-D-061 | R | 结束 404（非本人） | 不收口保留 ACTIVE，提示 | ✅ | consult.js:499-504 |
| DOC-D-062 | S | closing 锁防重复点 | closing=true 不弹确认不发请求 | ✅ | consult.js:459；CLOSED 再点 :460 直接 return |
| DOC-D-063 | R | 发送 409（会话已被结束） | 锁输入 + 提示「该问诊已结束」 | ✅ | consult.js:553-562 |
| DOC-D-064 | U | 键盘适配 | adjust-position=false + kbHeight 顶输入栏不位移 | ✅ | consult.wxml:169；consult.js:440-446 |

### 3.6 pages/doctor/schedule（12 条）

| ID | 维度 | 步骤/审查路径 | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- |
| DOC-D-065 | F | onLoad 拦截 + GET 排班 | 7 天渲染，无排班天=休诊 | ✅ | schedule.js:40-43,55-85 |
| DOC-D-066 | F | 预设时段 ActionSheet | 上午/下午两段 | ✅ | schedule.js:20-23,107-111 |
| DOC-D-067 | S | 同时段重叠拦截 | `sl.start<p.end && p.start<sl.end` 提示不落 | ✅ | schedule.js:113-118 |
| DOC-D-068 | F | 删除时段 | 本地移除，保存生效；删空→hasSchedule=false | ✅ | schedule.js:136-145 |
| DOC-D-069 | S | 保存 saving 锁 | saving=true 再点忽略 | ✅ | schedule.js:149 |
| DOC-D-070 | S | capacity 钳制 | Math.max(1,Math.min(50,v\|\|20)) | ✅ 代码层；UI 无编辑口不可达 | schedule.js:158（见 §5） |
| DOC-D-071 | S | expectedVersion 乐观锁 | 409→toast + fetch 重载 | ✅ | schedule.js:171-173；doctor.js:138 |
| DOC-D-072 | S | 保存带幂等键 | req.newIdempotencyKey() | ✅ | doctor.js:140 |
| DOC-D-073 | F | 在线开关切换 | 失败回滚开关态 | ✅ | schedule.js:91-99 |
| DOC-D-074 | R | 仍有待回复问诊时下线 409 | 提示「暂时无法下线」 | ✅ | schedule.js:94-95 |
| DOC-D-075 | R | 加载失败错误态 | errText 中文 | ✅ | schedule.js:83 |
| DOC-D-076 | R | 错误态仍可点保存 | onSave 无 error/loading 守卫 | ⚠️ 见 D-P3-02 | schedule.js:148-163 |

### 3.7 pages/doctor/account-security（10 条）

| ID | 维度 | 步骤/审查路径 | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- |
| DOC-D-077 | F | onLoad 拦截 | patient→reLaunch | ✅ | account-security.js:24-27 |
| DOC-D-078 | F | GET /me 展示 maskedPhone/phoneBound | 真实信息展示 | ✅ | account-security.js:34-49 |
| DOC-D-079 | U | 不伪造密码框 | 后端无密码体系，只展示+安全提示 | ✅（设计如此） | account-security.js:5-6 注释 |
| DOC-D-080 | F | /me 失败 toast | errText 中文 | ✅ | account-security.js:46-48 |
| DOC-D-081 | S | 退出登录二次确认 | confirm→logout+doctorService.logout+reLaunch | ✅ | account-security.js:56-68 |
| DOC-D-082 | U | 退出按钮触控 | 96rpx=48px | ✅ | account-security.wxss:69 |
| DOC-D-083 | U | 安全提示区字号 | 26rpx=13px（standard） | ✅ | account-security.wxss:64-65 |
| DOC-D-084 | R | 栈底返回 | reLaunch workbench | ✅ | account-security.js:51-54 |
| DOC-D-085 | S | 无修改密码/换绑表单 | 无该端点，页面无表单（任务书边界项） | ✅ 设计如此 | account-security.js:5-6 |
| DOC-D-086 | U | 不直出 err.message | errText 出口 | ✅ | account-security.js:12,47 |

### 3.8 pages/doctor/messages（11 条）

| ID | 维度 | 步骤/审查路径 | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- |
| DOC-D-087 | S | onShow 角色拦截（每次进入校验） | patient→reLaunch | ✅ | messages.js:34-37 |
| DOC-D-088 | F | 未读数+列表并行拉 | Promise.all，未读数失败回落 0 | ✅ | messages.js:48-49 |
| DOC-D-089 | R | 列表失败错误态 | errText + 骨架结束后显示 | ✅ | messages.js:50-53,73；messages.wxml:23,25 |
| DOC-D-090 | F | 空列表空态 | !messages.length 内联空态 | ✅ | messages.wxml:44 |
| DOC-D-091 | F | 点未读消息乐观已读 | 本地 read=true + unread-1 | ✅ | messages.js:80-83 |
| DOC-D-092 | R | 标已读失败 | 静默 catch，无回滚（下次 fetch 纠正） | ⚠️ 见 D-P3-03 | messages.js:84 |
| DOC-D-093 | F | refType=consultation 跳会话 | 带 ?id=encodeURIComponent(refId) | ✅ | messages.js:87-89 |
| DOC-D-094 | F | 全部已读 | 仅未读 id 集合提交 | ✅ | messages.js:92-96 |
| DOC-D-095 | R | 全部已读无防重 | 连点两次重复 POST | ⚠️ 见 D-P3-03 | messages.js:92-98 |
| DOC-D-096 | U | 时间展示 | fmtLocalDateTime 拼接 date+time | ✅ | messages.js:60,69 |
| DOC-D-097 | F | 已读消息点击不重复请求 | read=true 跳过 mark | ✅ | messages.js:80 |

---

## 4. storage 篡改专项（必做 4）

**实验脚本**：`DOC-D-C1/C2`（test-doctor-deep-audit.js）

| 篡改方式 | 页面层行为（8 页门） | 数据层行为 | 结论 |
| --- | --- | --- | --- |
| 伪造 `wb_role='doctor'` + 新鲜 `wb_login_at`（无 refresh token） | **进得去**：onLaunch 不登出、globalData.role='doctor'，8 页 onLoad/onShow 门均放行 | **零网络被拦**：`ensureAccessToken` 无 access 无 refresh → 本地 reject `AUTH_REQUIRED`，**未发任何请求**；页面 catch 显示错误态，不泄露他人数据 | 客户端门是 UX 提示非安全边界；服务端按 DB 任职判定（doctor.js:9-10）。与分片 A2 app 层结论互引一致 |
| 伪造 `wb_doctor`（profile 缓存） | personal/workbench 资料卡短暂显示伪造姓名，随后 /me 返回真实身份或 401 错误态 | 同上 AUTH_REQUIRED 本地拦截 | 伪造 profile 无持久危害 |

实测输出：`DOC-D-C1` 页面层 role='doctor'（门放行）；`DOC-D-C2` code='AUTH_REQUIRED' 且网络请求数增量=0。

---

## 5. 输入边界表（必做 3）

| 场景 | 审查路径 | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- |
| schedule 时段重叠 | onAddSlot clash 检测 | 提示不落 | ✅ | schedule.js:113-118 |
| schedule 时间越界 | UI 仅预设两段（09:00-12:00 / 14:00-17:30），无自由时间输入 | 越界不可达 | ✅ ⏭ | schedule.js:20-23；schedule.wxml:52 |
| schedule 容量 0/负数/超长 | 代码层 `Math.max(1,Math.min(50, Number(v)||20))`；UI 仅展示 `号源 {{slot.capacity}}` 无输入口 | 钳制存在但无触发路径 | ✅（不可达） | schedule.js:158；schedule.wxml:49 |
| schedule expectedVersion 缺失 | fetch 成功才有 version；失败时 version=0 提交，服务端 v>0 必 409 | 乐观锁兜底 | ⚠️ 见 D-P3-02 | schedule.js:78,163；doctor.js:138 |
| consult 结束无理由 | 契约 close body 为空，无理由字段；二次确认弹窗即确认 | 设计如此 | ✅ | doctor.js:283 `{}` |
| consult 超长理由 | 无理由输入口；发送内容无 maxlength（契约 ≤2000 字靠服务端） | 前端未截断 | ⚠️ 见 D-P3-04 | consult.wxml:163-178（无 maxlength） |
| consult 重复点 close | closing 锁 | ✅ | consult.js:459 |
| consult 已结束再结束 | status==='CLOSED' 直接 return + 输入栏替换只读条 | ✅ | consult.js:460；consult.wxml:157-160 |
| account-security 修改密码/换绑表单 | 页面无该端点无表单（后端无密码体系） | 设计如此 | ✅ | account-security.js:5-6 |
| account-security 防重 | 退出走 showModal 确认，无在途锁 | 双击风险极低 | ✅（弱） | account-security.js:56-68 |
| messages 列表边界 | 空列表空态 / 未读数失败回落 0 / 标已读失败无回滚 | 后两项见 bug | ⚠️ | messages.js:49,84；messages.wxml:44 |
| beds patientRef 空值 | 空→抽屉内错误不发请求 | ✅ | beds.js:204-208 |
| beds 重复提交 | assigning 锁 + 抽屉内重试复用幂等键 | ✅ | beds.js:177,187 |

---

## 6. 适老化量化表（必做 5；375px 档：750rpx=375px → 88rpx=44px 为触控红线）

### 6.1 触控目标

| 元素 | 文件:行 | 实测（rpx→px） | 判定 |
| --- | --- | --- | --- |
| appointments 叫号/完成就诊按钮 .apt-btn | appointments.wxss:192-204 | height 50rpx=**25px**（≥600px 档 :236 同为 25px） | ❌ 不达 44px（D-P2-01） |
| workbench 待办「处理」.todo-btn | workbench.wxss:411-416 | 112×50rpx=56×**25px** | ❌ 不达 44px（D-P2-02） |
| consult 接诊 .dc-accept | consult.wxss:157-163 | 12rpx×2+字号≈54rpx=**27px** | ⚠️ 边界（D-P3-01） |
| consult 发送 .dc-send | consult.wxss:359-371 | 88rpx=44px | ✅ |
| consult 结束 .dc-nav-end | consult.wxss:57-63 | 88×88rpx=44×44px | ✅ |
| consult 输入框 .dc-input | consult.wxss:347-357 | 88rpx=44px | ✅ |
| beds 安排入住/抽屉输入 | beds.wxss:114,271,306 | 88rpx=44px | ✅ |
| account-security 退出按钮 | account-security.wxss:69 | 96rpx=48px | ✅ |
| workbench 快捷宫格 .tw-tile | workbench.wxss:315-326 | 126rpx=63px | ✅ |
| appointments 统计列 ast-col | appointments.wxss:72-85 | ≈160rpx=80px | ✅ |
| 各页 nav 返回热区 | 各页 wxss（如 appointments.wxss:42-47） | 88rpx=44px | ✅ |

### 6.2 三档字号（app.wxss 令牌，页面全部走 var(--font-*)）

| 档位 | title | h2 | body | caption | 375px 档换算 |
| --- | --- | --- | --- | --- | --- |
| standard | 40rpx | 34rpx | 30rpx | 24rpx | 20/17/15/12px |
| large | 44rpx | 36rpx | 32rpx | 26rpx | 22/18/16/13px |
| xlarge | 52rpx | 42rpx | 38rpx | 30rpx | 26/21/19/15px |

关键文本抽查：患者姓名 `.apt-name`、会话标题 `.dc-list-t`、床位号 `.bed-no` 均基于 body/h2 令牌派生（appointments.wxss:88,101；consult.wxss:130；beds.wxss:247），三档自动放大。✅

### 6.3 对比度抽查（白底，WCAG 公式静态推算）

| 组合 | 色值 | 对比度 | 判定 |
| --- | --- | --- | --- |
| 主蓝按钮白字 .apt-btn/.todo-btn/.dc-send-on | #0B6EF8 底 / #FFF 字 | ≈4.56:1 | ✅ 达正文 4.5:1（擦边） |
| 次文本 --text-sub on white | #5064A0 | ≈5.72:1 | ✅ |
| 弱文本 --text-weak on white（caption 12px、.dc-count/.apt-done） | #828CA0 | ≈3.38:1 | ⚠️ 大字号≥18px 才够 3:1；12px 辅助文字不达 4.5:1（全仓已知口径，app.wxss:292 注释已登记同类项） |

真机项标注：触控热区实际命中盒、三档字号真机渲染、对比度真机目检 → **待真机**。

---

## 7. 新发现 Bug（D-Px-xx）

### [P2] D-P2-01 appointments「叫号/完成就诊」按钮触控目标仅 25px（DOC-D-026）
- 位置：`pages/doctor/appointments/appointments.wxss:192-204`（≥600px 档 :236 `height:25px` 同值）
- 根因：`.apt-btn height:50rpx`（=25px），设计稿 13 胶囊按钮按视觉稿落地，未按适老化 88rpx/44px 红线放大。
- 影响：医生端最高频操作（叫号/完成就诊）触控区仅红线 57%，适老用户易点空/误触。
- 建议：`.apt-btn height` 提至 88rpx（≥600px 档同步 44px），min-width 保持。
- 证据：`height: 50rpx; line-height: 50rpx;`（appointments.wxss:194,202）。

### [P2] D-P2-02 workbench 待办「处理」胶囊触控目标仅 25px（DOC-D-012）
- 位置：`pages/doctor/workbench/workbench.wxss:411-416`
- 根因：`.todo-btn width:112rpx; height:50rpx`（=56×25px），源注释（workbench.wxss:347-348）自认「右侧处理胶囊 112×50rpx」按设计稿落地。
- 影响：待办直达按钮触控偏小。
- 建议：height 提至 88rpx。
- 证据：`height: 50rpx; line-height: 50rpx;`（workbench.wxss:415-416）。

### [P3] D-P3-01 consult「接诊」按钮触控边界偏小（≈27px）（DOC-D 接诊行）
- 位置：`pages/doctor/consult/consult.wxss:157-163`
- 根因：`.dc-accept padding:12rpx 32rpx` 无显式 height，总高≈12+12+字号(30rpx)≈54rpx=27px。
- 建议：显式 height 提至 88rpx 或 padding 上下加大。

### [P3] D-P3-02 schedule.onSave 加载失败错误态仍可提交空模板（DOC-D-076）
- 位置：`pages/doctor/schedule/schedule.js:148-163`
- 根因：onSave 不检查 `this.data.error`/`loading`；fetch 失败时 days=[]，保存会 PUT `weekdays=[]` + `expectedVersion=0`。
- 影响：服务端 v>0 时乐观锁 409 兜底（不毁数据）；仅当服务端 version=0 时空排班被静默确认（无实际损失，因为本来无数据）。
- 建议：onSave 开头加 `if (this.data.error || this.data.loading) return`。

### [P3] D-P3-03 messages 乐观已读无回滚 + 全部已读无防重（DOC-D-092/DOC-D-095）
- 位置：`pages/doctor/messages/messages.js:80-85,92-98`
- 根因：markMessageRead 失败本地不回滚（靠下次 onShow fetch 纠正）；onMarkAllRead 无 _busy 锁。
- 影响：弱——已读状态短暂不一致；连点全部已读产生重复 POST（写幂等，服务端无副作用）。
- 建议：catch 里回滚 read/unread；onMarkAllRead 加 `if(this._marking) return`。

### [P3] D-P3-04 consult 医生回复输入无 maxlength（契约 ≤2000 字无前端截断）
- 位置：`pages/doctor/consult/consult.wxml:163-178`；doctor.js:261-267
- 根因：input 未设 maxlength，超长文本直传 POST，靠服务端拒绝。
- 建议：input 加 `maxlength="2000"` 并在 onInput 截断提示。

---

## 8. 脚本运行记录

| 脚本 | 命令 | 结果 |
| --- | --- | --- |
| `tools/test-doctor-deep-audit.js`（本轮新增） | `node tools/test-doctor-deep-audit.js` | **PASS=34 / FAIL=0**，exit 0 |
| `tools/test-doctor-pages-audit.js`（第一轮） | `node tools/test-doctor-pages-audit.js` | **PASS=32 / FAIL=0**（原 31/1，P1-06 转绿） |
| `tools/check-project.js` | `node tools/check-project.js` | 全部通过（js 语法/json/图标/全局类/禁址） |

deep-audit 覆盖明细：A 组 8 页门 ×2=16 项；B 组 isLoggedIn 单测 3 项 + workbench onShow 2 项；C 组 storage 篡改 2 项；D 组源码守门 11 项。

---

## 9. 与第一轮报告的差异说明

1. **P1-06（consult 缺拦截）已修复**：consult.js:61-64 现与其余 7 页同形；第一轮红灯回归锁 `test-doctor-pages-audit.js` 已转绿（32/0）。
2. **P2-03（onShow 复查 + 缺失 loginAt 收紧）已修复**：workbench.js:100-103 追加 `!app.isLoggedIn()`；app.js:59 `if (!loginAt || this._isSessionExpired(loginAt))` 收紧缺失时间戳情形。
3. 第一轮 P2-15（内存 role 可伪造）本轮以 storage 篡改实验复测确认：页面层放行、数据层 AUTH_REQUIRED 本地零网络拦截，维持「设计内可接受」结论。
4. 本轮新增 6 项 bug（2 P2 适老化触控 + 4 P3 健壮性），第一轮 P2-16/P2-17 未重复登记（已在主报告 §7.3 闭环或转文档债）。
