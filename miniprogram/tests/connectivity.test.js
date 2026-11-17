/*
 * connectivity.test.js —— 断网时"只读可看、写操作不可提交"的边界（零依赖，node:test）
 *
 * 背景（2026-11-17）：后端断网时，页面曾继续渲染默认/演示数据且按钮可操作。
 * 本测试锁定三条产品口径：
 *   ① 网络失败不清会话、不把用户踢下线；
 *   ② 写请求在离线/降级时返回结构化 OFFLINE，不再发业务 POST；
 *   ③ 网关探测成功后自动恢复写能力，不需要用户重登。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { createWxStub, purgeModuleCache } = require('./support/wx-stub.js')

const MINIPROGRAM_ROOT = path.resolve(__dirname, '..')
const WRITE_SPEC = { base: 'java', path: '/api/v1/connectivity-test-write' }

function loadFresh() {
  purgeModuleCache(MINIPROGRAM_ROOT)
  const stub = createWxStub()
  stub.install()
  const API = require('../config/api.js')
  const ENV = require('../config/env.js')
  const session = require('../services/session.js')
  const connectivity = require('../services/connectivity.js')
  const request = require('../services/request.js')
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
  return { stub, API, ENV, session, connectivity, request }
}

const ok = (data) => ({ statusCode: 200, data: { code: 'OK', data } })
const down = () => ({ error: new Error('request:fail') })

test('GET 网络失败：标记降级，但不清会话、不跳登录', async () => {
  const { stub, API, session, connectivity, request } = loadFresh()
  stub.queue(down())

  await assert.rejects(request.get(API.ME), (err) => err.code === 'NETWORK_ERROR')

  const snap = connectivity.snapshot()
  assert.strictEqual(snap.online, false)
  assert.strictEqual(snap.degraded, true)
  assert.strictEqual(snap.writable, false)
  assert.strictEqual(session.getAccessToken(), 'at-1', '断一次网不能把用户踢下线')
  assert.strictEqual(session.getRefreshToken(), 'rt-1')
})

test('离线时写请求被闸门拦截：只探测网关，不发业务 POST', async () => {
  const { stub, API, connectivity, request } = loadFresh()
  stub.queue(down())
  await assert.rejects(request.get(API.ME), (err) => err.code === 'NETWORK_ERROR')

  // 之后网关健康探测也失败：写操作必须直接 OFFLINE，而不是把 POST 发出去再超时
  stub.reset()
  stub.setDefault(down())

  await assert.rejects(request.post(WRITE_SPEC, { test: true }), (err) => err.code === 'OFFLINE')

  const posts = stub.httpRequests.filter((r) => r.method === 'POST')
  assert.strictEqual(posts.length, 0, '离线时不得发业务写请求')
  assert.strictEqual(connectivity.snapshot().writable, false)
})

test('网关探测成功后恢复写能力，不要求重新登录', async () => {
  const { stub, API, session, connectivity, request } = loadFresh()
  stub.queue(down())
  await assert.rejects(request.get(API.ME), (err) => err.code === 'NETWORK_ERROR')

  stub.reset()
  stub.queue(ok({ status: 'UP' }), ok({ id: 'w-1' }))

  const result = await request.post(WRITE_SPEC, { test: true })

  assert.deepStrictEqual(result, { id: 'w-1' })
  assert.strictEqual(connectivity.snapshot().online, true)
  assert.strictEqual(connectivity.snapshot().writable, true)
  assert.strictEqual(session.getAccessToken(), 'at-1', '恢复写能力不需要重新登录')

  const methods = stub.httpRequests.map((r) => r.method)
  assert.deepStrictEqual(methods, ['GET', 'POST'], '先探健康，再发一次业务写请求')
})

test('登录入口不被离线闸门提前挡掉：仍要真实尝试后端', async () => {
  const { stub, API, connectivity, request } = loadFresh()
  stub.queue(down())
  await assert.rejects(request.get(API.ME), (err) => err.code === 'NETWORK_ERROR')

  // 设备网络可能已恢复，但上一次探测还没成功；登录必须真实发一次，不能直接 OFFLINE。
  stub.reset()
  stub.queue(ok({ accessToken: 'at-2', refreshToken: 'rt-2' }))

  const result = await request.post(API.AUTH_WECHAT_LOGIN, { code: 'wx-code' })

  assert.deepStrictEqual(result, { accessToken: 'at-2', refreshToken: 'rt-2' })
  assert.deepStrictEqual(stub.httpRequests.map((r) => r.method), ['POST'],
    '登录不应先发健康探测，也不应被 OFFLINE 拦截')
  assert.strictEqual(connectivity.snapshot().online, true)
})

test('withFallback 返回演示数据时必须标记来源 mock，不能冒充真实数据', async () => {
  const { stub, API, ENV, connectivity, request } = loadFresh()
  ENV.MOCK_FALLBACK = true
  stub.queue(down())

  const value = await request.withFallback(request.get(API.ME), () => ({ demo: true }))

  assert.deepStrictEqual(value, { demo: true })
  const snap = connectivity.snapshot()
  assert.strictEqual(snap.degraded, true)
  assert.strictEqual(snap.source, 'mock')
  assert.strictEqual(snap.writable, false)
})
