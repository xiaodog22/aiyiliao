#!/usr/bin/env node
/**
 * tools/test-submission-actions.js —— 「提交完成后操作入口」离线单测
 *
 * 覆盖：展示条件、状态转移、状态校验、幂等（重复触发）、并发/脏状态、
 *       目标缺失、导航在途连点、宿主禁用，以及组件层与状态机层的一致性。
 * 不依赖微信运行时：用最小桩加载 Component，断言真实组件方法的行为。
 *
 * 运行：node tools/test-submission-actions.js
 */
'use strict'
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
const A = require(path.join(ROOT, 'utils', 'submission-actions.js'))
const { STATUS, REASON } = A

let PASS = 0
let FAIL = 0
function check(name, ok, note) {
  if (ok) { PASS++ } else { FAIL++; console.log('  ✗ ' + name + (note ? '  → ' + note : '')) }
}

const S = (status, over) => Object.assign({ status, submissionId: 'sub-1', assessPath: '/pages/assess/index' }, over || {})

// ==================== ① 展示条件 ====================
check('展示-DRAFT 不开放', A.canShowActions(S(STATUS.DRAFT)) === false)
check('展示-SUBMITTING 不开放', A.canShowActions(S(STATUS.SUBMITTING, { submitting: true })) === false)
check('展示-SUBMITTED 开放', A.canShowActions(S(STATUS.SUBMITTED)) === true)
check('展示-PASSED 仍开放', A.canShowActions(S(STATUS.PASSED)) === true)
check('展示-提交中但状态已 SUBMITTED（脏/并发）不开放',
  A.canShowActions(S(STATUS.SUBMITTED, { submitting: true })) === false)
check('展示-未知状态归 DRAFT 不开放',
  A.canShowActions(S('WAT')) === false && A.normalize(S('WAT')).status === STATUS.DRAFT)
check('展示-null / undefined 不开放且不抛',
  A.canShowActions(null) === false && A.canShowActions(undefined) === false)
check('展示-非对象输入不抛', A.canShowActions('SUBMITTED') === false && A.canShowActions(7) === false)

// ==================== ② 状态转移（守卫 + 显式 reopen） ====================
const s1 = A.beginSubmit(S(STATUS.DRAFT))
check('转移-beginSubmit → SUBMITTING 且 submitting=true',
  s1.ok === true && s1.state.status === STATUS.SUBMITTING && s1.state.submitting === true)
const s2 = A.succeedSubmit(s1.state, 'sub-9')
check('转移-succeedSubmit → SUBMITTED 且带 submissionId',
  s2.ok === true && s2.state.status === STATUS.SUBMITTED &&
  s2.state.submitting === false && s2.state.submissionId === 'sub-9')
const s3 = A.failSubmit(s1.state)
check('转移-failSubmit → 回 DRAFT 且清 submitting',
  s3.ok === true && s3.state.status === STATUS.DRAFT && s3.state.submitting === false)
check('转移-reset → DRAFT', A.reset().status === STATUS.DRAFT)
check('转移-完整链路完成后才开放',
  !A.canShowActions(s1.state) && A.canShowActions(s2.state) && !A.canShowActions(s3.state))

const done = A.markPassed(s2.state).state
const bad1 = A.beginSubmit(done)
check('守卫-已 PASSED 不允许 beginSubmit：返回原 state + ILLEGAL_TRANSITION',
  bad1.ok === false && bad1.changed === false &&
  bad1.reason === REASON.ILLEGAL_TRANSITION && bad1.state === done)
const fresh = A.reset()
const bad2 = A.succeedSubmit(fresh, 'x')
const bad3 = A.failSubmit(fresh)
check('守卫-DRAFT 不能跳步 succeedSubmit / failSubmit：均返回原 state',
  bad2.ok === false && bad3.ok === false &&
  bad2.reason === REASON.ILLEGAL_TRANSITION && bad3.reason === REASON.ILLEGAL_TRANSITION &&
  bad2.state === fresh && bad3.state === fresh)
