/**
 * test-patient-flows-audit.js —— 分片B「患者端 TabBar 与主流程」离线单测（只读审查配套）
 *
 * 打桩 wx / getApp / Page / storage，node 直接运行，覆盖：
 *   ① services/triage.js answerNav() 路线应答判定（否定先判："不要"不能误跳导航）
 *   ② 首页 _route() 四宫格 / 8 宫格跳转映射 + triage ?text= 深链 encodeURIComponent
 *   ③ consultation 消息追加：messages[i] 增量 setData 路径 + 60 条上限裁剪
 *   ④ consultation / triage 发送中防重复提交（status=THINKING 时拒绝再发）
 *   ⑤ appointment 状态机流转（goStep）+ onSubmit 防重复提交 + 缺号源校验
 *
 * 用法：node tools/test-patient-flows-audit.js
 * 说明：本脚本只读页面定义对象做行为驱动，不修改任何源码。
 *      导诊引擎本身已有 tools/test-triage.js（322 项）覆盖，此处不重复。
 */
const path = require('path')
const ROOT = path.join(__dirname, '..', 'miniprogram')

/* ==================== 全局打桩（必须在 require 页面模块之前） ==================== */
const storage = {}
const navCalls = []   // {method, url}
const toastCalls = []
let pageLoadError = null

global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v },
  removeStorageSync: (k) => { delete storage[k] },
  navigateTo: (o) => { navCalls.push({ method: 'navigateTo', url: o.url }) },
  redirectTo: (o) => { navCalls.push({ method: 'redirectTo', url: o.url }) },
  switchTab: (o) => { navCalls.push({ method: 'switchTab', url: o.url }) },
  reLaunch: (o) => { navCalls.push({ method: 'reLaunch', url: o.url }) },
  showToast: (o) => { toastCalls.push(o.title) },
  showModal: (o) => { toastCalls.push('[modal]' + o.title) },
  showActionSheet: (o) => { /* 默认取消：不回调 success，等价于用户放弃 */ },
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 667 }),
  getMenuButtonBoundingClientRect: () => ({ width: 32, left: 320 }),
  makePhoneCall: () => {},
  vibrateShort: () => {},
  stopRecord: () => {},
  startRecord: () => {},
  stopSpeak: () => {},
  hideKeyboard: () => {}
}

global.getApp = () => ({
  globalData: { role: 'patient', theme: 'standard', user: { name: '张三', phone: '13800001111' } },
  MOCK: {
    HOME: { greeting: '早上好', appointment: { dept: '呼吸内科', doctor: '王医生' } },
    PATIENT: { name: '张三' },
    DEPARTMENTS: [],
    TIME_SLOTS: []
  },
  logout: () => {}
})

let lastPage = null
global.Page = (def) => { lastPage = def }

/* ==================== 结果统计 ==================== */
let pass = 0
let fail = 0
let skip = 0
const failures = []

function check(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  failures.push(name + (extra ? '  →  ' + extra : ''))
}

function section(title) { console.log('\n— ' + title + ' —') }

/** 用页面定义对象造一个可驱动的运行时上下文（setData 支持 messages[i] / messages[i].字段） */
function makeCtx(def) {
  const ctx = Object.assign({}, def)
  ctx.data = JSON.parse(JSON.stringify(def.data || {}))
  ctx._patches = []
  ctx.setData = function (patch, cb) {
    ctx._patches.push(Object.keys(patch))
    for (const k of Object.keys(patch)) {
      const m = k.match(/^messages\[(\d+)\](?:\.(.+))?$/)
      if (m) {
        const i = Number(m[1])
        if (!Array.isArray(ctx.data.messages)) ctx.data.messages = []
        if (m[2]) {
          if (!ctx.data.messages[i]) ctx.data.messages[i] = {}
          ctx.data.messages[i][m[2]] = patch[k]
        } else {
          ctx.data.messages[i] = patch[k]
        }
      } else {
        ctx.data[k] = patch[k]
      }
    }
    if (typeof cb === 'function') cb()
  }
  return ctx
}

