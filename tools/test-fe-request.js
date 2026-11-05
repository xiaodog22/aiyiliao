/**
 * tools/test-fe-request.js —— services/request.js 请求层测试（前端测试文档 TC-FE-RQ-*）
 *
 * 打桩策略：global.wx 注入可控 request/uploadFile + 内存 storage；
 * getApp/getCurrentPages 不注入（源码内有 typeof 守卫，非小程序运行时安全跳过）。
 * 覆盖：信封脱壳、错误分类（五类 + BIZ + 429/403）、401 单飞刷新重试、
 *       GET 单飞合并、匿名白名单、会话守卫、幂等键、路径占位、二进制通道。
 *
 * 运行：node tools/test-fe-request.js
 */
const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const path = require('path')

// ==================== wx 打桩 ====================
const storage = {}
let queue = []           // 响应队列：{ statusCode, data, header } 或 { fail: {errMsg} }
const calls = []         // 每次 wx.request / wx.uploadFile 调用的记录

global.wx = {
  request(req) {
    calls.push({ api: 'request', req })
    const next = queue.shift() || { statusCode: 200, data: { code: 'OK', data: null } }
    const done = () => {
      if (next.fail) { req.fail && req.fail(next.fail); req.complete && req.complete(); return }
      req.success && req.success({ statusCode: next.statusCode, data: next.data, header: next.header || {} })
      req.complete && req.complete()
    }
    // 模拟异步：微任务里回调，保证 Promise 链按真实时序推进
    queueMicrotask(done)
  },
  uploadFile(req) {
    calls.push({ api: 'uploadFile', req })
    const next = queue.shift() || { statusCode: 200, data: { code: 'OK', data: null } }
    queueMicrotask(() => {
      if (next.fail) { req.fail && req.fail(next.fail); return }
      req.success && req.success({ statusCode: next.statusCode, data: next.data, header: next.header || {} })
    })
  },
  setStorageSync(k, v) { storage[k] = v },
  getStorageSync(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : '' },
  removeStorageSync(k) { delete storage[k] }
}

const ROOT = path.join(__dirname, '..', 'miniprogram')
const API = require(path.join(ROOT, 'config', 'api.js'))
const session = require(path.join(ROOT, 'services', 'session.js'))
const req = require(path.join(ROOT, 'services', 'request.js'))

beforeEach(() => {
  queue = []
  calls.length = 0
  session.clear()
  for (const k of Object.keys(storage)) delete storage[k]
})

const okEnv = (data) => ({ statusCode: 200, data: { code: 'OK', message: '成功', data } })

// ==================== ① 信封脱壳与成功路径 ====================

test('RQ-01 核心：GET 成功 + 契约信封 → 脱壳出 data；头/URL 正确', async () => {
  queue.push(okEnv({ id: 'dep-1', name: '消化内科' }))
  const out = await req.get(API.DEPARTMENT_LIST)
  assert.deepStrictEqual(out, { id: 'dep-1', name: '消化内科' })
  const c = calls[0].req
  assert.strictEqual(c.method, 'GET')
  assert.ok(c.url.endsWith('/api/v1/departments'), c.url)
  assert.strictEqual(c.header['X-Platform'], 'wechat-miniprogram')
  assert.ok(c.header['X-Client-Version'])
  assert.ok(/^wx-/.test(c.header['X-Request-Id']))
  assert.ok(!('Authorization' in c.header), '匿名目录不应带 Authorization')
})

test('RQ-02 核心：legacy 数字信封 code=200 同样脱壳（不误判 BIZ_ERROR）', async () => {
  queue.push({ statusCode: 200, data: { code: 200, msg: 'ok', data: [1, 2] } })
  const out = await req.get(API.DEPARTMENT_LIST)
  assert.deepStrictEqual(out, [1, 2])
})

test('RQ-03 核心：无 code 字段的裸数据原样返回', async () => {
  queue.push({ statusCode: 200, data: { items: [1] } })
  assert.deepStrictEqual(await req.get(API.DEPARTMENT_LIST), { items: [1] })
})

