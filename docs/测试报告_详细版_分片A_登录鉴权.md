# 测试报告 · 详细版 · 分片 A：登录 / 鉴权 / 会话域深挖

> 第二轮「详细版」增量测试分片 A2。方法：只读源码审查 + `tools/test-login-deep-audit.js`（打桩 wx/getApp/App/Page/storage/request，node 实跑 15 断言）。
> 基线报告：`docs/测试报告_20261029_全量前端测试.md`（§2 schema / §7.3 Bug 清单 / §7.5 修复计划）。
> 审查日期：2026-10-29 ｜ 运行环境：仓库当前入库档 BUILD_ENV='development'（env.js:15）。

---

## 0. 本批重要状态变化（相对第一轮基线）

DEV_LOG 2026-10-29（二）批次已落地后端 P0 加固 + 前端防线，本轮复核结果：

| 第一轮条目 | 第一轮状态 | 本轮复核（现行代码） | 证据 |
| --- | --- | --- | --- |
| P0-01 防线③ 生产档手输页拦截 | 未落地 | ✅ 已落地（3 页 onLoad reLaunch） | patient-login.js:30-33；manual-login.js:24-27；doctor-login.js:29-32 |
| P0-01 login.js 派生判据 `!isProduction` | 黑名单 fail-open | ✅ 改为白名单 `legacyManualLoginEnabled && devLoginKey` | login.js:147；doctor-login.js:136 |
| P0-01 env.js 档位白名单 | 黑名单 | ✅ ENV_KEYS fail-closed + 生产 https/mock 断言 | env.js:20-23, 60-65, 95-96 |
| P0-01 联调密钥头 | 无 | ✅ DevLoginGuard + `X-Dev-Login-Key`（request.js:32；env.js:83,118） | request.js:28-34 |
| P1-01 patient-login.onSubmit 漏协议 | 红 | ✅ 已修（:70-73） | patient-login.js:68-73 |
| P1-02 退出不注销后端会话 | 红 | ✅ 已修（app.logout → revokeSession → AUTH_LOGOUT） | app.js:82-102；request.js:161-176 |
| P2-01 logout 残留 wb_user_profile/wb_doctor | 红 | ✅ 已修（app.js:99-100 联动 userService/doctorService.logout） | app.js:97-100 |
| P2-02 patient-login.onWxLogin 无防重 | 红 | ✅ 已修（_busy，patient-login.js:101） | patient-login.js:99-101 |
| P2-03 workbench 不查 loginAt | 红 | ✅ 部分修（app.js:30, 57-62 缺时间戳按失效；页面层归 D2 复核） | app.js:49-64 |

---

## 1. 逐页用例表（AUTH-D-xxx；维度 F/S/R/U）

### 页面 pages/auth/login/login（登录入口主页）