/* ==================== 加载被测模块 ==================== */
section('模块加载')
let triageService = null
try {
  triageService = require(path.join(ROOT, 'services', 'triage.js'))
  check('加载 services/triage.js', typeof triageService.answerNav === 'function')
} catch (e) {
  pageLoadError = e
  check('加载 services/triage.js', false, e.message)
}

function loadPage(label, ...relParts) {
  try {
    lastPage = null
    require(path.join(ROOT, ...relParts))
    check('加载 ' + label, !!lastPage)
    return lastPage
  } catch (e) {
    check('加载 ' + label, false, e.message)
    return null
  }
}

const homeDef = loadPage('pages/home/home', 'pages', 'home', 'home.js')
const consultDef = loadPage('pages/consultation/consultation', 'pages', 'consultation', 'consultation.js')
const triageDef = loadPage('pages/triage/triage', 'pages', 'triage', 'triage.js')
const appointDef = loadPage('pages/appointment/appointment', 'pages', 'appointment', 'appointment.js')

/* ==================== ① answerNav 路线应答判定 ==================== */
if (triageService && triageService.answerNav) {
  section('① answerNav 路线应答词（否定先判："不要"不能误跳导航）')
  const cases = [
    ['不要', 'no'], ['不用了', 'no'], ['别', 'no'], ['不去了', 'no'],
    ['要', 'yes'], ['是', 'yes'], ['好', 'yes'], ['嗯', 'yes'], ['好的', 'yes'],
    ['', ''],
    ['我今天早上起来肚子很疼已经三天了', '']   // 长症状 → 不是应答，按新症状处理
  ]
  cases.forEach(([t, want]) => {
    check('answerNav("' + (t || '∅') + '") === "' + want + '"',
      triageService.answerNav(t) === want, 'got="' + triageService.answerNav(t) + '"')
  })
  // 核心红线回归："不要"含"要"，必须先否定
  check('核心："不要"不被误判成 yes', triageService.answerNav('不要') === 'no')
}

