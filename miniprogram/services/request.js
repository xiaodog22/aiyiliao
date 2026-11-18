/**
 * request.js —— 统一请求封装（统一网关版 V1.7）
 *
 * 三层 base 语义（gateway / python / java）在**同一地址** ENV.gateway 上解析，
 * 即：前端只维护一个后端地址，上游分流由网关路由表负责（对照《前端适配说明》§1/§2）。
 * ⚠️ 代码中禁止出现 8001 / 8088 / 127.0.0.1 / localhost。
 *
 * 错误分类：NO_BASE_URL / NETWORK_ERROR / TIMEOUT / HTTP_ERROR / BIZ_ERROR / PARSE_ERROR
 * 非 2xx 优先保留后端业务码（VERSION_CONFLICT / VALIDATION_FAILED / INTERNAL_ERROR 等）；
 * 只有响应体没有业务码时才回 HTTP_ERROR，避免把“版本冲突/参数错误”误报成服务故障。
 * 不弹 Toast、不吞错误，统一 reject 结构化错误 { code, message }
 */
const API = require('../config/api.js')
const ENV = require('../config/env.js')
const session = require('./session.js')
const connectivity = require('./connectivity.js')

let refreshPromise = null
let readyPromise = null

function requestId() {
  return 'wx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/** 写操作幂等键（契约：8~128 字符，重试必须复用同一键，相同键不同载荷 409） */
function newIdempotencyKey() {
  // 审计 M7：统一 32 位小写 hex（服务端按 tenant 域化后仍保持可读长度）；
  // 不用 Math.random 直接拼 base36，避免字符集/长度不稳定。
  let out = Date.now().toString(16)
  while (out.length < 32) out += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  return out.slice(0, 32)
}

/** 契约要求的小程序平台/版本头（login / doctor-login 为 required，其余接口无害） */
function clientHeaders() {
  const h = { 'X-Platform': ENV.platform, 'X-Client-Version': ENV.clientVersion }
  // 联调登录白名单头（仅 local/development 有值）：后端 DevLoginGuard 用它放行 dev 派生 code，
  // production 恒为空 → 不发送，prod 档也不装配该闸门。
  if (ENV.devLoginKey) h['X-Dev-Login-Key'] = ENV.devLoginKey
  return h
}

/**
 * 通用请求头（**不含 Content-Type**，供 multipart/文件上传等自行决定）：
 * 平台与版本头 + 追踪 ID + 可选 Authorization + 非生产的隧道跳过头。
 * includeAuth === false 用于匿名接口（登录 / 刷新）。
 */
function baseHeaders(extra, includeAuth) {
  const token = includeAuth === false ? '' : session.getAccessToken()
  return Object.assign(
    clientHeaders(),
    { 'X-Request-Id': requestId() },
    token ? { Authorization: 'Bearer ' + token } : {},
    ENV.isProduction ? {} : { 'ngrok-skip-browser-warning': 'true' },
    extra || {}
  )
}

/**
 * JSON 请求头（get/post/put/del 默认）：通用头 + application/json。
 * ⚠️ 隧道跳过头只在这里（及 baseHeaders）按 isProduction 判断，不再散落到各请求函数。
 */
function authHeader(extra, includeAuth) {
  return baseHeaders(Object.assign({ 'Content-Type': 'application/json' }, extra || {}), includeAuth)
}

/**
 * 匿名（免登录）接口白名单 —— 与后端 AuthInterceptor.ANONYMOUS 同一口径。
 * 仅白名单内的「方法 + 路径」允许无会话直接发请求；其余一律先经 ensureAccessToken()，
 * 从而"未登录的演示模式不再反复调用受保护接口"（不产生无谓 401，也不触发刷新风暴）。
 * 单段 * 通配（与后端同形）；/api/gw/tts/audio/* 按设计以短期签名 token 鉴权（audio 元素无法带 Authorization）。
 */
const ANONYMOUS = [
  { method: 'POST', pattern: '/api/v1/auth/wechat/login' },
  { method: 'POST', pattern: '/api/v1/auth/refresh' },
  { method: 'POST', pattern: '/api/v1/doctor/login' },
  { method: 'GET', pattern: '/api/v1/departments' },
  { method: 'GET', pattern: '/api/v1/departments/*/doctors' },
  // 医生目录：前端用的是 legacy 路径，由网关 compat 翻译到匿名端点 /api/v1/doctors（故仍为匿名）
  { method: 'GET', pattern: '/api/v1/doctor/list' },
  { method: 'GET', pattern: '/api/v1/doctor/by-department' },
  { method: 'GET', pattern: '/api/v1/doctors' },
  { method: 'GET', pattern: '/api/v1/doctors/*/slots' },
  { method: 'POST', pattern: '/api/v1/triage/emergency-check' },
  { method: 'POST', pattern: '/api/v1/triage/emergency-checks' },
  // 急诊红旗：前端用 legacy 路径，网关 compat 翻译到匿名端点 emergency-checks
  // （危重识别必须能在未登录时也发得出去，不能被本地守卫挡住）
  { method: 'POST', pattern: '/api/v1/consultation/emergency/check' },
  { method: 'GET', pattern: '/api/v1/contents' },
  { method: 'GET', pattern: '/api/v1/contents/*' },
  // 科普文章（N12/N13）：后端 AuthInterceptor 已登记匿名只读，前端守卫必须同口径，
  // 否则详情页拿不到 videoUrl（会被本地守卫拦成 AUTH_REQUIRED，且不发网络）。
  { method: 'GET', pattern: '/api/v1/health-articles' },
  { method: 'GET', pattern: '/api/v1/health-articles/*' },
  { method: 'GET', pattern: '/api/v1/resources/manifest' },
  // 降级开关快照（2026-11-18）：不含用户数据，冷启动/未登录也允许读取，供 WechatSI 兜底判定。
  { method: 'GET', pattern: '/api/v1/voice/capabilities' },
  // 网关健康：服务端该路径未挂鉴权且限流豁免（编排器轮询用）——实测匿名 200。
  // 设置页「后端服务状态」面板在未登录时也要能看到真实状态（不得被本地守卫拦成"未连接"误报）。
  { method: 'GET', pattern: '/api/gw/health' },
  { method: 'GET', pattern: '/api/gw/tts/audio/*' }
]

/** 判定某方法+路径是否匿名可访问（路径里的 query 不参与匹配） */
function isAnonymous(method, path) {
  const segs = String(path || '').split('?')[0].split('/')
  return ANONYMOUS.some((entry) => {
    if (entry.method !== method) return false
    const pat = entry.pattern.split('/')
    if (pat.length !== segs.length) return false
    for (let i = 0; i < pat.length; i++) {
      if (pat[i] !== '*' && pat[i] !== segs[i]) return false
    }
    return true
  })
}

/**
 * 会话就绪（受保护请求的统一前置；冷启动关键）：
 *  1) 内存里有可用 access → 直接放行；
 *  2) 无 access 但有 refresh（冷启动典型态：access 只在内存、refresh 在本地存储）→
 *     **先单飞刷新**，成功后再发业务请求（避免"先吃一个 401 再刷新"）；
 *  3) 两者都没有 → 本地直接 reject AUTH_REQUIRED，**不发网络**。
 * refreshAccessToken() 内部用裸 wx.request，不会递归回本函数。
 */
function ensureAccessToken() {
  if (session.getAccessToken()) return Promise.resolve(true)
  if (!session.getRefreshToken()) {
    return Promise.reject(makeError('AUTH_REQUIRED', '请先登录后再操作'))
  }
  if (!readyPromise) {
    readyPromise = refreshAccessToken().then(
      (tokens) => { readyPromise = null; return !!tokens },
      (err) => { readyPromise = null; throw err }
    )
  }
  return readyPromise
}

/** 页面侧包装：会话就绪 → true；未登录/刷新失败 → false（不抛错，供页面守卫用） */
function ensureSessionReady() {
  return ensureAccessToken().then(() => true, () => false)
}

/** 受保护接口的发请求前置：匿名路径直接放行，其余统一走 ensureAccessToken() */
function requireSession(method, spec) {
  if (isAnonymous(method, spec && spec.path)) return Promise.resolve(true)
  return ensureAccessToken()
}

/** 从 spec 取本次操作的幂等键（重试复用同一键由 options._idempotencyKey 承载） */
function idempotencyOf(options) {
  return (options && (options.idempotencyKey || options._idempotencyKey)) || null
}

function isRefreshSpec(spec) {
  return !!(spec && API.AUTH_REFRESH && spec.path === API.AUTH_REFRESH.path)
}

/**
 * 注销后端会话（退出登录专用）：POST /api/v1/auth/logout，按 Bearer 撤销整条会话链。
 * 契约要点：`Idempotency-Key` 必填（缺失 400）；无 Bearer 时后端如实返回 revoked=false。
 *
 * ⚠️ 必须在清本地会话**之前**调用 —— 这里刻意用裸 wx.request 而不是 request()：
 *    request() 的鉴权头是在 Promise 微任务里拼的，调用方紧接着 session.clear() 就会
 *    把 Authorization 拼成空（撤销变成匿名请求，静默失败）。此处同步取头，时序确定。
 * ⚠️ access 只驻留内存：2h 过期或进程被回收后 getAccessToken() 为空，但 refresh 仍在本地存储。
 *    此时若直接返回 false，服务端那条会话还能换新 access 满 7 天（审查 D-A-P1-01）。
 *    故无 access 但有 refresh 时，先用 refresh 静默换一次 access 再撤销（不写 session）。
 * ⚠️ 永不 reject：退出登录不能被网络问题挡住，失败由调用方按"尽力而为"处理。
 * @returns {Promise<boolean>} 是否收到服务端 2xx 撤销确认（网络失败/401/5xx 一律 false，调用方不得清本地令牌）
 */
function revokeSession() {
  const full = buildURL(API.AUTH_LOGOUT)
  if (!full) return Promise.resolve(false)
  const accessToken = session.getAccessToken()
  if (accessToken) return sendLogout(full, accessToken)
  const refreshToken = session.getRefreshToken()
  if (!refreshToken) return Promise.resolve(false)
  return refreshSilently(refreshToken)
    .then((tokens) => {
      const fresh = tokens && (tokens.accessToken || tokens.access_token)
      return fresh ? sendLogout(full, fresh) : false
    })
    .catch(() => false)
}

/**
 * 静默刷新（撤销专用）：用调用方显式给出的 refresh token 换一对新令牌。
 * ⚠️ 与 refreshAccessToken() 的区别：**不写 session、不跳登录页、不占单飞位**。
 *    退出登录流程里本地会话已清，若走 session.setTokens() 会把刚清掉的 refresh
 *    又写回 storage（"退出后令牌复活"）。
 * ⚠️ 永不 reject，失败一律 resolve(null)。
 */
function refreshSilently(refreshToken) {
  const full = API.AUTH_REFRESH ? buildURL(API.AUTH_REFRESH) : ''
  if (!full) return Promise.resolve(null)
  return new Promise((resolve) => {
    wx.request({
      url: full,
      method: 'POST',
      data: { refreshToken },
      header: authHeader({}, false),
      timeout: 5000,
      success: (res) => {
        if (!res || res.statusCode < 200 || res.statusCode >= 300) return resolve(null)
        let tokens = null
        try { tokens = unwrap(res.data) } catch (e) { tokens = null }
        resolve(tokens || null)
      },
      fail: () => resolve(null)
    })
  })
}

/** 发一次注销往返：token 由调用方显式给出（退出时 session 可能已清，不能靠 baseHeaders 自动取） */
function sendLogout(full, accessToken) {
  return new Promise((resolve) => {
    wx.request({
      url: full,
      method: 'POST',
      data: {},
      // extra 在 baseHeaders 内最后展开，显式 Authorization 覆盖自动取值
      header: baseHeaders({
        Authorization: 'Bearer ' + accessToken,
        'Idempotency-Key': newIdempotencyKey()
      }),
      timeout: 5000,
      success: (res) => resolve(!!res && res.statusCode >= 200 && res.statusCode < 300),
      fail: () => resolve(false)
    })
  })
}

/** 429 限流：中文文案 + 结构化 retryAfter（避免落进 HTTP_ERROR 通用文案而丢语义） */
function rateLimited(res) {
  return makeError('RATE_LIMITED', '操作过于频繁，请稍后再试', {
    httpCode: 429,
    retryAfter: Number(headerOf(res, 'Retry-After') || 0)
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ============ GET 单飞（in-flight 去重）============
/**
 * 同一时刻对「相同 URL + 相同 query」只发一次网络请求，并发调用共享同一 Promise。
 * 典型场景：Tab 快速来回切（home/profile/consultation 的 onShow 都会拉数据）、
 * 多个页面同时拉同一份科室目录。
 *
 * 约束：
 *  - **仅 GET**：天然幂等，合并无副作用；POST/PUT/DELETE 一律不合并（写操作必须逐次下发）
 *  - **401 自动重发跳过合并**：重发发生在原请求 settle 之前，若参与合并会命中自己
 *    未结束的 Promise 而死锁
 *  - **settle 即释放，失败不缓存**：下一次调用该重发还得重发
 */
const inflightGet = new Map()

function inflightKeyOf(full, data, rawEnvelope) {
  let payload = ''
  if (data != null) {
    try {
      payload = typeof data === 'object' ? JSON.stringify(data) : String(data)
    } catch (e) {
      payload = ''   // 无法序列化的载荷不参与合并（各自单发，宁可多一次请求也不串结果）
    }
  }
  return full + '|' + payload + (rawEnvelope ? '|raw' : '')
}

/* ============ GET 短 TTL 缓存（响应速度，2026-11-14） ============
   背景：真机走隧道时单次 RTT 1~3s，TabBar 来回切一次就有 3~4 个 GET 重发
   （我的页 /me + 健康档案 + 问诊列表），每次都把骨架屏重新拉一遍。
   策略：
     · 只缓存 **GET 成功结果**，默认 15s（页面需要更新鲜可传 cacheTtl: 0 关掉）；
     · **任何写操作成功后整体失效**（下单/改资料/删附件后立刻能读到新数据）；
     · 退出登录/切换账号时由 clearGetCache() 强制清空（避免下个账号读到上个账号的数据）；
     · 失败结果永不缓存（下次必须重发）。
   合规：只存内存、不落 storage，小程序进程结束即消失；健康类接口同样受益于"写后失效"，
   不会出现"改完还看到旧病历"的情况。 */
const GET_CACHE_TTL_MS = 15000
const getCache = new Map()

// 登录入口不能被"离线闸门"提前挡掉：登录本身就要尝试触达后端，
// 失败也应拿到真实的 NETWORK_ERROR/TIMEOUT（而不是复用一个 10s 前的探测结论）。
const AUTH_ENTRY_PATHS = [
  '/api/v1/auth/wechat/login',
  '/api/v1/doctor/login',
  '/api/user/login'
]

function isAuthEntry(method, spec) {
  if (method !== 'POST') return false
  const p = String((spec && spec.path) || '').split('?')[0]
  return AUTH_ENTRY_PATHS.indexOf(p) >= 0
}

/**
 * 只对这些**列表/目录类** GET 路径开缓存（白名单，不是全局默认）。
 * 为什么不用全局默认：/me、/auth/*、/voice/* 这类"改完必须立刻看到"的接口
 * 一旦被缓存，写后失效再快也会有窗口期；而列表页来回切 tab 才是真正的重复流量源。
 * 需要新增时在这里加路径（前缀匹配子路径，如 /api/v1/reports/{id}）。
 */
const GET_CACHE_PATHS = [
  '/api/v1/health-records',
  '/api/v1/appointments/me',
  '/api/v1/reports',
  '/api/v1/family-members',
  '/api/v1/consultations',
  '/api/v1/departments',
  '/api/v1/doctors',
  '/api/v1/messages'
]

function cacheablePath(path) {
  const p = String(path || '').split('?')[0]
  if (!p) return false
  return GET_CACHE_PATHS.some((base) => p === base || p.indexOf(base + '/') === 0)
}

function cacheTtlOf(options) {
  if (options && options.cacheTtl === 0) return 0
  if (options && typeof options.cacheTtl === 'number') return options.cacheTtl
  return GET_CACHE_TTL_MS
}

function getCached(key) {
  if (!key) return null
  const hit = getCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > hit.ttl) {
    getCache.delete(key)
    return null
  }
  return hit
}

function putGetCache(key, value, ttl) {
  if (!key || !ttl) return
  getCache.set(key, { at: Date.now(), ttl, value })
  // 极简容量保护：超过 200 条先清一半（列表页长期驻留也不会无限涨）
  if (getCache.size > 200) {
    const keys = Array.from(getCache.keys()).slice(0, 100)
    keys.forEach((k) => getCache.delete(k))
  }
}

/** 清空 GET 缓存（写操作后自动调用；退出登录也需显式调用） */
function clearGetCache() {
  getCache.clear()
}

// ============ 会话失效全局出口（审查报告 P1-9）============
/**
 * 只有"服务端明确拒绝 refresh"（AUTH_EXPIRED）才走这里。
 * ⚠️ 网络失败（NETWORK_ERROR / TIMEOUT）绝不清会话、绝不跳登录 —— 断一次网不该把用户踢下线。
 * ⚠️ 节流：并发请求会各自刷新失败，5s 内只处置一次，避免多次 reLaunch 竞态。
 * 处置 = 清本地登录态（wb_role/wb_user/wb_login_at + session）→ 说明原因 → 用户确认后回登录页。
 * 用弹窗而不是静默 reLaunch：导诊/问诊页面可能有未提交内容，直接跳走会丢数据。
 */
const LOGIN_PAGE = 'pages/auth/login/login'
const LOGIN_EXIT_THROTTLE_MS = 5000
let lastExitAt = 0

/** 清登录态：页面/全局（app.globalData）与令牌（session）必须同步清，否则页面仍显示已登录 */
function clearLoginState() {
  try {
    wx.removeStorageSync('wb_role')
    wx.removeStorageSync('wb_user')
    wx.removeStorageSync('wb_login_at')
  } catch (e) {}
  session.clear()
  // 模块加载早于 App 构造，getApp() 只能在运行时调用
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && app.globalData) {
    app.globalData.role = ''
    app.globalData.user = null
  }
}

function currentRoute() {
  if (typeof getCurrentPages !== 'function') return ''
  const pages = getCurrentPages() || []
  return pages.length ? (pages[pages.length - 1].route || '') : ''
}

function goLoginPage(retried) {
  // 非小程序运行时（node 用例/工具脚本）没有页面栈，直接跳过
  if (typeof getCurrentPages !== 'function') return
  // 启动早期页面栈为空：等页面栈建立后再跳（只重试一次，不递归）
  if (!currentRoute()) {
    if (!retried) setTimeout(() => goLoginPage(true), 400)
    return
  }
  // 已在登录页就不再跳（否则会把用户刚填的登录表单清空）
  if (currentRoute() === LOGIN_PAGE) return
  if (typeof wx.reLaunch !== 'function') return
  wx.reLaunch({ url: '/' + LOGIN_PAGE, fail: () => {} })
}

function exitToLogin() {
  const now = Date.now()
  if (now - lastExitAt < LOGIN_EXIT_THROTTLE_MS) return
  lastExitAt = now
  clearLoginState()
  if (currentRoute() === LOGIN_PAGE) return
  // 非小程序运行时：只清状态，不弹窗
  if (typeof wx.showModal !== 'function') return
  wx.showModal({
    title: '登录已过期',
    content: '为保护您的健康信息，请重新登录后继续使用。',
    showCancel: false,
    confirmText: '重新登录',
    success: () => goLoginPage(false),
    fail: () => goLoginPage(false)
  })
}

function refreshAccessToken() {
  const refreshToken = session.getRefreshToken()
  if (!refreshToken) {
    session.clear()
    exitToLogin()
    return Promise.reject(makeError('AUTH_EXPIRED', '登录已过期，请重新登录。'))
  }
  // 配置缺失属工程问题，不应把用户踢去登录页
  if (!API.AUTH_REFRESH) {
    return Promise.reject(makeError('AUTH_EXPIRED', '登录已过期，请重新登录。'))
  }
  if (refreshPromise) return refreshPromise

  const full = buildURL(API.AUTH_REFRESH)
  if (!full) return Promise.reject(makeError('NO_BASE_URL', '服务暂未开通，无法刷新登录状态。'))

  refreshPromise = new Promise((resolve, reject) => {
    // 记下发起时的会话代次：若期间用户退出登录（session.clear 会自增代次），
    // 回来的结果必须丢弃，否则 setTokens 会把已清掉的 refresh 写回 storage（令牌复活）。
    const epochAtStart = session.getEpoch()
    wx.request({
      url: full,
      method: 'POST',
      data: { refreshToken },
      header: authHeader({}, false),
      timeout: 15000,
      success: (res) => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            throw makeError('AUTH_EXPIRED', '登录已过期，请重新登录。', {
              httpCode: res.statusCode
            })
          }
          const tokens = unwrap(res.data)
          if (!tokens || !(tokens.accessToken || tokens.access_token)) {
            throw makeError('AUTH_EXPIRED', '登录状态刷新失败，请重新登录。')
          }
          if (session.getEpoch() !== epochAtStart) {
            // 期间已退出登录：不写令牌、不报错（调用方拿 false 即可），静默作废
            resolve(null)
            return
          }
          session.setTokens(tokens)
          resolve(tokens)
        } catch (e) {
          // 同上：代次已变说明会话是被主动清掉的，不要重复 clear / 跳登录页
          if (session.getEpoch() !== epochAtStart) {
            reject(e)
            return
          }
          session.clear()
          // 服务端拒绝刷新（或返回体无 accessToken）→ 会话确实失效，给用户一个出口
          if (e && e.code === 'AUTH_EXPIRED') exitToLogin()
          reject(e)
        }
      },
      fail: (err) => {
        const e = makeError(
          /timeout/.test((err && err.errMsg) || '') ? 'TIMEOUT' : 'NETWORK_ERROR',
          '网络连接失败，暂时无法刷新登录状态。',
          { raw: err }
        )
        // 刷新是裸 wx.request，不经 request() 的统一 fail 分支；这里补一次状态标记，
        // 否则"401 后刷新断网"会让全局状态误以为仍在线。
        // silent=true：刷新失败由调用方按 401 处理并引导重新登录，不需要全局模态框（m-06）。
        connectivity.markFail(e, 'request', true)
        reject(e)
      },
      complete: () => { refreshPromise = null }
    })
  })
  return refreshPromise
}

