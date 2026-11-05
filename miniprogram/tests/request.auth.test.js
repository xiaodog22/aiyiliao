/*
 * request.auth.test.js —— 401 单飞刷新与冷启动刷新（零依赖，node:test）
 *
 * 为什么这两个用例最值钱：它们是**并发逻辑**，单线程 happy path 测不出来。
 *   - 每个 401 各触发一次 refresh → 刷新风暴（后端 /auth/refresh 被 N 倍打，且令牌轮换互相踩踏）
 *   - 冷启动时多个页面同时 ensureSessionReady → 同上
 * 这两类 bug 在真机上的表现是"偶发被踢下线"，本地正常路径永远复现不了。
 *
 * 断言口径：数**网络请求条数**（mock 了 wx.request），不看内部变量。
 * 内部变量断言会随重构失效，请求条数是外部可观察行为。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { createWxStub, purgeModuleCache } = require('./support/wx-stub.js')

const MINIPROGRAM_ROOT = path.resolve(__dirname, '..')

/** 每个用例都从"冷启动"开始：清模块缓存（单飞位是模块级状态）+ 换新 stub。 */
function loadFresh() {
  purgeModuleCache(MINIPROGRAM_ROOT)
  const stub = createWxStub()
  stub.install()
  const API = require('../config/api.js')
  const session = require('../services/session.js')
  const request = require('../services/request.js')
  return { stub, API, session, request }
}

const ok = (data) => ({ statusCode: 200, data: { code: 'OK', data } })
const unauthorized = () => ({ statusCode: 401, data: { code: 'SESSION_REVOKED', message: '会话已撤销' } })

test('3 个并发请求同时 401 → refresh 只发 1 次，3 个原请求都用新 token 重发', async () => {
  const { stub, API, session, request } = loadFresh()
  session.setTokens({ accessToken: 'at-old', refreshToken: 'rt-old', expiresIn: 7200 })
  assert.strictEqual(session.getAccessToken(), 'at-old', '前置：必须有可用 access，才不会走冷启动刷新')

  // 编排：3 个 401 → 1 次 refresh 成功 → 3 个重发成功
  stub.queue(
    unauthorized(),
    unauthorized(),
    unauthorized(),
    ok({ accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 7200 }),
    ok({ id: 'u-1' }),
    ok({ count: 3 }),
    ok({ greeting: 'hi' })
  )

  const [me, unread, home] = await Promise.all([
    request.get(API.ME),
    request.get(API.MESSAGE_UNREAD_COUNT),
    request.get(API.HOME_SUMMARY),
  ])

  const http = stub.httpRequests
  const refreshCalls = http.filter((r) => r.url.includes('/api/v1/auth/refresh'))
  const replayCalls = http.filter((r) => !r.url.includes('/api/v1/auth/refresh'))

  assert.strictEqual(refreshCalls.length, 1,
    `refresh 必须单飞（实际 ${refreshCalls.length} 次）。多次 = 刷新风暴，令牌轮换会互相踩踏`)
  assert.strictEqual(replayCalls.length, 6,
    `应为 3 原始 + 3 重发 = 6 次业务请求（实际 ${replayCalls.length}）`)

  // 重发必须带新 token（后 3 条业务请求）
  for (const r of replayCalls.slice(3)) {
    assert.strictEqual(r.header.Authorization, 'Bearer at-new',
      `重发必须用刷新后的 access（${r.url} 实际带 ${r.header.Authorization}）`)
  }
  // 原始 3 条必须带旧 token（证明是"先失败再刷新"，不是一开始就没带）
  for (const r of replayCalls.slice(0, 3)) {
    assert.strictEqual(r.header.Authorization, 'Bearer at-old')
  }

  // 业务结果仍要正确返回（刷新不能把返回值吞掉）
  assert.deepStrictEqual(me, { id: 'u-1' })
  assert.deepStrictEqual(unread, { count: 3 })
  assert.deepStrictEqual(home, { greeting: 'hi' })
})

test('refresh 结束后单飞位释放：下一轮 401 会重新刷新（不会永久复用旧 Promise）', async () => {
  const { stub, API, session, request } = loadFresh()
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })

  // 第一轮：401 → refresh → 重发成功
  stub.queue(
    unauthorized(),
    ok({ accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 7200 }),
    ok({ id: 'u-1' })
  )
  await request.get(API.ME)
  assert.strictEqual(stub.httpRequests.filter((r) => r.url.includes('/auth/refresh')).length, 1)

  // 第二轮：再次 401 → 必须能再刷新一次（若 refreshPromise 没清空，这里会拿到已 resolve 的旧 Promise
  // 而不发网络请求，表现为"刷新成功但 token 还是旧的"——真机上就是反复被踢）
  stub.queue(
    unauthorized(),
    ok({ accessToken: 'at-3', refreshToken: 'rt-3', expiresIn: 7200 }),
    ok({ id: 'u-2' })
  )
  const me2 = await request.get(API.ME)

  assert.strictEqual(stub.httpRequests.filter((r) => r.url.includes('/auth/refresh')).length, 2,
    '第二轮必须重新发 refresh，说明单飞位已释放')
  assert.strictEqual(session.getAccessToken(), 'at-3')
  assert.deepStrictEqual(me2, { id: 'u-2' })
})

test('冷启动：无 access 有 refresh 时，5 个并发调用只刷新 1 次', async () => {
  const { stub, API, session, request } = loadFresh()
  // 只写 refresh（模拟"access 只在内存、进程被回收后丢失"的真实冷启动态）
  session.setTokens({ refreshToken: 'rt-cold' })
  assert.strictEqual(session.getAccessToken(), '', '前置：冷启动态不能有 access')

  stub.queue(ok({ accessToken: 'at-cold', refreshToken: 'rt-cold2', expiresIn: 7200 }))
  stub.setDefault(ok({ ok: true }))

  await Promise.all([
    request.get(API.ME),
    request.get(API.MESSAGE_UNREAD_COUNT),
    request.get(API.HOME_SUMMARY),
    request.get(API.ME_EXTENDED),
    request.get(API.ME_IDENTITY),
  ])

  const refreshCalls = stub.httpRequests.filter((r) => r.url.includes('/auth/refresh'))
  assert.strictEqual(refreshCalls.length, 1,
    `冷启动并发必须只刷新 1 次（实际 ${refreshCalls.length}）——多次会让后端签出多条会话链`)
})
