/*
 * official-cli-e2e.js —— 官方 wechatide CLI 回归入口（模拟器）
 *
 * 为什么单独一个脚本：官方 wechatide-skill 的 automator 走 IDE 内置 CLI，
 * 与 tools/e2e-weapp/e2e.spec.js 的 miniprogram-automator 是两条独立链路。
 * 本脚本只做「可复跑的模拟器 UI 回归」，不改动原有 e2e.spec.js。
 *
 * 前置（缺一即 SKIP，不伪造 PASS）：
 *   1. 微信开发者工具 >= 2.02.2607152（Electron 版，含 wechatide.cmd）
 *   2. IDE 已登录且已授权 clientName=WorkBuddy
 *   3. 项目窗口已打开（open_project_window）
 *
 * 用法：
 *   node tools/e2e-weapp/official-cli-e2e.js
 *   WECHATIDE_CLI="D:/微信web开发者工具/wechatide.cmd" node tools/e2e-weapp/official-cli-e2e.js
 *
 * 产物：artifacts/e2e-weapp/official-cli-<时间戳>/report.json + 截图
 */
'use strict'
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..', '..')
const PROJECT = path.join(ROOT, 'miniprogram')
const ARTIFACTS = path.join(ROOT, 'artifacts', 'e2e-weapp')
const CLIENT = process.env.WECHATIDE_CLIENT || 'WorkBuddy'

function findCli () {
  const candidates = [
    process.env.WECHATIDE_CLI,
    'D:/微信web开发者工具/wechatide.cmd',
    'D:/OpenWeChar/微信web开发者工具/wechatide.cmd',
    'C:/Program Files (x86)/Tencent/微信web开发者工具/wechatide.cmd',
    'C:/Program Files/Tencent/微信web开发者工具/wechatide.cmd'
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) || ''
}

/** 从混杂日志里截取第一个完整 JSON 对象（按括号深度，忽略字符串内的括号） */
function extractJson (text) {
  const start = text.indexOf('{')
  if (start < 0) throw new Error('无 JSON 输出：' + text.slice(0, 300))
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') {
      inStr = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
  }
  throw new Error('JSON 不完整：' + text.slice(start, start + 300))
}

/** 调 CLI 并解析 JSON（stdout/stderr 都可能带 [wechatide] 前缀） */
function callCli (cli, tool, args, opts = {}) {
  const { timeoutMs = 120000, withProject = true } = opts
  const base = ['-c', CLIENT, tool]
  if (withProject) base.push('--project', PROJECT)
  const res = spawnSync('cmd', ['/c', cli, ...base, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  })
  const out = String(res.stdout || '') + String(res.stderr || '')
  const json = extractJson(out)
  if (!json.ok) {
    throw new Error(`${tool} 失败：${json.message || json.errorType || 'unknown'}`)
  }
  return json.result || {}
}

function main () {
  const cli = findCli()
  if (!cli) {
    console.log('SKIP: 未找到 wechatide.cmd（设置 WECHATIDE_CLI 或安装 >=2.02.2607152 的开发者工具）')
    process.exit(2)
  }

  const outDir = path.join(ARTIFACTS, 'official-cli-' + Date.now())
  fs.mkdirSync(outDir, { recursive: true })
  const cases = []
  const run = (name, fn) => {
    const c = { name, status: 'PASS', assertions: [], error: '' }
    try { fn(c) } catch (e) { c.status = 'FAIL'; c.error = e.message }
    cases.push(c)
  }
  const shot = (name) => {
    const p = path.join(outDir, name + '.png')
    callCli(cli, 'simulator_screenshot', ['--path', p, '--wait', '2'])
    return p
  }

  // 0) 环境门禁（check_wechatide_status 不接受 --project）
  const status = callCli(cli, 'check_wechatide_status', ['--skill-version', '0.3.18'], { withProject: false })
  if (!status.success || status.loginExpired) {
    console.log('SKIP: IDE 未就绪（loginExpired=' + status.loginExpired + '）')
    process.exit(2)
  }

  // 1) 注入患者登录态（首页 onShow 有登录守卫；这是测试夹具，不是伪造业务结果）
  run('准备：注入患者登录态', (c) => {
    const r = callCli(cli, 'automation_evaluate', [
      '--fn-source',
      "function(){var a=getApp();a.globalData.role='patient';a.globalData.user={name:'Test',avatarText:'T'};a.globalData.theme='standard';return {role:a.globalData.role}}"
    ])
    const role = r && r.result && r.result.result
      ? r.result.result.role
      : (r && r.result ? r.result.role : undefined)
    if (role !== 'patient') throw new Error('注入失败：' + JSON.stringify(r))
    c.assertions.push('globalData.role=patient')
  })

  // 2) 旅程 A：首页 → AI 智能导诊
  run('旅程A：首页 → AI 智能导诊', (c) => {
    callCli(cli, 'automation_navigate', ['--action', 'reLaunch', '--url', '/pages/home/home'])
    callCli(cli, 'automation_element_action', ['--action', 'tap', '--selector', '.hm-ai'])
    const cur = callCli(cli, 'automation_runtime_info', ['--action', 'currentPage'])
    const route = cur && cur.currentPage && cur.currentPage.route
    if (route !== '/pages/triage/triage') throw new Error('未进入导诊页，当前=' + route)
    c.assertions.push('route=/pages/triage/triage')
    const title = callCli(cli, 'automation_element_action', ['--action', 'text', '--selector', '.tg-hero-title'])
    if (!title || !String(title).trim()) throw new Error('导诊页标题为空')
    c.assertions.push('标题非空：' + String(title).trim())
    c.screenshot = shot('journey-a')
  })

  // 3) 旅程 B：预约挂号页结构
  run('旅程B：预约挂号页结构', (c) => {
    callCli(cli, 'automation_navigate', ['--action', 'reLaunch', '--url', '/pages/appointment/appointment'])
    const root = callCli(cli, 'automation_page_action', ['--action', 'querySelector', '--selector', '.apt-page'])
    if (!root || !root.element) throw new Error('挂号页 .apt-page 不存在')
    c.assertions.push('.apt-page 存在')
    const search = callCli(cli, 'automation_page_action', ['--action', 'querySelector', '--selector', '.ap-search-in'])
    if (!search || !search.element) throw new Error('搜索框 .ap-search-in 不存在')
    c.assertions.push('.ap-search-in 存在')
    c.screenshot = shot('journey-b')
  })

  const failed = cases.filter((c) => c.status === 'FAIL')
  const report = {
    generatedAt: new Date().toISOString(),
    cli,
    project: PROJECT,
    status: failed.length ? 'FAIL' : 'PASS',
    cases,
    outDir
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')

  console.log('OUT:', outDir)
  cases.forEach((c) => {
    console.log(c.status, '|', c.name, '|', c.assertions.join('; '), c.error ? '| ERR: ' + c.error : '')
  })
  console.log(failed.length ? 'RESULT: FAIL' : 'RESULT: PASS')
  process.exit(failed.length ? 1 : 0)
}

main()