const re = A.reopen(done)
check('显式 reopen：PASSED → DRAFT、清 passedAt，且不改写原 state',
  re.ok === true && re.state.status === STATUS.DRAFT && re.state.passedAt === 0 &&
  done.status === STATUS.PASSED && A.canShowActions(done) === true)
const reBad = A.reopen(fresh)
check('守卫-DRAFT 不能 reopen', reBad.ok === false && reBad.state === fresh)

// ==================== ③ 通过（幂等） ====================
const p1 = A.markPassed(S(STATUS.SUBMITTED))
check('通过-首次：ok/changed/PASSED/passedAt',
  p1.ok === true && p1.changed === true && p1.state.status === STATUS.PASSED && p1.state.passedAt > 0)
const p2 = A.markPassed(p1.state)
check('通过-重复触发：保持同一状态对象引用且 changed=false',
  p2.ok === true && p2.changed === false && p2.reason === REASON.ALREADY_PASSED && p2.state === p1.state)
check('通过-重复触发不改写 passedAt', p2.state.passedAt === p1.state.passedAt)
const p3 = A.markPassed(S(STATUS.DRAFT))
check('通过-未完成被拒：NOT_READY 且状态不变',
  p3.ok === false && p3.changed === false && p3.reason === REASON.NOT_READY && p3.state.status === STATUS.DRAFT)
check('通过-提交中脏态被拒', A.markPassed(S(STATUS.SUBMITTED, { submitting: true })).ok === false)
check('通过-未知状态被拒且不抛', A.markPassed(S('WAT')).ok === false)
check('通过-isPassed 与 normalize 一致',
  A.isPassed(p1.state) === true && A.isPassed(S(STATUS.SUBMITTED)) === false)

// ==================== ④ 去评定项目 ====================
const t1 = A.assessTarget(S(STATUS.SUBMITTED, { assessPath: '/pages/assess/index' }))
check('评定-完成态返回目标', t1.ok === true && t1.target === '/pages/assess/index')
const t2 = A.assessTarget(S(STATUS.SUBMITTED, { assessPath: '/pages/assess/index' }))
check('评定-重复触发结果一致', t2.ok === t1.ok && t2.target === t1.target && t2.reason === t1.reason)
check('评定-未完成被拒', A.assessTarget(S(STATUS.DRAFT)).reason === REASON.NOT_READY)
check('评定-未配置入口被拒且无目标',
  A.assessTarget(S(STATUS.SUBMITTED, { assessPath: '' })).reason === REASON.NO_TARGET &&
  A.assessTarget(S(STATUS.SUBMITTED, { assessPath: '' })).target === '')
check('评定-通过后仍可进入', A.assessTarget(S(STATUS.PASSED)).ok === true)
check('评定-脏态被拒', A.assessTarget(S(STATUS.SUBMITTED, { submitting: true })).ok === false)

// ==================== ⑤ 归一化边界 ====================
const n = A.normalize({ status: 'WAT', submissionId: 42, submitting: 'yes', passedAt: 'x', assessPath: 9 })
check('归一化-非法字段全部收敛',
  n.status === STATUS.DRAFT && n.submissionId === '' && n.submitting === true && n.passedAt === 0 && n.assessPath === '')

// ==================== ⑥ 组件层（真实方法 + 最小运行时桩） ====================
let captured = null
const toasts = []
const navs = []
let autoComplete = true
let throwOnNavigate = false  // 模拟 wx.navigateTo 同步抛错（此时 fail / complete 都不会触发）
global.Component = (cfg) => { captured = cfg }
global.wx = {
  showToast(o) { toasts.push(o) },
  navigateTo(o) {
    navs.push(o)
    if (throwOnNavigate) throw new Error('invalid url')
    if (autoComplete && o.complete) o.complete()
  }
}
require(path.join(ROOT, 'components', 'submission-actions', 'submission-actions.js'))

const DEFAULTS = {
  status: STATUS.DRAFT, submissionId: 'sub-1', submitting: false,
  assessPath: '/pages/assess/index', disabled: false
}

