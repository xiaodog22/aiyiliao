#!/usr/bin/env node
/**
 * perf-runner.js —— 零依赖 HTTP 压测执行器（闭合环 + 阶梯并发）
 *
 * 为什么不用 k6 / JMeter：本机未安装这两个二进制（实测 `k6: command not found`），
 * 为避免引入外部依赖与下载风险，用 Node 内置模块实现同等口径的执行器。
 * 口径与 k6 一致：每 VU 一条 keep-alive 连接、闭合环（无思考时间）、
 * 分位统计取全量样本、错误判定 = HTTP 非 2xx 或业务码非 OK（双重判定）。
 *
 * 用法：
 *   node tools/perf-runner.js --scenario=read --vu=10 --duration=45 --tag=load10
 *   node tools/perf-runner.js --scenario=smoke --duration=60
 *   node tools/perf-runner.js --scenario=login --vu=5 --duration=20
 *   node tools/perf-runner.js --scenario=ai --vu=1 --duration=1 --requests=1
 *
 * 参数：
 *   --base      网关地址，默认 http://127.0.0.1:8080
 *   --scenario  read | smoke | login | ai   默认 read
 *   --vu        并发数，默认 1
 *   --duration  持续秒数，默认 30
 *   --requests  ai 场景的请求总数，默认 1
 *   --tag       结果文件标记，默认 auto
 *   --out       结果目录，默认 artifacts/perf
 *   --timeout   单请求超时 ms，默认 10000
 *
 * ⚠️ 写操作：login 场景会创建会话行，只允许小样本执行。
 */

'use strict'

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// ---------- 参数解析 ----------
const argv = process.argv.slice(2)
const arg = (name, def) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return def
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1)
  const idx = argv.indexOf(hit)
  return argv[idx + 1] !== undefined ? argv[idx + 1] : def
}

const BASE = String(arg('base', 'http://127.0.0.1:8080')).replace(/\/$/, '')
const SCENARIO = String(arg('scenario', 'read'))
const VU = Math.max(1, parseInt(arg('vu', '1'), 10))
const DURATION = Math.max(1, parseInt(arg('duration', '30'), 10))
const REQUESTS = Math.max(1, parseInt(arg('requests', '1'), 10))
const TIMEOUT = Math.max(1000, parseInt(arg('timeout', '10000'), 10))
const OUT_DIR = path.resolve(process.cwd(), arg('out', 'artifacts/perf'))
const TAG = String(arg('tag', `${SCENARIO}-${VU}vu`))
// 已有令牌时跳过登录（登录接口有频控，重复登录会 429 污染结果）
const PRESET_TOKEN = String(arg('token', ''))

const isHttps = BASE.startsWith('https://')
const lib = isHttps ? https : http
const target = new URL(BASE)

// ---------- 开发态登录（仅用于获取 Bearer，不进入统计样本）----------
// 密钥不在这里复制一份：从唯一来源 miniprogram/config/env.js 读取，
// 否则 env.local 与前端同时换值时，压测会静默 403 DEV_LOGIN_FORBIDDEN。
let envConfig = {}
try {
  envConfig = require('../miniprogram/config/env.js')
} catch (e) {
  process.stderr.write(`[perf] 读取 config/env.js 失败：${e.message}（将退回环境变量）\n`)
}
const DEV_LOGIN_KEY = arg('dev-login-key', process.env.PERF_DEV_LOGIN_KEY || envConfig.devLoginKey || '')
const CONSENT_VERSION = envConfig.consentVersion || 'v1.0'
const BASE_HEADERS = {
  'X-Platform': 'wechat-miniprogram',
  'X-Client-Version': '4.0.0',
  'Accept': 'application/json'
}

const agent = new lib.Agent({ keepAlive: true, maxSockets: VU })

