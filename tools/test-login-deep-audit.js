/**
 * tools/test-login-deep-audit.js —— 分片A「登录/鉴权/会话域」第二轮详细版审计
 *
 * 目的：把第一轮（20261029 全量前端测试）登记的 P0-01 / P1-01 / P1-02 修复验证断言
 *       钉成可复跑的离线单测（打桩 wx / getApp / App / Page / storage / request，node 实跑）。
 *
 * 断言清单（红=现状不符安全预期/锁定现状；绿=已符合）：
 *   A1  P0-01①  dev 档 user.login(phone,pwd) 请求体不含 password（红=漏洞行为仍在，仅 dev 白名单档）
 *   A2  P0-01②  prod 档 user.login / doctor.login 必须 reject BAD_SPEC 且不发网（绿）
 *   A3  P0-01③  login.js 演示 code 派生：dev 派生 / prod 透传真实 wx code（绿，白名单+密钥双重判据）
 *   A4  P0-01④  prod 档三个手输登录页 onLoad 整页拦截 reLaunch 登录入口（绿）
 *   A5  P1-01⑤  patient-login.onSubmit agreed=false 不发网 / agreed=true 发 1 次（绿）
 *   A6  P1-02⑥  app.logout 时 access 有效 → 调 POST /api/v1/auth/logout 且带 Bearer（绿）
 *   A7  D-A-P1-01 access 内存已过期（refresh 仍存活）时 logout 先用 refresh 静默换 access 再撤销（绿）
 *
 * 运行：node tools/test-login-deep-audit.js
 */
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
let PASS = 0
let FAIL = 0
const results = [] // {id, name, status:'PASS'|'FAIL', tone:'红'|'绿', note}

function check(id, name, ok, tone, note) {
  if (ok) { PASS++ } else { FAIL++ }
  results.push({ id, name, ok, tone, note: note || '' })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ==================== 打桩环境 ====================
const storage = {}
let reqCalls = []
let navCalls = []
let toastCalls = []

const PATIENT_SESSION = {
  accessToken: 'at-p', refreshToken: 'rt-p', expiresIn: 7200, tokenType: 'Bearer',
  user: { id: 'u1', displayName: '张患者', roles: ['PATIENT'], phoneBound: true }
}
const DOCTOR_SESSION = {
  accessToken: 'at-d', refreshToken: 'rt-d', expiresIn: 7200, tokenType: 'Bearer',
  user: { id: 'u2', displayName: '王医生', roles: ['DOCTOR'], phoneBound: true }
}

function wxRequest(o) {
  reqCalls.push({ url: String(o.url || ''), method: o.method, data: o.data, header: o.header || {} })
  const url = String(o.url || '')
  setTimeout(() => {
    try {
      if (url.indexOf('/auth/wechat/login') >= 0) {
        return o.success({ statusCode: 200, data: { code: 'OK', data: PATIENT_SESSION } })
      }
      if (url.indexOf('/doctor/login') >= 0) {
        return o.success({ statusCode: 200, data: { code: 'OK', data: DOCTOR_SESSION } })
      }
      // 撤销链路里的静默刷新：按契约返回轮换后的新对（accessToken 必须是新值，
      // 否则无法区分"用了旧 access"还是"先刷新再撤销"）
      if (url.indexOf('/auth/refresh') >= 0) {
        return o.success({ statusCode: 200,
          data: { code: 'OK', data: { accessToken: 'at-r2', refreshToken: 'rt-r2', expiresIn: 7200 } } })
      }
      if (url.indexOf('/auth/logout') >= 0) {
        return o.success({ statusCode: 200, data: { code: 'OK', data: { revoked: true } } })
      }
      return o.success({ statusCode: 200, data: { code: 'OK', data: null } })
    } catch (e) { /* 桩内异常不炸测试 */ }
  }, 0)
}

global.wx = {
  request: wxRequest,
  login(o) { setTimeout(() => { try { o.success({ code: 'wx-code-real' }) } catch (e) {} }, 0) },
  getStorageSync(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : '' },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  clearStorageSync() { Object.keys(storage).forEach((k) => delete storage[k]) },
  showToast(o) { toastCalls.push(o) },
  showLoading() {},
  hideLoading() {},
  showModal() {},
  reLaunch(o) { navCalls.push({ to: 'reLaunch', url: o.url }) },
  switchTab(o) { navCalls.push({ to: 'switchTab', url: o.url }) },
  navigateTo(o) { navCalls.push({ to: 'navigateTo', url: o.url }) },
  navigateBack(o) { navCalls.push({ to: 'navigateBack' }) },
  getImageInfo(o) { setTimeout(() => { if (o && o.fail) o.fail({ errMsg: 'no img' }) }, 0) }
}
global.getCurrentPages = () => [{ route: 'pages/auth/login/login' }]

// App / Page 捕获
let appCfg = null
global.App = (c) => { appCfg = c }
global.getApp = () => ({
  globalData: { theme: 'standard', role: '', user: null },
  isLoggedIn: () => false,
  setLogin() {},
  getRoleEntry: () => '/pages/home/home',
  logout() {},
  setTheme() {}
})

// ==================== 环境切换（dev 真实模块 / prod 模拟 env） ====================
const FAKE_PROD_ENV = {
  name: 'production',
  isProduction: true,
  gateway: 'https://api.example.com',
  fastapi: 'https://api.example.com',
  springboot: 'https://api.example.com',
  aiTimeout: 45000, ttsTimeout: 60000, carePlanTimeout: 90000,
  serviceReady: true,
  MOCK_READ_FALLBACK: false,
  MOCK_FALLBACK: false,
  platform: 'wechat-miniprogram',
  clientVersion: '4.0.0',
  consentVersion: 'v1.0',
  legacyManualLoginEnabled: false,
  devLoginKey: ''
}

function resolveMinirel(rel) { return require.resolve(path.join(ROOT, rel)) }

function loadModules(mode) {
  ;['config/env.js', 'config/api.js', 'services/request.js', 'services/session.js',
    'services/user.js', 'services/doctor.js'].forEach((rel) => {
      const p = resolveMinirel(rel)
      delete require.cache[p]
    })
  if (mode === 'prod') {
    const envPath = resolveMinirel('config/env.js')
    require.cache[envPath] = { id: envPath, filename: envPath, loaded: true, exports: FAKE_PROD_ENV }
  }
  // app.js 依赖打桩（resource / mock-data），两种模式都就位
  const resPath = resolveMinirel('services/resource.js')
  require.cache[resPath] = { id: resPath, filename: resPath, loaded: true,
    exports: { refreshManifest: () => Promise.resolve(), resourceUrl: (k, fb) => fb } }
  const mockPath = resolveMinirel('utils/mock-data.js')
  require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: {} }
  return {
    env: require(resolveMinirel('config/env.js')),
    session: require(resolveMinirel('services/session.js')),
    request: require(resolveMinirel('services/request.js')),
    user: require(resolveMinirel('services/user.js')),
    doctor: require(resolveMinirel('services/doctor.js'))
  }
}