// 真实 Component 的 observers 只监听 properties；setData 改纯 data 字段不触发。
// 2026-11-10 事故：旧桩的 setData 完全不重放 observers，于是「宿主刷新无关属性 →
// _sync 把已通过态刷回 → 重复发 pass」这条真机竞态在 42 项全绿时无人发现。
const OBSERVED = ['status', 'submissionId', 'submitting', 'assessPath', 'disabled']
function replayObservers(inst) {
  Object.keys(captured.observers || {}).forEach((k) => captured.observers[k].call(inst))
}
/** 模拟宿主经 WXML 下发新的 properties（唯一能触发 observers 的路径） */
function propsChange(inst, patch) {
  Object.assign(inst.data, patch)
  replayObservers(inst)
}

function makeInst(over) {
  const events = []
  const inst = {
    data: Object.assign({}, captured.data, DEFAULTS, over || {}),
    setData(o) {
      Object.assign(this.data, o)
      if (Object.keys(o).some((k) => OBSERVED.indexOf(k) >= 0)) replayObservers(this)
    },
    triggerEvent(name, detail) { events.push({ name, detail }) },
    _state: captured.methods._state,
    _sync: captured.methods._sync,
    onPass: captured.methods.onPass,
    onAssess: captured.methods.onAssess,
    rollbackPass: captured.methods.rollbackPass,
    events
  }
  inst._sync()
  return inst
}

const c1 = makeInst({ status: STATUS.DRAFT })
check('组件-未完成不渲染入口', c1.data.showActions === false)
// 旧版把 onPass + onAssess 组合起来只断言「共 1 条提示」，恰好由 onAssess 满足，
// 掩盖了 onPass 静默吞错。拆成两条独立断言，各自验一个方法。
toasts.length = 0; navs.length = 0
c1.onPass()
check('组件-未完成 onPass：不发 pass 且给出中文拒绝提示（不静默吞掉）',
  c1.events.length === 0 && toasts.length === 1 && /提交完成后/.test(toasts[0].title))
toasts.length = 0
c1.onAssess()
check('组件-未完成 onAssess：不跳转且给出中文拒绝提示',
  navs.length === 0 && toasts.length === 1 && /提交完成后/.test(toasts[0].title))

const c2 = makeInst({ status: STATUS.SUBMITTED })
check('组件-完成态渲染入口', c2.data.showActions === true && c2.data.passed === false)
c2.onPass()
check('组件-点击通过：只发一次 pass 且切为已通过',
  c2.events.length === 1 && c2.events[0].name === 'pass' &&
  c2.events[0].detail.submissionId === 'sub-1' && c2.data.passed === true)
c2.onPass()
check('组件-重复点击通过：不重复通知、状态不变',
  c2.events.length === 1 && c2.data.passed === true)

const c3 = makeInst({ status: STATUS.PASSED })
check('组件-宿主下发 PASSED → 直接显示已通过', c3.data.passed === true)
c3.onPass()
check('组件-已通过再点无事件', c3.events.length === 0)

toasts.length = 0; navs.length = 0
const c4 = makeInst({ status: STATUS.SUBMITTED })
c4.onAssess()
check('组件-点击去评定：跳到注入的目标且只跳一次',
  navs.length === 1 && navs[0].url === '/pages/assess/index' && c4.data.navigating === false)

// 旧版名为「重复点击」却只调用一次 onAssess，navs.length===1 恒真 —— 无效断言。
// 改为在途真连点（complete 未触发），才真正验证 navigating 锁；锁释放后的行为由 c6 覆盖。
autoComplete = false
const c5 = makeInst({ status: STATUS.SUBMITTED })
toasts.length = 0; navs.length = 0
c5.onAssess(); c5.onAssess()
check('组件-导航在途真连点：只发起一次 navigateTo', navs.length === 1 && c5.data.navigating === true)
check('组件-在途连点被锁拦下时不重复提示', toasts.length === 0)
if (navs[0] && navs[0].complete) navs[0].complete()
autoComplete = true

