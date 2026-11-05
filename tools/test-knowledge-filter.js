/**
 * tools/test-knowledge-filter.js —— 科普列表双维度筛选回归（P1-07）
 *
 * 背景（docs/测试报告_分片E_分包与工具链.md §3 P1）：
 *   KB 层早有 filterFeed(category, type)，但页面只做 分类+关键词 二维过滤，
 *   WXML 也没有「全部/图文/视频」类型 tab —— CORE_FLOWS 承诺的 cat × type 双筛选落空。
 *   本脚本打桩 wx / getApp / Page 后真实 require 页面，钉死三条：
 *     ① 类型 tab 状态存在且默认 all
 *     ② 切到 video 只剩 3 条、article 剩 7 条（当前内容库实测口径）
 *     ③ 分类 × 类型可叠加（睡眠类无视频 → 0 条）
 *
 * 运行：node tools/test-knowledge-filter.js
 */
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
let PASS = 0
let FAIL = 0
const fails = []

function check(name, ok, extra) {
  if (ok) { PASS++; return }
  FAIL++
  fails.push(name + (extra ? '  ← ' + extra : ''))
}

global.wx = {
  getStorageSync() { return '' },
  setStorageSync() {},
  removeStorageSync() {},
  navigateTo() {}
}
global.getApp = () => ({ globalData: { theme: 'standard' } })

let def = null
global.Page = (cfg) => { def = cfg }

require(path.join(ROOT, 'packageContent', 'pages', 'knowledge', 'knowledge.js'))

function makeInst(cfg) {
  const inst = Object.assign({}, cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}))
  inst.setData = function (patch) { Object.assign(this.data, patch) }
  return inst
}

const KB = require(path.join(ROOT, 'utils', 'knowledge-kb.js'))
const inst = makeInst(def)
inst.onLoad()

const ids = (list) => list.map((x) => x.id)

check('① 类型 tab 三档存在且默认 all',
  Array.isArray(inst.data.types) && inst.data.types.length === 3 && inst.data.type === 'all',
  JSON.stringify({ types: inst.data.types, type: inst.data.type }))
check('① 默认（全部 × 全部）= FEED 全量 ' + KB.FEED.length,
  inst.data.list.length === KB.FEED.length, '实得 ' + inst.data.list.length)

inst.onType({ currentTarget: { dataset: { type: 'video' } } })
check('② 类型=video → 3 条提示视频',
  inst.data.list.length === 3 && inst.data.list.every((x) => x.type === 'video'),
  '实得 ' + inst.data.list.length + ' / ' + JSON.stringify(ids(inst.data.list)))

inst.onType({ currentTarget: { dataset: { type: 'article' } } })
check('② 类型=article → 7 条图文',
  inst.data.list.length === 7 && inst.data.list.every((x) => x.type !== 'video'),
  '实得 ' + inst.data.list.length)

inst.onCat({ currentTarget: { dataset: { cat: '睡眠' } } })
check('③ 分类=睡眠 × 图文 → 1 条（可叠加）',
  inst.data.list.length === 1, '实得 ' + inst.data.list.length)

inst.onType({ currentTarget: { dataset: { type: 'video' } } })
check('③ 分类=睡眠 × 视频 → 0 条（不伪造命中）',
  inst.data.list.length === 0, '实得 ' + inst.data.list.length)

console.log('== test-knowledge-filter ==')
if (FAIL) {
  console.log('PASS=' + PASS + ' FAIL=' + FAIL)
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
console.log('PASS=' + PASS + ' FAIL=0')
