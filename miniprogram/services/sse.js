/**
 * sse.js —— SSE 字节流解析器（对外流式二期，纯逻辑、零依赖、无 wx）
 *
 * 为什么不能直接用现成的 `decodeUTF8` 拼字符串：
 *   `wx.request({enableChunked:true})` 的 `onChunkReceived` 按**字节**切分，切点没有任何语义保证。
 *   ① 一个汉字 3 字节，切点若落在中间，逐块解码必出 `�`（且是不可逆的丢失，拼不回来）；
 *   ② 帧分隔符 `\n\n` 也可能被切开，按块解析会拿到半截 JSON。
 *   所以必须做两层缓冲：**字节层凑齐完整码点再解码 → 文本层凑齐完整帧再解析**。
 *   这条约束在 Node 里可以用「任意切分方式输入，输出事件序列必须一致」完全验证，不必等真机。
 *
 * 契约来源：`docs/设计/对外流式契约提案.md` §0.1.1（一期冻结：start/delta/done/error）。
 */

'use strict'

/** 一帧最多缓存多少字符：超过即判定为脏流，避免无限增长（正常帧 < 1KB） */
const MAX_FRAME_CHARS = 64 * 1024

function toBytes(chunk) {
  if (!chunk) return null
  if (typeof chunk === 'string') return null // 字符串走旁路，不参与字节缓冲
  if (chunk instanceof Uint8Array) return chunk
  if (typeof ArrayBuffer !== 'undefined' && chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  // 小程序里偶见 { data: ArrayBuffer } 透传，兜一层
  if (chunk.buffer && typeof chunk.byteLength === 'number') {
    return new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength)
  }
  return null
}

function concatBytes(a, b) {
  if (!a || !a.length) return b
  if (!b || !b.length) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * 计算「可以安全解码」的字节前缀长度：末尾若有多字节序列未凑齐，就停在序列首字节之前。
 *
 * 反例（必须拦住）：`E4 BD` + `A0` —— 前两块只到「你」的前两字节，
 * 直接解码会得到一个替换字符，且第三块到达后再也拼不回原字。
 *
 * @param {Uint8Array} bytes
 * @returns {number} 安全长度（0 表示整块都还不能解码）
 */
function utf8SafeLength(bytes) {
  const n = bytes.length
  if (!n) return 0
  let i = n - 1
  let cont = 0
  while (i >= 0 && (bytes[i] & 0xc0) === 0x80 && cont < 3) {
    i--
    cont++
  }
  if (i < 0) return 0 // 整块都是续字节：首字节在上一块，等下一块
  const lead = bytes[i]
  let need
  if (lead < 0x80) need = 1
  else if (lead >= 0xc0 && lead < 0xe0) need = 2
  else if (lead >= 0xe0 && lead < 0xf0) need = 3
  else if (lead >= 0xf0 && lead < 0xf8) need = 4
  else need = 1 // 非法首字节：吞掉 1 字节，避免整个流卡死
  return n - i >= need ? n : i
}

/** 解码一段**已保证码点完整**的 UTF-8 字节；不依赖 TextDecoder（旧基础库无此 API） */
function decodeBytes(bytes) {
  const n = bytes.length
  let out = ''
  let i = 0
  while (i < n) {
    const b = bytes[i++]
    if (b < 0x80) {
      out += String.fromCharCode(b)
    } else if (b >= 0xc0 && b < 0xe0) {
      if (i >= n) break
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f))
    } else if (b >= 0xe0 && b < 0xf0) {
      if (i + 1 >= n) break
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f))
    } else if (b >= 0xf0) {
      if (i + 2 >= n) break
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f)
      const v = cp - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    } else {
      out += '\ufffd'
    }
  }
  return out
}

/**
 * 解析单个帧（不含分隔空行）。
 * 返回 null 表示空帧/纯注释帧（如心跳），调用方直接丢弃。
 */
