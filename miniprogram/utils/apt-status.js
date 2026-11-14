/**
 * apt-status.js —— 预约状态枚举 → 界面中文文案（纯函数，node 可直接 require 单测）
 *
 * 契约 AppointmentStatus（backend/contracts/business-openapi.yaml）共 7 态：
 *   PENDING / CONFIRMED / CHECKED_IN / COMPLETED / CANCELLED / EXPIRED / NO_SHOW
 * ⚠️ 契约走 /api/v1/** 后状态是英文枚举；历史页面写死的「待就诊」等中文判断已失效，
 *    展示一律经本函数转换（未知值原样透传——不吞、不猜）。
 */
const TEXT = {
  PENDING: '待确认',
  CONFIRMED: '待就诊',
  CHECKED_IN: '就诊中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  EXPIRED: '已过期',
  NO_SHOW: '未到诊'
}

/** @param {string} s 契约状态值（或已是中文的旧值） @returns {string} 展示文案 */
function aptStatusText(s) {
  const raw = String(s == null ? '' : s)
  const key = raw.trim().toUpperCase()
  return TEXT[key] || raw
}

/**
 * 就诊时间是否已过（D-06 的判定内核）。
 * 语义：状态仍是「待确认/待就诊」，但预约时段已经过去 → 展示为「已过期」。
 * 只做**展示层**纠正，不改服务端状态（真实过期由后端定时任务置 EXPIRED）。
 * 容错：时间缺失/解析失败一律返回 false —— 宁可显示「待就诊」，也不把有效预约误标过期。
 * @param {string} startTime ISO 时间（契约 AppointmentData.startTime）
 * @param {string} [endTime]   ISO 时间（可选，缺省按开始后 30 分钟估算单次门诊占用）
 */
const VISIT_SLOT_MS = 30 * 60 * 1000
function isPastVisit(startTime, endTime) {
  const end = endTime ? Date.parse(endTime) : NaN
  if (!isNaN(end)) return end < Date.now()
  const start = Date.parse(startTime)
  if (isNaN(start)) return false
  return start + VISIT_SLOT_MS < Date.now()
}

/**
 * 展示用状态（含过期纠正）。
 * @param {string} s 契约状态值
 * @param {string} [startTime] 预约开始时间
 * @param {string} [endTime]   预约结束时间
 * @returns {string} 中文展示文案
 */
function aptDisplayStatus(s, startTime, endTime) {
  const text = aptStatusText(s)
  if (text !== '待就诊' && text !== '待确认') return text
  return isPastVisit(startTime, endTime) ? '已过期' : text
}

module.exports = { aptStatusText, aptDisplayStatus, isPastVisit }
