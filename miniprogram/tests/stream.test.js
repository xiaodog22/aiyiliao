/*
 * stream.test.js —— AI 任务事件流客户端（对外流式二期，零依赖，node:test）
 *
 * 三层要测的东西，每层对应一个真实事故面：
 *   ① 传输：必须是 `enableChunked` + `Accept: text/event-stream` + 带 Bearer；
 *   ② 解码：逐字节投递时正文不得出现乱码（这是真机上最容易复现的失败）；
 *   ③ 语义：`onError` 的含义是「去轮询」，**不是**「任务失败」——
 *      所以流正常结束却没有终态时，也必须给出可降级的信号，不能静默。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { createWxStub, purgeModuleCache } = require('./support/wx-stub.js')

const MINIPROGRAM_ROOT = path.resolve(__dirname, '..')
const tick = () => new Promise((r) => setTimeout(r, 0))

function load() {
  purgeModuleCache(MINIPROGRAM_ROOT)
  const stub = createWxStub()
  stub.install()
  const session = require('../services/session.js')
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
  const stream = require('../services/stream.js')
  return { stub, stream }
}

const SSE_OK =
  'event: accepted\nid: 1\ndata: {"taskId":"t-1","status":"RUNNING"}\n\n' +
  'event: delta\nid: 2\ndata: {"text":"你好"}\n\n' +
  'event: delta\nid: 3\ndata: {"text":"，在的"}\n\n' +
  'event: completed\nid: 4\ndata: {"taskId":"t-1","status":"SUCCEEDED"}\n\n'

const bytesOf = (s) => new Uint8Array(Buffer.from(s, 'utf8'))

test('传输契约：enableChunked + Accept + Bearer + 走 /events 路由', async () => {
  const { stub, stream } = load()
  stream.open('t-1', {})
  await tick()

  const req = stub.httpRequests[0]
  assert.ok(req, '必须真的发起请求')
  assert.strictEqual(req.enableChunked, true, '不开分块就收不到增量')
  assert.strictEqual(req.header.Accept, 'text/event-stream')
  assert.match(String(req.header.Authorization || ''), /^Bearer /, 'SSE 同样要鉴权')
  assert.ok(/\/api\/v1\/ai\/tasks\/t-1\/events$/.test(req.url), `实际地址：${req.url}`)
})

test('逐字节投递：汉字与帧边界被切碎也不乱码、不丢字', async () => {
  const { stub, stream } = load()
  const deltas = []
  let done = 0
  stream.open('t-1', {
    onDelta: (t) => deltas.push(t),
    onDone: () => { done++ }
  })
  await tick()

  const bytes = bytesOf(SSE_OK)
  for (let i = 0; i < bytes.length; i++) {
    stub.httpRequests[0].emitChunk(bytes.subarray(i, i + 1))
  }
  stub.httpRequests[0].finish(200)

  assert.strictEqual(deltas.join(''), '你好，在的')
  assert.ok(deltas.every((t) => t.indexOf('\ufffd') === -1), '不得出现替换字符')
  assert.strictEqual(done, 1, 'completed 只收口一次')
})

test('error 事件透出结构化错误（含 code / retryable）', async () => {
  const { stub, stream } = load()
  let err = null
  stream.open('t-1', { onError: (e) => { err = e } })
  await tick()

  const rec = stub.httpRequests[0]
  rec.emitChunk(bytesOf('event: error\nid: 1\ndata: {"taskId":"t-1","error":{"code":"AI_TASK_FAILED","message":"模型超时","retryable":true}}\n\n'))
  rec.finish(200)

  assert.ok(err)
  assert.strictEqual(err.code, 'AI_TASK_FAILED')
  assert.strictEqual(err.message, '模型超时')
  assert.strictEqual(err.retryable, true)
})

test('连接正常结束却无终态：必须给 STREAM_ENDED 让页面去轮询', async () => {
  const { stub, stream } = load()
  let err = null
  stream.open('t-1', { onError: (e) => { err = e } })
  await tick()

  const rec = stub.httpRequests[0]
  rec.emitChunk(bytesOf('event: delta\nid: 1\ndata: {"text":"半句"}\n\n'))
  rec.finish(200) // 没有 completed / error

  assert.ok(err, '静默结束是最危险的：用户会一直停在半句话')
  assert.strictEqual(err.code, 'STREAM_ENDED')
  assert.strictEqual(err.retryable, true)
})

test('401：不重试（长连接重发代价高），交页面重新登录或轮询', async () => {
  const { stub, stream } = load()
  let err = null
  stream.open('t-1', { onError: (e) => { err = e } })
  await tick()

  stub.httpRequests[0].finish(401)
  assert.ok(err)
  assert.strictEqual(err.code, 'UNAUTHORIZED')
  assert.strictEqual(err.retryable, false)
})

test('网络失败：NETWORK_ERROR 可重试', async () => {
  const { stub, stream } = load()
  let err = null
  stream.open('t-1', { onError: (e) => { err = e } })
  await tick()

  stub.httpRequests[0].emitFail('request:fail timeout')
  assert.ok(err)
  assert.strictEqual(err.code, 'NETWORK_ERROR')
  assert.strictEqual(err.retryable, true)
})

test('基础库无 onChunkReceived：走 onUnsupported 降级，不算错误', async () => {
  const { stub, stream } = load()
  // 模拟低版本基础库：request 返回的 task 没有 onChunkReceived
  stub.wx.request = (options) => {
    stub.requests.push({ url: options.url, method: 'GET', header: options.header || {} })
    return { abort() {} }
  }

  let unsupported = 0
  let errored = 0
  stream.open('t-1', { onUnsupported: () => { unsupported++ }, onError: () => { errored++ } })
  await tick()

  assert.strictEqual(unsupported, 1)
  assert.strictEqual(errored, 0, '降级不是错误，不能弹错误提示')
})

test('基础库无 onChunkReceived：abort 连接且只回调一次终态（m-03）', async () => {
  const { stub, stream } = load()
  let aborted = 0
  let options = null
  // 模拟低版本基础库：返回的 task 没有 onChunkReceived，但连接本身仍会跑
  stub.wx.request = (o) => {
    options = o
    return { abort() { aborted++ } }
  }

  let unsupported = 0
  let errored = 0
  stream.open('t-1', { onUnsupported: () => { unsupported++ }, onError: () => { errored++ } })
  await tick()

  assert.strictEqual(unsupported, 1)
  assert.strictEqual(aborted, 1, '必须主动中止这条不会分块下发的连接')
  // 被丢下的连接随后仍可能 success/fail：调用方已切轮询，不得再收到第二个终态
  options.success({ statusCode: 200 })
  options.fail({ errMsg: 'request:fail abort' })

  assert.strictEqual(errored, 0, '降级后不得再报错')
  assert.strictEqual(unsupported, 1, 'onUnsupported 只回调一次')
})

test('delta replace=true：透出替换语义而不是追加（M-01 终态整段替换）', async () => {
  const { stub, stream } = load()
  const calls = []
  stream.open('t-1', { onDelta: (t, replace) => calls.push([t, !!replace]) })
  await tick()

  const rec = stub.httpRequests[0]
  rec.emitChunk(bytesOf('event: delta\nid: 1\ndata: {"text":"，在的"}\n\n'))
  rec.emitChunk(bytesOf('event: delta\nid: 2\ndata: {"text":"你好，在的","replace":true}\n\n'))
  rec.emitChunk(bytesOf('event: completed\nid: 3\ndata: {"taskId":"t-1","status":"SUCCEEDED"}\n\n'))

  assert.deepStrictEqual(calls[0], ['，在的', false])
  assert.deepStrictEqual(calls[1], ['你好，在的', true], '整段替换必须带 replace 标记')
})

test('abort 后不再回调，也不残留增量', async () => {
  const { stub, stream } = load()
  const deltas = []
  const handle = stream.open('t-1', { onDelta: (t) => deltas.push(t) })
  await tick()

  const rec = stub.httpRequests[0]
  rec.emitChunk(bytesOf('event: delta\nid: 1\ndata: {"text":"第一段"}\n\n'))
  handle.abort()

  rec.emitChunk(bytesOf('event: delta\nid: 2\ndata: {"text":"不该出现"}\n\n'))
  rec.finish(200)

  assert.deepStrictEqual(deltas, ['第一段'])
  assert.strictEqual(handle.isOpen(), false)
})
