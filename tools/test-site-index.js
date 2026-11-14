#!/usr/bin/env node
'use strict'
/**
 * test-site-index.js —— GitHub Pages 落地页（site/index.html）回归测试
 *
 * 背景（2026-11-13）：该页面被 Edge SmartScreen 标记为「危险网站」。为降低同类误判，
 * 页面新增了**原样**免责声明，并明确禁止手机号/验证码演示控件。本文件锁死三件事：
 *   ① 免责声明原样存在、位于首屏显著位置、窄屏不隐藏；
 *   ② 页面不保留/新增任何手机号/验证码输入控件与相关 JS 逻辑（无遗留死代码）；
 *   ③ 原有结构、导航、滚动渲染交互与静态服务运行完全不受影响。
 *
 * 运行：node tools/test-site-index.js（零外部依赖，node:test）
 * 已登记进 tools/test-fe-all.js，随前端一键回归自动执行。
 */

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const FILE = path.join(__dirname, '..', 'site', 'index.html')
const NOTICE = '本页面为开源项目演示，不提供医疗服务，不构成诊断依据'
const html = fs.readFileSync(FILE, 'utf8')

// 分区：正文标记 / 样式 / 脚本。控件扫描只看「可见标记」，避免把 CSS 选择器、
// 注释、Base64 图片数据里的字符误判成控件（本项目页面有 6 张内联 WebP）。
const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'))
const markup = body
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
const css = (html.match(/<style[\s\S]*?<\/style>/g) || []).join('\n')
const scripts = html.match(/<script[\s\S]*?<\/script>/g) || []
const script = scripts.join('\n')

function countOccurrences(text, needle) {
  let n = 0
  let i = 0
  while ((i = text.indexOf(needle, i)) >= 0) { n++; i += needle.length }
  return n
}

// ==================== A. 免责声明展示 ====================

test('SITE-01 免责声明原样出现且只有一处', () => {
  assert.ok(markup.includes(NOTICE), '未找到原样免责声明文本')
  assert.strictEqual(countOccurrences(markup, NOTICE), 1, '免责声明不应重复堆叠')
  // 逐字比对元素内容，防止「加前缀/后缀」式改写
  const m = /<p class="hero-notice"[^>]*>([^<]+)<\/p>/.exec(markup)
  assert.ok(m, '免责声明未放在 .hero-notice 元素里')
  assert.strictEqual(m[1].trim(), NOTICE, '文案必须原样，不得增删字词')
})

test('SITE-02 免责声明位于首屏显著位置（hero-copy 内、按钮组之前）', () => {
  const hero = markup.indexOf('<div class="hero-copy"')
  const notice = markup.indexOf(NOTICE)
  const actions = markup.indexOf('<div class="hero-actions"')
  const features = markup.indexOf('id="features"')
  assert.ok(hero >= 0 && actions > hero, '未找到 hero 区块')
  assert.ok(notice > hero && notice < actions, '免责声明应在 hero 文案之后、操作按钮之前')
  assert.ok(notice < features, '免责声明应在首屏（功能介绍区之前）')
})

test('SITE-03 免责声明是可见元素（非注释、非隐藏）', () => {
  const tag = /<p class="hero-notice"[^>]*>/.exec(markup)
  assert.ok(tag, '未找到声明元素')
  assert.ok(!/\bhidden\b|aria-hidden="true"|display\s*:\s*none/.test(tag[0]), '声明元素不得隐藏')
  // CSS 里 .hero-notice 必须显式可见；且不能出现 display:none 覆盖
  assert.ok(/\.hero-notice\s*\{/.test(css), '缺少 .hero-notice 样式定义')
  const rule = /\.hero-notice\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule && !/display\s*:\s*none/.test(rule[1]), '.hero-notice 基础样式不得隐藏')
})

