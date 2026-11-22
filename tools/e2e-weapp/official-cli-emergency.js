/*
 * official-cli-emergency.js —— 模拟器急症红旗专项回归（官方 wechatide CLI）
 *
 * 目的：发布前复测「急救横幅 / 拨打120 按钮」在真实渲染层是否出现，而不是只信单元测试。
 * 断言口径：
 *   1. 「无诱因胸痛，还冒冷汗」→ 常驻红条 .emg-bar 出现，文案含「急诊」，.emg-bar-call 文本为「拨打120」
 *   2. 同轮生成内联急症卡 .emg-card（含「紧急情况」标题与「前往急诊区」）
 *   3. 负样本「无胸痛」→ 不出现红条（否定语义不误报）
 *   4. 「不舒服3天」→ 时长槽位被采到（弱否定「不」不吞时长）
 *
 * 前置：IDE 已登录且项目窗口已开；否则 SKIP(2)，不写 PASS。
 * 产物：artifacts/e2e-weapp/official-cli-emergency-<时间戳>/report.json + 截图
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
    'C:/Program Files (x86)/Tencent/微信web开发者工具/wechatide.cmd',
    'C:/Program Files/Tencent/微信web开发者工具/wechatide.cmd'
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) || ''
}

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
  if (!json.ok) throw new Error(`${tool} 失败：${json.message || json.errorType || 'unknown'}`)
  return json.result || {}
}

/** 取元素文本：CLI 对 text 动作返回结构在不同版本略有差异，做兼容取值 */
function elementText (cli, selector) {
  const r = callCli(cli, 'automation_element_action', ['--action', 'text', '--selector', selector])
  if (typeof r === 'string') return r
  if (r && typeof r.text === 'string') return r.text
  if (r && r.result && typeof r.result === 'string') return r.result
  if (r && r.result && typeof r.result.text === 'string') return r.result.text
  return ''
}

function exists (cli, selector) {
  try {
    const r = callCli(cli, 'automation_page_action', ['--action', 'querySelector', '--selector', selector])
    return !!(r && r.element)
  } catch (e) {
    return false
  }
}

