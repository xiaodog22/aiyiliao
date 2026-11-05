# 分片A 测试报告：登录 / 鉴权 / 会话 / 请求层（2026-10-29）

> 隶属：`docs/测试报告_20261029_全量前端测试.md` §5.1 分片 A
> 方法：只读静态审查（定位优先，结论带 文件:行号）+ 离线打桩单测（`tools/test-login-auth-audit.js`，51/51 PASS）
> 声明：未修改任何页面/服务/样式源码；仅新增 `tools/test-login-auth-audit.js` 与本报告。

---

## 0. 登录验证专项（P0）：「随机号码+任意密码都能登录」是否属实

### 0.1 结论

**属实（在当前构建档位下）。** 仓库当前 `BUILD_ENV='development'`（`miniprogram/config/env.js:15`），该档位：
① 手输登录开放（`legacyManualLoginEnabled=true`，`env.js:71,91`）；
② 微信一键登录的真实 code 被前端替换为 `dev-user-1/2-wxlogin-<时间戳>` 派生码（`pages/auth/login/login.js:144-150`）；
③ 手输登录的「密码」**根本不参与请求**（`services/user.js:92-99`，注释 `:89` 自述「password 不参与校验（dev 档无密码体系）」）。

因此：**患者端**输入任意符合 `/^1\d{10}$/` 的号码（如 19900001234）+ 任意非空密码 → 后端 dev 档 provider 一律映射 `dev-user-1` 真实签发会话；**医生端**输入任意非空字符串（无需像手机号）→ 一律映射 `dev-user-2`（已登记的王医生账号）直接进工作台。体验版/真机联调档就是这档（`env.js:14` 注释），用户反馈与代码行为一致。

生产档（`BUILD_ENV='production'`）下该路径被两道门禁关闭：入口隐藏（`patient-login.js:48-51`、`login.js:173-177`）+ service 层 reject `BAD_SPEC`（`user.js:93-95`、`doctor.js:96-98`）。**防线只有「发版时人工把 BUILD_ENV 改成 production」这一处人为开关，未见 CI 门禁证据。**

### 0.2 证据链（4 条链路逐项）

**链路 1：manual-login 手机号+密码（`pages/auth/manual-login/manual-login.js`）**
- 前端校验：手机号正则 `manual-login.js:43`（`/^1\d{10}$/`）、密码非空 `:47`、协议勾选 `:51`；格式校验仅是「像不像手机号」，**不是后端凭证校验**。
- `:57` 调 `userService.login(phone, pwd)` → `services/user.js:92-99`：
  ```js
  function login(phone, password) {
    if (!ENV.legacyManualLoginEnabled) { return Promise.reject(...BAD_SPEC...) }
    const p = String(phone || '').trim()
    return post(API.USER_WX_LOGIN, loginBody('dev-user-1-manual-' + p, 'dev-phone-' + p)).then(applySession)
  }
  ```
  请求体无 password（单测 B-02/B-03 钉死）。成功 → `applySession`（`user.js:47-65`，缺 accessToken 抛 BIZ_ERROR）→ `manual-login.js:70-79` `_enter` → `app.setLogin`。
- 失败路径：`manual-login.js:62-67` catch → `errText(err,'登录失败，请重试')` toast，**不写登录态**（单测 B-10/B-11 钉死）。

**链路 2：login.js 一键登录演示分支（`pages/auth/login/login.js:106-170`）**
- 条件变量：`if (!ENV.isProduction)`（`login.js:145`）；`isProduction = BUILD_ENV==='production'`（`env.js:75`）。
- 演示分支行为：`login.js:146-150` 把 code 替换为 `dev-user-1-wxlogin-<stamp>`（患者）/ `dev-user-2-wxlogin-<stamp>`（医护）→ **跳过后端 jscode2session，由 dev provider 直接签发真实会话**（注释 `:141-143` 自述「保证演示闭环可一键登录；生产构建恒走真实 wx.login code」）。
- 写什么：成功后 `login.js:186-198` `_enter` → `app.setLogin(role, profile)` → `app.js:64-70` 写 `wb_role/wb_user/wb_login_at`；token 由 `user.js:52 session.setTokens` 落 refresh。
- 误判风险：isProduction 来源单一（`env.js:15` 写死档位）；development 档 gateway 是隧道域名 `https://qv56gv32944.vicp.fun`（`env.js:32`），若误以此档出体验版，绕过随包分发。