// ==================== ② 错误分类（契约错误语义） ====================

test('RQ-04 异常：业务错误信封 → BIZ_ERROR + httpCode + detail', async () => {
  queue.push({ statusCode: 200, data: { code: 409, msg: '该号源已满' } })
  await assert.rejects(req.get(API.DEPARTMENT_LIST), (e) => {
    assert.strictEqual(e.code, 'BIZ_ERROR')
    assert.strictEqual(e.httpCode, 409)
    assert.strictEqual(e.message, '该号源已满')
    return true
  })
})

test('RQ-05 异常：HTTP 500/404 → HTTP_ERROR（带 httpCode，不猜业务文案）', async () => {
  queue.push({ statusCode: 500, data: { message: '服务器炸了' } })
  await assert.rejects(req.get(API.DEPARTMENT_LIST), (e) => {
    assert.strictEqual(e.code, 'HTTP_ERROR')
    assert.strictEqual(e.httpCode, 500)
    return true
  })
})

test('RQ-06 异常：403 → FORBIDDEN', async () => {
  queue.push({ statusCode: 403, data: { message: '无权限' } })
  await assert.rejects(req.get(API.DEPARTMENT_LIST), (e) => {
    assert.strictEqual(e.code, 'FORBIDDEN')
    assert.strictEqual(e.httpCode, 403)
    return true
  })
})

test('RQ-07 异常：429 → RATE_LIMITED + retryAfter 从响应头提取', async () => {
  queue.push({ statusCode: 429, data: { message: 'too many' }, header: { 'Retry-After': '37' } })
  await assert.rejects(req.get(API.DEPARTMENT_LIST), (e) => {
    assert.strictEqual(e.code, 'RATE_LIMITED')
    assert.strictEqual(e.retryAfter, 37)
    return true
  })
})

test('RQ-08 异常：fail timeout → TIMEOUT；fail 其他 → NETWORK_ERROR', async () => {
  queue.push({ fail: { errMsg: 'request:fail timeout' } })
  await assert.rejects(req.get(API.DEPARTMENT_LIST), (e) => {
    assert.strictEqual(e.code, 'TIMEOUT')
    return true
  })
  queue.push({ fail: { errMsg: 'request:fail err' } })
  await assert.rejects(req.get(API.DEPARTMENT_LIST), (e) => {
    assert.strictEqual(e.code, 'NETWORK_ERROR')
    return true
  })
})

test('RQ-09 异常：缺接口规格 → BAD_SPEC；未知 base → NO_BASE_URL（不发网络）', async () => {
  await assert.rejects(req.get(null), (e) => {
    assert.strictEqual(e.code, 'BAD_SPEC')
    return true
  })
  await assert.rejects(req.get({ base: 'bogus', path: '/api/v1/x' }), (e) => {
    assert.strictEqual(e.code, 'NO_BASE_URL')
    return true
  })
  assert.strictEqual(calls.length, 0, '两个分支都不得发出网络请求')
})

// ==================== ③ 幂等键与请求头 ====================

test('RQ-10 核心：写操作带 Idempotency-Key（8~128，ik- 前缀，两次不同）', async () => {
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
  queue.push(okEnv({ id: 'ap-1' }))
  await req.post(API.APPOINT_SUBMIT, { slotId: 's1' }, { idempotencyKey: 'ik-fixed-0001' })
  const h = calls[0].req.header
  assert.strictEqual(h['Idempotency-Key'], 'ik-fixed-0001')
  assert.strictEqual(calls[0].req.method, 'POST')
})

test('RQ-11 核心：newIdempotencyKey 契约形状（ik- 前缀，长度 8~128，唯一）', () => {
  const a = req.newIdempotencyKey()
  const b = req.newIdempotencyKey()
  for (const k of [a, b]) {
    assert.ok(k.startsWith('ik-'), k)
    assert.ok(k.length >= 8 && k.length <= 128, k)
  }
  assert.notStrictEqual(a, b)
})

