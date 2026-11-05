/**
 * tools/test-fe-errtext.js —— utils/err-text.js 单元测试（前端测试文档 TC-FE-ET-*）
 *
 * 覆盖：已知错误码确定性中文、未知码中文透传、纯 ASCII 拦截 + console.warn 溯源、
 *       兜底文案、项目红线「用户文案禁英文报错 / 禁 HTTP 码」。
 *
 * 运行：node tools/test-fe-errtext.js
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')

const { errText, readable } = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'err-text.js'))

// ==================== ① 已知错误码 → 确定性中文（不看 message） ====================

test('ET-01 核心：九类已知 code 全部命中确定性中文文案', () => {
  const cases = [
    ['NO_BASE_URL', '服务地址未配置，请联系管理员'],
    ['NETWORK_ERROR', '网络连接失败，请检查网络后重试'],
    ['TIMEOUT', '网络较慢，请求超时，请重试'],
    ['HTTP_ERROR', '服务暂时不可用，请稍后重试'],
    ['PARSE_ERROR', '数据格式异常，请稍后重试'],
    ['AUTH_REQUIRED', '登录已过期，请重新登录'],
    ['AUTH_EXPIRED', '登录已过期，请重新登录'],
    ['SESSION_REVOKED', '登录已过期，请重新登录'],
    ['RATE_LIMITED', '操作过于频繁，请稍后再试']
  ]
  for (const [code, want] of cases) {
    assert.strictEqual(errText({ code, message: 'whatever' }), want, 'code=' + code)
  }
})

test('ET-02 红线：已知 code 的文案不含英文字母与 HTTP 码（即使 message 是英文）', () => {
  const codes = ['NO_BASE_URL', 'NETWORK_ERROR', 'TIMEOUT', 'HTTP_ERROR', 'PARSE_ERROR',
    'AUTH_REQUIRED', 'AUTH_EXPIRED', 'SESSION_REVOKED', 'RATE_LIMITED']
  for (const code of codes) {
    const out = errText({ code, message: 'Request failed with status code 500' })
    assert.ok(!/[a-zA-Z]/.test(out), 'code=' + code + ' 泄漏英文: ' + out)
    assert.ok(!/\b\d{3}\b/.test(out), 'code=' + code + ' 泄漏 HTTP 码: ' + out)
  }
})

// ==================== ② 业务错误 / 无 code：仅中文可展示 ====================

test('ET-03 核心：未知 code + 中文 message → 原样透传', () => {
  assert.strictEqual(errText({ code: 'SLOT_FULL', message: '该号源已满，请重新选择号源' }),
    '该号源已满，请重新选择号源')
  assert.strictEqual(errText({ code: 'BIZ_ERROR', message: '预约冲突' }), '预约冲突')
})

test('ET-04 核心：无 code + 中文 message → 透传', () => {
  assert.strictEqual(errText({ message: '网络开小差了' }), '网络开小差了')
})

test('ET-05 红线：纯 ASCII message（JS 异常 / 英文 / HTTP 码）一律拦截为兜底', () => {
  const fallback = errText({ message: 'paginate is not a function' }, '列表加载失败，请重试')
  assert.strictEqual(fallback, '列表加载失败，请重试')
  assert.strictEqual(errText({ code: 'WEIRD', message: 'TypeError: null is not an object' }), '操作失败，请稍后重试')
  assert.strictEqual(errText({ message: '500 Internal Server Error' }), '操作失败，请稍后重试')
})

test('ET-06 可观测：发生兜底替换时 console.warn 一次且带原文（不静默吞错）', () => {
  const warnings = []
  const orig = console.warn
  console.warn = (msg) => warnings.push(String(msg))
  try {
    const out = errText({ code: 'UNKNOWN_X', message: 'boom' }, '兜底')
    assert.strictEqual(out, '兜底')
  } finally {
    console.warn = orig
  }
  assert.strictEqual(warnings.length, 1, '应恰好 warn 一次')
  assert.ok(warnings[0].includes('UNKNOWN_X') && warnings[0].includes('boom'), 'warn 需含 code 与原文')
})

test('ET-07 边界：可读时不 warn（中文透传无副作用）', () => {
  const warnings = []
  const orig = console.warn
  console.warn = (msg) => warnings.push(String(msg))
  try {
    errText({ code: 'BIZ', message: '该号源已满' })
  } finally {
    console.warn = orig
  }
  assert.strictEqual(warnings.length, 0)
})

// ==================== ③ 兜底与入参形态 ====================

test('ET-08 边界：null / undefined / 空对象 → 兜底（不抛异常）', () => {
  assert.strictEqual(errText(null), '操作失败，请稍后重试')
  assert.strictEqual(errText(undefined), '操作失败，请稍后重试')
  assert.strictEqual(errText({}), '操作失败，请稍后重试')
  assert.strictEqual(errText(null, '自定义兜底'), '自定义兜底')
})

test('ET-09 核心：readable() 判定——空/纯 ASCII  false，含中文 true', () => {
  assert.strictEqual(readable(''), false)
  assert.strictEqual(readable(null), false)
  assert.strictEqual(readable('abc 123 !!!'), false)
  assert.strictEqual(readable('网络错误'), true)
  assert.strictEqual(readable('Error: 网络中断'), true) // 含中文即放行（message 整体可读）
})

test('ET-10 边界：自定义 fallback 缺省时用默认兜底', () => {
  assert.strictEqual(errText({ code: 'X', message: 'oops' }), '操作失败，请稍后重试')
  assert.strictEqual(errText({ code: 'X', message: 'oops' }, ''), '操作失败，请稍后重试') // 空串 fallback 也回退默认
})
