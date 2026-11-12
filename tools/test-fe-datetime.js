/**
 * tools/test-fe-datetime.js —— utils/datetime.js 单元测试（前端测试文档 TC-FE-DT-*）
 *
 * 覆盖：fmtDate / fmtLocalDateTime 的核心功能、边界、异常流程。
 * 时区敏感性：fmtLocalDateTime 的 ISO 分支按「设备本地时区」展示，
 * 本文件要求在 TZ=Asia/Shanghai 下运行（入口 test-fe-all.js 已固定）；
 * 单独运行时若 TZ 不同，ISO 分支两用例会明确失败并提示，而非静默错判。
 *
 * 运行：node tools/test-fe-datetime.js   （或 node --test tools/test-fe-datetime.js）
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')

const { fmtDate, fmtLocalDateTime } = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'datetime.js'))
const { slotDateTime } = require(path.join(__dirname, '..', 'miniprogram', 'services', 'appointment.js'))

// ==================== fmtDate：ISO Instant / 纯日期 → YYYY-MM-DD ====================

test('DT-01 核心：ISO Instant 按设备本地时区取日期（UTC→本地可能跨日）', () => {
  // 01:30Z → 上海(+8) 09:30 同日
  assert.strictEqual(fmtDate('2026-10-18T01:30:00Z'), '2026-10-18')
  // 23:59:59Z → 上海(+8) 次日 07:59：ISO 分支按本地时区取日期，跨日必须体现
  assert.strictEqual(fmtDate('2026-10-18T23:59:59Z'), '2026-10-19')
  // 01:30+08:00 = 前一日 17:30Z → 上海次日 01:30（同日 18 号）
  assert.strictEqual(fmtDate('2026-10-18T01:30:00.123+08:00'), '2026-10-18')
})

test('DT-02 核心：纯日期串原样返回（不走 Date，避免跨日偏移）', () => {
  assert.strictEqual(fmtDate('2026-08-30'), '2026-08-30')
  assert.strictEqual(fmtDate('2026-01-01'), '2026-01-01')
})

test('DT-03 边界：无 T 的「日期 时间」串取日期部分', () => {
  assert.strictEqual(fmtDate('2026-08-30 09:30'), '2026-08-30')
  assert.strictEqual(fmtDate('2026-08-30 09:30:00'), '2026-08-30')
})

test('DT-04 边界：空值 → 空串（不抛异常）', () => {
  assert.strictEqual(fmtDate(''), '')
  assert.strictEqual(fmtDate(null), '')
  assert.strictEqual(fmtDate(undefined), '')
})

test('DT-05 异常：不可解析串原样透传（不吞不猜）', () => {
  assert.strictEqual(fmtDate('abc'), 'abc')
  assert.strictEqual(fmtDate('not-a-date'), 'not-a-date')
  // 日期形态但非法（如 13 月）→ Date 解析失败 → 原样返回
  assert.strictEqual(fmtDate('2026-13-45T00:00:00Z'), '2026-13-45T00:00:00Z')
})

// ==================== fmtLocalDateTime：本地时区 { date, time } ====================

test('DT-06 核心：空值 → 双空串', () => {
  assert.deepStrictEqual(fmtLocalDateTime(''), { date: '', time: '' })
  assert.deepStrictEqual(fmtLocalDateTime(null), { date: '', time: '' })
  assert.deepStrictEqual(fmtLocalDateTime(undefined), { date: '', time: '' })
})

test('DT-07 核心：无时区标记的演示数据直接拆分（iOS 兼容路径）', () => {
  assert.deepStrictEqual(fmtLocalDateTime('2026-08-30'), { date: '2026-08-30', time: '' })
  assert.deepStrictEqual(fmtLocalDateTime('2026-08-30 09:30'), { date: '2026-08-30', time: '09:30' })
  assert.deepStrictEqual(fmtLocalDateTime('2026-08-30T09:30:00'), { date: '2026-08-30', time: '09:30' })
  assert.deepStrictEqual(fmtLocalDateTime('2026-08-30 09:30:45'), { date: '2026-08-30', time: '09:30' })
})

test('DT-08 核心：带时区 ISO Instant → 本地时区（Asia/Shanghai = UTC+8）', () => {
  // 01:30Z + 8h = 09:30 同日
  assert.deepStrictEqual(fmtLocalDateTime('2026-10-18T01:30:00Z'), { date: '2026-10-18', time: '09:30' })
  // 17:30Z + 8h = 次日 01:30（跨日偏移必须体现，不能被截成同日）
  assert.deepStrictEqual(fmtLocalDateTime('2026-10-18T17:30:00Z'), { date: '2026-10-19', time: '01:30' })
})

test('DT-09 边界：带 +08:00 显式偏移的 Instant', () => {
  // 09:30+08:00 = 01:30Z → 本地（+8）09:30
  assert.deepStrictEqual(fmtLocalDateTime('2026-10-18T09:30:00+08:00'), { date: '2026-10-18', time: '09:30' })
})

test('DT-10 异常：不可解析串 → 双空串（页面据此不渲染，不显示 NaN）', () => {
  assert.deepStrictEqual(fmtLocalDateTime('abc'), { date: '', time: '' })
  // 斜杠日期：不在 ① 的直接拆分分支内，落入 ② 的 Date 解析（本地零点）——
  // 这是既有行为（legacy 演示数据兼容），不是纯日期快路径，此处钉死防悄悄改语义
  assert.deepStrictEqual(fmtLocalDateTime('2026/08/30'), { date: '2026-08-30', time: '00:00' })
})

test('DT-11 时区守卫：进程 TZ 必须是 Asia/Shanghai（否则 DT-08/09 结论无效）', () => {
  const offsetMinutes = -new Date('2026-07-01T00:00:00Z').getTimezoneOffset()
  assert.strictEqual(offsetMinutes, 480,
    '本测试文件要求在 TZ=Asia/Shanghai 下运行（当前 UTC 偏移 ' + offsetMinutes + ' 分钟）')
})

// ==================== 号源时间：slotDateTime（DEF-02 回归）====================
// 背景：挂号页原实现用正则截字符串，把带 Z 的 UTC Instant 当本地时间用 ——
// 同一个 2026-11-13T09:00:00Z 在挂号页显示 09:00、医生端（走 fmtLocalDateTime）显示 17:00。
// 下面三条锁死「只有一套解析口径」。

test('DT-12 号源：UTC Instant 按本地时区换算（与医生端同一口径，DEF-02）', () => {
  assert.deepStrictEqual(slotDateTime('2026-11-13T09:00:00Z'), { date: '2026-11-13', time: '17:00' })
  // 跨日：23:30Z → 上海次日 07:30
  assert.deepStrictEqual(slotDateTime('2026-11-12T23:30:00Z'), { date: '2026-11-13', time: '07:30' })
  // 显式 +08:00 偏移
  assert.deepStrictEqual(slotDateTime('2026-11-13T09:00:00+08:00'), { date: '2026-11-13', time: '09:00' })
})

test('DT-13 号源：与 fmtLocalDateTime 结果完全一致（禁止第二套解析）', () => {
  const samples = ['2026-11-13T01:00:00Z', '2026-11-13T09:00:00Z', '2026-12-31T16:30:00Z']
  samples.forEach((v) => assert.deepStrictEqual(slotDateTime(v), fmtLocalDateTime(v)))
})

test('DT-14 号源：无时区标记的演示数据按原样拆分（不被误解成 UTC）', () => {
  assert.deepStrictEqual(slotDateTime('2026-08-30 09:30:00'), { date: '2026-08-30', time: '09:30' })
  assert.deepStrictEqual(slotDateTime('2026-08-30T14:00:00'), { date: '2026-08-30', time: '14:00' })
})

test('DT-15 号源：空值/不可解析/只有日期 → null（页面丢弃该号源，不展示猜的时间）', () => {
  assert.strictEqual(slotDateTime(''), null)
  assert.strictEqual(slotDateTime(null), null)
  assert.strictEqual(slotDateTime('abc'), null)
  assert.strictEqual(slotDateTime('2026-08-30'), null)   // 有日期无时间：号源必须有时间
})
