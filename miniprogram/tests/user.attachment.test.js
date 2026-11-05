/*
 * user.attachment.test.js —— 附件路径参数守卫（零依赖，node:test）
 *
 * 为什么加这组用例：
 *   2026-11-04 真机 404 —— 问诊页发图调用 `uploadAttachment(null, path)`，拼出
 *   `/api/v1/health-records//attachments`（recordId 为空）。后端只能回笼统的"路径不存在"，
 *   页面把它显示成"上传失败"，看起来像网络问题，实际是**参数为空**。
 *
 * 断言口径：
 *   ① 空 id 必须在**发请求之前**就 reject（请求条数 = 0），否则等于把脏 URL 交给网络层；
 *   ② 正常路径必须落到**独立上传**端点 `/api/v1/attachments`，不能带 health-records 段。
 *   只断言外部可观察行为（请求条数 / URL），不碰内部变量。
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
  const session = require('../services/session.js')
  const user = require('../services/user.js')
  return { stub, session, user }
}

const ok = (data) => ({ statusCode: 200, data: { code: 'OK', data } })

test('listAttachments 空 recordId：不拼 URL、不发请求，直接给中文业务错误', async () => {
  const { stub, user } = loadFresh()

  await assert.rejects(
    () => user.listAttachments(''),
    (err) => {
      assert.strictEqual(err.code, 'VALIDATION_FAILED')
      assert.match(err.message, /档案/)
      return true
    },
    '空 recordId 必须 reject，而不是拼出 /health-records//attachments'
  )
  assert.strictEqual(stub.requests.length, 0,
    `守卫必须在网络层之前生效（实际发了 ${stub.requests.length} 个请求）`)
})

test('uploadAttachment 空 recordId：同样零请求（2026-11-04 问诊发图 404 的根因）', async () => {
  const { stub, user } = loadFresh()
  stub.setDefault(ok({}))

  await assert.rejects(() => user.uploadAttachment(null, '/tmp/photo.png'),
    (err) => err.code === 'VALIDATION_FAILED')
  assert.strictEqual(stub.requests.length, 0)
  assert.ok(
    !stub.requests.some((r) => String(r.url).includes('health-records//')),
    '任何情况下都不允许出现空的路径参数段'
  )
})

test('uploadStandaloneAttachment 走独立上传端点（问诊会话没有既有档案）', async () => {
  const { stub, session, user } = loadFresh()
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })

  // ⚠️ 只断言"打到哪个端点、带什么头"，不断言响应映射：
  //    wx-stub 的 uploadFile 固定回 { code:'OK', data:{} }，不消费 queue，
  //    在这里断言 objectKey 等于在测 stub 而不是测被测代码。
  await user.uploadStandaloneAttachment('/tmp/photo.png')

  const uploads = stub.requests.filter((r) => r.kind === 'uploadFile')
  assert.strictEqual(uploads.length, 1)
  assert.ok(uploads[0].url.includes('/api/v1/attachments'),
    `必须打独立上传端点，实际 ${uploads[0].url}`)
  assert.ok(!uploads[0].url.includes('health-records'),
    `独立上传不得带 health-records 段，实际 ${uploads[0].url}`)
  assert.strictEqual(uploads[0].options.name, 'file',
    'multipart part 名固定 file（后端 @RequestPart("file")）')
})
