/**
 * pages/auth/login —— 登录主界面（患者端 A-认证 01-登录页）
 *
 * 结构（共三个登录界面）：
 *   1. 本页：入口选择（患者登录 / 医护登录）—— 版式对齐设计稿 01-登录页.png
 *   2. pages/auth/patient-login：患者手输登录（**仅开发构建**，见下方说明）
 *   3. pages/auth/doctor-login：医生手输登录（**仅开发构建**）
 *
 * 登录链路（契约化，两枚 code 必须分开取）：
 *   - 患者：wx.login() 取 **code** + getPhoneNumber 取 **phoneCode**
 *           → POST /api/v1/auth/wechat/login（services/user.js#loginByWxCode）
 *   - 医护：同一交互
 *           → POST /api/v1/doctor/login（services/doctor.js#loginByWxCode）
 *   - 成功后**去向按服务端下发的 user.roles 判定**，不由本页入口参数决定
 *   - 一键登录失败（拒授权/异常）→ 开发构建降级到手输页；生产构建只提示重试
 *
 * ⚠️ 手输登录仅开发构建可用：契约不存在密码端点（详见 services/user.js / doctor.js 注释）。
 * ⚠️ 设计稿只有「欢迎登录 + 两个登录按钮 + 协议行」，故本页不再放辅助入口：
 *    手输登录的入口仍在（失败自动降级）；大字模式入口在「我的 → 隐私设置」页。
 * 界面规范：顶部无标题文字；按钮内仅纯文本，不含图标
 */
const app = getApp()
const userService = require('../../../services/user.js')
const doctorService = require('../../../services/doctor.js')
const ENV = require('../../../config/env.js')
const resource = require('../../../services/resource.js')

// 登录页主视觉（3D 小安）：默认用包内同版文件，清单到达后换成后端下发的地址。
// 为什么远端优先：这张图的 alpha 曾整块缺失，改错图不必重新发版审核。
const ROBOT_ART_KEY = 'home.xiaoan-robot'
const ROBOT_ART_LOCAL = '/assets/home/xiaoan-robot.png'