| ID | 维度 | 前置 | 步骤（审查路径） | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| AUTH-D-001 | F | 72h 内已登录 | onLoad → app.isLoggedIn()=true | reLaunch 到 getRoleEntry（患者 home / 医生 workbench） | ✅ | login.js:44-46；app.js:55-64 |
| AUTH-D-002 | F | 未登录 | onLoad | 停留本页，渲染两按钮 | ✅ | login.js:41-47 |
| AUTH-D-003 | F | dev 档 | 点「患者登录」getPhoneNumber → wx.login → _login | 派生 dev-user-1-wxlogin-* → user.loginByWxCode → roles=PATIENT → switchTab home | ✅ | login.js:106-136,146-156,188-200；断言 A3-1 |
| AUTH-D-004 | F | dev 档 | 点「医护登录」 | 派生 dev-user-2-wxlogin-* → doctor.loginByWxCode → roles=DOCTOR → reLaunch workbench | ✅ | login.js:149-152；断言 A3-2 |
| AUTH-D-005 | F | 后端返回 roles 含 DOCTOR | 从患者入口登录成功 | 按服务端 roles 进工作台（不信入口 data-role） | ✅ | login.js:188-199 |
| AUTH-D-006 | S | 登录请求在途 | 连点登录按钮 | _busy 忽略后续点击，不重复签发会话 | ✅ | login.js:108 |
| AUTH-D-007 | S | 用户拒绝手机号授权 | onGetPhoneNumber detail.errMsg=deny | dev：toast + navigateTo patient-login；prod：仅 toast 停留 | ✅ | login.js:113-116,175-185 |
| AUTH-D-008 | S | wx.login success 无 code | onGetPhoneNumber → res.code 空 | 复位 _busy + 降级手输页（dev） | ✅ | login.js:122-127 |
| AUTH-D-009 | S | wx.login fail | 网络异常 | _busy 复位 + hideLoading + 降级 | ✅ | login.js:130-134 |
| AUTH-D-010 | R | 医生无任职 | loginByWxCode reject FORBIDDEN | 中文 toast「未登记医生身份」，不跳页 | ✅ | login.js:166-169 |
| AUTH-D-011 | R | 其他登录失败 | reject 非 FORBIDDEN | dev：降级手输页；prod：toast 重试 | ✅ | login.js:170,176-179 |
| AUTH-D-012 | U | 在「我的」改过大字主题 | onShow | theme class 重新同步 | ✅ | login.js:50-54 |
| AUTH-D-013 | U | 远端机器人图加载失败 | onRobotArtError | 回退包内 xiaoan-robot.png | ✅ | login.js:93-98 |
| AUTH-D-014 | U | 点协议行 | onOpenAgreement / onOpenPrivacy | 跳真实协议/隐私页（不伪造已同意） | ✅ | login.js:203-209；login.wxml:61 |

### 页面 pages/auth/patient-login/patient-login（患者手输）

| ID | 维度 | 前置 | 步骤（审查路径） | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| AUTH-D-021 | F | prod 档 | onLoad | reLaunch 回登录入口（深链拦截） | ✅ | patient-login.js:30-33；断言 A4-1 |
| AUTH-D-022 | F | dev 档 | onSubmit：合法手机号+密码+已勾协议 | user.login → 按 roles 进端 | ✅ | patient-login.js:53-92；user.js:92-103 |
| AUTH-D-023 | F | — | onSubmit 手机号非 /^1\d{10}$/ | toast「请输入正确的手机号」，不发网 | ✅ | patient-login.js:60-63 |
| AUTH-D-024 | F | — | onSubmit 密码空 | toast，不发网 | ✅ | patient-login.js:64-67 |
| AUTH-D-025 | F | agreed=false | onSubmit | toast「请先阅读并同意…」，不发网（P1-01 已修） | ✅ | patient-login.js:70-73；断言 A5-1 |
| AUTH-D-026 | S | submitting=true | onSubmit 连点 | 忽略重复提交 | ✅ | patient-login.js:58 |
| AUTH-D-027 | S | agreed=false | onWxLogin | toast 不发网 | ✅ | patient-login.js:105-108 |
| AUTH-D-028 | S | 拒授权 | onWxLogin detail.errMsg=deny | navigateTo manual-login | ✅ | patient-login.js:110-113 |
| AUTH-D-029 | S | 在途连点 | onWxLogin | _busy 守卫（P2-02 已修） | ✅ | patient-login.js:101 |
| AUTH-D-030 | F | wx.login 成功 | onWxLogin → loginByWxCode | roles 判定去向 | ✅ | patient-login.js:116-128 |
| AUTH-D-031 | R | 一键登录后端失败 | onWxLogin catch | 复位 + navigateTo manual-login 降级 | ✅ | patient-login.js:129-134 |
| AUTH-D-032 | R | 网络错误 | onSubmit catch | errText 中文 toast（非 err.message 直出） | ✅ | patient-login.js:81-91 |
| AUTH-D-033 | U | 栈首打开本页 | onBack | navigateBack fail → reLaunch 登录入口兜底 | ✅ | patient-login.js:156-159 |
| AUTH-D-034 | U | 点协议行任意处 | onToggleAgreement；链接 catchtap | 整行切换勾选；链接不触发勾选 | ✅ | patient-login.wxml:30-37；patient-login.js:41-43 |

### 页面 pages/auth/manual-login/manual-login（手输降级页）

