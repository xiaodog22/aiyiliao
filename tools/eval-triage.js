/**
 * eval-triage.js —— 导诊效果评测（golden set，2026-11-17）
 *
 * 为什么要有它：
 *   现有 `test-triage.js` 证明的是"规则没写坏"（322 项确定性断言），
 *   但回答不了"分得准不准"。本脚本用一份**按临床常识标注**的评测集跑真实引擎，
 *   输出科室 Top-1 / Top-3、分科室命中率、红旗召回率、兜底率——
 *   换症状词、换融合策略、换模型后都能回归同一把尺子。
 *
 * 指标优先级（医疗场景）：
 *   ① 红旗召回率 = 100% 是**硬门禁**（漏一个急症比答错十个科室严重）；
 *   ② 兜底用例必须落 `noConclusion`（不能把"说不清"包装成确定科室）；
 *   ③ 科室 Top-1 先出基线（默认门槛 85%，低于即红，避免"越改越差"）。
 *
 * 用法：
 *   node tools/eval-triage.js                     # 默认门槛
 *   node tools/eval-triage.js --min-dept=0.8      # 临时放宽（只用于看基线）
 *   node tools/eval-triage.js --verbose           # 打印全部失配明细
 * 退出码：0 达标 / 1 未达标
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const E = require(path.join(ROOT, 'miniprogram', 'utils', 'triage-engine.js'))
const DATA = path.join(__dirname, 'data', 'triage-golden.json')

const argv = process.argv.slice(2)
const verbose = argv.indexOf('--verbose') >= 0
const minDeptArg = argv.find((x) => x.indexOf('--min-dept=') === 0)
const MIN_DEPT = minDeptArg ? Number(minDeptArg.split('=')[1]) : 0.85

function pct(n, d) { return d ? (n / d * 100).toFixed(1) + '%' : '—' }

function main() {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf-8'))
  const deptCases = data.deptCases || []
  const redCases = data.redFlagCases || []
  const fbCases = data.fallbackCases || []

  console.log('TRIAGE_EVAL ' + data.version + ' | 科室 ' + deptCases.length +
    ' | 红旗 ' + redCases.length + ' | 兜底 ' + fbCases.length)

  // ---------- ① 科室 Top-1 / Top-3 ----------
  let top1 = 0
  let top3 = 0
  let emergencyInDept = 0
  const perDept = {}
  const misses = []

  deptCases.forEach((c) => {
    const r = E.analyze(c.text)
    const got = (r.primary && r.primary.dept) || ''
    const alt = (r.alternates || []).map((x) => x.dept)
    const isTop1 = got === c.dept
    const isTop3 = isTop1 || alt.indexOf(c.dept) >= 0
    if (isTop1) top1++
    if (isTop3) top3++
    if (r.emergency) emergencyInDept++
    const s = perDept[c.dept] || (perDept[c.dept] = { n: 0, hit: 0 })
    s.n++
    if (isTop1) s.hit++
    if (!isTop1) {
      misses.push({ id: c.id, text: c.text, expect: c.dept, got: got, alt: alt.join('/'), emergency: r.emergency })
    }
  })

  console.log('\n— 科室推荐 —')
  console.log('Top-1 ' + top1 + '/' + deptCases.length + '（' + pct(top1, deptCases.length) + '）· ' +
    'Top-3 ' + top3 + '/' + deptCases.length + '（' + pct(top3, deptCases.length) + '）')
  if (emergencyInDept) {
    console.log('⚠ 普通科室用例被升级为急诊 ' + emergencyInDept + ' 条（需逐条确认是否误报）')
  }
  Object.keys(perDept).sort().forEach((d) => {
    const s = perDept[d]
    console.log('  ' + d.padEnd(6, ' ') + s.hit + '/' + s.n + '  ' + pct(s.hit, s.n))
  })

  // ---------- ② 红旗召回（硬门禁）----------
  let redHit = 0
  const redMiss = []
  redCases.forEach((c) => {
    const r = E.analyze(c.text)
    const ids = (r.redFlags || []).map((f) => f.id)
    const hit = r.level === 'emergency' && ids.indexOf(c.redFlag) >= 0
    if (hit) redHit++
    else redMiss.push({ id: c.id, text: c.text, expect: c.redFlag, level: r.level, got: ids.join(',') || '(none)' })
  })
  console.log('\n— 红旗召回（必须 100%）—')
  console.log('召回 ' + redHit + '/' + redCases.length + '（' + pct(redHit, redCases.length) + '）')

  // ---------- ③ 兜底不是结论 ----------
  let fbHit = 0
  const fbMiss = []
  fbCases.forEach((c) => {
    const r = E.analyze(c.text)
    const hit = r.noConclusion === true
    if (hit) fbHit++
    else fbMiss.push({ id: c.id, text: c.text, dept: (r.primary && r.primary.dept) || '', score: r.primary && r.primary.score })
  })
  console.log('\n— 兜底用例（必须 noConclusion）—')
  console.log('正确 ' + fbHit + '/' + fbCases.length + '（' + pct(fbHit, fbCases.length) + '）')

  // ---------- 明细 ----------
  if (verbose || misses.length || redMiss.length || fbMiss.length) {
    console.log('\n— 失配明细 —')
    misses.forEach((m) => {
      console.log('  ✗ 科室 ' + m.id + ' 「' + m.text + '」 期望=' + m.expect + ' 实际=' + m.got +
        (m.alt ? ' 备选=' + m.alt : '') + (m.emergency ? ' [被判急诊]' : ''))
    })
    redMiss.forEach((m) => {
      console.log('  ✗ 红旗 ' + m.id + ' 「' + m.text + '」 期望=' + m.expect + ' level=' + m.level + ' 命中=' + m.got)
    })
    fbMiss.forEach((m) => {
      console.log('  ✗ 兜底 ' + m.id + ' 「' + m.text + '」 落科室=' + m.dept + ' score=' + m.score)
    })
  }

  // ---------- 判定 ----------
  const deptRate = deptCases.length ? top1 / deptCases.length : 1
  const fail = []
  if (redHit !== redCases.length) fail.push('红旗召回 ' + redHit + '/' + redCases.length + ' < 100%')
  if (fbHit !== fbCases.length) fail.push('兜底用例 ' + fbHit + '/' + fbCases.length + ' < 100%')
  if (deptRate < MIN_DEPT) fail.push('科室 Top-1 ' + pct(top1, deptCases.length) + ' < 门槛 ' + pct(MIN_DEPT, 1))

  if (fail.length) {
    console.log('\nTRIAGE_EVAL_FAIL ' + fail.join('；'))
    process.exit(1)
  }
  console.log('\nTRIAGE_EVAL_OK（红旗 100%、兜底 100%、科室 Top-1 ' + pct(top1, deptCases.length) +
    ' ≥ ' + pct(MIN_DEPT, 1) + '）')
}

main()
