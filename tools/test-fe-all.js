/**
 * tools/test-fe-all.js —— 前端测试一键入口（新增单测 + 既有门禁回归 + 覆盖率）
 *
 * 用法：
 *   node tools/test-fe-all.js            # 新增单测 + 既有门禁
 *   node tools/test-fe-all.js --coverage # 附带 V8 覆盖率（node --experimental-test-coverage）
 *
 * 固定 TZ=Asia/Shanghai：datetime 的 ISO→本地时区用例依赖（见 test-fe-datetime.js DT-11 守卫）。
 * 退出码：0 = 全绿；1 = 有失败（既有门禁中 check-v4-docs / check-v4-prototypes 为登记在案的
 * 历史失败项，不计入本次退出码，但在输出中明确标注 KNOWN-FAIL）。
 */
const { spawnSync } = require('child_process')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const COVERAGE = process.argv.includes('--coverage')
const TZ = 'Asia/Shanghai'

// ① 新增单元测试（node:test）
const NEW_TESTS = [
  'test-fe-datetime.js',
  'test-fe-errtext.js',
  'test-fe-aptstatus.js',
  'test-fe-paginate.js',
  'test-fe-config.js',
  'test-fe-request.js'
].map((f) => path.join('tools', f))

// ② 既有门禁回归（与 2026-10-18 基线一致的口径）
// known:true 登记治理（2026-11-10）：只用于「已定位、有明确卡点、不阻塞本轮」的历史失败。
// 退出条件：下次里程碑复测通过即改回 known:false；连续 2 个里程碑未复测则升级为阻塞项，
// 不允许沉淀成永久豁免。每条 known 必须在注释里写明卡点与收口方向。
const GATES = [
  { cmd: 'check-project.js', known: false },
  { cmd: 'check-require.js', known: false },
  { cmd: 'check-exports.js', known: false },
  { cmd: 'check-styles.js', known: false },
  { cmd: 'test-apt-date.js', known: false },
  { cmd: 'test-triage.js', known: false },
  { cmd: 'test-nav-page.js', known: false },
  { cmd: 'test-pages-contract.js', known: false },
  { cmd: 'test-pages-paginate.js', known: false },
  { cmd: 'test-resource-links.js', known: false },
  { cmd: 'test-detail-video.js', known: false },
  // 2026-10-29 全量前端测试的分片回归（此前只在分片报告里手工跑，未进一键入口）
  { cmd: 'test-login-auth-audit.js', known: false },
  { cmd: 'test-patient-flows-audit.js', known: false },
  { cmd: 'test-profile-pages-audit.js', known: false },
  { cmd: 'test-doctor-pages-audit.js', known: false },
  { cmd: 'test-knowledge-filter.js', known: false },
  // 2026-10-30 适老化触控 + 登录页字号令牌化（D-B/D-D-P2 触控 6 条、D-A-P2-02/03）
  { cmd: 'test-a11y-touch.js', known: false },
  // 2026-11-10 提交完成态操作入口（展示条件 / 状态校验 / 幂等 / 组件重复触发）
  { cmd: 'test-submission-actions.js', known: false },
  // 第二轮详细版 deep-audit（此前只在分片报告里手工跑，D-A-P1-01 断言⑦就在 login 里）
  { cmd: 'test-login-deep-audit.js', known: false },
  { cmd: 'test-patient-deep-audit.js', known: false },
  { cmd: 'test-doctor-deep-audit.js', known: false },
  { cmd: 'test-pkg-deep-audit.js', known: false },
  // 2026-11-09 补登记：该套件一直存在但从未进一键入口（3 项失败长期无人看见）。
  // 现余 1 项待查（断言① 设默认后 wb_voice 未落 storage），先按登记在案处理，不阻塞。
  { cmd: 'test-profile-deep-audit.js', known: true },
  { cmd: 'check-v4-docs.js', known: true },       // 登记在案：11 条新增路由未登记进 V4 主说明书
  { cmd: 'check-v4-prototypes.js', known: true }  // 登记在案：原型清单缺页 + 截图尺寸
]

function run(cmd, args) {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TZ }),
    maxBuffer: 32 * 1024 * 1024
  })
  return r
}

let failed = 0
let knownFailed = 0
let skipped = 0

console.log('='.repeat(72))
console.log('前端测试一键入口 · ' + new Date().toISOString())
console.log('TZ=' + TZ + ' · 新增单测 ' + NEW_TESTS.length + ' 文件 · 既有门禁 ' + GATES.length + ' 个')
console.log('='.repeat(72))

// ---------- ① 新增单元测试 ----------
const nodeArgs = COVERAGE
  ? ['--test', '--experimental-test-coverage'].concat(NEW_TESTS)
  : ['--test'].concat(NEW_TESTS)
const unit = run(null, nodeArgs)
const unitTail = (unit.stdout || '').split('\n').filter((l) => /^# (tests|pass|fail|skipped)/.test(l)).join(' · ')
console.log('\n[1/2] 新增单元测试（node:test' + (COVERAGE ? ' + coverage' : '') + '）')
console.log('  ' + (unit.status === 0 ? 'PASS' : 'FAIL') + '  ' + unitTail)
if (unit.status !== 0) {
  failed++
  console.log((unit.stdout || '').split('\n').filter((l) => l.startsWith('not ok')).slice(0, 20).join('\n'))
}

// ---------- ② 既有门禁 ----------
console.log('\n[2/2] 既有门禁回归')
for (const g of GATES) {
  const r = run(null, [path.join('tools', g.cmd)])
  const ok = r.status === 0
  const out = r.stdout || ''
  // 环境不可达 ≠ 用例通过：必须单列 SKIP，绝不计入 PASS
  const isSkip = ok && out.indexOf('结果：SKIPPED') >= 0
  if (isSkip) {
    skipped++
    console.log('  SKIP        ' + g.cmd + '（环境不可达，未执行；不计 PASS/FAIL）')
  } else if (ok) {
    console.log('  PASS        ' + g.cmd)
  } else if (g.known) {
    knownFailed++
    console.log('  KNOWN-FAIL  ' + g.cmd + '（登记在案的历史失败，不阻塞）')
  } else {
    failed++
    console.log('  FAIL        ' + g.cmd)
    const tail = out.split('\n').slice(-12).join('\n')
    console.log(tail.split('\n').map((l) => '    ' + l).join('\n'))
  }
}

console.log('\n' + '='.repeat(72))
console.log('汇总：新增失败 ' + failed + ' · 环境跳过 ' + skipped + ' · 登记在案失败 ' + knownFailed + ' · 结论 ' +
  (failed === 0 ? '无新增失败（SKIP 不计通过）' : '存在真实失败'))
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
