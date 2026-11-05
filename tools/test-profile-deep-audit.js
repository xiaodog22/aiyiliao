/**
 * tools/test-profile-deep-audit.js —— 分片 C 第二轮「详细版」：P1 修复验证断言 + 边界补钉
 *
 * 打桩 wx / getApp / Page / storage / request，真实 require 页面与服务模块，钉死：
 *
 * 【断言①】voice 设默认成功链（voice-settings.onSetDefault → _apply → voice.save）
 *          必须向 VOICE_DEFAULT 端点发出请求（第一轮红：0 个网络请求）。
 *          注：当前契约 canonical 方法 = PUT（business-openapi.yaml /voice/voices/default put），
 *          POST 仅 legacy 兼容（yaml 同路径 post deprecated:true）。
 * 【断言②】远端音色（不在本地 CATALOG 4 条内）经 catalogRemote() 后可被设默认
 *          （第一轮红：NOT_FOUND 拒绝）。
 * 【断言③】settings.onClearCache 恢复清单必须保留 wb_voice / wb_voice_rate（P2-11）。
 * 【附加】WCAG 对比度量化（--text-weak / --text-sub 白卡上）；family / personal-info 表单边界
 *
 * 运行：node tools/test-profile-deep-audit.js
 */
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
let PASS = 0
let FAIL = 0
const fails = []

function check(name, ok, extra) {
  if (ok) { PASS++; return }
  FAIL++
  fails.push(name + (extra ? '  ← ' + extra : ''))
}

// ==================== 桩：storage / wx.request ====================
const storage = {}
const requestLog = []          // url
const requestMethods = []      // 与 requestLog 同下标的 method（大写）
const toastLog = []            // wx.showToast 标题流水（表单错误通道：本批页面用 toast 报错，不用 data.err）

function resetStorage() { Object.keys(storage).forEach((k) => delete storage[k]) }

global.wx = {
  getStorageSync(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : '' },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  clearStorageSync() { Object.keys(storage).forEach((k) => delete storage[k]) },
  request(o) {
    requestLog.push(String(o.url || ''))
    requestMethods.push(String(o.method || 'GET').toUpperCase())
    setTimeout(() => {
      const url = String(o.url || '')
      const u = url.replace(/^https?:\/\/[^/]+/, '')   // 剥掉网关前缀（request.js 会把 gateway+path 拼全）
      if (u === '/api/v1/voice/voices/default') {                // PUT 设默认（先于 /voices 精确分支）
        o.success({ statusCode: 200, data: { code: 'OK', data: { voiceId: (o.data && o.data.voiceId) || '', rate: (o.data && o.data.rate) || 1, synced: true } } })
      } else if (/\/api\/v1\/voice\/voices\/[^/]+\/previews$/.test(u)) {
        o.success({ statusCode: 200, data: { code: 'OK', data: { audioUrl: '' } } })
      } else if (/\/api\/v1\/voice\/voices\/[^/]+$/.test(u)) {    // DELETE 自定义音色
        o.success({ statusCode: 200, data: { code: 'OK', data: {} } })
      } else if (u === '/api/v1/voice/voices') {                  // GET 远端目录（request.js 已解包 → 直接给数组）
        o.success({ statusCode: 200, data: { code: 'OK', data: REMOTE_ROWS } })
      } else if (u === '/api/v1/family-members') {
        o.success({ statusCode: 200, data: { code: 'OK', data: { items: [] } } })
      } else if (/\/api\/v1\/me\/extended/.test(u)) {
        o.success({ statusCode: 200, data: { code: 'OK', data: {} } })
      } else if (u === '/api/v1/me/archive') {
        o.success({ statusCode: 200, data: { code: 'OK', data: { id: 'a1', ageBand: 'SENIOR', gender: 'FEMALE', chronic: ['高血压'], allergies: [] } } })
      } else if (/\/api\/v1\/me/.test(u)) {
        o.success({ statusCode: 200, data: { code: 'OK', data: { id: 'u1', displayName: '陈阿姨', avatarUrl: '', phoneBound: true, roles: ['PATIENT'], profileCompleted: true } } })
      } else {
        o.success({ statusCode: 200, data: { code: 'OK', data: {} } })
      }
    }, 0)
  },
  showModal(o) { if (o && o.success) o.success({ confirm: true, cancel: false }) },
  showToast(o) { toastLog.push(String((o && o.title) || '')) }, showLoading() {}, hideLoading() {},
  navigateTo() {}, reLaunch() {}, switchTab() {}, navigateBack() {},
  stopPullDownRefresh() {}, getWindowInfo() { return { statusBarHeight: 20 } },
  createInnerAudioContext() { return { src: '', play() {}, pause() {}, stop() {}, onCanplay() {}, onEnded() {}, onError() {} } }
}