function request(method, pathname, { body, headers = {}, token } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const h = { ...BASE_HEADERS, ...headers }
    if (token) h.Authorization = `Bearer ${token}`
    if (payload) h['Content-Type'] = 'application/json'
    if (payload) h['Content-Length'] = payload.length

    const req = lib.request(
      { hostname: target.hostname, port: target.port, method, path: pathname, headers: h, agent, timeout: TIMEOUT },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6
          const text = Buffer.concat(chunks).toString('utf8')
          let bizCode = ''
          try {
            const parsed = JSON.parse(text)
            bizCode = parsed && typeof parsed.code === 'string' ? parsed.code : ''
          } catch (_) { /* 非 JSON 响应不参与业务码判定 */ }
          resolve({ status: res.statusCode, ms, bizCode, bytes: Buffer.byteLength(text), error: '' })
        })
      }
    )
    req.on('timeout', () => { req.destroy(new Error('TIMEOUT')) })
    req.on('error', (err) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      resolve({ status: 0, ms, bizCode: '', bytes: 0, error: err.code || err.message })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

// ---------- 场景定义 ----------
const READ_ENDPOINTS = [
  { key: 'home/summary', path: '/api/v1/home/summary', weight: 20 },
  { key: 'doctors', path: '/api/v1/doctors', weight: 20 },
  { key: 'appointments/me', path: '/api/v1/appointments/me', weight: 20 },
  { key: 'departments', path: '/api/v1/departments', weight: 15 },
  { key: 'messages', path: '/api/v1/messages', weight: 10 },
  { key: 'resources/manifest', path: '/api/v1/resources/manifest', weight: 5 },
  { key: 'me', path: '/api/v1/me', weight: 5 },
  { key: 'messages/unread-count', path: '/api/v1/messages/unread-count', weight: 5 }
]

const SMOKE_ENDPOINTS = [
  { key: 'gw/health', path: '/api/gw/health', weight: 1 },
  { key: 'me', path: '/api/v1/me', weight: 1 },
  { key: 'departments', path: '/api/v1/departments', weight: 1 },
  { key: 'doctors', path: '/api/v1/doctors', weight: 1 },
  { key: 'appointments/me', path: '/api/v1/appointments/me', weight: 1 },
  { key: 'resources/manifest', path: '/api/v1/resources/manifest', weight: 1 },
  { key: 'home/summary', path: '/api/v1/home/summary', weight: 1 },
  { key: 'messages', path: '/api/v1/messages', weight: 1 },
  { key: 'messages/unread-count', path: '/api/v1/messages/unread-count', weight: 1 },
  { key: 'consultations', path: '/api/v1/consultations', weight: 1 },
  { key: 'health-records', path: '/api/v1/health-records', weight: 1 },
  { key: 'family-members', path: '/api/v1/family-members', weight: 1 }
]

const LOGIN_ENDPOINT = {
  key: 'auth/wechat/login',
  path: '/api/v1/auth/wechat/login',
  method: 'POST',
  body: { code: 'dev-user-1', consentVersion: CONSENT_VERSION },
  headers: { 'X-Dev-Login-Key': DEV_LOGIN_KEY }
}

const AI_ENDPOINT = {
  key: 'case/recommend-department',
  path: '/api/v1/case/recommend-department',
  method: 'POST',
  body: { text: '最近三天咳嗽有痰，晚上有点低烧，想去医院看看该挂什么科' }
}

function buildPlan() {
  const list = SCENARIO === 'smoke' ? SMOKE_ENDPOINTS : SCENARIO === 'read' ? READ_ENDPOINTS : []
  const total = list.reduce((s, e) => s + e.weight, 0)
  let acc = 0
  return list.map((e) => { acc += e.weight; return { ...e, cum: acc / total } })
}

const PLAN = buildPlan()
function pick() {
  const r = Math.random()
  for (const e of PLAN) if (r <= e.cum) return e
  return PLAN[PLAN.length - 1]
}

// ---------- 统计 ----------
const stats = { samples: [], byKey: new Map(), errors: new Map(), aborted: false, abortReason: '', cpu: [], memFreeGb: [] }

// 主机级 CPU 采样（os.cpus() 差分，含全部核心；反映被压端 + 施压端合计占用）
function startCpuSampler() {
  const snap = () => os.cpus().reduce((a, c) => {
    const t = c.times
    a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq
    return a
  }, { idle: 0, total: 0 })
  let prev = snap()
  return setInterval(() => {
    const cur = snap()
    const dTotal = cur.total - prev.total
    const dIdle = cur.idle - prev.idle
    if (dTotal > 0) stats.cpu.push(Math.round((1 - dIdle / dTotal) * 1000) / 10)
    stats.memFreeGb.push(Math.round((os.freemem() / 1073741824) * 100) / 100)
    prev = cur
  }, 1000)
}

function record(key, r) {
  const ok = r.status >= 200 && r.status < 300 && (r.bizCode === '' ? true : r.bizCode === 'OK')
  const sample = { key, ms: r.ms, status: r.status, ok, bytes: r.bytes, error: r.error }
  stats.samples.push(sample)
  let bucket = stats.byKey.get(key)
  if (!bucket) { bucket = { lat: [], ok: 0, err: 0, bytes: 0, statuses: new Map() }; stats.byKey.set(key, bucket) }
  bucket.lat.push(r.ms)
  bucket.bytes += r.bytes
  bucket.statuses.set(r.status, (bucket.statuses.get(r.status) || 0) + 1)
  if (ok) bucket.ok += 1
  else {
    bucket.err += 1
    const tag = `${r.status || r.error || 'BIZ'}:${r.bizCode || ''}`
    stats.errors.set(tag, (stats.errors.get(tag) || 0) + 1)
  }
}

const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}
const round = (n) => Math.round(n * 10) / 10
// ⚠️ 不能用 Math.max(...arr)：样本可达 20 万条，展开会触发 RangeError 爆栈
const maxOf = (arr) => arr.reduce((m, n) => (n > m ? n : m), 0)