| ID | 维度 | 前置 | 步骤（审查路径） | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| AUTH-D-041 | F | prod 档 | onLoad | reLaunch 回登录入口 | ✅ | manual-login.js:24-27；断言 A4-1 |
| AUTH-D-042 | F | dev 档 | onSubmit 三项校验全过 | user.login → 进端 | ✅ | manual-login.js:46-74 |
| AUTH-D-043 | F | — | 手机号非法/密码空/协议未勾 | 分别 toast 拦截，不发网 | ✅ | manual-login.js:49-60 |
| AUTH-D-044 | S | submitting=true | onSubmit 连点 | 忽略 | ✅ | manual-login.js:47 |
| AUTH-D-045 | S | — | togglePwd | 密码框显隐切换 | ✅ | manual-login.js:34；manual-login.wxml:48-55 |
| AUTH-D-046 | U | 栈内页 | onBackToWx | navigateBack → patient-login；fail 兜底 reLaunch | ✅ | manual-login.js:88-90 |
| AUTH-D-047 | R | prod 档直调 service（异常路径） | doctor/user.login reject BAD_SPEC | errText 中文 toast | ✅ | manual-login.js:68-73；断言 A2-1/A2-2 |
| AUTH-D-048 | U | 密码仅空格（'   '） | onSubmit | 通过「非空」校验（!pwd 为 false）——dev 档 password 不进请求，无实际风险；prod 无此页 | ⚠️ 记录 | manual-login.js:53；user.js:100-101 |
| AUTH-D-049 | U | 手机号输入 | maxlength=11 限制 + 数字键盘 | 超长输入被键盘层截断 | ✅ | manual-login.wxml:27-35 |
| AUTH-D-050 | U | 协议行整行 tap / 链接 catchtap | onToggleAgreement / onOpenAgreement | 切换 + 跳真实页 | ✅ | manual-login.wxml:81-88 |
| AUTH-D-051 | F | dev 档登录返回 roles=DOCTOR | _enter | reLaunch workbench（跨端走向） | ✅ | manual-login.js:76-85 |
| AUTH-D-052 | R | service reject | onSubmit catch | submitting 复位 + errText toast | ✅ | manual-login.js:68-73 |
| AUTH-D-053 | U | onLoad | theme class 同步 | ✅ | manual-login.js:28 |

### 页面 pages/auth/doctor-login/doctor-login（医生手输）

| ID | 维度 | 前置 | 步骤（审查路径） | 预期 | 实测 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| AUTH-D-061 | F | prod 档 | onLoad | reLaunch 回登录入口 | ✅ | doctor-login.js:29-32；断言 A4-1 |
| AUTH-D-062 | F | — | onSubmit 空账号 | toast「请输入工号或手机号」，不发网 | ✅ | doctor-login.js:43-48 |
| AUTH-D-063 | F | dev 档 | onSubmit 合法账号 | doctor.login → 成功进工作台 / FORBIDDEN 中文 toast | ✅ | doctor-login.js:49-75；doctor.js:95-106 |
| AUTH-D-064 | S | submitting=true | onSubmit 连点 | 忽略 | ✅ | doctor-login.js:43 |
| AUTH-D-065 | R | 拒授权 | onWxLogin errMsg=deny | 中文 toast 引导手输 | ✅ | doctor-login.js:95-98 |
| AUTH-D-066 | R | wx.login 无 code | onWxLogin success 无 code | hideLoading + toast | ✅ | doctor-login.js:102-106 |
| AUTH-D-067 | R | 后端 FORBIDDEN | onWxLogin catch | 中文 toast，不跳页 | ✅ | doctor-login.js:112-117 |
| AUTH-D-068 | R | 其他失败 | onWxLogin catch | toast 引导手输 | ✅ | doctor-login.js:118 |
| AUTH-D-069 | U | dev/prod 档 | _devCode(code) | dev+密钥→派生 dev-user-2-wxlogin-*；prod→原样透传 | ✅ | doctor-login.js:133-138；断言 A3-3 |
| AUTH-D-070 | U | 键盘完成键 | bindconfirm=onSubmit | 直达提交 | ✅ | doctor-login.wxml:28-29 |
| AUTH-D-071 | R | 在途连点 | onWxLogin 连点 | **无 _busy 守卫 → 双 wx.login + 双登录请求** | ❌ | doctor-login.js:93-126（新发现 D-P2-01） |
| AUTH-D-072 | U | 栈首打开 | onBack | navigateBack fail → reLaunch 登录入口 | ✅ | doctor-login.js:152-155 |
| AUTH-D-073 | U | 账号输入框 | 超长账号（>240 字符） | 无 maxlength；拼入派生 code 超契约 8~256 → 后端 422 | ⚠️ 记录 | doctor-login.wxml:22-30；doctor.js:103-105（新发现 D-P2-05） |

