/*
 * privacy.test.js —— 微信隐私授权封装（2026-11-17）
 *
 * 为什么单测它：隐私授权是**上架硬门槛**，但它的失败模式很隐蔽——
 *   ① 基础库没有 getPrivacySetting（老工具/低版本）时若 reject，会让语音直接不可用；
 *   ② needAuthorization=false（已同意/未配置）时若仍弹窗，会每点一次语音弹一次；
 *   ③ 用户拒绝时若 resolve(true)，会在未授权情况下采集录音（合规事故）。
 * 这三条都是"看起来能跑"的错，只能用桩把分支钉死。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const MODULE = path.resolve(__dirname, '..', 'utils', 'privacy.js')

function loadWith(wxStub) {
  global.wx = wxStub
  delete require.cache[require.resolve(MODULE)]
  return require(MODULE)
}

test('平台无 getPrivacySetting（低版本/旧工具）→ 放行，不阻断语音', async () => {
  const { ensurePrivacy } = loadWith({})
  assert.equal(await ensurePrivacy(), true)
})

test('needAuthorization=false（已同意或未配置）→ 不弹窗，直接放行', async () => {
  let requireCalled = false
  const { ensurePrivacy } = loadWith({
    getPrivacySetting: ({ success }) => success({ needAuthorization: false }),
    requirePrivacyAuthorize: () => { requireCalled = true }
  })
  assert.equal(await ensurePrivacy(), true)
  assert.equal(requireCalled, false, '已授权时不得重复弹窗')
})

test('needAuthorization=true 且用户同意 → 放行', async () => {
  let popup = 0
  const { ensurePrivacy } = loadWith({
    getPrivacySetting: ({ success }) => success({ needAuthorization: true }),
    requirePrivacyAuthorize: ({ success }) => { popup++; success() }
  })
  assert.equal(await ensurePrivacy(), true)
  assert.equal(popup, 1)
})

test('用户拒绝隐私授权 → 返回 false（调用方必须退回文字输入）', async () => {
  const { ensurePrivacy } = loadWith({
    getPrivacySetting: ({ success }) => success({ needAuthorization: true }),
    requirePrivacyAuthorize: ({ fail }) => fail({ errMsg: 'privacy deny' })
  })
  assert.equal(await ensurePrivacy(), false)
})

test('getPrivacySetting 自身失败 → 放行（平台异常不锁死功能）', async () => {
  const { ensurePrivacy } = loadWith({
    getPrivacySetting: ({ fail }) => fail({ errMsg: 'not supported' })
  })
  assert.equal(await ensurePrivacy(), true)
})

test('openPrivacyContract 失败静默（不抛异常打断页面）', () => {
  const { openPrivacyContract } = loadWith({
    openPrivacyContract: () => { throw new Error('boom') }
  })
  assert.doesNotThrow(() => openPrivacyContract())
})