Page({
  data: {
    theme: 'standard',
    robotArt: ROBOT_ART_LOCAL,
    // 手输登录入口仅开发构建可用（生产只用微信一键登录）
    manualEnabled: ENV.legacyManualLoginEnabled
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'standard' })
    // 已在有效期内登录：跳过登录页直接进入对应端（持久化登录）
    if (app.isLoggedIn()) {
      wx.reLaunch({ url: app.getRoleEntry() })
    }
  },

  // 主题可能在「我的 → 隐私设置」里改过，回到本页时重新同步一次（本页无 TabBar）
  onShow() {
    const theme = app.globalData.theme || 'standard'
    if (theme !== this.data.theme) this.setData({ theme })
    this._syncRobotArt()
  },

  /**
   * 主视觉取图：缓存清单 → 先算一次（二次进入本页可立即命中）；再后台刷新一次清单。
   * 只有拿到「非包内」的地址才换 src，任何一步失败都保持包内图，不出现白框。
   */
  _syncRobotArt() {
    const cached = resource.resourceUrl(ROBOT_ART_KEY, ROBOT_ART_LOCAL)
    if (cached && cached !== ROBOT_ART_LOCAL) this._preloadRobotArt(cached)

    resource.refreshManifest()
      .then(() => {
        const remote = resource.resourceUrl(ROBOT_ART_KEY, ROBOT_ART_LOCAL)
        if (remote && remote !== ROBOT_ART_LOCAL) this._preloadRobotArt(remote)
      })
      .catch(() => {})
  },

  /**
   * 换图前先预热：`<image>` 直接改 src 会先渲染空白帧（大图在弱网下尤其明显）。
   * wx.getImageInfo 成功说明已落缓存，此时再 setData 基本是秒出；失败则不动。
   */
  _preloadRobotArt(remote) {
    if (remote === this.data.robotArt || remote === this._pendingArt) return
    this._pendingArt = remote
    wx.getImageInfo({
      src: remote,
      success: () => {
        // 期间可能已被下一次刷新替换，避免旧地址回写
        if (this._pendingArt === remote) this.setData({ robotArt: remote })
      },
      fail: () => {
        this._pendingArt = ''
        // 静默回退：包内已有同一张图，远端不可达时不应打扰用户
      }
    })
  },

  /** `<image>` 加载失败（域名未配置 / 远端 5xx）→ 退回包内文件 */
  onRobotArtError() {
    if (this.data.robotArt !== ROBOT_ART_LOCAL) {
      this._pendingArt = ''
      this.setData({ robotArt: ROBOT_ART_LOCAL })
    }
  },

  /**
   * 微信手机号一键登录（患者/医护共用入口，data-role 只决定调哪个端点的登录）
   * ⚠️ 必须区分两个 code（此前把 getPhoneNumber 的 code 当 login code 用，生产必失败）：
   *   - code      = `wx.login()` 的临时码 → 服务端换 openid
   *   - phoneCode = `getPhoneNumber` 的 detail.code → 服务端解密手机号
   */
  onGetPhoneNumber(e) {
    // 连点保护：登录请求在途时忽略后续点击（避免重复签发会话 / 重复 showLoading）
    if (this._busy) return
    const intent = e.currentTarget.dataset.role === 'doctor' ? 'doctor' : 'patient'
    const detail = e.detail || {}

    // 用户拒绝授权 / 不支持
    if (!detail.code || (detail.errMsg && /deny|fail|refus/i.test(detail.errMsg))) {
      this._goManual(intent, '未获取到手机号授权')
      return
    }

    this._busy = true
    wx.showLoading({ title: '登录中...', mask: true })
    wx.login({
      success: (res) => {
        if (!res || !res.code) {
          this._busy = false
          wx.hideLoading()
          this._goManual(intent, '微信登录失败，请重试')
          return
        }
        this._login(intent, res.code, detail.code)
      },
      fail: () => {
        this._busy = false
        wx.hideLoading()
        this._goManual(intent, '微信登录失败，请重试')
      }
    })
  },

  /** 调契约登录接口并落会话（token 由 service 层写入 session） */
  _login(intent, code, phoneCode) {
    // dev/本地构建：微信临时 code 无法被 dev 档 provider 识别（它只认 dev-user-1/2 两个身份），
    // 这里把 code 派生成带 dev 身份的契约 code，由服务端**真实签发会话**（非伪造响应），
    // 保证演示闭环可一键登录；生产构建恒走真实 wx.login code。
    // ⚠️ 判据用 legacyManualLoginEnabled（白名单）而不是 !isProduction（黑名单）：
    //    后者在 BUILD_ENV 拼错时会把 dev 派生 code 带进发布包（P0-01）。
    //    且必须同时有联调密钥：后端 DevLoginGuard 要求 X-Dev-Login-Key，缺了必 403。
    let loginCode = code
    if (ENV.legacyManualLoginEnabled && ENV.devLoginKey) {
      const stamp = Date.now()
      loginCode = intent === 'doctor'
        ? 'dev-user-2-wxlogin-' + stamp
        : 'dev-user-1-wxlogin-' + stamp
    }

    const p = intent === 'doctor'
      ? doctorService.loginByWxCode(loginCode, phoneCode)
      : userService.loginByWxCode(loginCode, phoneCode)

    p.then((profile) => {
      this._busy = false
      wx.hideLoading()
      this._enter(profile)
    }).catch((err) => {
      this._busy = false
      wx.hideLoading()
      // 医生端 403：服务端按数据库任职关系如实判定（不做客户端提权）
      if (err && err.code === 'FORBIDDEN') {
        wx.showToast({ title: '该账号未登记医生身份，请联系院方', icon: 'none', duration: 2500 })
        return
      }
      this._goManual(intent, '登录失败，请重试')
    })
  },

  // 跳转到对应手输登录页；生产构建无手输通道 → 只提示重试
  _goManual(intent, tip) {
    if (!this.data.manualEnabled) {
      wx.showToast({ title: tip || '请稍后重试', icon: 'none' })
      return
    }
    if (tip) wx.showToast({ title: tip, icon: 'none' })
    const url = intent === 'doctor'
      ? '/pages/auth/doctor-login/doctor-login'
      : '/pages/auth/patient-login/patient-login'
    wx.navigateTo({ url })
  },

  /** 登录成功进入对应端：去向由**服务端下发的 roles** 决定（不信任入口参数） */
  _enter(profile) {
    const roles = (profile && profile.roles) || []
    const isDoctor = roles.indexOf('DOCTOR') >= 0
    app.setLogin(isDoctor ? 'doctor' : 'patient', profile)
    wx.showToast({ title: '登录成功', icon: 'success' })
    setTimeout(() => {
      if (isDoctor) {
        wx.reLaunch({ url: '/pages/doctor/workbench/workbench' })
      } else {
        wx.switchTab({ url: '/pages/home/home' })
      }
    }, 400)
  },

  // 协议行链接：跳真实协议页（非纯文案，不伪造"已同意"）
  onOpenAgreement() {
    wx.navigateTo({ url: '/pages/profile/agreement/agreement' })
  },

  onOpenPrivacy() {
    wx.navigateTo({ url: '/pages/profile/privacy/privacy' })
  }
})
