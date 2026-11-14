/*
 * preflight.js —— 环境自检。只报告事实，不补齐、不伪造、不吞错。
 * 每项状态：OK / MISS / SKIP；缺什么、为什么跳过，都写进 detail。
 */
'use strict'
const fs = require('fs')
const net = require('net')
const { spawnSync } = require('child_process')

function tcpOpen(host, port, timeout = 800) {
  return new Promise(resolve => {
    const s = net.createConnection({ host, port })
    let done = false
    const finish = v => { if (!done) { done = true; s.destroy(); resolve(v) } }
    s.setTimeout(timeout)
    s.on('connect', () => finish(true))
    s.on('error', () => finish(false))
    s.on('timeout', () => finish(false))
  })
}

function sdkResolvable(cfg) {
  try {
    return require.resolve('miniprogram-automator', { paths: [__dirname, cfg.ROOT] })
  } catch (_) {
    return ''
  }
}

async function runPreflight(cfg) {
  const checks = []
  const add = (key, status, detail) => checks.push({ key, status, detail })

  const nodeMajor = Number(process.versions.node.split('.')[0])
  add('Node.js', nodeMajor >= 18 ? 'OK' : 'MISS', `v${process.versions.node}（automator 需要 >=18）`)

  const gw = cfg.gateway
  const gwPort = Number(gw.port || (gw.protocol === 'https:' ? 443 : 80))
  const gwOpen = await tcpOpen(gw.hostname, gwPort)
  add('网关 TCP', gwOpen ? 'OK' : 'MISS', `${gw.protocol}//${gw.hostname}:${gwPort} → ${gwOpen ? '可达' : '不可达（后端未启动？）'}`)

  // 开发者工具：CLI 可执行文件 + 服务端口在线（两件事都满足才能自动化）
  add('DevTools CLI', cfg.devtoolsCli ? 'OK' : 'MISS',
    cfg.devtoolsCli || '未找到，设置 WECHAT_DEVTOOLS_CLI 指向 cli.bat / cli')
  let serviceOpen = false
  let ideDetail = cfg.ideFiles.length ? cfg.ideFiles.join(', ') : '未发现 .ide 端口文件'
  for (const f of cfg.ideFiles) {
    const p = Number(String(fs.readFileSync(f, 'utf8')).trim())
    if (!Number.isFinite(p) || p <= 0) continue
    // 开发者工具 HTTP 服务只监听本机；复用 env.js 解析出的同机主机名，避免硬编码回环地址
    if (await tcpOpen(cfg.gateway.hostname, p)) { serviceOpen = true; ideDetail = `端口 ${p} 在线（${f}）`; break }
    ideDetail = `端口 ${p} 未监听（${f}）`
  }
  add('DevTools 服务端口', serviceOpen ? 'OK' : 'MISS', ideDetail)
  add('项目配置', fs.existsSync(require('path').join(cfg.projectPath, 'project.config.json')) ? 'OK' : 'MISS', cfg.projectPath)

  const sdk = sdkResolvable(cfg)
  add('miniprogram-automator', sdk ? 'OK' : 'MISS',
    sdk || '未安装：npm install --prefix tools/e2e-weapp miniprogram-automator')

  add('JMeter 5.4.1', cfg.jmeterBin ? 'OK' : 'MISS', cfg.jmeterBin || '未找到，设置 JMETER_HOME')
  let jmVer = '未检测'
  if (cfg.jmeterBin) {
    const r = spawnSync(cfg.jmeterBin, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true, shell: cfg.IS_WIN })
    const m = String(r.stdout || r.stderr || '').match(/[\d]+\.[\d]+\.[\d]+/)
    jmVer = m ? m[0] : `无法解析（exit=${r.status}, ${String(r.error || r.stderr || '').slice(0, 120)}）`
  }
  add('JMeter 版本', jmVer === '5.4.1' ? 'OK' : 'MISS', jmVer)

  const plugins = cfg.jmeterHome
    ? fs.readdirSync(require('path').join(cfg.jmeterHome, 'lib', 'ext')).filter(f => /plugins-manager|jpgc/i.test(f))
    : []
  add('JMeter 第三方插件', plugins.length ? 'OK' : 'SKIP',
    plugins.length ? plugins.join(', ') : 'lib/ext 无第三方插件（本套件 JMX 只用内置组件，不依赖插件）')

  const java = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  const javaLine = String(java.stderr || java.stdout || '').split(/\r?\n/)[0] || 'java 不可用'
  add('JDK', java.status === 0 ? 'OK' : 'MISS', javaLine)
  add('JMeter 运行 JDK', cfg.javaHome ? 'OK' : 'WARN',
    cfg.javaHome ? `子进程注入 ${cfg.javaHome}（规避 5.4.1 报告生成器在 JDK 17 下的缺陷）`
      : '未找到 JDK 8/11，回退系统 JDK；HTML Dashboard 可能生成失败')

  const e2eReady = checks.filter(c => ['DevTools CLI', 'DevTools 服务端口', '项目配置', 'miniprogram-automator'].includes(c.key))
    .every(c => c.status === 'OK')
  const jmeterReady = checks.filter(c => ['JMeter 5.4.1', 'JMeter 版本', 'JDK'].includes(c.key))
    .every(c => c.status === 'OK')

  return { checks, ready: { e2e: e2eReady, jmeter: jmeterReady, gateway: gwOpen } }
}

module.exports = { runPreflight, tcpOpen }

if (require.main === module) {
  const cfg = require('./config')
  runPreflight(cfg).then(r => {
    for (const c of r.checks) console.log(`${c.status.padEnd(5)} ${c.key.padEnd(24)} ${c.detail}`)
    console.log(`ready: e2e=${r.ready.e2e} jmeter=${r.ready.jmeter} gateway=${r.ready.gateway}`)
  }).catch(e => { console.error('preflight 失败：' + e.stack); process.exitCode = 1 })
}