test('RQ-12 核心：登录后请求带 Authorization Bearer；匿名登录请求不带', async () => {
  session.setTokens({ accessToken: 'at-test-1', refreshToken: 'rt-test-1', expiresIn: 7200 })
  queue.push(okEnv({ id: 'u1' }))
  await req.get(API.ME)
  assert.strictEqual(calls[0].req.header.Authorization, 'Bearer at-test-1')

  calls.length = 0
  session.clear()
  queue.push(okEnv({ accessToken: 'at-x', refreshToken: 'rt-x', expiresIn: 60 }))
  await req.post(API.AUTH_WECHAT_LOGIN, { code: 'c', consentVersion: 'v1.0' })
  assert.ok(!('Authorization' in calls[0].req.header), '登录请求不得带 Authorization')
})

// ==================== ④ 会话守卫与 401 单飞刷新 ====================

test('RQ-13 守卫：受保护路径无 token 无 refresh → AUTH_REQUIRED 且零网络', async () => {
  await assert.rejects(req.get(API.ME), (e) => {
    assert.strictEqual(e.code, 'AUTH_REQUIRED')
    return true
  })
  assert.strictEqual(calls.length, 0, '未登录不得发出受保护请求')
})

test('RQ-14 守卫：匿名白名单路径无 token 直接放行（network 发出）', async () => {
  queue.push(okEnv([]))
  await req.get(API.DEPARTMENT_LIST)
  assert.strictEqual(calls.length, 1)
})

test('RQ-15 核心：401 → 单飞刷新 → 同幂等键重发一次 → 成功', async () => {
  session.setTokens({ accessToken: 'at-old', refreshToken: 'rt-old', expiresIn: 7200 })
  queue.push(
    { statusCode: 401, data: { message: 'unauthorized' } },                    // 原请求 401
    { statusCode: 200, data: okEnv({ accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 7200 }).data }, // 刷新成功
    okEnv({ id: 'ap-ok' })                                                     // 重发成功
  )
  const out = await req.post(API.APPOINT_SUBMIT, { slotId: 's1' }, { idempotencyKey: 'ik-retry-01' })
  assert.deepStrictEqual(out, { id: 'ap-ok' })
  assert.strictEqual(calls.length, 3, '应恰三次：原请求 + 刷新 + 重发')
  assert.strictEqual(calls[1].req.url.endsWith('/api/v1/auth/refresh'), true)
  assert.strictEqual(calls[2].req.header['Idempotency-Key'], 'ik-retry-01', '重发必须复用同一幂等键')
  assert.strictEqual(calls[2].req.header.Authorization, 'Bearer at-new')
})

test('RQ-16 异常：401 后刷新也被拒（401）→ AUTH_EXPIRED 且清本地会话', async () => {
  session.setTokens({ accessToken: 'at-old', refreshToken: 'rt-old', expiresIn: 7200 })
  queue.push(
    { statusCode: 401, data: { message: 'unauthorized' } },
    { statusCode: 401, data: { message: 'revoked' } }
  )
  await assert.rejects(req.get(API.ME), (e) => {
    assert.strictEqual(e.code, 'AUTH_EXPIRED')
    return true
  })
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(session.getAccessToken(), '', '刷新失败必须清本地 access')
})

// ==================== ⑤ GET 单飞合并 ====================

test('RQ-17 核心：并发同 URL GET 只发一次网络（写操作不合并）', async () => {
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
  queue.push(okEnv([1]), okEnv([2]))
  const [a, b] = await Promise.all([
    req.get(API.DEPARTMENT_LIST),
    req.get(API.DEPARTMENT_LIST)
  ])
  assert.deepStrictEqual(a, [1])
  assert.deepStrictEqual(b, [1], '并发第二个调用共享首次结果')
  assert.strictEqual(calls.length, 1)

  calls.length = 0
  queue.push(okEnv({ n: 1 }), okEnv({ n: 2 }))
  await Promise.all([
    req.post(API.APPOINT_SUBMIT, { slotId: 'a' }, { idempotencyKey: 'ik-p1' }),
    req.post(API.APPOINT_SUBMIT, { slotId: 'b' }, { idempotencyKey: 'ik-p2' })
  ])
  assert.strictEqual(calls.length, 2, 'POST 永不合并')
})

