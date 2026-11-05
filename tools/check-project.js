/**
 * tools/check-project.js —— 项目静态自查（语法 / JSON / 图标 / 样式冲突 / 禁址）
 *
 * 为什么需要：下面这些失败**都不会**被 node --check 或 check-require.js 发现，
 * 但都会静默出问题（图标永远空白、样式被页面覆盖、地址漏进代码）：
 *   ① 全量 js 语法；
 *   ② 全量 json 可解析；
 *   ③ WXML 里用到的 `icons.X` 必须在 utils/icons.js 里存在，且该页要把 icons 放进 data；
 *   ④ 页面 wxss 里不得重复定义 app.wxss 的全局类（.state* / .error-inline*），否则全局改色被覆盖；
 *   ⑤ 禁址扫描：代码里禁止出现 127.0.0.1 / localhost / :800x / :8088。
 *      唯一豁免：miniprogram/config/env.js 中带 DEV_DIRECT 标记的行（PC 模拟器直连统一网关）。
 *
 * 运行：node tools/check-project.js     （有问题退出码 1）
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..', 'miniprogram')
const FORBIDDEN = /127\.0\.0\.1|localhost|:800[0-9]|:8088/
// 生产门禁"检测器"豁免：拦截临时隧道的正则必须写出这些域名才能拦截它们，
// 这类行只在 env.js 的生产 guard 中出现，属合法用法，不算违规。
// 注意：普通赋值（const gateway = 'http://localhost'）不含这些标记，仍会被判违规。
const GUARD = /TEMPORARY_HOST|vicp\\?\.fun|ngrok|natapp/
// 本机直连豁免（仅 config/env.js + 含 DEV_DIRECT 标记的行）：
// PC 模拟器直连统一网关 :8000 的唯一地址字面量；其他文件 / 其他行仍按 ⑤ 判违规。
const DEV_DIRECT = /DEV_DIRECT/
// 全局类：页面里不该重复定义（重复 = 全局改动被静默覆盖）
// ⚠️ 用 (?![-\w]) 而不是 \b：否则 .empty-card / .load-more-x 会被误判成 .empty / .load-more
const GLOBAL_CLS = /^\.(state|state-badge|state-badge-primary|state-badge-gray|state-ic|state-title|state-sub|state-btn|error-inline|error-inline-ic|error-inline-text|error-inline-btn|empty|load-more|load-all)(?![-\w])/

let bad = 0
function walk(dir, cb) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, cb)
    else cb(p)
  }
}
const rel = (p) => path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/')

const js = []
const json = []
const wxml = []
const wxss = []
walk(ROOT, (p) => {
  if (p.endsWith('.js')) js.push(p)
  else if (p.endsWith('.json')) json.push(p)
  else if (p.endsWith('.wxml')) wxml.push(p)
  else if (p.endsWith('.wxss')) wxss.push(p)
})

// ① 语法
console.log('① js 语法（' + js.length + ' 个）')
let n = 0
for (const f of js) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'ignore' }) }
  catch (e) { bad++; n++; console.log('   ✗ ' + rel(f)) }
}
console.log(n ? '   ' + n + ' 个语法错误' : '   全部通过')

// ② JSON
console.log('② json 可解析（' + json.length + ' 个）')
n = 0
for (const f of json) {
  try { JSON.parse(fs.readFileSync(f, 'utf8')) }
  catch (e) { bad++; n++; console.log('   ✗ ' + rel(f) + ' — ' + e.message) }
}
console.log(n ? '   ' + n + ' 个失败' : '   全部通过')

// ③ 图标键 + icons 进 data
console.log('③ 图标引用（' + wxml.length + ' 个 wxml）')
const icons = require(path.join(ROOT, 'utils', 'icons.js'))
let used = 0
n = 0
for (const f of wxml) {
  const src = fs.readFileSync(f, 'utf8')
  const keys = [...new Set([...src.matchAll(/icons\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))]
  if (!keys.length) continue
  for (const k of keys) {
    used++
    if (!icons[k]) { bad++; n++; console.log('   ✗ ' + rel(f) + ' → icons.' + k + ' 在 icons.js 里不存在') }
  }
  const jsFile = f.replace(/\.wxml$/, '.js')
  if (!fs.existsSync(jsFile)) continue
  const jsSrc = fs.readFileSync(jsFile, 'utf8')
  if (!/require\([^)]*utils\/icons\.js[^)]*\)/.test(jsSrc)) { bad++; n++; console.log('   ✗ ' + rel(jsFile) + ' 未 require icons.js') }
  // data 里必须出现 icons（否则模板取到 undefined，图标空白）
  else if (!/\bicons\s*[,:}]/.test(jsSrc)) { bad++; n++; console.log('   ✗ ' + rel(jsFile) + ' 未把 icons 放进 data') }
}
console.log('   引用 ' + used + ' 处' + (n ? '，' + n + ' 处有问题' : '，全部有效'))

// ④ 页面不得重复定义全局类
console.log('④ 全局类是否被页面 wxss 重复定义')
n = 0
for (const f of wxss) {
  if (f.endsWith(path.join('miniprogram', 'app.wxss'))) continue
  fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    if (GLOBAL_CLS.test(l.trim())) { bad++; n++; console.log('   ✗ ' + rel(f) + ':' + (i + 1) + ' ' + l.trim().slice(0, 60)) }
  })
}
console.log(n ? '   ' + n + ' 处重复定义（会覆盖全局样式）' : '   无重复定义')

// ⑤ 禁址
console.log('⑤ 禁址扫描（127.0.0.1 / localhost / :800x / :8088）')
n = 0
for (const f of js.concat(json, wxml, wxss)) {
  let src = fs.readFileSync(f, 'utf8')
  // 块注释跨行，里面的说明文字（"代码中禁止出现 8001）不算违规 → 整段抹掉，
  // 但把换行保留成等量换行，保证下面报的行号仍然准。
  src = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const isEnvJs = rel(f) === 'miniprogram/config/env.js'
  src.split('\n').forEach((l, i) => {
    // 行注释也抹掉，但不能误伤 http:// 里的双斜杠
    const code = l.replace(/(^|[^:])\/\/.*$/, '$1')
    const exempt = GUARD.test(code) || (isEnvJs && DEV_DIRECT.test(code))
    if (FORBIDDEN.test(code) && !exempt) { bad++; n++; console.log('   ✗ ' + rel(f) + ':' + (i + 1) + ' ' + l.trim().slice(0, 70)) }
  })
}
console.log(n ? '   ' + n + ' 处命中' : '   无命中')

// ⑥ 包体门禁（计划文档 F5 / 目标 G3）
//   · 主包体积估算：>1.7MB WARN / >1.9MB FAIL（微信主包硬上限 2MB）
//   · 单图 >100KB FAIL
//   · 主包内不得有音视频（分包内的存量视频只 WARN，留给 F2 网络化处理）
// 说明：体积按 packOptions.ignore 规则聚合，是**上界估算**（未做压缩/去重），
//      真实值以 devtools「代码依赖分析」为准；这里只做早期拦截。
console.log('⑥ 包体门禁（主包 / 单图 / 音视频）')
const pkgCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
const ignore = (pkgCfg.packOptions && pkgCfg.packOptions.ignore) || []
const subRoots = (appJson.subPackages || []).map((s) => s.root)

function ignored(relFromRoot) {
  for (const r of ignore) {
    if (r.type === 'folder' && (relFromRoot === r.value || relFromRoot.startsWith(r.value + '/'))) return true
    if (r.type === 'file' && relFromRoot === r.value) return true
    if (r.type === 'suffix' && relFromRoot.endsWith(r.value)) return true
  }
  return false
}
const MEDIA = /\.(mp4|mov|avi|mkv|mp3|wav|aac|m4a|ogg|flac)$/i
const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i
let mainBytes = 0
const subBytes = {}
for (const s of subRoots) subBytes[s] = 0
const bigImages = []
const mainMedia = []
const subMedia = []

walk(ROOT, (p) => {
  const relFromRoot = path.relative(ROOT, p).replace(/\\/g, '/')
  if (ignored(relFromRoot)) return
  const size = fs.statSync(p).size
  const owner = subRoots.find((s) => relFromRoot === s || relFromRoot.startsWith(s + '/'))
  if (owner) {
    subBytes[owner] += size
    if (MEDIA.test(relFromRoot)) subMedia.push([relFromRoot, size])
    return
  }
  mainBytes += size
  if (IMG.test(relFromRoot) && size > 100 * 1024) bigImages.push([relFromRoot, size])
  if (MEDIA.test(relFromRoot)) mainMedia.push([relFromRoot, size])
})

const mb = (b) => (b / 1024 / 1024).toFixed(3) + 'MB'
const mainWarn = mainBytes > 1.7 * 1024 * 1024
const mainFail = mainBytes > 1.9 * 1024 * 1024
console.log('   主包估算 ' + mb(mainBytes) + (mainFail ? ' ✗ 超 1.9MB' : mainWarn ? ' ⚠ 超 1.7MB' : ' ✓'))
if (mainFail) { bad++; console.log('   ✗ 主包体积 ' + mb(mainBytes) + ' 超过 1.9MB（微信上限 2MB）') }
else if (mainWarn) console.log('   ⚠ 主包体积 ' + mb(mainBytes) + ' 超过 1.7MB，建议继续瘦身')
for (const s of subRoots) {
  const b = subBytes[s]
  const flag = b > 2 * 1024 * 1024 ? ' ✗ 超 2MB' : ' ✓'
  console.log('   分包 ' + s + ' 估算 ' + mb(b) + flag)
  if (b > 2 * 1024 * 1024) { bad++; console.log('   ✗ 分包 ' + s + ' 超过 2MB') }
}
// 图片+音频总量（2026-11-04 新增，对齐 devtools 代码质量建议：单包 ≤200KB）
// 主包 FAIL 线取 300KB：现状已压到 ~198KB，留 100KB 余量，避免正常新增 1~2 张图就红；
// 分包只 WARN —— packageContent 里的存量 mp4 要走网络化（F2）才能降到 200KB 以内。
const imgMedia = (rules) => {
  let sum = 0
  walk(ROOT, (p) => {
    const rel = path.relative(ROOT, p).replace(/\\/g, '/')
    if (ignored(rel)) return
    if (!IMG.test(rel) && !MEDIA.test(rel)) return
    const owner = subRoots.find((s) => rel === s || rel.startsWith(s + '/'))
    if (rules(owner)) sum += fs.statSync(p).size
  })
  return sum
}
const kb = (b) => (b / 1024).toFixed(1) + 'KB'
const mainIM = imgMedia((o) => !o)
const DEVTOOLS_LIMIT = 200 * 1024
const MAIN_IM_FAIL = 300 * 1024
console.log('   主包图片+音频 ' + kb(mainIM) + (mainIM > MAIN_IM_FAIL ? ' ✗ 超 300KB' : mainIM > DEVTOOLS_LIMIT ? ' ⚠ 超 200KB' : ' ✓'))
if (mainIM > MAIN_IM_FAIL) { bad++; console.log('   ✗ 主包图片+音频 ' + kb(mainIM) + ' 超过 300KB（devtools 建议 ≤200KB）') }
else if (mainIM > DEVTOOLS_LIMIT) console.log('   ⚠ 主包图片+音频 ' + kb(mainIM) + ' 超过 devtools 建议的 200KB')
for (const s of subRoots) {
  const b = imgMedia((o) => o === s)
  if (b > DEVTOOLS_LIMIT) console.log('   ⚠ 分包 ' + s + ' 图片+音频 ' + kb(b) + ' 超过 200KB（需网络化，见 F2）')
}
for (const [f, s] of bigImages) { bad++; console.log('   ✗ 单图 ' + f + ' = ' + (s / 1024).toFixed(1) + 'KB（>100KB）') }
if (!bigImages.length) console.log('   无 >100KB 单图')
for (const [f, s] of mainMedia) { bad++; console.log('   ✗ 主包内含音视频 ' + f + '（' + (s / 1024).toFixed(1) + 'KB），禁止入包') }
for (const [f, s] of subMedia) console.log('   ⚠ 分包内存量音视频 ' + f + '（' + (s / 1024).toFixed(1) + 'KB），F2 网络化后消除')

console.log(bad ? '\n✗ check-project：共 ' + bad + ' 处问题' : '\n✓ check-project：全部通过')
process.exit(bad ? 1 : 0)