---

## 2. 新发现 Bug（D-Px-xx；schema 对齐第一轮 §2.3）

### [P1] logout 在 access 内存过期时跳过后端撤销（AUTH-D-063 对照）
- 位置：`miniprogram/services/request.js:161-164`（revokeSession `if (!full || !token) return Promise.resolve(false)`）；`miniprogram/services/session.js:26-29`（内存 access 过期即返回 ''）；`miniprogram/app.js:85`
- 根因：access token 只驻内存，2h 过期后 `getAccessToken()` 返回 ''；revokeSession 要求 Bearer 才能发，无 token 即静默跳过。退出登录时不会先 ensureAccessToken()。
- 复现：登录后挂机 >2h（access 自然过期、refresh 存活）→ 点「退出登录」→ 本地清干净，但服务端 refresh 仍有效，7 天内可换新 access。
- 影响：P1-02 修复只覆盖「access 仍在内存」的窗口；换机/丢失场景的残留暴露窗口仍是 7 天。
- 建议：logout 前先 `await ensureAccessToken()`（有 refresh 就先换新 access）再 revokeSession；或后端 /auth/logout 支持 refresh token 注销。
- 证据：断言 A7-1（脚本实跑：撤销请求发出=false，refresh 本地已清）。

### [P2] doctor-login.onWxLogin 无在途防重（AUTH-D-071）
- 位置：`miniprogram/pages/auth/doctor-login/doctor-login.js:93-126`
- 根因：login.js:108 有 `_busy`、patient-login.js:101 有 `_busy`（P2-02 已修），本页遗漏。
- 复现：doctor-login 页连点「微信一键登录」按钮 → 两次 wx.login + 两次 loginByWxCode。
- 影响：后端幂等可吸收，但属无谓请求 + loading 态错乱。
- 建议：onWxLogin 入口加 `if (this._busy) return`，成功/失败分支复位，与 patient-login.js:99-101 同形。
- 证据：doctor-login.js 全文无 `_busy` 字样（Grep 复核）。

### [P2] manual-login 输入框标准档触控高度 36px < 44px 基准（AUTH-D-049 旁支）
- 位置：`miniprogram/pages/auth/manual-login/manual-login.wxss:80-85`（.ml-input height:72rpx=36px）
- 根因：大号/超大号主题已补 88rpx（:180-181），标准档保持 72rpx。
- 影响：适老化 88rpx（44px）基准在标准档未达标。
- 建议：.ml-input 标准档高度提到 88~96rpx。
- 证据：manual-login.wxss:82, :181。

### [P2] 四个登录页关键文本硬编码 rpx，不随三档主题放大
- 位置：`login.wxss:188,198-200,214`（56/40/26rpx 硬编码）；`patient-login.wxss:46,54,78,131,146`（42/26/32/26/22rpx）；`doctor-login.wxss:47,55,89,114,135`（42/26/30/32/24rpx，**无任何 theme 覆盖块**）；`manual-login.wxss:180-185` 仅覆盖 input/btn/label 三项
- 根因：三档机制靠 `--font-*` 令牌（app.wxss:59-63, 78-83, 93-97），硬编码 rpx 不走令牌。
- 影响：老人切到 xlarge 档后，登录页正文仍停在 standard 尺寸（如协议行 13px），适老化开关在登录场景失效。
- 建议：登录页文本改用 `var(--font-*)` 令牌，或补 theme-large/theme-xlarge 覆盖块（对齐 manual-login.wxss:180-185 范式）。
- 证据：app.wxss:78-97 仅定义令牌缩放；四页 wxss 硬编码清单如上。

