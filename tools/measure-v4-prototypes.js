#!/usr/bin/env node
'use strict'
/**
 * measure-v4-prototypes.js —— 原型盒模型与变体真实性门禁
 *
 * 为什么需要：截图只能证明"渲染出来了"，证明不了两件事——
 *   ① 没有横向滚动。宽度算错时 PNG 仍是 375×812，只是右边被裁掉。
 *      注意 position:fixed 元素不撑大 scrollWidth，必须单独量它们的边界。
 *   ② 变体是真的。若 applyQuery 没生效，?state=error 只是默认态换了个文件名，
 *      这种"伪证据"必须由脚本而不是肉眼来否掉。
 *
 * 做法：生成临时外壳页，把每个目标塞进同源 iframe（尺寸精确），
 * 用 setTimeout 等渲染完成（requestAnimationFrame 在离屏 iframe 里不触发），
 * 读回盒模型与计算样式，再由 --dump-dom 取结果。
 *
 * 运行：node tools/measure-v4-prototypes.js   （有问题退出码 1）
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const WEB = path.join(ROOT, 'prototype-web')
const MF = path.join(WEB, 'pages.manifest.json')
const HARNESS = path.join(WEB, '.measure-harness.html')

const browsers = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const browser = browsers.find(fs.existsSync)
if (!browser) { console.error('ERROR: 未找到 Chrome/Edge。可设置 CHROME_PATH。'); process.exit(2) }

const manifest = JSON.parse(fs.readFileSync(MF, 'utf8'))
const VPS = manifest.variantViewports || {}
const QS = manifest.variantQueries || {}

const targets = []
for (const p of manifest.pages) {
  targets.push({ label: p.id, file: p.file, query: '', variant: '', ...manifest.standardViewport })
  if (p.tablet) targets.push({ label: p.id + '--tablet', file: p.file, query: '', variant: '', ...manifest.tabletViewport })
  for (const name of p.variants || []) {
    targets.push({ label: `${p.id}--${name}`, file: p.file, query: QS[name] || '', variant: name, ...(VPS[name] || manifest.standardViewport) })
  }
}

const harness = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>measure</title>
<style>iframe{position:absolute;left:-9999px;top:0;border:0}pre{white-space:pre;font:12px monospace}</style></head>
<body><pre id="measure">PENDING</pre>
<script>
var T = ${JSON.stringify(targets)}
var out = [], i = 0
function report (s) { document.getElementById('measure').textContent = out.join('\\n') + '\\nMEASURE_DONE' }
function step () {
  if (i >= T.length) return report()
  var t = T[i++]
  var f = document.createElement('iframe')
  f.style.width = t.width + 'px'
  f.style.height = t.height + 'px'
  f.src = t.file + (t.query ? '?' + t.query : '')
  f.onload = function () {
    setTimeout(function () {
      try {
        var d = f.contentDocument, w = f.contentWindow
        var iw = w.innerWidth
        var sw = Math.max(d.documentElement.scrollWidth, d.body ? d.body.scrollWidth : 0)
        // 被祖先横向裁剪的元素不会造成页面横向滚动（如 .chip-row{overflow:auto} 里的标签），
        // 折叠 <details> 里的内容根本没渲染 —— 这两类都不算溢出。
        function clippedByAncestor (el) {
          var pe = el.parentElement
          if (pe && pe.closest('details:not([open])')) return true
          var p = el.parentElement
          while (p && p !== d.documentElement) {
            var ox = w.getComputedStyle(p).overflowX
            if (ox === 'hidden' || ox === 'auto' || ox === 'scroll' || ox === 'clip') return true
            p = p.parentElement
          }
          return false
        }
        function desc (el) {
          var cls = (typeof el.className === 'string' && el.className.trim())
            ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''
          return el.tagName.toLowerCase() + cls
        }
        function outside (el) {
          var r = el.getBoundingClientRect()
          if (r.width <= 0) return null
          if (r.right <= iw + 1 && r.left >= -1) return null
          return r
        }
        var bad = []
        d.querySelectorAll('body *').forEach(function (el) {
          var r = outside(el)
          if (!r || r.height <= 0 || clippedByAncestor(el)) return
          bad.push(desc(el) + '@' + Math.round(r.left) + '..' + Math.round(r.right))
        })
        // position:fixed 元素不撑大 scrollWidth，单独量边界
        var fixedBad = []
        d.querySelectorAll('body *').forEach(function (el) {
          if (w.getComputedStyle(el).position !== 'fixed') return
          var r = outside(el)
          if (!r || clippedByAncestor(el)) return
          fixedBad.push(desc(el) + '@' + Math.round(r.left) + '..' + Math.round(r.right))
        })
        var cs = w.getComputedStyle(d.documentElement)
        var main = d.getElementById('main')
        out.push(JSON.stringify({
          label: t.label, vp: iw, sw: sw, variant: t.variant,
          bad: bad.slice(0, 5), fixedBad: fixedBad.slice(0, 5),
          cls: d.documentElement.className || '',
          ink: cs.getPropertyValue('--ink').trim(),
          bg: cs.getPropertyValue('--bg').trim(),
          zoom: cs.zoom || '1',
          main: ((main ? main.textContent : '') || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
        }))
      } catch (e) { out.push(JSON.stringify({ label: t.label, error: e.message })) }
      f.remove(); step()
    }, 60)
  }
  document.body.appendChild(f)
}
step()
<\/script></body></html>`

fs.writeFileSync(HARNESS, harness, 'utf8')
let dom = ''
try {
  dom = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
    '--virtual-time-budget=60000', '--dump-dom',
    'file:///' + HARNESS.replace(/\\/g, '/'),
  ], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 })
} finally {
  try { fs.unlinkSync(HARNESS) } catch (e) { /* 清理失败不影响结论 */ }
}