**链路 3：patient-login / doctor-login 的 wx.login code 流程**
- `patient-login.js:107` `userService.loginByWxCode(res.code, detail.code)`；`doctor-login.js:102` `doctorService.loginByWxCode(this._devCode(res.code), detail.code)`（`_devCode` 派生 `doctor-login.js:128-131`，同样 `!isProduction` 门禁）。
- 后端不可用：**登录请求无 `withFallback` 包裹**（`user.js:80`、`doctor.js:82` 均直连 `post`），`withFallback` 仅查询页降级（`request.js:646-654`）→ 后端故障 = reject = 不 setLogin（单测 B-10、C-21 钉死）。降级只发生在页面 catch → `patient-login.js:115` navigateTo manual-login（**仍在 dev 档手输体系内**）。
- 401 重试机制对登录端点不触发（`request.js:478` 排除刷新接口；登录在匿名白名单 `request.js:63,65`，不带 Authorization，单测 RQ-12 已钉）。

**链路 4：doctor-login → POST /api/v1/doctor/login 失败处理**
- `doctor.js:81-83` → 403（无任职）→ `request.js:484-487` reject `FORBIDDEN` → `doctor-login.js:56-59` 中文 toast「该账号未登记医生身份」，**不 setLogin**（单测 C-14/C-15 钉死）；401/网络错误 → `:64-69` 走 err-text。错误文案合规（未直出 err.message）。

**链路 5：app.setLogin 前置条件（`app.js:64-70`）**
- **无任何参数校验**：不校验 role 白名单（任意字符串都写 `wb_role`）、不校验 user 形状、不要求 session 已签发。它是纯本地路由函数——真正的权限边界在后端 token，前端这层仅 UI 路由。

**链路 6：ensureAccessToken（`request.js:113-125`）**
- access 内存有效 → 放行；无 access 有 refresh → 单飞刷新 `refreshAccessToken()`（`request.js:251-303`）；**两者皆无 → 本地 reject `AUTH_REQUIRED`，不发网络**（`request.js:115-117`）。
- refresh 无效/过期：本地过期预拦 `session.js:33-37`；服务端拒绝（非 2xx / 无 accessToken）→ `AUTH_EXPIRED` + `session.clear()` + `exitToLogin()`（`request.js:276-290`）；**纯网络故障（断网/超时）不清会话、不踢登录**（`request.js:294-298`，注释 `:188`）。
- token 与 wb_user 不联动：ensureAccessToken 只认 token，不认 `wb_role/wb_login_at`；两者由 `app.js` 登录/退出动作并行维护。

**链路 7：72h 会话（`app.js:13,22-50,53-61`）**
- `wb_login_at` 时间戳 + 固定 72h 窗口（`SESSION_TTL_MS=72h`，`:13`；`_isSessionExpired` `:47-50`）。
- 覆盖入口：冷启动 `onLaunch` 超期 → `logout()`（`:28-29`）；`login.js:44` onLoad 调 `app.isLoggedIn()`（`:53-61`，超期自动 logout 并跳登录页）。
- logout 清理：`wb_role/wb_user/wb_login_at` + `session.clear()`（`app.js:73-82`）。
- `settings.onClearCache`（`settings.js:194-223`）：`session.snapshot()` → `clearStorageSync` → 恢复 `wb_role/wb_user/wb_login_at` + `session.restore()`，语义一致（单测 D-09/D-10 钉死）。

