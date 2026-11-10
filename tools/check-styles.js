/**
 * tools/check-styles.js —— WXML 用到的 class 是否都有样式定义（样式覆盖守卫）
 *
 * 为什么需要：`node --check` / `check-project.js` / `check-require.js` 全绿 ≠ 页面能看。
 * 真实踩过的坑（本轮 VF-09 养生页）：WXML 整体重写后引入了一批新类（.hx-hero / .act-card…），
 * 但 wxss 还没补 —— 语法没问题、图标引用没问题、门禁全绿，**页面却是一堆没排版的裸块**。
 * 这类问题只能靠"类名 → 样式"的交叉比对发现。
 *
 * 覆盖范围：每个页面 wxml × ( app.wxss + 本页 wxss[含 @import 递归] + usingComponents 组件 wxss )。
 * 判定口径：class 属性里出现的 token 必须能在上述样式文件里**以类选择器形式**找到。
 *   排除三类必然误报（已实测踩过）：
 *     ① `theme-{{theme}}` 这类拼接残片（`hm-tile-{{tint}}`）→ 丢弃以 '-' 结尾/开头的半截 token
 *     ② `{{status !== 'IDLE' ? …}}` 里的**比较值**被当类名 → 只取 `? : && || ,` 之后的取值位字符串
 *     ③ 公共样式经 `@import` 引入（auth-common.wxss）→ 必须递归跟进，否则整页误报
 *
 * 运行：node tools/check-styles.js
 * 退出码：0 全通过 / 1 有未定义类
 */
const fs = require('fs')
const path = require('path')

const MP = path.join(__dirname, '..', 'miniprogram')
const APP_WXSS = path.join(MP, 'app.wxss')

let FAIL = 0
const report = []
const allowedHits = []

/* 合法「结构 hook」白名单：类名只作语义锚点，视觉由父级 / 全局类承担。
   ⚠️ 往里加条目之前，必须先确认"确实有承载样式"，否则等于把真缺口洗掉。
   2026-10-16 逐个目检确认（承载来源写在理由里）。 */
const ALLOW = {
  'hm-ai-t1': '父 .hm-ai-tag 提供字号/字重/色（home.wxss），本类仅两行标注的锚点',
  'hm-ai-t2': '同上（手写标注第二行）',
  'hm-svc': '与全局 .card 组合使用，视觉由 .card + .hm-svc-* 子元素承担',
  'hm-tip': '与全局 .card 组合使用，视觉由 .card + .hm-tip-* 子元素承担',
  'dept-card': '与全局 .card 组合使用（consultation 页另有完整定义，本页只需 .card）',
  'sym-card': '与全局 .card 组合使用',
  'next-card': '与全局 .card 组合使用',
  'rec-line': '⚠️ 无自身样式：继承 page 正文字号/色 + 父卡内边距。复核非破版，但样式偏素 —— 列入观察，不属本轮范围',
  'device-info': '容器 hook，排版由子元素自带样式承担',
  // 2026-11-09（report-detail 电子检查报告页）：
  'rd-rows': '纯容器 hook：行内排版/分隔线由子元素 .rd-row（flex + padding + border-bottom）承担',
  'rd-sec-name': '分组标题文本：字号/色/内边距全部由父级 .rd-sec-bar 承担，<text> 直接继承',
  'none': '微信内置写法 hover-class="none"：正则 /class="…"/ 会匹配到 hover-class 尾部，属采集误报'
}

/** 递归找文件（跳过 tools 与隐藏目录） */
function walk(dir, ext, out) {
  out = out || []
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    if (d.name === 'tools' || d.name.startsWith('.')) return
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walk(p, ext, out)
    else if (d.name.endsWith(ext)) out.push(p)
  })
  return out
}

