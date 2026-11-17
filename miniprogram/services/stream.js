/**
 * stream.js —— AI 任务事件流客户端（对外流式二期）
 *
 * 链路：小程序 → 网关 → business-service → ai-service。
 * 本模块只做三件事：把字节流喂给解析器、把事件翻译成页面回调、在不可用时如实降级。
 *
 * 两条铁律（来自一期冻结契约与二期设计）：
 *  ① **流只是增量通道**，权威终态永远是 `GET /api/v1/ai/tasks/{taskId}`。
 *     所以这里的 `onError` 不等于「任务失败」，而是「实时通道断了，去轮询」。
 *  ② **降级绝不重新提交任务**。换新幂等键 = 第二次推理 + 两段不同答案 + 白烧 7B CPU。
 *
 * 事件来源有两套词汇（都是本服务产出，客户端按需取用）：
 *  - 业务事件（business `/events`）：accepted / status / delta / citation / safety / tts / completed / cancelled / error
 *  - 内部事件（ai-service `/stream`，经 business 转发后与上面同形）
 */

'use strict'

const req = require('./request.js')
const API = require('../config/api.js')
const sse = require('./sse.js')

/** 服务端 SSE 总时长 130s，这里留 20s 余量；超时后走降级轮询。 */
const DEFAULT_TIMEOUT = 150000

function normaliseError(payload) {
  const p = payload || {}
  // business 层错误是 { error: { code, message, retryable } }；ai-service 层是平铺
  const e = p.error && typeof p.error === 'object' ? p.error : p
  return {
    code: e.code || 'STREAM_ERROR',
    message: e.message || '实时通道异常',
    retryable: e.retryable !== false
  }
}

/**
 * 打开某任务的事件流。
 *
 * @param {string} taskId
 * @param {Object} handlers
 *   onStatus(data)       accepted / status 事件
 *   onDelta(text)        增量正文（已从 JSON 里抽好，可直接追加显示）
 *   onDone(data)         正常收尾（completed / cancelled）
 *   onError(err)         {code,message,retryable}——含义是「去轮询」，不是「任务失败」
 *   onUnsupported()      环境不支持分块下发：直接走轮询
 *   onExtra(type, data)  citation / safety / tts 等扩展事件（可选）
 * @param {{timeout?:number}} [opts]
 * @returns {{abort:Function, isOpen:Function}}
 */
function open(taskId, handlers, opts) {
  const h = handlers || {}
  const o = opts || {}
  const state = { aborted: false, settled: false, handle: null }
  const id = String(taskId == null ? '' : taskId).trim()

  const call = (name, a, b) => {
    if (state.aborted) return
    try {
      if (typeof h[name] === 'function') h[name](a, b)
    } catch (e) {
      // 页面回调异常不得中断读取
    }
  }

  const settle = () => {
    state.settled = true
  }

  // 无 taskId 直接拒绝：拼出 `/tasks//events` 会被网关当成另一条路由（实测 404）。
  if (!id) {
    call('onError', { code: 'VALIDATION_FAILED', message: '缺少任务标识', retryable: false })
    return { abort() {}, isOpen() { return false } }
  }
  const spec = req.withPath(API.AI_TASK_EVENTS, { taskId: id })

  const parser = sse.createParser({
    onEvent(evt) {
      if (state.aborted) return
      const type = evt.event
      if (type === 'delta') {
        const text = evt.data && typeof evt.data === 'object' ? evt.data.text : ''
        if (text) call('onDelta', text)
        return
      }
      if (type === 'completed' || type === 'cancelled') {
        settle()
        call('onDone', evt.data || {})
        return
      }
      if (type === 'done') {
        settle()
        call('onDone', evt.data || {})
        return
      }
      if (type === 'error') {
        settle()
        call('onError', normaliseError(evt.data))
        return
      }
      if (type === 'accepted' || type === 'status') {
        call('onStatus', evt.data || {})
        return
      }
      // citation / safety / tts / 未知类型：不猜测语义，交给页面按需处理
      call('onExtra', type, evt.data)
    }
  })

  req.openStream(spec, {
    chunk: (data) => parser.push(data),
    success: (res) => {
      parser.end()
      if (state.settled || state.aborted) return
      const code = res && res.statusCode
      if (code === 401) {
        call('onError', { code: 'UNAUTHORIZED', message: '登录状态已过期', retryable: false })
      } else if (code >= 400) {
        call('onError', { code: 'HTTP_ERROR', message: '实时通道不可用（' + code + '）', retryable: true })
      } else {
        // 连接正常结束却没有终态事件（服务端超时/被中间层截断）→ 去轮询
        call('onError', { code: 'STREAM_ENDED', message: '实时通道已结束', retryable: true })
      }
    },
    fail: () => {
      call('onError', { code: 'NETWORK_ERROR', message: '网络异常，实时通道中断', retryable: true })
    },
    unsupported: () => call('onUnsupported')
  }, { timeout: typeof o.timeout === 'number' ? o.timeout : DEFAULT_TIMEOUT })
    .then((handle) => {
      state.handle = handle
      if (state.aborted) handle.abort() // 在拿到 task 之前就 abort 了
    })
    .catch((err) => {
      call('onError', {
        code: (err && err.code) || 'NO_BASE_URL',
        message: (err && err.message) || '实时通道不可用',
        retryable: true
      })
    })

  return {
    abort() {
      state.aborted = true
      if (state.handle) state.handle.abort()
    },
    isOpen() {
      return !state.aborted && !state.settled
    }
  }
}

module.exports = { open, DEFAULT_TIMEOUT }
