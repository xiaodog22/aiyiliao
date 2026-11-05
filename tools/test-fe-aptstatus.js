/**
 * tools/test-fe-aptstatus.js —— utils/apt-status.js 单元测试（前端测试文档 TC-FE-AS-*）
 *
 * 覆盖：契约 7 态映射、大小写/空白容忍、未知值透传、空值。
 *
 * 运行：node tools/test-fe-aptstatus.js
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')

const { aptStatusText } = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'apt-status.js'))

test('AS-01 核心：契约 AppointmentStatus 七态逐值映射', () => {
  const expected = {
    PENDING: '待确认',
    CONFIRMED: '待就诊',
    CHECKED_IN: '就诊中',
    COMPLETED: '已完成',
    CANCELLED: '已取消',
    EXPIRED: '已过期',
    NO_SHOW: '未到诊'
  }
  for (const [status, text] of Object.entries(expected)) {
    assert.strictEqual(aptStatusText(status), text, status)
  }
})

test('AS-02 边界：大小写与首尾空白容忍', () => {
  assert.strictEqual(aptStatusText('pending'), '待确认')
  assert.strictEqual(aptStatusText('Confirmed'), '待就诊')
  assert.strictEqual(aptStatusText('  CHECKED_IN  '), '就诊中')
})

test('AS-03 边界：未知值原样透传（不吞不猜，页面可显示原值）', () => {
  assert.strictEqual(aptStatusText('WEIRD_STATUS'), 'WEIRD_STATUS')
  assert.strictEqual(aptStatusText('已取消'), '已取消') // 旧中文值原样返回
})

test('AS-04 边界：空值 → 空串（不抛异常）', () => {
  assert.strictEqual(aptStatusText(''), '')
  assert.strictEqual(aptStatusText(null), '')
  assert.strictEqual(aptStatusText(undefined), '')
})