// ============ 地址解析 ============
function getBase(spec) {
  if (!spec || !spec.base) return ''
  // gateway / python / java 三者都落在唯一网关入口上（上游分流由网关负责）
  if (spec.base === 'gateway' || spec.base === 'python' || spec.base === 'java') return ENV.gateway
  // 兼容历史写法
  if (spec.base === 'fastapi' || spec.base === 'springboot') return ENV.gateway
  return ''
}

function buildURL(spec) {
  const base = getBase(spec)
  if (!base) return ''
  return base + spec.path
}

/** 对外暴露：由接口规格取完整 URL（SSE / 音频直链等场景需要） */
function url(spec) { return buildURL(spec) }

/** 路径占位符替换：{id} → 实际值（如 API.BED_UPDATE） */
function withPath(spec, params) {
  if (!spec || !params) return spec
  let p = spec.path
  Object.keys(params).forEach((k) => {
    p = p.replace(new RegExp('\\{' + k + '\\}', 'g'), encodeURIComponent(String(params[k])))
  })
  return { base: spec.base, path: p }
}

// ============ 编码工具 ============
/** UTF-8 编码（不依赖 TextEncoder，兼容旧基础库） */
function encodeUTF8(str) {
  const s = String(str)
  const out = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F))
    } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      const c2 = s.charCodeAt(++i)
      const cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00)
      out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
    } else {
      out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F))
    }
  }
  return new Uint8Array(out)
}

