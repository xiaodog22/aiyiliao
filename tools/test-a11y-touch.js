/**
 * tools/test-a11y-touch.js —— 适老化触控目标 + 登录页字号令牌化断言（离线静态，node 直接跑）
 *
 * 依据：docs/测试报告_20261029_全量前端测试_详细版.md §3.2 / §3.4
 *   红线：375px 档 88rpx = 44px；本轮按"提到 80~88rpx"验收（≥80rpx 且断点内 ≥40px）。
 *
 * 断言分组：
 *   T02  触控 6 条（D-B-P2-04 ×4 / D-D-P2-01 / D-D-P2-02）+ 手动登录输入框（D-A-P2-02）
 *   F03  登录五页 base 区不得残留 <48rpx 的硬编码字号（D-A-P2-03；展示型大字号除外）
 *
 * 运行：node tools/test-a11y-touch.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
let PASS = 0
let FAIL = 0

function check(id, name, ok, note) {
  if (ok) PASS++; else FAIL++
  console.log((ok ? '✓' : '✗') + ' [' + id + '] ' + name + (note ? '  → ' + note : ''))
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 拆 base / ≥600px 断点两段（断点内尺寸必须折 px，÷2） */
function split(rel) {
  const s = read(rel)
  const i = s.indexOf('@media (min-width: 600px)')
  return i >= 0 ? { base: s.slice(0, i), wide: s.slice(i) } : { base: s, wide: '' }
}

/** 取某选择器块内的属性值（同名属性取最后一次声明） */
function prop(block, selector, name) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(esc + '\\s*\\{([^}]*)\\}', 'g')
  let val = null
  let m
  while ((m = re.exec(block)) !== null) {
    const hit = m[1].match(new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)'))
    if (hit) val = hit[1].trim()
  }
  return val
}

function rpx(v) {
  const n = parseFloat(String(v || ''))
  return /rpx/.test(String(v)) ? n : NaN
}

function px(v) {
  const n = parseFloat(String(v || ''))
  return /px/.test(String(v)) ? n : NaN
}

// ---------------- T02 触控目标 ----------------
const TOUCH = [
  // [id, 文件, 选择器, 属性, base 最小 rpx, 断点最小 px, 说明]
  ['T02-1', 'pages/doctor/appointments/appointments.wxss', '.apt-btn', 'height', 88, 44, '医生叫号/完成就诊（D-D-P2-01，原 25px）'],
  ['T02-2', 'pages/doctor/appointments/appointments.wxss', '.apt-actions', 'min-height', 88, 44, '叫号动作区容器'],
  ['T02-3', 'pages/doctor/workbench/workbench.wxss', '.todo-btn', 'height', 80, 40, '待办「处理」胶囊（D-D-P2-02，原 25px）'],
  ['T02-4', 'pages/consultation/consultation.wxss', '.chip', 'min-height', 80, 40, '问诊快捷症状 chip（D-B-P2-04，原 34px）'],
  ['T02-5', 'pages/consultation/consultation.wxss', '.emergency-call', 'min-height', 88, 44, '急诊预警「拨打」按钮（D-B-P2-04，原 36px）'],
  ['T02-6', 'pages/consultation/consultation.wxss', '.voice-btn', 'height', 80, 40, '输入栏语音圆钮（D-B-P2-04，原 32px）'],
  ['T02-7', 'pages/auth/manual-login/manual-login.wxss', '.ml-input', 'height', 88, 44, '手动登录输入框（D-A-P2-02，原 36px）']
]

TOUCH.forEach(([id, file, sel, name, minRpx, minPx, label]) => {
  const { base, wide } = split(file)
  const b = prop(base, sel, name)
  const w = prop(wide, sel, name)
  const okB = rpx(b) >= minRpx
  const okW = wide ? px(w) >= minPx : true
  check(id, label + ' ' + name + ' ≥ ' + minRpx + 'rpx / ' + minPx + 'px',
    okB && okW, 'base=' + b + ' 窄=' + (okB ? '达标' : '不足') + ' ｜ ≥600px=' + (w || '(未覆盖)'))
})

// 首页发送胶囊走 CSS 变量（不在选择器里，单独断言变量值）
{
  const { base, wide } = split('pages/home/home.wxss')
  const b = (base.match(/--h-send-h:\s*([^;]+)/) || [])[1]
  const w = (wide.match(/--h-send-h:\s*([^;]+)/) || [])[1]
  check('T02-8', '首页发送胶囊高度 ≥ 80rpx / 40px（D-B-P2-04，原 36px）',
    rpx(b) >= 80 && px(w) >= 40, 'base=' + b + ' ｜ ≥600px=' + w)
}

// ---------------- F03 登录页字号令牌化 ----------------
const LOGIN_FILES = [
  'pages/auth/auth-common.wxss',
  'pages/auth/login/login.wxss',
  'pages/auth/patient-login/patient-login.wxss',
  'pages/auth/doctor-login/doctor-login.wxss',
  'pages/auth/manual-login/manual-login.wxss'
]

LOGIN_FILES.forEach((file, i) => {
  const { base } = split(file)
  const bad = []
  base.split('\n').forEach((line) => {
    const m = line.match(/font-size:\s*([0-9]+)rpx/)
    if (!m) return
    if (Number(m[1]) >= 48) return            // 展示型大字号（logo/slogan）按设计稿固定，不参与适老缩放
    if (/theme-large|theme-xlarge/.test(line)) return // 主题专项覆盖本身即放大档
    bad.push(m[1] + 'rpx')
  })
  check('F03-' + (i + 1), path.basename(file) + ' base 区无 <48rpx 硬编码字号',
    bad.length === 0, bad.length ? '残留=' + bad.join(',') : '全部走 --font-* 令牌')
})

// 令牌化后的字号必须真实跟随档位（抽查三档差异，防止写成固定 var 别名）
{
  const app = read('app.wxss')
  // --font-body 在 app.wxss 按 standard → .theme-large → .theme-xlarge 顺序各声明一次
  const all = (app.match(/--font-body:\s*([0-9]+)rpx/g) || []).map((s) => s.match(/([0-9]+)rpx/)[1])
  check('F03-6', '字号令牌三档确实递增（standard < large < xlarge）',
    all.length >= 3 && Number(all[0]) < Number(all[1]) && Number(all[1]) < Number(all[2]),
    'body=' + all.slice(0, 3).join(' / '))
}

console.log('--------------------------------')
console.log('PASS=' + PASS + ' FAIL=' + FAIL)
process.exit(FAIL > 0 ? 1 : 0)
