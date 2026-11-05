/**
 * tools/test-doctor-pages-audit.js —— 医生端 8 页离线静态/逻辑审查单测
 *
 * 覆盖（打桩 wx / getApp / Page / storage / request，真实 require 页面文件跑逻辑）：
 *   A. paginate() 对象导出回归（`const { paginate } = require(...)` 才能拿到函数；
 *      否则 "paginate is not a function" / data.all=undefined → 按钮点了没反应，2026-09-16 线上事故）
 *   B. 8 页鉴权拦截：非 doctor / 未登录 → reLaunch 登录页；doctor → 放行
 *   C. 挂号叫号状态流转守卫：叫号→CHECKED_IN、带 Idempotency-Key；409 回滚；_submitting 防连点
 *   D. 结束问诊闭环：二次确认 → POST /close 带幂等键；成功→CLOSED；409→当已结束；404→非本人不收口；closing 防重
 *
 * 运行：node tools/test-doctor-pages-audit.js
 *
 * ⚠️ 本脚本为只读审查：不修改任何页面/服务/样式源码，仅在内存打桩后 require。
 */
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
let PASS = 0
let FAIL = 0
const fails = []

function check(name, ok, extra) {
  if (ok) { PASS++; return }
  FAIL++
  fails.push('  ✗ ' + name + (extra ? '  ← ' + extra : ''))
}

// ==================== 运行模式（按用例切换） ====================
let APPT_STATUS_MODE = 'ok'   // ok | conflict409
let CLOSE_MODE = 'ok'         // ok | closed409 | notmine404

// 请求日志（断言用）
const REQLOG = []
const reLaunchCalls = []
let modalCalls = 0

// 未来日期（否则 appointments 的「今天及未来」前端过滤会把样本全滤掉）
const FUTURE = '2030-06-01T01:30:00Z'
const DOCTOR_APPTS = Array.from({ length: 5 }, (_, i) => ({
  id: 'apt' + (i + 1),
  status: i === 0 ? 'PENDING' : 'CONFIRMED',
  version: 1,
  queueNumber: i + 1,
  departmentName: '呼吸内科',
  doctorName: '王医生',
  startTime: FUTURE,
  patientName: '患者' + (i + 1)
}))

global.wx = {
  request(o) {
    const url = String(o.url || '')
    REQLOG.push({ url, method: o.method || 'GET', data: o.data, header: o.header || {} })
    setTimeout(() => {
      // 状态流转 POST /api/v1/doctor/appointments/{id}/status
      if (/\/doctor\/appointments\/[^/]+\/status$/.test(url)) {
        if (APPT_STATUS_MODE === 'conflict409') {
          o.success({ statusCode: 409, data: { code: 'VERSION_CONFLICT', message: '版本冲突' }, header: {} })
          return
        }
        let body = o.data
        if (typeof body === 'string') { try { body = JSON.parse(body) } catch (e) { body = {} } }
        const to = (body && body.toStatus) || 'CHECKED_IN'
        o.success({ statusCode: 200, data: { code: 0, data: { id: 'apt1', status: to, version: 2 } }, header: {} })
        return
      }
      // 结束问诊 POST /api/v1/doctor/consultations/{id}/close
      if (/\/doctor\/consultations\/[^/]+\/close$/.test(url)) {
        if (CLOSE_MODE === 'closed409') {
          o.success({ statusCode: 409, data: { code: 'CONSULTATION_CLOSED', message: '已结束' }, header: {} })
          return
        }
        if (CLOSE_MODE === 'notmine404') {
          o.success({ statusCode: 404, data: { code: 'NOT_FOUND', message: '非本人' }, header: {} })
          return
        }
        o.success({ statusCode: 200, data: { code: 0, data: { status: 'CLOSED' } }, header: {} })
        return
      }
      // 医生挂号列表
      if (/\/doctor\/appointments$/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, data: DOCTOR_APPTS, meta: { nextCursor: '' } }, header: {} })
        return
      }
      // 医生问诊列表 / 消息
      if (/\/doctor\/consultations/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, data: [], meta: { nextCursor: '' } }, header: {} })
        return
      }
      // /me
      if (/\/me$/.test(url)) {
        o.success({ statusCode: 200, data: { code: 0, data: { displayName: '王医生', avatarUrl: '', maskedPhone: '138****0000', phoneBound: true } }, header: {} })
        return
      }
      // 兜底：空列表成功，避免页面卡住
      o.success({ statusCode: 200, data: { code: 0, data: [], meta: { nextCursor: '' } }, header: {} })
    }, 0)
  },
  getStorageSync(k) { return (global.__storage && global.__storage[k] !== undefined) ? global.__storage[k] : '' },
  setStorageSync(k, v) { global.__storage = global.__storage || {}; global.__storage[k] = v },
  removeStorageSync(k) { if (global.__storage) delete global.__storage[k] },
  showToast() {},
  showModal(opts) {
    modalCalls++
    // 默认自动点「确定」，用于走通二次确认闭环
    if (opts && typeof opts.success === 'function') opts.success({ confirm: true })
  },
  reLaunch(o) { reLaunchCalls.push(o && o.url) },
  navigateTo() {},
  redirectTo() {},
  navigateBack() {},
  stopPullDownRefresh() {},
  pageScrollTo() {},
  nextTick(cb) { if (cb) cb() },
  getWindowInfo() { return { statusBarHeight: 20 } },
  getSystemInfoSync() { return { statusBarHeight: 20 } },
  setNavigationBarTitle() {}
}
global.__storage = {}
global.getCurrentPages = () => ({ length: 1 })

