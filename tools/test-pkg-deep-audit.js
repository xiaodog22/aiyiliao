/**
 * tools/test-pkg-deep-audit.js —— 第二轮「详细版」分片 E 深度审计：P1-07 / P2-18 / P2-19 修复验证
 *
 * 背景（docs/测试报告_20261029_全量前端测试.md §7.3）：
 *   P1-07 knowledge 列表缺「类型筛选」维度（第一轮红灯）；P2-18 nav.wxml 渲染了
 *   nav.js 从不存在的 activeFloorText（meta 楼层恒空）；P2-19 needRegister 算了未渲染。
 *   本脚本打桩 wx/getApp/Page/storage 后真实 require 分包页面，把三条钉成可执行断言：
 *
 *   A 组（P1-07，任务书预期「当前红」→ 修复轮后实测转绿）：
 *     ① knowledge data 含类型维度 types(all/article/video) 且 WXML 有类型 tab
 *     ② knowledge._apply 确实调 KB.filterFeed(cat, type)（spy 记录实参）
 *   B 组（P2-18）：
 *     ③ 任务书字面断言：nav 渲染数据含 activeFloorText 且非空 —— 当前码无此字段，按字面仍为红；
 *        修复实际走替代方案（wxml 改用 activeFloor），由 B2/B3 结果级断言验证用户可见效果。
 *   C 组（P2-19）：WXML 渲染 needRegister 提示条 + _pick 后字段为 true。
 *
 * 运行：node tools/test-pkg-deep-audit.js
 * 退出码：仅 A/B 结果级/C 组全绿才 exit 0；B1 字面断言红灯单独标注（预期内），不导致 exit 1。
 */
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..', 'miniprogram')

let PASS = 0
let FAIL = 0
const reds = [] // 记录「预期内红灯」（任务书字面口径已被修复方案替代）

function check(name, ok, extra) {
  if (ok) { PASS++; return }
  FAIL++
  reds.push(name + (extra ? '  ← ' + extra : ''))
}
function checkLiteralRed(name, okNow, extra) {
  // 任务书字面断言：当前应为红；若意外变绿则打印提示（防止漏记）
  if (!okNow) console.log('  [预期内红灯] ' + name + (extra ? '  ← ' + extra : ''))
  else console.log('  [⚠️ 字面断言意外转绿] ' + name)
}

// ==================== 全局桩（与 test-nav-page.js / test-knowledge-filter.js 同范式）====================
const APP = { globalData: { theme: 'standard', user: { name: '张三', phone: '13800138001' } }, logout() {} }
global.getApp = () => APP

global.wx = {
  getWindowInfo: () => ({ statusBarHeight: 20, pixelRatio: 2 }),
  getStorageSync: () => '',
  setStorageSync() {},
  removeStorageSync() {},
  showToast() {},
  showModal: (o) => { if (o && o.success) o.success({ confirm: true }) },
  navigateTo: () => {},
  switchTab: () => {},
  redirectTo: () => {},
  navigateBack: () => {},
  env: { USER_DATA_PATH: '/tmp' }
}
const ctxStub = new Proxy({}, {
  get(t, k) {
    if (k === 'measureText') return () => ({ width: 30 })
    if (k in t) return t[k]
    return () => {}
  },
  set(t, k, v) { t[k] = v; return true }
})
global.wx.createSelectorQuery = () => ({
  in: () => ({
    select: () => ({
      fields: () => ({
        exec: (cb) => cb([{
          width: 375, height: 420,
          node: {
            width: 0, height: 0,
            getContext: () => ctxStub,
            createImage: () => { const o = { set src(v) { if (o.onload) o.onload() } }; return o },
            requestAnimationFrame: (fn) => setTimeout(fn, 16)
          }
        }])
      })
    })
  })
})

let captured = null
global.Page = (o) => { captured = o }

function mount(page) {
  const ctx = Object.assign({}, page)
  ctx.data = JSON.parse(JSON.stringify(page.data))
  ctx.setData = function (patch, cb) {
    Object.keys(patch).forEach((k) => { ctx.data[k] = patch[k] })
    if (cb) cb()
  }
  return ctx
}

// ==================== A 组：P1-07 knowledge 类型筛选 ====================
console.log('== A 组：P1-07 knowledge 类型筛选修复验证 ==')

// spy KB.filterFeed（先包装再 require 页面，模块缓存共享同一 exports 对象）
const KB = require(path.join(ROOT, 'utils', 'knowledge-kb.js'))
const feedCalls = []
const origFilter = KB.filterFeed
KB.filterFeed = function (cat, type) {
  feedCalls.push({ cat: cat, type: type })
  return origFilter.call(KB, cat, type)
}

require(path.join(ROOT, 'packageContent', 'pages', 'knowledge', 'knowledge.js'))
const knowledgePage = captured
const kb = mount(knowledgePage)
kb.onLoad()

