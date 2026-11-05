#!/usr/bin/env node
'use strict'
/*
 * check-v4-docs.js —— V4 文档一致性门禁
 *
 * 校验 docs/v4/06 中登记的 S-01 / S-12 等条目：
 *   S-01 24 路由在 app.json / V4 主说明书 / 原型清单三处一致
 *   S-08 禁用词未出现在 V4 对外界面提示词中
 *   S-12 V3.1 原文件存在且未被覆盖
 * 另校验：V4 主说明书 24 段提示词齐全、docs/v4/01-07 齐全、截图引用齐全。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const APP = path.join(ROOT, 'miniprogram', 'app.json')
const DOC = path.join(ROOT, 'design-output', '医疗_AI_智能健康小程序_UIUX_原型设计与界面说明书_V4.md')
const V31 = path.join(ROOT, 'design-output', '医疗_AI_智能健康小程序_UIUX_原型设计与界面说明书_V3.1_修正版.md')
const V4DIR = path.join(ROOT, 'docs', 'v4')
const MANIFEST = path.join(ROOT, 'prototype-web', 'pages.manifest.json')

const errors = []
const warnings = []
const fail = (m) => errors.push(m)
const warn = (m) => warnings.push(m)

function read(p) {
  try { return fs.readFileSync(p, 'utf8') } catch (e) { fail('缺少或不可读 ' + path.relative(ROOT, p)); return '' }
}

// ---------- 事实源 ----------
let app, manifest
try { app = JSON.parse(read(APP)) } catch (e) { fail('app.json 解析失败: ' + e.message) }
try { manifest = JSON.parse(read(MANIFEST)) } catch (e) { fail('pages.manifest.json 解析失败: ' + e.message) }

const routes = app
  ? [...(app.pages || []), ...(app.subPackages || []).flatMap((sp) => (sp.pages || []).map((p) => sp.root + '/' + p))]
  : []

if (routes.length !== 24) fail(`app.json 路由数应为 24，实际 ${routes.length}`)

// ---------- V4 主说明书 ----------
const doc = read(DOC)

for (const r of routes) if (!doc.includes(r)) fail('V4 主说明书缺少路由 ' + r)

const promptSections = (doc.match(/^### 8\.\d+/gm) || []).length
if (promptSections !== 24) fail(`V4 主说明书提示词节应为 24 段，实际 ${promptSections}`)

const fences = (doc.match(/^```text$/gm) || []).length
if (fences < 24) fail(`V4 主说明书可复制提示词代码块应 ≥24，实际 ${fences}`)

// 每段提示词不得写"同上/见前文"（使用说明中声明"不依赖同上"的句子不算）
const lazy = doc
  .split(/\r?\n/)
  .filter((l) => /同上|参见上一节|提示词同前/.test(l))
  .filter((l) => !/不依赖|互相独立|使用说明/.test(l))
if (lazy.length) fail(`提示词中出现 ${lazy.length} 处"同上"类省略写法`)

// 截图引用
if (manifest) {
  for (const p of manifest.pages) {
    const std = 'prototype-web/screenshots/' + p.id + '.png'
    if (!doc.includes(std)) warn('V4 主说明书未引用截图 ' + std)
  }
}

// ---------- 声明性文案（必须存在，防止被删） ----------
const requiredStatements = [
  ['非 AI 参考图声明', /不是\s*AI\s*生成的参考图|非\s*AI\s*参考图/],
  ['V3.1 保持不变', /V3\.1[\s\S]{0,40}保持不变|不被覆盖/],
  ['edge-tts 边界', /不是[\s\S]{0,30}Azure[\s\S]{0,20}正式商业/],
  ['思维链禁止', /不展示隐藏思维链|禁止展示思维链|不向用户展示隐藏思维链/],
  ['写操作禁止降级', /写操作[\s\S]{0,20}禁止[\s\S]{0,20}降级|禁止任何[\s\S]{0,10}降级/],
  ['处方类禁用词规范', /膳食处方[\s\S]{0,30}膳食参考/],
]
for (const [name, re] of requiredStatements) if (!re.test(doc)) fail('V4 主说明书缺少必要声明：' + name)

// ---------- 禁用词扫描（只扫提示词正文区域，避免误伤"禁用词表"本身）----------
const promptRegion = doc.slice(doc.indexOf('## 8. 24 页页面提示词'))
const forbidden = ['膳食处方', '调理处方', '用药指导', 'AI 医生', '精准诊断', '治愈率', '疗效保证', '思考链']
for (const w of forbidden) {
  // 允许出现在否定语境（禁用/禁止/不得/改为/不使用/不展示/不出现）的同一行里
  const lines = promptRegion.split(/\r?\n/).filter((l) => l.includes(w))
  const bad = lines.filter((l) => !/禁用|禁止|不得|改为|替换|非处方|不使用|不展示|不出现|不用/.test(l))
  if (bad.length) fail(`提示词正文出现禁用词「${w}」 ${bad.length} 处`)
}

// ---------- docs/v4 齐全 ----------
const expectedDocs = [
  '01-上线审查与整改清单.md',
  '02-页面数据与交互契约.md',
  '03-Spring-Boot业务后端开发指南.md',
  '04-FastAPI-AI后端开发指南.md',
  '05-部署运维与低配优化.md',
  '06-测试矩阵与发布检查表.md',
  '07-隐私数据流与保留策略.md',
]
for (const f of expectedDocs) if (!fs.existsSync(path.join(V4DIR, f))) fail('缺少 docs/v4/' + f)

// ---------- 后端实施开工（2026-10-14 起，见 docs/v4/08）：骨架按里程碑允许存在 ----------
// 原「本轮不生产骨架」告警已废弃；改为「未交付即提示」：目录缺失才提示，不阻断。
for (const [dir, owner] of [['business-service', 'Agent-M'], ['ai-service', 'Agent-D']]) {
  if (!fs.existsSync(path.join(ROOT, 'backend', dir))) warn('backend/' + dir + ' 尚未交付（' + owner + '）——见 docs/v4/08-后端实施双Agent总纲.md')
}

// ---------- V3.1 完整性 ----------
if (!fs.existsSync(V31)) fail('V3.1 原文件缺失（禁止删除或覆盖）')
else {
  const st = fs.statSync(V31)
  if (st.size < 10000) fail('V3.1 原文件疑似被截断，大小 ' + st.size)
}

// ---------- 输出 ----------
if (errors.length) {
  console.error('DOC_CHECK_FAIL ' + errors.length)
  errors.forEach((e) => console.error(' - ' + e))
  warnings.forEach((w) => console.warn(' WARN ' + w))
  process.exit(1)
}
console.log(
  `DOC_CHECK_OK routes=${routes.length} prompts=${promptSections} docs=${expectedDocs.length} warnings=${warnings.length}`
)
warnings.forEach((w) => console.warn('WARN ' + w))