// 预置会话（受保护请求本地守卫：无 access 直接 reject）
const session = require(path.join(ROOT, 'services', 'session.js'))
session.setTokens({ accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 7200 })

const MOCK = require(path.join(ROOT, 'utils', 'mock-data.js'))
const appStub = {
  globalData: { role: 'doctor', theme: 'standard', user: { displayName: '王医生' } },
  MOCK,
  logout() {}
}
global.getApp = () => appStub

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
      const mDot = /^([\w$]+)\.([\w$.\[\]]+)$/.exec(k)
      if (mDot) {
        // a.b 或 a.b.c 路径（页面用 'active.status'、'active.patientName'）
        const parts = mDot[1].split('.').concat(mDot[2].split('.'))
        let cur = inst.data
        for (let i = 0; i < parts.length - 1; i++) {
          cur[parts[i]] = cur[parts[i]] || {}
          cur = cur[parts[i]]
        }
        cur[parts[parts.length - 1]] = patch[k]
      } else {
        inst.data[k] = patch[k]
      }
    })
    if (typeof cb === 'function') cb()
  }
  return inst
}

const tick5 = () => new Promise((r) => setTimeout(r, 20))
function settleLoading(inst, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (inst.data.loading === false || Date.now() - t0 > (ms || 400)) resolve()
      else setTimeout(tick, 10)
    }
    tick()
  })
}

// ==================== A. paginate 对象导出回归 ====================
;(function testPaginateRegression() {
  const { paginate } = require(path.join(ROOT, 'utils', 'paginate.js'))
  check('DOC-A1 paginate 具名解构拿到的是函数（对象导出形状正确）', typeof paginate === 'function')
  if (typeof paginate !== 'function') return
  const arr = Array.from({ length: 45 }, (_, i) => ({ id: i }))
  const p = paginate(arr, 1)
  check('DOC-A2 paginate() 回传 all（页面写 all:p.all 不会是 undefined）', Array.isArray(p.all) && p.all.length === 45, '实得 all=' + typeof p.all)
  check('DOC-A3 paginate() 回传 displayed/total/hasMore',
    Array.isArray(p.displayed) && p.displayed.length === 20 && p.total === 45 && p.hasMore === true)
  // 反例锁定：若页面误写成 `const paginate = require(...)`（默认导入对象），调用会崩
  const mod = require(path.join(ROOT, 'utils', 'paginate.js'))
  check('DOC-A4 模块是对象导出 { PAGE_SIZE, paginate }（非函数导出）', typeof mod === 'object' && typeof mod.paginate === 'function')
})()

// ==================== B. 8 页鉴权拦截 ====================
const ONLOAD_GATED = [
  ['pages/doctor/workbench/workbench.js', 'onLoad'],
  ['pages/doctor/appointments/appointments.js', 'onLoad'],
  ['pages/doctor/beds/beds.js', 'onLoad'],
  ['pages/doctor/personal/personal.js', 'onLoad'],
  ['pages/doctor/schedule/schedule.js', 'onLoad'],
  ['pages/doctor/account-security/account-security.js', 'onLoad']
]

