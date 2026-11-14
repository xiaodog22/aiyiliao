/*
 * run-jmeter.js —— 驱动本机 Apache JMeter 5.4.1 执行 gateway-smoke.jmx
 *
 * 地址/端口从 config.js（env.js 的 DEV_DIRECT）解析后以 -J 属性注入；
 * 健康接口路径从 miniprogram/config/api.js 的 GW_HEALTH 解析，避免重复维护路径表。
 * 不吞错：JMeter 退出码、JTL 空文件、非 2xx 采样都会如实反映到结果与日志。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function readHealthPath(cfg) {
  const src = fs.readFileSync(path.join(cfg.MP_ROOT, 'config', 'api.js'), 'utf8')
  const m = src.match(/const\s+GW_HEALTH\s*=\s*\{[^}]*path:\s*'([^']+)'/)
  if (!m) throw new Error('无法从 config/api.js 解析 GW_HEALTH 路径')
  return m[1]
}

// JTL 是带引号的 CSV：responseMessage 可能含逗号，必须按 RFC4180 解析，否则列会整体错位
function csvLine(line) {
  const out = []
  let cur = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++ } else quoted = !quoted
    } else if (ch === ',' && !quoted) { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

function parseJtl(file) {
  if (!fs.existsSync(file)) return { samples: 0, errors: 0, avg: 0, p95: 0, note: 'JTL 文件不存在' }
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return { samples: 0, errors: 0, avg: 0, p95: 0, note: 'JTL 无采样记录' }
  const cols = csvLine(lines[0])
  const idx = n => cols.indexOf(n)
  const iElapsed = idx('elapsed'), iCode = idx('responseCode'), iSuccess = idx('success'), iLabel = idx('label')
  const elapsed = [], labels = new Set()
  let errors = 0
  for (const line of lines.slice(1)) {
    const f = csvLine(line)
    const code = String(iCode >= 0 ? f[iCode] : '').trim()
    const ok = String(iSuccess >= 0 ? f[iSuccess] : 'true').trim() === 'true'
    if (!ok || !/^2\d\d$/.test(code)) errors++
    if (iElapsed >= 0) { const n = Number(f[iElapsed]); if (Number.isFinite(n)) elapsed.push(n) }
    if (iLabel >= 0) labels.add(f[iLabel])
  }
  elapsed.sort((a, b) => a - b)
  const p95 = elapsed.length ? elapsed[Math.min(elapsed.length - 1, Math.ceil(elapsed.length * 0.95) - 1)] : 0
  return {
    samples: lines.length - 1,
    errors,
    avg: elapsed.length ? Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length) : 0,
    p95,
    labels: [...labels],
    note: ''
  }
}


function runJmeter(cfg, opts = {}) {
  if (!cfg.jmeterBin) return { status: 'SKIP', reason: 'JMeter 未安装（设置 JMETER_HOME）', summary: null }

  const dryRun = !!opts.dryRun
  const gw = cfg.gateway
  const scheme = gw.protocol.replace(':', '')
  const port = Number(gw.port || (scheme === 'https' ? 443 : 80))
  const users = Number(opts.users || process.env.E2E_USERS || 1)
  const loops = Number(opts.loops || process.env.E2E_LOOPS || 1)
  const healthPath = opts.path || readHealthPath(cfg)
  const outDir = path.join(cfg.ARTIFACTS, 'jmeter-' + Date.now())
  fs.mkdirSync(outDir, { recursive: true })
  const jtl = path.join(outDir, 'results.jtl')
  const html = path.join(outDir, 'html')

  // dry-run 只验证 JMX 可加载 + JTL 链路，不请求 HTML Dashboard（无性能样本，生成报告无意义）
  const reportArgs = dryRun ? [] : ['-e', '-o', html]
  const args = [
    '-n', '-t', cfg.jmx, '-l', jtl, ...reportArgs,
    '-Jgw.host=' + gw.hostname,
    '-Jgw.port=' + port,
    '-Jgw.scheme=' + scheme,
    '-Jgw.path=' + healthPath,
    '-Jgw.users=' + users,
    '-Jgw.loops=' + loops,
    '-Jgw.dryrun=' + (dryRun ? '1' : '0'),
    '-Jjmeter.save.saveservice.output_format=csv'
  ]
  fs.writeFileSync(path.join(outDir, 'command.txt'), [cfg.jmeterBin, ...args].join(' ') + '\n')

  // Windows 下 .bat 必须经 cmd.exe 解释；shell:true 由 Node 处理引号（与 preflight 的 --version 同一路径，已实测）
  // 子进程单独注入 JDK 8/11，不动系统 JAVA_HOME（5.4.1 报告生成器在 JDK 17 下有已知缺陷）
  const childEnv = Object.assign({}, process.env)
  if (cfg.javaHome) {
    childEnv.JAVA_HOME = cfg.javaHome
    childEnv.PATH = path.join(cfg.javaHome, 'bin') + path.delimiter + (process.env.PATH || '')
  }
  const r = spawnSync(cfg.jmeterBin, args,
    { encoding: 'utf8', timeout: 300000, windowsHide: true, shell: cfg.IS_WIN, env: childEnv })
  fs.writeFileSync(path.join(outDir, 'jmeter-stdout.log'), String(r.stdout || ''))
  fs.writeFileSync(path.join(outDir, 'jmeter-stderr.log'), String(r.stderr || ''))

  const summary = parseJtl(jtl)
  const reason = []
  if (r.error) reason.push('进程启动失败：' + r.error.message)
  if (r.status !== 0) reason.push('JMeter exit=' + r.status)
  if (summary.samples === 0) reason.push('JTL 无采样：' + summary.note)
  if (summary.errors > 0) reason.push(`非 2xx / 失败采样 ${summary.errors}/${summary.samples}`)

  const warnings = []
  if (!dryRun && !fs.existsSync(path.join(html, 'index.html'))) {
    const stderr = String(r.stderr || '')
    warnings.push(/Begin size 0 is not equal to fixed size/.test(stderr)
      ? 'HTML Dashboard 未生成：JMeter 5.4.1 报告生成器与当前 JDK 不兼容（用 E2E_JAVA_HOME 指向 JDK 8/11），JTL 数据完整'
      : 'HTML Dashboard 未生成，详见 jmeter-stderr.log；JTL 数据完整')
  }

  return {
    status: reason.length ? 'FAIL' : (dryRun ? 'PASS (SELF-CHECK)' : 'PASS'),
    reason: reason.join('；'),
    warnings,
    javaHome: cfg.javaHome || '(系统 JAVA_HOME)',
    dryRun,
    users,
    loops,
    target: `${scheme}://${gw.hostname}:${port}${healthPath}`,
    command: [cfg.jmeterBin, ...args].join(' '),
    outDir,
    jtl,
    html: dryRun ? '' : html,
    summary
  }
}

module.exports = { runJmeter, parseJtl, readHealthPath }

if (require.main === module) {
  const cfg = require('./config')
  const argv = process.argv.slice(2)
  const num = prefix => {
    const a = argv.find(x => x.startsWith(prefix + '='))
    const n = a ? Number(a.slice(prefix.length + 1)) : NaN
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const r = runJmeter(cfg, {
    dryRun: argv.includes('--dry-run'),
    users: num('--users'),
    loops: num('--loops')
  })
  console.log(JSON.stringify(r, null, 2))
  if (r.status.startsWith('FAIL')) process.exitCode = 1
}
