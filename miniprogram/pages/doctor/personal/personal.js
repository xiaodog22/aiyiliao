/**
 * pages/doctor/personal —— 个人管理（医生端）
 *
 * 数据：GET /api/v1/me（config/api.js → API.ME，services/user.js → getMe）
 *   返回 displayName / avatarUrl / maskedPhone（脱敏号，如 138****0000）。
 *   科室（dept）与职称（title）当前**没有接口下发**，只有登录态里带才渲染；
 *   /me 的 additionalProperties:false 也决定了它不会带这两个字段 —— 前端不编造。
 *
 * 版式：design-output/医生端/E-医生端/15-医生个人管理.png（实测见 personal.wxss 头部注释）
 */
const app = getApp()
const userService = require('../../../services/user.js')
const doctorService = require('../../../services/doctor.js')
const icons = require('../../../utils/icons.js')

Page({
  data: {
    theme: 'standard',
    icons,
    statusBarHeight: 20,
    navH: 64,
    doctor: {},
    version: '1.0.0'
  },

  onLoad() {
    if (app.globalData.role !== 'doctor') {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }

    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}

    // 真实版本号：wx.getAccountInfoSync（低版本基础库可能抛错，try/catch 兜底）
    let version = '1.0.0'
    try {
      const info = wx.getAccountInfoSync && wx.getAccountInfoSync()
      if (info && info.miniProgram && info.miniProgram.version) {
        version = info.miniProgram.version
      }
    } catch (e) { /* 低版本基础库忽略 */ }

    this.setData({
      theme: app.globalData.theme || 'standard',
      statusBarHeight: sbh,
      navH: sbh + 44,
      version,
      // 先用登录态兜底渲染，避免 /me 请求期间卡片空着
      doctor: this._merge(app.globalData.user || {})
    })

    this._loadMe()
  },

  /** 拉取服务端认定的当前用户；失败时保留登录态资料，不弹错（资料卡属弱依赖） */
  _loadMe() {
    userService.getMe().then((data) => {
      const me = data || {}
      if (!me.id && !me.displayName) return
      this.setData({ doctor: this._merge(me) })
    }).catch(() => {})
  },

  /**
   * 合成展示用医生资料：
   * 姓名/头像优先取 /me（服务端认定），科室/职称取登录态（若将来下发）；
   * 手机号只认 /me 的 maskedPhone（明文不落前端）。
   */
  _merge(me) {
    const u = app.globalData.user || {}
    const d = app.globalData.doctor || {}
    const name = me.displayName || u.displayName || d.name || ''
    const avatar = me.avatarUrl || u.avatarUrl || d.avatarUrl || ''
    return {
      name,
      title: me.title || u.title || d.title || '',
      dept: me.departmentName || me.dept || u.departmentName || u.dept || '',
      phone: me.maskedPhone || '',
      // avatarUrl 可能是站内相对路径（/api/v1/avatars/x.png）→ 解析成网关绝对地址，
      // 否则 <image src> 会当成包内路径裂图；解析失败回落默认头像。
      avatarUrl: userService.resolveAvatar(avatar)
    }
  },

  onBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
      return
    }
    wx.reLaunch({ url: '/pages/doctor/workbench/workbench' })
  },

  // 三个功能入口：排班设置 / 账号安全 / 消息通知（2026-10-24 已补齐对应页面）
  onEntry(e) {
    const page = e.currentTarget.dataset.page
    const routes = {
      schedule: '/pages/doctor/schedule/schedule',
      'account-security': '/pages/doctor/account-security/account-security',
      messages: '/pages/doctor/messages/messages'
    }
    const url = routes[page]
    if (url) wx.navigateTo({ url })
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前医生账号吗？',
      success: (res) => {
        if (res.confirm) {
          app.logout()
          doctorService.logout()
          wx.reLaunch({ url: '/pages/auth/login/login' })
        }
      }
    })
  }
})