function main () {
  const cli = findCli()
  if (!cli) {
    console.log('SKIP: 未找到 wechatide.cmd')
    process.exit(2)
  }
  const outDir = path.join(ARTIFACTS, 'official-cli-emergency-' + Date.now())
  fs.mkdirSync(outDir, { recursive: true })

  const status = callCli(cli, 'check_wechatide_status', ['--skill-version', '0.3.18'], { withProject: false })
  if (!status.success || status.loginExpired) {
    console.log('SKIP: IDE 未就绪（loginExpired=' + status.loginExpired + '）')
    process.exit(2)
  }

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
  /** 重置导诊页到干净状态并注入登录夹具 */
  const freshTriage = () => {
    callCli(cli, 'automation_evaluate', [
      '--fn-source',
      "function(){var a=getApp();a.globalData.role='patient';a.globalData.user={name:'Test',avatarText:'T'};a.globalData.theme='standard';return {role:a.globalData.role}}"
    ])
    callCli(cli, 'automation_navigate', ['--action', 'reLaunch', '--url', '/pages/triage/triage'])
    // 等导诊页真正渲染完（输入框是页面骨架最稳的锚点）
    callCli(cli, 'automation_page_action', [
      '--action', 'querySelector', '--selector', '.input-field',
      '--wait-for-selector', '.input-field'
    ], { timeoutMs: 60000 })
  }
  const say = (text) => {
    callCli(cli, 'automation_element_action', ['--action', 'input', '--selector', '.input-field', '--value', text])
    callCli(cli, 'automation_element_action', ['--action', 'tap', '--selector', '.send-fab'])
  }
  /** 读页面 data（兼容 CLI 返回 {data:{...}} 与直接 {data 字段}） */
  const pageData = () => {
    const r = callCli(cli, 'automation_page_action', ['--action', 'getData'])
    return (r && r.data && typeof r.data === 'object') ? r.data : (r || {})
  }

  run('急症：无诱因胸痛+冷汗 → 常驻红条 + 拨打120', (c) => {
    freshTriage()
    say('无诱因胸痛，还冒冷汗')
    callCli(cli, 'automation_page_action', [
      '--action', 'querySelector', '--selector', '.emg-bar', '--wait-for-selector', '.emg-bar'
    ], { timeoutMs: 30000 })
    if (!exists(cli, '.emg-bar')) throw new Error('未出现 .emg-bar 急救横幅')
    c.assertions.push('.emg-bar 出现')
    const barText = elementText(cli, '.emg-bar-text')
    if (!barText.trim()) throw new Error('.emg-bar-text 为空')
    if (barText.indexOf('急诊') < 0) throw new Error('横幅文案未指向急诊：' + barText)
    c.assertions.push('横幅文案：' + barText.trim().slice(0, 40))
    const callText = elementText(cli, '.emg-bar-call')
    if (callText.trim() !== '拨打120') throw new Error('.emg-bar-call 文案异常：' + callText)
    c.assertions.push('拨打120 按钮存在')
    if (!exists(cli, '.emg-card')) throw new Error('未出现内联急症卡 .emg-card')
    const head = elementText(cli, '.emg-title')
    if (head.indexOf('紧急情况') < 0) throw new Error('急症卡标题异常：' + head)
    c.assertions.push('内联急症卡：' + head.trim().slice(0, 30))
    if (!exists(cli, '.emg-op-call')) throw new Error('急症卡内「拨打120」操作缺失')
    c.assertions.push('.emg-op-call 存在')
    c.screenshot = shot('emergency-chest-pain')
  })

  run('负样本：无胸痛 → 不得出现红条', (c) => {
    freshTriage()
    say('无胸痛也没有呼吸困难')
    // 等本地规则跑完（无网络请求，1.2s 足够）
    callCli(cli, 'automation_evaluate', [
      '--fn-source',
      'function(){return new Promise(function(r){setTimeout(function(){r(1)},1200)})}'
    ])
    if (exists(cli, '.emg-bar')) throw new Error('「无胸痛」仍触发急救横幅（否定语义回归）')
    c.assertions.push('.emg-bar 未出现')
    const emg = pageData().emergency
    if (emg) throw new Error('page.data.emergency 非空：' + JSON.stringify(emg))
    c.assertions.push('page.data.emergency=null')
    c.screenshot = shot('negative-no-chest-pain')
  })

  run('弱否定：不舒服3天 → 时长未被「不」吞掉', (c) => {
    freshTriage()
    say('不舒服3天')
    callCli(cli, 'automation_page_action', [
      '--action', 'querySelector', '--selector', '.collect-bar', '--wait-for-selector', '.collect-bar'
    ], { timeoutMs: 30000 })
    const slots = String(pageData().slotsText || '')
    if (!slots) throw new Error('slotsText 为空，时长未采集（弱否定「不」又把时长吞了）')
    // 时长是分桶归一（3天→数天，见 triage-kb DURATION 表），断言「采到时长」而不是字面「3天」
    if (slots.indexOf('时长') < 0) throw new Error('slotsText 无时长项：' + slots)
    c.assertions.push('slotsText：' + slots.slice(0, 40))
    if (exists(cli, '.emg-bar')) throw new Error('「不舒服3天」误触发急救横幅')
    c.assertions.push('未误报急症')
    c.screenshot = shot('weak-negation-duration')
  })

  const failed = cases.filter((c) => c.status === 'FAIL')
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    cli,
    project: PROJECT,
    status: failed.length ? 'FAIL' : 'PASS',
    cases,
    outDir
  }, null, 2), 'utf8')

  console.log('OUT:', outDir)
  cases.forEach((c) => {
    console.log(c.status, '|', c.name, '|', c.assertions.join('; '), c.error ? '| ERR: ' + c.error : '')
  })
  console.log(failed.length ? 'RESULT: FAIL' : 'RESULT: PASS')
  process.exit(failed.length ? 1 : 0)
}

main()
