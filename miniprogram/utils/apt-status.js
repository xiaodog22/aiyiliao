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

/**
 * 跨页同步标记（2026-11-15）：在「我的预约」取消成功后写这个键，
 * 「预约挂号」/「我的预约」等页面 onShow 看到就重拉数据 —— 否则用户取消完切回挂号页，
 * 还停在「挂号成功」页、余号也还是取消前那份。
 *
 * ⚠️ 这是**广播**，不是「读一次即删」（2026-11-15 修正）：
 *    最初写成破坏性消费，结果是「我的预约」自己的 onShow 先把它吃掉（用户取消后
 *    往往要回列表确认一次），再切「预约挂号」时标记已空 → 成功页照旧显示，
 *    看着像完全没修。现改为：写入只更新时间戳，每个页面各持 `_aptSeen` 游标做比较，
 *    谁都不会把别人的通知吞掉。
 * ⚠️ 10 分钟 TTL：太老的标记不认（进页本来就会拉数据），避免残留导致每次进页白刷。
 */
const APT_DIRTY_KEY = 'wb_apt_dirty'
const APT_DIRTY_TTL_MS = 10 * 60 * 1000

/** 写标记（取消/改约等变更后调用）；只写不清，可重复调用，返回写入的时间戳 */
function markAptDirty() {
  const ts = Date.now()
  try { wx.setStorageSync(APT_DIRTY_KEY, ts) } catch (e) {}
  return ts
}

/**
 * 读标记时间戳（**不删除**，供多个页面各自消费）。
 * @returns {number} 0 = 无标记 / 已超 TTL；否则为标记写入的毫秒时间戳
 */
function aptDirtyAt() {
  let v = 0
  try { v = Number(wx.getStorageSync(APT_DIRTY_KEY)) || 0 } catch (e) { v = 0 }
  if (!v) return 0
  if (Date.now() - v > APT_DIRTY_TTL_MS) {
    try { wx.removeStorageSync(APT_DIRTY_KEY) } catch (e) {}
    return 0
  }
  return v
}

module.exports = {
  aptStatusText, aptDisplayStatus, isPastVisit,
  markAptDirty, aptDirtyAt, APT_DIRTY_KEY, APT_DIRTY_TTL_MS
}