**链路 8：工作台鉴权拦截（`workbench.js:72-76`）**
- `onLoad`：`app.globalData.role !== 'doctor'` → `reLaunch` 登录页。拦截只在 onLoad（onShow 不复查，`workbench.js:97-111`）；role 判定纯本地内存/storage，可伪造——但 `/api/v1/doctor/*` 后端按 Bearer token 鉴权，伪造者只看得到空壳，数据请求 403 → `FORBIDDEN`（`request.js:484`）。

**链路 9：防重复提交**
- `manual-login.js:41`（submitting）、`login.js:107-108`（_busy）、`doctor-login.js:38`（submitting）均有在途守卫（单测 C-07、C-19 钉死）；**`patient-login.js:86-123` onWxLogin 无守卫**（见 Bug A-P2-3）。

**链路 10：前端格式校验**
- manual-login `:43` / patient-login `:54`：`/^1\d{10}$/`（随机号码不匹配正则则拦截；匹配即放行）；doctor-login `:39-43`：**仅查非空，无任何格式约束**。

### 0.3 复现步骤（当前 development 档）

1. 体验版打开小程序 → 进入「手输登录」（一键登录失败自动降级，或真机联调档直接可见）；
2. 患者端：手机号输 `19900001234`（任意 1 开头 11 位），密码输 `1` → 登录成功进首页，身份 = dev-user-1；
3. 医生端：账号输 `随便`，密码任意 → 登录成功直接 reLaunch 医生工作台，身份 = dev-user-2（王医生）。

### 0.4 对 72h 会话 / Token 体系的影响

- 不影响 Token 机制正确性：登录成功走的是**真实契约端点 + 真实签发**（dev provider 映射），access/refresh、401 单飞刷新、refresh 7 天轮换均工作正常（test-fe-request RQ-13~18、本报告 D 组钉死）。
- 影响在于：**dev 档「任意输入即真会话」与生产档「必须真实微信 code」之间，只有 BUILD_ENV 一处编译期开关**。72h 窗口内该 dev 会话的所有受保护请求都合法。

### 0.5 修复建议（P0）

1. **发版门禁**：CI/流水线增加断言——出体验版/正式版时 `env.js` 中 `BUILD_ENV` 必须为 `'production'`；仓库当前入库值 `'development'`（`env.js:15`）应改为占位 + 流水线注入，并补 `node tools/check-build-env.js` 之类硬门禁。
2. **dev provider 收窄**：服务端 dev 档 provider 仅在 `X-Platform` 头为开发特征或内网来源时接受 `dev-user-*-manual-*`/`*-wxlogin-*` 派生 code（现在只认 code 形态，隧道域名本身即可触发）。
3. **手输页隐藏加固**：`patient-login/doctor-login/manual-login` 三个页面在 `app.json` 保留注册但在生产档整页拦截（页面 onLoad 即 `if (ENV.isProduction) wx.reLaunch 登录页`），不依赖入口隐藏。
4. 短期缓解：用户反馈环境若为体验版，确认其构建档位；若确为 development 档分发，立即按 1 整改。

---

## 1. 用例表（AUTH-xxx）