// 远端目录：1 条云端音色（id=remote_yunv，不在本地 CATALOG 4 条内）。
// 形状按契约 voice.js:142-148 消费：{id, displayName, locale, gender, isCustom, available}
const REMOTE_ROWS = [
  { id: 'remote_yunv', displayName: '云端女声', locale: '普通话', gender: 'FEMALE', isCustom: false, available: true }
]

// 注入内存会话 token（否则受保护请求在 requireSession() 即被本地拦截，发不出 wx.request）
require(path.join(ROOT, 'services', 'session.js'))
  .setTokens({ accessToken: 'at-test', refreshToken: 'rt-seed', expiresIn: 3600 })

// ==================== 桩：页面注册 / App ====================
function loadPage(rel) {
  let cfg = null
  global.Page = (c) => { cfg = c }
  const abs = path.join(ROOT, rel)
  delete require.cache[require.resolve(abs)]
  require(abs)
  if (!cfg) throw new Error('未捕获到 Page 配置：' + rel)
  return cfg
}

function instantiate(cfg) {
  const inst = Object.assign({}, cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}))
  inst.setData = (patch, cb) => {
    Object.keys(patch).forEach((k) => {
      const mm = /^([\w$]+)\.([\w$]+)$/.exec(k)
      const mb = /^([\w$]+)\[(\d+)\]$/.exec(k)
      if (mm) { inst.data[mm[1]] = inst.data[mm[1]] || {}; inst.data[mm[1]][mm[2]] = patch[k] }
      else if (mb) { inst.data[mb[1]] = inst.data[mb[1]] || []; inst.data[mb[1]][Number(mb[2])] = patch[k] }
      else inst.data[k] = patch[k]
    })
    if (typeof cb === 'function') cb()
  }
  return inst
}

function settle(inst, pred, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (pred(inst.data) || Date.now() - t0 > (ms || 600)) resolve()
      else setTimeout(tick, 5)
    }
    tick()
  })
}

const tick5 = () => new Promise((r) => setTimeout(r, 5))

// ==================== 【断言①】onSetDefault → voice.save → VOICE_DEFAULT 请求 ====================
async function testAssertion1_PageOnSetDefault() {
  resetStorage()
  storage.wb_voice = 'preset_gentle'
  storage.wb_voice_rate = 1.0
  storage.wb_voice_hidden = []
  requestLog.length = 0; requestMethods.length = 0

  global.getApp = () => ({
    globalData: { role: 'patient', theme: 'standard', user: { displayName: '陈阿姨' } },
    MOCK: undefined, setTheme() {}, logout() {}
  })
  const cfg = loadPage(path.join('pages', 'profile', 'voice-settings', 'voice-settings.js'))
  const inst = instantiate(cfg)
  inst.onLoad({})
  await settle(inst, (d) => d.rows && d.rows.length > 0, 800)
  check('[断言①前置] voice-settings 目录已渲染（rows>0）', inst.data.rows.length > 0, '实得 rows=' + inst.data.rows.length)
  check('[断言①前置] 当前生效音色 = preset_gentle（本地记忆）', inst.data.current === 'preset_gentle', '实得 ' + inst.data.current)

  // 页面动作：点「设默认」（本地目录音色 preset_pro）
  const before = requestLog.length
  inst.onSetDefault({ currentTarget: { dataset: { id: 'preset_pro' } } })
  await tick5()
  await tick5()

  const hits = requestLog.slice(before).filter((u) => u.indexOf('/api/v1/voice/voices/default') >= 0)
  check('[断言①] onSetDefault→voice.save 成功链对 VOICE_DEFAULT 端点发起请求',
    hits.length === 1, '本轮请求=' + JSON.stringify(requestLog.slice(before)))
  if (hits.length === 1) {
    const m = requestMethods[requestLog.indexOf(hits[0])]
    check('[断言①] 实际请求方法=' + m + '（契约 canonical=PUT；POST 仅 legacy）',
      m === 'PUT' || m === 'POST', '实得 ' + m)
  }
  check('[断言①] 设默认成功后本地 storage 同步', storage.wb_voice === 'preset_pro', '实得 ' + storage.wb_voice)
}