/* ==================== ② 首页 _route() 跳转映射 ==================== */
if (homeDef) {
  section('② 首页 _route() 跳转映射与 ?text= 深链')
  const ctx = makeCtx(homeDef)
  function navTo(method, url) {
    return navCalls.filter((c) => c.method === method && c.url === url).length
  }
  function expectUrl(method, url, name) {
    check(name, navTo(method, url) >= 1,
      'expected ' + method + ' ' + url + '; actual=' + JSON.stringify(navCalls.slice(-3)))
  }

  navCalls.length = 0
  ctx._route('triage')
  expectUrl('navigateTo', '/pages/triage/triage', '四宫格-导诊 → navigateTo triage（无参）')

  navCalls.length = 0
  ctx._route('triage', '咳嗽')
  check('快选词-深链 triage?text= encodeURIComponent',
    navCalls.some((c) => c.method === 'navigateTo' && c.url === '/pages/triage/triage?text=' + encodeURIComponent('咳嗽')),
    'actual=' + JSON.stringify(navCalls))

  navCalls.length = 0
  ctx._route('appoint')
  expectUrl('switchTab', '/pages/appointment/appointment', '四宫格-预约挂号 → switchTab appointment（tabBar 页不能 navigateTo）')

  navCalls.length = 0
  ctx._route('doctor')
  expectUrl('switchTab', '/pages/appointment/appointment', '8宫格-找医生 → switchTab appointment')

  navCalls.length = 0
  ctx._route('health')
  expectUrl('navigateTo', '/pages/health/health', '更多服务-AI养生 → navigateTo health')

  navCalls.length = 0
  ctx._route('consult')
  expectUrl('navigateTo', '/pages/consult/picker/picker', '四宫格-在线问诊 → picker 选医生')

  navCalls.length = 0
  ctx._route('advice')
  expectUrl('navigateTo', '/pages/consult/picker/picker', '8宫格-健康咨询 → picker')

  navCalls.length = 0
  ctx._route('reports')
  expectUrl('navigateTo', '/pages/profile/health-records/health-records', '四宫格-报告查询 → health-records')

  navCalls.length = 0
  ctx._route('archive')
  // 修复后（P2-04）：与「报告查询」同落点，直达健康档案页，不再绕「我的」Tab
  check('8宫格-健康档案 → navigateTo health-records（P2-04 已修）',
    navTo('navigateTo', '/pages/profile/health-records/health-records') === 1
      && navTo('switchTab', '/pages/profile/profile') === 0,
    'actual=' + JSON.stringify(navCalls))

  navCalls.length = 0
  ctx._route('nav')
  expectUrl('navigateTo', '/packageNav/pages/nav/nav', '侧栏-院内导航 → nav 分包页')

  navCalls.length = 0
  ctx._route('knowledge')
  expectUrl('navigateTo', '/packageContent/pages/knowledge/knowledge', '侧栏-全部健康科普 → knowledge 分包页')

  navCalls.length = 0
  toastCalls.length = 0
  ctx._route('checkup')
  // 修复后（P1-03）：NOT_READY 接线，点击弹中文说明（不做假跳转、不静默）
  check('8宫格-体检服务：弹「体检服务」中文说明（P1-03 已修）',
    navCalls.length === 0 && toastCalls.indexOf('[modal]体检服务') >= 0,
    'actual=' + JSON.stringify(navCalls) + ' toast=' + JSON.stringify(toastCalls))

  navCalls.length = 0
  toastCalls.length = 0
  ctx._route('care')
  check('8宫格-居家护理：弹「居家护理」中文说明（P1-03 已修）',
    navCalls.length === 0 && toastCalls.indexOf('[modal]居家护理') >= 0,
    'actual=' + JSON.stringify(navCalls) + ' toast=' + JSON.stringify(toastCalls))

  // P2-07：汇总失败态 —— 生产档必须能与"真的没挂号"区分（中文错误 + 重试入口标记）
  const ENV = require(path.join(ROOT, 'config', 'env.js'))
  const prevFallback = ENV.MOCK_FALLBACK
  ENV.MOCK_FALLBACK = false
  ctx._applySummaryFailed()
  check('首页汇总失败（生产档）：aptError 为中文且非空',
    !!ctx.data.aptError && !/^[\x00-\x7F]*$/.test(ctx.data.aptError), '实得 ' + JSON.stringify(ctx.data.aptError))
  check('首页汇总失败（生产档）：aptLoading 复位 false（不停在骨架）', ctx.data.aptLoading === false)
  check('首页汇总失败（生产档）：hasApt=false 且不塞演示预约', ctx.data.hasApt === false)
  ENV.MOCK_FALLBACK = prevFallback
}

/* ==================== ③ consultation 消息追加 / 60 条裁剪 ==================== */
if (consultDef) {
  section('③ consultation _appendMsg：增量 setData 路径 + 60 条裁剪')
  const ctx = makeCtx(consultDef)
  ctx._MSG_CAP = 60   // onLoad 里才赋值，本测试不走 onLoad，手动补齐
  ctx.data.messages = []
  ctx.data.msgId = 0

  ctx._appendMsg({ id: 1, role: 'user', content: 'a', time: '10:00' })
  check('首条追加：走 messages[0] 数据路径（非整数组 setData）',
    ctx._patches[0].indexOf('messages[0]') >= 0 && ctx._patches[0].indexOf('messages') < 0,
    JSON.stringify(ctx._patches[0]))
  check('首条追加后 messages.length === 1', ctx.data.messages.length === 1,
    'len=' + ctx.data.messages.length)

  // 灌满 60 条
  for (let i = 2; i <= 60; i++) {
    ctx._appendMsg({ id: i, role: 'ai', content: 'm' + i, time: '10:00' })
  }
  check('灌满 60 条后 length === 60', ctx.data.messages.length === 60,
    'len=' + ctx.data.messages.length)
  // 第 61 条 → 触发整体裁剪，仍为 60
  ctx._appendMsg({ id: 61, role: 'user', content: 'last', time: '10:00' })
  check('第 61 条后裁剪至 60 条上限', ctx.data.messages.length === 60,
    'len=' + ctx.data.messages.length)
  check('裁剪后保留最新一条（id=61 在列）',
    ctx.data.messages[ctx.data.messages.length - 1].id === 61,
    'last.id=' + ctx.data.messages[ctx.data.messages.length - 1].id)

  section('④ consultation 发送中防重复提交')
  const c2 = makeCtx(consultDef)
  c2.data.messages = [{ id: 1, role: 'ai', content: '欢迎', time: '10:00' }]
  c2.data.msgId = 1
  c2.data.status = 'THINKING'
  c2._remoteAllowed = true
  const beforeLen = c2.data.messages.length
  c2.send('咳嗽头疼')
  check('status=THINKING 时 send() 被拒绝（不追加用户消息）',
    c2.data.messages.length === beforeLen, 'len=' + c2.data.messages.length)
}

