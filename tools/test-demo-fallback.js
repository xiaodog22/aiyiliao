/**
 * tools/test-demo-fallback.js —— 个人主体演示兜底回归
 *
 * 背景（2026-11-20）：个人主体小程序没有 getPhoneNumber 权限，真实支付也未开通。
 * 本用例钉死：
 *   ① 登录页「患者登录」弹模拟获取手机号确认框，不调用 wx.login / getPhoneNumber；
 *   ② 后端可用 → 走 dev 预置手机号签发真实会话；
 *   ③ 后端不可用 → 自动落本地演示会话（demo=true，不留旧 token）；
 *   ④ 支付页真实开关关闭/订单读取失败时，可生成 0.01 元本地模拟单并点击模拟支付成功；
 *   ⑤ 源码守卫：不出现 wx.requestPayment / open-type="getPhoneNumber"（避免个人主体编译/预览报错）。
 *
 * 运行：node tools/test-demo-fallback.js
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')

// 干净 clone 没有 config/env.local.js：config/env.js 会落到 production 档并在**模块加载期**
// fail-closed（缺 HTTPS 网关直接 throw）。与 tools/test-fe.js 同口径，先声明本次是 Node 单测，
// 让 env.js 走 local 档。小程序运行时没有 process 对象，该分支不影响线上（BUG-003）。
process.env.WB_NODE_TEST = '1'

let PASS = 0
let FAIL = 0
const fails = []

function check(name, ok, extra) {
  if (ok) { PASS++; return }
  FAIL++
  fails.push(name + (extra ? '  ← ' + extra : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ==================== 桩 ====================
const storage = {}
let reqCalls = []
let toastCalls = []
let modalCalls = []
let navCalls = []
let wxLoginCalls = 0
let loginFault = null
let modalConfirm = true

const PATIENT_SESSION = {
  accessToken: 'at-demo', refreshToken: 'rt-demo', expiresIn: 7200, tokenType: 'Bearer',
  user: { id: 'u-demo', displayName: '演示用户', roles: ['PATIENT'], phoneBound: true }
}

global.wx = {
  request(o) {
    reqCalls.push({ url: String(o.url || ''), method: o.method, data: o.data, header: o.header || {} })
    setTimeout(() => {
      const url = String(o.url || '')
      if (url.indexOf('/auth/wechat/login') >= 0) {
        if (loginFault === 'network') return o.fail({ errMsg: 'request:fail timeout' })
        return o.success({ statusCode: 200, data: { code: 'OK', data: PATIENT_SESSION } })
      }
      return o.success({ statusCode: 200, data: { code: 'OK', data: null } })
    }, 0)
  },
  login() { wxLoginCalls++ },
  getStorageSync(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : '' },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  clearStorageSync() { Object.keys(storage).forEach((k) => delete storage[k]) },
  showToast(o) { toastCalls.push(o) },
  showLoading() {},
  hideLoading() {},
  showModal(o) {
    modalCalls.push(o)
    if (o && o.success) o.success({ confirm: modalConfirm, cancel: !modalConfirm })
  },
  reLaunch(o) { navCalls.push({ to: 'reLaunch', url: o.url }) },
  switchTab(o) { navCalls.push({ to: 'switchTab', url: o.url }) },
  navigateTo(o) { navCalls.push({ to: 'navigateTo', url: o.url }) },
  navigateBack(o) { navCalls.push({ to: 'navigateBack' }) },
  getImageInfo(o) { setTimeout(() => { if (o && o.fail) o.fail({ errMsg: 'no img' }) }, 0) },
  getWindowInfo() { return { statusBarHeight: 20 } },
  setNavigationBarTitle() {}
}

let appCfg = null
let appInst = null
global.App = (cfg) => { appCfg = cfg }
global.getApp = () => appInst
global.getCurrentPages = () => [{ route: 'pages/home/home' }]
require(path.join(MP, 'app.js'))

// devLoginKey 只从本地未入库的 env.local.js 注入，干净 clone 下为空串 —— 手输登录会被
// services/user.js 的前置校验拦下（BAD_SPEC），D-05 永远拿不到 dev 派生 code。
// 这里在测试进程内注入固定假值（不是任何环境在用的真实闸门值；桩网络不会真的发给服务端）。
const ENV = require(path.join(MP, 'config', 'env.js'))
if (!ENV.devLoginKey) ENV.devLoginKey = 'e2e-fixture-dev-login-key'

function bindApp(cfg) {
  const inst = { globalData: cfg.globalData, MOCK: cfg.MOCK }
  Object.keys(cfg).forEach((k) => { if (typeof cfg[k] === 'function') inst[k] = cfg[k].bind(inst) })
  return inst
}
appInst = bindApp(appCfg)

function loadPage(rel) {
  let cfg = null
  global.Page = (c) => { cfg = c }
  const abs = path.join(MP, rel)
  delete require.cache[require.resolve(abs)]
  require(abs)
  if (!cfg) throw new Error('未捕获 Page：' + rel)
  const inst = {
    data: JSON.parse(JSON.stringify(cfg.data || {})),
    setData(patch) { Object.assign(this.data, patch) }
  }
  Object.keys(cfg).forEach((k) => { if (typeof cfg[k] === 'function') inst[k] = cfg[k].bind(inst) })
  return inst
}

function reset() {
  Object.keys(storage).forEach((k) => delete storage[k])
  storage.wb_policy_version = 'v1.0'
  storage.wb_policy_updated_at = '2026-11-18'
  storage.wb_consent_version = 'v1.0'
  storage.wb_consent_at = Date.now()
  appInst.globalData.role = ''
  appInst.globalData.user = null
  reqCalls = []
  toastCalls = []
  modalCalls = []
  navCalls = []
  wxLoginCalls = 0
  loginFault = null
  modalConfirm = true
}

async function main() {
  const loginWxml = fs.readFileSync(path.join(MP, 'pages', 'auth', 'login', 'login.wxml'), 'utf8')
  check('D-01 login.wxml 不声明 open-type="getPhoneNumber"', !/open-type\s*=\s*["']getPhoneNumber["']/.test(loginWxml))
  check('D-02 login.wxml 保留模拟获取手机号入口（bindtap=onManualLogin）',
    /bindtap="onManualLogin"/.test(loginWxml) && /模拟获取手机号/.test(loginWxml))

  // ① 后端可用：点击患者登录 → 弹出模拟确认 → dev 预置手机号签发真实会话
  reset()
  const lg = loadPage('pages/auth/login/login.js')
  lg.onLoad()
  lg.onManualLogin({ currentTarget: { dataset: { role: 'patient' } } })
  await sleep(40)
  const call = reqCalls.find((c) => c.url.indexOf('/auth/wechat/login') >= 0)
  check('D-03 患者登录先弹「模拟获取手机号」确认框',
    modalCalls.length === 1 && /模拟获取手机号/.test(modalCalls[0].title || ''))
  check('D-04 模拟登录不调用 wx.login（完全绕过 getPhoneNumber 权限）', wxLoginCalls === 0)
  check('D-05 后端可用 → code 使用 dev 预置手机号 13800138001',
    !!call && call.data && call.data.code === 'dev-user-1-manual-13800138001' &&
    call.data.phoneCode === 'dev-phone-13800138001',
    call && JSON.stringify(call.data))
  await sleep(500)
  check('D-06 后端可用 → 写入 patient 登录态并进入首页',
    appInst.globalData.role === 'patient' && navCalls.some((n) => n.to === 'switchTab' && /home/.test(n.url || '')))

  // ② 后端不可用：自动落本地演示会话
  reset()
  loginFault = 'network'
  const lg2 = loadPage('pages/auth/login/login.js')
  lg2.onLoad()
  lg2.onManualLogin({ currentTarget: { dataset: { role: 'patient' } } })
  await sleep(60)
  await sleep(500)
  check('D-07 后端不可用 → 仍进入本地演示登录（demo=true）',
    storage.wb_user && storage.wb_user.demo === true && appInst.globalData.role === 'patient')
  check('D-08 本地演示登录提示明确（不冒充真实登录）',
    toastCalls.some((t) => /本地演示成功/.test(t.title || '')))

  // ③ 支付：无后端订单时生成本地模拟单并支付成功
  const payWxml = fs.readFileSync(path.join(MP, 'pages', 'payment', 'payment.wxml'), 'utf8')
  const payJs = fs.readFileSync(path.join(MP, 'pages', 'payment', 'payment.js'), 'utf8')
  const homeWxml = fs.readFileSync(path.join(MP, 'pages', 'home', 'home.wxml'), 'utf8')
  const homeJs = fs.readFileSync(path.join(MP, 'pages', 'home', 'home.js'), 'utf8')
  check('D-09 payment 不调用 wx.requestPayment', !/wx\.requestPayment\s*\(/.test(payJs) && !/wx\.requestPayment\s*\(/.test(payWxml))
  check('D-10 payment 保留模拟收银台入口', /模拟支付（本地演示）/.test(payWxml) && /startLocalDemo/.test(payJs))
  check('D-15 home 模拟支付入口仅开发档渲染',
    /wx:if="\{\{demoEnabled\}\}"[\s\S]{0,120}goDemoPay/.test(homeWxml) &&
    /demoEnabled:\s*ENV\.legacyManualLoginEnabled/.test(homeJs))

  reset()
  const pay = loadPage('pages/payment/payment.js')
  pay.startLocalDemo()
  check('D-11 本地模拟单：0.01 元、UNPAID、localDemo=true',
    pay.data.order && pay.data.order.amountText === '0.01' && pay.data.order.status === 'UNPAID' &&
    pay.data.order.localDemo === true)
  modalConfirm = true
  pay.onPay()
  await sleep(20)
  check('D-12 点击模拟支付 → 弹出模拟收银台确认', modalCalls.some((m) => /模拟收银台/.test(m.title || '')))
  check('D-13 确认后本地订单置 PAID（不写后端）',
    pay.data.order.status === 'PAID' && reqCalls.length === 0)
  check('D-14 成功提示固定标注模拟', toastCalls.some((t) => /模拟支付成功/.test(t.title || '')))

  console.log('\n==================== 结果 ====================')
  if (FAIL) {
    console.log('FAIL ' + FAIL)
    fails.forEach((f) => console.log('  - ' + f))
  }
  console.log('PASS ' + PASS + ' / FAIL ' + FAIL)
  process.exit(FAIL ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
