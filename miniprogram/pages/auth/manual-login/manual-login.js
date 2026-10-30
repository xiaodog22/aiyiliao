/**
 * pages/auth/manual-login —— 手动登录降级页
 * 从 patient-login 微信一键登录失败（无法获取手机号）时 navigateTo 进入。
 * 提供手机号+密码表单；成功后按服务端 roles 进入患者端/医生端。
 * 底部"返回微信一键登录"回到 patient-login。
 */
const app = getApp()
const userService = require('../../../services/user.js')
const { errText } = require('../../../utils/err-text.js')
const ENV = require('../../../config/env.js')

Page({
  data: {
    phone: '',
    pwd: '',
    showPwd: false,
    submitting: false,
    agreed: false,
    theme: 'standard'
  },

  onLoad() {
    // 生产档整页拦截（P0-01 第三道防线）：深链可直接编译本页，不能只靠入口隐藏。
    if (!ENV.legacyManualLoginEnabled) {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    this.setData({ theme: app.globalData.theme || 'standard' })
  },

  onPhoneInput(e) { this.setData({ phone: e.detail.value }) },
  onPwdInput(e) { this.setData({ pwd: e.detail.value }) },

  togglePwd() { this.setData({ showPwd: !this.data.showPwd }) },

  onToggleAgreement() { this.setData({ agreed: !this.data.agreed }) },

  onOpenAgreement() {
    wx.navigateTo({ url: '/pages/profile/agreement/agreement' })
  },

  onOpenPrivacy() {
    wx.navigateTo({ url: '/pages/profile/privacy/privacy' })
  },

  onSubmit() {
    if (this.data.submitting) return
    const { phone, pwd } = this.data
    if (!/^1\d{10}$/.test(String(phone || '').trim())) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' })
      return
    }
    if (!pwd) {
      wx.showToast({ title: '请输入密码', icon: 'none' })
      return
    }
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意用户协议与隐私政策', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    wx.showLoading({ title: '登录中...', mask: true })
    userService.login(phone.trim(), pwd)
      .then((profile) => {
        wx.hideLoading()
        this._enter(profile)
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        const msg = errText(err, '登录失败，请重试')
        wx.showToast({ title: msg, icon: 'none' })
      })
  },

  _enter(profile) {
    const roles = (profile && profile.roles) || []
    const isDoctor = roles.indexOf('DOCTOR') >= 0
    app.setLogin(isDoctor ? 'doctor' : 'patient', profile)
    wx.showToast({ title: '登录成功', icon: 'success' })
    setTimeout(() => {
      if (isDoctor) wx.reLaunch({ url: '/pages/doctor/workbench/workbench' })
      else wx.switchTab({ url: '/pages/home/home' })
    }, 400)
  },

  // 返回微信一键登录页
  onBackToWx() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/auth/patient-login/patient-login' }) })
  }
})