/* ==================== ④b triage 页发送中防重复 ==================== */
if (triageDef) {
  section('④b triage 页发送中防重复提交')
  const t2 = makeCtx(triageDef)
  t2.data.messages = [{ id: 1, role: 'ai', content: '欢迎', time: '10:00' }]
  t2.data.msgId = 1
  t2.data.status = 'THINKING'
  t2._remoteAllowed = true
  const beforeLen = t2.data.messages.length
  t2.send('胸口压榨样疼')
  check('triage status=THINKING 时 send() 被拒绝',
    t2.data.messages.length === beforeLen, 'len=' + t2.data.messages.length)
}

/* ==================== ⑤ appointment 状态机与防重复提交 ==================== */
if (appointDef) {
  section('⑤ appointment 状态机流转 + 防重复提交')
  const a1 = makeCtx(appointDef)
  a1.goStep('doctor', 1)
  check('goStep("doctor",1) 状态机推进',
    a1.data.step === 'doctor' && a1.data.stepIndex === 1,
    'step=' + a1.data.step + '/' + a1.data.stepIndex)
  a1.goStep('time', 2)
  check('goStep("time",2) 继续推进',
    a1.data.step === 'time' && a1.data.stepIndex === 2,
    'step=' + a1.data.step + '/' + a1.data.stepIndex)

  // 防重复：submitting=true 时 onSubmit 必须立刻返回、零副作用
  const a2 = makeCtx(appointDef)
  a2.data.submitting = true
  a2.data.selSlotId = 'slot-1'
  a2.data.patient = { name: '张三' }
  toastCalls.length = 0
  const snap = JSON.parse(JSON.stringify(a2.data))
  a2.onSubmit()
  check('submitting=true 时 onSubmit 零副作用（防重复提交）',
    a2.data.submitting === true && toastCalls.length === 0 &&
    JSON.stringify(a2.data) === JSON.stringify(snap),
    'toasts=' + JSON.stringify(toastCalls))

  // 缺号源校验：未选 slot 给出中文提示
  const a3 = makeCtx(appointDef)
  a3.data.submitting = false
  a3.data.selSlotId = ''
  a3.data.patient = { name: '张三' }
  toastCalls.length = 0
  a3.onSubmit()
  check('未选号源 onSubmit → 中文 toast 拦截',
    toastCalls.length === 1 && toastCalls[0].indexOf('日期和时间') >= 0,
    'toasts=' + JSON.stringify(toastCalls))
}

/* ==================== 汇总 ==================== */
console.log('\n==================== 结果 ====================')
console.log('PASS: ' + pass)
console.log('FAIL: ' + fail)
if (failures.length) {
  console.log('\n失败明细：')
  failures.forEach((f) => console.log('  ✗ ' + f))
}
if (pageLoadError) console.log('（模块加载异常：' + pageLoadError.message + '）')
process.exit(fail ? 1 : 0)