/** UTF-8 解码（ArrayBuffer → string） */
function decodeUTF8(buf) {
  if (typeof buf === 'string') return buf
  if (!buf) return ''
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i++]
    if (b < 0x80) {
      out += String.fromCharCode(b)
    } else if (b >= 0xC0 && b < 0xE0) {
      out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F))
    } else if (b >= 0xE0 && b < 0xF0) {
      out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F))
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F)
      const v = cp - 0x10000
      out += String.fromCharCode(0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF))
    }
  }
  return out
}

/** 构造 multipart/form-data 请求体（转义无关的字段名，值按 UTF-8 原样发送） */
function buildMultipart(fields) {
  const boundary = '----wb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  let head = ''
  Object.keys(fields || {}).forEach((k) => {
    const v = fields[k]
    if (v === undefined || v === null) return
    head += '--' + boundary + '\r\n'
    head += 'Content-Disposition: form-data; name="' + k + '"\r\n\r\n'
    head += String(v) + '\r\n'
  })
  head += '--' + boundary + '--\r\n'
  return { body: encodeUTF8(head).buffer, boundary }
}

function isArrayBuffer(v) {
  return !!v && typeof v === 'object' && typeof v.byteLength === 'number' && typeof v.slice === 'function'
}

function headerOf(res, name) {
  const h = (res && res.header) || {}
  const want = name.toLowerCase()
  const keys = Object.keys(h)
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === want) return h[keys[i]]
  }
  return ''
}

