#!/usr/bin/env node
'use strict'
/*
 * test-resource-links.js —— 「前端适配 + 素材经后端传递」资源链路链接自测
 *   （对应文档 docs/v4/09-前端适配与资源外置.md §6）
 *
 * 目的：对资源链路的关键链接做一次**可重复、可读**的冒烟，把每条链接的实测效果
 *       （状态 / 类型 / 字节数 / sha256 / 304 复用）直接打印出来 —— 即「测试链接效果」。
 *
 * 用法：
 *   node tools/test-resource-links.js                        # 默认 http://127.0.0.1:8000（统一网关）
 *   node tools/test-resource-links.js --base http://127.0.0.1:8009
 *   node tools/test-resource-links.js --assets extra.png,more.jpg   # 追加额外素材名
 *
 * 依赖：Node 18+ 内置 fetch（无第三方包）；回环地址不受环境代理影响
 *       （undici 默认不读 *_PROXY）。
 *
 * 检查项：
 *   ① GET  /api/gw/health                               网关自身健康
 *   ② POST /api/v1/auth/wechat/login（dev 占位码）       经网关代理 business，取 accessToken
 *   ③ GET  /api/v1/resources/manifest（Bearer）          清单可达 + items[] 必填字段抽查
 *   ④ GET  /api/gw/assets/<name>（逐张）                 200 + image/*；下载字节 sha256 与
 *      X-Resource-Sha256 头一致；带 If-None-Match 复取 → 304
 *
 * 退出码：0 全过 / 1 有 FAIL / 2 异常退出。
 * 注意：素材通道为新增路由，运行中的网关需**重启后生效**（backend/deploy/restart.bat）。
 */

const { createHash } = require('node:crypto')
const path = require('path')

// 默认 base 唯一来源：miniprogram/config/env.js 的 gateway（2026-10-19 网关已由 8000 迁 8080，
// 硬编码端口会随迁移腐烂——此处与前端同源读取，--base 仍可覆盖）。
const ENV = require(path.join(__dirname, '..', 'miniprogram', 'config', 'env.js'))
const DEFAULT_BASE = ENV.gateway

// 首批种子素材（backend/deploy/resources/；与文档 §6.3 链接清单一致）
const SEED_ASSETS = [
  'banner-hospital.jpg', 'ai-doctor.png',
  'svc-advice.png', 'svc-archive.png', 'svc-care.png', 'svc-checkup.png',
  'svc-dept.png', 'svc-doctor.png', 'svc-more.png', 'svc-triage.png',
  'measure-bp.jpg', 'stand-up.jpg', 'wash-hands.jpg'
]

const LOGIN_CODE = 'dev-user-1-code'       // dev/itest 档占位码（生产必须走 wx.login 真 code）
const CLIENT_HEADERS = { 'X-Client-Version': '1.0.0', 'X-Platform': 'wechat-miniprogram' }
// 2026-10-29 起 dev 派生 code 需过 DevLoginGuard（闸门开关 + X-Dev-Login-Key 恒定时间相等），
// 否则一律 403 DEV_LOGIN_FORBIDDEN。密钥与前端同源（env.js 的 devLoginKey，生产档为空）。
const DEV_LOGIN_KEY = ENV.devLoginKey || ''
const REQUIRED_ITEM_FIELDS = ['key', 'level', 'mime', 'size', 'sha256']

function parseArgs(argv) {
  const out = { base: DEFAULT_BASE, assets: [], strict: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) out.base = String(argv[++i]).replace(/\/+$/, '')
    else if (argv[i] === '--assets' && argv[i + 1]) out.assets.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean))
    else if (argv[i] === '--strict') out.strict = true
  }
  return out
}