// ==================== 【断言②】远端音色（非本地 CATALOG 4 条）可设默认 ====================
async function testAssertion2_RemoteVoiceSetDefault() {
  resetStorage()
  storage.wb_voice = 'preset_gentle'
  storage.wb_voice_rate = 1.0
  storage.wb_voice_hidden = []
  requestLog.length = 0; requestMethods.length = 0
  const abs = path.join(ROOT, 'services', 'voice.js')
  delete require.cache[require.resolve(abs)]
  const voice = require(abs)

  // 前置：远端 id 确实不在本地 CATALOG
  const localIds = voice.catalog().rows.map((r) => r.id)
  check('[断言②前置] remote_yunv ∉ 本地 CATALOG（本地=' + localIds.join(',') + '）',
    localIds.indexOf('remote_yunv') < 0, '实得 ' + localIds.join(','))

  // 先 catalogRemote()（页面 onLoad 必走），让远端行进 _remoteRows 白名单
  const remoteCat = await voice.catalogRemote()
  check('[断言②前置] catalogRemote() 拉到远端行 remote_yunv（source=' + (remoteCat && remoteCat.source) + '）',
    remoteCat.rows.some((r) => r.id === 'remote_yunv'), '实得 ' + JSON.stringify(remoteCat.rows.map((r) => r.id)))

  // 直接对未登记的远端 id 调 save（模拟目录拉取前的旧行为）：应被拒 NOT_FOUND
  let rejected = null
  try { await voice.save({ voiceId: 'ghost_id' }) } catch (e) { rejected = e }
  check('[断言②旁证] 未登记音色仍拒绝 NOT_FOUND（校验未被放宽成任意 id）',
    rejected && rejected.code === 'NOT_FOUND', '实得 ' + (rejected && rejected.code))

  // 核心：远端音色设默认 —— 第一轮现状=NOT_FOUND 拒绝
  let saved = null, saveErr = null
  try { saved = await voice.save({ voiceId: 'remote_yunv', rate: 1.1 }) } catch (e) { saveErr = e }
  check('[断言②] 远端音色 remote_yunv 可设默认（resolve）',
    !!saved && !saveErr, '实得 err=' + (saveErr && (saveErr.code || saveErr.message)))
  if (saved) {
    check('[断言②] 远端音色落本地 storage wb_voice', storage.wb_voice === 'remote_yunv', '实得 ' + storage.wb_voice)
    const hits = requestLog.filter((u) => u.indexOf('/api/v1/voice/voices/default') >= 0)
    check('[断言②] 远端音色设默认同样同步 VOICE_DEFAULT 端点', hits.length >= 1, '实得 ' + JSON.stringify(requestLog))
  }
}

