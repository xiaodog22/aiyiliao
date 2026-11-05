/**
 * test-patient-deep-audit.js —— 分片 B2「患者端 9 页」详细版深度审计离线单测
 *
 * 打桩 wx / getApp / Page / storage，node 直接运行，覆盖：
 *   A. P1-03 回归断言：home._route('checkup'/'care') 必须有用户反馈（showModal/toast/跳转）
 *      —— 第一轮红：NOT_READY 零引用、default 空分支静默。断言按「修复后应有行为」编写，
 *      实测红/绿如实记录。
 *   B. P1-04 回归断言：consultation._onAiFail 失败气泡不得直出英文错误码/err.code，
 *      且必须经 err-text.js（第一轮红：直拼 err.message/code）。
 *   C. 边界与篡改辅助：
 *      - home._route('triage', text) 深链 encodeURIComponent（含特殊字符）
 *      - 挂号 goConfirm/onSubmit 守卫、问诊 send 防重复提交
 *      - voiceReadEnabled 对 storage 异常值的行为（篡改观察项）
 *      - wb_theme 读取是否有档位白名单（静态源扫描）
 *      - 进度卡是否按中文文案硬编码分支（静态源扫描，对照 apt-status.js）
 *      - onLoad 深链参数 decodeURIComponent 是否有 try/catch 兜底（静态源扫描）
 *   D. 对比度量化（WCAG 公式确定性计算，打印表供报告引用）
 *
 * 用法：node tools/test-patient-deep-audit.js
 * 说明：只读页面定义对象做行为驱动 + 静态源扫描，不修改任何源码。
 */
const path = require('path')
const fs = require('fs')
const ROOT = path.join(__dirname, '..', 'miniprogram')

/* ==================== 全局打桩（必须在 require 页面模块之前） ==================== */
const storage = {}
const navCalls = []
const toastCalls = []
const modalCalls = []

global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v },
  removeStorageSync: (k) => { delete storage[k] },
  navigateTo: (o) => { navCalls.push({ method: 'navigateTo', url: o.url }) },
  redirectTo: (o) => { navCalls.push({ method: 'redirectTo', url: o.url }) },
  switchTab: (o) => { navCalls.push({ method: 'switchTab', url: o.url }) },
  reLaunch: (o) => { navCalls.push({ method: 'reLaunch', url: o.url }) },
  showToast: (o) => { toastCalls.push(o.title) },
  showModal: (o) => { modalCalls.push(o) },
  showActionSheet: (o) => {},
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 667 }),
  getMenuButtonBoundingClientRect: () => ({ width: 32, left: 320 }),
  makePhoneCall: () => {},
  vibrateShort: () => {},
  stopRecord: () => {},
  startRecord: () => {},
  stopSpeak: () => {},
  hideKeyboard: () => {},
  pageScrollTo: () => {}
}

global.getApp = () => ({
  globalData: { role: 'patient', theme: 'standard', user: { name: '张三', phone: '13800001111' } },
  MOCK: {
    HOME: { greeting: '早上好', appointment: { dept: '呼吸内科', doctor: '王医生' } },
    PATIENT: { name: '张三' },
    DEPARTMENTS: [],
    TIME_SLOTS: [],
    TV_PREVIEW: { waiting: ['候诊 001 号', '候诊 002 号'] }
  },
  logout: () => {}
})

let lastPage = null
global.Page = (def) => { lastPage = def }

/* ==================== 加载页面定义 ==================== */
function loadPage(p) {
  lastPage = null
  require(path.join(ROOT, p))
  return lastPage
}
const homeDef = loadPage('pages/home/home.js')
const consultationDef = loadPage('pages/consultation/consultation.js')
const appointmentDef = loadPage('pages/appointment/appointment.js')
const triageDef = loadPage('pages/triage/triage.js')

/* ==================== 运行时上下文 ==================== */
function makeCtx(def) {
  const ctx = Object.assign({}, def)
  ctx.data = JSON.parse(JSON.stringify(def.data || {}))
  ctx.setData = function (patch, cb) {
    for (const k of Object.keys(patch)) {
      const m = k.match(/^messages\[(\d+)\](?:\.(.+))?$/)
      if (m) {
        const i = Number(m[1])
        if (!Array.isArray(ctx.data.messages)) ctx.data.messages = []
        if (m[2]) {
          if (!ctx.data.messages[i]) ctx.data.messages[i] = {}
          ctx.data.messages[i][m[2]] = patch[k]
        } else { ctx.data.messages[i] = patch[k] }
      } else {
        ctx.data[k] = patch[k]
      }
    }
    if (typeof cb === 'function') cb()
  }
  return ctx
}