// ============ 响应脱壳 ============
// 后端常用 { code, msg, data }（Spring Boot）或 { code, message, data }（FastAPI）
/**
 * 成功信封判定：契约统一信封的 code 固定为 **"OK"**（大小写不敏感），
 * 而 legacy 兼容适配器（网关 compat）仍下发数字 200/0 以兼容旧端 —— 两者都必须认。
 * ⚠️ 只认 200/'200'/0/'0' 会把契约响应误判成 BIZ_ERROR（401 修复前的老 bug）。
 */
function isOkCode(code) {
  if (code === 200 || code === 0 || code === '200' || code === '0') return true
  return typeof code === 'string' && code.trim().toLowerCase() === 'ok'
}

function unwrap(res) {
  if (res == null) return null
  if (typeof res !== 'object') return res
  if (Object.prototype.hasOwnProperty.call(res, 'code') && isOkCode(res.code)) {
    return Object.prototype.hasOwnProperty.call(res, 'data') ? res.data : res
  }
  if (!Object.prototype.hasOwnProperty.call(res, 'code')) return res
  const message = res.msg || res.message || res.error || '业务错误'
  const err = new Error(message)
  err.code = 'BIZ_ERROR'
  err.httpCode = res.code
  err.detail = res
  throw err
}

function makeError(code, message, extra) {
  const err = new Error(message)
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

/**
 * 后端错误文案提取（审计 L7）。
 *
 * 原实现把 `msg/message/error/detail` 以及结构化 `details` 全部拼进用户可见文案：
 * 上游一旦回显堆栈（FastAPI 的 detail 惯例），整段内部信息会直接渲染到患者屏幕。
 * 现在分档：
 *  - 5xx：一律不取原文（内部故障不该把实现细节给用户）；
 *  - 4xx：取业务自写文案（msg/message/error），**不再**把 detail 当文案；
 *    `details` 只在 VALIDATION_FAILED 这类字段级校验里拼接（那是给用户看的字段提示）。
 */
function extractBizMsg(data, status) {
  if (!data || typeof data !== 'object') return ''
  if (typeof status === 'number' && status >= 500) return ''
  const base = data.msg || data.message || (typeof data.error === 'string' ? data.error : '') || ''
  const code = typeof data.code === 'string' ? data.code.trim() : ''
  const detail = code === 'VALIDATION_FAILED' ? extractBizDetails(data) : ''
  if (!detail) return base
  return base ? (base + '：' + detail) : detail
}

/** 后端 VALIDATION_FAILED 的 details 是结构化字段错误；把它拼进用户可见文案，避免只剩“参数未通过校验”。 */
function extractBizDetails(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.details)) return ''
  return data.details.map((item) => {
    if (!item || typeof item !== 'object') return ''
    const field = item.field ? String(item.field) : ''
    const reason = item.reason || item.message || ''
    return (field + (field && reason ? '：' : '') + reason).trim()
  }).filter(Boolean).join('；')
}

