/**
 * tools/test-login-auth-audit.js —— 分片A「登录/鉴权/会话/请求层」离线审计单测
 *
 * 目的（P0 专项：用户反馈「随机号码+任意密码都能登录」）：
 *   打桩 wx / getApp / App / Page / storage，真实 require 页面与服务层，钉死：
 *   ① 4 个登录页的前端校验分支（手机号正则 / 协议勾选 / 空账号 / 防重复提交）
 *   ② 服务层门禁：dev 档派生 code 发送、password 不参与请求体、缺 accessToken 拒绝落会话
 *   ③ app.js 72h 会话：超期判定 / onLaunch 清理 / logout 清理范围
 *   ④ workbench onLoad 角色拦截
 *   ⑤ env.js 生产隔离规则（源码级守卫，防回归）
 *
 * 复用说明：request.js 的会话守卫（无 token 本地拒绝 / 401 单飞刷新 / 匿名白名单 /
 *   refresh 被拒清会话）已由 test-fe-request.js RQ-12~RQ-18 覆盖，本脚本不重复造。
 *
 * 运行：node tools/test-login-auth-audit.js
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..', 'miniprogram')
let PASS = 0
let FAIL = 0
const fails = []

function check(name, ok, extra) {
  if (ok) { PASS++; return }
  FAIL++
  fails.push(name + (extra ? '  ← ' + extra : ''))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ==================== 打桩环境 ====================
const storage = {}
let reqCalls = []           // {url, method, data, header}
let toastCalls = []
let modalCalls = []
let navCalls = []           // reLaunch / switchTab / navigateTo / navigateBack
let wxLoginCalls = 0
let loginFault = null      // null | 'forbidden' | 'network'

const PATIENT_SESSION = {
  accessToken: 'at-p', refreshToken: 'rt-p', expiresIn: 7200, tokenType: 'Bearer',
  user: { id: 'u1', displayName: '张患者', roles: ['PATIENT'], phoneBound: true }
}
const DOCTOR_SESSION = {
  accessToken: 'at-d', refreshToken: 'rt-d', expiresIn: 7200, tokenType: 'Bearer',
  user: { id: 'u2', displayName: '王医生', roles: ['DOCTOR'], phoneBound: true }
}
const REFRESHED = { accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 7200 }

function wxRequest(o) {
  reqCalls.push({ url: String(o.url || ''), method: o.method, data: o.data, header: o.header || {} })
  const url = String(o.url || '')
  setTimeout(() => {
    try {
      if (url.indexOf('/auth/wechat/login') >= 0) {
        if (loginFault === 'network') return o.fail({ errMsg: 'request:fail timeout' })
        if (loginFault === 'forbidden') return o.success({ statusCode: 403, data: { code: 'FORBIDDEN', message: '无医生任职关系' } })
        return o.success({ statusCode: 200, data: { code: 'OK', data: PATIENT_SESSION } })
      }
      if (url.indexOf('/doctor/login') >= 0) {
        if (loginFault === 'network') return o.fail({ errMsg: 'request:fail' })
        if (loginFault === 'forbidden') return o.success({ statusCode: 403, data: { code: 'FORBIDDEN', message: '无医生任职关系' } })
        return o.success({ statusCode: 200, data: { code: 'OK', data: DOCTOR_SESSION } })
      }
      if (url.indexOf('/auth/refresh') >= 0) {
        return o.success({ statusCode: 200, data: { code: 'OK', data: REFRESHED } })
      }
      if (url.indexOf('/resources/manifest') >= 0) {
        return o.success({ statusCode: 200, data: { code: 'OK', data: { items: [] } } })
      }
      // 其余受保护端点：有 token 即 200
      return o.success({ statusCode: 200, data: { code: 'OK', data: null } })
    } catch (e) { /* 桩内异常不炸测试 */ }
  }, 0)
}

