/*
 * sse.test.js —— SSE 字节流解析器（对外流式二期，零依赖，node:test）
 *
 * 为什么必须先有这层测试：`onChunkReceived` 的切点是**字节级、无语义保证**的。
 * 一个汉字 3 字节、一个帧分隔符 2 字节，任何切点组合都可能在真机上出现。
 * 真机只能验证"某一次切分恰好没问题"，只有穷举切分才能证明解析器正确。
 *
 * 断言口径：把事件投影成 {event, seq, data} 后**深比较整个序列**，
 * 而不是只看"包含某段文字"——后者会漏掉丢帧、重复帧、乱码。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { createParser, _internal } = require('../services/sse.js')

// 与服务端真实输出同构：一期冻结契约的四种事件，正文含中文标点
const CANONICAL =
  'event: start\n' +
  'id: 1\n' +
  'data: {"taskId":"t-1","taskType":"CHAT"}\n' +
  '\n' +
  'event: delta\n' +
  'id: 2\n' +
  'data: {"text":"你好，我"}\n' +
  '\n' +
  'event: delta\n' +
  'id: 3\n' +
  'data: {"text":"在的。"}\n' +
  '\n' +
  'event: done\n' +
  'id: 4\n' +
  'data: {"finishReason":"stop","cached":false}\n' +
  '\n'

function bytesOf(str) {
  return new Uint8Array(Buffer.from(str, 'utf8'))
}

/** 跑一遍解析器，返回事件投影序列 */
function collect(chunks) {
  const events = []
  const parser = createParser({
    onEvent: function (e) {
      events.push({ event: e.event, seq: e.seq, data: e.data })
    }
  })
  for (let i = 0; i < chunks.length; i++) parser.push(chunks[i])
  parser.end()
  return events
}

/** 整段一次投递的基准结果 */
function baseline() {
  return collect([bytesOf(CANONICAL)])
}

test('整段投递：四种事件齐全，正文正确拼合', () => {
  const events = baseline()
  assert.strictEqual(events.length, 4)
  assert.deepStrictEqual(events.map((e) => e.event), ['start', 'delta', 'delta', 'done'])
  assert.deepStrictEqual(events.map((e) => e.seq), [1, 2, 3, 4])
  assert.strictEqual(events[0].data.taskId, 't-1')
  const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')
  assert.strictEqual(text, '你好，我在的。')
  assert.strictEqual(events[3].data.finishReason, 'stop')
})

test('任意单点切分：每个切分位置的事件序列都必须与整段一致', () => {
  const bytes = bytesOf(CANONICAL)
  const want = baseline()
  let checked = 0
  for (let cut = 1; cut < bytes.length; cut++) {
    const got = collect([bytes.subarray(0, cut), bytes.subarray(cut)])
    assert.deepStrictEqual(got, want, `切分点 ${cut} 结果不一致`)
    checked++
  }
  assert.ok(checked > 100, `应覆盖全部切分点，实际 ${checked}`)
})

test('逐字节投递：每个字节单独一块（最极端的 UTF-8 与帧边界切断）', () => {
  const bytes = bytesOf(CANONICAL)
  const chunks = []
  for (let i = 0; i < bytes.length; i++) chunks.push(bytes.subarray(i, i + 1))
  assert.deepStrictEqual(collect(chunks), baseline())
})

test('定点复现：汉字被切成 3 块 + 帧分隔符被切开', () => {
  // "你" = E4 BD A0；这里把 CANONICAL 按「每个汉字单独切三份」的方式重排
  const bytes = bytesOf(CANONICAL)
  const chunks = []
  let i = 0
  // 步长取 1/2/3 交替，能同时命中 2 字节与 3 字节序列的中间位置
  let step = 1
  while (i < bytes.length) {
    chunks.push(bytes.subarray(i, Math.min(i + step, bytes.length)))
    i += step
    step = step === 3 ? 1 : step + 1
  }
  const got = collect(chunks)
  assert.deepStrictEqual(got, baseline())
  const text = got.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')
  assert.strictEqual(text, '你好，我在的。', '不能出现替换字符或丢字')
  assert.ok(text.indexOf('\ufffd') === -1)
})

test('utf8SafeLength：不完整的尾序列必须被拦住', () => {
  const safe = _internal.utf8SafeLength
  // "你" 的 3 字节
  assert.strictEqual(safe(new Uint8Array([0xe4, 0xbd, 0xa0])), 3, '完整码点应全部安全')
  assert.strictEqual(safe(new Uint8Array([0xe4, 0xbd])), 0, '缺尾字节，整块都不能解码')
  assert.strictEqual(safe(new Uint8Array([0xe4])), 0)
  assert.strictEqual(safe(new Uint8Array([0x41, 0xe4, 0xbd])), 1, 'ASCII 后可解码，汉字部分留待下一块')
  assert.strictEqual(safe(new Uint8Array([0x41, 0x42])), 2)
  // 4 字节（emoji）同样要拦住半截
  const emoji = new Uint8Array(Buffer.from('😀', 'utf8'))
  assert.strictEqual(safe(emoji.subarray(0, 2)), 0)
  assert.strictEqual(safe(emoji), 4)
})

test('CRLF 行尾：\\r 被切在块尾时不产生多余空帧', () => {
  const crlf = CANONICAL.replace(/\n/g, '\r\n')
  const bytes = bytesOf(crlf)
  const want = baseline()
  for (let cut = 1; cut < bytes.length; cut++) {
    const got = collect([bytes.subarray(0, cut), bytes.subarray(cut)])
    assert.deepStrictEqual(got, want, `CRLF 切分点 ${cut} 结果不一致`)
  }
})

test('心跳注释帧被忽略，不影响事件序列', () => {
  const withPing = ': ping\n\n' + CANONICAL
  assert.deepStrictEqual(collect([bytesOf(withPing)]), baseline())
})

test('非 JSON 的 data 不抛错：标记 parseError 并原样透出', () => {
  const events = collect([bytesOf('event: delta\nid: 1\ndata: 半截{不是JSON\n\n')])
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].data, '半截{不是JSON')
})

test('末尾无空行：end() 收尾时把最后一段当作完整帧', () => {
  const noTail = CANONICAL.replace(/\n$/, '')
  assert.deepStrictEqual(collect([bytesOf(noTail)]), baseline())
})

test('空块与空字符串安全：不产生事件、不崩', () => {
  const events = collect([new Uint8Array(0), '', bytesOf(CANONICAL), new Uint8Array(0)])
  assert.deepStrictEqual(events, baseline())
})

test('字符串入参（非 ArrayBuffer）按文本直通', () => {
  assert.deepStrictEqual(collect([CANONICAL]), baseline())
})

test('stats 反映真实帧数与字节数', () => {
  const parser = createParser({})
  parser.push(bytesOf(CANONICAL))
  parser.end()
  const s = parser.stats()
  assert.strictEqual(s.frames, 4)
  assert.strictEqual(s.bytes, bytesOf(CANONICAL).length)
  assert.strictEqual(s.pendingBytes, 0)
})
