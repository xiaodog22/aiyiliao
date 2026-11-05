#!/usr/bin/env node
/**
 * 前后端契约快照（2026-11-01）。
 *
 * 解决的问题：前端读 `doctor.slotStatus`，后端某天改成 `slotState` —— 编译通过、单测通过、
 * 后端契约测试也通过（后端自己的 DTO 改名了，测试跟着改），只有**真机上页面一片空白**。
 * 中间这条缝没有任何自动化防线。
 *
 * 为什么不是 Pact：本项目的消费者是**微信小程序原生栈**，`wx.request` 走原生桥、不经 Node HTTP 栈，
 * Pact 的 mock server 拦不住它（真机也不走本机回环）。Pact Broker 还要额外部署。
 * 契约测试 90% 的价值来自"字段改名能被 CI 拦住"，不是"用了 Pact"——所以用快照实现同等防线。
 *
 * 快照比什么（关键设计）：
 *   - **比字段集**：快照里有、实际没有 → FAIL（删字段/改名，正是要抓的）
 *   - **比类型**：`string` → `number` → FAIL（前端 NaN / 渲染错位）
 *   - **比数组元素形状**：取首元素代表，空数组单独标记（避免"今天没数据"变成快照差异）
 *   - ⚠️ **不比具体值**：id / createdAt / remainingSlots 每次都在变。比值的话快照天天红，
 *     团队会习惯性 --update，契约就退化成橡皮图章（这是快照类测试最常见的死法）
 *   - **新增字段 → 只 WARN 不 FAIL**：后端加字段是兼容变更，不该阻断 CI；
 *     但必须打印出来，让 reviewer 看到"契约变宽了"
 *
 * 用法：
 *   node tools/contract-snapshot.js --token=<accessToken>            # 校验（CI 用，FAIL 则 exit 1）
 *   node tools/contract-snapshot.js --token=<token> --update         # 更新快照（会先打印 diff）
 *   node tools/contract-snapshot.js --token=<token> --only=doctors   # 只校验单个端点
 *
 * ⚠️ `--update` 必须人工 review：本脚本会先打印"新增/删除/类型变化"三组差异再落盘，
 *    不要把它挂到无人值守的流水线里，否则等于没有契约。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SNAPSHOT_DIR = path.join(ROOT, 'contracts', 'snapshots')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const BASE = arg('base', 'http://127.0.0.1:8080')
const UPDATE = flag('update')
const ONLY = arg('only', null)

/**
 * 受契约保护的端点。只挑**前端真实消费且字段多**的只读端点：
 * 全量覆盖会让快照维护成本超过收益，这三个是患者端首屏强依赖。
 */
const ENDPOINTS = [
  { slug: 'doctors', label: 'GET /api/v1/doctors', path: '/api/v1/doctors' },
  { slug: 'appointments-me', label: 'GET /api/v1/appointments/me', path: '/api/v1/appointments/me' },
  { slug: 'home-summary', label: 'GET /api/v1/home/summary', path: '/api/v1/home/summary' },
  { slug: 'messages-unread', label: 'GET /api/v1/messages/unread-count', path: '/api/v1/messages/unread-count' },
  { slug: 'me', label: 'GET /api/v1/me', path: '/api/v1/me' },
]

/** 数组统一表示成 {"$array": <元素形状>}，避免与业务字段混淆。 */
const ARRAY_KEY = '$array'

/**
 * 形状提取：值 → 类型骨架。
 * 数字/布尔/字符串一律只留类型名；null 单独标记（前端对 null 与 undefined 的处理常不同）。
 */
function shapeOf(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) {
    return value.length ? { [ARRAY_KEY]: shapeOf(value[0]) } : { [ARRAY_KEY]: 'empty' }
  }
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = shapeOf(value[k])
    return out
  }
  return typeof value
}

function typeName(node) {
  if (Array.isArray(node)) return 'array'
  if (node === null) return 'null'
  if (typeof node === 'object') return node[ARRAY_KEY] !== undefined ? 'array' : 'object'
  return String(node)
}