/* ==================== 统计 ==================== */
let pass = 0
let fail = 0
const failures = []
const redGreen = []   // P1 断言红/绿台账

function check(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  failures.push(name + (extra ? '  →  ' + extra : ''))
}
function section(t) { console.log('\n— ' + t + ' —') }
function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8') }

/* ==================== A. P1-03 回归断言 ==================== */
section('A. P1-03 首页 checkup/care 用户反馈断言')
{
  const src = readSrc('pages/home/home.js')
  // A1 源级：NOT_READY 不再是死常量（有引用）
  const notReadyUses = (src.match(/NOT_READY/g) || []).length
  check('A1 NOT_READY 常量被引用 ≥2 次（定义+使用）', notReadyUses >= 2, '仅出现 ' + notReadyUses + ' 次')

  // A2 行为级：_route('checkup') 必须触发 showModal / showToast / 任一导航（不能静默）
  modalCalls.length = 0
  navCalls.length = 0
  const homeCtx = makeCtx(homeDef)
  homeDef._route.call(homeCtx, 'checkup')
  const fbCheckup = modalCalls.length > 0 || toastCalls.length > 0 || navCalls.length > 0
  check('A2 _route(checkup) 有用户反馈（modal/toast/navigate）', fbCheckup,
    'modal=' + modalCalls.length + ' toast=' + toastCalls.length + ' nav=' + navCalls.length)
  check('A2b checkup 不做假跳转', navCalls.length === 0, '误跳转 ' + JSON.stringify(navCalls))

  // A3 行为级：_route('care') 同样有反馈
  modalCalls.length = 0
  homeDef._route.call(homeCtx, 'care')
  const fbCare = modalCalls.length > 0 || toastCalls.length > 0 || navCalls.length > 0
  check('A3 _route(care) 有用户反馈（modal/toast/navigate）', fbCare,
    'modal=' + modalCalls.length)
  const modalTitle = modalCalls.length ? (modalCalls[0].title || '') : ''
  check('A3b modal 标题含「居家护理」业务名', modalTitle.indexOf('居家护理') >= 0, '标题=' + modalTitle)

  redGreen.push({ id: 'P1-03', green: fbCheckup && fbCare && notReadyUses >= 2 })
}

