/**
 * pages/auth/patient-login —— 患者手输登录（独立页面）
 * 从主界面「个人账号登录」进入，或微信一键登录失败时降级进入（**仅开发构建**）。
 *
 * 后端：契约 POST /api/v1/auth/wechat/login（WechatLoginRequest）
 *   - 契约不存在密码端点，开发构建由 service 层用派生 code/phoneCode 走该契约接口；
 *   - 成功后 token 由 service 层写入 session；去向按**服务端下发的 roles** 判定。
 * ⚠️ 生产构建：本页表单与入口均隐藏（契约无密码体系）。
 */
const app = getApp()
const userService = require('../../../services/user.js')
const { errText } = require('../../../utils/err-text.js')
const ENV = require('../../../config/env.js')

Page({
  data: {
    phone: '',
    pwd: '',
    submitting: false,
    theme: 'standard',
    // 协议勾选：设计稿 02 默认不勾，勾选前不发起登录
    agreed: false,
    // 手输登录仅开发构建可用
    manualEnabled: ENV.legacyManualLoginEnabled
  },

  onLoad() {
    // 生产档整页拦截：入口隐藏只是第一层，深链/扫码/调试器仍可直接打开本页。
    // 契约没有密码体系，生产档不存在合法的"手输登录"，直接退回一键登录页（P0-01 第三道防线）。
    if (!ENV.legacyManualLoginEnabled) {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    this.setData({ theme: app.globalData.theme || 'standard' })
  },

  onPhoneInput(e) { this.setData({ phone: e.detail.value }) },
  onPwdInput(e) { this.setData({ pwd: e.detail.value }) },

  // 协议勾选切换（点整行任意处都切换；链接本身用 catchtap 不触发）
  onToggleAgreement() {
    this.setData({ agreed: !this.data.agreed })
  },

  onOpenAgreement() {
    wx.navigateTo({ url: '/pages/profile/agreement/agreement' })
  },

  onOpenPrivacy() {
    wx.navigateTo({ url: '/pages/profile/privacy/privacy' })
  },

  onSubmit() {
    if (!this.data.manualEnabled) {
      wx.showToast({ title: '当前版本仅支持微信一键登录', icon: 'none' })
      return
    }
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
    // 合规：协议未勾选不得登录。onWxLogin 分支本来就有这道判断，手输分支此前漏了
    // （审查 P1-01）—— 未同意隐私政策的用户也能完成登录，属合规缺口。
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意《用户协议》《隐私政策》', icon: 'none' })
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
        const code = err && err.code
        const msg = errText(err, '登录失败，请重试')
        if (code === 'NO_BASE_URL' || code === 'NETWORK_ERROR' || code === 'TIMEOUT') {
          wx.showToast({ title: '网络连接失败，请检查后重试', icon: 'none', duration: 2500 })
        } else {
          wx.showToast({ title: msg, icon: 'none' })
        }
      })
  },

  /**
   * 微信一键登录（本页也提供，失败时提示并留在当前页手输）
   * ⚠️ 两个 code 必须分开：`wx.login()` 得 code；`getPhoneNumber` 的 detail.code 作为 phoneCode。
   */
  onWxLogin(e) {
    // 连点保护：其余三个登录页都有在途守卫，本页此前缺（审查 P2-02）——
    // 快速连点会重复 wx.login + 重复 loginByWxCode（后端幂等能吸收，但属无谓请求）。
    if (this._busy) return
    const detail = e.detail || {}

    // 协议未勾选：不提交（用户已授权手机号，前端不发起登录）
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意《用户协议》《隐私政策》', icon: 'none' })
      return
    }
    // 用户拒绝授权 / 不支持：跳转手动登录降级页
    if (!detail.code || (detail.errMsg && /deny|fail|refus/i.test(detail.errMsg))) {
      wx.navigateTo({ url: '/pages/auth/manual-login/manual-login' })
      return
    }
    this._busy = true
    wx.showLoading({ title: '登录中...', mask: true })
    wx.login({
      success: (res) => {
        if (!res || !res.code) {
          this._busy = false
          wx.hideLoading()
          wx.showToast({ title: '微信登录失败，请重试', icon: 'none' })
          return
        }
        userService.loginByWxCode(res.code, detail.code)
          .then((profile) => {
            wx.hideLoading()
            this._enter(profile)
          })
          .catch(() => {
            this._busy = false
            wx.hideLoading()
            // 后端无法获取手机号 → 降级到手输登录
            wx.navigateTo({ url: '/pages/auth/manual-login/manual-login' })
          })
      },
      fail: () => {
        this._busy = false
        wx.hideLoading()
        wx.showToast({ title: '微信登录失败，请重试', icon: 'none' })
      }
    })
  },

  /** 去向由**服务端下发的 roles** 决定（客户端不自判角色） */
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

  onBack() {
    // 栈首直接打开本页时 navigateBack 会失败 → 兜底回登录入口（不把错误对象抛给控制台）
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/auth/login/login' }) })
  }
})
