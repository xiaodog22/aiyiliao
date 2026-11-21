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
    // intent 三态（2026-11-20）：'' = 提交链路被动拉起（同意后返回原页）；
    // 'doctor' / 'patient' = 登录入口主动拉起（同意后直达对应登录页，少点一次）。
    // 旧实现把缺省值当 patient，医生链路会被错误导向患者手输页。
    const raw = options && options.intent
    this._intent = (raw === 'doctor' || raw === 'patient') ? raw : ''
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
      // 主动拉起：同意后直达目标登录页（redirectTo 替换本页，栈里不留同意页）
      if (this._intent === 'doctor') {
        wx.redirectTo({ url: '/pages/auth/doctor-login/doctor-login' })
        return
      }
      if (this._intent === 'patient') {
        wx.redirectTo({ url: '/pages/auth/manual-login/manual-login' })
        return
      }
      // 被动拉起（提交时 CONSENT_REQUIRED）：退回原页，由页面重新读取 isAccepted
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
