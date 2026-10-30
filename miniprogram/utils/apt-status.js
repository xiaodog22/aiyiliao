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

module.exports = { aptStatusText }
