/*
 * pages/auth/consent —— 独立隐私政策同意页（审计 M11）
 *
 * 登录前必须进入本页：展示服务端当前版本号 + 政策全文（复用 privacy.wxml，避免两份文本漂移），
 * 用户勾选并点击“同意”后才把版本号与点击时间戳写入本地；登录请求携带该版本。
 * 版本轮换后旧同意自动失效（consent.isAccepted 同时校验版本与时间戳）。
 */
const app = getApp()
const consent = require('../../../services/consent.js')

Page({
  data: {
    theme: 'standard',
    updatedAt: '',
    version: '',
    title: '隐私政策',
    checked: false,
    loading: true,
    error: ''
  },

  onLoad(options) {
    this._intent = options && options.intent === 'doctor' ? 'doctor' : 'patient'
    this.setData({ theme: app.globalData.theme || 'standard' })
    this.loadPolicy()
  },

  loadPolicy() {
    consent.refreshPolicy()
      .then((p) => {
        this.setData({
          loading: false,
          error: '',
          version: String(p.version || ''),
          updatedAt: String(p.effectiveAt || ''),
          title: String(p.title || '隐私政策')
        })
      })
      .catch(() => {
        this.setData({ loading: false, error: '无法获取当前隐私政策版本，请检查网络后重试' })
      })
  },

  onToggle() {
    this.setData({ checked: !this.data.checked })
  },

  onAgree() {
    if (!this.data.checked) {
      wx.showToast({ title: '请先勾选同意', icon: 'none' })
      return
    }
    if (!this.data.version) {
      wx.showToast({ title: '政策版本未加载，请重试', icon: 'none' })
      return
    }
    try {
      consent.accept(this.data.version)
      // 记录后返回登录页；登录页会重新读取 isAccepted，再允许发起登录。
      wx.navigateBack({
        delta: 1,
        success: () => {
          const pages = getCurrentPages()
          const prev = pages && pages.length ? pages[pages.length - 1] : null
          if (prev && typeof prev.refreshConsentState === 'function') prev.refreshConsentState()
        }
      })
    } catch (e) {
      wx.showToast({ title: '同意记录失败，请重试', icon: 'none' })
    }
  },

  onOpenPrivacy() {
    wx.navigateTo({ url: '/pages/profile/privacy/privacy' })
  }
})
