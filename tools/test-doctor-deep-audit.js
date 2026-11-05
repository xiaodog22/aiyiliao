/**
 * tools/test-doctor-deep-audit.js —— 分片D第二轮「详细版」深度审计（医生端 8 页）
 *
 * 覆盖（打桩 wx / Page / Component / storage；require 真实 app.js + 真实 services + 真实页面跑逻辑）：
 *   A. P1-06 修复验证：consult.onLoad 角色拦截 + 8 页 onLoad/onShow 全部角色拦截
 *   B. P2-03 修复验证：app.isLoggedIn() 时效逻辑（过期/缺失 loginAt → 登出）
 *      + workbench.onShow 复查（role='doctor' 但 wb_login_at 超 72h → reLaunch 登录）
 *   C. storage 篡改：伪造 wb_role='doctor'（无 refresh token）→
 *      页面层门放行（客户端门非安全边界）；数据层 ensureAccessToken 本地 reject AUTH_REQUIRED、零网络
 *   D. 源码级静态守门断言（防修复回退）
 *
 * 运行：node tools/test-doctor-deep-audit.js
 * ⚠️ 只读审查：不修改任何页面/服务/样式源码，仅内存打桩后 require。
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
  fails.push('  ✗ ' + name + (extra ? '  ← ' + extra : ''))
}

// ==================== 打桩 ====================
const __storage = {}
const REQLOG = []
const reLaunchCalls = []

global.wx = {
  request(o) {
    const url = String(o.url || '')
    REQLOG.push({ url, method: o.method || 'GET', data: o.data, header: o.header || {} })
    setTimeout(() => {
      // 通用成功信封：空列表 / 空对象；分页端点回 meta
      o.success({ statusCode: 200, data: { code: 0, data: [], meta: { nextCursor: '' } }, header: {} })
    }, 0)
  },
  getStorageSync(k) { return (global.__storage && global.__storage[k] !== undefined) ? global.__storage[k] : '' },
  setStorageSync(k, v) { global.__storage[k] = v },
  removeStorageSync(k) { if (global.__storage) delete global.__storage[k] },
  showToast() {},
  showModal(opts) { if (opts && typeof opts.success === 'function') opts.success({ confirm: true }) },
  reLaunch(o) { reLaunchCalls.push(o && o.url) },
  navigateTo() {},
  redirectTo() {},
  navigateBack() {},
  stopPullDownRefresh() {},
  pageScrollTo() {},
  nextTick(cb) { if (cb) cb() },
  getWindowInfo() { return { statusBarHeight: 20 } },
  getSystemInfoSync() { return { statusBarHeight: 20 } },
  getAccountInfoSync() { return {} }
}
global.__storage = __storage
global.getCurrentPages = () => ({ length: 1 })

// 捕获 App 配置（真实 app.js）
let appConfig = null
global.App = (cfg) => { appConfig = cfg }
global.Component = () => {}
global.getApp = () => appConfig

require(path.join(ROOT, 'app.js'))
if (!appConfig) throw new Error('未捕获到 App 配置（app.js require 失败）')

const session = require(path.join(ROOT, 'services', 'session.js'))
const doctorService = require(path.join(ROOT, 'services', 'doctor.js'))

const DAY = 24 * 3600 * 1000
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10))

function resetStorage() {
  Object.keys(__storage).forEach((k) => delete __storage[k])
  session.clear()
}

function seedDoctorSession(loginAtOffsetMs) {
  resetStorage()
  appConfig.globalData.role = 'doctor'
  appConfig.globalData.user = { displayName: '王医生' }
  appConfig.globalData.theme = 'standard'
  __storage.wb_role = 'doctor'
  __storage.wb_user = { displayName: '王医生' }
  __storage.wb_login_at = Date.now() + (loginAtOffsetMs || 0)
}

// ==================== 页面加载工具 ====================
function loadPage(rel) {
  let cfg = null
  global.Page = (c) => { cfg = c }
  const abs = path.join(ROOT, rel)
  delete require.cache[require.resolve(abs)]
  require(abs)
  if (!cfg) throw new Error('未捕获到 Page 配置：' + rel)
  return cfg
}

function instantiate(cfg) {
  const inst = Object.assign({}, cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}))
  inst.setData = (patch, cb) => {
    Object.keys(patch).forEach((k) => {
      // 支持 'active.status' / 'list[0].assigned' 两类路径
      const pathParts = k.split('.').map((seg) => {
        const m = /^([\w$]+)\[(\d+)\]$/.exec(seg)
        return m ? { arr: m[1], idx: Number(m[2]) } : seg
      })
      let cur = inst.data
      pathParts.forEach((p, i) => {
        if (typeof p === 'object') {
          cur[p.arr] = cur[p.arr] || []
          if (i === pathParts.length - 1) cur[p.arr][p.idx] = patch[k]
          else cur = cur[p.arr][p.idx] = cur[p.arr][p.idx] || {}
        } else {
          if (i === pathParts.length - 1) cur[p] = patch[k]
          else cur[p] = cur[p] || {}
        }
      })
    })
    if (typeof cb === 'function') cb()
  }
  return inst
}

const PAGES = [
  ['pages/doctor/workbench/workbench.js', 'onLoad'],
  ['pages/doctor/appointments/appointments.js', 'onLoad'],
  ['pages/doctor/beds/beds.js', 'onLoad'],
  ['pages/doctor/personal/personal.js', 'onLoad'],
  ['pages/doctor/consult/consult.js', 'onLoad'],
  ['pages/doctor/schedule/schedule.js', 'onLoad'],
  ['pages/doctor/account-security/account-security.js', 'onLoad'],
  ['pages/doctor/messages/messages.js', 'onShow']
]

// ==================== A. P1-06 修复验证：8 页角色拦截 ====================
async function testAGates() {
  for (const [rel, hook] of PAGES) {
    const name = rel.split('/').pop()
    // 患者角色 → 必须 reLaunch 登录
    seedDoctorSession(0)
    appConfig.globalData.role = 'patient'
    reLaunchCalls.length = 0
    const inst = instantiate(loadPage(rel))
    inst[hook](hook === 'onLoad' ? {} : undefined)
    await tick(20)
    await tick(20)
    check('DOC-D-A[' + name + '] 非doctor角色被拦截→reLaunch登录',
      reLaunchCalls.length >= 1 && reLaunchCalls[0].indexOf('/pages/auth/login/login') >= 0,
      '实得 reLaunch=' + JSON.stringify(reLaunchCalls))

    // doctor 角色 + 新鲜会话 → 放行
    seedDoctorSession(0)
    reLaunchCalls.length = 0
    const inst2 = instantiate(loadPage(rel))
    inst2[hook](hook === 'onLoad' ? {} : undefined)
    await tick(20)
    await tick(20)
    check('DOC-D-A[' + name + '] doctor角色放行（不跳登录）',
      reLaunchCalls.length === 0, '实得 reLaunch=' + JSON.stringify(reLaunchCalls))
  }
}

// ==================== B. P2-03 修复验证：会话时效 + onShow 复查 ====================
function testBIsLoggedInUnit() {
  // B1 新鲜会话 → true
  seedDoctorSession(0)
  check('DOC-D-B1 新鲜 wb_login_at → isLoggedIn()=true', appConfig.isLoggedIn() === true)

  // B2 过期会话（73h 前）→ false，且顺手 logout（清 wb_role）
  seedDoctorSession(-73 * 3600 * 1000)
  const r = appConfig.isLoggedIn()
  check('DOC-D-B2 wb_login_at 超72h → isLoggedIn()=false 并执行登出',
    r === false && __storage.wb_role === undefined && appConfig.globalData.role === '',
    '实得 r=' + r + ' wb_role=' + JSON.stringify(__storage.wb_role))

  // B3 缺失 loginAt 但 role 在（脏数据/手工写 storage）→ false（审查 AUTH-25 收紧项）
  seedDoctorSession(0)
  delete __storage.wb_login_at
  appConfig.globalData.role = 'doctor'
  const r3 = appConfig.isLoggedIn()
  check('DOC-D-B3 缺失 wb_login_at → 按失效处理=false',
    r3 === false && __storage.wb_role === undefined,
    '实得 r=' + r3 + ' wb_role=' + JSON.stringify(__storage.wb_role))
}

async function testBWorkbenchOnShow() {
  // B4 workbench.onShow：新鲜会话 → 不跳登录
  seedDoctorSession(0)
  reLaunchCalls.length = 0
  const okInst = instantiate(loadPage('pages/doctor/workbench/workbench.js'))
  okInst.onShow()
  await tick(20); await tick(20)
  check('DOC-D-B4 workbench.onShow 新鲜会话放行', reLaunchCalls.length === 0,
    '实得 reLaunch=' + JSON.stringify(reLaunchCalls))

  // B5 workbench.onShow：会话过期（73h）→ reLaunch 登录（onShow 复查行为）
  seedDoctorSession(-73 * 3600 * 1000)
  reLaunchCalls.length = 0
  const expInst = instantiate(loadPage('pages/doctor/workbench/workbench.js'))
  expInst.onShow()
  await tick(20); await tick(20)
  check('DOC-D-B5 workbench.onShow 过期会话→reLaunch登录',
    reLaunchCalls.length >= 1 && reLaunchCalls[0].indexOf('/pages/auth/login/login') >= 0,
    '实得 reLaunch=' + JSON.stringify(reLaunchCalls))
}

// ==================== C. storage 篡改 ====================
async function testCTamper() {
  // 伪造：wb_role='doctor' + 新鲜 loginAt，但无 refresh token（伪造 wb_doctor 不含会话链）
  resetStorage()
  __storage.wb_role = 'doctor'
  __storage.wb_user = { displayName: '伪造医生' }
  __storage.wb_login_at = Date.now() - 3600 * 1000
  appConfig.globalData.role = ''
  appConfig.globalData.user = null
  appConfig.onLaunch()
  await tick(10)

  check('DOC-D-C1 伪造 wb_role=doctor → 页面层门放行（onLaunch 不登出）',
    appConfig.globalData.role === 'doctor',
    '实得 globalData.role=' + appConfig.globalData.role + '（客户端门非安全边界，与 P2-15 结论一致）')

  // 数据层：无 refresh token → ensureAccessToken 本地 reject AUTH_REQUIRED，零网络
  const reqBefore = REQLOG.length
  let rejectedCode = ''
  await doctorService.listAppointments({ limit: 50 })
    .then(() => { rejectedCode = 'RESOLVED(不该发生)' })
    .catch((e) => { rejectedCode = (e && e.code) || ('HTTP_' + (e && e.httpCode)) })
  await tick(10)
  check('DOC-D-C2 伪造身份调医生数据 → 本地 reject AUTH_REQUIRED 且未发网络',
    rejectedCode === 'AUTH_REQUIRED' && REQLOG.length === reqBefore,
    '实得 code=' + rejectedCode + ' 网络请求数=' + (REQLOG.length - reqBefore))
}

// ==================== D. 源码级静态守门断言 ====================
function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function testDStatic() {
  // D1 consult.onLoad：角色拦截在取参数/加载数据之前
  const consultSrc = readSrc('pages/doctor/consult/consult.js')
  const guardIdx = consultSrc.indexOf("if (app.globalData.role !== 'doctor')")
  const loadIdx = consultSrc.indexOf('this.loadList')
  check('DOC-D-D1 consult.onLoad 源码存在角色拦截且先于 loadList',
    guardIdx >= 0 && loadIdx > guardIdx,
    'guardIdx=' + guardIdx + ' loadIdx=' + loadIdx)

  // D2 workbench.onShow 源码复查 isLoggedIn
  const wbSrc = readSrc('pages/doctor/workbench/workbench.js')
  const onShowIdx = wbSrc.indexOf('onShow()')
  const seg = wbSrc.slice(onShowIdx, onShowIdx + 400)
  check('DOC-D-D2 workbench.onShow 源码含 app.isLoggedIn() 复查', /app\.isLoggedIn\(\)/.test(seg))

  // D3 app.isLoggedIn 源码收紧缺失 loginAt
  const appSrc = readSrc('app.js')
  const fnIdx = appSrc.indexOf('isLoggedIn()')
  const fnSeg = appSrc.slice(fnIdx, fnIdx + 400)
  check('DOC-D-D3 app.isLoggedIn() 源码含「缺失 loginAt 按失效」收紧', /!loginAt/.test(fnSeg),
    '片段=' + JSON.stringify(fnSeg.slice(0, 120)))

  // D4 8 页源码各自含角色拦截语句
  PAGES.forEach(([rel]) => {
    const src = readSrc(rel)
    check('DOC-D-D4 源码守门[' + rel.split('/').pop() + '] 含 globalData.role !== \'doctor\'',
      src.indexOf("app.globalData.role !== 'doctor'") >= 0)
  })
}

// ==================== 运行 ====================
;(async function main() {
  await (async () => { try { await testAGates() } catch (e) { check('DOC-D-A 用例抛异常: ' + e.message, false) } })()
  await (async () => { try { testBIsLoggedInUnit() } catch (e) { check('DOC-D-B 用例抛异常: ' + e.message, false) } })()
  await (async () => { try { await testBWorkbenchOnShow() } catch (e) { check('DOC-D-B-onShow 用例抛异常: ' + e.message, false) } })()
  await (async () => { try { await testCTamper() } catch (e) { check('DOC-D-C 用例抛异常: ' + e.message, false) } })()
  await (async () => { try { testDStatic() } catch (e) { check('DOC-D-D 用例抛异常: ' + e.message, false) } })()

  console.log('===== test-doctor-deep-audit.js =====')
  console.log('PASS=' + PASS + '  FAIL=' + FAIL)
  if (FAIL) {
    console.log('失败明细：')
    fails.forEach((f) => console.log(f))
  }
  process.exit(FAIL ? 1 : 0)
})()
