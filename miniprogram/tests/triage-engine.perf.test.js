const test = require('node:test')
const assert = require('node:assert')
const engine = require('../utils/triage-engine.js')

/**
 * triage-engine 性能烟测（2026-11-15）：
 * 只防「优化被回退成 O(n²)」这类明显退化，不做精度断言；阈值取宽松的 3s。
 */
test('analyze 连续 1000 次不超过 3000ms', () => {
  const samples = [
    '胃疼反酸一周了，饭后加重',
    '咳嗽有痰三天，晚上明显',
    '胸闷心慌，爬楼气短',
    '腰疼膝盖疼，阴雨天加重',
    '头晕恶心，血压偏高'
  ]
  const t0 = Date.now()
  for (let i = 0; i < 1000; i += 1) {
    engine.analyze(samples[i % samples.length] + '，第' + i + '次描述')
  }
  const cost = Date.now() - t0
  assert.ok(cost < 3000, `analyze 1000 次耗时 ${cost}ms，超过 3000ms 基线`)
})
