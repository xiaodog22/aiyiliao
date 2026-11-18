/**
 * app.js —— 全局状态（V3.1 纯前端版）
 * 角色路由：登录后按身份自动进入 患者端(TabBar) / 医生端(工作台)
 * 主题管理：standard / large / xlarge 三档（设置页可切换）
 * 登录持久化：登录态写入本地存储，72 小时内免重复登录（超时自动失效）
 */
const MOCK = require('./utils/mock-data.js')
const session = require('./services/session.js')
const { ensureAccessToken, revokeSession, clearGetCache } = require('./services/request.js')
const resource = require('./services/resource.js')
const connectivity = require('./services/connectivity.js')
const capabilities = require('./services/capabilities.js')
const consent = require('./services/consent.js')

// 登录会话有效期：72 小时（毫秒）。超过则需重新登录。
const SESSION_TTL_MS = 72 * 60 * 60 * 1000

/**
 * 审计 M13：医生分包 8 个页面的服务端角色门禁。
 *
 * 只在 `pages/doctor/**` 上包一层：onLoad/onShow 先等 /auth/whoami 返回，
 * 非 DOCTOR 直接 reLaunch 登录页，原页面生命周期不执行（不加载医生业务数据）。
 * 这样不依赖每个页面手写守卫，也不会把本地 wb_role 当权限依据。
 * 本地角色仍保留为路由提示，但通过服务端返回的 roles 覆盖。
 */
if (typeof Page === 'function') {
  const nativePage = Page
  // eslint-disable-next-line no-global-assign
  Page = function (options) {
    const originalOnLoad = options && options.onLoad
    const originalOnShow = options && options.onShow
    options = options || {}

    const ensureDoctor = (page) => {
      if (page._doctorGate) return page._doctorGate
      page._doctorGate = getApp().verifyDoctorRole().then((ok) => {
        if (!ok) {
          wx.reLaunch({ url: '/pages/auth/login/login' })
          return false
        }
        return true
      }).catch(() => {
        wx.reLaunch({ url: '/pages/auth/login/login' })
        return false
      })
      return page._doctorGate
    }

    const isDoctorPage = (page) => {
      const route = (page && page.route) || ''
      return route.indexOf('pages/doctor/') === 0
    }

    options.onLoad = function (query) {
      if (!isDoctorPage(this)) {
        if (originalOnLoad) return originalOnLoad.call(this, query)
        return
      }
      const page = this
      ensureDoctor(page).then((ok) => {
        if (ok && originalOnLoad) originalOnLoad.call(page, query)
      })
    }

    options.onShow = function () {
      if (!isDoctorPage(this)) {
        if (originalOnShow) return originalOnShow.call(this)
        return
      }
      const page = this
      ensureDoctor(page).then((ok) => {
        if (ok && originalOnShow) originalOnShow.call(page)
      })
    }

    return nativePage(options)
  }
}

