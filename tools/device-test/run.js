'use strict'
/**
 * run.js —— 基于 adb 的真机用例执行器（连接设备 → 触发路径 → 采集证据 → 断言 → 报告）
 *
 * 与既有 tools/e2e-weapp 的分工：
 *  - e2e-weapp：微信开发者工具自动化（WXML 结构）+ JMeter 压测；
 *  - 本执行器：**真机**维度，只依赖 adb，不依赖开发者工具、不注入 JS、不改小程序代码。
 *
 * 断言分级（不伪造通过）：
 *  - 设备/环境不具备（无 adb、无设备、无 token）→ SKIP，退出码 2，不当作 PASS；
 *  - 断言不成立 → FAIL，退出码 1；
 *  - 全部 PASS/SKIP 且至少一条 PASS → 退出码 0。
 *
 * 用法：
 *   node tools/device-test/run.js --list
 *   node tools/device-test/run.js --case appointment-demo
 *   node tools/device-test/run.js --case ./cases/xxx.json --serial <serial>
 *   node tools/device-test/run.js --case appointment-demo --token <bearer>
 *   环境变量：ADB_PATH / DEVICE_TEST_SERIAL / DEVICE_TEST_TOKEN / DEVICE_TEST_OUT
 */
const fs = require('fs')
const path = require('path')

const { createAdb, AdbUnavailable } = require('./adb')

const ROOT = path.resolve(__dirname, '..', '..')
const CASES_DIR = path.join(__dirname, 'cases')
const DEFAULT_OUT = path.join(ROOT, 'artifacts', 'device-test')

function parseArgs(argv) {
  const out = { case: '', serial: '', token: '', out: '', list: false, dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') out.list = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--case') out.case = argv[++i] || ''
    else if (a === '--serial') out.serial = argv[++i] || ''
    else if (a === '--token') out.token = argv[++i] || ''
    else if (a === '--out') out.out = argv[++i] || ''
    else if (a === '-h' || a === '--help') out.help = true
  }
  out.serial = out.serial || process.env.DEVICE_TEST_SERIAL || ''
  out.token = out.token || process.env.DEVICE_TEST_TOKEN || ''
  out.out = out.out || process.env.DEVICE_TEST_OUT || DEFAULT_OUT
  return out
}

function resolveCase(nameOrPath) {
  if (!nameOrPath) return ''
  if (fs.existsSync(nameOrPath)) return path.resolve(nameOrPath)
  const p = path.join(CASES_DIR, nameOrPath.endsWith('.json') ? nameOrPath : nameOrPath + '.json')
  return fs.existsSync(p) ? p : ''
}