### [P2] 弱文本 #828CA0 对比度 3.38:1 不达正文 4.5:1
- 位置：`app.wxss:38`（--text-weak #828CA0）；使用点：login.wxss:214（lg-agree 26rpx=13px）、patient-login.wxss:55,146、doctor-login.wxss:56,135,136
- 根因：--text-weak 定位「白卡说明」；实测 3.38:1 ≥3（大字档）但 <4.5（正文档），且这些文本多为 12~13px 小字。
- 影响：已知设计权衡（KNOWN_ISSUES #28 同类），登录页合规说明文本是要读的内容。
- 建议：合规/说明类小字改 `--text-sub`（#5064A0=5.72:1 达标），--text-weak 仅留装饰性文案。
- 证据：脚本对比度速算输出（见 §5 表）。

### [P2] doctor-login 账号输入框无 maxlength
- 位置：`miniprogram/pages/auth/doctor-login/doctor-login.wxml:22-30`
- 根因：无 maxlength；账号直接拼入派生 code `dev-user-2-manual-<account>`（doctor.js:103-105），契约 code 限 8~256。
- 影响：超长账号（>240 字符）拼出的 code 超 256 → 后端 422，用户得到笼统错误。
- 建议：input 加 maxlength（如 32）。
- 证据：doctor-login.wxml:22-30 无 maxlength 属性。

---

## 3. 修复验证断言表（问题引用 / 断言 / 当前红绿 / 验证脚本）

脚本：`node tools/test-login-deep-audit.js`（实跑 PASS=15 FAIL=0；红=3 绿=12）。

| # | 引用问题 | 断言内容 | 当前状态 | 脚本输出摘要 |
| --- | --- | --- | --- | --- |
| ① | P0-01 | dev 档 user.login(phone,pwd) 请求体**不含 password**（锁定漏洞行为，仅 dev 白名单档可达） | 🔴 红（现状确实不含，行为被锁定） | body={"code":"dev-user-1-manual-19900001234","consentVersion":"v1.0","phoneCode":"dev-phone-19900001234"} |
| ② | P0-01 | prod 档 user.login / doctor.login 必须 reject BAD_SPEC 且不发网 | 🟢 绿（生产档已拦截） | err=BAD_SPEC req=0 |
| ③ | P0-01 | login.js 演示 code 派生仅在 dev+密钥档触发；prod 透传真实 wx code | 🟢 绿（白名单判据已替代 !isProduction 黑名单） | dev: code=dev-user-1-wxlogin-*；prod: code=WXREAL |
| ④ | P0-01 防线③ | prod 档 patient/manual/doctor-login onLoad → reLaunch 登录入口 | 🟢 绿（防线已落地） | reLaunch 次数=3 |
| ⑤ | P1-01 | patient-login.onSubmit agreed=false 不发网；agreed=true 发 1 次 | 🟢 绿（已修复） | 0 → 1 次 |
| ⑥ | P1-02 | logout 流程调 POST /api/v1/auth/logout（带 Bearer + Idempotency-Key）；本地三件套+refresh 全清 | 🟢 绿（已修复） | url=…/api/v1/auth/logout Authorization=Bearer at-1；残留=空 |
| ⑦ | 新发现 D-P1-01 | access 内存过期时 logout 撤销请求被静默跳过（refresh 残留） | 🔴 红（新缺陷锁定） | 撤销请求发出=false |

红绿统计：**红 3（①/⑦ 为 dev 档设计内现状或新缺陷锁定；②③④⑤⑥ 全绿闭环）｜绿 12**。

---

## 4. 输入边界表（必做 3）

