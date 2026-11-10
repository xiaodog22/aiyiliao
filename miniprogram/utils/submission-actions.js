/**
 * utils/submission-actions —— 「提交完成后的操作入口」唯一状态真源（纯函数，无 wx 依赖）
 *
 * 为什么单独成模块：展示条件、状态校验、幂等要同时被组件、宿主页面和离线测试消费。
 * 若把判断散在 WXML 的 wx:if 和点击 handler 里，重复触发/并发/脏状态必然各判各的。
 *
 * 状态机：DRAFT → SUBMITTING → SUBMITTED → PASSED（失败回 DRAFT，reset 回 DRAFT）。
 * 2026-11-10：三个转移一律校验来源状态，非法转移返回原 state + ILLEGAL_TRANSITION；
 * 需要「重新提交」时显式调 reopen()，不再靠 beginSubmit 隐式允许逆向/跳步。
 * 只有 SUBMITTED / PASSED 且 submitting=false 时才开放「通过」「去评定项目」。
 *
 * ⚠️ 本模块不写任何后端地址、不落库、不跳页：审批落库由宿主页面通过 services/ 契约完成，
 *    评定目标路由由宿主以 assessPath 传入（仓库当前没有该页面，禁止伪造路由）。
 */
'use strict'

const STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTING: 'SUBMITTING',
  SUBMITTED: 'SUBMITTED',
  PASSED: 'PASSED'
})

const REASON = Object.freeze({
  OK: 'OK',
  NOT_READY: 'NOT_READY',       // 提交未完成 / 正在提交（未知状态归一化后也归此类）
  ALREADY_PASSED: 'ALREADY_PASSED',
  NO_TARGET: 'NO_TARGET',       // 未配置评定入口
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION'  // 转移来源状态不合法（含逆向 / 跳步）
})

/**
 * 归一化：任何脏输入都退化成 DRAFT，绝不抛异常、绝不把未知状态当成完成态。
 * 已是规范形态的对象直接返回**原引用** —— markPassed 的幂等分支依赖这一点保持
 * 「重复触发时状态完全一致」，否则每次都会造出一个语义相同的新对象。
 */
function normalize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  if (Object.prototype.hasOwnProperty.call(STATUS, s.status) &&
      typeof s.submissionId === 'string' &&
      typeof s.submitting === 'boolean' &&
      typeof s.passedAt === 'number' && isFinite(s.passedAt) &&
      typeof s.assessPath === 'string') {
    return s
  }
  return {
    status: Object.prototype.hasOwnProperty.call(STATUS, s.status) ? s.status : STATUS.DRAFT,
    submissionId: typeof s.submissionId === 'string' ? s.submissionId : '',
    submitting: !!s.submitting,
    passedAt: Number(s.passedAt) || 0,
    assessPath: typeof s.assessPath === 'string' ? s.assessPath : ''
  }
}

/** 展示条件：提交完成（SUBMITTED/PASSED）且不在提交中，才开放两个入口 */
function canShowActions(raw) {
  const s = normalize(raw)
  return !s.submitting && (s.status === STATUS.SUBMITTED || s.status === STATUS.PASSED)
}

function isPassed(raw) {
  return normalize(raw).status === STATUS.PASSED
}

// ---------------- 状态转移 ----------------
// 与 markPassed 对齐的返回形状：{ state, ok, changed, reason }。
// 非法转移返回 normalize 后的**原 state 引用** + reason，绝不隐式允许逆向 / 跳步。
function illegal(s) {
  return { state: s, ok: false, changed: false, reason: REASON.ILLEGAL_TRANSITION }
}
function moved(s, patch) {
  return { state: Object.assign({}, s, patch), ok: true, changed: true, reason: REASON.OK }
}

/** 仅 DRAFT 可开始提交 */
function beginSubmit(raw) {
  const s = normalize(raw)
  if (s.status !== STATUS.DRAFT) return illegal(s)
  return moved(s, { status: STATUS.SUBMITTING, submitting: true })
}
/** 仅 SUBMITTING 可成功 / 失败终局 */
function succeedSubmit(raw, submissionId) {
  const s = normalize(raw)
  if (s.status !== STATUS.SUBMITTING) return illegal(s)
  return moved(s, {
    status: STATUS.SUBMITTED, submitting: false,
    submissionId: submissionId || s.submissionId
  })
}
function failSubmit(raw) {
  const s = normalize(raw)
  if (s.status !== STATUS.SUBMITTING) return illegal(s)
  return moved(s, { status: STATUS.DRAFT, submitting: false })
}
/** 显式「重新提交」边：只有宿主明确调用才会回到 DRAFT；组件不消费本函数 */
function reopen(raw) {
  const s = normalize(raw)
  if (s.status !== STATUS.SUBMITTED && s.status !== STATUS.PASSED) return illegal(s)
  return moved(s, { status: STATUS.DRAFT, submitting: false, passedAt: 0 })
}
/** 初始化（非转移）：仍返回 state 对象，保持既有调用形状 */
function reset() {
  return normalize(null)
}

/**
 * 标记通过（幂等）。
 * @returns {{state:Object, ok:boolean, changed:boolean, reason:string}}
 *   changed=false 时 state 与入参归一化后的对象保持同一语义且不再产生副作用；
 *   已 PASSED 时直接返回同一 state 引用，保证「重复触发状态一致」。
 */
function markPassed(raw) {
  const s = normalize(raw)
  if (!canShowActions(s)) {
    return { state: s, ok: false, changed: false, reason: REASON.NOT_READY }
  }
  if (s.status === STATUS.PASSED) {
    return { state: s, ok: true, changed: false, reason: REASON.ALREADY_PASSED }
  }
  return {
    state: { ...s, status: STATUS.PASSED, passedAt: Date.now() },
    ok: true,
    changed: true,
    reason: REASON.OK
  }
}

/** 取得评定流程目标；未完成或未配置时拒绝，不产生跳转 */
function assessTarget(raw) {
  const s = normalize(raw)
  if (!canShowActions(s)) return { ok: false, target: '', reason: REASON.NOT_READY }
  if (!s.assessPath) return { ok: false, target: '', reason: REASON.NO_TARGET }
  return { ok: true, target: s.assessPath, reason: REASON.OK }
}

module.exports = {
  STATUS, REASON,
  normalize, canShowActions, isPassed,
  beginSubmit, succeedSubmit, failSubmit, reopen, reset,
  markPassed, assessTarget
}
