/*
 * batch-screenshot.js —— 模拟器全页面批量截图（官方 wechatide CLI）
 *
 * 用途：把当前系统全部注册页面逐个导航并截图，按页面分类目录保存，
 *       产出 manifest.json 记录每页路由校验结果与截图路径，供对照文档引用。
 *
 * 关键点：
 *   - 本 IDE 版本的 automation_navigate(reLaunch) 会报 Uncaught [object Object]，
 *     故统一用 automation_evaluate 调 wx.reLaunch 导航（已实测可用）。
 *   - 每页导航前注入患者/医生登录态夹具（首页 onShow 有登录守卫）。
 *   - 不伪造业务结果；导航失败的页记录失败原因，截图为真实渲染。
 *
 * 用法：node tools/e2e-weapp/batch-screenshot.js
 * 产物：artifacts/page-atlas/<分类>/<序号>-<页面名>.png + manifest.json
 */
'use strict'
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..', '..')
const PROJECT = path.join(ROOT, 'miniprogram')
const OUT = path.join(ROOT, 'artifacts', 'page-atlas')
const CLIENT = process.env.WECHATIDE_CLIENT || 'WorkBuddy'
const WAIT = process.env.SHOT_WAIT || '2'

const CLI = [
  process.env.WECHATIDE_CLI,
  'D:/微信web开发者工具/wechatide.cmd',
  'D:/OpenWeChar/微信web开发者工具/wechatide.cmd',
  'C:/Program Files (x86)/Tencent/微信web开发者工具/wechatide.cmd',
  'C:/Program Files/Tencent/微信web开发者工具/wechatide.cmd'
].filter(Boolean).find((p) => fs.existsSync(p))

// 页面清单（来自 app.json，含分类与角色）——角色决定注入哪种登录态夹具
const PAGES = [
  { route: '/pages/auth/login/login',           cat: '01-登录与授权', name: 'login',            role: 'none' },
  { route: '/pages/auth/consent/consent',       cat: '01-登录与授权', name: 'consent',          role: 'none' },
  { route: '/pages/auth/health-consent/health-consent', cat: '01-登录与授权', name: 'health-consent', role: 'none' },
  { route: '/pages/auth/patient-login/patient-login', cat: '01-登录与授权', name: 'patient-login', role: 'none' },
  { route: '/pages/auth/manual-login/manual-login', cat: '01-登录与授权', name: 'manual-login',  role: 'none' },
  { route: '/pages/auth/doctor-login/doctor-login', cat: '01-登录与授权', name: 'doctor-login',   role: 'none' },
  { route: '/pages/home/home',                  cat: '02-首页与Tab', name: 'home',              role: 'patient' },
  { route: '/pages/consultation/consultation',  cat: '02-首页与Tab', name: 'consultation',      role: 'patient' },
  { route: '/pages/health/health',              cat: '02-首页与Tab', name: 'health',            role: 'patient' },
  { route: '/pages/profile/profile',            cat: '02-首页与Tab', name: 'profile',           role: 'patient' },
  { route: '/pages/appointment/appointment',    cat: '02-首页与Tab', name: 'appointment',       role: 'patient' },
  { route: '/pages/profile/records/records',    cat: '03-个人中心', name: 'records',            role: 'patient' },
  { route: '/pages/profile/health-records/health-records', cat: '03-个人中心', name: 'health-records', role: 'patient' },
  { route: '/pages/profile/reports/reports',    cat: '03-个人中心', name: 'reports',            role: 'patient' },
  { route: '/pages/profile/report-detail/report-detail', cat: '03-个人中心', name: 'report-detail', role: 'patient' },
  { route: '/pages/profile/consultations/consultations', cat: '03-个人中心', name: 'consultations', role: 'patient' },
  { route: '/pages/profile/messages/messages',  cat: '03-个人中心', name: 'messages',           role: 'patient' },
  { route: '/pages/profile/family/family',      cat: '03-个人中心', name: 'family',             role: 'patient' },
  { route: '/pages/profile/personal-info/personal-info', cat: '03-个人中心', name: 'personal-info', role: 'patient' },
  { route: '/pages/profile/settings/settings',  cat: '03-个人中心', name: 'settings',           role: 'patient' },
  { route: '/pages/profile/voice-settings/voice-settings', cat: '03-个人中心', name: 'voice-settings', role: 'patient' },
  { route: '/pages/profile/privacy/privacy',    cat: '03-个人中心', name: 'privacy',            role: 'none' },
  { route: '/pages/profile/agreement/agreement',cat: '03-个人中心', name: 'agreement',          role: 'none' },
  { route: '/pages/doctor/workbench/workbench', cat: '04-医生端', name: 'workbench',            role: 'doctor' },
  { route: '/pages/doctor/personal/personal',   cat: '04-医生端', name: 'doctor-personal',       role: 'doctor' },
  { route: '/pages/doctor/consult/consult',     cat: '04-医生端', name: 'doctor-consult',        role: 'doctor' },
  { route: '/pages/doctor/schedule/schedule',   cat: '04-医生端', name: 'doctor-schedule',       role: 'doctor' },
  { route: '/pages/doctor/messages/messages',   cat: '04-医生端', name: 'doctor-messages',       role: 'doctor' },
  { route: '/pages/triage/triage',              cat: '05-问诊导诊', name: 'triage',             role: 'patient' },
  { route: '/pages/triage/result/result',       cat: '05-问诊导诊', name: 'triage-result',       role: 'patient' },
  { route: '/pages/consult/consult',            cat: '05-问诊导诊', name: 'consult',            role: 'patient' },
  { route: '/pages/consult/picker/picker',      cat: '05-问诊导诊', name: 'consult-picker',      role: 'patient' },
  { route: '/pages/exam/exam',                  cat: '06-业务分包', name: 'exam',               role: 'patient' },
  { route: '/pages/payment/payment',            cat: '06-业务分包', name: 'payment',            role: 'patient' },
  { route: '/pages/tv/cast/cast',               cat: '06-业务分包', name: 'cast',               role: 'patient' },
  { route: '/packageNav/pages/nav/nav',         cat: '06-业务分包', name: 'nav',                role: 'patient' },
  { route: '/packageContent/pages/knowledge/knowledge', cat: '07-科普内容', name: 'knowledge',   role: 'patient' },
  { route: '/packageContent/pages/detail/detail', cat: '07-科普内容', name: 'detail',           role: 'patient' }
]