function parseFrame(raw) {
  const lines = String(raw).split('\n')
  let event = ''
  let id = ''
  let retry = ''
  let hasData = false
  const dataLines = []

  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]
    if (!line) continue
    if (line.charAt(0) === ':') continue // 注释帧（心跳），按 SSE 规范忽略
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    let value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.charAt(0) === ' ') value = value.slice(1) // 规范：冒号后允许一个空格
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') {
      dataLines.push(value)
      hasData = true
    } else if (field === 'retry') retry = value
    // 其余字段按规范忽略
  }

  if (!hasData && !event && !id) return null

  const text = dataLines.join('\n')
  let data = text
  let parseError = false
  if (hasData) {
    try {
      data = text ? JSON.parse(text) : null
    } catch (e) {
      // 半截 JSON 到这里说明上游违约，但不能因此中断整条流：原样交给调用方判定
      data = text
      parseError = true
    }
  }

  const evt = { event: event || 'message', id: id || '', data: data, raw: String(raw) }
  if (id && /^\d+$/.test(id)) evt.seq = parseInt(id, 10)
  if (retry) evt.retry = parseInt(retry, 10) || 0
  if (parseError) evt.parseError = true
  return evt
}

/**
 * 创建解析器。
 *
 * @param {{onEvent?:function, onError?:function}} handlers
 *   onEvent(evt)  evt = { event, id, seq?, data, raw, parseError? }
 *   onError(err)  仅在帧超长（脏流）时回调，解析器会自动丢弃该帧并继续
 * @returns {{push:function, end:function, stats:function, dropped:function}}
 */
function createParser(handlers) {
  const opts = handlers || {}
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {}
  const onError = typeof opts.onError === 'function' ? opts.onError : function () {}

  let pendingBytes = new Uint8Array(0) // 未凑齐码点的字节
  let pendingText = '' // 未凑齐帧的文本
  let frameCount = 0
  let byteCount = 0
  let droppedCount = 0
  let ended = false

  function emitFrame(raw) {
    if (!raw) return
    const evt = parseFrame(raw)
    if (!evt) return
    frameCount++
    onEvent(evt)
  }

  /** 从文本缓冲里反复切出完整帧（`\n\n` 分隔） */
  function drainText() {
    for (;;) {
      const idx = pendingText.indexOf('\n\n')
      if (idx === -1) {
        if (pendingText.length > MAX_FRAME_CHARS) {
          droppedCount++
          onError(new Error('SSE 帧超长，已丢弃'))
          pendingText = ''
        }
        return
      }
      const raw = pendingText.slice(0, idx)
      pendingText = pendingText.slice(idx + 2)
      emitFrame(raw)
    }
  }

  function push(chunk) {
    if (ended) return
    if (typeof chunk === 'string') {
      byteCount += chunk.length
      pendingText += chunk
      drainText()
      return
    }
    const bytes = toBytes(chunk)
    if (!bytes || !bytes.length) return
    byteCount += bytes.length
    const merged = concatBytes(pendingBytes, bytes)
    const safe = utf8SafeLength(merged)
    if (safe <= 0) {
      pendingBytes = merged
      return
    }
    pendingText += decodeBytes(merged.subarray(0, safe))
    pendingBytes = safe >= merged.length ? new Uint8Array(0) : merged.subarray(safe)
    // 统一行尾：完整的 \r\n 归一为 \n；**末尾孤立的 \r 必须留到下一块**（可能正是被切开的 \r\n）
    if (pendingText.indexOf('\r') !== -1) {
      pendingText = pendingText.replace(/\r\n/g, '\n')
      if (pendingText.charAt(pendingText.length - 1) === '\r') {
        pendingText = pendingText.slice(0, -1).replace(/\r/g, '\n') + '\r'
      } else {
        pendingText = pendingText.replace(/\r/g, '\n')
      }
    }
    drainText()
  }

  /** 流结束：强制收尾（残留字节按替换字符兜底，残留文本按最后一帧解析） */
  function end() {
    if (ended) return
    ended = true
    if (pendingBytes.length) {
      pendingText += decodeBytes(pendingBytes)
      pendingBytes = new Uint8Array(0)
    }
    if (pendingText.indexOf('\r') !== -1) pendingText = pendingText.replace(/\r\n/g, '\n')
    // 上游可能省略末尾空行：把最后一段当完整帧收掉
    const rest = pendingText
    pendingText = ''
    if (rest && rest.replace(/\n+$/, '')) emitFrame(rest.replace(/\n+$/, ''))
  }

  return {
    push: push,
    end: end,
    stats: function () {
      return { frames: frameCount, bytes: byteCount, dropped: droppedCount, pendingBytes: pendingBytes.length }
    }
  }
}

module.exports = {
  createParser: createParser,
  // 导出给单测直接断言内部不变量
  _internal: { utf8SafeLength: utf8SafeLength, decodeBytes: decodeBytes, parseFrame: parseFrame }
}