| ID | 维度 | 前置 | 步骤（审查路径） | 预期 | 实测 | 证据 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AUTH-01 | S | dev 档 | manual-login 输合法格式手机号+任意密码 | dev 档放行（设计内）；生产档 BAD_SPEC reject | ✅（dev 档行为与代码一致） | manual-login.js:43,57；user.js:92-99；单测 B-01~B-04 | P0 |
| AUTH-02 | S | dev 档 | doctor-login 输任意非空账号 | 生产档 reject；dev 档映射 dev-user-2 | ✅ 属实 | doctor-login.js:39-46；doctor.js:95-102；单测 C-12/C-13 | P0 |
| AUTH-03 | S | 生产档 | userService.login / doctorService.login | reject BAD_SPEC、不发网 | ✅（代码门禁在位） | user.js:93-95；doctor.js:96-98 | P0 |
| AUTH-04 | S | dev/生产 | login.js `_login` 演示 code 派生 | 仅 !isProduction 替换 code；生产恒真 code | ✅ | login.js:144-150；单测 A-05 源码守卫 | P0 |
| AUTH-05 | S | 未登录 | 发起登录 POST /auth/wechat/login | 匿名白名单放行；请求头不带 Authorization | ✅ | request.js:63,133-136；复用 test-fe-request RQ-12 | P1 |
| AUTH-06 | S | 桩响应缺 accessToken | loginByWxCode | reject BIZ_ERROR、不落会话 | ✅ | user.js:49-51；单测 B-07/B-08 | P1 |
| AUTH-07 | R | 后端断网 | 触发任一登录 | reject（NETWORK_ERROR/TIMEOUT）、toast 中文、零登录键 | ✅ | request.js:506-513；单测 B-10/B-11、C-21 | P1 |
| AUTH-08 | S | 403 响应 | doctorService.loginByWxCode | err.code=FORBIDDEN；页面中文提示、不提权 | ✅ | request.js:484-487；doctor-login.js:56-59；单测 B-09、C-14/C-15 | P1 |
| AUTH-09 | R | wb_login_at=73h 前 | app.onLaunch | 自动 logout、三件套清空 | ✅ | app.js:28-29,47-50；单测 D-04/D-05 | P1 |
| AUTH-10 | F | wb_login_at=1h 前 | app.onLaunch → login.onLoad | globalData.role 恢复；isLoggedIn=true 跳对应端 | ✅ | app.js:30-33,53-61；单测 D-06 | P1 |
| AUTH-11 | S | 登录中 | app.logout | 清 wb_role/wb_user/wb_login_at + access/refresh | ✅ | app.js:73-82；单测 D-09 | P1 |
| AUTH-12 | S | role=patient/空 | workbench.onLoad | reLaunch 登录页、不加载数据 | ✅ | workbench.js:72-76；单测 E-01/E-02 | P1 |
| AUTH-13 | F | role=doctor+token | workbench.onLoad | 不跳登录页、拉数据 | ✅ | workbench.js:72-95；单测 E-03 | P1 |
| AUTH-14 | S | 在途连点 | manual-login.onSubmit ×3 / login.onGetPhoneNumber ×3 | 只发 1 次登录请求 | ✅ | manual-login.js:41；login.js:107-108；单测 C-07、C-19 | P1 |
| AUTH-15 | U | 各类失败 | 4 登录页 catch | 错误文案走 errText、不直出 err.message | ✅ | manual-login.js:65；patient-login.js:73；doctor-login.js:64；err-text.js:35-60 | P2 |
| AUTH-16 | S | 无 token 无 refresh | 受保护 GET /api/v1/me | 本地 reject AUTH_REQUIRED、零网络 | ✅（复用） | request.js:113-117；test-fe-request RQ-13 | P1 |
| AUTH-17 | R | access 过期 | 受保护请求 401 | 单飞刷新 + 同幂等键重发一次 | ✅（复用） | request.js:478-483；test-fe-request RQ-15 | P1 |
| AUTH-18 | R | refresh 被拒 | 受保护请求 | AUTH_EXPIRED + 清会话 + 弹窗引导重登 | ✅（复用） | request.js:287-291,233-249；test-fe-request RQ-16 | P1 |
| AUTH-19 | F | 登录态 | settings.onClearCache | 保留 wb_role/wb_user/wb_login_at + session 快照恢复 | ✅ | settings.js:203-219；单测 D-10 | P1 |
| AUTH-20 | S | agreed=false | patient-login.onSubmit（手输） | 应拦截；实测仍发网 | ❌ | patient-login.js:47-80（对照 onWxLogin:90-93 有校验）；单测 C-09 | P1 |
| AUTH-21 | S | setTokens | refresh 写入 | 本地不接受响应体延长 refresh TTL（镜像 7 天） | ✅ | session.js:51-59 | P2 |
| AUTH-22 | S | 退出登录 | 各 onLogout | 应通知后端注销 refresh | ❌（端点零调用） | api.js:22 AUTH_LOGOUT 无调用点；app.js:73-82 | P1 |
| AUTH-23 | R | 清 storage 残留 | logout 后 wb_user_profile / wb_doctor | 应同步清除 | ⚠️ | profile.js:162、settings.js:260 仅 app.logout()（对照 triage.js:539-540 配对调）；user.js:32-35 | P2 |
| AUTH-24 | S | 72h 内停留在工作台 | workbench.onShow | 复查角色/会话 | ⚠️ 不复查（request 层 exitToLogin 兜底） | workbench.js:97-111 | P2 |
| AUTH-25 | S | wb_login_at 缺失而内存 role 残留 | isLoggedIn | 应判失效 | ⚠️ 视为未过期（app.js:48） | app.js:47-49 | P2 |