// ---------- 执行 ----------
let token = ''

async function fetchToken() {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(LOGIN_ENDPOINT.body))
    const req = lib.request({
      hostname: target.hostname, port: target.port, method: 'POST',
      path: LOGIN_ENDPOINT.path,
      headers: { ...BASE_HEADERS, ...LOGIN_ENDPOINT.headers, 'Content-Type': 'application/json', 'Content-Length': payload.length },
      agent, timeout: TIMEOUT
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const t = parsed?.data?.accessToken
          if (res.statusCode === 200 && t) resolve(t)
          else reject(new Error(`登录失败 HTTP ${res.statusCode} code=${parsed?.code}`))
        } catch (e) { reject(e) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function warmup() {
  for (let i = 0; i < 12; i++) {
    const ep = SCENARIO === 'login' ? LOGIN_ENDPOINT : SCENARIO === 'ai' ? AI_ENDPOINT : pick()
    await request(ep.method || 'GET', ep.path, { body: ep.body, headers: ep.headers, token })
  }
}

async function worker(vuId, deadline) {
  while (Date.now() < deadline && !stats.aborted) {
    let ep
    if (SCENARIO === 'login') ep = LOGIN_ENDPOINT
    else if (SCENARIO === 'ai') ep = AI_ENDPOINT
    else ep = pick()
    const r = await request(ep.method || 'GET', ep.path, { body: ep.body, headers: ep.headers, token })
    record(ep.key, r)
  }
}

async function runAi() {
  for (let i = 0; i < REQUESTS && !stats.aborted; i++) {
    const r = await request(AI_ENDPOINT.method, AI_ENDPOINT.path, { body: AI_ENDPOINT.body, token, })
    record(AI_ENDPOINT.key, r)
  }
}

function watchdog(startedAt) {
  const timer = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000
    const n = stats.samples.length
    if (n < 50 || elapsed < 10) return
    const err = stats.samples.filter((s) => !s.ok).length
    if (err / n > 0.2) {
      stats.aborted = true
      stats.abortReason = `错误率 ${((err / n) * 100).toFixed(1)}% > 20%（${n} 样本）`
    }
  }, 2000)
  return () => clearInterval(timer)
}

