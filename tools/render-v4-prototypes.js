#!/usr/bin/env node
'use strict'
/**
 * render-v4-prototypes.js —— 24 页网页原型无头渲染与截图
 *
 * 产出三类截图（全部由本地网页原型渲染，非 AI 参考图）：
 *   1. 标准手机  375×812      —— 全部 24 页
 *   2. 平板横屏  1194×834     —— manifest 中 tablet:true 的页
 *   3. 变体                  —— manifest 中 variants 声明的页：
 *        landscape      812×375   手机横屏
 *        tabletPortrait 1194×1696 平板竖屏
 *        cast16x9       1280×720  投屏 16:9
 *        error / offline / contrast / largeFont  ← 由 URL 查询串驱动评审态
 *
 * ⚠️ 为什么不用 `--window-size=W,H --screenshot` 直接截：
 *   实测（Chrome 141 / Windows）该方式下窗口宽度被强制钳到最小 512，
 *   高度还会比请求值少约 98px；PNG 仍按请求尺寸输出，于是得到
 *   "512 宽布局被裁到 375" 的假 375×812 —— 右边内容被切掉却看不出。
 *   所以这里改为：**把页面放进一个尺寸精确的 iframe**，窗口开得足够大，
 *   截图后再由 tools/lib/png.js 从左上角裁到目标尺寸。
 *
 * 运行：node tools/render-v4-prototypes.js    （需本机 Chrome 或 Edge）
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const png = require('./lib/png')

const ROOT = path.resolve(__dirname, '..')
const WEB = path.join(ROOT, 'prototype-web')
const MANIFEST = path.join(WEB, 'pages.manifest.json')
const OUT = path.join(WEB, 'screenshots')
const SHOT = path.join(WEB, '.shot.html')

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const browsers = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const browser = browsers.find(fs.existsSync)
if (!browser) { console.error('ERROR: 未找到 Chrome/Edge。可设置 CHROME_PATH。'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })

// 截图窗口比目标尺寸大出的余量：必须大于 Chrome 的宽度钳制值与高度损耗
const PAD = 260

const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/')

fs.writeFileSync(SHOT, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>shot</title>
<style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}
iframe{display:block;border:0;background:#fff}</style></head><body>
<iframe id="f"></iframe>
<script>
var q = new URLSearchParams(location.search)
var f = document.getElementById('f')
f.style.width = q.get('w') + 'px'
f.style.height = q.get('h') + 'px'
f.src = q.get('src')
<\/script></body></html>`, 'utf8')

/** 解析变体名 → {viewport, query}，未登记的变体名直接报错，避免静默漏截 */
function variantSpec(name) {
  const vp = (manifest.variantViewports || {})[name]
  const q = (manifest.variantQueries || {})[name]
  if (!vp && !q) throw new Error('manifest 未登记变体: ' + name)
  return { viewport: vp, query: q || '' }
}

function render(page, vp, suffix, query) {
  const target = path.join(OUT, `${page.id}${suffix}.png`)
  const source = path.join(WEB, page.file)
  // capture=1 让页面隐藏评审工具浮层，避免它盖住页面右上角内容
  const pageQuery = ['capture=1', query].filter(Boolean).join('&')
  const url = `${fileUrl(SHOT)}?w=${vp.width}&h=${vp.height}&src=${encodeURIComponent(fileUrl(source) + '?' + pageQuery)}`
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--allow-file-access-from-files', '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=1500',
    `--window-size=${vp.width + PAD},${vp.height + PAD}`,
    `--screenshot=${target}`, url,
  ]
  execFileSync(browser, args, { stdio: 'ignore', timeout: 30000 })
  const raw = png.decode(fs.readFileSync(target))
  if (raw.width < vp.width || raw.height < vp.height) {
    throw new Error(`${page.id}${suffix}: 原始截图 ${raw.width}x${raw.height} 小于目标 ${vp.width}x${vp.height}，需增大 PAD`)
  }
  fs.writeFileSync(target, png.encode(png.cropTopLeft(raw, vp.width, vp.height)))
  return target
}

let standard = 0, tablet = 0, variant = 0
try {
  for (const p of manifest.pages) {
    render(p, manifest.standardViewport, ''); standard++
    if (p.tablet) { render(p, manifest.tabletViewport, '--tablet'); tablet++ }
    for (const name of p.variants || []) {
      const spec = variantSpec(name)
      render(p, spec.viewport || manifest.standardViewport, '--' + name, spec.query)
      variant++
    }
    console.log(`OK ${p.id}${p.tablet ? ' + tablet' : ''}${(p.variants || []).length ? ' + ' + p.variants.join(',') : ''}`)
  }
} finally {
  try { fs.unlinkSync(SHOT) } catch (e) { /* 清理失败不影响结论 */ }
}
console.log(`RENDER_OK browser=${path.basename(browser)} standard=${standard} tablet=${tablet} variant=${variant} total=${standard + tablet + variant} out=${path.relative(ROOT, OUT)}`)
