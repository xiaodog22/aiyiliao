/**
 * apt-date.js —— 预约日期徽章解析（VF-11）
 *
 * 为什么单独成文件：按项目惯例，**纯逻辑进 utils/ 才能被 node 直接 require 单测**
 * （同 utils/paginate.js / utils/triage-engine.js）。写在页面 js 里会被 Page() 阻断导入。
 * 无环境依赖、无 wx.* 调用 → `node tools/test-apt-date.js` 可直接跑。
 *
 * 输入形态（后端 / mock 的同一个 date 字段，不新增接口）：
 *   '2026-08-30（明天）' · '2026/8/3' · '2026.8.3 上午' · '08-30'
 * 输出：{ mon: '08月', day: '30', week: '周日' }
 * 解析不出（字段缺省 / 格式不认识 / 非法日期）→ 返回 null，
 * 页面据此回退为原来的整行文本 —— 这是「缺字段态不破版」的保证。
 */
function parseAptDate(s) {
  // ① 必须能取到 年-月-日 三段数字；年份可缺（缺则按当年算，见下）
  const m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(s == null ? '' : s))
  if (!m) return null
  const y = +m[1]
  const mo = +m[2]
  const d = +m[3]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null

  // ② 用 Date 反查校验（挡掉 2 月 30 日这类越界值），并取星期
  const dt = new Date(y, mo - 1, d)
  if (isNaN(dt.getTime())) return null
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null

  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return {
    mon: (mo < 10 ? '0' : '') + mo + '月',
    day: d < 10 ? '0' + d : String(d),
    week: WEEK[dt.getDay()]
  }
}

module.exports = { parseAptDate }