async function main() {
  process.stdout.write(`\n[perf] 目标=${BASE} 场景=${SCENARIO} 并发=${VU} 时长=${DURATION}s\n`)

  if (PRESET_TOKEN) {
    token = PRESET_TOKEN
    process.stdout.write(`[perf] 复用外部令牌 ${token.slice(0, 8)}…（跳过登录）\n`)
  } else if (SCENARIO !== 'login') {
    token = await fetchToken()
    process.stdout.write(`[perf] 登录成功，token 前缀 ${token.slice(0, 8)}…\n`)
  }

  const warmStart = Date.now()
  if (SCENARIO !== 'ai') await warmup()
  process.stdout.write(`[perf] 预热完成 ${Date.now() - warmStart}ms，开始正式计时\n`)

  const startedAt = Date.now()
  const deadline = startedAt + DURATION * 1000
  const stopWatch = watchdog(startedAt)
  const stopCpu = startCpuSampler()
  const boot = Number(process.hrtime.bigint() / 1000000n)

  if (SCENARIO === 'ai') await runAi()
  else await Promise.all(Array.from({ length: VU }, (_, i) => worker(i, deadline)))

  stopWatch()
  clearInterval(stopCpu)
  const wallClock = (Date.now() - startedAt) / 1000
  const all = stats.samples
  const okCount = all.filter((s) => s.ok).length
  const errCount = all.length - okCount
  const lat = all.map((s) => s.ms)

  const summary = {
    scenario: SCENARIO,
    base: BASE,
    vu: VU,
    durationSec: round(wallClock),
    runnerBootMs: Number(process.hrtime.bigint() / 1000000n) - boot,
    total: all.length,
    ok: okCount,
    errors: errCount,
    errorRatePct: all.length ? round((errCount / all.length) * 10000) / 100 : 0,
    rps: round(all.length / wallClock),
    bytesPerSec: round(all.reduce((s, x) => s + x.bytes, 0) / wallClock),
    aborted: stats.aborted,
    abortReason: stats.abortReason,
    latency: {
      avg: round(lat.reduce((a, b) => a + b, 0) / (lat.length || 1)),
      p50: round(pct(lat, 50)),
      p90: round(pct(lat, 90)),
      p95: round(pct(lat, 95)),
      p99: round(pct(lat, 99)),
      max: round(maxOf(lat))
    },
    errorTags: [...stats.errors.entries()].map(([tag, count]) => ({ tag, count })),
    host: {
      cpuAvgPct: round(stats.cpu.reduce((a, b) => a + b, 0) / (stats.cpu.length || 1)),
      cpuMaxPct: maxOf(stats.cpu),
      memFreeMinGb: stats.memFreeGb.length ? Math.min(...stats.memFreeGb) : null,
      memFreeEndGb: stats.memFreeGb.length ? stats.memFreeGb[stats.memFreeGb.length - 1] : null
    },
    endpoints: [...stats.byKey.entries()].map(([key, b]) => ({
      key,
      count: b.lat.length,
      ok: b.ok,
      err: b.err,
      avg: round(b.lat.reduce((a, c) => a + c, 0) / b.lat.length),
      p50: round(pct(b.lat, 50)),
      p95: round(pct(b.lat, 95)),
      p99: round(pct(b.lat, 99)),
      max: round(maxOf(b.lat)),
      avgBytes: Math.round(b.bytes / b.lat.length),
      statuses: Object.fromEntries(b.statuses)
    })).sort((a, b) => b.count - a.count),
    startedAt: new Date(startedAt).toISOString()
  }

  // 控制台表格
  process.stdout.write(`\n全局：请求 ${summary.total} | RPS ${summary.rps} | 错误 ${summary.errors} (${summary.errorRatePct}%) | P50 ${summary.latency.p50}ms P95 ${summary.latency.p95}ms P99 ${summary.latency.p99}ms max ${summary.latency.max}ms\n`)
  if (stats.aborted) process.stdout.write(`⚠️ 提前终止：${stats.abortReason}\n`)
  process.stdout.write(`主机：CPU 均值 ${summary.host.cpuAvgPct}% 峰值 ${summary.host.cpuMaxPct}% | 空闲内存最低 ${summary.host.memFreeMinGb}GB\n`)
  process.stdout.write('\n分端点：\n')
  for (const e of summary.endpoints) {
    process.stdout.write(`  ${e.key.padEnd(26)} n=${String(e.count).padStart(5)} p50=${String(e.p50).padStart(7)} p95=${String(e.p95).padStart(7)} p99=${String(e.p99).padStart(7)} max=${String(e.max).padStart(7)} err=${e.err} ${JSON.stringify(e.statuses)}\n`)
  }
  if (summary.errorTags.length) process.stdout.write(`\n错误分布：${JSON.stringify(summary.errorTags)}\n`)

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, `result-${TAG}.json`)
  fs.writeFileSync(file, JSON.stringify(summary, null, 2), 'utf8')
  process.stdout.write(`\n[perf] 结果已写入 ${file}\n`)
}

main().catch((err) => {
  process.stderr.write(`[perf] 失败：${err.message}\n`)
  process.exit(1)
})