autoComplete = false
const c6 = makeInst({ status: STATUS.SUBMITTED })
navs.length = 0
c6.onAssess(); c6.onAssess()
check('组件-导航在途连点：只发起一次 navigateTo', navs.length === 1 && c6.data.navigating === true)
navs[0].complete()
check('组件-导航 complete 后释放锁', c6.data.navigating === false)
autoComplete = true

const c7 = makeInst({ status: STATUS.SUBMITTED, assessPath: '' })
toasts.length = 0; navs.length = 0
c7.onAssess()
check('组件-未配置入口：中文提示且不跳转',
  navs.length === 0 && toasts.length === 1 && /配置/.test(toasts[0].title))

const c8 = makeInst({ status: STATUS.SUBMITTED, disabled: true })
toasts.length = 0; navs.length = 0
c8.onPass(); c8.onAssess()
check('组件-宿主 disabled：点击全部被拦',
  c8.events.length === 0 && navs.length === 0 && toasts.length === 0)

const c9 = makeInst({ status: STATUS.SUBMITTED, submitting: true })
check('组件-提交中 locked 且入口不开放', c9.data.locked === true && c9.data.showActions === false)

// ==================== ⑦ 真机竞态回归：属性变化后重放 observers（M1） ====================
toasts.length = 0; navs.length = 0
const cR = makeInst({ status: STATUS.SUBMITTED })
cR.onPass()
check('竞态-首次通过：1 次 pass、进入待裁决',
  cR.events.length === 1 && cR.data.passPending === true)
propsChange(cR, { assessPath: '/pages/assess/index?src=host' })
check('竞态-无关属性刷新：已通过态不回退、pending 仍在、入口仍开',
  cR.data.passed === true && cR.data.passPending === true && cR.data.showActions === true)
cR.onPass()
check('竞态-属性刷新后重复点击：不再发 pass', cR.events.length === 1)
propsChange(cR, { status: STATUS.PASSED })
check('竞态-宿主确认 PASSED：清 pending、保持已通过',
  cR.data.passPending === false && cR.data.passed === true)
check('竞态-终态下显式回滚无效（无副作用）',
  cR.rollbackPass() === false && cR.data.passed === true && cR.events.length === 1)

const cRb = makeInst({ status: STATUS.SUBMITTED })
cRb.onPass()
propsChange(cRb, { assessPath: '/pages/assess/index?src=host' })
check('回滚-显式 rollbackPass 生效并回到可重试态',
  cRb.rollbackPass() === true && cRb.data.passed === false &&
  cRb.data.passPending === false && cRb.data.showActions === true)
cRb.onPass()
check('回滚-重试可再发 1 次 pass（不累计旧事件）', cRb.events.length === 2)

const cRv = makeInst({ status: STATUS.SUBMITTED })
cRv.onPass()
propsChange(cRv, { status: STATUS.DRAFT })
check('边界-宿主撤回提交：入口关闭且本地乐观态清空',
  cRv.data.showActions === false && cRv.data.passed === false && cRv.data.passPending === false)

// 边界：navigateTo 同步抛错时 fail / complete 都不触发，旧实现会把 navigating 永久锁死
throwOnNavigate = true
toasts.length = 0; navs.length = 0
const cSync = makeInst({ status: STATUS.SUBMITTED })
cSync.onAssess()
check('边界-navigateTo 同步抛错：释放锁并给中文提示（不静默吞错）',
  cSync.data.navigating === false && toasts.length === 1 && /暂无法打开/.test(toasts[0].title))
throwOnNavigate = false

console.log('--------------------------------')
console.log('== test-submission-actions == 通过 ' + PASS + ' / 共 ' + (PASS + FAIL))
console.log(FAIL === 0 ? 'RESULT: SUBMISSION_ACTIONS_OK' : 'RESULT: SUBMISSION_ACTIONS_FAIL')
process.exit(FAIL > 0 ? 1 : 0)