App({
  globalData: {
    role: '',           // '' | 'patient' | 'doctor'
    user: null,         // 患者/医生信息
    theme: 'standard',  // standard | large | xlarge
    highContrast: false // 无障碍高对比（D-10：原来只作用于设置页自身，等于开关没效果）
  },

  onLaunch() {
    // 恢复登录态与主题设置；角色仅作为路由提示，真正的医生准入由 verifyDoctorRole() 向服务端复核
    const role = session.getRoleHint() || wx.getStorageSync('wb_role') || ''
    try { wx.removeStorageSync('wb_role') } catch (e) {}
    const user = wx.getStorageSync('wb_user') || null
    const loginAt = wx.getStorageSync('wb_login_at') || 0
    // 会话超过有效期则清除登录态，强制重新登录。
    // ⚠️ loginAt 缺失但 role 仍在（历史脏数据 / 手工写 storage）同样视为失效：
    //    原实现对 `!loginAt` 返回"未过期"，会让 72h 会话在缺时间戳时永久有效（审查 AUTH-25）。
    if (role && (!loginAt || this._isSessionExpired(loginAt))) {
      this.logout()
    } else {
      this.globalData.role = role
      this.globalData.user = user
    }
    const theme = wx.getStorageSync('wb_theme') || 'standard'
    this.globalData.theme = theme
    // 无障碍高对比：冷启动读回（页面 onShow 会把它写到根节点 class 上）
    this.globalData.highContrast = !!wx.getStorageSync('wb_high_contrast')

    // 冷启动会话预热：access token 只驻留内存（重启即丢），这里用持久化的 refresh 先换回 access，
    // 避免首个受保护请求"先吃一个 401 再刷新"。失败静默：无会话 / refresh 过期时由页面守卫引导重登。
    ensureAccessToken().catch(() => {})

    // 全局连接状态（离线只读 / 写操作闸门）：冷启动静默探测网关健康；
    // 设备网络恢复时自动重探，但只有真正可达才重新放行写操作。
    connectivity.start()

    // 非关键远端资源清单后台刷新（docs/v4/09 §4.4-1）：仅写入本地缓存供 resolveResource/fallbackFor
    // 消费；清单或单资源失败一律静默回退内置素材，绝不阻断启动、绝不弹错。
    resource.refreshManifest().catch(() => {})

    // 降级开关快照（2026-11-18）：从后端读取 degradeMode/switches，供 WechatSI 等云端兜底判定；
    // 失败保持本地旧快照/构建档位兜底，不阻断启动，也不因读不到而放开云端。
    capabilities.refresh().catch(() => {})
    // M11：拉取服务端当前隐私政策版本；失败不阻断启动，但登录时 isAccepted 会失败关闭。
    consent.refreshPolicy().catch(() => {})
  },

  // 判断登录会话是否已过期（loginAt 为登录时间戳；0/空视为未登录，不判过期）
  _isSessionExpired(loginAt) {
    if (!loginAt) return false
    return Date.now() - Number(loginAt) > SESSION_TTL_MS
  },

  // 当前是否有有效登录态（未登录或已过期均返回 false，过期会自动清除）
  isLoggedIn() {
    if (!this.globalData.role) return false
    const loginAt = wx.getStorageSync('wb_login_at') || 0
    // 无时间戳 = 无法证明在 72h 内 → 按失效处理（与 onLaunch 同口径）
    if (!loginAt || this._isSessionExpired(loginAt)) {
      this.logout()
      return false
    }
    return true
  },

  // 登录成功：角色只作路由提示（服务端权威角色由 whoami 复核）；不落 wb_role 作为权限依据
  setLogin(role, user) {
    this.globalData.role = role
    this.globalData.user = user
    session.setRoleHint(role)
    try { wx.removeStorageSync('wb_role') } catch (e) {}
    wx.setStorageSync('wb_user', user)
    wx.setStorageSync('wb_login_at', Date.now())
  },

  /**
   * 退出登录（审计 M14 收紧）：必须先收到服务端 2xx 撤销确认，再清本地令牌。
   * ⚠️ 原实现“撤销尽力而为、本地立即清”会让服务端 refresh 链在断网/401 时继续存活 24h；
   *    现在失败保留本地会话并返回 false，由调用方提示重试，用户可再次退出。
   * ⚠️ 本地已无任何令牌（重复点击/已退出）视为成功，不阻塞导航。
   * @returns {Promise<boolean>} true=服务端已撤销（或本来就没有会话），可以离开；false=保留会话待重试
   */
  logout() {
    const clearLocal = () => {
      this.globalData.role = ''
      this.globalData.user = null
      try { wx.removeStorageSync('wb_role') } catch (e) {}
      wx.removeStorageSync('wb_user')
      wx.removeStorageSync('wb_login_at')
      session.clear()
      try { clearGetCache() } catch (e) {}
      try { require('./services/user.js').logout() } catch (e) {}
      try { require('./services/doctor.js').logout() } catch (e) {}
      return true
    }

    if (!session.hasSession()) {
      return Promise.resolve(clearLocal())
    }
    let revoking
    try {
      revoking = revokeSession()
    } catch (e) {
      revoking = Promise.resolve(false)
    }
    return Promise.resolve(revoking)
      .then((ok) => (ok ? clearLocal() : false))
      .catch(() => false)
  },

  // 切换主题档位
  setTheme(theme) {
    this.globalData.theme = theme
    wx.setStorageSync('wb_theme', theme)
  },

  /**
   * 无障碍高对比开关（D-10）。
   * 语义：**只提高对比度，不改色相** —— 文字加深、分割线加深，品牌蓝/状态绿保持原样，
   *       否则用户会以为开了"黑白模式"，颜色承载的状态语义全部丢失。
   * 落地：写 globalData + 本地存储，各页 onShow 会把它映射成根节点 `.high-contrast`，
   *       由 app.wxss 里的变量覆盖生效（设置页自身即时生效，无需回退）。
   */
  setHighContrast(on) {
    const v = !!on
    this.globalData.highContrast = v
    try { wx.setStorageSync('wb_high_contrast', v) } catch (e) {}
    return v
  },

  // 获取当前角色对应首页路由
  getRoleEntry() {
    return this.globalData.role === 'doctor'
      ? '/pages/doctor/workbench/workbench'
      : '/pages/home/home'
  },

  /**
   * 审计 M13：医生端准入必须向服务端复核角色。
   * 本地 wb_role / globalData.role 可被改 storage 伪造；本方法用 /auth/whoami 的
   * 服务端签发角色覆盖本地值，并返回是否真的具备 DOCTOR 角色。
   * 调用方必须在 onLoad/onShow 里 await 后再加载医生业务数据；失败关闭（false）。
   */
  verifyDoctorRole() {
    if (!this.isLoggedIn()) return Promise.resolve(false)
    return require('./services/user.js').whoami()
      .then((data) => {
        const roles = data && Array.isArray(data.roles) ? data.roles : []
        const role = data && data.role === 'doctor' && roles.indexOf('DOCTOR') >= 0 ? 'doctor' : 'patient'
        this.globalData.role = role
        session.setRoleHint(role)
        this.globalData.roleVerifiedAt = Date.now()
        return role === 'doctor'
      })
      .catch(() => false)
  },

  // 全局未捕获异常兜底：框架层异常会回调此处（errMsg 为字符串）。
  // 记录原始信息，避免在控制台/页面只看到 [object Object] 而丢失真实错误。
  onError(errMsg) {
    let info = errMsg
    if (errMsg && typeof errMsg !== 'string' && typeof errMsg.message === 'string') {
      info = errMsg.message + (errMsg.stack ? '\n' + errMsg.stack : '')
    }
    console.error('[global] 未捕获异常：', info)
  },

  // 全局未处理 Promise 拒绝兜底（基础库 ≥2.10 支持）：把拒绝原因转成可读文本再打印。
  // 不接这个钩子时，拒绝一个非 Error 值时控制台只显示 [object Object]，无从定位。
  onUnhandledRejection(res) {
    const reason = res && res.reason
    let info = ''
    if (reason && typeof reason.message === 'string') {
      info = reason.message + (reason.stack ? '\n' + reason.stack : '')
    } else if (reason === undefined || reason === null) {
      info = '(空原因)'
    } else {
      try { info = JSON.stringify(reason) } catch (e) { info = String(reason) }
    }
    console.error('[global] 未处理的 Promise 拒绝：' + info)
  },

  MOCK
})