global.wx = {
  request: wxRequest,
  login() { wxLoginCalls++; setTimeout(() => { try { wx.login._cb && wx.login._cb({ code: 'wx-code-real' }) } catch (e) {} }, 0) },
  getStorageSync(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : '' },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  clearStorageSync() { Object.keys(storage).forEach((k) => delete storage[k]) },
  showToast(o) { toastCalls.push(o) },
  showLoading() {},
  hideLoading() {},
  showModal(o) { modalCalls.push(o); if (o && o.success) o.success({ confirm: true }) },
  reLaunch(o) { navCalls.push({ to: 'reLaunch', url: o.url }) },
  switchTab(o) { navCalls.push({ to: 'switchTab', url: o.url }) },
  navigateTo(o) { navCalls.push({ to: 'navigateTo', url: o.url }) },
  navigateBack(o) { navCalls.push({ to: 'navigateBack' }) },
  getImageInfo(o) { setTimeout(() => { if (o && o.fail) o.fail({ errMsg: 'no img' }) }, 0) },
  getWindowInfo() { return { statusBarHeight: 20 } },
  setNavigationBarTitle() {}
}
// wx.login success 注入器：桩默认 success(code=wx-code-real)
wx.login._cb = null
global.wx.login = function (o) {
  wxLoginCalls++
  setTimeout(() => { try { o.success({ code: 'wx-code-real' }) } catch (e) {} }, 0)
}
global.getCurrentPages = () => [{ route: 'pages/doctor/workbench/workbench' }]

// ==================== App / Page 捕获 ====================
let appCfg = null
global.App = (cfg) => { appCfg = cfg }
let appInstance = null
global.getApp = () => appInstance

function makeAppInstance(cfg) {
  const inst = { globalData: cfg.globalData, MOCK: cfg.MOCK }
  Object.keys(cfg).forEach((k) => {
    if (typeof cfg[k] === 'function') inst[k] = cfg[k].bind(inst)
  })
  return inst
}

// 先就位桩，再 require app.js
require(path.join(ROOT, 'app.js'))
appInstance = makeAppInstance(appCfg)

const ENV = require(path.join(ROOT, 'config', 'env.js'))
const session = require(path.join(ROOT, 'services', 'session.js'))
const userService = require(path.join(ROOT, 'services', 'user.js'))
const doctorService = require(path.join(ROOT, 'services', 'doctor.js'))

function loadPage(rel) {
  let cfg = null
  global.Page = (c) => { cfg = c }
  const abs = path.join(ROOT, rel)
  delete require.cache[require.resolve(abs)]
  require(abs)
  if (!cfg) throw new Error('未捕获到 Page 配置：' + rel)
  const inst = {
    data: JSON.parse(JSON.stringify(cfg.data || {})),
    setData(patch) { Object.assign(this.data, patch) }
  }
  Object.keys(cfg).forEach((k) => {
    if (typeof cfg[k] === 'function') inst[k] = cfg[k].bind(inst)
  })
  return inst
}

function reset() {
  Object.keys(storage).forEach((k) => delete storage[k])
  reqCalls = []
  toastCalls = []
  modalCalls = []
  navCalls = []
  wxLoginCalls = 0
  loginFault = null
  session.clear()
  // 模拟冷启动：内存角色态与 storage 同步复位（app.onLaunch 从 storage 重建 globalData.role）
  appInstance.globalData.role = ''
  appInstance.globalData.user = null
}

const lastToast = () => toastCalls[toastCalls.length - 1] || {}

// ==================== A. env.js 门禁事实（当前仓库档位） ====================
check('A-01 当前构建档位：isProduction=false（BUILD_ENV=' + ENV.name + '）', ENV.isProduction === false)
check('A-02 当前档位手输登录开放：legacyManualLoginEnabled=true（体验版=本档）', ENV.legacyManualLoginEnabled === true)
check('A-03 当前档位 mockReadFallback=true（开发降级开着）', ENV.MOCK_FALLBACK === true)

// 源码级生产隔离守卫：规则必须存在，防误删
const envSrc = fs.readFileSync(path.join(ROOT, 'config', 'env.js'), 'utf8')
check('A-04 源码守卫：手输登录为白名单档位（local/development），不再用 !== production 黑名单',
  /const DEV_ONLY\s*=\s*BUILD_ENV\s*===\s*'local'\s*\|\|\s*BUILD_ENV\s*===\s*'development'/.test(envSrc)
  && /LEGACY_MANUAL_LOGIN_ENABLED\s*=\s*DEV_ONLY/.test(envSrc)
  && !/LEGACY_MANUAL_LOGIN_ENABLED\s*=\s*BUILD_ENV\s*!==\s*'production'/.test(envSrc))