;(async function testAuthGate() {
  for (const [rel, hook] of ONLOAD_GATED) {
    // 患者角色 → 必须被拦去登录
    appStub.globalData.role = 'patient'
    reLaunchCalls.length = 0
    let cfg = loadPage(rel)
    let inst = instantiate(cfg)
    inst[hook]()
    await tick5()
    check('DOC-B[' + rel.split('/').pop() + '] 非doctor角色被拦截→reLaunch登录',
      reLaunchCalls.length >= 1 && reLaunchCalls[0].indexOf('/pages/auth/login/login') >= 0,
      '实得 reLaunch=' + JSON.stringify(reLaunchCalls))

    // doctor 角色 → 放行（不 reLaunch 登录）
    appStub.globalData.role = 'doctor'
    reLaunchCalls.length = 0
    cfg = loadPage(rel)
    inst = instantiate(cfg)
    inst[hook]()
    await tick5()
    check('DOC-B[' + rel.split('/').pop() + '] doctor角色放行（不跳登录）',
      reLaunchCalls.length === 0, '实得 reLaunch=' + JSON.stringify(reLaunchCalls))
  }

  // consult 页：onLoad 同样应拦截（深链直达不能绕过）
  appStub.globalData.role = 'patient'
  reLaunchCalls.length = 0
  let cfg = loadPage('pages/doctor/consult/consult.js')
  let inst = instantiate(cfg)
  inst.onLoad({})
  await tick5()
  check('DOC-B[consult] 非doctor深链直达被拦截→reLaunch登录',
    reLaunchCalls.length >= 1 && reLaunchCalls[0].indexOf('/pages/auth/login/login') >= 0,
    '实得 reLaunch=' + JSON.stringify(reLaunchCalls) + '（consult.onLoad 缺角色拦截）')

  // messages 页：鉴权在 onShow
  appStub.globalData.role = 'patient'
  reLaunchCalls.length = 0
  cfg = loadPage('pages/doctor/messages/messages.js')
  inst = instantiate(cfg)
  inst.onShow()
  await tick5()
  check('DOC-B[messages] 非doctor在onShow被拦截→reLaunch登录',
    reLaunchCalls.length >= 1 && reLaunchCalls[0].indexOf('/pages/auth/login/login') >= 0,
    '实得 reLaunch=' + JSON.stringify(reLaunchCalls))
})()

// ==================== C. 挂号叫号状态流转守卫 ====================
async function testApptFlow() {
  appStub.globalData.role = 'doctor'
  APPT_STATUS_MODE = 'ok'
  const cfg = loadPage('pages/doctor/appointments/appointments.js')
  const inst = instantiate(cfg)
  inst.onLoad()
  await settleLoading(inst)
  await tick5()

  check('DOC-C1 列表拉取后 data.all 非空（不再 undefined）', Array.isArray(inst.data.all) && inst.data.all.length > 0,
    '实得 all.len=' + (inst.data.all || []).length)

  // apt1 是 PENDING → 可叫号
  const before = (inst.data.all || []).find((r) => r.id === 'apt1')
  check('DOC-C2 apt1 初态 PENDING 且 canCall=true', before && before.rawStatus === 'PENDING' && before.canCall === true,
    '实得 ' + JSON.stringify(before && { s: before.rawStatus, canCall: before.canCall }))

  const logBefore = REQLOG.length
  inst.onCall({ currentTarget: { dataset: { id: 'apt1' } } })
  await tick5()
  await tick5()

  const statusReq = REQLOG.slice(logBefore).find((r) => /\/status$/.test(r.url))
  check('DOC-C3 叫号触发 POST 状态流转', !!statusReq)
  if (statusReq) {
    let body = statusReq.data
    if (typeof body === 'string') { try { body = JSON.parse(body) } catch (e) { body = {} } }
    check('DOC-C4 流转目标=CHECKED_IN（叫号→就诊中）', body && body.toStatus === 'CHECKED_IN', '实得 toStatus=' + (body && body.toStatus))
    check('DOC-C5 状态流转带 Idempotency-Key 头', !!statusReq.header && !!statusReq.header['Idempotency-Key'],
      '实得 header=' + JSON.stringify(Object.keys(statusReq.header || {})))
  }
  const after = (inst.data.all || []).find((r) => r.id === 'apt1')
  check('DOC-C6 叫号后 apt1 乐观更新为 CHECKED_IN', after && after.rawStatus === 'CHECKED_IN' && after.canFinish === true,
    '实得 ' + JSON.stringify(after && { s: after.rawStatus, canFinish: after.canFinish }))

  // 防连点：_submitting 期间再点不应发新请求
  // ⚠️ 先等上一笔彻底静止：乐观更新的 setData 回调里还会补一次 _refresh（GET），
  //    在流程里跑（机器更忙）时这笔 GET 会晚于本断言的取样点，被误算成"多发的请求"。
  await tick5()
  await tick5()
  inst._submitting = true
  const logBefore2 = REQLOG.filter((r) => /\/status$/.test(r.url)).length
  inst.onCall({ currentTarget: { dataset: { id: 'apt2' } } })
  await tick5()
  const statusAfter2 = REQLOG.filter((r) => /\/status$/.test(r.url)).length
  check('DOC-C7 _submitting 期间忽略重复点击（不发状态流转请求）', statusAfter2 === logBefore2,
    '实多发了 ' + (statusAfter2 - logBefore2) + ' 个状态流转请求')
  inst._submitting = false

  // 409 版本冲突 → 回滚到原态
  APPT_STATUS_MODE = 'conflict409'
  const apt2 = (inst.data.all || []).find((r) => r.id === 'apt2')
  const apt2StatusBefore = apt2 && apt2.rawStatus
  inst.onFinish({ currentTarget: { dataset: { id: 'apt2' } } })
  await tick5()
  await tick5()
  await tick5()
  const apt2After = (inst.data.all || []).find((r) => r.id === 'apt2')
  // apt2 是 CONFIRMED → canFinish=false，不会发请求。改用 apt3(CONFIRMED) 走叫号路径触发 409
  const apt3 = (inst.data.all || []).find((r) => r.id === 'apt3')
  const apt3Before = apt3 && apt3.rawStatus
  inst.onCall({ currentTarget: { dataset: { id: 'apt3' } } })
  await tick5(); await tick5(); await tick5()
  const apt3After = (inst.data.all || []).find((r) => r.id === 'apt3')
  check('DOC-C8 409 版本冲突后行状态回滚（不残留错误态）', apt3After && apt3After.rawStatus === apt3Before,
    '实得 before=' + apt3Before + ' after=' + (apt3After && apt3After.rawStatus))
  APPT_STATUS_MODE = 'ok'
}

