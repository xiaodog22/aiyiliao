#!/usr/bin/env node
/**
 * check-docs.js —— 交付文档静态核验（2026-11-28）
 *
 * 用途：对 设计交付_20261128 下的两份正式文档做可自动化的体检：
 *   1) 反引号里的仓库相对路径是否存在（排除选择器、命令、URL、变量）
 *   2) 是否出现红线词（诊断/治疗/处方/医疗器械/准确率/节省…）
 *   3) 是否残留 TODO/待补充/XXX
 *   4) emoji 图标（白名单外）
 *   5) 标题层级是否跳级、表格列数是否稳定
 *   6) 必备章节是否齐全
 *
 * 用法：node 设计交付_20261128/06_验证记录/check-docs.js
 * 退出码：0 全过；1 有 FAIL（WARN 不影响退出码）
 */
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const DOCS = [
  '设计交付_20261128/03_创意设计/康诊云_创意设计文档_20261128.md',
  '设计交付_20261128/05_说明文档/康诊云_设计说明书_20261128.md',
  '设计交付_20261128/05_说明文档/康诊云_项目说明文档_20261128.md',
]

// level：FAIL = 一定违规；WARN = 需人工看上下文（文档里说明"不做什么"时会合法出现）
const RED_WORDS = [
  ['诊断', /(?:AI\s*)?诊断/g, 'WARN'],
  ['治疗', /治疗/g, 'WARN'],
  ['处方', /处方/g, 'WARN'],
  ['医疗器械', /医疗器械/g, 'WARN'],
  ['准确率', /准确率/g, 'FAIL'],
  ['节省时间', /节省(?:了)?\s*\d+\s*(?:分钟|秒|小时)/g, 'FAIL'],
  ['真实院名', /(?:人民医院|中心医院|附属医院|协和医院|华西医院|湘雅医院)/g, 'FAIL'],
]
// 出现这些词说明该句在"禁止/边界"语境，降级为 NOTE（只打印，不计数）
const NEGATION = /(不(?:做|写|出现|宣称|用于|含|得|能|会|是)|禁止|避免|勿|非医疗|免责|边界|红线|否决|不承诺|不输出)/

// 只写「第 N 章 / 第 N 节 / 附录 X」，实际匹配任意级别标题，容忍 ## 或 ###
const REQUIRED = {
  '康诊云_创意设计文档_20261128.md': [
    '第 0 章', '第 1 章', '第 2 章', '第 3 章',
    '第 4 章', '第 5 章', '第 6 章', '第 7 章',
  ],
  '康诊云_设计说明书_20261128.md': [
    '第 0 节', '第 1 节', '第 2 节', '第 3 节',
    '第 4 节', '第 5 节', '第 6 节',
    '附录 A', '附录 B', '附录 C', '附录 D',
  ],
  '康诊云_项目说明文档_20261128.md': [
    '第 1 章', '第 2 章', '第 3 章', '第 4 章', '第 5 章',
    '第 6 章', '第 7 章', '第 8 章', '第 9 章', '第 10 章',
  ],
}