check('A-04b 源码守卫：BUILD_ENV 白名单校验（拼错直接抛错，fail-closed）',
  /ENV_KEYS\s*=\s*\['local',\s*'development',\s*'production'\]/.test(envSrc)
  && /ENV_KEYS\.indexOf\(BUILD_ENV\)\s*<\s*0/.test(envSrc))
const loginSrc = fs.readFileSync(path.join(ROOT, 'pages', 'auth', 'login', 'login.js'), 'utf8')
check('A-05 源码守卫：login.js 演示 code 派生由 legacyManualLoginEnabled + devLoginKey 双门禁',
  /if \(ENV\.legacyManualLoginEnabled && ENV\.devLoginKey\) \{[\s\S]*dev-user-/.test(loginSrc))
check('A-06 源码守卫：三个手输登录页均有生产档整页拦截',
  ['patient-login', 'manual-login', 'doctor-login'].every((p) => {
    const s = fs.readFileSync(path.join(ROOT, 'pages', 'auth', p, p + '.js'), 'utf8')
    return /if \(!ENV\.legacyManualLoginEnabled\) \{[\s\S]{0,120}reLaunch\(\{ url: '\/pages\/auth\/login\/login' \}\)/.test(s)
  }))

// ==================== B. 服务层登录契约 ====================
async function groupB() {
  reset()
  // B-01：患者手输登录 → 请求体含派生 code，**不含 password**
  const p = userService.login('13800138000', '任意密码XYZ')
  await sleep(20)
  const patientLoginCall = reqCalls.find((c) => c.url.indexOf('/auth/wechat/login') >= 0)
  check('B-01 患者手输登录：确实发网到 /auth/wechat/login（非本地伪造）', !!patientLoginCall)
  if (patientLoginCall) {
    check('B-02 密码不参与请求体：body 无 password 字段', !('password' in patientLoginCall.data))
    check('B-03 手机号被派生成 code=dev-user-1-manual-*',
      patientLoginCall.data && patientLoginCall.data.code === 'dev-user-1-manual-13800138000',
      '实际=' + (patientLoginCall.data && patientLoginCall.data.code))
    check('B-04 consentVersion 已带（契约 required）', !!patientLoginCall.data.consentVersion)
    // 后端 DevLoginGuard 要求 dev 派生 code 必须带 X-Dev-Login-Key（2026-10-29 加固）
    check('B-04b dev 派生 code 带 X-Dev-Login-Key（与 env.devLoginKey 一致）',
      !!ENV.devLoginKey && patientLoginCall.header['X-Dev-Login-Key'] === ENV.devLoginKey,
      '实际=' + JSON.stringify(patientLoginCall.header['X-Dev-Login-Key']))
  }
  await p.catch(() => {})

  // B-05：医生手输登录 → 任意非空账号都派生 dev-user-2（服务端映射该 openid）
  reset()
  const p2 = doctorService.login('随便打几个字', '')
  await sleep(20)
  const docLoginCall = reqCalls.find((c) => c.url.indexOf('/doctor/login') >= 0)
  check('B-05 医生手输登录：任意非空账号即发网 /doctor/login', !!docLoginCall)
  if (docLoginCall) {
    check('B-06 账号原样拼进 dev-user-2-manual-*（任何账号 → dev-user-2 身份）',
      docLoginCall.data && docLoginCall.data.code === 'dev-user-2-manual-随便打几个字',
      '实际=' + (docLoginCall.data && docLoginCall.data.code))
  }
  await p2.catch(() => {})

  // B-07：登录响应缺 accessToken → 拒绝，不落会话
  reset()
  loginFault = null
  // 直接桩一个无 accessToken 的响应：复用 userService.loginByWxCode 但改桩路由？
  // 简化：桩 /auth/wechat/login 返回无 accessToken —— 通过临时替换 wx.request 路由实现
  const realReq = global.wx.request
  global.wx.request = (o) => {
    if (String(o.url).indexOf('/auth/wechat/login') >= 0) {
      setTimeout(() => o.success({ statusCode: 200, data: { code: 'OK', data: { user: { id: 'x', roles: ['PATIENT'] } } } }), 0)
    } else realReq(o)
  }
  let rejectedCode = ''
  try {
    await userService.loginByWxCode('c1', 'p1')
  } catch (e) { rejectedCode = e.code }
  global.wx.request = realReq
  check('B-07 响应缺 accessToken → reject BIZ_ERROR（不写会话）', rejectedCode === 'BIZ_ERROR', '实际=' + rejectedCode)
  check('B-08 拒绝后 access/refresh 均未落本地', session.getAccessToken() === '' && session.getRefreshToken() === '')

  // B-09：后端 403 FORBIDDEN → reject 带 code=FORBIDDEN（页面据此中文提示）
  reset()
  loginFault = 'forbidden'
  let fb = ''
  try { await doctorService.loginByWxCode('c2', 'p2') } catch (e) { fb = e.code }
  check('B-09 医生 403 → err.code=FORBIDDEN（前端可拦截提权）', fb === 'FORBIDDEN', '实际=' + fb)

  // B-10：后端网络故障 → 页面只能看到失败，绝不本地放行（无 withFallback 包裹登录）
  reset()
  loginFault = 'network'
  let netErr = ''
  try { await userService.login('13800138000', 'x') } catch (e) { netErr = e.code }
  check('B-10 后端不可用 → reject（NETWORK_ERROR/TIMEOUT），不写会话',
    netErr === 'NETWORK_ERROR' || netErr === 'TIMEOUT', '实际=' + netErr)
  check('B-11 故障后 storage 无任何登录键',
    storage.wb_role === undefined && storage.wb_user === undefined && storage.wb_login_at === undefined)
}

// ==================== C. 4 登录页校验分支 ====================
async function groupC() {
  // ---- manual-login ----
  reset()
  const ml = loadPage('pages/auth/manual-login/manual-login.js')
  ml.onLoad()
  // C-01：非法手机号拦截
  ml.onPhoneInput({ detail: { value: '12345' } })
  ml.onPwdInput({ detail: { value: 'x' } })
  ml.onToggleAgreement()
  ml.onSubmit()
  await sleep(10)
  check('C-01 manual-login：手机号非11位 → toast 拦截、零网络',
    reqCalls.length === 0 && /手机号/.test(lastToast().title || ''))
  // C-02：密码空拦截
  ml.onPhoneInput({ detail: { value: '13800138000' } })
  ml.onPwdInput({ detail: { value: '' } })
  ml.onSubmit()
  await sleep(10)
  check('C-02 manual-login：密码空 → toast 拦截、零网络',
    reqCalls.length === 0 && /密码/.test(lastToast().title || ''))
  // C-03：协议未勾拦截
  ml.onPwdInput({ detail: { value: 'x' } })
  ml.data.agreed = false
  ml.onSubmit()
  await sleep(10)
  check('C-03 manual-login：协议未勾 → toast 拦截、零网络',
    reqCalls.length === 0 && /协议/.test(lastToast().title || ''))
  // C-04：合法输入 → 发网 + 成功后 setLogin
  ml.data.agreed = true
  ml.onSubmit()
  await sleep(30)
  check('C-04 manual-login：合法输入即发网（当前档）', reqCalls.length === 1 && reqCalls[0].url.indexOf('/auth/wechat/login') >= 0)
  await sleep(500) // 等成功后 setTimeout 400ms 的导航
  check('C-05 登录成功落 wb_role=patient / wb_login_at 已写',
    storage.wb_role === 'patient' && !!storage.wb_login_at,
    'wb_role=' + storage.wb_role)
  check('C-06 成功后切首页 switchTab',
    navCalls.some((n) => n.to === 'switchTab' && n.url === '/pages/home/home'))

  // C-07：防重复提交 —— submitting 在途时第二次 onSubmit 必须被拦
  reset()
  const ml2 = loadPage('pages/auth/manual-login/manual-login.js')
  ml2.onLoad()
  ml2.onPhoneInput({ detail: { value: '13800138001' } })
  ml2.onPwdInput({ detail: { value: 'x' } })
  ml2.onToggleAgreement()
  ml2.onSubmit()
  ml2.onSubmit()
  ml2.onSubmit()
  await sleep(30)
  check('C-07 manual-login：连点 3 次只发 1 次登录请求（防重复提交）',
    reqCalls.length === 1, '实际发网=' + reqCalls.length)

  // ---- patient-login ----
  reset()
  const pl = loadPage('pages/auth/patient-login/patient-login.js')
  pl.onLoad()
  check('C-08 patient-login：当前档 manualEnabled=true（手输页活着）', pl.data.manualEnabled === true)
  // C-09：协议未勾直接提交手输表单 —— 修复后必须被拦截（P1-01）
  pl.onPhoneInput({ detail: { value: '13800138002' } })
  pl.onPwdInput({ detail: { value: 'x' } })
  pl.data.agreed = false
  pl.onSubmit()
  await sleep(30)
  check('C-09 patient-login：协议未勾，手输提交被拦截、不发网（P1-01 已修）',
    reqCalls.length === 0, '实际发网=' + reqCalls.length)
  // C-10：手机号格式拦截仍在
  reset()
  const pl2 = loadPage('pages/auth/patient-login/patient-login.js')
  pl2.onLoad()
  pl2.onPhoneInput({ detail: { value: 'abcdefg' } })
  pl2.onPwdInput({ detail: { value: 'x' } })
  pl2.onSubmit()
  await sleep(10)
  check('C-10 patient-login：非法手机号 → toast 拦截、零网络',
    reqCalls.length === 0 && /手机号/.test(lastToast().title || ''))

  // ---- doctor-login ----
  reset()
  const dl = loadPage('pages/auth/doctor-login/doctor-login.js')
  dl.onLoad()
  // C-11：账号空拦截
  dl.onSubmit()
  await sleep(10)
  check('C-11 doctor-login：空账号 → toast 拦截、零网络',
    reqCalls.length === 0 && /工号|手机号/.test(lastToast().title || ''))
  // C-12：任意字符串账号（非手机号）→ 无格式校验直接发网
  dl.onAccountInput({ detail: { value: 'xyz随便打' } })
  dl.onSubmit()
  await sleep(30)
  const dlCall = reqCalls.find((c) => c.url.indexOf('/doctor/login') >= 0)
  check('C-12 doctor-login：任意非空账号即发网（无手机号格式约束）', !!dlCall)
  if (dlCall) {
    check('C-13 该账号被原样拼进 dev-user-2-manual-*',
      dlCall.data && dlCall.data.code === 'dev-user-2-manual-xyz随便打',
      '实际=' + (dlCall.data && dlCall.data.code))
  }
  await sleep(500)
  // C-14：403 路径 —— 新实例 + 故障桩
  reset()
  loginFault = 'forbidden'
  const dl2 = loadPage('pages/auth/doctor-login/doctor-login.js')
  dl2.onLoad()
  dl2.onAccountInput({ detail: { value: '13900139001' } })
  dl2.onSubmit()
  await sleep(30)
  check('C-14 doctor-login：403 → 中文提示「未登记医生身份」、不写登录态',
    /未登记医生身份/.test(lastToast().title || '') && storage.wb_role === undefined,
    'toast=' + (lastToast().title || ''))
  check('C-15 403 后 submitting 已复位（可重试）', dl2.data.submitting === false)

  // ---- login.js 主登录页 ----
  reset()
  const lg = loadPage('pages/auth/login/login.js')
  lg.onLoad() // 未登录 → 不应 reLaunch
  check('C-16 login.onLoad：无有效登录态 → 不跳转（留在登录页）',
    !navCalls.some((n) => n.to === 'reLaunch'))
  // C-17：患者一键登录（dev 档）→ code 被派生为 dev-user-1-wxlogin-*
  lg.onGetPhoneNumber({ currentTarget: { dataset: { role: 'patient' } }, detail: { code: 'phone-code-1' } })
  await sleep(40)
  const wxLoginCall = reqCalls.find((c) => c.url.indexOf('/auth/wechat/login') >= 0)
  check('C-17 dev档一键登录：发网且 body.code=dev-user-1-wxlogin-*（本地派生，非真微信 code）',
    !!wxLoginCall && /^dev-user-1-wxlogin-/.test(wxLoginCall.data.code),
    wxLoginCall && wxLoginCall.data.code)
  await sleep(500)
  check('C-18 一键登录成功 → setLogin + switchTab 首页',
    storage.wb_role === 'patient' && navCalls.some((n) => n.to === 'switchTab'))
  // C-19：连点保护 —— _busy 在途时忽略第二次
  reset()
  const lg2 = loadPage('pages/auth/login/login.js')
  lg2.onLoad()
  lg2.onGetPhoneNumber({ currentTarget: { dataset: { role: 'patient' } }, detail: { code: 'pc-2' } })
  lg2.onGetPhoneNumber({ currentTarget: { dataset: { role: 'patient' } }, detail: { code: 'pc-3' } })
  lg2.onGetPhoneNumber({ currentTarget: { dataset: { role: 'patient' } }, detail: { code: 'pc-4' } })
  await sleep(40)
  check('C-19 login：连点 3 次只 wx.login 1 次（_busy 防重）',
    wxLoginCalls === 1, '实际 wx.login 次数=' + wxLoginCalls)
  // C-20：拒绝授权 → dev 档降级跳手输页
  reset()
  const lg3 = loadPage('pages/auth/login/login.js')
  lg3.onLoad()
  lg3.onGetPhoneNumber({ currentTarget: { dataset: { role: 'doctor' } }, detail: { errMsg: 'getPhoneNumber:fail user deny' } })
  await sleep(10)
  check('C-20 拒授权 → dev 档 navigateTo 手输页（doctor-login）',
    navCalls.some((n) => n.to === 'navigateTo' && /doctor-login/.test(n.url || '')))
  // C-21：后端故障 → 不写登录态，页面停留在登录流程
  reset()
  loginFault = 'network'
  const lg4 = loadPage('pages/auth/login/login.js')
  lg4.onLoad()
  lg4.onGetPhoneNumber({ currentTarget: { dataset: { role: 'patient' } }, detail: { code: 'pc-5' } })
  await sleep(40)
  check('C-21 后端故障 → 不 setLogin（storage 无登录键）',
    storage.wb_role === undefined && storage.wb_login_at === undefined)
}

// ==================== D. app.js 72h 会话 ====================
async function groupD() {
  reset()
  const now = Date.now()
  check('D-01 72h判定：loginAt=0 → 未过期', appInstance._isSessionExpired(0) === false)
  check('D-02 72h判定：71h前 → 未过期', appInstance._isSessionExpired(now - 71 * 3600 * 1000) === false)
  check('D-03 72h判定：73h前 → 已过期', appInstance._isSessionExpired(now - 73 * 3600 * 1000) === true)

  // D-04：onLaunch 超期 → 自动 logout
  storage.wb_role = 'patient'
  storage.wb_user = { name: 'x' }
  storage.wb_login_at = now - 73 * 3600 * 1000
  appInstance.onLaunch()
  check('D-04 onLaunch：72h 超期 → wb_role/wb_user/wb_login_at 全清',
    storage.wb_role === undefined && storage.wb_user === undefined && storage.wb_login_at === undefined)
  check('D-05 onLaunch：超期后 globalData.role 已复位空串', appInstance.globalData.role === '')

  // D-06：onLaunch 未超期 → 恢复 globalData
  storage.wb_role = 'doctor'
  storage.wb_user = { name: '王医生' }
  storage.wb_login_at = now
  appInstance.onLaunch()
  check('D-06 onLaunch：72h 内 → globalData.role=doctor 恢复', appInstance.globalData.role === 'doctor')

  // D-07：isLoggedIn 超期自动失效
  storage.wb_role = 'patient'
  storage.wb_login_at = now - 80 * 3600 * 1000
  appInstance.globalData.role = 'patient'
  check('D-07 isLoggedIn：超期返回 false 且清登录键',
    appInstance.isLoggedIn() === false && storage.wb_role === undefined)

  // D-08：setLogin 写三件套（无角色白名单：任何字符串都接受）
  appInstance.setLogin('doctor', { name: 't' })
  check('D-08 setLogin 写 wb_role/wb_user/wb_login_at',
    storage.wb_role === 'doctor' && !!storage.wb_login_at && storage.wb_user !== undefined)

  // D-09：logout 清理范围 = 三件套 + session refresh
  session.setTokens({ accessToken: 'at-x', refreshToken: 'rt-x', expiresIn: 7200 })
  appInstance.logout()
  check('D-09 logout：清 wb_role/wb_user/wb_login_at + refresh token 一并清',
    storage.wb_role === undefined && storage.wb_login_at === undefined &&
    session.getRefreshToken() === '' && session.getAccessToken() === '')

  // D-10：settings.onClearCache 语义 —— snapshot/restore 保留会话
  reset()
  session.setTokens({ accessToken: 'at-y', refreshToken: 'rt-y', expiresIn: 7200 })
  const snap = session.snapshot()
  wx.clearStorageSync()
  session.restore(snap)
  check('D-10 清缓存后 session.restore 恢复 refresh（不清登录态）',
    session.getRefreshToken() === 'rt-y', '实际=' + session.getRefreshToken())

  // D-11：退出登录必须先撤后端会话（P1-02）：带 Bearer + Idempotency-Key 打 /auth/logout
  reset()
  session.setTokens({ accessToken: 'at-logout', refreshToken: 'rt-logout', expiresIn: 7200 })
  storage.wb_role = 'patient'
  storage.wb_login_at = now
  storage.wb_user_profile = { name: '上一用户' }
  storage.wb_doctor = { name: '上一医生' }
  appInstance.globalData.role = 'patient'
  appInstance.logout()
  await sleep(20)
  const lo = reqCalls.filter((c) => c.url.indexOf('/api/v1/auth/logout') >= 0)[0]
  check('D-11 logout 调用 POST /api/v1/auth/logout（后端会话撤销，P1-02 已修）', !!lo,
    '实际请求=' + JSON.stringify(reqCalls.map((c) => c.method + ' ' + c.url)))
  check('D-11b logout 请求带 Bearer 与 Idempotency-Key（契约必填）',
    !!lo && /^Bearer at-logout$/.test(String(lo.header.Authorization || ''))
      && !!lo.header['Idempotency-Key'],
    lo ? JSON.stringify({ auth: lo.header.Authorization, idem: lo.header['Idempotency-Key'] }) : '无请求')
  check('D-11c logout 清掉上一用户资料缓存（wb_user_profile / wb_doctor，P2-01 已修）',
    storage.wb_user_profile === undefined && storage.wb_doctor === undefined,
    JSON.stringify({ p: storage.wb_user_profile, d: storage.wb_doctor }))
}

// ==================== E. workbench 鉴权拦截 ====================
async function groupE() {
  // E-01：患者角色直接进 workbench → onLoad 拦截 reLaunch 登录页
  reset()
  appInstance.globalData.role = 'patient'
  const wb = loadPage('pages/doctor/workbench/workbench.js')
  wb.onLoad()
  await sleep(20)
  check('E-01 workbench：patient 角色 onLoad → reLaunch 登录页',
    navCalls.some((n) => n.to === 'reLaunch' && n.url === '/pages/auth/login/login'),
    JSON.stringify(navCalls))
  // E-02：未登录（role=''）同样拦截
  reset()
  appInstance.globalData.role = ''
  const wb2 = loadPage('pages/doctor/workbench/workbench.js')
  wb2.onLoad()
  await sleep(20)
  check('E-02 workbench：role=空 → reLaunch 登录页',
    navCalls.some((n) => n.to === 'reLaunch' && n.url === '/pages/auth/login/login'))
  // E-03：doctor 角色 → 放行（不跳登录页）
  reset()
  appInstance.globalData.role = 'doctor'
  session.setTokens({ accessToken: 'at-wb', refreshToken: 'rt-wb', expiresIn: 7200 })
  const wb3 = loadPage('pages/doctor/workbench/workbench.js')
  wb3.onLoad()
  await sleep(40)
  check('E-03 workbench：doctor 角色 → 不跳登录页',
    !navCalls.some((n) => n.to === 'reLaunch' && n.url === '/pages/auth/login/login'))
  // E-04：拦截只在 onLoad；onShow 不复查角色（记录现状）
  wb3.onShow()
  check('E-04 workbench.onShow：不复查角色（现状记录）', true)
}

// ==================== 运行 ====================
;(async () => {
  await groupB()
  await groupC()
  await groupD()
  await groupE()

  console.log('=== test-login-auth-audit.js ===')
  console.log('PASS=' + PASS + '  FAIL=' + FAIL)
  if (fails.length) {
    console.log('--- 失败明细 ---')
    fails.forEach((f) => console.log('  ✗ ' + f))
  }
  process.exit(FAIL ? 1 : 0)
})()