// ==================== ⑥ 匿名白名单判定 ====================

test('RQ-18 核心：isAnonymous 与后端 AuthInterceptor 同口径', () => {
  const yes = [
    ['GET', '/api/v1/departments'],
    ['GET', '/api/v1/departments/dep-1/doctors'],
    ['GET', '/api/v1/doctors/doc-1/slots'],
    ['POST', '/api/v1/auth/wechat/login'],
    ['POST', '/api/v1/auth/refresh'],
    ['POST', '/api/v1/triage/emergency-checks'],
    ['GET', '/api/v1/contents'],
    ['GET', '/api/v1/contents/c-1'],
    ['GET', '/api/v1/health-articles'],
    ['GET', '/api/v1/health-articles/a-1'],
    ['GET', '/api/v1/resources/manifest'],
    ['GET', '/api/gw/health'],
    ['GET', '/api/gw/tts/audio/f.wav?token=x']
  ]
  for (const [m, p] of yes) assert.strictEqual(req.isAnonymous(m, p), true, m + ' ' + p)
  const no = [
    ['GET', '/api/v1/me'],
    ['GET', '/api/v1/appointments/me'],
    ['POST', '/api/v1/appointments'],
    ['GET', '/api/v1/consultations'],
    ['POST', '/api/v1/departments'],            // 方法不匹配 → 非匿名
    ['DELETE', '/api/v1/contents/c-1'],         // 方法不匹配 → 非匿名
    ['GET', '/api/v1/health-articles/a-1/b/c']  // 段数不匹配 → 非匿名
  ]
  for (const [m, p] of no) assert.strictEqual(req.isAnonymous(m, p), false, m + ' ' + p)
})

// ==================== ⑦ 路径工具与二进制通道 ====================

test('RQ-19 核心：withPath 占位替换 + encodeURIComponent；url() 拼完整地址', () => {
  const spec = req.withPath(API.DEPARTMENT_DOCTORS, { id: 'dep 1/x' })
  assert.strictEqual(spec.path, '/api/v1/departments/dep%201%2Fx/doctors')
  assert.ok(req.url(spec).endsWith(spec.path))
  assert.ok(req.url(API.ME).startsWith('http'))
})

test('RQ-20 核心：getBinary 匿名音频直链 → ArrayBuffer；404 → 语音过期文案', async () => {
  const buf = new Uint8Array([1, 2, 3]).buffer
  queue.push({ statusCode: 200, data: buf })
  const out = await req.getBinary(API.GW_TTS_AUDIO || { base: 'gateway', path: '/api/gw/tts/audio/f.wav' })
  assert.strictEqual(out, buf)

  queue.push({ statusCode: 404, data: null })
  await assert.rejects(req.getBinary({ base: 'gateway', path: '/api/gw/tts/audio/f.wav' }), (e) => {
    assert.strictEqual(e.code, 'HTTP_ERROR')
    assert.strictEqual(e.httpCode, 404)
    return true
  })
})

