/*
 * request.http-error.test.js —— 非 2xx 必须保留后端业务码
 *
 * 回归背景（2026-11-17）：医生端「线上问诊设置」保存排班返回 409 VERSION_CONFLICT，
 * 但 request.js 把所有非 2xx 压成 HTTP_ERROR，页面里的 `err.code === 'VERSION_CONFLICT'`
 * 永远不成立，最终提示“服务暂时不可用”。这不是服务挂了，而是排班版本过期。
 *
 * 断言口径：外部可观察的错误对象（code / httpCode / message），不测内部实现。
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
  session.setTokens({ accessToken: 'at-test', refreshToken: 'rt-test', expiresIn: 7200 })
  return { stub, API, request }
}

test('409 VERSION_CONFLICT 透传业务码，不被压成 HTTP_ERROR', async () => {
  const { stub, API, request } = loadFresh()
  stub.queue({
    statusCode: 409,
    data: {
      code: 'VERSION_CONFLICT',
      message: '排班已被修改（当前版本 3，请求基于 2），请刷新后重试'
    }
  })

  await assert.rejects(
    request.put(API.DOCTOR_SCHEDULE, { expectedVersion: 2, weekdays: [] }, {
      idempotencyKey: 'ik-version-conflict-test'
    }),
    (err) => {
      assert.strictEqual(err.code, 'VERSION_CONFLICT', '页面必须能识别版本冲突')
      assert.strictEqual(err.httpCode, 409)
      assert.match(err.message, /排班已被修改/)
      return true
    }
  )
})

test('422 VALIDATION_FAILED 保留 details 字段原因，供页面给出可修复提示', async () => {
  const { stub, API, request } = loadFresh()
  stub.queue({
    statusCode: 422,
    data: {
      code: 'VALIDATION_FAILED',
      message: '请求参数未通过校验',
      details: [{ field: 'expectedVersion', reason: '不能为空', code: 'INVALID' }]
    }
  })

  await assert.rejects(
    request.put(API.DOCTOR_SCHEDULE, { weekdays: [] }, {
      idempotencyKey: 'ik-validation-test'
    }),
    (err) => {
      assert.strictEqual(err.code, 'VALIDATION_FAILED')
      assert.strictEqual(err.httpCode, 422)
      assert.match(err.message, /expectedVersion/)
      assert.match(err.message, /不能为空/)
      return true
    }
  )
})

test('无业务码的 5xx 仍回 HTTP_ERROR，不伪造业务错误', async () => {
  const { stub, API, request } = loadFresh()
  stub.queue({ statusCode: 503, data: { message: '上游暂不可用' } })

  await assert.rejects(
    request.get(API.DOCTOR_SCHEDULE),
    (err) => {
      assert.strictEqual(err.code, 'HTTP_ERROR')
      assert.strictEqual(err.httpCode, 503)
      return true
    }
  )
})
