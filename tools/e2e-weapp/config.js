/*
 * config.js —— 小程序 E2E + JMeter 联调套件的唯一配置入口
 *
 * ⚠️ 本套件不硬编码任何 host / port：网关地址只从 miniprogram/config/env.js 的
 *    DEV_DIRECT 行解析（全仓唯一放行点），或由 E2E_GATEWAY_URL 显式覆盖。
 *    所有外部路径均可用环境变量覆盖，便于 CI 与本机切换。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..', '..')
const MP_ROOT = path.join(ROOT, 'miniprogram')
const ARTIFACTS = path.join(ROOT, 'artifacts', 'e2e-weapp')
const HOME = os.homedir()
const IS_WIN = process.platform === 'win32'

// 网关地址：环境变量优先，否则读 env.js 的 DEV_DIRECT（不复制字面地址到本文件）
function parseGateway() {
  if (process.env.E2E_GATEWAY_URL) return new URL(process.env.E2E_GATEWAY_URL)
  const src = fs.readFileSync(path.join(MP_ROOT, 'config', 'env.js'), 'utf8')
  const line = src.split(/\r?\n/).find(l => /DEV_DIRECT\s*=/.test(l))
  const m = line && line.match(/https?:\/\/[^\s'"`]+/)
  if (!m) throw new Error('无法从 miniprogram/config/env.js 解析 DEV_DIRECT 网关地址')
  return new URL(m[0])
}

function findDevtoolsCli() {
  const candidates = [
    process.env.WECHAT_DEVTOOLS_CLI,
    'D:/OpenWeChar/微信web开发者工具/cli.bat', // 2026-11-14 本机实证安装路径（非默认位置）
    'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
    'C:/Program Files/Tencent/微信web开发者工具/cli.bat',
    path.join(HOME, 'AppData/Local/微信开发者工具/cli.bat'),
    '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    path.join(HOME, 'Library/Application Support/微信开发者工具/cli')
  ].filter(Boolean)
  return candidates.find(p => fs.existsSync(p)) || ''
}

// 开发者工具 HTTP 服务端口记录在用户目录的 .ide 文件里（官方 HTTP V2 约定）
function findIdeFiles() {
  const roots = IS_WIN
    ? [path.join(HOME, 'AppData/Local/微信开发者工具/User Data')]
    : [path.join(HOME, 'Library/Application Support/微信开发者工具')]
  const out = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const dir of fs.readdirSync(root)) {
      const p = path.join(root, dir, 'Default', '.ide')
      if (fs.existsSync(p)) out.push(p)
    }
  }
  return out
}

function findJmeterHome() {
  const candidates = [
    process.env.JMETER_HOME,
    'D:/apache-jmeter-5.4.1',
    'C:/apache-jmeter-5.4.1',
    '/opt/apache-jmeter-5.4.1',
    '/usr/local/apache-jmeter-5.4.1'
  ].filter(Boolean)
  return candidates.find(p => fs.existsSync(path.join(p, 'bin', IS_WIN ? 'jmeter.bat' : 'jmeter'))) || ''
}

// JMeter 5.4.1 的 HTML 报告生成器在 JDK 17 下会抛
// "Begin size 0 is not equal to fixed size 5"；优先选本机 JDK 8/11，不改系统 JAVA_HOME，
// 只在启动 JMeter 子进程时通过 env 注入。E2E_JAVA_HOME 可显式覆盖。
function findJavaHomeForJmeter() {
  if (process.env.E2E_JAVA_HOME) return process.env.E2E_JAVA_HOME
  const candidates = [
    'C:/Program Files/Java/jdk1.8.0_261',
    'C:/Program Files/Java/jdk-11',
    'C:/Program Files/Java/jdk-14.0.1',
    'D:/java/jdk-8u441-windows-i586'
  ]
  return candidates.find(p => fs.existsSync(path.join(p, 'bin', IS_WIN ? 'java.exe' : 'java'))) || ''
}

const jmeterHome = findJmeterHome()

module.exports = {
  ROOT,
  MP_ROOT,
  ARTIFACTS,
  IS_WIN,
  projectPath: process.env.WECHAT_PROJECT_PATH || MP_ROOT,
  devtoolsCli: findDevtoolsCli(),
  ideFiles: findIdeFiles(),
  autoPort: Number(process.env.WECHAT_AUTO_PORT || 9420),
  jmeterHome,
  javaHome: findJavaHomeForJmeter(),
  jmeterBin: jmeterHome ? path.join(jmeterHome, 'bin', IS_WIN ? 'jmeter.bat' : 'jmeter') : '',
  jmx: path.join(__dirname, 'jmeter', 'gateway-smoke.jmx'),
  gateway: parseGateway()
}