/** 递归比对，把差异分三类收集（缺失=破坏性，新增=兼容，类型变化=破坏性）。 */
function compare(expected, actual, at, acc) {
  const eType = typeName(expected)
  const aType = typeName(actual)
  if (eType !== aType) {
    acc.typeChanged.push(`${at}: ${eType} → ${aType}`)
    return
  }
  if (eType === 'array') {
    const eEl = expected[ARRAY_KEY]
    const aEl = actual[ARRAY_KEY]
    // 一侧为空数组时不比元素形状：数据从 0 条变 1 条是数据变化，不是契约变化
    if (eEl === 'empty' || aEl === 'empty') return
    compare(eEl, aEl, `${at}[]`, acc)
    return
  }
  if (eType === 'object') {
    for (const k of Object.keys(expected)) {
      if (!(k in actual)) acc.missing.push(`${at}.${k}`)
      else compare(expected[k], actual[k], `${at}.${k}`, acc)
    }
    for (const k of Object.keys(actual)) {
      if (!(k in expected)) acc.added.push(`${at}.${k}`)
    }
    return
  }
  // 基本类型：类型一致即通过，**不比值**
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Platform': 'wechat-miniprogram',
      'X-Client-Version': '4.0.0',
    },
  })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch (e) {
    body = { __unparsable: text.slice(0, 200) }
  }
  return { status: res.status, body }
}

function snapshotPath(slug) {
  return path.join(SNAPSHOT_DIR, `${slug}.shape.json`)
}

async function main() {
  const token = arg('token', null)
  if (!token) {
    console.error('[contract] 缺少 --token=<accessToken>。用法见文件头注释。')
    process.exit(2)
  }

  const targets = ONLY ? ENDPOINTS.filter((e) => e.slug === ONLY) : ENDPOINTS
  if (!targets.length) {
    console.error(`[contract] --only=${ONLY} 未匹配任何端点`)
    process.exit(2)
  }

  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })

  let failed = 0
  let warned = 0
  let created = 0

  for (const ep of targets) {
    const { status, body } = await fetchJson(BASE + ep.path, token)
    if (status !== 200 || !body || body.code !== 'OK') {
      console.error(`[contract] ✗ ${ep.label} 无法取到 OK 响应（HTTP ${status}, code=${body && body.code}）`)
      console.error('           先确认服务健康与 token 有效；把环境问题当成契约失败会误导排障。')
      process.exit(2)
    }

    // 只对 data 做形状（信封的 code/message 由全局契约测试保证）
    const shape = shapeOf(body.data)
    const file = snapshotPath(ep.slug)

    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `${JSON.stringify(shape, null, 2)}\n`, 'utf8')
      console.log(`[contract] + ${ep.label} 首次建立快照 → ${path.relative(ROOT, file)}`)
      created += 1
      continue
    }

    const expected = JSON.parse(fs.readFileSync(file, 'utf8'))
    const acc = { missing: [], added: [], typeChanged: [] }
    compare(expected, shape, 'data', acc)

    const hasBreaking = acc.missing.length || acc.typeChanged.length
    if (UPDATE) {
      // --update 也先打印差异：reviewer 必须看到"哪些字段消失了"，否则等于静默改契约
      if (hasBreaking || acc.added.length) {
        console.log(`[contract] ~ ${ep.label} 快照变更：`)
        for (const m of acc.missing) console.log(`    - 移除字段 ${m}`)
        for (const a of acc.added) console.log(`    + 新增字段 ${a}`)
        for (const t of acc.typeChanged) console.log(`    ! 类型变化 ${t}`)
      }
      fs.writeFileSync(file, `${JSON.stringify(shape, null, 2)}\n`, 'utf8')
      console.log(`[contract] ~ ${ep.label} 快照已更新`)
      continue
    }

    if (hasBreaking) {
      failed += 1
      console.error(`[contract] ✗ ${ep.label} 契约破坏：`)
      for (const m of acc.missing) console.error(`    - 字段消失 ${m}  ← 前端会读到 undefined`)
      for (const t of acc.typeChanged) console.error(`    ! 类型变化 ${t}`)
    } else if (acc.added.length) {
      warned += 1
      console.warn(`[contract] ⚠ ${ep.label} 契约变宽（兼容变更，不阻断）：`)
      for (const a of acc.added) console.warn(`    + 新增字段 ${a}`)
    } else {
      console.log(`[contract] ✓ ${ep.label}`)
    }
  }

  console.log(`\n[contract] 汇总：破坏 ${failed} / 变宽 ${warned} / 新建 ${created}`)
  if (failed) {
    console.error('[contract] 结论：FAIL（字段消失或类型变化必须人工确认；'
      + '确认是刻意变更后跑 --update 并在 review 里说明）')
    process.exit(1)
  }
  console.log('[contract] 结论：PASS')
  process.exit(0)
}

main().catch((e) => {
  console.error(`[contract] 未预期错误：${e.message}`)
  process.exit(2)
})
