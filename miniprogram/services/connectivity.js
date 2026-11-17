/**
 * services/connectivity.js —— 全局连接状态（离线只读 / 写操作闸门）
 *
 * 背景（2026-11-17）：
 *   后端断网但小程序仍在运行时，页面会继续渲染本地默认数据/演示数据，按钮也仍可点。
 *   这不是"登录态"问题：request.js 对 NETWORK_ERROR / TIMEOUT 刻意不清会话、不跳登录，
 *   断一次网不该把用户踢下线。真正需要区分的是：
 *
 *     · 读：已加载/缓存内容可以继续看，但必须标明"不是实时"；
 *     · 写：预约、问诊、床位申请、资料修改等会改变医疗状态的动作，必须在线；
 *     · 急诊拨号、本地科普、本地规则导诊等本地能力，不因断网被锁死。
 *
 * 本模块只做三件事：
 *   1) 记录 ONLINE / DEGRADED / OFFLINE 三态（DEGRADED = 服务不可达但设备网络在）；
 *   2) 给页面/组件提供订阅，用于顶部离线条；
 *   3) 给 request.js 提供 ensureWritable()，写请求前先探测网关健康，探测失败直接
 *      返回结构化 OFFLINE 错误——不排队、不假装成功、不吞错。
 *
 * 约束：
 *   · 网络失败绝不清会话、绝不跳登录（与 request.js 既有语义一致）；
 *   · 医疗写操作不做离线队列：恢复网络后让用户重新确认提交，避免"以为提交了"；
 *   · 探测只打匿名 /api/gw/health，不触发业务副作用。
 */
const API = require('../config/api.js')
const ENV = require('../config/env.js')

const PROBE_TIMEOUT_MS = 5000
const PROBE_THROTTLE_MS = 10000

let state = {
  online: true,
  degraded: false,
  source: '',       // 'request' | 'probe' | 'network' | 'mock'
  lastOkAt: 0,
  lastFailAt: 0,
  lastProbeAt: 0
}
let probing = null
let notified = false
let listeners = []

function now() {
  return Date.now()
}

function canUseWx() {
  return typeof wx !== 'undefined' && wx
}

function snapshot() {
  return {
    online: state.online,
    degraded: state.degraded,
    source: state.source,
    lastOkAt: state.lastOkAt,
    lastFailAt: state.lastFailAt,
    // 页面只需要一个布尔值：离线或降级都视为"不能写"
    writable: state.online && !state.degraded
  }
}

function emit() {
  const snap = snapshot()
  listeners.forEach((fn) => {
    try { fn(snap) } catch (e) {}
  })
}

function subscribe(fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.push(fn)
  try { fn(snapshot()) } catch (e) {}
  return function unsubscribe() {
    listeners = listeners.filter((item) => item !== fn)
  }
}

function showOfflineNotice(source) {
  if (notified || !canUseWx() || typeof wx.showModal !== 'function') return
  notified = true
  const demo = source === 'mock'
  wx.showModal({
    title: demo ? '当前展示演示数据' : '院内服务暂时不可用',
    content: demo
      ? '后端未连接，页面显示的是本地演示数据，仅供界面预览。预约、问诊、床位申请等提交操作已暂停。'
      : '当前只能浏览已加载的内容，预约、问诊、床位申请、资料修改等提交操作已暂停。服务恢复后可重试。',
    showCancel: false,
    confirmText: '知道了'
  })
}

function showRecoveredToast() {
  if (!canUseWx() || typeof wx.showToast !== 'function') return
  wx.showToast({ title: '服务已恢复', icon: 'success', duration: 1800 })
}

/**
 * 标记服务可达。
 * @param {string} source 'request' | 'probe' | 'network'
 */
function markOk(source) {
  const wasDown = !state.online || state.degraded
  state.online = true
  state.degraded = false
  state.source = source || 'request'
  state.lastOkAt = now()
  state.lastFailAt = 0
  notified = false
  emit()
  if (wasDown) showRecoveredToast()
}

/**
 * 标记服务不可达 / 降级。
 * @param {*} err 结构化错误（NETWORK_ERROR / TIMEOUT / MOCK_FALLBACK）
 * @param {string} source 'request' | 'network' | 'mock'
 * @param {boolean} [silent] 启动探测失败时静默，避免冷启动就弹窗
 */
function markFail(err, source, silent) {
  const src = source || 'request'
  state.online = false
  state.degraded = true
  state.source = src
  state.lastFailAt = now()
  emit()
  if (!silent) showOfflineNotice(src)
  return err
}

/**
 * 演示数据降级：withFallback 使用 mock 时调用。
 * 语义与"后端不可达"相同，但文案要明确写"演示数据"，不能冒充真实数据。
 */
function markMock(err) {
  return markFail(err || { code: 'MOCK_FALLBACK' }, 'mock', false)
}

function offlineError() {
  const err = new Error('当前未连接院内服务，暂时不能提交。请恢复网络后重试。')
  err.code = 'OFFLINE'
  return err
}

/**
 * 探测网关健康（匿名、只读、无副作用）。
 * @param {{silent?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
function probe(opts) {
  const silent = !!(opts && opts.silent)
  if (probing) return probing
  if (!ENV.gateway) {
    state.online = false
    state.degraded = true
    state.source = 'probe'
    state.lastFailAt = now()
    emit()
    return Promise.resolve(false)
  }
  const url = ENV.gateway + API.GW_HEALTH.path
  probing = new Promise((resolve) => {
    if (!canUseWx() || typeof wx.request !== 'function') {
      resolve(false)
      return
    }
    wx.request({
      url,
      method: 'GET',
      timeout: PROBE_TIMEOUT_MS,
      success: (res) => {
        resolve(!!res && res.statusCode >= 200 && res.statusCode < 300)
      },
      fail: () => resolve(false)
    })
  }).then((ok) => {
    probing = null
    state.lastProbeAt = now()
    if (ok) markOk('probe')
    else markFail({ code: 'NETWORK_ERROR' }, 'probe', silent)
    return ok
  })
  return probing
}

/**
 * 写操作前置：在线直接放行；离线/降级先探测一次。
 * 探测成功 → 放行；失败 → reject OFFLINE（页面用 err-text 显示中文）。
 * 10s 内刚探测失败过则直接拒绝，避免每次点击都等 5s。
 * @returns {Promise<void>}
 */
function ensureWritable() {
  if (state.online && !state.degraded) return Promise.resolve()
  const recentlyFailed = state.lastProbeAt && (now() - state.lastProbeAt < PROBE_THROTTLE_MS) && state.lastFailAt
  if (recentlyFailed) return Promise.reject(offlineError())
  return probe({ silent: true }).then((ok) => {
    if (!ok) throw offlineError()
  })
}

function isWritable() {
  return state.online && !state.degraded
}

function start() {
  if (!canUseWx()) return
  if (typeof wx.onNetworkStatusChange === 'function') {
    wx.onNetworkStatusChange((res) => {
      if (res && res.isConnected) {
        // 设备网络恢复不代表后端恢复：静默探测，成功才真正放行写操作
        probe({ silent: true })
      } else {
        markFail({ code: 'NETWORK_ERROR' }, 'network', false)
      }
    })
  }
  // 冷启动静默探测：只更新状态，不弹窗；页面上的离线条会接管提示
  probe({ silent: true })
}

module.exports = {
  snapshot,
  subscribe,
  markOk,
  markFail,
  markMock,
  probe,
  ensureWritable,
  isWritable,
  offlineError,
  start
}
