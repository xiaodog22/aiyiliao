/**
 * tools/test-auth-request.js —— 小程序鉴权链路桩测（纯 node，无第三方依赖）
 *
 * 运行：node tools/test-auth-request.js
 * 目的：把「401 联调修复」在小程序侧的关键承诺固化成可执行断言
 *   （tools/ 已在 project.config.json 的 packOptions.ignore 中，不会进小程序包）
 *
 * 覆盖：
 *  ① unwrap 认契约信封 code:"OK"（并保留 legacy 数字 200/0）
 *  ② 请求头：Bearer + X-Platform + X-Client-Version + Idempotency-Key
 *  ③ ensureAccessToken 三条分支（有 access / 只有 refresh → 单飞刷新 / 都没有 → 本地 reject 且零网络）
 *  ④ 401 → 最多刷新一次 → 重发（复用同一幂等键）；刷新失败 → 清会话 + AUTH_EXPIRED
 *  ⑤ refresh 本地 TTL：只按服务端 7 天，不受 expiresIn 影响
 *  ⑥ 匿名白名单：急诊 legacy 路径免登录；受保护路径未登录时本地拦截、不发网络
 */
const assert = require('assert')

// ---------------- wx 桩 ----------------
const store = {}
let calls = []        // 网络调用记录
let handler = null    // (opts) => ({ statusCode, data }) | { fail: {errMsg} }

global.wx = {
  getStorageSync(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : '' },
  setStorageSync(k, v) { store[k] = v },
  removeStorageSync(k) { delete store[k] },
  request(opts) {
    calls.push({ url: opts.url, method: opts.method, header: opts.header || {}, data: opts.data })
    Promise.resolve().then(() => {
      const r = handler(opts)
      // ⚠️ 必须回调 complete（真实 wx.request 一定会回调；request.js 的 refreshPromise 就靠它复位）
      try {
        if (r && r.fail) opts.fail(r.fail)
        else opts.success(r)
      } finally {
        if (opts.complete) opts.complete({})
      }
    })
  },
  uploadFile(opts) {
    calls.push({ url: opts.url, method: 'UPLOAD', header: opts.header || {} })
    Promise.resolve().then(() => {
      opts.fail({ errMsg: 'stub: not used in this test' })
      if (opts.complete) opts.complete({})
    })
  }
}

const req = require('../services/request.js')
const session = require('../services/session.js')
const API = req.API
const ENV = req.ENV

const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60
const nowSec = () => Math.floor(Date.now() / 1000)

let pass = 0
let fail = 0
function ok(name) { pass++; console.log('  PASS  ' + name) }
function bad(name, e) { fail++; console.log('  FAIL  ' + name + '  → ' + (e && (e.stack || e.message) || e)) }

async function check(name, fn) {
  try { await fn(); ok(name) } catch (e) { bad(name, e) }
}

// 发一个「业务请求」并返回结果（不抛错，返回 {ok, value, err}）
function send(spec, opts) {
  return req.get(spec, null, opts).then(
    (value) => ({ ok: true, value }),
    (err) => ({ ok: false, err })
  )
}

function resetSession() {
  session.clear()
  delete store.wb_refresh_token
  delete store.wb_refresh_expires_at
  delete store.wb_role_hint
}

/** 模拟「冷启动」：内存 access 为空、storage 里只有上次持久化的 refresh */
function simulateColdStart(refreshToken) {
  session.clear()
  store.wb_refresh_token = refreshToken
  store.wb_refresh_expires_at = nowSec() + REFRESH_TTL_SECONDS
}

const SESSION_OK = {
  statusCode: 200,
  data: {
    code: 'OK', message: '成功', data: {
      accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 7200, tokenType: 'Bearer',
      user: { id: 'u-1', displayName: '测试用户甲', roles: ['PATIENT'], phoneBound: true }
    }
  }
}

