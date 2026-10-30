/**
 * pages/auth/doctor-login —— 医生手输登录（独立页面，**仅开发构建**）
 * 从主界面「医生登录」进入（微信一键登录失败时降级到此）。
 *
 * 后端：契约 POST /api/v1/doctor/login（WechatLoginRequest）
 *   - ⚠️ 医生登录**与患者同一套令牌机制**，请求体是 {code, phoneCode?, consentVersion}，
 *     没有 username/password（旧注释里的 {username,password} 是过期契约，会 400/422）；
 *   - 角色由服务端按数据库任职关系判定，无任职 → 403（前端只做中文提示，不提权）；
 *   - 开发构建由 service 层用派生 code 走该契约接口（契约不存在密码端点）。
 * ⚠️ 生产构建：本页表单与入口均隐藏。
 */
const app = getApp()
const doctorService = require('../../../services/doctor.js')
const { errText } = require('../../../utils/err-text.js')
const ENV = require('../../../config/env.js')

Page({
  data: {
    account: '',
    pwd: '',
    submitting: false,
    theme: 'standard',
    // 手输登录仅开发构建可用
    manualEnabled: ENV.legacyManualLoginEnabled
  },

  onLoad() {
    // 生产档整页拦截（P0-01 第三道防线）：深链可直接编译本页，不能只靠入口隐藏。
    if (!ENV.legacyManualLoginEnabled) {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    this.setData({ theme: app.globalData.theme || 'standard' })
  },

  onAccountInput(e) { this.setData({ account: e.detail.value }) },
  onPwdInput(e) { this.setData({ pwd: e.detail.value }) },

  // 工号/手机号「登录验证」（设计稿 03：单输入框，无密码框）
  // ⚠️ dev 档走契约派生 code（password 不参与校验，service 层注释明确）；
  //    生产档契约无此端点 → service 层 reject BAD_SPEC，前端转中文提示（不伪造数据）。
  onSubmit() {
    if (this.data.submitting) return
    const account = String(this.data.account || '').trim()
    if (!account) {
      wx.showToast({ title: '请输入工号或手机号', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    wx.showLoading({ title: '登录中...', mask: true })
    doctorService.login(account, '')
      .then((profile) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        this._enter(profile)
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        const code = err && err.code
        if (code === 'FORBIDDEN') {
          wx.showToast({ title: '该账号未登记医生身份，请联系院方', icon: 'none', duration: 2500 })
          return
        }
        if (code === 'BAD_SPEC') {
          wx.showToast({ title: '当前版本请使用微信一键登录', icon: 'none' })
          return
        }
        const msg = errText(err, '登录失败，请重试')
        if (code === 'NO_BASE_URL' || code === 'NETWORK_ERROR' || code === 'TIMEOUT') {
          wx.showToast({ title: '网络连接失败，请检查后重试', icon: 'none', duration: 2500 })
        } else {
          wx.showToast({ title: msg, icon: 'none' })
        }
      })
  },

  onOpenAgreement() {
    wx.navigateTo({ url: '/pages/profile/agreement/agreement' })
  },

  onOpenPrivacy() {
    wx.navigateTo({ url: '/pages/profile/privacy/privacy' })
  },

  /**
   * 微信一键登录（医生端）
   * ⚠️ 两个 code 必须分开：`wx.login()` 得 code；`getPhoneNumber` 的 detail.code 作为 phoneCode。
   * dev 档 provider 只有 dev-user-1/2 两个身份（医生任职登记在 dev-user-2 上），
   * 故本地一键登录可能如实 403 —— 联调请走手输入口；生产配置
   * WECHAT_MINIPROGRAM_APP_ID / APP_SECRET 后由服务端真实 jscode2session 换 openid。
   */
  onWxLogin(e) {
    const detail = e.detail || {}
    if (!detail.code || (detail.errMsg && /deny|fail|refus/i.test(detail.errMsg))) {
      wx.showToast({ title: '无法获取微信手机号，请手动输入', icon: 'none' })
      return
    }
    wx.showLoading({ title: '登录中...', mask: true })
    wx.login({
      success: (res) => {
        if (!res || !res.code) {
          wx.hideLoading()
          wx.showToast({ title: '微信登录失败，请重试', icon: 'none' })
          return
        }
        doctorService.loginByWxCode(this._devCode(res.code), detail.code)
          .then((profile) => {
            wx.hideLoading()
            this._enter(profile)
          })
          .catch((err) => {
            wx.hideLoading()
            if (err && err.code === 'FORBIDDEN') {
              wx.showToast({ title: '该账号未登记医生身份，请联系院方', icon: 'none', duration: 2500 })
              return
            }
            wx.showToast({ title: '无法获取微信手机号，请手动输入', icon: 'none' })
          })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '微信登录失败，请重试', icon: 'none' })
      }
    })
  },

  /**
   * dev/本地构建：微信临时 code 无法被 dev 档 provider 识别（只认 dev-user-1/2），
   * 派生成带 dev-user-2 的契约 code 由服务端真实签发医生会话（演示闭环一键登录）；
   * 生产构建（isProduction）恒走真实 code（服务端 jscode2session）。
   */
  _devCode(code) {
    // 白名单判据（与 services/user.js#login 同源），不再用 !isProduction 黑名单。
    // 没有联调密钥时不派生：派生了也只会被后端 DevLoginGuard 403，不如走真实 code 让失败原因单一。
    if (!ENV.legacyManualLoginEnabled || !ENV.devLoginKey) return code
    return 'dev-user-2-wxlogin-' + Date.now()
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
