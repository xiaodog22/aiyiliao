/**
 * datetime.js —— 时间字段展示格式化（纯函数，node 可直接 require 单测）
 *
 * 契约时间字段一律为 ISO Instant（UTC，如 '2026-10-18T01:30:00Z'），界面按**设备本地时区**展示；
 * 演示/历史数据可能是 'YYYY-MM-DD' 纯日期 → 直接取日期部分（不做时区换算，避免跨日偏移）。
 * 解析失败：原样返回（不吞、不猜），由页面自行决定是否显示。
 */

/**
 * ISO Instant / 'YYYY-MM-DD' → 'YYYY-MM-DD'
 * @param {string} s
 * @returns {string}
 */
function fmtDate(s) {
  const str = String(s == null ? '' : s)
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str)
  // 纯日期串（无 T 时间部分）：原样取日期，不走 Date 解析（避免 UTC→本地跨日偏移）
  if (m && str.indexOf('T') < 0) return m[1]
  const d = new Date(str)
  if (isNaN(d.getTime())) return str
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/**
 * ISO Instant → 本地时区 { date:'YYYY-MM-DD', time:'HH:mm' }
 * @param {string} s
 * @returns {{date:string, time:string}} 空值/解析失败 → { date:'', time:'' }
 */
function fmtLocalDateTime(s) {
  const str = String(s == null ? '' : s)
  if (!str) return { date: '', time: '' }
  // ① 整串就是「日期[ 时间]」且无时区标记（演示数据 '2026-08-30' / '2026-08-30 09:30'）：
  //    直接拆分 —— 不走 Date（iOS 不识别 "YYYY-MM-DD HH:mm" 空格格式，会得到空串）
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?$/.exec(str)
  if (m) return { date: m[1], time: m[2] ? m[2] + ':' + m[3] : '' }
  // ② 带时区的 ISO Instant（T…Z / T…+08:00）→ Date 解析后取本地时间
  const d = new Date(str)
  if (isNaN(d.getTime())) return { date: '', time: '' }
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return {
    date: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
    time: p(d.getHours()) + ':' + p(d.getMinutes())
  }
}

/**
 * 会话时间分隔标签：ISO Instant / 'YYYY-MM-DD' → 今天 / 昨天 / M月D日 / YYYY年M月D日
 *
 * 用于聊天流的「—— 今天 9:30 ——」分隔条（设计稿 04-在线问诊）。
 * 只做**日期相对化**，时分仍由 fmtLocalDateTime 给出，两者组合使用：
 *   dayLabel(iso) + ' ' + fmtLocalDateTime(iso).time
 * @param {string} s
 * @returns {string} 无法解析 → ''（调用方不渲染分隔条，不猜日期）
 */
function dayLabel(s) {
  const t = fmtLocalDateTime(s)
  if (!t.date) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date)
  if (!m) return ''
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  // 用「设备本地今天」的 0 点做差，按自然日取整（不用 24h 计时，避免跨夏令时/午夜抖动）
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const that = new Date(y, mo - 1, d)
  const diff = Math.round((today.getTime() - that.getTime()) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (y === now.getFullYear()) return mo + '月' + d + '日'
  return y + '年' + mo + '月' + d + '日'
}

module.exports = { fmtDate, fmtLocalDateTime, dayLabel }