/** 从一个 wxss 文件收集类选择器名，并递归跟进其 @import */
function collectDefinedFrom(cssPath, into, visited) {
  visited = visited || new Set()
  if (visited.has(cssPath) || !fs.existsSync(cssPath)) return
  visited.add(cssPath)
  const css = fs.readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /\.(-?[_a-zA-Z][\w-]*)/g
  let m
  while ((m = re.exec(css))) into.add(m[1])
  // @import 跟进（相对当前文件目录解析）
  const imp = /@import\s+(['"])([^'"]+)\1\s*;/g
  while ((m = imp.exec(css))) {
    collectDefinedFrom(path.resolve(path.dirname(cssPath), m[2]), into, visited)
  }
}

/** 从 class 属性值里抽出所有候选类名 */
function collectUsed(attrValue, into) {
  // ① 只取三元/逻辑表达式的**取值位**字符串（比较值不算类名）
  const expr = attrValue.match(/\{\{[\s\S]*?\}\}/g) || []
  expr.forEach((e) => {
    const re = /(?:[?:]|&&|\|\||,)\s*(?:'([^']*)'|"([^"]*)")/g
    let m
    while ((m = re.exec(e))) {
      const v = m[1] != null ? m[1] : m[2]
      String(v).split(/\s+/).forEach((t) => t && into.add(t))
    }
  })
  // ② 剥掉插值后剩下的静态 token；丢掉被插值截断的半截 token
  attrValue.replace(/\{\{[\s\S]*?\}\}/g, ' ').split(/\s+/).forEach((t) => {
    if (!t) return
    if (t.endsWith('-') || t.startsWith('-')) return
    into.add(t)
  })
}

// ==================== 逐页比对 ====================
const wxmls = walk(MP, '.wxml')

wxmls.forEach((wxmlPath) => {
  const rel = path.relative(MP, wxmlPath).replace(/\\/g, '/')
  const dir = path.dirname(wxmlPath)
  const base = path.basename(wxmlPath, '.wxml')

  const defs = new Set()
  collectDefinedFrom(APP_WXSS, defs)
  const own = path.join(dir, base + '.wxss')
  if (fs.existsSync(own)) collectDefinedFrom(own, defs)
  const ownJson = path.join(dir, base + '.json')
  if (fs.existsSync(ownJson)) {
    try {
      const j = JSON.parse(fs.readFileSync(ownJson, 'utf8'))
      Object.keys(j.usingComponents || {}).forEach((k) => {
        const c = String(j.usingComponents[k]).replace(/^\//, '')
        collectDefinedFrom(path.join(MP, c + '.wxss'), defs)
      })
    } catch (e) { /* json 坏掉由 check-project 负责报 */ }
  }

  const used = new Set()
  const wxml = fs.readFileSync(wxmlPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const re = /class\s*=\s*"([^"]*)"/g
  let m
  while ((m = re.exec(wxml))) collectUsed(m[1], used)

  const missing = [...used].filter((t) => !defs.has(t) && !ALLOW[t]).sort()
  const allowed = [...used].filter((t) => !defs.has(t) && ALLOW[t]).sort()
  if (allowed.length) allowedHits.push({ rel, list: allowed })
  if (missing.length) {
    FAIL += missing.length
    report.push({ rel, missing })
  }
})

// ==================== 汇总 ====================
console.log('== check-styles ==')
console.log('比对页面：' + wxmls.length + ' 个 wxml（样式源：app.wxss + 本页 wxss[含 @import] + 组件 wxss）')
if (report.length) {
  console.log('❌ 有未定义类的页面 ' + report.length + ' 个（共 ' + FAIL + ' 个类）：')
  report.forEach((r) => console.log('   · ' + r.rel + '\n       ' + r.missing.join(' ')))
} else {
  console.log('✓ 所有 class 均有样式定义（或已被白名单确认）')
}
if (allowedHits.length) {
  console.log('ℹ️ 命中白名单的结构 hook（已目检：承载样式来自父级/全局类）：')
  allowedHits.forEach((r) => console.log('   · ' + r.rel + ' → ' + r.list.join(' ')))
}
console.log(report.length ? 'RESULT: STYLES_FAIL' : 'RESULT: STYLES_OK')
process.exit(FAIL ? 1 : 0)
