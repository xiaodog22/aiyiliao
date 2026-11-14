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

const { aptStatusText, aptDisplayStatus, isPastVisit } = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'apt-status.js'))

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

/* ---------- D-06：过期预约不能还显示「待就诊」 ---------- */

test('AS-05 核心：CONFIRMED 且时段已过 → 显示「已过期」', () => {
  const past = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
  assert.strictEqual(aptDisplayStatus('CONFIRMED', past), '已过期')
  assert.strictEqual(aptDisplayStatus('PENDING', past), '已过期')
})

test('AS-06 核心：未来时段仍显示「待就诊」/「待确认」（不能误杀有效预约）', () => {
  const future = new Date(Date.now() + 3 * 3600 * 1000).toISOString()
  assert.strictEqual(aptDisplayStatus('CONFIRMED', future), '待就诊')
  assert.strictEqual(aptDisplayStatus('PENDING', future), '待确认')
})

test('AS-07 边界：已有 endTime 时以 endTime 为准（就诊中不判过期）', () => {
  const start = new Date(Date.now() - 20 * 60 * 1000).toISOString()   // 20 分钟前开始
  const end = new Date(Date.now() + 10 * 60 * 1000).toISOString()     // 还有 10 分钟结束
  assert.strictEqual(aptDisplayStatus('CONFIRMED', start, end), '待就诊')
  assert.strictEqual(isPastVisit(start, end), false)
})

test('AS-08 边界：时间缺失/非法一律不判过期（宁可显示待就诊，也不误标）', () => {
  assert.strictEqual(aptDisplayStatus('CONFIRMED'), '待就诊')
  assert.strictEqual(aptDisplayStatus('CONFIRMED', 'not-a-date'), '待就诊')
  assert.strictEqual(isPastVisit(null), false)
})

test('AS-09 边界：非「待就诊/待确认」状态不受时间影响（已完成/已取消/就诊中不被改写）', () => {
  const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  assert.strictEqual(aptDisplayStatus('COMPLETED', past), '已完成')
  assert.strictEqual(aptDisplayStatus('CANCELLED', past), '已取消')
  assert.strictEqual(aptDisplayStatus('CHECKED_IN', past), '就诊中')
  assert.strictEqual(aptDisplayStatus('NO_SHOW', past), '未到诊')
})
