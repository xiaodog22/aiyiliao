/*
 * wx-stub.js —— 小程序 `wx` 全局的最小替身（零依赖，测试专用）
 *
 * 为什么需要它：`services/*.js` 在**函数体内**直接调用 `wx.request` / `wx.getStorageSync`，
 * 没有依赖注入。要让这些模块能在 Node 里跑，必须在 require 之前把 `wx` 挂到 globalThis。
 *
 * ⚠️ 这个替身**不是**微信运行时的模拟器：
 *   - 不实现网络、不实现域名校验、不实现真实存储持久化（只是内存 Map）；
 *   - 只实现被测代码实际用到的子集，且每个方法的语义都按微信文档的最小子集对齐；
 *   - 任何"微信特有行为"（例如 request 的 task.abort、分包预下载）都不覆盖。
 * 所以它适合测**纯逻辑**（单飞、重试、缓存、字段映射），不适合测 UI 或真机行为。
 *
 * 关键设计：`request` 由测试通过 `stub.respond()` 编排响应，而不是打真实网络。
 * 这样断言的是"发了几个请求、带什么头、body 长什么样"，与后端解耦、毫秒级。
 */

'use strict'

/** 创建一套独立的 wx 替身（每个测试文件各自一份，互不污染）。 */
function createWxStub() {
  const storage = new Map()
  /** 已发出的请求记录：{ url, method, header, data, resolve, reject } */
  const requests = []
  /** 编排队列：按顺序消费；空队列时按 `defaultResponder` 处理 */
  const queue = []
  let defaultResponder = null

  const stub = {
    // ── 存储 ──
    getStorageSync(key) {
      return storage.has(key) ? storage.get(key) : ''
    },
    setStorageSync(key, value) {
      // 微信会做序列化拷贝；这里深拷贝一次，避免测试里因共享引用产生假阴性
      storage.set(key, value === undefined ? '' : JSON.parse(JSON.stringify(value)))
    },
    removeStorageSync(key) {
      storage.delete(key)
    },
    clearStorageSync() {
      storage.clear()
    },

    // ── 网络 ──
    /**
     * 记录请求并交给编排器决定何时/如何回调。
     * 返回一个 task 对象；微信的 request 会立即返回 task，回调异步发生。
     */
    request(options) {
      const record = {
        url: options.url,
        method: String(options.method || 'GET').toUpperCase(),
        header: options.header || {},
        data: options.data,
        options,
      }
      requests.push(record)
      // 异步回调，模拟真实时序（同步回调会掩盖"单飞未生效"这类竞态）
      Promise.resolve().then(() => dispatch(record))
      return { abort() {}, onHeadersReceived() {}, offHeadersReceived() {} }
    },

    // ── 其它被 services 层用到的零散 API ──
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop', version: '0.0.0' } }
    },
    getSystemInfoSync() {
      return { platform: 'devtools', windowWidth: 375, windowHeight: 812, pixelRatio: 2 }
    },
    showToast() {},
    hideToast() {},
    navigateTo() {},
    redirectTo() {},
    reLaunch() {},
    switchTab() {},
    setNavigationBarTitle() {},
    getFileSystemManager() {
      return { readFileSync() { throw new Error('stub: 未实现 readFileSync') } }
    },
    downloadFile(options) {
      const record = { url: options.url, kind: 'downloadFile', options }
      requests.push(record)
      Promise.resolve().then(() => {
        if (typeof options.success === 'function') {
          options.success({ statusCode: 200, tempFilePath: '/tmp/stub-file' })
        }
        if (typeof options.complete === 'function') options.complete({})
      })
      return { abort() {} }
    },
    uploadFile(options) {
      const record = { url: options.url, kind: 'uploadFile', options }
      requests.push(record)
      Promise.resolve().then(() => {
        if (typeof options.success === 'function') {
          options.success({ statusCode: 200, data: '{"code":"OK","data":{}}' })
        }
        if (typeof options.complete === 'function') options.complete({})
      })
      return { abort() {} }
    },
  }

  /** 消费编排队列；队列为空则回落到 defaultResponder，再没有就返回 200 空 OK。 */
  function dispatch(record) {
    const next = queue.length ? queue.shift() : defaultResponder
    let outcome
    try {
      outcome = typeof next === 'function' ? next(record) : next
    } catch (e) {
      outcome = { error: e }
    }
    if (!outcome) outcome = { statusCode: 200, data: { code: 'OK', data: {} } }

    const { statusCode = 200, data = { code: 'OK', data: {} }, header = {}, delayMs = 0, error } = outcome

    const fire = () => {
      const res = { statusCode, data, header, errMsg: 'request:ok' }
      if (error) {
        if (typeof record.options.fail === 'function') record.options.fail({ errMsg: error.message || String(error) })
        if (typeof record.options.complete === 'function') record.options.complete({})
        return
      }
      if (typeof record.options.success === 'function') record.options.success(res)
      if (typeof record.options.complete === 'function') record.options.complete(res)
    }
    if (delayMs > 0) setTimeout(fire, delayMs)
    else fire()
  }

  return {
    /** 挂到 globalThis（幂等） */
    install() {
      globalThis.wx = stub
      return stub
    },
    /** 底层 wx 对象 */
    wx: stub,
    /** 按顺序编排接下来 N 个请求的响应 */
    queue(...outcomes) {
      queue.push(...outcomes)
    },
    /** 兜底响应（队列空时使用） */
    setDefault(responder) {
      defaultResponder = responder
    },
    /** 已发出的请求（含 downloadFile / uploadFile） */
    requests,
    /** 仅 wx.request 的请求 */
    get httpRequests() {
      return requests.filter((r) => !r.kind)
    },
    /** 清空记录与编排（不自动清 storage，storage 由测试显式控制） */
    reset() {
      requests.length = 0
      queue.length = 0
      defaultResponder = null
    },
    storage,
  }
}

/**
 * 强制丢弃 services 层的模块缓存。
 *
 * 必要性：`request.js` 顶层持有 `refreshPromise` / `readyPromise`（单飞位），`resource.js`
 * 持有 `inflight`。这些是**模块级状态**，跨用例会互相污染——上一个用例留下的 inflight
 * 会让下一个用例"看起来只发了 1 个请求"，造成假阳性。
 * 所以每个用例前必须清缓存重新 require，模拟"冷启动"。
 */
function purgeModuleCache(moduleDir) {
  const prefix = require('node:path').resolve(moduleDir)
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key]
  }
}

module.exports = { createWxStub, purgeModuleCache }