| 边界场景 | 行为 | 证据 | 结论 |
| --- | --- | --- | --- |
| 手机号超长（12 位） | manual-login 输入层 maxlength=11；regex 二次拒绝 | manual-login.wxml:30；manual-login.js:49 | ✅ |
| 非 1 开头（2xxxx…） | regex 拒绝 toast | patient-login.js:60；manual-login.js:49 | ✅ |
| 含空格 | user.login 前 `String(phone).trim()`；多余空格已截 | user.js:100 | ✅ |
| 含 emoji | number 键盘层无法输入；regex 兜底拒绝 | manual-login.wxml:29；manual-login.js:49 | ✅ |
| `<script>` 字符串 | 手机号 regex 拒绝；doctor 账号无 regex 但走派生 code，WXML text 绑定自动转义无 XSS；超长触发 422 | doctor.js:103-105；doctor-login.wxml | ⚠️ D-P2-05 |
| 纯数字非 11 位 | regex 拒绝 | 同手机号行 | ✅ |
| 密码超长 | 密码框无 maxlength；dev 档不进请求体，prod 无此页 | manual-login.wxml:48-55 | ✅（无实际风险） |
| 密码仅空格 | `!pwd` 对纯空格为 false → 放行（dev 档 password 不参与校验） | manual-login.js:53 | ⚠️ 记录（D-P2 级，随 dev 档下线自动消失） |
| 协议未勾 | patient-login/manual-login 拦；doctor-login 无勾选（设计同主登录页「登录即代表同意」） | patient-login.js:70-73；manual-login.js:57-60；doctor-login.wxml:37-41 | ✅ / 设计一致 |
| 双击提交 | login/onWxLogin(patient) _busy；onSubmit 三件 submitting；doctor-login.onWxLogin 无 | login.js:108；patient-login.js:101；doctor-login.js:93 | ❌ D-P2-01 |
| 输入值回显路径 | value="{{phone}}" 受控渲染；phone/pwd 不落 storage（仅内存 data） | patient-login.js:37-38；manual-login.js:31-32 | ✅ 无 storage 回显风险 |
| URL 参数 onLoad 无参/异常参 | 4 页 onLoad 均不读 options，无 ?from= 解析；深链直达 prod 档三手输页被 onLoad reLaunch 拦截 | login.js:41-47；patient-login.js:30-33；断言 A4-1 | ✅ |
| 深链绕过登录页直接进业务页 | 客户端门仅 UX（见 §6）；数据层 403 兜底 | doctor.js:9-10；D2 复核 workbench | ⚠️ 设计内（P2-15 同级） |

---

## 5. 适老化量化表（必做 5；375 档 1rpx=0.5px，基准 88rpx=44px）

### 5.1 触控目标

| 元素 | 选择器 | rpx | 375 档 px | ≥44px? | 证据 |
| --- | --- | --- | --- | --- | --- |
| login 患者/医护按钮 | .lg-btn | 99 | 49.5 | ✅ | login.wxss:196-203 |
| patient-login 微信一键登录 | .pl-btn-primary | 96 | 48 | ✅ | patient-login.wxss:68-84 |
| patient-login 协议行（整行 tap） | .pl-agree-row | 整行宽 | ≈21px 行高但整行卡片宽可点 | ✅ 整行点 | patient-login.wxml:30 |
| patient-login 勾选圈视觉 | .pl-checkbox | 34 | 17 | ⚠️ 依赖整行 tap | patient-login.wxss:104-114 |
| manual-login 登录按钮 | .ml-btn | 96 | 48 | ✅ | manual-login.wxss:97-109 |
| manual-login 输入框 | .ml-input | 72 | 36 | ❌ <44 | manual-login.wxss:80-85（D-P2-02） |
| manual-login「返回微信一键登录」 | .ml-back 纯文本 | — | ≈14px 文本 | ❌ 次要入口 | manual-login.wxss:115-120 |
| doctor-login 输入框容器 | .dl-field | 104 | 52 | ✅ | doctor-login.wxss:69-78 |
| doctor-login 登录验证按钮 | .dl-btn-primary | 96 | 48 | ✅ | doctor-login.wxss:106-120 |
| 返回键 | 三手输页原生导航栏返回（页面注释声明）；login 页无返回键 | — | 原生 ≥44 | ✅ | patient-login.wxml:5；manual-login.wxml 注释；doctor-login.wxml:5 |

