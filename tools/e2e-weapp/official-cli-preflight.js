/*
 * official-cli-preflight.js —— 官方 wechatide CLI 环境预检
 *
 * 为什么单独一个脚本：回归失败十有八九是环境前置缺失（IDE 没开/没授权/版本不一致），
 * 但 official-cli-e2e.js 会把它们误报成 3 条用例 FAIL。本脚本先逐项探明，缺啥报啥。
 *
 * 退出码：0=全就绪；2=有 SKIP 项（环境未就绪，不判 FAIL）。
 *
 * 用法：
 *   node tools/e2e-weapp/official-cli-preflight.js
 *   WECHATIDE_CLI="D:/微信web开发者工具/wechatide.cmd" node tools/e2e-weapp/official-cli-preflight.js
 */
'use strict'
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..', '..')
const PROJECT = path.join(ROOT, 'miniprogram')
const CLIENT = process.env.WECHATIDE_CLIENT || 'WorkBuddy'
const SKILL_VERSION = '0.3.18'

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

/** CLI 外层信封 {ok, tool, result}，业务字段在 result 内——与 e2e.js 的 callCli 一致 */
function unwrap (json) {
  if (!json || typeof json !== 'object') return {}
  if (json.ok && json.result && typeof json.result === 'object') return json.result
  return json
}

/** 按括号深度截取首个完整 JSON 对象（忽略字符串内括号），与 e2e.js 同口径 */
function extractJson (text) {
  const start = text.indexOf('{')
  if (start < 0) throw new Error('无 JSON 输出：' + text.slice(0, 200))
  let depth = 0; let inStr = false; let esc = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
  }
  throw new Error('JSON 不完整')
}

function callCli (cli, tool, args, withProject = true) {
  const base = ['-c', CLIENT, tool]
  if (withProject) base.push('--project', PROJECT)
  const res = spawnSync('cmd', ['/c', cli, ...base, ...args], {
    encoding: 'utf8', timeout: 60000, windowsHide: true
  })
  const out = String(res.stdout || '') + String(res.stderr || '')
  return unwrap(extractJson(out))
}

function main () {
  const rows = []
  const add = (name, ok, detail) => rows.push({ name, status: ok ? 'OK' : 'SKIP', detail })
  let cli = ''

  // 1) CLI 是否存在
  cli = findCli()
  add('CLI 存在', !!cli, cli || '未找到 wechatide.cmd（设置 WECHATIDE_CLI 或装 IDE≥2.02.2607152）')
  if (!cli) return report(rows)

  // 2) 项目目录存在
  add('项目目录', fs.existsSync(PROJECT), PROJECT)

  // 3) IDE 状态/版本/登录（check_wechatide_status 不吃 --project）
  //    注意：reg.exe/WMIC.exe 被安全中心黑名单拦时，CLI 可能返回 success=false 但无 errorType，
  //    此时把整个返回体截断贴出，避免 detail 空白让人误判为"IDE 正常"。
  let status = null
  try {
    status = callCli(cli, 'check_wechatide_status', ['--skill-version', SKILL_VERSION], false)
    const ready = !!(status && status.success)
    const why = ready ? 'success'
      : (status && (status.errorType || status.message)) || ('返回体=' + JSON.stringify(status).slice(0, 160))
    add('IDE 已就绪', ready, why)
    // 登录/版本项只有在 IDE 已就绪时才有意义，否则标 N/A 而不是 OK（避免矛盾）
    if (ready) {
      add('登录未过期', !status.loginExpired, 'loginExpired=' + !!status.loginExpired)
      add('skill 版本一致', status.versionRelation === 'equal', 'versionRelation=' + status.versionRelation)
    } else {
      rows.push({ name: '登录未过期', status: 'N/A', detail: 'IDE 未就绪，跳过' })
      rows.push({ name: 'skill 版本一致', status: 'N/A', detail: 'IDE 未就绪，跳过' })
    }
  } catch (e) {
    add('IDE 状态探测', false, e.message)
    rows.push({ name: '登录未过期', status: 'N/A', detail: 'IDE 状态探测失败' })
    rows.push({ name: 'skill 版本一致', status: 'N/A', detail: 'IDE 状态探测失败' })
  }

  // 4) 项目窗口（页面运行时）—— 用 currentPage 探，失败即"没开窗口/没 runtimeid"
  if (status && status.success && !status.loginExpired) {
    try {
      const cur = callCli(cli, 'automation_runtime_info', ['--action', 'currentPage'])
      add('项目窗口/运行时', true, 'currentPage=' + (cur && cur.currentPage && cur.currentPage.route || JSON.stringify(cur).slice(0, 100)))
    } catch (e) {
      add('项目窗口/运行时', false, e.message + '（多半是 IDE 没开或没 open_project_window）')
    }
  } else {
    add('项目窗口/运行时', false, '跳过：IDE 未就绪或未登录')
  }

  report(rows)
}

function report (rows) {
  rows.forEach((r) => {
    console.log(r.status.padEnd(5), '|', r.name, '|', r.detail || '')
  })
  // 只统计独立的 SKIP 项；N/A 是 IDE 未就绪的派生项，不重复计数
  const skipped = rows.filter((r) => r.status === 'SKIP').length
  console.log('\nRESULT:', skipped ? 'SKIP(' + skipped + '项环境未就绪)' : 'READY')
  process.exit(skipped ? 2 : 0)
}

main()