function listCases() {
  if (!fs.existsSync(CASES_DIR)) return []
  return fs.readdirSync(CASES_DIR).filter(f => f.endsWith('.json')).sort()
    .map(f => {
      const p = path.join(CASES_DIR, f)
      let meta = {}
      try { meta = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { meta = { name: f, description: '（JSON 解析失败）' } }
      return { file: f, name: meta.name || f, description: meta.description || '' }
    })
}

/** 网关地址只从 env.js 的 DEV_DIRECT 解析（复用 e2e-weapp 的唯一配置入口，不复制字面地址）。 */
function gatewayBase() {
  try {
    const cfg = require('../e2e-weapp/config')
    return cfg.gateway.origin
  } catch (e) {
    return ''
  }
}

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function truncate(s, n) {
  const t = String(s == null ? '' : s)
  return t.length > n ? t.slice(0, n) + `…(共 ${t.length} 字)` : t
}

async function main() {
  const args = parseArgs(process.argv)

  if (args.help) {
    console.log(`用法:
  node tools/device-test/run.js --list
  node tools/device-test/run.js --case <名称|路径> [--serial <serial>] [--token <bearer>] [--out <目录>]

环境变量: ADB_PATH / DEVICE_TEST_SERIAL / DEVICE_TEST_TOKEN / DEVICE_TEST_OUT
退出码: 0 全 PASS 或含 SKIP 且无 FAIL；1 有 FAIL；2 环境不可用（SKIP，不伪造通过）`)
    return 0
  }

  if (args.list) {
    const cases = listCases()
    if (!cases.length) {
      console.log('cases/ 下没有 .json 用例')
      return 0
    }
    for (const c of cases) console.log(`- ${c.file}\n    ${c.name}：${c.description}`)
    return 0
  }

  const casePath = resolveCase(args.case)
  if (!casePath) {
    console.error(`未找到用例: ${args.case || '(空)'}。用 --list 查看可用用例。`)
    return 2
  }

  let spec
  try {
    spec = JSON.parse(fs.readFileSync(casePath, 'utf8'))
  } catch (e) {
    console.error(`用例 JSON 解析失败: ${casePath}\n${e.message}`)
    return 2
  }

  const runId = `${(spec.name || path.basename(casePath, '.json'))}-${stamp()}`
  const outDir = path.join(args.out, runId)
  fs.mkdirSync(outDir, { recursive: true })

  const report = {
    runId,
    caseName: spec.name || path.basename(casePath, '.json'),
    description: spec.description || '',
    casePath,
    startedAt: new Date().toISOString(),
    device: null,
    environment: {},
    steps: [],
    summary: { pass: 0, fail: 0, skip: 0 }
  }

  const record = (step, status, detail) => {
    report.steps.push({ name: step.name || step.type, type: step.type, status, detail: truncate(detail, 600) })
    if (status === 'PASS') report.summary.pass++
    else if (status === 'FAIL') report.summary.fail++
    else report.summary.skip++
    const icon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP'
    console.log(`  [${icon}] ${step.name || step.type}${detail ? ' — ' + truncate(detail, 160) : ''}`)
  }

  console.log(`\n用例: ${report.caseName} (${runId})`)
  console.log(`证据目录: ${outDir}\n`)

  // ---------- 连接设备 ----------
  let adb
  let serial
  try {
    adb = createAdb()
    report.environment.adb = adb.bin
    report.environment.adbVersion = adb.version().split(/\r?\n/)[0]
    serial = adb.pickDevice(args.serial)
    const size = adb.wmSize(serial)
    report.device = {
      serial,
      wmSize: size,
      screenState: adb.screenState(serial),
      currentFocus: adb.currentFocus(serial)
    }
    console.log(`设备: ${serial} ${size ? size.width + 'x' + size.height : '(尺寸未知)'}\n`)
  } catch (e) {
    const reason = e instanceof AdbUnavailable ? e.message : `连接设备失败: ${e.message}`
    record({ type: 'device', name: '连接设备' }, 'SKIP', reason)
    finish(report, outDir, 2)
    return 2
  }

  const size = report.device.wmSize
  const W = size ? size.width : 0
  const H = size ? size.height : 0
  const base = gatewayBase()
  report.environment.gateway = base
  report.environment.node = process.version
  report.environment.tokenPresent = Boolean(args.token)

  // ---------- 执行步骤 ----------
  for (const step of (spec.steps || [])) {
    try {
      switch (step.type) {
        case 'wait': {
          await sleep(step.ms || 1000)
          record(step, 'PASS', `等待 ${step.ms || 1000}ms`)
          break
        }

        case 'wake': {
          adb.wake(serial)
          await sleep(step.waitMs || 500)
          record(step, 'PASS', '已发送唤醒键')
          break
        }

        case 'tap': {
          adb.tap(serial, step.x, step.y)
          await sleep(step.waitMs || 1200)
          record(step, 'PASS', `tap(${step.x},${step.y})`)
          break
        }

        case 'tapRatio': {
          if (!W || !H) {
            record(step, 'SKIP', '设备分辨率未知，无法换算相对坐标')
            break
          }
          const x = step.x * W
          const y = step.y * H
          adb.tap(serial, x, y)
          await sleep(step.waitMs || 1200)
          record(step, 'PASS', `tapRatio(${step.x},${step.y}) → 设备(${Math.round(x)},${Math.round(y)})`)
          break
        }

        case 'swipe': {
          adb.swipe(serial, step.x1 * (step.ratio ? W : 1), step.y1 * (step.ratio ? H : 1),
            step.x2 * (step.ratio ? W : 1), step.y2 * (step.ratio ? H : 1), step.durationMs || 300)
          await sleep(step.waitMs || 800)
          record(step, 'PASS', 'swipe 完成')
          break
        }

        case 'input': {
          adb.inputText(serial, step.text || '')
          await sleep(step.waitMs || 500)
          record(step, 'PASS', `input "${step.text}"`)
          break
        }

        case 'keyevent': {
          adb.keyevent(serial, step.code)
          await sleep(step.waitMs || 800)
          record(step, 'PASS', `keyevent ${step.code}`)
          break
        }

        case 'shot': {
          const name = step.name || `shot-${report.steps.length + 1}`
          const r = adb.screencap(serial, path.join(outDir, `${name}.png`))
          record(step, 'PASS', `${name}.png (${r.bytes} bytes)`)
          break
        }

        case 'assertLogcat': {
          const log = adb.logcatDump(serial)
          fs.writeFileSync(path.join(outDir, `${step.name || 'logcat'}.log`), log || '(empty)')
          if (!log) {
            record(step, 'SKIP', 'logcat 为空（缓冲区被清或设备不允许读取）')
            break
          }
          const re = new RegExp(step.pattern, step.flags || 'i')
          const hit = re.test(log)
          const ok = step.absent ? !hit : hit
          record(step, ok ? 'PASS' : 'FAIL',
            (step.absent ? '不应匹配 ' : '应匹配 ') + `/${step.pattern}/ → ${hit ? '命中' : '未命中'}`)
          break
        }

        case 'assertScreenshot': {
          const name = step.name || `assert-${report.steps.length + 1}`
          const r = adb.screencap(serial, path.join(outDir, `${name}.png`))
          const min = step.minBytes || 20000
          const ok = r.bytes >= min
          record(step, ok ? 'PASS' : 'FAIL', `${name}.png ${r.bytes} bytes（阈值 ${min}）`)
          break
        }

        case 'assertHttp': {
          if (!base) {
            record(step, 'SKIP', '未能从 miniprogram/config/env.js 解析网关地址')
            break
          }
          if (!args.token && step.skipIfNoToken !== false) {
            record(step, 'SKIP', '未提供 DEVICE_TEST_TOKEN（不伪造接口断言）')
            break
          }
          const url = base + step.path
          const headers = Object.assign({ Accept: 'application/json' }, step.headers || {})
          if (args.token) headers.Authorization = `Bearer ${args.token}`
          let res
          try {
            res = await fetch(url, { method: step.method || 'GET', headers, body: step.body ? JSON.stringify(step.body) : undefined })
          } catch (e) {
            record(step, 'FAIL', `请求失败 ${url}: ${e.message}`)
            break
          }
          const text = await res.text()
          fs.writeFileSync(path.join(outDir, `${step.name || 'http'}.json`), text || '(empty)')
          // 数据前置条件不满足时明确 SKIP（例如账号还没有预约，就不该把「字段缺失」判成 FAIL）
          if (step.skipIfBodyMatches && new RegExp(step.skipIfBodyMatches).test(text)) {
            record(step, 'SKIP', `响应匹配跳过条件 /${step.skipIfBodyMatches}/`)
            break
          }
          const problems = []
          if (step.expectStatus && res.status !== step.expectStatus) {
            problems.push(`状态码 ${res.status} != ${step.expectStatus}`)
          }
          for (const needle of (step.expectBodyContains || [])) {
            if (!text.includes(needle)) problems.push(`响应缺少 "${needle}"`)
          }
          for (const needle of (step.expectBodyAbsent || [])) {
            if (text.includes(needle)) problems.push(`响应不应包含 "${needle}"`)
          }
          record(step, problems.length ? 'FAIL' : 'PASS',
            problems.length ? problems.join('；') : `${step.method || 'GET'} ${step.path} → ${res.status}`)
          break
        }

        default:
          record(step, 'SKIP', `未知步骤类型: ${step.type}`)
      }
    } catch (e) {
      record(step, 'FAIL', e.message)
    }
  }

  const code = report.summary.fail > 0 ? 1 : (report.summary.pass > 0 ? 0 : 2)
  finish(report, outDir, code)
  return code
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function finish(report, outDir, code) {
  report.finishedAt = new Date().toISOString()
  report.exitCode = code
  report.conclusion = code === 0
    ? (report.summary.skip > 0 ? 'PASS（含 SKIP，SKIP 项未验证）' : 'PASS')
    : code === 1 ? 'FAIL' : 'SKIP（环境不满足，未验证）'

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))

  const lines = [
    `# 真机用例报告 · ${report.caseName}`,
    '',
    `- runId：${report.runId}`,
    `- 结论：**${report.conclusion}**（PASS ${report.summary.pass} / FAIL ${report.summary.fail} / SKIP ${report.summary.skip}）`,
    `- 设备：${report.device ? `${report.device.serial} ${report.device.wmSize ? report.device.wmSize.width + 'x' + report.device.wmSize.height : ''}` : '未连接'}`,
    `- adb：${report.environment.adb || '未探测到'}`,
    `- 网关：${report.environment.gateway || '未解析'}`,
    `- token：${report.environment.tokenPresent ? '已提供' : '未提供（接口断言按 SKIP 处理）'}`,
    '',
    '| 步骤 | 类型 | 结果 | 说明 |',
    '|---|---|---|---|'
  ]
  for (const s of report.steps) {
    lines.push(`| ${s.name} | ${s.type} | ${s.status} | ${String(s.detail || '').replace(/\|/g, '\\|')} |`)
  }
  lines.push('', report.casePath ? `用例文件：\`${report.casePath}\`` : '')
  fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'))

  console.log(`\n结论: ${report.conclusion}`)
  console.log(`报告: ${path.join(outDir, 'report.md')}`)
}

main().then(code => {
  process.exitCode = code
}).catch(e => {
  console.error(`执行器异常: ${e && e.stack ? e.stack : e}`)
  process.exitCode = 2
})
