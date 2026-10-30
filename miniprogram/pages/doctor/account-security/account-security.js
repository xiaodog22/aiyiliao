/**
 * pages/doctor/account-security —— 账号安全（医生端）
 *
 * 数据：GET /api/v1/me → displayName / maskedPhone / phoneBound（脱敏号，明文不落前端）。
 * ⚠️ 后端当前无「医生修改密码」端点（登录走微信/短信，无密码体系）：
 *    本页做**真实信息展示 + 安全提示**，不伪造可修改的密码框。
 */
const app = getApp()
const userService = require('../../../services/user.js')
const doctorService = require('../../../services/doctor.js')
const icons = require('../../../utils/icons.js')
const { errText } = require('../../../utils/err-text.js')

Page({
  data: {
    icons,
    theme: 'standard',
    statusBarHeight: 20,
    navH: 64,
    account: {}
  },

  onLoad() {
    if (app.globalData.role !== 'doctor') {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}
    this.setData({ theme: app.globalData.theme || 'standard', statusBarHeight: sbh, navH: sbh + 44 })
    this.fetch()
  },

  fetch() {
    userService.getMe()
      .then((me) => {
        const d = me || {}
        this.setData({
          account: {
            name: d.displayName || (app.globalData.user || {}).displayName || '医生',
            phone: d.maskedPhone || '',
            phoneBound: !!d.phoneBound
          }
        })
      })
      .catch((err) => {
        wx.showToast({ title: errText(err, '账号信息加载失败'), icon: 'none' })
      })
  },

  onBack() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.reLaunch({ url: '/pages/doctor/workbench/workbench' })
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