function callCli (tool, args) {
  const base = ['-c', CLIENT, tool, '--project', PROJECT]
  const res = spawnSync('cmd', ['/c', CLI, ...base, ...args], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '' }
  })
  const out = String(res.stdout || '') + String(res.stderr || '')
  const start = out.indexOf('{')
  if (start < 0) return { ok: false, raw: out.slice(0, 200) }
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < out.length; i += 1) {
    const ch = out[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { try { return JSON.parse(out.slice(start, i + 1)) } catch (e) { return { ok: false, raw: out.slice(start, i + 1) } } }
    }
  }
  return { ok: false, raw: out.slice(start, start + 200) }
}

function evalFn (fnSource) {
  const r = callCli('automation_evaluate', ['--fn-source', fnSource])
  // 返回嵌套：r.result.result（业务函数返回值）
  if (r && r.result && r.result.result && typeof r.result.result === 'object' && 'result' in r.result.result) {
    return r.result.result.result
  }
  return r
}

function currentRoute () {
  const r = callCli('automation_runtime_info', ['--action', 'currentPage'])
  try { return r.result.currentPage.route } catch (e) { return '(unknown)' }
}

function injectRole (role) {
  const user = role === 'doctor'
    ? "{name:'王医生',avatarText:'王'}"
    : "{name:'Test',avatarText:'T'}"
  const fn = `function(){var a=getApp();a.globalData.role='${role}';a.globalData.user=${user};a.globalData.theme='standard';return {role:a.globalData.role}}`
  return evalFn(fn)
}

function main () {
  if (!CLI) { console.log('SKIP: 未找到 wechatide.cmd'); process.exit(2) }
  fs.mkdirSync(OUT, { recursive: true })
  const manifest = { generatedAt: new Date().toISOString(), cli: CLI, project: PROJECT, outDir: OUT, total: PAGES.length, pages: [] }

  PAGES.forEach((p, idx) => {
    const seq = String(idx + 1).padStart(2, '0')
    const dir = path.join(OUT, p.cat)
    fs.mkdirSync(dir, { recursive: true })
    const shotName = `${seq}-${p.name}.png`
    const shotPath = path.join(dir, shotName)

    // 注入登录态（角色页）；非登录页统一患者
    const effRole = p.role === 'none' ? 'patient' : p.role
    injectRole(effRole)

    // 导航（用 evaluate 调 wx.reLaunch，规避 CLI navigate 缺陷）
    evalFn(`function(){try{wx.reLaunch({url:'${p.route}'});return 'ok'}catch(e){return 'ERR:'+(e&&e.message||e)}}`)

    const route = currentRoute()
    const match = route === p.route

    // 截图
    const sr = callCli('simulator_screenshot', ['--path', shotPath, '--wait', WAIT])
    const ok = match && fs.existsSync(shotPath) && fs.statSync(shotPath).size > 1000

    const entry = {
      seq, route: p.route, category: p.cat, name: p.name, role: effRole,
      screenshot: path.relative(ROOT, shotPath).replace(/\\/g, '/'),
      landedRoute: route, routeMatch: match,
      sizeKB: fs.existsSync(shotPath) ? +(fs.statSync(shotPath).size / 1024).toFixed(1) : 0,
      status: ok ? 'OK' : (match ? 'SHOT_FAIL' : 'ROUTE_MISMATCH'),
      screenshotOk: sr && (sr.ok || (sr.result && sr.result.success)) ? true : fs.existsSync(shotPath)
    }
    manifest.pages.push(entry)
    console.log(`${ok ? 'OK ' : 'WARN'} | ${seq} | ${p.route} | landed=${route} | ${entry.sizeKB}KB`)
  })

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  const okCount = manifest.pages.filter((p) => p.status === 'OK').length
  console.log(`\nRESULT: ${okCount}/${PAGES.length} OK; manifest=${path.join(OUT, 'manifest.json')}`)
  process.exit(okCount === PAGES.length ? 0 : 1)
}

main()