/**
 * 非 2xx 的统一错误：保留后端业务码（VERSION_CONFLICT / VALIDATION_FAILED / INTERNAL_ERROR…）。
 * 旧实现把所有 4xx/5xx 都压成 HTTP_ERROR，页面无法区分“版本冲突”“参数错误”和“服务挂了”，
 * 最终统一显示“服务暂时不可用”，把可修复的问题伪装成故障。
 */
function httpError(status, data) {
  const biz = (data && typeof data === 'object' && typeof data.code === 'string')
    ? data.code.trim()
    : ''
  const code = biz && biz !== 'OK' ? biz : 'HTTP_ERROR'
  const rawMsg = extractBizMsg(data, status)
  if (!rawMsg && data && (data.detail || data.msg || data.message)) {
    // 原文只进调试台，不上屏（审计 L7）
    console.debug('[request] 上游错误详情（不展示给用户）', specSafe(data))
  }
  return makeError(code, rawMsg || '服务暂时不可用，请稍后重试', {
    httpCode: status,
    data,
    bizCode: biz
  })
}

/** 调试输出用：只保留可读摘要，避免整包打印敏感响应。 */
function specSafe(data) {
  try {
    return String((data && (data.code || data.message || data.detail)) || '').slice(0, 200)
  } catch (e) {
    return ''
  }
}