function loadPage(rel) {
  const p = resolveMinirel(rel)
  delete require.cache[p]
  let pageDef = null
  const prevPage = global.Page
  global.Page = (def) => {
    pageDef = def
    // 运行时由框架注入 setData（合并进 data），桩内等价实现
    pageDef.setData = function (patch) { Object.assign(pageDef.data, patch) }
  }
  require(p)
  global.Page = prevPage
  return pageDef
}

// ==================== 对比度速算（WCAG 2.x） ====================
function lum(hex) {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const f = (c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function contrast(a, b) {
  const l1 = lum(a), l2 = lum(b)
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

async function main() {
  // ---------- 阶段 1：dev 档（仓库当前 BUILD_ENV='development'） ----------
  let mods = loadModules('dev')
  check('S1-env', 'dev 环境就位（legacyManualLoginEnabled=true / devLoginKey 非空）',
    mods.env.legacyManualLoginEnabled === true && !!mods.env.devLoginKey && mods.env.isProduction === false,
    '绿')

  // A1①：user.login(phone,pwd) 请求体不含 password
  reqCalls.length = 0
  await mods.user.login('19900001234', 'secret-123').then(() => {}, () => {})
  await sleep(20)
  const a1 = reqCalls.find((c) => c.url.indexOf('/auth/wechat/login') >= 0)
  check('A1-1', 'P0-01① user.login 请求体不含 password（dev 档漏洞行为锁定）',
    !!a1 && a1.data && a1.data.password === undefined &&
    a1.data.code === 'dev-user-1-manual-19900001234',
    '红', a1 ? 'body=' + JSON.stringify(a1.data) : '未发出请求')
  // doctor.login 对照
  reqCalls.length = 0
  await mods.doctor.login('doc001', 'secret-123').then(() => {}, () => {})
  await sleep(20)
  const a1b = reqCalls.find((c) => c.url.indexOf('/doctor/login') >= 0)
  check('A1-2', 'P0-01① doctor.login 请求体不含 password / code=dev-user-2-manual-*',
    !!a1b && a1b.data && a1b.data.password === undefined &&
    a1b.data.code === 'dev-user-2-manual-doc001' && a1b.data.phoneCode === undefined,
    '红', a1b ? 'body=' + JSON.stringify(a1b.data) : '未发出请求')

  // A3：login.js 演示 code 派生（dev）
  const loginPage = loadPage('pages/auth/login/login.js')
  reqCalls.length = 0
  loginPage._login('patient', 'WXREAL', 'PHONEREAL')
  await sleep(20)
  const a3d = reqCalls.find((c) => c.url.indexOf('/auth/wechat/login') >= 0)
  check('A3-1', 'P0-01③ dev 档 login.js 派生 dev-user-1-wxlogin-*（非透传 wx code）',
    !!a3d && /^dev-user-1-wxlogin-/.test(a3d.data.code),
    '绿', a3d ? 'code=' + a3d.data.code : '未发出请求')
  reqCalls.length = 0
  loginPage._login('doctor', 'WXREAL2', '')
  await sleep(20)
  const a3d2 = reqCalls.find((c) => c.url.indexOf('/doctor/login') >= 0)
  check('A3-2', 'P0-01③ dev 档 login.js 派生 dev-user-2-wxlogin-*',
    !!a3d2 && /^dev-user-2-wxlogin-/.test(a3d2.data.code),
    '绿', a3d2 ? 'code=' + a3d2.data.code : '未发出请求')

  // A5：patient-login agreed 守卫（dev 档）
  const patientPage = loadPage('pages/auth/patient-login/patient-login.js')
  patientPage.setData({ phone: '19900001234', pwd: 'x', agreed: false })
  reqCalls.length = 0
  patientPage.onSubmit()
  await sleep(20)
  check('A5-1', 'P1-01⑤ agreed=false 时 onSubmit 不发网',
    reqCalls.length === 0,
    '绿', '发出请求数=' + reqCalls.length)
  patientPage.setData({ agreed: true })
  reqCalls.length = 0
  patientPage.onSubmit()
  await sleep(20)
  check('A5-2', 'P1-01⑤ agreed=true 时 onSubmit 发 1 次登录请求',
    reqCalls.length === 1,
    '绿', '发出请求数=' + reqCalls.length)

  // ---------- 阶段 2：prod 档（模拟 env） ----------
  mods = loadModules('prod')
  check('S2-env', 'prod 环境就位（legacyManualLoginEnabled=false / devLoginKey 空）',
    mods.env.legacyManualLoginEnabled === false && mods.env.devLoginKey === '' && mods.env.isProduction === true,
    '绿')

  // A2：prod 档 service 层 BAD_SPEC 拦截
  let a2rej = null
  reqCalls.length = 0
  await mods.user.login('19900001234', 'x').catch((e) => { a2rej = e })
  await sleep(20)
  check('A2-1', 'P0-01② prod 档 user.login reject BAD_SPEC 且不发网',
    !!a2rej && a2rej.code === 'BAD_SPEC' && reqCalls.length === 0,
    '绿', 'err=' + (a2rej && a2rej.code) + ' req=' + reqCalls.length)
  let a2rej2 = null
  await mods.doctor.login('doc001', 'x').catch((e) => { a2rej2 = e })
  check('A2-2', 'P0-01② prod 档 doctor.login reject BAD_SPEC',
    !!a2rej2 && a2rej2.code === 'BAD_SPEC',
    '绿', 'err=' + (a2rej2 && a2rej2.code))

  // A3b：prod 档 login.js 透传真实 wx code（不派生）
  const loginPageProd = loadPage('pages/auth/login/login.js')
  reqCalls.length = 0
  loginPageProd._login('patient', 'WXREAL', 'PHONEREAL')
  await sleep(20)
  const a3p = reqCalls.find((c) => c.url.indexOf('/auth/wechat/login') >= 0)
  check('A3-3', 'P0-01③ prod 档 login.js 透传真实 wx code（无派生）',
    !!a3p && a3p.data.code === 'WXREAL' && !/^dev-user/.test(a3p.data.code),
    '绿', a3p ? 'code=' + a3p.data.code : '未发出请求')

  // A4：prod 档三手输页 onLoad 整页拦截
  navCalls.length = 0
  loadPage('pages/auth/patient-login/patient-login.js').onLoad()
  loadPage('pages/auth/manual-login/manual-login.js').onLoad()
  loadPage('pages/auth/doctor-login/doctor-login.js').onLoad()
  const reLaunchCount = navCalls.filter((n) => n.to === 'reLaunch' && n.url === '/pages/auth/login/login').length
  check('A4-1', 'P0-01④ prod 档 patient/manual/doctor-login onLoad → reLaunch 登录入口（应 3 次）',
    reLaunchCount === 3,
    '绿', 'reLaunch 次数=' + reLaunchCount)

  // ---------- 阶段 3：logout 撤销链路（P1-02） ----------
  // A6：access 有效 → logout 调 AUTH_LOGOUT
  appCfg = null
  require(resolveMinirel('app.js')) // app.js 的 App() 在模块加载时捕获
  mods.session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
  reqCalls.length = 0
  appCfg.logout()
  await sleep(20)
  const a6 = reqCalls.find((c) => c.url.indexOf('/auth/logout') >= 0)
  check('A6-1', 'P1-02⑥ logout 流程调 POST /api/v1/auth/logout（access 有效）',
    !!a6 && a6.method === 'POST' && a6.header.Authorization === 'Bearer at-1' &&
    !!a6.header['Idempotency-Key'],
    '绿', a6 ? 'url=' + a6.url + ' Authorization=' + a6.header.Authorization : '未发出撤销请求')
  check('A6-2', 'P1-02⑥ logout 后本地三件套 + refresh 全清',
    storage['wb_role'] === undefined && storage['wb_user'] === undefined &&
    storage['wb_login_at'] === undefined && storage['wb_refresh_token'] === undefined,
    '绿', '残留=' + Object.keys(storage).join(','))

  // A7（D-A-P1-01 修复锁）：access 内存为空、refresh 存活 → 先用 refresh 静默换 access 再撤销
  mods.session.clear()
  mods.session.setTokens({ refreshToken: 'rt-2' }) // 无 accessToken → 内存 access 为空
  const refreshAliveBefore = storage['wb_refresh_token'] === 'rt-2'
  reqCalls.length = 0
  appCfg.logout()
  await sleep(30)
  const a7 = reqCalls.find((c) => c.url.indexOf('/auth/logout') >= 0)
  const a7refresh = reqCalls.find((c) => c.url.indexOf('/auth/refresh') >= 0)
  check('A7-1', 'D-A-P1-01 access 内存为空时先用本地 refresh 换 access 再撤销（Bearer at-r2）',
    refreshAliveBefore && !!a7refresh && a7refresh.data && a7refresh.data.refreshToken === 'rt-2' &&
    !!a7 && a7.method === 'POST' && a7.header.Authorization === 'Bearer at-r2' &&
    !!a7.header['Idempotency-Key'],
    '绿', 'refresh请求=' + !!a7refresh + ' 撤销请求=' + !!a7 + ' Authorization=' + (a7 && a7.header.Authorization))
  check('A7-2', 'D-A-P1-01 退出后轮换出的新 refresh 未被静默写回 storage（无令牌复活）',
    storage['wb_refresh_token'] === undefined && storage['wb_refresh_expires_at'] === undefined,
    '绿', '残留=' + Object.keys(storage).filter((k) => k.indexOf('wb_refresh') >= 0).join(',') || '无')

  // ---------- 汇总 ----------
  console.log('===== 分片A 详细版断言结果 =====')
  let redCount = 0, greenCount = 0
  results.forEach((r) => {
    if (r.tone === '红') redCount++; else greenCount++
    console.log((r.ok ? '✓' : '✗') + ' [' + r.id + '] ' + r.name + '  [' + r.tone + '] ' + r.note)
  })
  console.log('--------------------------------')
  console.log('PASS=' + PASS + ' FAIL=' + FAIL + ' ｜ 红断言=' + redCount + ' 绿断言=' + greenCount)

  // 对比度速查（不参与 PASS/FAIL，仅量化输出）
  console.log('===== 对比度速算（375 档 px 无关，WCAG ratio） =====')
  const pairs = [
    ['#FFFFFF', '#0B6EF8', '主蓝按钮 白字 on #0B6EF8'],
    ['#828CA0', '#FFFFFF', '弱文本 #828CA0 on 白卡'],
    ['#5064A0', '#FFFFFF', '次文本 #5064A0 on 白'],
    ['#14264C', '#FFFFFF', '主文本 #14264C on 白'],
    ['#0B6EF8', '#FFFFFF', '协议链接蓝 on 白卡'],
    ['#FFFFFF', '#14264C', '医生 logo 白字/图标 on #14264C']
  ]
  pairs.forEach(([fg, bg, label]) => {
    console.log('  ' + label + ' = ' + contrast(fg, bg).toFixed(2) + ':1')
  })

  process.exit(FAIL > 0 ? 1 : 0)
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(2) })