check('A1 knowledge data.types 含 all/article/video 三档',
  Array.isArray(kb.data.types) && kb.data.types.length === 3 &&
  kb.data.types[0].key === 'all' && kb.data.types[1].key === 'article' && kb.data.types[2].key === 'video',
  JSON.stringify(kb.data.types))
check('A1b 默认 type=all', kb.data.type === 'all', kb.data.type)

const kbWxml = fs.readFileSync(path.join(ROOT, 'packageContent', 'pages', 'knowledge', 'knowledge.wxml'), 'utf8')
check('A2 knowledge.wxml 有类型 tab 渲染块（kb-types + onType 绑定）',
  kbWxml.indexOf('kb-types') >= 0 && kbWxml.indexOf('bindtap="onType"') >= 0,
  '未找到 kb-types / onType')

check('A3 onLoad 后 _apply 调过 KB.filterFeed(cat, type) 且实参含二维',
  feedCalls.length > 0 && feedCalls[feedCalls.length - 1].type === 'all',
  'feedCalls=' + JSON.stringify(feedCalls))

kb.onType({ currentTarget: { dataset: { type: 'video' } } })
check('A4 切 video → 全部 3 条均为 video',
  kb.data.list.length === 3 && kb.data.list.every((x) => x.type === 'video'),
  '实得 ' + kb.data.list.length)
kb.onType({ currentTarget: { dataset: { type: 'article' } } })
check('A4b 切 article → 7 条均为图文',
  kb.data.list.length === 7 && kb.data.list.every((x) => x.type !== 'video'),
  '实得 ' + kb.data.list.length)
kb.onCat({ currentTarget: { dataset: { cat: '睡眠' } } })
kb.onType({ currentTarget: { dataset: { type: 'video' } } })
check('A5 分类×类型可叠加（睡眠×视频=0，不伪造命中）', kb.data.list.length === 0, '实得 ' + kb.data.list.length)
KB.filterFeed = origFilter

// ==================== B/C 组：P2-18 / P2-19 nav ====================
console.log('\n== B/C 组：P2-18 nav meta 楼层 + P2-19 needRegister 修复验证 ==')
require(path.join(ROOT, 'packageNav', 'pages', 'nav', 'nav.js'))
const navPage = captured

// B1：任务书字面断言（activeFloorText）——当前码已删该字段，按字面预期为红
const navKb = mount(navPage)
navKb.onLoad({})
const hasLiteral = typeof navKb.data.activeFloorText === 'string' && navKb.data.activeFloorText.length > 0
checkLiteralRed('B1 字面断言：data.activeFloorText 非空', hasLiteral,
  navKb.data.activeFloorText === undefined ? '字段不存在（wxml 已改用 activeFloor）' : '值=' + navKb.data.activeFloorText)

const navWxml = fs.readFileSync(path.join(ROOT, 'packageNav', 'pages', 'nav', 'nav.wxml'), 'utf8')
check('B2 结果级：nav.wxml nvr-meta 渲染 {{activeFloor}}（替代方案落地）',
  /nvr-meta[^}]*\{\{activeFloor\}\}/.test(navWxml), '未在 nvr-meta 找到 activeFloor')
check('B2b 结果级：nav.wxml 已无 activeFloorText 残留', navWxml.indexOf('activeFloorText') < 0, '仍有残留')

// 深链消化内科（1F 直达门诊房间）→ activeFloor 非空 + needRegister=true
navKb.onLoad({ dept: encodeURIComponent('消化内科') })
navKb.onReady()
check('B3 深链消化内科：activeFloor 非空（meta 楼层有内容）',
  !!navKb.data.activeFloor && navKb.data.activeFloor.length > 0, 'activeFloor=' + navKb.data.activeFloor)
check('C2 深链消化内科（门诊目的地）：needRegister=true 且提示条会渲染',
  navKb.data.needRegister === true, 'needRegister=' + navKb.data.needRegister)
check('C1 结果级：nav.wxml 有 needRegister 提示条块',
  navWxml.indexOf('wx:if="{{needRegister}}"') >= 0, 'wxml 无 needRegister 块')

// 深链神经内科（3F 换层）：floorTip 非空 + activeFloor 取目的地楼层
const navKb2 = mount(navPage)
navKb2.onLoad({ dept: encodeURIComponent('神经内科') })
navKb2.onReady()
check('B4 深链神经内科：floorTip 换层提示非空',
  !!navKb2.data.floorTip && navKb2.data.floorTip.indexOf('3 楼') >= 0, navKb2.data.floorTip || '(空)')

// ==================== 汇总 ====================
console.log('\n== test-pkg-deep-audit 汇总 ==')
if (FAIL) {
  console.log('PASS=' + PASS + ' FAIL=' + FAIL)
  reds.forEach((r) => console.log('  ✗ ' + r))
  process.exit(1)
}
console.log('PASS=' + PASS + ' FAIL=0（结果级断言全绿；B1 字面红灯为预期内口径漂移，见报告）')