test('RQ-21 核心：postForm multipart —— JSON 应答脱壳；二进制应答返回 ArrayBuffer', async () => {
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
  // responseType=arraybuffer 下 JSON 应答也是字节流（真实运行时语义），打桩须给 ArrayBuffer
  const jsonBytes = (obj) => new TextEncoder().encode(JSON.stringify(obj)).buffer
  queue.push({ statusCode: 200, data: jsonBytes({ code: 'OK', data: { ok: true } }), header: { 'Content-Type': 'application/json' } })
  const j = await req.postForm(API.VOICE_TTS, { text: '你好', voice: 'v1' })
  assert.deepStrictEqual(j, { ok: true })
  const sent = calls[0].req
  assert.ok(sent.header['Content-Type'].startsWith('multipart/form-data; boundary=----wb'))

  calls.length = 0
  const wav = new Uint8Array([0, 1, 0, 1]).buffer
  queue.push({ statusCode: 200, data: wav, header: { 'Content-Type': 'audio/wav' } })
  const b = await req.postForm(API.VOICE_TTS, { text: 'hi' })
  assert.strictEqual(b, wav)
})

test('RQ-22 异常：声明 JSON 内容类型但应答不是合法 JSON → PARSE_ERROR（不静默成功）', async () => {
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
  queue.push({ statusCode: 200, data: new Uint8Array([0x7b, 0x7b, 0x7b]).buffer, header: { 'Content-Type': 'application/json' } })
  await assert.rejects(req.postForm(API.VOICE_TTS, { text: 'x' }), (e) => {
    assert.strictEqual(e.code, 'PARSE_ERROR')
    return true
  })
})

test('RQ-22b 边界：非 JSON 内容类型的字节流按二进制原样返回（音频通道）', async () => {
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
  const wav = new Uint8Array([0, 1, 0, 1]).buffer
  queue.push({ statusCode: 200, data: wav, header: { 'Content-Type': 'audio/wav' } })
  assert.strictEqual(await req.postForm(API.VOICE_TTS, { text: 'x' }), wav)
})

test('RQ-23 边界：ensureSessionReady —— 无登录 false，有 token true（不抛错）', async () => {
  assert.strictEqual(await req.ensureSessionReady(), false)
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 60 })
  assert.strictEqual(await req.ensureSessionReady(), true)
})

test('RQ-24 边界：encodeUTF8/decodeUTF8 往返（中文 + 代理对 emoji）', () => {
  const s = '潮汕话测试\u4e2d\ud83d\ude00' // 含 emoji（代理对）
  const bytes = req.encodeUTF8(s)
  assert.ok(bytes instanceof Uint8Array)
  assert.strictEqual(req.decodeUTF8(bytes), s)
  assert.strictEqual(req.decodeUTF8(bytes.buffer), s)
  assert.strictEqual(req.decodeUTF8(''), '')
  assert.strictEqual(req.decodeUTF8(null), '')
})

test('RQ-25 边界：uploadFile 401 自动刷新重发一次', async () => {
  session.setTokens({ accessToken: 'at-old', refreshToken: 'rt-old', expiresIn: 7200 })
  queue.push(
    { statusCode: 401, data: '{"message":"x"}' },
    { statusCode: 200, data: { accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 7200 } },
    { statusCode: 200, data: { code: 'OK', data: { text: '转写文本' } } }
  )
  const out = await req.uploadFile(API.VOICE_ASR, '/tmp/a.wav', 'audio', {}, { idempotencyKey: 'ik-asr-1' })
  assert.deepStrictEqual(out, { text: '转写文本' })
  assert.strictEqual(calls.length, 3)
  assert.strictEqual(calls[0].api, 'uploadFile')
  assert.strictEqual(calls[2].api, 'uploadFile')
  assert.strictEqual(calls[2].req.header['Idempotency-Key'], 'ik-asr-1')
})

test('RQ-26 边界：withFallback —— 开发档失败降级 mock；mock 为 null 原样抛错', async () => {
  queue.push({ statusCode: 500, data: null }, { statusCode: 500, data: null })
  const out = await req.withFallback(req.get(API.DEPARTMENT_LIST), () => [{ id: 'mock' }])
  assert.deepStrictEqual(out, [{ id: 'mock' }])
  await assert.rejects(
    req.withFallback(req.get(API.DEPARTMENT_LIST), () => null),
    (e) => e.code === 'HTTP_ERROR'
  )
})