---

## 2. Bug 清单

### [P0] 「随机号码+任意密码可登录」在 development 档随包生效（AUTH-01/02/03/04）
- 位置：`config/env.js:15`（BUILD_ENV='development'）；`config/env.js:71`；`pages/auth/login/login.js:145-150`；`services/user.js:92-99`；`services/doctor.js:95-102`
- 根因：dev 档 provider 接受 `dev-user-*-manual-<输入>` / `dev-user-*-wxlogin-<stamp>` 派生 code 并真实签发会话；手输「密码」不进入请求；生产隔离仅靠构建时改 BUILD_ENV 一处人为开关。
- 复现：见 §0.3。
- 影响：体验版/联调档上，任意输入即可获得患者/医生端会话；若误以 development 档分发，等于无密码登录上线。
- 建议：见 §0.5 四条（CI 档位门禁 / dev provider 收窄 / 生产档页面级拦截 / 环境确认）。
- 证据：`user.js:89` 注释「password 不参与校验（dev 档无密码体系）」；单测 B-01~B-04、C-12/C-13、C-17。

### [P1] patient-login 手输提交漏查协议勾选（AUTH-20）
- 位置：`pages/auth/patient-login/patient-login.js:47-80`
- 根因：`onWxLogin` 有 `if (!this.data.agreed)` 拦截（`:90-93`），手输 `onSubmit` 分支遗漏；对照 `manual-login.js:51-54` 有该校验。
- 复现：patient-login 页不勾协议 → 输手机号+密码 → onSubmit 直接发网（单测 C-09：agreed=false 仍发 1 次请求）。
- 影响：合规缺口——未同意隐私政策的用户也能完成登录。
- 建议：`onSubmit` 加 `if (!this.data.agreed) { wx.showToast(...); return }`，与 manual-login 对齐。
- 证据：单测 C-09 钉死。

### [P1] 本地退出不注销后端会话（AUTH-22）
- 位置：`config/api.js:22`（`POST /api/v1/auth/logout` 注册但全仓无调用）；`app.js:73-82`
- 根因：logout 只清本地三件套 + session.clear()；refresh token 服务端最长仍有效 7 天（session.js:19 镜像服务端 TTL）。
- 复现：退出登录 → 抓包/换设备用旧 refresh 调 /api/v1/auth/refresh 仍可换新 access（后端行为，本次仅前端审查）。
- 影响：换机/丢失场景，旧 refresh 窗口期内会话可被恢复。
- 建议：logout 前 `post(API.AUTH_LOGOUT, {}, {_authRetried 豁免})` 异步注销（失败不阻塞本地退出）。
- 证据：Grep 全仓 `AUTH_LOGOUT` 仅 api.js:22 定义与导出，无调用点。