async function main() {
  console.log('== ① unwrap 认契约信封 ==')
  await check('契约 code:"OK" 且带 data → 返回 data', async () => {
    resetSession()
    session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
    handler = () => ({ statusCode: 200, data: { code: 'OK', message: '成功', data: [{ id: 1 }] } })
    const r = await send(API.APPOINT_LIST)
    assert.strictEqual(r.ok, true, '应成功解包，实际 ' + JSON.stringify(r.err || r.value))
    assert.deepStrictEqual(r.value, [{ id: 1 }])
  })

  await check('契约 code:"OK" 无 data → 返回整个信封', async () => {
    handler = () => ({ statusCode: 200, data: { code: 'OK', message: '成功' } })
    const r = await send(API.ME)
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.value.code, 'OK')
  })

  await check('legacy 适配器仍回 code:200 → 返回 data（不回归）', async () => {
    handler = () => ({ statusCode: 200, data: { code: 200, msg: '成功', data: { name: '甲', userId: 'u-1' } } })
    const r = await send(API.DOCTOR_LIST)
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.value.userId, 'u-1')
  })

  console.log('== ② 请求头 ==')
  await check('Bearer + 契约头 + 追踪头', async () => {
    resetSession()
    session.setTokens({ accessToken: 'at-hdr', refreshToken: 'rt-hdr', expiresIn: 7200 })
    handler = () => ({ statusCode: 200, data: { code: 'OK', data: [] } })
    calls = []
    await send(API.APPOINT_LIST)
    const h = calls[calls.length - 1].header
    assert.strictEqual(h.Authorization, 'Bearer at-hdr')
    assert.strictEqual(h['X-Platform'], 'wechat-miniprogram')
    assert.strictEqual(h['X-Client-Version'], ENV.clientVersion)
    assert.ok(h['X-Request-Id'] && h['X-Request-Id'].length >= 8, 'X-Request-Id 应有值且 ≥8')
    assert.ok(!!h['ngrok-skip-browser-warning'] === !ENV.isProduction, '隧道跳过头只在非生产出现')
  })

  await check('幂等键出现在写请求头（长度 8~128）', async () => {
    handler = () => ({ statusCode: 200, data: { code: 'OK', data: {} } })
    calls = []
    await req.post(API.APPOINT_SUBMIT, { dept: '内科' }, { idempotencyKey: 'ik-fixed-0001' })
    const h = calls[calls.length - 1].header
    assert.strictEqual(h['Idempotency-Key'], 'ik-fixed-0001')
    const gen = req.newIdempotencyKey()
    assert.ok(gen.length >= 8 && gen.length <= 128, '自动生成的幂等键长度须在 8~128：' + gen)
  })

  console.log('== ③ ensureAccessToken 三条分支 ==')
  await check('有 access → 直接放行', async () => {
    resetSession()
    session.setTokens({ accessToken: 'at-a', refreshToken: 'rt-a', expiresIn: 7200 })
    assert.strictEqual(await req.ensureAccessToken(), true)
  })

  await check('只有 refresh（冷启动）→ 先刷新再发业务请求，只发 1 次业务请求、无 401', async () => {
    simulateColdStart('rt-cold')
    calls = []
    handler = (opts) => {
      if (opts.url.indexOf(API.AUTH_REFRESH.path) >= 0) return SESSION_OK
      return { statusCode: 200, data: { code: 'OK', data: [] } }
    }
    const r = await send(API.APPOINT_LIST)
    assert.strictEqual(r.ok, true)
    const urls = calls.map((c) => c.url)
    const refreshCount = urls.filter((u) => u.indexOf(API.AUTH_REFRESH.path) >= 0).length
    const bizCount = urls.filter((u) => u.indexOf(API.APPOINT_LIST.path) >= 0).length
    assert.strictEqual(refreshCount, 1, '应恰好刷新 1 次，实际 ' + refreshCount)
    assert.strictEqual(bizCount, 1, '业务请求应只发 1 次，实际 ' + bizCount)
    assert.strictEqual(session.getAccessToken(), 'at-new', '刷新得到的 access 应已生效')
    assert.strictEqual(calls[calls.length - 1].header.Authorization, 'Bearer at-new')
  })

  await check('无 access 无 refresh → 本地 reject AUTH_REQUIRED 且零网络调用', async () => {
    resetSession()
    calls = []
    handler = () => { throw new Error('不应发出任何网络请求') }
    const r = await send(API.APPOINT_LIST)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.err.code, 'AUTH_REQUIRED')
    assert.strictEqual(calls.length, 0, '不应发网络，实际 ' + calls.length)
  })

  console.log('== ④ 401 刷新一次 + 失败清会话 ==')
  await check('401 → 刷新一次 → 重发，且复用同一幂等键', async () => {
    resetSession()
    session.setTokens({ accessToken: 'at-old', refreshToken: 'rt-ok', expiresIn: 7200 })
    calls = []
    let bizSeen = 0
    handler = (opts) => {
      if (opts.url.indexOf(API.AUTH_REFRESH.path) >= 0) return SESSION_OK
      bizSeen++
      if (bizSeen === 1) return { statusCode: 401, data: { code: 'UNAUTHORIZED', message: '未登录或登录态无效' } }
      return { statusCode: 200, data: { code: 'OK', data: { ok: true } } }
    }
    const r = await req.post(API.APPOINT_SUBMIT, { x: 1 }, { idempotencyKey: 'ik-reuse-01' })
    assert.strictEqual(r.ok, true, '刷新后重发应成功')
    const bizCalls = calls.filter((c) => c.url.indexOf(API.APPOINT_SUBMIT.path) >= 0)
    const refreshCalls = calls.filter((c) => c.url.indexOf(API.AUTH_REFRESH.path) >= 0)
    assert.strictEqual(refreshCalls.length, 1, '最多刷新一次')
    assert.strictEqual(bizCalls.length, 2, '业务请求应重发一次（共 2 次）')
    assert.strictEqual(bizCalls[0].header['Idempotency-Key'], 'ik-reuse-01')
    assert.strictEqual(bizCalls[1].header['Idempotency-Key'], 'ik-reuse-01', '重试必须复用同一幂等键')
  })

  await check('刷新失败 → 清会话 + AUTH_EXPIRED', async () => {
    resetSession()
    session.setTokens({ accessToken: 'at-old2', refreshToken: 'rt-bad', expiresIn: 7200 })
    calls = []
    handler = (opts) => {
      if (opts.url.indexOf(API.AUTH_REFRESH.path) >= 0) {
        return { statusCode: 401, data: { code: 'SESSION_REVOKED', message: '刷新令牌无效' } }
      }
      return { statusCode: 401, data: { code: 'UNAUTHORIZED', message: '未登录或登录态无效' } }
    }
    const r = await send(API.APPOINT_LIST)
    assert.strictEqual(r.ok, false)
    assert.ok(['AUTH_EXPIRED', 'SESSION_REVOKED'].indexOf(r.err.code) >= 0, '应给出会话类错误码，实际 ' + r.err.code)
    assert.strictEqual(session.getAccessToken(), '', 'access 应被清空')
    assert.strictEqual(wx.getStorageSync('wb_refresh_token'), '', 'refresh 应被清空')
  })

  console.log('== ⑤ refresh 本地 TTL（只按服务端 7 天）==')
  await check('setTokens 后 refresh 过期 ≈ now+7 天，且不随 expiresIn 变化', async () => {
    resetSession()
    session.setTokens({ accessToken: 'at-t1', refreshToken: 'rt-t1', expiresIn: 7200 })
    const exp1 = wx.getStorageSync('wb_refresh_expires_at')
    assert.ok(Math.abs(exp1 - (nowSec() + REFRESH_TTL_SECONDS)) <= 5,
      'refresh 过期应为 now+7d，实际差 ' + (exp1 - nowSec()) + ' 秒')
    // 故意给一个巨大的 expiresIn / 伪造的延长字段：都不得延长 refresh
    session.setTokens({ accessToken: 'at-t2', refreshToken: 'rt-t2', expiresIn: 99999999, refreshExpiresIn: 99999999 })
    const exp2 = wx.getStorageSync('wb_refresh_expires_at')
    assert.ok(Math.abs(exp2 - (nowSec() + REFRESH_TTL_SECONDS)) <= 5,
      'refresh 过期不得被延长，实际差 ' + (exp2 - nowSec()) + ' 秒')
  })

  console.log('== ⑥ 匿名白名单 ==')
  await check('急诊 legacy 路径与登录/刷新/目录为匿名；预约/会议为受保护', async () => {
    assert.strictEqual(req.isAnonymous('POST', '/api/v1/auth/wechat/login'), true)
    assert.strictEqual(req.isAnonymous('POST', '/api/v1/auth/refresh'), true)
    assert.strictEqual(req.isAnonymous('POST', '/api/v1/doctor/login'), true)
    assert.strictEqual(req.isAnonymous('POST', '/api/v1/consultation/emergency/check'), true)
    assert.strictEqual(req.isAnonymous('GET', '/api/v1/doctor/list'), true)
    assert.strictEqual(req.isAnonymous('GET', '/api/v1/appointments/me'), false)
    assert.strictEqual(req.isAnonymous('POST', '/api/v1/voice/tts'), false)
    assert.strictEqual(req.isAnonymous('GET', '/api/v1/voice/voices'), false)
    // 带 query 的签名音频地址仍应命中匿名
    assert.strictEqual(req.isAnonymous('GET', '/api/gw/tts/audio/a1b2.mp3?token=x'), true)
  })

  console.log('')
  console.log(fail === 0 ? ('全部通过：' + pass + ' 项') : ('通过 ' + pass + ' 项，失败 ' + fail + ' 项'))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