// ==================== 【断言③】onClearCache 恢复清单含 wb_voice/wb_voice_rate ====================
async function testAssertion3_ClearCacheKeepsVoice() {
  resetStorage()
  storage.wb_role = 'patient'
  storage.wb_user = { displayName: '陈阿姨' }
  storage.wb_login_at = 1730000000000
  storage.wb_theme = 'large'
  storage.wb_high_contrast = true
  storage.wb_voice = 'preset_pro'
  storage.wb_voice_rate = 1.25
  storage.wb_voice_read = true
  storage.wb_refresh_token = 'rt-token'
  storage.wb_refresh_expires_at = 2000000000000
  storage.wb_junk = 'junk'

  global.getApp = () => ({
    globalData: { role: 'patient', theme: 'large', user: { displayName: '陈阿姨' } },
    setTheme() {}, logout() {}
  })
  const cfg = loadPage(path.join('pages', 'profile', 'settings', 'settings.js'))
  const inst = instantiate(cfg)
  inst.onLoad()
  await tick5()
  inst.onClearCache()
  await tick5()

  check('[断言③] 清缓存后 wb_voice 保留（P2-11）', storage.wb_voice === 'preset_pro', '实得 ' + JSON.stringify(storage.wb_voice))
  check('[断言③] 清缓存后 wb_voice_rate 保留（P2-11）',
    Math.abs(Number(storage.wb_voice_rate) - 1.25) < 0.001, '实得 ' + JSON.stringify(storage.wb_voice_rate))
  check('[断言③] 会话/主题/高对比/语音播报等其余保留键同步保留',
    storage.wb_role === 'patient' && storage.wb_theme === 'large' &&
    storage.wb_high_contrast === true && storage.wb_voice_read === true &&
    storage.wb_refresh_token === 'rt-token',
    JSON.stringify({ role: storage.wb_role, theme: storage.wb_theme, hc: storage.wb_high_contrast, vr: storage.wb_voice_read }))
  check('[断言③] 无关缓存确实被清除', storage.wb_junk === undefined)
}

// ==================== 【附加A】WCAG 对比度量化 ====================
function srgbLin(c) {
  c /= 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  return 0.2126 * srgbLin(r) + 0.7152 * srgbLin(g) + 0.0722 * srgbLin(b)
}
function contrast(fg, bg) {
  const l1 = luminance(fg), l2 = luminance(bg)
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}
;(function testContrast() {
  const weak = contrast('#828CA0', '#FFFFFF')   // --text-weak 白卡说明/次行
  const sub = contrast('#5064A0', '#FFFFFF')     // --text-sub 次要文字
  const main = contrast('#14264C', '#FFFFFF')    // --text-main 标题正文
  const ph = contrast('#B0BEC5', '#FFFFFF')      // 输入框 placeholder
  console.log('  [对比度] --text-weak#828CA0/白 =', weak.toFixed(2) + ':1（正文阈值4.5）')
  console.log('  [对比度] --text-sub #5064A0/白 =', sub.toFixed(2) + ':1（正文阈值4.5）')
  console.log('  [对比度] --text-main#14264C/白 =', main.toFixed(2) + ':1（大字阈值3.0）')
  console.log('  [对比度] placeholder#B0BEC5/白 =', ph.toFixed(2) + ':1')
  check('[对比度] --text-sub 达正文 4.5:1', sub >= 4.5, '实得 ' + sub.toFixed(2))
  check('[对比度] --text-main 达标', main >= 7.0, '实得 ' + main.toFixed(2))
  check('[对比度] --text-weak <4.5:1（白卡 12px 次行偏小，登记观察项）', weak < 4.5, '实得 ' + weak.toFixed(2))
})()

