/**
 * fetch-icons.js —— 从开源图标库抓取真实图标（禁止 emoji 的替代方案）
 *
 * 来源：Lucide（https://lucide.dev，ISC/MIT，Feather 官方续作，风格与本项目一致）
 * 通道：Iconify API（https://api.iconify.design/lucide/<id>.svg）
 * 规格：24x24 viewBox · stroke-width 2 · round cap/join · 纯 path 描边
 *
 * 输出：tools/icons-lucide.js（name → SVG 内部元素），由 build-icons.js 合并进图标库
 *
 * 用法：node tools/fetch-icons.js           按 MAP 全量抓取
 *       node tools/fetch-icons.js thumbUp   只抓指定（可多个，空格分隔）
 */
const fs = require('fs')
const path = require('path')

const API = 'https://api.iconify.design/lucide/'
const OUT = path.join(__dirname, 'icons-lucide.js')

// name（项目内图标名） → Lucide 图标 id
const MAP = {
  // 反馈（替代 👍 👎）
  thumbUp: 'thumbs-up',
  thumbDown: 'thumbs-down',
  // 健康档案（替代 👤 📋 🧪）
  clipboardList: 'clipboard-list',
  flask: 'flask-conical',
  // 设置项（替代 🔠 🎨 🧹 📄）
  textSize: 'a-large-small',
  contrast: 'contrast',
  broom: 'broom',
  fileLock: 'file-lock-2',
  // 数字人控制（替代 🔇 ⏹）
  volumeOff: 'volume-x',
  stop: 'square',
  // 投屏（替代 ⚡ 📽 📢 🧘）
  zap: 'zap',
  projector: 'projector',
  megaphone: 'megaphone',
  personStanding: 'person-standing',
  // 大屏布局增强
  layoutGrid: 'layout-grid',
  bell: 'bell',
  bookOpen: 'book-open',
  heartbeat: 'heart-pulse',
  sparkles: 'sparkles',
  arrowUpRight: 'arrow-up-right',
  wrench: 'wrench',
  globe: 'globe',
  lock: 'lock',
  eye: 'eye'
}

function innerOf(svgText) {
  const m = svgText.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)
  if (!m) throw new Error('no <svg> found')
  return m[1]
    .replace(/\sstroke="currentColor"/g, '')
    .replace(/\sstroke="[^"]*"/g, '')
    .replace(/\sfill="none"/g, '')
    .trim()
}

async function fetchOne(name, id) {
  const res = await fetch(API + id + '.svg')
  if (!res.ok) throw new Error(name + ' HTTP ' + res.status)
  const inner = innerOf(await res.text())
  if (!/<(path|circle|rect|line|polyline|polygon)/.test(inner)) {
    throw new Error(name + ' empty inner')
  }
  return inner
}

async function main() {
  const only = process.argv.slice(2)
  const names = only.length ? only : Object.keys(MAP)
  const missing = names.filter((n) => !MAP[n])
  if (missing.length) throw new Error('未登记的图标：' + missing.join(', '))

  let prev = {}
  if (fs.existsSync(OUT)) {
    try { prev = require(OUT) } catch (e) { prev = {} }
  }

  const out = Object.assign({}, prev)
  let ok = 0
  for (const name of names) {
    try {
      out[name] = await fetchOne(name, MAP[name])
      ok++
      console.log('OK  ' + name + '  <- lucide/' + MAP[name])
    } catch (e) {
      console.log('ERR ' + name + '  ' + e.message)
    }
  }

  const keys = Object.keys(out).sort()
  const body = keys.map((k) => "  '" + k + "': '" + out[k].replace(/'/g, "\\'") + "'").join(',\n')
  fs.writeFileSync(OUT, [
    '/**',
    ' * icons-lucide.js —— 从 Lucide 抓取的真实图标（自动生成，请勿手改）',
    ' *',
    ' * 来源：https://lucide.dev （ISC 许可，Feather 续作，24x24 线性描边）',
    ' * 抓取：node tools/fetch-icons.js',
    ' * 用途：替换界面中的 emoji，保证跨设备（含 OPPO Pad 大屏）一致可辨识',
    ' */',
    'module.exports = {',
    body,
    '}',
    ''
  ].join('\n'), 'utf8')

  console.log('\nfetched ' + ok + '/' + names.length + ' -> ' + OUT + ' (total ' + keys.length + ')')
}

main().catch((e) => { console.error(e); process.exit(1) })
