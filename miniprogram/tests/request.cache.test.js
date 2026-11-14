/*
 * request.cache.test.js —— GET 短 TTL 缓存（响应速度改造）的边界（零依赖，node:test）
 *
 * 为什么必须测：缓存是"用旧数据换速度"，最容易踩的两颗雷是
 *   ① 把写操作也缓存了 → 用户改完资料仍看到旧值（会被当成"保存失败"）；
 *   ② 缓存白名单外的接口（/me、/auth/*）→ 401 重试、退出登录后被旧数据串号。
 * 断言口径与 request.auth.test.js 一致：数**网络请求条数**，不看内部 Map。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { createWxStub, purgeModuleCache } = require('./support/wx-stub.js')

const MINIPROGRAM_ROOT = path.resolve(__dirname, '..')

function loadFresh() {
  purgeModuleCache(MINIPROGRAM_ROOT)
  const stub = createWxStub()
  stub.install()
  const API = require('../config/api.js')
  const session = require('../services/session.js')
  const request = require('../services/request.js')
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
  return { stub, API, session, request }
}

const ok = (data) => ({ statusCode: 200, data: { code: 'OK', data } })

test('列表类 GET 在 TTL 内复用响应：两次调用只发 1 次网络请求', async () => {
  const { stub, API, request } = loadFresh()
  stub.queue(ok([{ id: 'hr-1' }]), ok([{ id: 'hr-2' }]))

  const first = await request.get(API.HEALTH_RECORDS)
  const second = await request.get(API.HEALTH_RECORDS)

  assert.strictEqual(stub.httpRequests.length, 1, '第二次必须命中缓存，不再发网络请求')
  assert.deepStrictEqual(first, second, '缓存返回的是同一份真实响应，不是重新构造的数据')
})

test('写操作成功后缓存立即失效：再读会重新发请求并拿到新数据', async () => {
  const { stub, API, request } = loadFresh()
  stub.queue(
    ok([{ id: 'hr-1' }]),                    // 首次读
    ok({ deleted: true }),                    // 写操作（DELETE）
    ok([{ id: 'hr-2' }])                      // 写后再读
  )

  await request.get(API.HEALTH_RECORDS)
  await request.del(API.HR_ATTACHMENT_BY_ID, undefined, {
    params: { recordId: 'hr-1', attachmentId: 'at-1' }
  })
  const after = await request.get(API.HEALTH_RECORDS)

  assert.strictEqual(stub.httpRequests.length, 3, '读 → 写 → 读：三条都必须真的发出去')
  assert.deepStrictEqual(after, [{ id: 'hr-2' }], '写后读到的是新数据，不是缓存里的旧列表')
})

test('白名单之外的 GET 不缓存：/me 每次都要走网络（避免改完资料看到旧值）', async () => {
  const { stub, API, request } = loadFresh()
  stub.queue(ok({ id: 'u-1' }), ok({ id: 'u-1', displayName: '张三' }))

  await request.get(API.ME)
  await request.get(API.ME)

  assert.strictEqual(stub.httpRequests.length, 2, '/me 属敏感即时态，不能被 TTL 缓存')
})

test('cacheTtl: 0 可显式关闭缓存（页面要求强一致时用）', async () => {
  const { stub, API, request } = loadFresh()
  stub.queue(ok([{ id: 'hr-1' }]), ok([{ id: 'hr-1' }]))

  await request.get(API.HEALTH_RECORDS, undefined, { cacheTtl: 0 })
  await request.get(API.HEALTH_RECORDS, undefined, { cacheTtl: 0 })

  assert.strictEqual(stub.httpRequests.length, 2, 'cacheTtl:0 必须每次真发')
})

test('clearGetCache 后重新发请求（退出登录/切账号场景）', async () => {
  const { stub, API, request } = loadFresh()
  stub.queue(ok([{ id: 'hr-1' }]), ok([{ id: 'hr-9' }]))

  await request.get(API.HEALTH_RECORDS)
  request.clearGetCache()
  const after = await request.get(API.HEALTH_RECORDS)

  assert.strictEqual(stub.httpRequests.length, 2, '清缓存后必须重新发请求')
  assert.deepStrictEqual(after, [{ id: 'hr-9' }], '不允许把上个账号的缓存读给下一个账号')
})