/* ==================== B. P1-04 回归断言 ==================== */
section('B. P1-04 consultation 失败气泡文案断言')
{
  const src = readSrc('pages/consultation/consultation.js')
  // B1 源级：文件 require err-text.js
  check('B1 源码 require err-text.js', /require\(['"][^'"]*err-text\.js['"]\)/.test(src))
  // B2 源级：_onAiFail 体内调用 errText
  const m = src.match(/_onAiFail\(err\)\s*\{([\s\S]*?)\n\s*\}/)
  const body = m ? m[1] : ''
  check('B2 _onAiFail 调用 errText()', /errText\s*\(/.test(body), '方法体未匹配到 errText')

  // B3 行为级：模拟 NETWORK_ERROR 失败 → 气泡不得出现英文码/大写蛇形码
  const ctx = makeCtx(consultationDef)
  ctx._gone = false
  ctx._idemKey = 'k1'
  consultationDef._onAiFail.call(ctx, { code: 'NETWORK_ERROR', message: 'NETWORK_ERROR' })
  const bubble = (ctx.data.messages && ctx.data.messages.length)
    ? ctx.data.messages[ctx.data.messages.length - 1].content : ''
  console.log('  实测气泡：' + bubble)
  const hasEnglishCode = /[A-Z][A-Z_]{3,}/.test(bubble) // NETWORK_ERROR / HTTP_500 等
  check('B3 失败气泡不含英文错误码（NETWORK_ERROR 等）', !hasEnglishCode, '气泡=' + bubble)
  check('B4 失败气泡含中文说明', /[一-龥]/.test(bubble), '气泡=' + bubble)
  check('B5 失败后状态复位 IDLE（可重试）', ctx.data.status === 'IDLE', 'status=' + ctx.data.status)

  // B6 行为级：模拟英文 JS 异常 message（"paginate is not a function"）→ errText 拦成中文兜底
  const ctx2 = makeCtx(consultationDef)
  ctx2._gone = false
  consultationDef._onAiFail.call(ctx2, { code: '', message: 'paginate is not a function' })
  const bubble2 = ctx2.data.messages[ctx2.data.messages.length - 1].content
  const asciiLeak = /paginate|is not a function/i.test(bubble2)
  check('B6 纯英文 JS 异常不外泄（errText 兜底）', !asciiLeak, '气泡=' + bubble2)

  redGreen.push({ id: 'P1-04', green: /require\(['"][^'"]*err-text\.js['"]\)/.test(src) && /errText\s*\(/.test(body) && !hasEnglishCode && !asciiLeak })
}

/* ==================== C. 边界 / 篡改 / 硬编码状态辅助 ==================== */
section('C. 边界与篡改辅助断言')
{
  // C1 home._route('triage', text) 深链编码
  navCalls.length = 0
  const homeCtx = makeCtx(homeDef)
  homeDef._route.call(homeCtx, 'triage', '头疼<>&症状 测试')
  const triageNav = navCalls.filter((n) => n.url.indexOf('/pages/triage/triage') === 0).pop()
  check('C1 triage 深链带 text 参数', !!triageNav && /\?text=/.test(triageNav.url), triageNav && triageNav.url)
  check('C1b text 经 encodeURIComponent（裸 <>& 不出现在 URL）',
    !!triageNav && !/[<>& ]/.test(triageNav.url), triageNav && triageNav.url)

  // C2 triage send：THINKING 状态拒绝再发（防重复提交）
  const triCtx = makeCtx(triageDef)
  triCtx._remoteAllowed = true
  triCtx.data.status = 'THINKING'
  const before = triCtx.data.messages.length
  triageDef.send.call(triCtx, '继续说症状')
  check('C2 THINKING 时 send 被拒（不追加消息）', triCtx.data.messages.length === before)

  // C3 appointment goConfirm 未选号源 → toast 拦截
  toastCalls.length = 0
  const aptCtx = makeCtx(appointmentDef)
  aptCtx.data.selDate = '2026-10-30'
  aptCtx.data.selSlotId = ''
  appointmentDef.goConfirm.call(aptCtx)
  check('C3 goConfirm 缺 slotId 给中文 toast 拦截', toastCalls.some((t) => /请选择日期和时间/.test(t)), JSON.stringify(toastCalls))

  // C4 appointment onSubmit submitting 防重复
  const aptCtx2 = makeCtx(appointmentDef)
  aptCtx2.data.submitting = true
  aptCtx2.data.selSlotId = 's1'
  let submitted = false
  aptCtx2.data.patient = { name: '张三' }
  // submit 走 service，这里只验证 submitting=true 时直接 return 不进入提交逻辑：
  // 用桩替换 submitAppointment 不可行（service 已加载），改为静态验证守卫存在
  const aptSrc = readSrc('pages/appointment/appointment.js')
  check('C4 onSubmit 开头有 submitting 守卫', /onSubmit\(\)\s*\{\s*if\s*\(this\.data\.submitting\)\s*return/.test(aptSrc))
  check('C4b onSubmit 成功/失败后 submitting 复位', (aptSrc.match(/submitting:\s*false/g) || []).length >= 2)

  // C5 voiceReadEnabled：storage 篡改观察项（字符串 'false' 是真值 → !!'false'=true）
  const speechSrc = readSrc('services/speech.js')
  storage['wb_voice_read'] = 'false' // 篡改：字符串 false
  const voiceService = require('../miniprogram/services/speech.js')
  const v = voiceService.voiceReadEnabled()
  check('C5[观察项] wb_voice_read="false"(字符串) 被当作 true 播报', v === true, 'voiceReadEnabled=' + v)
  storage['wb_voice_read'] = false // 正常布尔值
  check('C5b wb_voice_read=false(布尔) 正确关闭播报', voiceService.voiceReadEnabled() === false)

  // C6 wb_theme 白名单（静态）：app.js 读取后是否校验档位
  const appSrc = readSrc('app.js')
  const themeLine = appSrc.split('\n').findIndex((l) => l.indexOf("getStorageSync('wb_theme')") >= 0) + 1
  const themeSnippet = appSrc.split('\n').slice(Math.max(0, themeLine - 1), themeLine + 3).join(' ')
  check('C6[观察项] wb_theme 读取无档位白名单校验（非法档静默落到未定义 theme 类）',
    !/(standard|large|xlarge)[^\n]*\b(includes|indexOf)\b/.test(themeSnippet), themeSnippet.trim())

  // C7 D-B-P2-03 已修：进度卡分支按契约英文枚举，不再比对 aptStatusText 的中文展示文案
  const consSrc = readSrc('pages/consultation/consultation.js')
  const triPageSrc = readSrc('pages/triage/triage.js')
  const cnBranch = /status === '待就诊'|status === '就诊中'|status === '已完成'/.test(consSrc) ||
    /status === '待就诊'|status === '就诊中'|status === '已完成'/.test(triPageSrc)
  const enumBranch = /raw === 'CONFIRMED'/.test(consSrc) && /raw === 'CONFIRMED'/.test(triPageSrc)
  check('C7 D-B-P2-03 进度卡按英文枚举分支（无中文文案耦合）', !cnBranch && enumBranch,
    '中文分支残留=' + cnBranch + ' 枚举分支=' + enumBranch)

  // C8 D-B-P2-02 已修：深链解码走 safeDecode / try-catch，畸形 % 序列不再白屏
  const consPageSrc = readSrc('pages/consult/consult.js')
  const bareConsultId = /activeId:\s*q\.consultationId\s*\?\s*decodeURIComponent\(/.test(consPageSrc)
  const safeHelper = /function safeDecode\(/.test(consPageSrc) && /activeId:\s*q\.consultationId\s*\?\s*decode\(q\.consultationId\)/.test(consPageSrc)
  check('C8 D-B-P2-02 consult.onLoad 深链解码有兜底（safeDecode，无裸 decodeURIComponent）',
    !bareConsultId && safeHelper, '裸调用=' + bareConsultId + ' 安全helper=' + safeHelper)
  const aptPageSrc = readSrc('pages/appointment/appointment.js')
  const aptGuarded = /try\s*\{\s*dept\s*=\s*decodeURIComponent\(options\.dept\)\s*\}\s*catch/.test(aptPageSrc)
  check('C8b D-B-P2-02 appointment.onLoad options.dept 解码有 try/catch 兜底', aptGuarded,
    '兜底=' + aptGuarded)
}

/* ==================== D. 对比度量化（打印表） ==================== */
section('D. WCAG 对比度量化（static 推算，375px 档）')
function lin(c) {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
function L(hex) {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function ratio(fg, bg) {
  const l1 = L(fg), l2 = L(bg)
  return ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05))
}
const pairs = [
  ['正文 --text-main #14264C / 白卡', '#14264C', '#FFFFFF'],
  ['正文 #14264C / 页面底 #F3F8FF', '#14264C', '#F3F8FF'],
  ['次文本 --text-sub #5064A0 / 白卡', '#5064A0', '#FFFFFF'],
  ['弱文本 --text-weak #828CA0 / 白卡', '#828CA0', '#FFFFFF'],
  ['占位 --text-placeholder #B0BEC5 / 白卡', '#B0BEC5', '#FFFFFF'],
  ['白字 / 主蓝 #0B6EF8 按钮', '#FFFFFF', '#0B6EF8'],
  ['薄荷标签字 #178F6B / 薄荷浅底 #E0F7F0', '#178F6B', '#E0F7F0'],
  ['橙字 #CC6600 / 橙浅底 #FFF4E5', '#CC6600', '#FFF4E5']
]
const results = []
pairs.forEach(([name, fg, bg]) => {
  const r = ratio(fg, bg)
  results.push({ name, ratio: r.toFixed(2) })
  console.log('  ' + r.toFixed(2) + ':1  ' + name)
})
// 断言级：关键路径必须达标（正文 4.5）
check('D1 正文 #14264C/白卡 ≥4.5', ratio('#14264C', '#FFFFFF') >= 4.5)
check('D2 次文本 #5064A0/白卡 ≥4.5', ratio('#5064A0', '#FFFFFF') >= 4.5)
check('D3[观察项] 弱文本 #828CA0/白卡 <4.5（正文不达）', ratio('#828CA0', '#FFFFFF') < 4.5)
check('D4[观察项] 占位 #B0BEC5/白卡 <3.0（提示字偏弱）', ratio('#B0BEC5', '#FFFFFF') < 3.0)
check('D5 白字/主蓝按钮 ≥4.5', ratio('#FFFFFF', '#0B6EF8') >= 4.5)

/* ==================== 汇总 ==================== */
console.log('\n==================== 汇总 ====================')
redGreen.forEach((r) => console.log((r.green ? 'GREEN' : 'RED ') + '  ' + r.id + (r.green ? '（第一轮红已闭环）' : '（仍红，待修复）')))
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (failures.length) {
  console.log('\n失败/观察项明细：')
  failures.forEach((f) => console.log('  - ' + f))
}
process.exit(fail ? 1 : 0)
