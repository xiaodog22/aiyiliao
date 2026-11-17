/**
 * tools/test-profile-pages-audit.js —— 分片 C（个人中心 10 页）离线单测
 *
 * 打桩 wx / getApp / Page / storage / request，真实 require 页面与服务模块，钉死：
 *   ① apt-status 7 态映射（页面禁止回退写死中文判断）
 *   ② records 分页（对象导出 paginate）+ 触底追加 + 分段筛选 + 错误态中文文案
 *   ③ settings.onClearCache 保留键：wb_role / wb_user / wb_login_at / wb_theme /
 *      wb_high_contrast / wb_voice_read / refresh 令牌（72h 会话不被误清）
 *   ④ voice 设默认链路现状（voice.save 纯本地 storage；服务端持久化缺口已登记 P1，
 *      此处钉住现状——若未来接了 POST /voices/default，本用例会失败，提醒同步更新）
 *   ⑤ user 服务契约字段：resolveAvatar 空值默认头像、列表 {list}/{items} 包裹解包
 *
 * 运行：node tools/test-profile-pages-audit.js
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

// ==================== 桩：storage / wx ====================
const storage = {}
let MODE = 'ok'                 // ok | http500
const requestLog = []            // 记录所有经过 wx.request 的 URL（voice 契约断言用）
const requestMethods = []        // 与 requestLog 同下标的 method（断言 PUT/GET 用）

function resetStorage() {
  Object.keys(storage).forEach((k) => delete storage[k])
}

global.wx = {
  getStorageSync(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : '' },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  clearStorageSync() { Object.keys(storage).forEach((k) => delete storage[k]) },
  request(o) {
    requestLog.push(String(o.url || ''))
    requestMethods.push(String(o.method || 'GET').toUpperCase())
    setTimeout(() => {
      if (MODE === 'http500') {
        o.success({ statusCode: 500, data: { message: 'Internal Server Error' } })
        return
      }
      const url = String(o.url || '')
      if (url.indexOf('/api/v1/me/extended') >= 0) {
        o.success({ statusCode: 200, data: { code: 'OK', data: { email: 'a@b.com', residence: '广州' } } })
      } else if (url.indexOf('/api/v1/me') >= 0) {
        o.success({ statusCode: 200, data: { code: 'OK', data: { id: 'u1', displayName: '陈阿姨', avatarUrl: '/api/v1/avatars/a.png', phoneBound: true, roles: ['PATIENT'] } } })
      } else if (url.indexOf('/api/v1/health-records') >= 0) {
        o.success({ statusCode: 200, data: { code: 'OK', data: [{ id: 'hr1' }] } })
      } else if (url.indexOf('/api/v1/consultations') >= 0) {
        o.success({ statusCode: 200, data: { code: 'OK', data: [{ id: 'c1', status: 'ACTIVE' }] } })
      } else if (url.indexOf('/api/v1/family-members') >= 0) {
        o.success({ statusCode: 200, data: { code: 'OK', data: { items: [{ id: 'f1', displayName: '陈大伯', relation: 'FATHER' }] } } })
      } else if (url.indexOf('/api/v1/appointments/me') >= 0) {
        o.success({ statusCode: 200, data: { code: 'OK', data: CONTRACT_APPOINTMENTS } })
      } else if (url.indexOf('/api/v1/voice/voices/default') >= 0) {
        o.success({ statusCode: 200, data: { code: 'OK', data: { voiceId: (o.data && o.data.voiceId) || '', rate: (o.data && o.data.rate) || 1 } } })
      } else if (url.indexOf('/api/v1/voice/voices') >= 0) {
        o.success({ statusCode: 200, data: { code: 'OK', data: REMOTE_VOICES } })
      } else {
        o.success({ statusCode: 200, data: { code: 'OK', data: [] } })
      }
    }, 0)
  },
  showModal(o) { if (o && o.success) o.success({ confirm: true, cancel: false }) },
  showToast() {}, showLoading() {}, hideLoading() {},
  navigateTo() {}, reLaunch() {}, switchTab() {}, navigateBack() {}, openSetting() {},
  stopPullDownRefresh() {}, getAccountInfoSync() { throw new Error('stub: 无') },
  getWindowInfo() { return { statusBarHeight: 20 } }
}

// 注入内存会话：access token 只驻留 session.js 内存；不注入则受保护请求
// 在 requireSession() 阶段即被本地拦成 AUTH_REQUIRED，根本发不出 wx.request。
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
      if (pred(inst.data) || Date.now() - t0 > (ms || 400)) resolve()
      else setTimeout(tick, 5)
    }
    tick()
  })
}

const tick5 = () => new Promise((r) => setTimeout(r, 5))

// 45 条契约预约：20 PENDING + 15 CONFIRMED + 5 COMPLETED + 5 CANCELLED
// ⚠️ PENDING/CONFIRMED 必须**恒在未来**：aptDisplayStatus 会把「未终态且时段已过」纠正为
// 「已过期」并入已完成段（2026-11-15 口径），写死日期的夹具下午/隔天跑必红。
function futIso() {
  const d = new Date()
  d.setHours(9, 30, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
  return d.toISOString()
}
const CONTRACT_APPOINTMENTS = []
;[['PENDING', 20], ['CONFIRMED', 15], ['COMPLETED', 5], ['CANCELLED', 5]].forEach(([st, n]) => {
  for (let i = 0; i < n; i++) CONTRACT_APPOINTMENTS.push({
    id: 'apt-' + st + '-' + i,
    status: st,
    departmentName: '心血管内科',
    doctorName: '张医生',
    startTime: (st === 'PENDING' || st === 'CONFIRMED') ? futIso() : '2026-10-29T01:30:00Z',
    location: '门诊楼 3 楼'
  })
})

// 远端音色目录（GET /api/v1/voice/voices）= 后端内置两项（qwen3-*，与 application.yml 一致）+ 一条自定义。
// locale/gender 用后端原值（zh-CN/female），钉住前端必须本地化成「普通话 · 女声」。
const REMOTE_VOICES = [
  { id: 'qwen3-female-1', displayName: '温柔女声', locale: 'zh-CN', gender: 'female', isCustom: false, available: true },
  { id: 'qwen3-male-1', displayName: '沉稳男声', locale: 'zh-CN', gender: 'male', isCustom: false, available: true },
  { id: 'custom-1', displayName: '我的音色', locale: 'zh-CN', gender: 'female', isCustom: true, available: true }
]

// ==================== ① apt-status 7 态映射 ====================
;(function testAptStatus() {
  const { aptStatusText } = require(path.join(ROOT, 'utils', 'apt-status.js'))
  check('apt-status: PENDING → 待确认', aptStatusText('PENDING') === '待确认')
  check('apt-status: CONFIRMED → 待就诊', aptStatusText('CONFIRMED') === '待就诊')
  check('apt-status: CHECKED_IN → 就诊中', aptStatusText('CHECKED_IN') === '就诊中')
  check('apt-status: COMPLETED → 已完成', aptStatusText('COMPLETED') === '已完成')
  check('apt-status: CANCELLED → 已取消', aptStatusText('CANCELLED') === '已取消')
  check('apt-status: EXPIRED → 已过期', aptStatusText('EXPIRED') === '已过期')
  check('apt-status: NO_SHOW → 未到诊', aptStatusText('NO_SHOW') === '未到诊')
  check('apt-status: 小写输入容忍', aptStatusText('confirmed') === '待就诊')
  check('apt-status: 未知枚举原样透传（不吞不猜）', aptStatusText('WEIRD') === 'WEIRD')
  check('apt-status: null 安全', aptStatusText(null) === '')
})()

// ==================== ② user 服务契约字段 ====================
;(function testUserService() {
  const userService = require(path.join(ROOT, 'services', 'user.js'))
  check('resolveAvatar: 空值返回包内默认头像',
    userService.resolveAvatar('') === '/assets/img/avatar-default.png',
    '实得 ' + userService.resolveAvatar(''))
  const ENV = require(path.join(ROOT, 'config', 'env.js'))
  check('resolveAvatar: 站内相对路径拼网关',
    userService.resolveAvatar('/api/v1/avatars/a.png') === ENV.gateway + '/api/v1/avatars/a.png')
  check('resolveAvatar: 绝对 URL 原样',
    userService.resolveAvatar('https://cdn.example.com/a.png') === 'https://cdn.example.com/a.png')
})()

// ==================== ③ records 分页 / 触底 / 状态中文 / 错误态 ====================
async function testRecords() {
  global.getApp = () => ({
    globalData: { role: 'patient', theme: 'standard', user: { displayName: '陈阿姨', avatarUrl: '/api/v1/avatars/a.png' } },
    MOCK: undefined,
    logout() {}
  })
  const cfg = loadPage(path.join('pages', 'profile', 'records', 'records.js'))
  MODE = 'ok'
  const inst = instantiate(cfg)
  inst.onLoad()
  await settle(inst, (d) => d.loading === false)

  check('[records] all 拿到 45 条契约数据', inst.data.all.length === 45, '实得 ' + inst.data.all.length)
  check('[records] 首屏只渲染 20 条', inst.data.displayed.length === 20, '实得 ' + inst.data.displayed.length)
  check('[records] hasMore=true', inst.data.hasMore === true)
  check('[records] PENDING 经 apt-status 转中文（页面未写死判断）',
    inst.data.all[0].status === '待确认', '实得 ' + inst.data.all[0].status)
  // 2026-11-15 口径：isHistory 把「已完成/过期/取消/未到」都并入历史段 →
  // 夹具 5 COMPLETED + 5 CANCELLED = done=10，active = 20 PENDING + 15 CONFIRMED = 35
  check('[records] 计数：active=35 / done=10',
    inst.data.counts.active === 35 && inst.data.counts.done === 10,
    JSON.stringify(inst.data.counts))

  inst.onReachBottom()
  check('[records] 触底后渲染 40 条', inst.data.displayed.length === 40, '实得 ' + inst.data.displayed.length)
  inst.onReachBottom()
  check('[records] 再次触底渲染 45 条', inst.data.displayed.length === 45, '实得 ' + inst.data.displayed.length)
  check('[records] 到末尾 hasMore=false', inst.data.hasMore === false)
  inst.onReachBottom()
  check('[records] hasMore=false 时触底幂等', inst.data.displayed.length === 45)

  inst.onSeg({ currentTarget: { dataset: { f: '已完成' } } })
  check('[records] 分段「已完成」筛出 10 条（含取消）且 hasMore=false',
    inst.data.displayed.length === 10 && inst.data.hasMore === false,
    '实得 ' + inst.data.displayed.length)
  inst.onSeg({ currentTarget: { dataset: { f: '待就诊' } } })
  check('[records] 分段「待就诊」total=35（首屏切片 20）',
    inst.data.total === 35 && inst.data.displayed.length === 20 && inst.data.hasMore === true,
    '实得 total=' + inst.data.total + ' displayed=' + inst.data.displayed.length)
  inst.onSeg({ currentTarget: { dataset: { f: '全部' } } })

  // 错误态：后端 500（MOCK_FALLBACK=true 档 app.MOCK 未注入 → mockFactory 抛错 → 走页面 catch）
  // ⚠️ /appointments/me 在 15s GET 缓存白名单内：成功轮的结果还在缓存里，不清掉 500 轮命中缓存。
  require(path.join(ROOT, 'services', 'request.js')).clearGetCache()
  MODE = 'http500'
  inst.fetch()
  await settle(inst, (d) => d.error !== '')
  check('[records] 错误态文案为纯中文（errText 未直出英文）',
    !!inst.data.error && /[\u4e00-\u9fa5]/.test(inst.data.error) && /^[\u4e00-\u9fa5，。、（）]/i.test(inst.data.error) &&
    !/^[\x00-\x7F]*$/.test(inst.data.error),
    '实得 ' + inst.data.error)
  MODE = 'ok'
}

// ==================== ④ settings.onClearCache 保留键 ====================
async function testSettingsClearCache() {
  resetStorage()
  storage.wb_role = 'patient'
  storage.wb_user = { name: '陈阿姨' }
  storage.wb_login_at = 1730000000000
  storage.wb_theme = 'large'
  storage.wb_high_contrast = true
  storage.wb_voice = 'qwen3-male-1'
  storage.wb_voice_rate = 1.2
  storage.wb_voice_read = true
  storage.wb_refresh_token = 'rt-token'
  storage.wb_refresh_expires_at = 2000000000000
  storage.wb_unrelated_cache = 'junk'

  global.getApp = () => ({
    globalData: { role: 'patient', theme: 'large', user: { name: '陈阿姨' } },
    setTheme() {}, logout() {}
  })
  const cfg = loadPage(path.join('pages', 'profile', 'settings', 'settings.js'))
  const inst = instantiate(cfg)
  inst.onLoad()
  await tick5()
  inst.onClearCache()

  check('[settings] 清缓存后 wb_role 保留', storage.wb_role === 'patient', JSON.stringify(storage.wb_role))
  check('[settings] 清缓存后 wb_user 保留', storage.wb_user && storage.wb_user.name === '陈阿姨')
  check('[settings] 清缓存后 wb_login_at 保留（72h 会话不被误清）',
    storage.wb_login_at === 1730000000000, '实得 ' + storage.wb_login_at)
  check('[settings] 清缓存后 wb_theme 保留', storage.wb_theme === 'large')
  check('[settings] 清缓存后 wb_high_contrast 保留', storage.wb_high_contrast === true)
  check('[settings] 清缓存后 wb_voice_read 保留', storage.wb_voice_read === true)
  check('[settings] 清缓存后 refresh 令牌快照恢复', storage.wb_refresh_token === 'rt-token')
  check('[settings] 无关缓存确被清除', storage.wb_unrelated_cache === undefined)
  // 修复后（P2-11）：音色偏好属于"用户设置"，清缓存后必须保留
  check('[settings] 清缓存后 wb_voice 保留（P2-11 已修）',
    storage.wb_voice === 'qwen3-male-1', '实得 ' + JSON.stringify(storage.wb_voice))
  check('[settings] 清缓存后 wb_voice_rate 保留（P2-11 已修）',
    Math.abs(Number(storage.wb_voice_rate) - 1.2) < 0.001, '实得 ' + JSON.stringify(storage.wb_voice_rate))
}

// ==================== ⑤ voice 目录口径 + 设默认链路 ====================
async function testVoiceService() {
  resetStorage()
  storage.wb_voice = 'qwen3-female-1'
  storage.wb_voice_rate = 1.0
  storage.wb_voice_hidden = []
  const voice = require(path.join(ROOT, 'services', 'voice.js'))

  const c = voice.catalog()
  check('[voice] 本地兜底目录 2 个音色（id 与后端内置一致）', c.rows.length === 2, '实得 ' + c.rows.length)
  check('[voice] 当前音色 = storage wb_voice', c.current === 'qwen3-female-1', '实得 ' + c.current)
  check('[voice] 本地目录不含方言音色',
    !c.rows.some((r) => (r.name + r.desc).indexOf('潮汕') >= 0), JSON.stringify(c.rows.map((r) => r.name)))

  // 自愈：当前音色 id 不在目录里 → 回落到第一个并重写记忆
  storage.wb_voice = 'ghost-voice'
  const c2 = voice.catalog()
  check('[voice] 悬空音色 id 自愈回落第一项', c2.current === 'qwen3-female-1', '实得 ' + c2.current)
  check('[voice] 自愈后 storage 重写', storage.wb_voice === 'qwen3-female-1', '实得 ' + storage.wb_voice)

  // 设默认：本地立即生效 + PUT 契约 /voices/default 持久化（P1-05 / P2-10）
  const res = await voice.save({ voiceId: 'qwen3-male-1', rate: 1.2 })
  check('[voice] save(qwen3-male-1) 落 storage wb_voice', storage.wb_voice === 'qwen3-male-1', '实得 ' + storage.wb_voice)
  check('[voice] save 返回 voiceId/rate', res.voiceId === 'qwen3-male-1' && Math.abs(res.rate - 1.2) < 0.001, JSON.stringify(res))
  check('[voice] save 云端同步成功标记 synced=true', res.synced === true, JSON.stringify(res))
  let rejectCode = ''
  try { await voice.save({ voiceId: 'nope' }) } catch (e) { rejectCode = e && e.code }
  check('[voice] 未知音色拒绝 code=NOT_FOUND', rejectCode === 'NOT_FOUND', '实得 ' + rejectCode)

  // 修复后：设默认必须打契约端点（方法=PUT，路径 /api/v1/voice/voices/default）
  const hits = requestLog.filter((u) => u.indexOf('/api/v1/voice/voices/default') >= 0)
  check('[voice] 设默认调用 PUT /api/v1/voice/voices/default（P1-05 已修）',
    hits.length === 1, '实得 ' + JSON.stringify(requestLog.filter((u) => u.indexOf('voices') >= 0)))
  check('[voice] 设默认使用 PUT 方法（POST 会 405）',
    requestMethods[hits.length ? requestLog.indexOf(hits[0]) : -1] === 'PUT',
    '实得 ' + JSON.stringify(requestMethods))

  // 试听走契约 /voices/{voiceId}/previews（P2-09）；桩无 audioUrl → 如实回落，不假装播放成功
  const played = await voice.preview('qwen3-male-1', {})
  const pv = requestLog.filter((u) => u.indexOf('/previews') >= 0)
  check('[voice] 试听调用 POST /voices/{voiceId}/previews（P2-09 已修）',
    pv.length === 1 && pv[0].indexOf('/voices/qwen3-male-1/previews') >= 0,
    '实得 ' + JSON.stringify(requestLog.filter((u) => u.indexOf('voices') >= 0)))
  check('[voice] 试听无音频地址时不假装播放成功', played === false, '实得 ' + played)

  // 回归锁（2026-11-17，本 bug 直接成因）：远端目录拉到之后，catalog() 必须与远端同口径。
  // 若再写回「本地 ∪ 远端」，页面点「保存」触发 _refresh() 时列表会从 2 项膨胀成 6 项。
  const rc = await voice.catalogRemote()
  check('[voice] 远端目录 source=remote', rc.source === 'remote', '实得 ' + rc.source)
  check('[voice] 远端 desc 中文化（zh-CN/female → 普通话 · 女声）',
    rc.rows.length > 0 && rc.rows[0].desc === '普通话 · 女声', '实得 ' + JSON.stringify(rc.rows.map((r) => r.desc)))
  const afterRemote = voice.catalog()
  check('[voice] 远端成功后目录 = 远端 3 项（保存/刷新不膨胀）',
    afterRemote.rows.length === 3, '实得 ' + afterRemote.rows.length + ' → ' + JSON.stringify(afterRemote.rows.map((r) => r.id)))
  check('[voice] 远端成功后目录仍无方言音色',
    !afterRemote.rows.some((r) => (r.name + r.desc).indexOf('潮汕') >= 0), JSON.stringify(afterRemote.rows.map((r) => r.name)))
}

// ==================== ⑥ profile 我的页数据链路 ====================
async function testProfile() {
  resetStorage()
  storage.wb_role = 'patient'
  storage.wb_user = { displayName: '陈阿姨', avatarUrl: '/api/v1/avatars/a.png' }
  global.getApp = () => ({
    globalData: { role: 'patient', theme: 'standard', user: { displayName: '陈阿姨', avatarUrl: '/api/v1/avatars/a.png' } },
    MOCK: undefined,
    logout() {}
  })
  const cfg = loadPage(path.join('pages', 'profile', 'profile.js'))
  const inst = instantiate(cfg)
  inst.onShow()
  await settle(inst, (d) => d.archiveSynced === true, 500)

  check('[profile] 姓名取契约 displayName', inst.data.user.name === '陈阿姨', '实得 ' + inst.data.user.name)
  const ENV = require(path.join(ROOT, 'config', 'env.js'))
  check('[profile] 头像走 resolveAvatar（相对路径拼网关）',
    inst.data.user.avatarUrl === ENV.gateway + '/api/v1/avatars/a.png', '实得 ' + inst.data.user.avatarUrl)
  check('[profile] 有健康档案 → archiveSynced=true（真实状态位）', inst.data.archiveSynced === true)
  check('[profile] 有 ACTIVE 问诊 → unread=true（未读点真实数据）', inst.data.unread === true)
}

// ==================== 运行 ====================
;(async () => {
  try {
    await testRecords()
    await testSettingsClearCache()
    await testVoiceService()
    await testProfile()
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
  console.log('RESULT: PROFILE_AUDIT_OK')
})()