### 5.2 三档字号关键文本（375 档 px；令牌 standard/large/xlarge）

令牌真值（app.wxss:59-63, 78-83, 93-97）：--font-title 20/22/26px；--font-h2 17/18/21px；--font-body 15/16/19px；--font-caption 12/13/15px。

| 文本 | 页面实际渲染（standard） | 是否随主题放大 | 证据 |
| --- | --- | --- | --- |
| login 大标题 54px / 欢迎登录 28px / 按钮字 20px / 协议行 13px | 全硬编码 rpx | ❌ 不放大 | login.wxss:56,188,200,214 |
| patient 标题 21px / 副标题 13px / 按钮 16px / 授权说明 11px | 全硬编码 | ❌ 不放大 | patient-login.wxss:46,55,78,146 |
| manual 标题 21px / 输入 15px / 按钮 16px / 协议 12px | 硬编码 + 仅 input/btn/label 三项有 large/xlarge 覆盖（17/18/16px） | ⚠️ 部分 | manual-login.wxss:180-185 |
| doctor 标题 21px / 输入 15px / 按钮 16px / 协议 12px | 全硬编码，**无 theme 覆盖块** | ❌ 不放大 | doctor-login.wxss 全文 |

### 5.3 对比度抽查（脚本实算；正文 ≥4.5 / 大字 ≥3）

| 组合 | ratio | 判定 |
| --- | --- | --- |
| 白字 on #0B6EF8（主按钮 / 协议链接蓝 on 白=同色对调） | 4.57:1 | ✅ 刚过正文线 |
| #5064A0 次文本 on 白 | 5.72:1 | ✅ |
| #14264C 主文本 on 白 | 14.88:1 | ✅ |
| #828CA0 弱文本 on 白（合规说明小字） | 3.38:1 | ⚠️ ≥3 但 <4.5（D-P2-04） |

> 真机项（实际渲染盒模型、整行 tap 热区、安全区）标「待真机」；本表为静态推算。

---

## 6. storage 篡改结论（必做 4；A2 侧，与 D2 页面层互引）

| 篡改场景 | 行为 | 证据 | 结论 |
| --- | --- | --- | --- |
| 伪造 wb_role='doctor' + wb_user + 未来 wb_login_at | onLaunch 接受 → globalData.role='doctor'；workbench onLoad 页面门通过（内存态）；但服务端按 DB 任职鉴权 → 无任职 403 | app.js:24-35；doctor.js:9-10；P2-15 | ⚠️ 客户端门=UX 非安全边界（与 D2 互引） |
| 篡改 wb_login_at=0 或删除 | onLaunch 视为失效 → logout() 清理（P2-03 已修口径） | app.js:28-31, 49-52 | ✅ |
| 篡改 wb_login_at 为遥远未来 | Date.now()-future < TTL → 判定未过期，72h 窗口被无限拉长（客户端时间戳固有） | app.js:50-51 | ⚠️ 记录（设计内，服务端 TTL=7d refresh 为权威） |
| setLogin 前置校验 | setLogin 原样写三件套，不校验 role 取值；唯一调用点 _enter 传服务端 roles | app.js:67-73；login.js:191 | ✅ 无旁路调用点 |
| wb_refresh_token 篡改写入 | getRefreshToken 校验本地 expires_at（7d）；服务端校验 token 本体 | session.js:31-42, 51-59 | ✅ |

---

## 7. 结论统计

- 用例数：**54 条**（AUTH-D-001~073，4 页；每页 ≥12）。
- 新发现 bug：**6 条**（D-P1-01 ×1；D-P2 ×5：防重 / 输入框高度 / 三档字号 / 弱文本对比 / maxlength）。
- 断言红/绿：**红 3 / 绿 12**（红=① dev 档漏洞行为锁定现状 + ⑦ 新缺陷 D-P1-01；绿=P0-01 四道防线②③④ + P1-01⑤ + P1-02⑥ 全闭环）。
- 脚本：`tools/test-login-deep-audit.js`（PASS=15 FAIL=0，退出码 0）。
- 待真机：整行 tap 热区实测、安全区与矮屏叠合、三档主题真机切换目检。
