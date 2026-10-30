/**
 * utils/paginate.js —— 长列表客户端分页（首屏只渲染部分，上拉触底追加）
 *
 * 为什么不用后端分页：当前后端列表接口（/api/appoint/list、/api/v1/bed/list 等）
 * 均返回全量数组，未提供 offset/limit。前端首屏只切 PAGE_SIZE 条进 WXML，
 * 避免几百条一次性进渲染树（wx:for 全量 → setData 体大、首屏慢）。
 *
 * ⚠️ 本模块导出的是**对象** `{ PAGE_SIZE, paginate }`，必须按名解构导入：
 *     const { paginate } = require('../../utils/paginate.js')
 *   写成 `const paginate = require(...)` 会拿到整个模块对象，调用即报
 *   "paginate is not a function"（2026-09-16 线上真实踩到，四个长列表页全中）。
 *
 * 用法（pages/doctor/appointments、beds、profile/consultations、records 四个长列表页）：
 *   const { paginate } = require('../../utils/paginate.js')
 *   // 拉到全量后：p.all 是归一化后的全量数组，必须存进 data 供触底追加
 *   const p = paginate(mapped, 1)
 *   this.setData({ all: p.all, displayed: p.displayed, page: p.page, hasMore: p.hasMore, total: p.total })
 *   // 上拉触底：
 *   onReachBottom() {
 *     if (!this.data.hasMore) return
 *     const p = paginate(this.data.all, this.data.page + 1)
 *     this.setData({ displayed: p.displayed, page: p.page, hasMore: p.hasMore })
 *   }
 */
const PAGE_SIZE = 20

/**
 * 按页码切分全量数组。
 * @param {Array} all   全量数据（已映射成视图需要的字段）
 * @param {number} page 从 1 开始的页码
 * @param {number} [size] 每页条数，默认 PAGE_SIZE
 * @returns {{all:Array, displayed:Array, page:number, hasMore:boolean, total:number}}
 *   all —— 归一化后的全量数组（回传是为了让调用方一次 setData 就能存下全量与切片；
 *          页面若写 all: p.all 而这里不返回 all，会静默变成 undefined，
 *          表现的却是"按钮点了没反应"，比直接报错更难查）
 */
function paginate(all, page, size) {
  const arr = Array.isArray(all) ? all : []
  const ps = size || PAGE_SIZE
  const pg = Math.max(1, page | 0)
  const end = pg * ps
  return {
    all: arr,
    displayed: arr.slice(0, end),
    page: pg,
    hasMore: arr.length > end,
    total: arr.length
  }
}

module.exports = { PAGE_SIZE, paginate }
