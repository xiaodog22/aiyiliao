/*
 * run-all.js —— 一键编排：环境自检 → 小程序 UI E2E → JMeter 网关冒烟 → Markdown 报告
 *
 * 用法：
 *   node tools/e2e-weapp/run-all.js                 # 自动判定：后端不在线则 JMeter 走离线自检
 *   node tools/e2e-weapp/run-all.js --dry-run     # 强制离线自检（不向后端发请求）
 *   node tools/e2e-weapp/run-all.js --users=10 --loops=5   # 后端在线时放大压测
 *   node tools/e2e-weapp/run-all.js --skip-e2e / --skip-jmeter
 *
 * 任何一项未就绪都写 SKIP + 具体原因，绝不伪造通过或吞掉错误。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const cfg = require('./config')
const { runPreflight } = require('./preflight')
const { runE2E } = require('./e2e.spec')
const { runJmeter } = require('./run-jmeter')
const { runNewman } = require('./run-newman')

function parseArgs(argv) {
  const o = { dryRun: false, users: 0, loops: 0, skipE2E: false, skipJmeter: false }
  for (const a of argv) {
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--skip-e2e') o.skipE2E = true
    else if (a === '--skip-jmeter') o.skipJmeter = true
    else if (a.startsWith('--users=')) o.users = Number(a.split('=')[1])
    else if (a.startsWith('--loops=')) o.loops = Number(a.split('=')[1])
  }
  return o
}

function fmtCase(c) {
  const lines = [`- **${c.status}** ${c.name}`]
  for (const a of (c.assertions || [])) lines.push(`  - ${a}`)
  if (c.error) lines.push(`  - 错误：${c.error}`)
  if (c.screenshot) lines.push(`  - 截图：${c.screenshot}`)
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(cfg.ARTIFACTS, { recursive: true })
  const pre = await runPreflight(cfg)

  const e2e = args.skipE2E
    ? { status: 'SKIP', reason: '命令行 --skip-e2e', cases: [] }
    : await runE2E(cfg, pre)

  // 后端不在线时不制造一堆连接失败样本：改为明确标注的离线自检
  const dryRun = args.dryRun || !pre.ready.gateway
  const jm = args.skipJmeter
    ? { status: 'SKIP', reason: '命令行 --skip-jmeter' }
    : runJmeter(cfg, { dryRun, users: args.users || 1, loops: args.loops || 1 })

  // 接口回归：runner / collection 缺失时返回 SKIP，不伪造结果
  const nm = runNewman(cfg)

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const md = []
  md.push(`# 小程序联调测试报告 · ${new Date().toLocaleString('zh-CN')}`)
  md.push('')
  md.push('> 由 `tools/e2e-weapp/run-all.js` 生成。SKIP = 环境未就绪，不代表通过。')
  md.push('')
  md.push('## 1. 环境自检')
  md.push('')
  md.push('| 检查项 | 状态 | 说明 |')
  md.push('| --- | --- | --- |')
  for (const c of pre.checks) md.push(`| ${c.key} | ${c.status} | ${c.detail.replace(/\|/g, '\\|')} |`)
  md.push('')
  md.push(`就绪判定：E2E=${pre.ready.e2e} / JMeter=${pre.ready.jmeter} / 网关=${pre.ready.gateway}`)
  md.push('')
  md.push('## 2. 小程序 UI E2E（miniprogram-automator）')
  md.push('')
  md.push(`**结果：${e2e.status}**${e2e.reason ? ' — ' + e2e.reason : ''}`)
  md.push('')
  if (e2e.cases && e2e.cases.length) md.push(e2e.cases.map(fmtCase).join('\n'))
  if (e2e.outDir) md.push(`\n产物目录：\`${e2e.outDir}\``)
  md.push('')
  md.push('## 3. Postman / Newman 接口回归')
  md.push('')
  md.push(`**结果：${nm.status}**${nm.reason ? ' — ' + nm.reason : ''}`)
  if (nm.collection) {
    md.push('')
    md.push(`- runner：\`${nm.tool}\` ${nm.version || ''}`)
    md.push(`- Collection：\`${nm.collection}\``)
    md.push(`- 迭代 / 失败断言：${nm.samples} / ${nm.errors}`)
    md.push(`- 产物：\`${nm.outDir}\``)
  }
  md.push('')
  md.push('## 4. JMeter 5.4.1 网关冒烟')
  md.push('')
  md.push(`**结果：${jm.status}**${jm.reason ? ' — ' + jm.reason : ''}`)
  if (jm.target) {
    md.push('')
    md.push(`- 目标：\`${jm.target}\``)
    md.push(`- 模式：${jm.dryRun ? '离线自检（未发后端请求，样本不计入性能结论）' : '真实压测'}`)
    md.push(`- 并发/循环：${jm.users} / ${jm.loops}`)
    md.push(`- 运行 JDK：${jm.javaHome}`)
    md.push(`- 采样 / 非 2xx：${jm.summary.samples} / ${jm.summary.errors}`)
    md.push(`- 平均 / p95（ms）：${jm.summary.avg} / ${jm.summary.p95}`)
    md.push(`- JTL：\`${jm.jtl}\``)
    md.push(`- HTML 报告：${jm.html ? `\`${jm.html}\`` : '离线自检不生成（无性能样本）'}`)
    for (const w of (jm.warnings || [])) md.push(`- ⚠️ ${w}`)
    md.push(`- 进程日志：\`${path.join(jm.outDir, 'jmeter-stdout.log')}\` / \`jmeter-stderr.log\``)
    if (jm.summary.labels) md.push(`- 采样标签：${jm.summary.labels.join('、')}`)
  }
  md.push('')
  md.push('## 5. 结论与待办')
  md.push('')
  if (!pre.ready.gateway) md.push('- 网关未在线：启动 `backend/deploy/scripts/orchestrator.ps1 -Action start`，再重跑本脚本（不加 --dry-run）。')
  if (!pre.ready.e2e) md.push('- 微信开发者工具未就绪：安装/启动工具 → 设置 → 安全设置 → 开启服务端口 → 安装 `miniprogram-automator`，再重跑。')
  if (pre.ready.gateway && pre.ready.e2e) md.push('- 环境齐备；如需放大压测，用 `--users=N --loops=N` 显式指定。')
  if (jm.status.startsWith('FAIL')) md.push(`- JMeter 失败需排查：\`${jm.outDir || cfg.ARTIFACTS}\` 下的 stdout/stderr 与 JTL。`)
  md.push('- JMeter 5.4.1 使用 Log4j 2.13.3（CVE-2021-44228），仅限本机内网；生产压测建议升级 5.4.2+ / 5.6.x。')
  md.push('')
  md.push('## 6. 边界说明')
  md.push('')
  md.push('- JMeter 只测后端 HTTP 协议，不渲染 WXML、不执行小程序 JS；小程序前端体验由 E2E 用例覆盖。')
  md.push('- E2E 两条旅程只断言页面结构，不注入 mock 数据、不伪造分诊/挂号结果；数据类断言须在后端在线后补。')
  md.push('- 套件零业务代码改动，不修改 `miniprogram/` 任何页面与服务。')
  md.push('')

  const report = path.join(cfg.ARTIFACTS, `report-${stamp}.md`)
  fs.writeFileSync(report, md.join('\n'))
  fs.writeFileSync(path.join(cfg.ARTIFACTS, 'report-latest.md'), md.join('\n'))

  // 统一结果 schema：三种工具的产物各自归一化，供 CI / Agent / 看板消费
  const cases = e2e.cases || []
  const unified = {
    runId: stamp,
    generatedAt: new Date().toISOString(),
    gateway: cfg.gateway.href,
    ready: pre.ready,
    environment: pre.checks.map(c => ({ key: c.key, status: c.status, detail: c.detail })),
    stages: [
      {
        stage: 'ui', tool: 'miniprogram-automator', status: e2e.status,
        samples: cases.length, errors: cases.filter(c => c.status === 'FAIL').length,
        p95_ms: null, assertions: cases.map(c => ({ name: c.name, status: c.status, items: c.assertions || [] })),
        artifacts: e2e.outDir ? [e2e.outDir] : [], reason: e2e.reason || ''
      },
      Object.assign({ reason: '' }, nm),
      {
        stage: 'load', tool: 'jmeter-5.4.1', status: jm.status,
        samples: jm.summary ? jm.summary.samples : 0,
        errors: jm.summary ? jm.summary.errors : 0,
        p95_ms: jm.summary ? jm.summary.p95 : null,
        assertions: null,
        artifacts: [jm.jtl, jm.html].filter(Boolean),
        reason: jm.reason || '', warnings: jm.warnings || []
      }
    ]
  }
  const jsonReport = path.join(cfg.ARTIFACTS, `report-${stamp}.json`)
  fs.writeFileSync(jsonReport, JSON.stringify(unified, null, 2))
  fs.writeFileSync(path.join(cfg.ARTIFACTS, 'report-latest.json'), JSON.stringify(unified, null, 2))

  const bad = [e2e, nm, jm].filter(x => x.status.startsWith('FAIL'))
  console.log(`状态：${bad.length ? 'FAIL' : 'PASS'}｜UI ${e2e.status}｜接口 ${nm.status}｜压测 ${jm.status}`)
  console.log(`自检：E2E就绪=${pre.ready.e2e} JMeter就绪=${pre.ready.jmeter} 网关在线=${pre.ready.gateway}`)
  console.log(`报告：${report} / ${jsonReport}`)
  if (jm.html) console.log(`HTML：${path.join(jm.html, 'index.html')}`)
  const todos = [e2e.reason, nm.reason, jm.reason].filter(Boolean)
  if (todos.length) console.log(`待办：${todos.join('；')}`)
  if (bad.length) process.exitCode = 1
}

main().catch(e => { console.error('编排失败：' + e.stack); process.exitCode = 1 })