// ==================== D. 结束问诊闭环 ====================
async function testConsultClose() {
  appStub.globalData.role = 'doctor'
  const cfg = loadPage('pages/doctor/consult/consult.js')

  function freshInst() {
    const inst = instantiate(cfg)
    inst._gone = false
    inst.setData({
      active: { id: 'c1', patientName: '患者', initial: '者', title: '在线问诊', assigned: true, accepting: true, status: 'ACTIVE' },
      closing: false
    })
    return inst
  }

  // D1 成功闭环
  CLOSE_MODE = 'ok'
  let inst = freshInst()
  let logBefore = REQLOG.length
  modalCalls = 0
  inst.onCloseConsult()
  await tick5(); await tick5()
  const closeReq = REQLOG.slice(logBefore).find((r) => /\/close$/.test(r.url))
  check('DOC-D1 二次确认后触发 POST /close', modalCalls >= 1 && !!closeReq, 'modal=' + modalCalls + ' closeReq=' + !!closeReq)
  if (closeReq) {
    check('DOC-D2 /close 带 Idempotency-Key 头', !!closeReq.header && !!closeReq.header['Idempotency-Key'])
  }
  check('DOC-D3 结束成功→active.status=CLOSED 且锁输入(canSend=false)',
    inst.data.active.status === 'CLOSED' && inst.data.canSend === false,
    '实得 status=' + inst.data.active.status)

  // D2 已结束（409）→ 按已结束处理
  CLOSE_MODE = 'closed409'
  inst = freshInst()
  logBefore = REQLOG.length
  inst.onCloseConsult()
  await tick5(); await tick5()
  check('DOC-D4 409（已被结束）→ 本地收口为 CLOSED，不报错卡死',
    inst.data.active.status === 'CLOSED', '实得 status=' + inst.data.active.status)

  // D3 非本人（404）→ 不收口，保留 ACTIVE
  CLOSE_MODE = 'notmine404'
  inst = freshInst()
  inst.onCloseConsult()
  await tick5(); await tick5()
  check('DOC-D5 404（非本人/未接诊）→ 不收口，status 保持 ACTIVE',
    inst.data.active.status === 'ACTIVE' && inst.data.closing === false,
    '实得 status=' + inst.data.active.status + ' closing=' + inst.data.closing)

  // D4 closing 防重
  CLOSE_MODE = 'ok'
  inst = freshInst()
  inst.data.closing = true
  modalCalls = 0
  logBefore = REQLOG.length
  inst.onCloseConsult()
  await tick5()
  check('DOC-D6 closing=true 时不再弹确认/不再发 close 请求', modalCalls === 0 && REQLOG.length === logBefore,
    'modal=' + modalCalls + ' req+' + (REQLOG.length - logBefore))
  CLOSE_MODE = 'ok'
}

// ==================== 运行 ====================
;(async function main() {
  await (async () => { try { await testApptFlow() } catch (e) { check('DOC-C 挂号流转用例抛异常: ' + e.message, false) } })()
  await (async () => { try { await testConsultClose() } catch (e) { check('DOC-D 结束问诊用例抛异常: ' + e.message, false) } })()

  console.log('===== test-doctor-pages-audit.js =====')
  console.log('PASS=' + PASS + '  FAIL=' + FAIL)
  if (FAIL) {
    console.log('失败明细：')
    fails.forEach((f) => console.log(f))
  }
  process.exit(FAIL ? 1 : 0)
})()