// ==================== 【附加B】family / personal-info 表单边界（可执行） ====================
async function testFormBoundary() {
  resetStorage()
  global.getApp = () => ({
    globalData: { role: 'patient', theme: 'standard', user: { displayName: '陈阿姨' } },
    MOCK: undefined, setTheme() {}, logout() {}
  })
  // ---- family ----
  const fcfg = loadPage(path.join('pages', 'profile', 'family', 'family.js'))
  const fam = instantiate(fcfg)
  fam.onLoad({})
  await tick5()
  fam.onInputName({ detail: { value: '  ' } })
  fam.onSubmit()
  check('[family] 姓名纯空白被拒「请填写成员姓名」', fam.data.formErr === '请填写成员姓名', '实得 ' + fam.data.formErr)
  fam.onInputName({ detail: { value: '陈大伯' } })
  fam.onInputPhone({ detail: { value: '123' } })
  fam.onSubmit()
  check('[family] 手机号「123」被拒格式提示', /^手机号格式不正确/.test(fam.data.formErr || ''), '实得 ' + fam.data.formErr)
  fam.onInputPhone({ detail: { value: '' } })
  fam.onSubmit()
  check('[family] 未选关系被拒「请选择与本人的关系」', fam.data.formErr === '请选择与本人的关系', '实得 ' + fam.data.formErr)
  fam.onPickRelation({ currentTarget: { dataset: { rel: 'FATHER' } } })
  fam.onSubmit()
  await tick5(); await tick5()
  check('[family] 合法提交后 saving 复位且发了 POST /family-members',
    fam.data.saving === false && (function () {
      const i = requestLog.findIndex((u) => u.indexOf('/api/v1/family-members') >= 0)
      return i >= 0 && requestMethods[i] === 'POST'
    })(),
    JSON.stringify(requestLog.slice(-3)))

  // ---- personal-info 边界（错误走 wx.showToast 通道） ----
  const pcfg = loadPage(path.join('pages', 'profile', 'personal-info', 'personal-info.js'))
  const pi = instantiate(pcfg)
  toastLog.length = 0
  pi.onEmailInput({ detail: { value: 'bad-email' } })
  pi.saveContact()
  check('[personal-info] 邮箱 bad-email → toast「邮箱格式不正确」',
    toastLog.indexOf('邮箱格式不正确') >= 0, '实得 ' + JSON.stringify(toastLog))
  check('[personal-info] 邮箱非法时不发 PUT /me/extended',
    !requestLog.some((u) => u.indexOf('/api/v1/me/extended') >= 0), '实得 ' + JSON.stringify(requestLog.filter((u) => u.indexOf('extended') >= 0)))
  pi.onEmailInput({ detail: { value: 'a@b.com' } })
  toastLog.length = 0
  pi.saveContact()
  await tick5()
  check('[personal-info] 合法邮箱通过校验并发了请求',
    (function () {
      const i = requestLog.findIndex((u) => u.indexOf('/api/v1/me/extended') >= 0)
      return i >= 0 && requestMethods[i] === 'PUT'
    })(),
    JSON.stringify(requestLog.slice(-3)))

  toastLog.length = 0
  pi.onIdNameInput({ detail: { value: '陈阿姨' } })
  pi.onIdNumberInput({ detail: { value: '12345' } })
  pi.submitIdentity()
  check('[personal-info] 身份证 5 位 → toast「身份证号须为 18 位」',
    toastLog.indexOf('身份证号须为 18 位') >= 0, '实得 ' + JSON.stringify(toastLog))
  pi.onIdNumberInput({ detail: { value: '11010119900307775X' } })
  toastLog.length = 0
  pi.submitIdentity()
  await tick5()
  check('[personal-info] 18 位身份证（尾 X）通过格式校验（无 18 位 toast）',
    toastLog.indexOf('身份证号须为 18 位') < 0, '实得 ' + JSON.stringify(toastLog))
}

// ==================== 运行 ====================
;(async () => {
  try {
    await testAssertion1_PageOnSetDefault()
    await testAssertion2_RemoteVoiceSetDefault()
    await testAssertion3_ClearCacheKeepsVoice()
    await testFormBoundary()
  } catch (e) {
    FAIL++
    fails.push('运行时异常：' + (e && e.stack || e))
  }
  console.log('PASS=' + PASS + ' FAIL=' + FAIL)
  if (fails.length) {
    console.log('--- 失败明细 ---')
    fails.forEach((f) => console.log('✗ ' + f))
    process.exit(1)
  }
  console.log('RESULT: PROFILE_DEEP_AUDIT_OK')
})()