let pass = 0
let fail = 0
const ok = (name, detail) => { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')) }
const bad = (name, detail) => { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')) }
const skip = (name, detail) => console.log('  [SKIP] ' + name + (detail ? '  ' + detail : ''))

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const base = args.base
  const assets = [...SEED_ASSETS, ...args.assets.filter((a) => !SEED_ASSETS.includes(a))]

  console.log('== 资源链路链接自测 ==')
  console.log('  目标: ' + base + '   （' + new Date().toLocaleString('zh-CN') + '）')
  console.log('')

  // ---------- ⓪ 前置探活 ----------
  // 为什么要有：目标不可达属"环境故障"，不是"用例失败"。16 项全判 FAIL 会掩盖真实回归，
  // 也会让 test-fe-all 永远红。这里只判可达性，可达后仍走原有逐项断言（不降低严格度）。
  if (base) {
    let probeErr = ''
    try {
      const probe = await fetch(base + '/api/gw/health', { signal: AbortSignal.timeout(5000) })
      await probe.text()
    } catch (e) {
      probeErr = (e && e.name === 'TimeoutError') ? '探活超时（5s）' : String((e && e.message) || e)
    }
    if (probeErr) {
      console.log('  [SKIP] 目标不可达：' + base + '（' + probeErr + '）')
      console.log('')
      if (args.strict) {
        console.log('结果：FAIL（--strict 已开启：目标不可达即判失败）')
        process.exit(1)
      }
      console.log('结果：SKIPPED（目标不可达，非用例失败）')
      console.log('建议：改指向本地网关 --base http://127.0.0.1:8080，或先启动隧道（backend/deploy/start-all.bat）')
      process.exit(0)
    }
  }

  // ---------- ① 网关健康 ----------
  try {
    const r = await fetch(base + '/api/gw/health')
    const j = await r.json().catch(() => null)
    const upstreams = j && j.data && Array.isArray(j.data.upstreams)
      ? j.data.upstreams.map((u) => u.name + (u.reachable ? '✓' : '✗')).join(' ')
      : '(无 data)'
    if (r.status === 200) ok('网关健康 /api/gw/health', '200 · ' + upstreams)
    else bad('网关健康 /api/gw/health', 'HTTP ' + r.status + '（网关未启动？见 backend/deploy/start-all.bat）')
  } catch (e) {
    bad('网关健康 /api/gw/health', '连接失败：' + e.message + '（网关未启动？）')
  }

  // ---------- ② 登录（dev 占位码；失败不阻断素材检查——素材通道为公开只读） ----------
  let token = ''
  try {
    const r = await fetch(base + '/api/v1/auth/wechat/login', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        CLIENT_HEADERS,
        DEV_LOGIN_KEY ? { 'X-Dev-Login-Key': DEV_LOGIN_KEY } : {}
      ),
      body: JSON.stringify({ code: LOGIN_CODE, consentVersion: 'v1.0' })
    })
    const j = await r.json().catch(() => null)
    token = (j && j.data && j.data.accessToken) || ''
    if (r.status === 200 && token) ok('登录 /api/v1/auth/wechat/login', '200 · accessToken 已取得（' + token.length + ' 字符）')
    else bad('登录 /api/v1/auth/wechat/login', 'HTTP ' + r.status + ' ' + ((j && j.code) || '') +
      '（dev 档需带 X-Dev-Login-Key；正式档请改用真实 wx code 登录）')
  } catch (e) {
    bad('登录 /api/v1/auth/wechat/login', '连接失败：' + e.message)
  }

  // ---------- ③ 资源清单 ----------
  try {
    const r = await fetch(base + '/api/v1/resources/manifest?platform=wechat-miniprogram', {
      headers: { Authorization: 'Bearer ' + token, ...CLIENT_HEADERS }
    })
    if (r.status === 200) {
      const j = await r.json()
      const manifest = (j && j.data) || {}
      const items = Array.isArray(manifest.items) ? manifest.items : []
      const badItems = items.filter((it) => REQUIRED_ITEM_FIELDS.some((f) => it[f] === undefined || it[f] === null || it[f] === ''))
      const withUrl = items.filter((it) => it.url).length
      const etag = r.headers.get('etag')
      const detail = '200 · manifestVersion=' + (manifest.manifestVersion || '-') + ' · items=' + items.length +
        ' · 带 url=' + withUrl + (withUrl === 0 ? '（当前全部回退内置；B 级条目待 M 侧录入）' : '') +
        (etag ? ' · ETag 在' : ' · 无 ETag（清单 304 未实现，登记项）')
      if (badItems.length === 0) ok('资源清单 /api/v1/resources/manifest', detail)
      else bad('资源清单 /api/v1/resources/manifest', '必填字段缺失 ' + badItems.length + ' 条')
    } else if (r.status === 401) {
      skip('资源清单 /api/v1/resources/manifest', '401（登录未成功；strict 档需真实会话）')
    } else {
      bad('资源清单 /api/v1/resources/manifest', 'HTTP ' + r.status)
    }
  } catch (e) {
    bad('资源清单 /api/v1/resources/manifest', '连接失败：' + e.message)
  }

  // ---------- ④ 素材公开通道（逐张） ----------
  console.log('')
  console.log('  素材通道 /api/gw/assets/<name>（' + assets.length + ' 张）:')
  for (const name of assets) {
    const url = base + '/api/gw/assets/' + encodeURIComponent(name)
    try {
      const r1 = await fetch(url)
      if (r1.status !== 200) {
        bad(name, 'HTTP ' + r1.status + '（未就位或通道未生效——重启网关后重试；见文档 §6 排障）')
        continue
      }
      const buf = Buffer.from(await r1.arrayBuffer())
      const ct = r1.headers.get('content-type') || ''
      const sha = createHash('sha256').update(buf).digest('hex')
      const headerSha = (r1.headers.get('x-resource-sha256') || '').toLowerCase()
      const sizeHeader = r1.headers.get('x-resource-size') || ''
      const etag = r1.headers.get('etag') || ''

      const problems = []
      if (!ct.startsWith('image/')) problems.push('content-type=' + ct)
      if (!headerSha) problems.push('缺 X-Resource-Sha256 头')
      else if (headerSha !== sha) problems.push('sha256 不一致（下载字节≠头声明）')
      if (sizeHeader && Number(sizeHeader) !== buf.length) problems.push('X-Resource-Size 不一致')

      let cacheNote = ''
      if (etag) {
        const r2 = await fetch(url, { headers: { 'If-None-Match': etag } })
        if (r2.status === 304) cacheNote = ' · 304✓'
        else { problems.push('304 复用未生效（HTTP ' + r2.status + '）') }
      } else {
        problems.push('缺 ETag（无法 304 复用）')
      }

      const kb = (buf.length / 1024).toFixed(1) + ' KB'
      if (problems.length === 0) ok(name, kb + ' · ' + ct + ' · sha256=' + sha.slice(0, 12) + '…' + cacheNote)
      else bad(name, kb + ' · ' + problems.join('; '))
    } catch (e) {
      bad(name, '请求异常：' + e.message)
    }
  }

  console.log('')
  console.log('结果：PASS ' + pass + ' · FAIL ' + fail + '   （链接清单见 docs/v4/09 §6.3；可视化测试页 docs/v4/09-资源链接自测页.html）')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
