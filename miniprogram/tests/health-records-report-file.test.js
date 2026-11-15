const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const mock = require(path.join(__dirname, '..', 'utils', 'mock-data.js'))

/**
 * 健康档案报告文件回归（2026-11-15）：
 * 1) 每条档案记录（就诊记录 / 检验检查报告）都必须带且仅带一个报告文件，
 *    否则「查看报告」会退化成「该记录暂无报告文件」；
 * 2) 报告文件必须有 resourceKey（后端资源库可下发）与 sha256 内容摘要，
 *    同一记录内摘要不得重复 —— 报告文件的唯一性由摘要保证。
 */
const records = []
  ;(mock.HEALTH_RECORDS.visits || []).forEach((v) => records.push({
    title: (v.dept || '') + (v.doctor ? ' · ' + v.doctor : ''),
    attachments: v.attachments || []
  }))
  ;(mock.HEALTH_RECORDS.reports || []).forEach((r) => records.push({
    title: r.name || '',
    attachments: r.attachments || []
  }))

test('健康档案每条记录都有且仅有一个报告文件', () => {
  assert.ok(records.length > 0, '演示档案不应为空')
  records.forEach((r) => {
    assert.strictEqual(r.attachments.length, 1, `${r.title} 应有且仅有一个报告文件`)
  })
})

test('报告文件带 resourceKey 与 sha256，且同记录内摘要不重复', () => {
  records.forEach((r) => {
    const hashes = r.attachments.map((a) => String(a.sha256 || ''))
    hashes.forEach((h) => {
      assert.match(h, /^[0-9a-f]{64}$/, `${r.title} 的报告文件缺少 64 位 sha256`)
    })
    assert.strictEqual(new Set(hashes).size, hashes.length, `${r.title} 存在重复报告文件`)
    r.attachments.forEach((a) => {
      assert.match(String(a.resourceKey || ''), /^health\./, `${r.title} 的报告文件未登记 resourceKey`)
      assert.ok(a.fileName, `${r.title} 的报告文件缺少文件名`)
      assert.ok(Number(a.size) > 0, `${r.title} 的报告文件缺少大小`)
    })
  })
})

/**
 * 真实后端档案（u-dev-user-1）没有任何 health_record_attachments，
 * 报告内容在 health_report_details（GET /api/v1/reports/{recordId}）。
 * 「查看报告」必须在该情形下打开结构化报告单，而不是弹「暂无报告文件」。
 */
test('无附件文件时查看报告走结构化报告单', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'pages', 'profile', 'health-records', 'health-records.js'), 'utf8')
  assert.ok(src.includes('_openStructuredReport'), '缺少结构化报告单入口')
  assert.ok(src.includes('/pages/profile/report-detail/report-detail?recordId='),
    '未跳转到 V27 报告详情页')
  assert.ok(src.includes("rawCategory === 'EXAM'"), '未按检查检验类别判定可查看报告')
})