### [P2] logout 后 wb_user_profile / wb_doctor 残留（AUTH-23）
- 位置：`pages/profile/profile.js:162`、`pages/profile/settings/settings.js:260`（仅 `app.logout()`）
- 根因：`app.logout()` 未联动 `userService.logout()`（清 `wb_user_profile`，user.js:32-35）/ `doctorService.logout()`（清 `wb_doctor`，doctor.js:29-32）；对照 triage.js:539-540、consultation.js:835-836、account-security.js:62-63、personal.js:112-113 均为配对调用。
- 影响：退出后本地残留上一用户资料缓存（隐私小问题；新用户登录前 profile 页可能读到旧数据的短暂窗口）。
- 建议：profile/settings 的 onLogout 补 `userService.logout()`。
- 证据：上述行号对照。

### [P2] patient-login.onWxLogin 无在途防重点（AUTH-14 补漏）
- 位置：`pages/auth/patient-login/patient-login.js:86-123`
- 根因：无 submitting/_busy 守卫（其余三登录页均有）。
- 影响：快速连点重复 wx.login + loginByWxCode（后端幂等吸收，但增加无谓请求）。
- 建议：加 `_busy` 守卫，与 login.js:107-108 对齐。
- 证据：代码对照。

### [P2] workbench 拦截仅 onLoad 且不查会话时效（AUTH-24/25）
- 位置：`pages/doctor/workbench/workbench.js:72-76,97-111`；`app.js:47-49`
- 根因：onLoad 只查 `globalData.role === 'doctor'`（内存值），onShow 不复查；`_isSessionExpired` 对 loginAt 缺失直接 `return false`。
- 影响：role 纯本地可伪造（仅 UI 壳，数据 403 兜底）；72h 超期在工作台内不主动引导重登（靠 request.js exitToLogin 兜底）。
- 建议：onLoad/onShow 补 `app.isLoggedIn()` 判定；`_isSessionExpired` 对缺失 loginAt 且 globalData.role 存在的情形收紧为过期。
- 证据：行号原文。

---

## 3. 页面核对表

### 页面 miniprogram/pages/auth/login/login.*
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 两按钮 open-type=getPhoneNumber（患者/医护） | F | ✅ | login.wxml:45-58 | 患者/医护同一交互，去向由服务端 roles 定 |
| 演示 code 派生由 !isProduction 门禁 | S | ✅ | login.js:144-150 | 见 P0 专项 |
| _busy 连点保护 | S | ✅ | login.js:107-108 | 单测 C-19 |
| 403 医生未登记中文提示 | S | ✅ | login.js:163-167 | |
| 一键失败 → dev 档降级手输页 | R | ✅ | login.js:173-183 | 生产档 manualEnabled=false 只 toast |
| onLoad 72h 内免登跳转 | F | ✅ | login.js:44-46 | app.isLoggedIn |
| 错误文案走 err-text | U | ✅ | catch 分支 toast 均为固定中文 | |

### 页面 miniprogram/pages/auth/patient-login/patient-login.*
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 手机号正则 + 密码非空 | S | ✅ | patient-login.js:54-61 | |
| 协议勾选拦截 | S | ❌ | patient-login.js:47-80（漏）vs :90-93（onWxLogin 有） | Bug P1 |
| manualEnabled 生产档关闭 | S | ✅ | patient-login.js:24,48-51 | |
| onWxLogin 在途防重点 | S | ❌ | patient-login.js:86-123 | Bug P2 |
| onWxLogin catch 降级手输 | R | ✅ | patient-login.js:112-116 | 不区分 FORBIDDEN（患者端影响小） |

### 页面 miniprogram/pages/auth/manual-login/manual-login.*
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 手机号正则/密码非空/协议勾选三重校验 | S | ✅ | manual-login.js:43-54 | 单测 C-01~C-03 |
| submitting 防重复提交 | S | ✅ | manual-login.js:41 | 单测 C-07 |
| 成功后 setLogin + 按 roles 分流 | F | ✅ | manual-login.js:70-79 | 单测 C-05/C-06 |
| 失败 errText 中文 toast | U | ✅ | manual-login.js:62-67 | |