// ============ 基础请求 ============
function request(options) {
  const { spec, method = 'GET', data, header, timeout, params, rawEnvelope } = options
  if (!spec) return Promise.reject(makeError('BAD_SPEC', '缺少接口规格'))
  const finalSpec = params ? withPath(spec, params) : spec
  const full = buildURL(finalSpec)
  if (!full) {
    return Promise.reject(makeError('NO_BASE_URL', '服务暂未开通，请稍后重试。'))
  }
  const finalTimeout = typeof timeout === 'number' ? timeout : (ENV.aiTimeout || 30000)
  const idem = idempotencyOf(options)

  // GET 单飞：并发相同请求共享同一次网络往返（写操作永不合并）
  const canShare = method === 'GET' && !options._authRetried && !options.noShare
  const shareKey = canShare ? inflightKeyOf(full, data, rawEnvelope) : ''
  // 缓存键与单飞键分开：noShare 的 GET 也要能命中/写入缓存（否则缓存键为空会串结果）
  // 仅白名单路径进缓存（见 GET_CACHE_PATHS），其余路径 cacheKey 为空 = 不缓存
  const cacheKey = (method === 'GET' && cacheablePath(finalSpec.path))
    ? inflightKeyOf(full, data, rawEnvelope)
    : ''
  if (method === 'GET' && !options._authRetried) {
    // 401 重试后的那次读缓存无意义（服务端刚判定过期），其余 GET 先看短缓存
    const cached = getCached(cacheKey)
    if (cached) return Promise.resolve(cached.value)
  }
  if (canShare) {
    const hit = inflightGet.get(shareKey)
    if (hit) return hit
  }

  // 写操作前置：离线/降级时先探测网关健康；探测失败直接返回 OFFLINE，
  // 不让预约、问诊、床位申请等提交在断网时"点了像成功"。
  // GET 不受影响：已加载/缓存内容仍可浏览，页面用离线条标明"非实时"。
  const writeGate = (method === 'GET' || isAuthEntry(method, finalSpec))
    ? Promise.resolve()
    : connectivity.ensureWritable()

  // 会话就绪（冷启动先刷新再发；未登录则本地 reject，不发无谓请求）
  const pending = writeGate.then(() => requireSession(method, finalSpec)).then(() => new Promise((resolve, reject) => {
    wx.request({
      url: full,
      method,
      data,
      header: authHeader(Object.assign({}, header || {}, idem ? { 'Idempotency-Key': idem } : {})),
      timeout: finalTimeout,
      success: (res) => {
        // 只要能收到 HTTP 响应，就说明网关可达；业务 4xx/5xx 不应把全局状态误判为断网。
        connectivity.markOk('request')
        // 401：非刷新接口且未重试过 → 单飞刷新后带同一幂等键重发一次（最多一次）
        if (res.statusCode === 401 && !options._authRetried && !isRefreshSpec(finalSpec)) {
          refreshAccessToken()
            .then(() => request(Object.assign({}, options, { _authRetried: true })))
            .then(resolve, reject)
          return
        }
        if (res.statusCode === 403) {
          reject(makeError('FORBIDDEN', '您没有权限执行此操作。', { httpCode: 403 }))
          return
        }
        if (res.statusCode === 429) {
          reject(rateLimited(res))
          return
        }
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            // rawEnvelope：不脱壳，返回完整 { code, message, data, ... } 用于
            // 同级字段共存的极端场景（信封里 data 之外还有并列状态字段）
            const value = rawEnvelope ? res.data : unwrap(res.data)
            // 响应速度（2026-11-14）：GET 成功结果进短 TTL 缓存；写操作成功后整体失效。
            if (method === 'GET') {
              putGetCache(cacheKey, value, cacheTtlOf(options))
            } else {
              clearGetCache()
            }
            resolve(value)
          } else {
            reject(httpError(res.statusCode, res.data))
          }
        } catch (e) {
          if (e && e.code === 'BIZ_ERROR') reject(e)
          else reject(makeError('PARSE_ERROR', e.message || '响应解析失败'))
        }
      },
      fail: (err) => {
        // m-06（2026-11-18）：只有**写操作**（预约/问诊/床位/资料修改等写闸门）失败才弹全局
        // 模态框；读请求失败一律静默 —— 顶部 offline-bar 已经在提示，弱网下再每请求弹一次纯打扰。
        const silent = method === 'GET'
        const msg = (err && err.errMsg) || ''
        if (/timeout/.test(msg)) {
          const e = makeError('TIMEOUT', '请求超时，请检查网络后重试。', { raw: err })
          connectivity.markFail(e, 'request', silent)
          reject(e)
        } else {
          const e = makeError('NETWORK_ERROR', '网络连接失败，请检查网络后重试。', { raw: err })
          connectivity.markFail(e, 'request', silent)
          reject(e)
        }
      }
    })
  }))

  if (canShare) {
    inflightGet.set(shareKey, pending)
    // settle 即释放：成功失败都不缓存（失败的请求必须允许下次重发）
    const release = () => {
      if (inflightGet.get(shareKey) === pending) inflightGet.delete(shareKey)
    }
    pending.then(release, release)
  }
  return pending
}

// ============ multipart（Form 参数接口：TTS / 音色试听）============
/**
 * 以 multipart/form-data 发 POST。
 * 自动识别响应：Content-Type 含 json → 脱壳后返回对象；否则返回 **ArrayBuffer**（音频等二进制）。
 * @returns {Promise<Object|ArrayBuffer>}
 */