const CMD_PREFIX = /^(node|npm|pnpm|git|python|curl|cd|ls|grep|wc|find|echo|sed|awk)\b/
const NOT_PATH = /^(?:\.|#|@|\/\/)|^https?:|^[A-Za-z-]+$|^--|\s/

let fail = 0
let warn = 0
const problems = []

function add(level, doc, msg) {
  problems.push({ level, doc, msg })
  if (level === 'FAIL') fail++
  else warn++
}

for (const rel of DOCS) {
  const abs = path.join(ROOT, rel)
  const name = path.basename(rel)
  if (!fs.existsSync(abs)) {
    add('FAIL', name, '文件不存在：' + rel)
    continue
  }
  const text = fs.readFileSync(abs, 'utf8')
  const lines = text.split(/\r?\n/)

  // 1) 路径存在性
  const ticked = [...text.matchAll(/`([^`\n]{3,120})`/g)].map((m) => m[1].trim())
  const checked = new Set()
  for (const tok of ticked) {
    if (!/[/\\]/.test(tok)) continue
    if (CMD_PREFIX.test(tok) || NOT_PATH.test(tok)) continue
    if (/[*?{}]/.test(tok)) continue
    if (/^[.#]/.test(tok)) continue
    // HTTP 路由与接口路径（/api/...、/openapi/...）不是仓库文件，跳过存在性检查
    if (/^\/(?:api|openapi|gw)\//.test(tok)) continue
    const clean = tok.replace(/[，。；：、)）]+$/, '').replace(/:\d+(?:-\d+)?$/, '')
    if (checked.has(clean)) continue
    checked.add(clean)
    // 路由简写（pages/triage/triage、auth/login）在文档里不带扩展名，按小程序页面逐项展开
    const EXTS = ['.wxml', '.js', '.json', '.wxss']
    const candidates = [clean, 'miniprogram/' + clean, '设计交付_20261128/' + clean, 'miniprogram/pages/' + clean]
    for (const base of ['miniprogram/', 'miniprogram/pages/']) {
      for (const ext of EXTS) candidates.push(base + clean + ext)
    }
    if (!candidates.some((p) => fs.existsSync(path.join(ROOT, p)))) {
      add('WARN', name, '路径可能不存在：' + clean)
    }
  }

  // 2) 红线词
  for (const [label, re, level] of RED_WORDS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split(/\n/).length
      const ctx = lines[line - 1].trim()
      const near = text.slice(Math.max(0, m.index - 30), m.index + 30)
      if (NEGATION.test(ctx) || NEGATION.test(near)) continue
      add(level, name, `红线词「${label}」L${line}：${ctx.slice(0, 90)}`)
      if (re.lastIndex === m.index) re.lastIndex++
    }
  }

  // 3) 残留
  for (const bad of ['TODO', '待补充', 'XXX', 'TBD', '（略）']) {
    if (text.includes(bad)) add('FAIL', name, '残留占位：' + bad)
  }

  // 4) emoji（排除箭头、勾叉、圆圈等常用符号）
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu
  const emojiAllow = new Set(['✓', '✗', '✔', '✘', '→', '←', '↑', '↓', '·', '—', '×', '≤', '≥', '⚠'])
  let em
  while ((em = emojiRe.exec(text))) {
    if (emojiAllow.has(em[0])) continue
    const line = text.slice(0, em.index).split(/\n/).length
    add('WARN', name, `emoji/符号 L${line}：${em[0]}`)
  }

  // 5) 标题跳级
  let prev = 1
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+/.exec(l)
    if (!m) return
    const lv = m[1].length
    if (lv > prev + 1) add('WARN', name, `标题跳级 L${i + 1}：${l.slice(0, 40)}`)
    prev = lv
  })

  // 6) 必备章节
  for (const h of REQUIRED[name] || []) {
    const SP = String.fromCharCode(92) + 's*'
    const re = new RegExp('^#{1,3}' + SP + h.split(' ').join(SP), 'm')
    if (!re.test(text)) add('FAIL', name, '缺章节：' + h)
  }

  // 7) 表格列数一致性（同一表内）
  let headerCols = 0
  let inTable = false
  lines.forEach((l, i) => {
    if (/^\s*\|/.test(l)) {
      const cols = l.trim().replace(/^\||\|$/g, '').split('|').length
      if (!inTable) {
        inTable = true
        headerCols = cols
      } else if (cols !== headerCols && !/^\s*\|[\s:|-]+\|\s*$/.test(l)) {
        add('WARN', name, `表格列数 L${i + 1}：${cols} ≠ 表头 ${headerCols}`)
      }
    } else {
      inTable = false
    }
  })

  // 8) 题注编号重复（图 x-y / 表 x-y）
  const caps = [...text.matchAll(/^(?:图|表)\s*(\d+)-(\d+)/gm)].map((m) => m[0])
  const dup = caps.filter((c, i) => caps.indexOf(c) !== i)
  if (dup.length) add('WARN', name, '题注编号重复：' + [...new Set(dup)].join('、'))

  const chars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  console.log(`· ${name}：${chars} 汉字，${lines.length} 行`)
}

console.log('\n—— 结果 ——')
for (const p of problems) console.log(`${p.level} [${p.doc}] ${p.msg}`)
console.log(`\nFAIL=${fail} WARN=${warn}`)
process.exit(fail ? 1 : 0)
