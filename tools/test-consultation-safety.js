/**
 * test-consultation-safety.js —— 在线问诊「服务端 safety → 急救横幅 / 120」契约测试
 *
 * 为什么要有它（2026-11-22 敌意审查 L1）：
 *   前端 consultation.js 的产品红线是「只认服务端 safety」；服务端命中急症后必须
 *   真实渲染横幅与一键 120。页面依赖 wx/Page，无法直接跑，所以：
 *     ① 判定收敛到 utils/consultation-safety.js（纯函数）→ 行为级断言；
 *     ② 页面源码 → 断言 setData/弹窗/拨号链路没有被改断；
 *     ③ WXML → 断言横幅条件与按钮真实存在。
 *
 * 用法：node tools/test-consultation-safety.js   （CI frontend job）
 * 退出码：0 全部通过 / 1 任一断言失败。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
const CS = require(path.join(ROOT, 'utils', 'consultation-safety.js'))
const PAGE_JS = path.join(ROOT, 'pages', 'consultation', 'consultation.js')
const PAGE_WXML = path.join(ROOT, 'pages', 'consultation', 'consultation.wxml')

let pass = 0
let fail = 0
const failures = []

function check(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  failures.push(name + (extra ? '  →  ' + extra : ''))
}

// ==================== ① 纯函数：服务端 safety 的渲染口径 ====================
const serverText = '命中急症红旗：急性胸痛。疑似急症表现：请立即拨打 120 或前往最近医院急诊科，不要等待线上回复。'
check('emergency=true 使用服务端原文', CS.emergencyText({ emergency: true, message: serverText }) === serverText)
const fallback = CS.emergencyText({ emergency: true })
check('emergency=true 且无 message 时给默认急救文案',
  /120/.test(fallback) && /急诊科/.test(fallback), fallback)
check('emergency=false 不渲染横幅', CS.emergencyText({ emergency: false, message: 'x' }) === '')
check('safety 缺失不渲染横幅', CS.emergencyText(null) === '' && CS.emergencyText(undefined) === '')
check('emergency=true 主推荐急诊科', CS.emergencyDept({ emergency: true }) === '急诊科')
check('emergency=false 不推荐急诊科', CS.emergencyDept({ emergency: false }) === '')

// ==================== ② 页面源码：只认服务端 + 120 链路 ====================
const page = fs.readFileSync(PAGE_JS, 'utf-8')
check('页面引入 consultation-safety 纯函数', /consultation-safety\.js/.test(page))
check('页面不引入本地红旗词表（triage-kb / RED_FLAGS）',
  !/triage-kb/.test(page) && !/RED_FLAGS/.test(page))
check('_askAi 只读服务端 res.safety', /const safety = res && res\.safety/.test(page))
check('急症分支调用 _onEmergency', /if \(safety && safety\.emergency\)[\s\S]{0,80}_onEmergency\(safety\)/.test(page))
check('横幅文案写入 data.emergency', /emergency: advice/.test(page))
check('主推荐科室来自服务端 safety（急诊科）', /consultationSafety\.emergencyDept\(safety\)/.test(page))
check('弹窗确认后拨打 120', /if \(res\.confirm\) this\.onCall120\(\)/.test(page))
check('onCall120 使用系统拨号且号码 120', /phoneNumber: '120'/.test(page))

// ==================== ③ WXML：横幅与按钮必须真实存在 ====================
const wxml = fs.readFileSync(PAGE_WXML, 'utf-8')
check('WXML 有 emergency 条件横幅', /wx:if="\{\{emergency\}\}"/.test(wxml))
check('WXML 渲染 emergency 文案', /\{\{emergency\}\}/.test(wxml))
check('WXML 有一键拨打 120 入口', /onCall120/.test(wxml) && /拨打120/.test(wxml))

console.log('— 在线问诊 safety 契约 —')
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) {
  console.log('\n失败明细：')
  failures.forEach((f) => console.log('  ✗ ' + f))
  process.exit(1)
}
console.log('RESULT: CONSULTATION_SAFETY_OK')