test('SITE-04 窄屏（≤720px）仍显示免责声明', () => {
  const media = /@media\s*\(max-width:720px\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(media, '未找到 720px 响应式规则')
  assert.ok(/\.hero-notice\s*\{/.test(media[1]), '窄屏未给 .hero-notice 补样式')
  assert.ok(!/\.hero-notice\s*\{[^}]*display\s*:\s*none/.test(media[1]), '窄屏不得隐藏免责声明')
  // 窄屏会隐藏 .hero-lead，声明不能跟着一起消失
  assert.ok(/\.hero-lead\{display:none;/.test(media[1]), '基线：窄屏原本隐藏 hero-lead')
})

test('SITE-05 页脚原有医疗免责声明保留（其他内容不受影响）', () => {
  assert.ok(/免责声明：导诊与问诊结果均为演示性质/.test(markup), '页脚原有免责声明被误删')
})

// ==================== B. 手机号 / 验证码控件缺失 ====================

test('SITE-06 无任何输入框、表单、tel/数字输入控件', () => {
  assert.strictEqual((markup.match(/<input\b/gi) || []).length, 0, '页面不应有 <input>')
  assert.strictEqual((markup.match(/<form\b/gi) || []).length, 0, '页面不应有 <form>')
  assert.ok(!/type=["']tel["']|inputmode=["']numeric["']|type=["']number["']/i.test(markup), '不应有电话/数字输入')
  assert.ok(!/<textarea\b/i.test(markup), '页面不应有 <textarea>')
})

test('SITE-07 无手机号/验证码/获取验证码等演示文案与按钮', () => {
  const banned = ['手机号', '验证码', '获取验证码', '发送验证码', '短信验证码', '输入手机号', '请输入11位']
  banned.forEach((w) => assert.ok(!markup.includes(w), '出现被禁文案：' + w))
  assert.ok(!/获取验证码|发送验证码/.test(html), '源码任何位置都不得出现验证码按钮文案')
  assert.ok(!/\b(phone|sms|otp|captcha|tel)\b/i.test(markup), '可见标记里不应有手机号/验证码控件标识')
})

test('SITE-08 无手机号/验证码相关 JS 逻辑（无遗留死代码）', () => {
  assert.ok(script.length > 0, '交互脚本不应被删')
  assert.ok(!/\b(phone|sms|otp|captcha|verification|verifyCode|sendCode|getCode|form|submit)\b/i.test(script),
    '脚本里仍有手机号/验证码/表单提交相关逻辑')
  assert.ok(!/getElementById\([^)]*(phone|sms|code|verify)/i.test(script), '脚本仍在引用已移除的控件')
})

test('SITE-09 脚本引用的 DOM id 全部存在（无「清理后残留」的空引用）', () => {
  const ids = []
  const re = /document\.getElementById\("([^"]+)"\)/g
  let m
  while ((m = re.exec(script))) ids.push(m[1])
  assert.ok(ids.length >= 8, '交互脚本的 DOM 引用异常减少')
  ids.forEach((id) => assert.ok(markup.includes('id="' + id + '"'), '脚本引用了不存在的 id：' + id))
  ;['.shot', '.ch', '.rail button', '[data-goto]'].forEach((sel) => {
    const key = sel.replace(/^\./, '').split(' ')[0].replace(/[[\]]/g, '')
    assert.ok(script.includes(sel), '缺少原有选择器：' + sel)
    assert.ok(markup.includes(key) || markup.includes('data-goto'), '页面缺少对应元素：' + sel)
  })
})

test('SITE-10 页面保持自包含（无外部脚本 / iframe / 外部图片）', () => {
  assert.ok(!/<script[^>]+src=/i.test(html), '不应引入外部脚本')
  assert.ok(!/<iframe\b/i.test(html), '不应引入 iframe')
  assert.ok(!/<img[^>]+src=["']https?:/i.test(html), '不应引用外部图片')
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket/.test(script), '落地页不应发起数据请求')
})

// ==================== C. 原有结构 / 交互 / 构建运行 ====================

test('SITE-11 关键结构锚点与区块数量不变', () => {
  ;['<header class="nav" id="nav"', 'id="pbar"', 'id="mobileMenu"', '<main id="top"',
    'id="showcase"', 'id="pin"', 'id="heroCopy"', 'id="chapters"', 'id="device"',
    'id="features"', 'id="tech"', '<footer class="footer"', 'id="startBtn"', 'id="burger"'
  ].forEach((frag) => assert.ok(markup.includes(frag), '结构锚点缺失：' + frag))
  assert.strictEqual((markup.match(/<article class="ch"/g) || []).length, 6, '章节卡应为 6 张')
  assert.strictEqual((markup.match(/<button type="button" data-goto=/g) || []).length, 6, 'rail 跳转按钮应为 6 个')
  // 首屏那张初始可见的截图带 `class="shot on"`，按 `<img class="shot` 计数才是 6
  assert.strictEqual((markup.match(/<img class="shot/g) || []).length, 6, '界面截图应为 6 张')
})

test('SITE-12 导航与外链保持不变', () => {
  assert.ok(markup.includes('href="#features"') && markup.includes('href="#tech"'), '主导航锚点缺失')
  assert.strictEqual((markup.match(/https:\/\/github\.com\/xiaodog22\/aiyiliao/g) || []).length >= 3, true,
    'GitHub 外链数量异常')
  assert.ok(markup.includes('MIT 许可'), '许可链接缺失')
})

test('SITE-13 滚动渲染/菜单/跳转交互脚本完整', () => {
  ;['addEventListener("scroll"', '{ passive: true }', 'addEventListener("resize"',
    'function measure()', 'function render(', 'function goTo(', 'data-goto',
    'startBtn', 'burger', 'prefers-reduced-motion'
  ].forEach((frag) => assert.ok(script.includes(frag), '交互脚本缺失：' + frag))
  assert.strictEqual(scripts.length, 1, '脚本块数量不应变化')
})

test('SITE-14 文档骨架与编码不变', () => {
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'DOCTYPE 被改')
  assert.ok(/<html lang="zh-CN">/.test(html), '语言标记被改')
  assert.ok(/<meta charset="UTF-8">/.test(html), '编码声明被改')
  assert.ok(!html.includes('\uFEFF'), '不应带 BOM')
})

test('SITE-15 关键标签成对（HTML 可解析，构建运行前提）', () => {
  ;['div', 'p', 'section', 'svg', 'script', 'style', 'article', 'footer', 'header'].forEach((tag) => {
    const open = (html.match(new RegExp('<' + tag + '\\b', 'gi')) || []).length
    const close = (html.match(new RegExp('</' + tag + '>', 'gi')) || []).length
    assert.strictEqual(open, close, '<' + tag + '> 开闭标签数量不一致')
  })
})

test('SITE-16 静态服务可返回 200 且响应含原样免责声明', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (r) => {
      let buf = ''
      r.on('data', (c) => { buf += c })
      r.on('end', () => resolve({ status: r.statusCode, body: buf }))
    }).on('error', reject)
  })
  assert.strictEqual(res.status, 200)
  assert.ok(res.body.includes(NOTICE), 'HTTP 响应里应包含免责声明')
  assert.ok(res.body.includes('id="heroCopy"'), 'HTTP 响应里应保留首屏结构')
})
