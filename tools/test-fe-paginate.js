/**
 * tools/test-fe-paginate.js —— utils/paginate.js 单元测试（前端测试文档 TC-FE-PG-*）
 *
 * 覆盖：首页切片、触底翻页、hasMore 边界、页码钳制、非数组入参、
 *       回归 2026-09-16 线上事故（paginate 被当函数调用 / all 不回传）。
 *
 * 运行：node tools/test-fe-paginate.js
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')

const { PAGE_SIZE, paginate } = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'paginate.js'))

const range = (n) => Array.from({ length: n }, (_, i) => i + 1)

test('PG-01 核心：PAGE_SIZE 为 20 且模块导出为对象（防回归"paginate is not a function"）', () => {
  assert.strictEqual(PAGE_SIZE, 20)
  assert.strictEqual(typeof paginate, 'function')
})

test('PG-02 核心：首页只切 PAGE_SIZE 条，all/total 回传全量', () => {
  const p = paginate(range(45), 1)
  assert.strictEqual(p.displayed.length, 20)
  assert.strictEqual(p.all.length, 45) // all 必须回传（页面 setData 依赖）
  assert.strictEqual(p.total, 45)
  assert.strictEqual(p.page, 1)
  assert.strictEqual(p.hasMore, true)
  assert.deepStrictEqual(p.displayed, range(20))
})

test('PG-03 核心：触底翻页逐页累加', () => {
  const p2 = paginate(range(45), 2)
  assert.strictEqual(p2.displayed.length, 40)
  assert.strictEqual(p2.hasMore, true)
  const p3 = paginate(range(45), 3)
  assert.strictEqual(p3.displayed.length, 45)
  assert.strictEqual(p3.hasMore, false) // 恰好等于总量时无更多
})

test('PG-04 边界：hasMore 临界值（20 条恰好一页 / 21 条溢出）', () => {
  assert.strictEqual(paginate(range(20), 1).hasMore, false)
  assert.strictEqual(paginate(range(21), 1).hasMore, true)
  assert.strictEqual(paginate(range(21), 1).displayed.length, 20)
  assert.strictEqual(paginate([], 1).hasMore, false)
  assert.strictEqual(paginate([], 1).total, 0)
})

test('PG-05 边界：页码非法值钳制到 ≥1（0 / 负数 / 小数）', () => {
  assert.strictEqual(paginate(range(45), 0).page, 1)
  assert.strictEqual(paginate(range(45), -5).page, 1)
  assert.strictEqual(paginate(range(45), 2.7).page, 2) // |0 截断
  assert.strictEqual(paginate(range(45), null).page, 1)
  assert.strictEqual(paginate(range(45), undefined).page, 1)
})

test('PG-06 边界：自定义每页条数', () => {
  const p = paginate(range(25), 1, 10)
  assert.strictEqual(p.displayed.length, 10)
  assert.strictEqual(p.hasMore, true)
  assert.strictEqual(paginate(range(25), 3, 10).hasMore, false)
})

test('PG-07 异常：非数组入参不抛异常，按空集合处理', () => {
  for (const bad of [null, undefined, 'x', 42, {}, true]) {
    const p = paginate(bad, 1)
    assert.deepStrictEqual(p.displayed, [])
    assert.strictEqual(p.total, 0)
    assert.strictEqual(p.hasMore, false)
    assert.deepStrictEqual(p.all, [])
  }
})

test('PG-08 边界：页码超过总页数 → 返回全量、hasMore=false', () => {
  const p = paginate(range(45), 99)
  assert.strictEqual(p.displayed.length, 45)
  assert.strictEqual(p.hasMore, false)
})
