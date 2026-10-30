/*
 * home.js —— 患者端首页数据（契约 GET /api/v1/home/summary）
 *
 * 响应：Envelope<HomeSummary> → { greeting, blocks: [{ kind, status, nextAppointment?, contents?, services? }] }
 *   kind   ：NEXT_APPOINTMENT / HEALTH_TIPS / QUICK_SERVICES / CONTENT_FEED / CARE_PLAN
 *   status ：ok / degraded / unavailable —— unavailable 的块**客户端隐藏**（不显示空数据，契约 02）
 *
 * 页面接线（pages/home）：greeting 取本响应；预约动态卡取 NEXT_APPOINTMENT 块；
 * 首页自有的导航配置（四宫格/常用服务/快选词/科普库）是界面配置与院内宣教内容，不走本接口。
 */
const { get, API } = require('./request.js')

/** 首页汇总（失败 reject，由页面按 MOCK_FALLBACK / 错误态处理） */
function getSummary() {
  return get(API.HOME_SUMMARY)
}

/** 从 blocks 数组按 kind 取块（找不到返回 null） */
function blockOf(summary, kind) {
  const list = (summary && Array.isArray(summary.blocks)) ? summary.blocks : []
  return list.find((b) => b && b.kind === kind) || null
}

module.exports = { getSummary, blockOf }