### 页面 miniprogram/pages/auth/doctor-login/doctor-login.*
| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 账号非空校验 | S | ⚠️ | doctor-login.js:39-43 | 无格式约束（dev 档设计内，见 P0） |
| submitting 防重点 | S | ✅ | doctor-login.js:38 | |
| 403/FORBIDDEN 中文拦截 | S | ✅ | doctor-login.js:56-59 | 单测 C-14 |
| BAD_SPEC（生产档）中文提示 | S | ✅ | doctor-login.js:60-63 | |
| _devCode 演示派生 | S | ✅ | doctor-login.js:128-131 | !isProduction 门禁 |

### 横切文件核对（app.js / config / services / workbench / settings / err-text）
| 文件 | 核对点 | 实测 | 证据 |
| --- | --- | --- | --- |
| app.js | 72h TTL=72h；onLaunch 超期 logout；isLoggedIn 双检；setLogin 无参数校验；logout 清理范围 | ✅/⚠️（见 AUTH-22~25） | app.js:13,22-50,53-82 |
| config/env.js | 三档 gateway；isProduction；legacyManualLoginEnabled；MOCK_FALLBACK；生产自检 throw | ✅（当前档=development 即 P0 现场） | env.js:15,22-57,67,71,75 |
| config/api.js | USER_WX_LOGIN=/api/v1/auth/wechat/login；DOCTOR_LOGIN=/api/v1/doctor/login；AUTH_REFRESH；AUTH_LOGOUT 零调用 | ✅/❌ | api.js:20-22,33-34 |
| services/session.js | access 内存/refresh 持久化 7 天镜像；本地过期预拦；snapshot/restore | ✅ | session.js:19,26-42,51-59,90-110 |
| services/request.js | 匿名白名单；ensureAccessToken；401 单飞；refresh 失败清会话/网络故障不清；withFallback 不含登录 | ✅ | request.js:62-136,251-303,478-490,646-654 |
| services/user.js | loginByWxCode/login 派生 code；applySession 缺 token 抛错；setTokens | ✅ | user.js:47-99 |
| services/doctor.js | loginByWxCode/login；403 服务端判定；applySession | ✅ | doctor.js:45-102 |
| workbench.js | onLoad role 拦截；onShow 不复查；errText 错误态 | ✅/⚠️ | workbench.js:72-76,97-111,214,297 |
| settings.js | onClearCache 保留登录键+快照恢复；onLogout 未联动 userService.logout | ✅/❌ | settings.js:194-223,254-264 |
| err-text.js | 已知 code 中文；纯 ASCII 拦截；console.warn 溯源 | ✅ | err-text.js:35-60 |

---

## 4. 新增单测记录

- 脚本：`tools/test-login-auth-audit.js`（node v22.23.2 实跑）
- 结果：**PASS=51 / FAIL=0**（`node --check` 语法 OK）
- 覆盖：env 门禁事实与源码守卫 ×5；服务层登录契约 ×11；4 登录页校验/防重/403/一键派生 ×21；72h 会话与清理 ×10；工作台拦截 ×4。
- 复用说明：request.js 会话守卫（无 token 零网络 / 401 单飞刷新 / refresh 被拒清会话 / 匿名白名单 / GET 单飞）已由 `tools/test-fe-request.js` RQ-12~RQ-18 覆盖，本脚本不重复实现，仅在报告引用。
- 复现命令：`node tools/test-login-auth-audit.js`

---

## 5. 下一步建议

1. P0：按 §0.5 出 CI 档位门禁 + dev provider 收窄；确认用户反馈环境的构建档位。
2. P1：patient-login.onSubmit 补协议勾选；logout 前异步调 AUTH_LOGOUT。
3. P2：profile/settings onLogout 联动 userService.logout；patient-login.onWxLogin 加 _busy；workbench onShow 复查会话。