const m = /<pre id="measure">([\s\S]*?)<\/pre>/.exec(dom)
if (!m) { console.error('MEASURE_FAIL 无法读取测量结果（外壳页未产出 measure 节点）'); process.exit(1) }
const body = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
if (!/MEASURE_DONE/.test(body)) { console.error('MEASURE_FAIL 测量未跑完（虚拟时间预算不足或页面报错）'); console.error(body.trim().slice(0, 2000)); process.exit(1) }

const rows = body.split('\n').map((l) => l.trim()).filter((l) => l && l !== 'MEASURE_DONE').map((l) => { try { return JSON.parse(l) } catch (e) { return { label: '?', error: '结果不是 JSON: ' + l.slice(0, 120) } } })

const problems = []
for (const r of rows) {
  if (r.error) { problems.push(`${r.label}: ${r.error}`); continue }
  if (r.sw > r.vp + 1) problems.push(`${r.label} 横向溢出 scrollWidth=${r.sw} > ${r.vp}${r.bad.length ? ' 越界元素: ' + r.bad.join(' | ') : ''}`)
  if (r.bad.length) problems.push(`${r.label} 存在越界元素: ${r.bad.join(' | ')}`)
  if (r.fixedBad.length) problems.push(`${r.label} 固定定位元素超出视口: ${r.fixedBad.join(' | ')}`)
  // 变体真实性：必须真的改变了渲染结果，否则就是"默认态换文件名"
  if (r.variant === 'contrast' && !/high-contrast/.test(r.cls)) problems.push(`${r.label} 未进入高对比模式（html.class=${r.cls}）`)
  if (r.variant === 'largeFont' && r.zoom === '1') problems.push(`${r.label} 大字档未生效（zoom=${r.zoom}）`)
  if ((r.variant === 'error' || r.variant === 'offline') && !/加载失败|离线|暂时没有/.test(r.main)) {
    problems.push(`${r.label} 状态未切换（main=${r.main.slice(0, 24)}）`)
  }
  if (!r.variant && r.cls) problems.push(`${r.label} 无查询串却带上了类名 ${r.cls}`)
}

if (problems.length) {
  console.error(`MEASURE_FAIL ${problems.length} 处问题 / 共 ${rows.length} 个视口`)
  problems.forEach((p) => console.error(' - ' + p))
  process.exit(1)
}
console.log(`MEASURE_OK targets=${rows.length} overflow=0 fixedOverflow=0 variantsVerified=${rows.filter((r) => r.variant).length}`)
