/*
 * secret-store.test.js —— refresh 令牌静态混淆存储回归（审计 M14）
 *
 * 钉住四件事：
 *   ① storage 里不能再出现 `rt-` 明文（历史明文要就地升级）；
 *   ② 混淆串必须能原样还原，且同一明文的两次写入不同（seed 随机）；
 *   ③ 密钥变了 / 密文被截断 → 还原为空串，绝不返回半截令牌；
 *   ④ 混淆不可用（无密钥）时**不落盘**，不能悄悄退回明文。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { createWxStub, purgeModuleCache } = require('./support/wx-stub.js')

const MINIPROGRAM_ROOT = path.resolve(__dirname, '..')
const REFRESH_KEY = 'wb_refresh_token'
const SECRET_KEY = 'wb_sk'

function load() {
  purgeModuleCache(MINIPROGRAM_ROOT)
  const stub = createWxStub()
  const wx = stub.install() // install() 返回真正的 wx 替身（控制器另有 queue/reset 等）
  const secretStore = require('../utils/secret-store.js')
  return { stub, wx, secretStore }
}

test('写入后 storage 里没有 rt- 明文，且能还原', () => {
  const { stub, wx, secretStore } = load()
  const token = 'rt-11111111-2222-3333-4444-555555555555'
  assert.equal(secretStore.put(REFRESH_KEY, token), true)

  const raw = wx.getStorageSync(REFRESH_KEY)
  assert.ok(typeof raw === 'string' && raw.indexOf('v1.') === 0, '落盘值应是 v1.<seed>.<b64>')
  assert.ok(raw.indexOf('rt-') === -1, '落盘值不得包含 rt- 明文')
  assert.ok(raw.indexOf('555555555555') === -1, '落盘值不得包含令牌片段')
  assert.equal(secretStore.get(REFRESH_KEY), token)
})

test('同一明文两次写入密文不同（seed 每次随机）', () => {
  const { stub, wx, secretStore } = load()
  secretStore.put(REFRESH_KEY, 'rt-same-token')
  const a = wx.getStorageSync(REFRESH_KEY)
  secretStore.put(REFRESH_KEY, 'rt-same-token')
  const b = wx.getStorageSync(REFRESH_KEY)
  assert.notEqual(a, b)
  assert.equal(secretStore.get(REFRESH_KEY), 'rt-same-token')
})

test('历史明文（升级前写入）读取时就地升级为混淆串', () => {
  const { stub, wx, secretStore } = load()
  wx.setStorageSync(REFRESH_KEY, 'rt-legacy-plain-text')
  assert.equal(secretStore.get(REFRESH_KEY), 'rt-legacy-plain-text', '首次读仍要能拿到令牌')
  const raw = wx.getStorageSync(REFRESH_KEY)
  assert.ok(raw.indexOf('v1.') === 0, '读一次后应已重写为混淆串')
  assert.ok(raw.indexOf('rt-legacy') === -1)
})

test('密钥被换掉 / 密文损坏 → 返回空串（不返回半截令牌）', () => {
  const { stub, wx, secretStore } = load()
  secretStore.put(REFRESH_KEY, 'rt-secret-token')
  wx.setStorageSync(SECRET_KEY, 'ffffffffffffffffffffffffffffffff')
  assert.equal(secretStore.get(REFRESH_KEY), '')

  const { wx: wx2, secretStore: store2 } = load()
  store2.put(REFRESH_KEY, 'rt-secret-token')
  const broken = wx2.getStorageSync(REFRESH_KEY).slice(0, 12)
  wx2.setStorageSync(REFRESH_KEY, broken)
  assert.equal(store2.get(REFRESH_KEY), '')
})

test('无密钥（storage 写不进去）时拒绝落盘，而不是退化成明文', () => {
  const { stub, wx, secretStore } = load()
  const originalSet = wx.setStorageSync
  wx.setStorageSync = function (key, value) {
    if (key === SECRET_KEY) throw new Error('storage full')
    return originalSet.call(this, key, value)
  }
  assert.equal(secretStore.put(REFRESH_KEY, 'rt-should-not-persist'), false)
  assert.equal(wx.getStorageSync(REFRESH_KEY), '')
})

test('session.js 落盘的 refresh 是混淆串，且 snapshot/restore 后仍可用', () => {
  const { stub, wx } = load()
  const session = require('../services/session.js')
  session.setTokens({ accessToken: 'at-x', refreshToken: 'rt-session-token', expiresIn: 7200 })

  const raw = wx.getStorageSync(REFRESH_KEY)
  assert.ok(String(raw).indexOf('v1.') === 0, 'session 必须走混淆存储')
  assert.ok(String(raw).indexOf('rt-session-token') === -1)

  const snap = session.snapshot()
  assert.equal(snap.refresh, 'rt-session-token', 'snapshot 取明文供恢复使用')
  session.clear()
  assert.equal(wx.getStorageSync(REFRESH_KEY), '')
  assert.equal(session.restore(snap), true)
  assert.equal(session.getRefreshToken(), 'rt-session-token')
  assert.ok(String(wx.getStorageSync(REFRESH_KEY)).indexOf('v1.') === 0, 'restore 也应重新混淆')
})
