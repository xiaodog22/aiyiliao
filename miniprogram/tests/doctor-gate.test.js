/*
 * doctor-gate.test.js —— 全局 Page 包装的医生分包门禁（审计 M13 逻辑面）
 *
 * 覆盖 app.js 里那段「只在 pages/doctor/** 上包一层」的包装：
 *   ① 服务端 whoami 判否 → reLaunch 登录页，且原页面 onLoad **不执行**；
 *   ② 判是 → 原 onLoad 正常执行；
 *   ③ 校验抛错（网络/500）→ 同样 reLaunch，不执行 onLoad（fail-closed）；
 *   ④ 非医生分包页面 → 完全不触发角色校验，原 onLoad 同步执行。
 *
 * ⚠️ 这是**逻辑级**验证（node + wx 替身），不等于真机渲染验收：
 *    真机还需要微信开发者工具 + 手机扫码，步骤见 docs/修复任务书 D.6。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { createWxStub, purgeModuleCache } = require('./support/wx-stub.js')

const ROOT = path.resolve(__dirname, '..')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 加载 app.js 并返回被包装后的 Page。
 * @param {Function} roleCheck 返回 Promise<boolean> 的假 verifyDoctorRole
 */
function boot(roleCheck) {
  purgeModuleCache(ROOT)
  const stub = createWxStub()
  const wx = stub.install()
  const redirects = []
  const roleChecks = []
  wx.reLaunch = (opt) => { redirects.push((opt && opt.url) || '') }

  let captured = null
  // 原生 Page：真实运行时是"登记页面对象"，这里只捕获 options
  globalThis.Page = function (options) { captured = options }
  globalThis.App = function () { }
  globalThis.getApp = () => ({
    verifyDoctorRole: () => {
      roleChecks.push(1)
      return roleCheck()
    }
  })

  require('../app.js')
  const wrapper = globalThis.Page

  return {
    wx,
    redirects,
    roleChecks,
    register(options) {
      wrapper(options)
      return captured
    }
  }
}

test('医生分包 + 服务端判否 → 跳登录页且不执行原 onLoad', async () => {
  const env = boot(() => Promise.resolve(false))
  let loaded = false
  const page = env.register({ onLoad() { loaded = true } })
  const instance = { route: 'pages/doctor/workbench/workbench' }

  page.onLoad.call(instance, {})
  await flush()

  assert.deepEqual(env.redirects, ['/pages/auth/login/login'], '必须 reLaunch 回登录页')
  assert.equal(loaded, false, '未通过角色校验时不得执行页面 onLoad（不加载医生业务数据）')
})

test('医生分包 + 服务端判是 → 原 onLoad 执行且不跳转', async () => {
  const env = boot(() => Promise.resolve(true))
  let loaded = 0
  const page = env.register({ onLoad() { loaded += 1 } })
  const instance = { route: 'pages/doctor/appointments/appointments' }

  page.onLoad.call(instance, {})
  await flush()

  assert.equal(loaded, 1)
  assert.deepEqual(env.redirects, [])
})

test('角色校验抛错 → fail-closed 跳登录页，不执行 onLoad', async () => {
  const env = boot(() => Promise.reject(new Error('whoami 500')))
  let loaded = false
  const page = env.register({ onLoad() { loaded = true } })
  const instance = { route: 'pages/doctor/beds/beds' }

  page.onLoad.call(instance, {})
  await flush()

  assert.deepEqual(env.redirects, ['/pages/auth/login/login'])
  assert.equal(loaded, false)
})

test('非医生分包页面 → 不触发角色校验，onLoad 同步执行', async () => {
  const env = boot(() => Promise.resolve(false))
  let loaded = false
  const page = env.register({ onLoad() { loaded = true } })
  const instance = { route: 'pages/profile/profile' }

  page.onLoad.call(instance, {})
  await flush()

  assert.equal(loaded, true)
  assert.equal(env.roleChecks.length, 0, '患者页面不应触发 whoami')
  assert.deepEqual(env.redirects, [])
})

test('同一页面重复进入只校验一次（_doctorGate 复用）', async () => {
  const env = boot(() => Promise.resolve(true))
  let loaded = 0
  const page = env.register({ onLoad() { loaded += 1 }, onShow() { loaded += 1 } })
  const instance = { route: 'pages/doctor/workbench/workbench' }

  page.onLoad.call(instance, {})
  page.onShow.call(instance)
  await flush()

  assert.equal(env.roleChecks.length, 1, 'onLoad/onShow 应复用同一个 gate Promise')
  assert.equal(loaded, 2)
})