function postForm(spec, fields, opts) {
  const o = opts || {}
  if (!spec) return Promise.reject(makeError('BAD_SPEC', '缺少接口规格'))
  const full = buildURL(spec)
  if (!full) return Promise.reject(makeError('NO_BASE_URL', '服务暂未开通，请稍后重试。'))
  const { body, boundary } = buildMultipart(fields)
  const finalTimeout = typeof o.timeout === 'number' ? o.timeout : (ENV.ttsTimeout || 90000)
  const idem = idempotencyOf(o)

  // 会话就绪 + Bearer（此前本条路完全没有 Authorization，是 TTS/ASR 401 的直接原因之一）
  return connectivity.ensureWritable().then(() => requireSession('POST', spec)).then(() => new Promise((resolve, reject) => {
    const send = (options) => {
      wx.request({
        url: full,
        method: 'POST',
        data: body,
        // Content-Type 由本函数决定（multipart）；平台/版本/追踪/Bearer/幂等键由 baseHeaders 统一拼装
        header: baseHeaders(Object.assign(
          { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
          idem ? { 'Idempotency-Key': idem } : {}
        )),
        // 以 arraybuffer 接收，便于同时兼容「JSON 应答」与「WAV 二进制应答」
        responseType: 'arraybuffer',
        timeout: finalTimeout,
        success: (res) => {
          connectivity.markOk('request')
          const ct = String(headerOf(res, 'Content-Type') || '').toLowerCase()
          const isJson = ct.indexOf('json') >= 0
          // 401：未重试过且非刷新接口 → 单飞刷新后重发一次
          if (res.statusCode === 401 && !(options && options._authRetried) && !isRefreshSpec(spec)) {
            refreshAccessToken()
              .then(() => send({ _authRetried: true }))
              .then(resolve, reject)
            return
          }
          if (res.statusCode === 429) { reject(rateLimited(res)); return }
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              let msg = ''
              if (isJson && res.data) msg = extractBizMsg(JSON.parse(decodeUTF8(res.data)))
              reject(makeError('HTTP_ERROR', msg || ('请求失败（' + res.statusCode + '）'),
                { httpCode: res.statusCode, data: res.data }))
              return
            }
            if (isJson || !isArrayBuffer(res.data)) {
              const text = isArrayBuffer(res.data) ? decodeUTF8(res.data) : String(res.data || '')
              let obj = null
              try { obj = JSON.parse(text) } catch (e) { obj = null }
              if (obj === null) { reject(makeError('PARSE_ERROR', '响应解析失败')); return }
              resolve(unwrap(obj))
            } else {
              resolve(res.data) // ArrayBuffer
            }
          } catch (e) {
            if (e && (e.code === 'BIZ_ERROR' || e.code === 'PARSE_ERROR')) reject(e)
            else reject(makeError('PARSE_ERROR', e.message || '响应解析失败'))
          }
        },
        fail: (err) => {
          // 次要请求（TTS 合成/试听）：失败交给页面与 offline-bar，不弹全局模态框（m-06）
          const msg = (err && err.errMsg) || ''
          if (/timeout/.test(msg)) {
            const e = makeError('TIMEOUT', '语音合成超时，请稍后重试。', { raw: err })
            connectivity.markFail(e, 'request', true)
            reject(e)
          } else {
            const e = makeError('NETWORK_ERROR', '网络连接失败，请检查网络后重试。', { raw: err })
            connectivity.markFail(e, 'request', true)
            reject(e)
          }
        }
      })
    }
    send({})
  }))
}

// ============ 二进制 GET（网关音频 /api/gw/tts/audio/{file}）============
function getBinary(spec, params, opts) {
  const o = opts || {}
  const finalSpec = params ? withPath(spec, params) : spec
  const full = buildURL(finalSpec)
  if (!full) return Promise.reject(makeError('NO_BASE_URL', '服务暂未开通'))
  // 会话就绪（签名音频路径属匿名白名单，直接放行）
  return requireSession('GET', finalSpec).then(() => new Promise((resolve, reject) => {
    wx.request({
      url: full,
      method: 'GET',
      header: baseHeaders(),
      responseType: 'arraybuffer',
      timeout: typeof o.timeout === 'number' ? o.timeout : (ENV.aiTimeout || 30000),
      success: (res) => {
        connectivity.markOk('request')
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data) // ArrayBuffer
        } else if (res.statusCode === 401) {
          reject(makeError('AUTH_REQUIRED', '登录已过期，请重新登录。', { httpCode: 401 }))
        } else if (res.statusCode === 404) {
          reject(makeError('HTTP_ERROR', '语音已过期，请重新生成。', { httpCode: 404 }))
        } else if (res.statusCode === 429) {
          reject(rateLimited(res))
        } else {
          // 不把 HTTP 码拼进用户可见文案（项目红线）
          reject(makeError('HTTP_ERROR', '音频获取失败，请稍后重试', { httpCode: res.statusCode }))
        }
      },
      fail: (err) => {
        // 音频下载属次要请求：静默标记，不弹模态框（m-06）
        const msg = (err && err.errMsg) || ''
        const e = /timeout/.test(msg)
          ? makeError('TIMEOUT', '音频下载超时。', { raw: err })
          : makeError('NETWORK_ERROR', '网络连接失败，请检查网络后重试。', { raw: err })
        connectivity.markFail(e, 'request', true)
        reject(e)
      }
    })
  }))
}

/**
 * withFallback —— 数据降级包装（骨架屏配套，最小设计）
 * 开发阶段（ENV.MOCK_FALLBACK=true）：请求失败 → 返回固定演示数据（mockFactory 结果），
 *   骨架屏结束后展示演示数据，不阻断开发；未提供 mockFactory 或返回 null 则原样抛错。
 * 上线阶段（ENV.MOCK_FALLBACK=false）：原样 reject → 页面骨架屏结束后展示错误态 + 重试。
 * 用法：withFallback(request.get(API.XXX), (err) => app.MOCK.XXX
 */
function withFallback(promise, mockFactory) {
  if (!ENV.MOCK_FALLBACK) return promise
  return promise.catch((err) => {
    const mock = typeof mockFactory === 'function' ? mockFactory(err) : mockFactory
    if (mock == null) throw err
    // 演示数据必须让全局状态知道：页面顶部离线条会写"演示数据"，写操作仍被闸门拦住。
    connectivity.markMock(err)
    console.warn('[request] 开发降级：后端不可用，使用演示数据兜底（' + (err && err.code) + '）')
    return mock
  })
}

