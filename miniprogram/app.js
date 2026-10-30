/**
 * app.js —— 全局状态（V3.1 纯前端版）
 * 角色路由：登录后按身份自动进入 患者端(TabBar) / 医生端(工作台)
 * 主题管理：standard / large / xlarge 三档（设置页可切换）
 * 登录持久化：登录态写入本地存储，72 小时内免重复登录（超时自动失效）
 */
const MOCK = require('./utils/mock-data.js')
const session = require('./services/session.js')
const { ensureAccessToken, revokeSession } = require('./services/request.js')
const resource = require('./services/resource.js')

// 登录会话有效期：72 小时（毫秒）。超过则需重新登录。
const SESSION_TTL_MS = 72 * 60 * 60 * 1000

App({
  globalData: {
    role: '',           // '' | 'patient' | 'doctor'
    user: null,         // 患者/医生信息
    theme: 'standard'   // standard | large | xlarge
  },

  onLaunch() {
    // 恢复登录态与主题设置
    const role = wx.getStorageSync('wb_role') || ''
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

    // 冷启动会话预热：access token 只驻留内存（重启即丢），这里用持久化的 refresh 先换回 access，
    // 避免首个受保护请求"先吃一个 401 再刷新"。失败静默：无会话 / refresh 过期时由页面守卫引导重登。
    ensureAccessToken().catch(() => {})

    // 非关键远端资源清单后台刷新（docs/v4/09 §4.4-1）：仅写入本地缓存供 resolveResource/fallbackFor
    // 消费；清单或单资源失败一律静默回退内置素材，绝不阻断启动、绝不弹错。
    resource.refreshManifest().catch(() => {})
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

  // 登录成功：写入角色与用户信息（纯前端演示，接入后端后替换为 Token 鉴权）
  setLogin(role, user) {
    this.globalData.role = role
    this.globalData.user = user
    wx.setStorageSync('wb_role', role)
    wx.setStorageSync('wb_user', user)
    wx.setStorageSync('wb_login_at', Date.now())
  },

  /**
   * 退出登录：先撤后端会话，再清本地登录态、会话令牌与上一用户的资料缓存。
   * ⚠️ 顺序不能反：POST /api/v1/auth/logout 需要当前 access token 作 Bearer，
   *    先 session.clear() 会让撤销请求变成匿名请求（后端如实返回 revoked=false，
   *    于是 refresh 链在服务端还能用满 7 天 —— 审查 P1-02）。
   * ⚠️ 撤销是"尽力而为"：断网/超时不得把用户卡在退出流程里，本地照常清干净。
   * ⚠️ access 只驻留内存：2h 过期/进程重启后 getAccessToken() 为空，而 refresh 还在本地。
   *    revokeSession() 内部会先用该 refresh 静默换一次 access 再撤销（审查 D-A-P1-01），
   *    因此这里**不等待**撤销结果——本地清理同步执行，退出 UI 不被网络 RTT 拖住。
   */
  logout() {
    let revoking = null
    try {
      revoking = revokeSession()
    } catch (e) {
      revoking = null
    }
    this.globalData.role = ''
    this.globalData.user = null
    wx.removeStorageSync('wb_role')
    wx.removeStorageSync('wb_user')
    wx.removeStorageSync('wb_login_at')
    // ⚠️ 必须同步清会话（access 内存 + refresh 本地）：否则退出后 refresh token 仍留在 storage，
    //    ensureAccessToken() 还能换回可用 access —— 用户以为已退出，其实会话仍在。
    session.clear()
    // 上一用户的资料缓存不属于"登录态"，但留着会被下一个登录者读到（审查 AUTH-23）。
    // 所有退出入口（我的 / 设置 / 医生个人 / 账号安全）都走这里，集中清理避免漏项。
    try { require('./services/user.js').logout() } catch (e) {}
    try { require('./services/doctor.js').logout() } catch (e) {}
    return revoking || Promise.resolve(false)
  },

  // 切换主题档位
  setTheme(theme) {
    this.globalData.theme = theme
    wx.setStorageSync('wb_theme', theme)
  },

  // 获取当前角色对应首页路由
  getRoleEntry() {
    return this.globalData.role === 'doctor'
      ? '/pages/doctor/workbench/workbench'
      : '/pages/home/home'
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
