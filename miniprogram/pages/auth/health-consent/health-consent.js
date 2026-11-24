/**
 * pages/auth/health-consent/health-consent.js —— 健康数据单独同意页（审计 F4-1）
 *
 * 由 services/health-consent.ensure() 打开；用户勾选并点击“同意并授权”后：
 *   1) POST /api/v1/consents（HEALTH_DATA_PROCESSING；语音入口同时 VOICE_RECORDING）；
 *   2) 通过 eventChannel 通知调用方继续原操作；取消/返回则通知 declined。
 * 不在本页保存“已同意”布尔值 —— 权威状态永远以服务端 consents 记录为准。
 */
const consent = require('../../../services/consent.js')
const healthConsent = require('../../../services/health-consent.js')
const { errText } = require('../../../utils/err-text.js')
const icons = require('../../../utils/icons.js')

Page({
  data: {
    theme: 'normal',
    icons,
    voice: false,
    version: '',
    effectiveAt: '',
    checked: false,
    loading: true,
    granting: false,
    error: ''
  },

  onLoad(options) {
    const app = getApp()
    const theme = (app && app.globalData && app.globalData.theme) || 'normal'
    this.setData({ theme, voice: String((options && options.voice) || '') === '1' })
    this._granted = false
    this._declined = false
    consent.refreshPolicy()
      .then((p) => this.setData({
        version: String((p && p.version) || ''),
        effectiveAt: String((p && p.effectiveAt) || ''),
        loading: false
      }))
      .catch(() => this.setData({
        loading: false,
        error: '授权文本版本加载失败，请检查网络后重试'
      }))
  },

  onToggle() {
    this.setData({ checked: !this.data.checked, error: '' })
  },

  onOpenPolicy() {
    wx.navigateTo({ url: '/pages/profile/privacy/privacy' })
  },

  onAgree() {
    if (this.data.granting) return
    if (!this.data.checked) {
      this.setData({ error: '请先勾选“我已阅读并同意”' })
      return
    }
    if (!this.data.version) {
      this.setData({ error: '授权文本版本未加载，请稍后重试' })
      return
    }
    this.setData({ granting: true, error: '' })
    healthConsent.grant({ voice: this.data.voice })
      .then(() => {
        this._granted = true
        healthConsent.emit(this.getOpenerEventChannel && this.getOpenerEventChannel(), 'granted', true)
        wx.navigateBack({
          fail: () => wx.redirectTo({ url: '/pages/home/home' })
        })
      })
      .catch((err) => {
        this.setData({ granting: false, error: errText(err, '授权失败，请稍后重试') })
      })
  },

  onDecline() {
    this._declined = true
    healthConsent.emit(this.getOpenerEventChannel && this.getOpenerEventChannel(), 'declined', false)
    wx.navigateBack({
      fail: () => wx.redirectTo({ url: '/pages/home/home' })
    })
  },

  onUnload() {
    // 返回手势 / 物理返回：未明确同意时必须让调用方失败关闭，不能挂起原 Promise
    if (!this._granted && !this._declined) {
      healthConsent.emit(this.getOpenerEventChannel && this.getOpenerEventChannel(), 'declined', false)
    }
  }
})