/**
 * 打开 SSE 长连接（对外流式二期，2026-11-17）。
 *
 * 与 get/post 的差异，每条都是踩过的坑：
 *  ① **不脱壳**：SSE 帧由调用方（`services/stream.js`）解析，这里只管字节流；
 *  ② **成功回调 ≠ 有正文**：它只表示连接结束，增量在 `onChunkReceived` 里；
 *  ③ 基础库 < 2.20.2 没有 `onChunkReceived` → 走 `unsupported` 回调降级，**不是错误**；
 *  ④ 401 **不在这里自动刷新**：长连接重发代价高（7B CPU 一次推理数十秒），
 *     交调用方决定——通常直接降级轮询同一 taskId，绝不重新提交任务。
 *
 * @param {Object} spec 接口规格（如 API.AI_TASK_EVENTS）
 * @param {{chunk?:Function, success?:Function, fail?:Function, unsupported?:Function}} handlers
 * @param {{timeout?:number}} [opts]
 * @returns {Promise<{abort:Function, supported:boolean}>}
 */
function openStream(spec, handlers, opts) {
  const full = buildURL(spec)
  if (!full) return Promise.reject(makeError('NO_BASE_URL', '服务暂未开通'))
  const h = handlers || {}
  const o = opts || {}
  const emit = (name, payload) => {
    try {
      if (typeof h[name] === 'function') h[name](payload)
    } catch (e) {
      // 回调异常不得中断读取：SSE 仍在跑，抛出去会丢掉后续增量
    }
  }
  return requireSession('GET', spec).then(() => new Promise((resolve) => {
    const task = wx.request({
      url: full,
      method: 'GET',
      header: baseHeaders({ Accept: 'text/event-stream' }),
      enableChunked: true,
      timeout: typeof o.timeout === 'number' ? o.timeout : (ENV.aiTimeout || 30000),
      success: (res) => {
        if (res && res.statusCode >= 200 && res.statusCode < 300) connectivity.markOk('request')
        emit('success', res)
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || ''
        // 主动 abort 不是断网：用户切换页面/取消生成时会走这里，不能误标离线。
        if (!/abort/.test(msg)) {
          const e = makeError('NETWORK_ERROR', '长连接失败', { raw: err })
          connectivity.markFail(e, 'request', false)
        }
        emit('fail', err)
      }
    })
    if (!task || typeof task.onChunkReceived !== 'function') {
      // 老基础库没有分块下发：先告知调用方降级，再**主动 abort**（m-03，2026-11-18）。
      // 不 abort 的话这条连接会继续跑，随后 success/fail 又回调一次；调用方此时已切轮询，
      // 会把正常收尾当成异常，出现双重降级/误报。
      emit('unsupported', {})
      try {
        if (task && typeof task.abort === 'function') task.abort()
      } catch (e) {
        // 连接尚未真正建立时 abort 会抛，属正常
      }
      resolve({ abort() {}, supported: false })
      return
    }
    task.onChunkReceived((res) => emit('chunk', res && res.data))
    resolve({
      supported: true,
      abort() {
        try {
          task.abort()
        } catch (e) {
          // 连接已结束时 abort 会抛，属正常
        }
      }
    })
  }))
}

module.exports = {
  get(spec, data, opts) { return request(Object.assign({ spec, method: 'GET', data }, opts || {})) },
  post(spec, data, opts) { return request(Object.assign({ spec, method: 'POST', data }, opts || {})) },
  put(spec, data, opts) { return request(Object.assign({ spec, method: 'PUT', data }, opts || {})) },
  del(spec, data, opts) { return request(Object.assign({ spec, method: 'DELETE', data }, opts || {})) },
  postForm,
  getBinary,
  openStream,
  url,
  withPath,
  // 上传文件（multipart）— ASR 用
  uploadFile(spec, filePath, name = 'audio', formData, opts) {
    const o = opts || {}
    const full = buildURL(spec)
    if (!full) return Promise.reject(makeError('NO_BASE_URL', '服务暂未开通'))
    const idem = idempotencyOf(o)
    // 会话就绪 + Bearer（此前本条路完全没有 Authorization，是 ASR 401 的直接原因之一）
    return connectivity.ensureWritable().then(() => requireSession('POST', spec)).then(() => new Promise((resolve, reject) => {
      const send = (options) => {
        wx.uploadFile({
          url: full,
          filePath,
          name,
          formData: formData || {},
          // Content-Type 交给 wx.uploadFile 自行生成 multipart；其余头统一走 baseHeaders
          header: baseHeaders(idem ? { 'Idempotency-Key': idem } : {}),
          timeout: typeof o.timeout === 'number' ? o.timeout : (ENV.aiTimeout || 30000),
          success: (res) => {
            connectivity.markOk('request')
            // 401：未重试过且非刷新接口 → 单飞刷新后重发一次
            if (res.statusCode === 401 && !(options && options._authRetried) && !isRefreshSpec(spec)) {
              refreshAccessToken().then(() => send({ _authRetried: true })).then(resolve, reject)
              return
            }
            if (res.statusCode === 429) { reject(rateLimited(res)); return }
            let body = res.data
            if (typeof body === 'string') {
              try { body = JSON.parse(body) } catch (e) { body = { message: body } }
            }
            if (body === '') body = null
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(unwrap(body))
            } else {
              const msg = extractBizMsg(body) || ('请求失败（' + res.statusCode + '）')
              reject(makeError('HTTP_ERROR', msg, { httpCode: res.statusCode, data: body }))
            }
          },
          fail: (err) => {
            // 语音上传属次要请求：页面自带失败提示，静默标记即可（m-06）
            const e = makeError('NETWORK_ERROR', '上传失败', { raw: err })
            connectivity.markFail(e, 'request', true)
            reject(e)
          }
        })
      }
      send({})
    }))
  },
  ENV,
  API,
  withFallback,
  encodeUTF8,
  decodeUTF8,
  isArrayBuffer,
  headerOf,
  // 认证与会话就绪（页面守卫用；请求内部已自动前置，页面仅在需要时显式调用）
  ensureAccessToken,
  ensureSessionReady,
  revokeSession,
  isAnonymous,
  newIdempotencyKey,
  // GET 短缓存手动失效（退出登录/切换账号时必须调用，避免串账号数据）
  clearGetCache
}
