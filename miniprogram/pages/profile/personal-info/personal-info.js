/**
 * pages/profile/personal-info —— 个人信息设置（我的 → 个人信息设置）
 *
 * 能力（后端 V8：/api/v1/me/extended / identity / insurance / account / avatar）：
 *  - 头像：button open-type="chooseAvatar"（微信官方头像填写能力）→ 压缩 → multipart 上传
 *  - 姓名：input type="nickname"（官方昵称填写能力），失焦即保存（PUT /me/account）
 *  - 手机号：只展示绑定状态（原文由服务端加密存储，客户端永不接触；重新授权走登录流程）
 *  - 邮箱/住宅/户籍：表单保存（PUT /me/extended）
 *  - 身份证实名：GB 11643 校验码服务端验证，号码密文落库，页面只见掩码（POST /me/identity）
 *  - 医保绑定：类型枚举 + 号码密文（POST /me/insurance）
 * ⚠️ 页面错误文案一律 errText()；证件号/医保号只显示掩码，绝不回显原文。
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const userService = require('../../../services/user.js')
const { errText } = require('../../../utils/err-text.js')

const INSURANCE_TYPES = ['职工基本医疗保险', '城乡居民基本医疗保险', '其他']
const ID_CARD_RE = /^\d{17}[\dXx]$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INSURANCE_NO_RE = /^[A-Za-z0-9]{6,30}$/

Page({
  data: {
    icons,
    theme: 'standard',
    loading: true,
    loadError: '',
    // 基本信息
    avatarUrl: '',
    avatarErr: false,
    avatarText: '我',
    form: { displayName: '', email: '', residence: '', householdRegistration: '' },
    phoneBound: false,
    maskedPhone: '',
    nameFocus: false,
    // 身份证实名
    idVerified: false,
    idName: '',
    idMasked: '',
    showIdForm: false,
    idNameInput: '',
    idNumberInput: '',
    // 医保绑定
    insBound: false,
    insType: '',
    insMasked: '',
    showInsForm: false,
    insuranceTypes: INSURANCE_TYPES,
    insuranceTypeIndex: 0,
    insuranceNoInput: '',
    // 提交中标志（防重复提交）
    savingAvatar: false,
    savingName: false,
    savingContact: false,
    savingId: false,
    savingIns: false
  },

  onShow() {
    if (!app.globalData.role) {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    this.setData({ theme: app.globalData.theme || 'standard' })
    this._loadAll()
  },

  _loadAll() {
    this.setData({ loading: true, loadError: '' })
    Promise.all([userService.getMe(), userService.getExtendedProfile()])
      .then((arr) => {
        this._applyMe(arr[0])
        this._applyExtended(arr[1])
        this.setData({ loading: false })
      })
      .catch((err) => {
        this.setData({ loading: false, loadError: errText(err, '个人信息加载失败，请重试') })
      })
  },

  onRetry() {
    this._loadAll()
  },

  _applyMe(u) {
    const src = u || {}
    const name = src.displayName || ''
    this._savedName = name          // 「上次保存成功的名字」基准，见 onNameBlur 注释
    this.setData({
      avatarUrl: userService.resolveAvatar(src.avatarUrl),
      avatarErr: false,
      avatarText: (name || '我').slice(0, 1),
      'form.displayName': name,
      phoneBound: !!src.phoneBound,
      // 契约 User.maskedPhone：服务端下发的脱敏号（138****1234），未绑定或不可解密时为 null
      maskedPhone: src.maskedPhone || ''
    })
  },

  _applyExtended(e) {
    const d = e || {}
    this.setData({
      'form.email': d.email || '',
      'form.residence': d.residence || '',
      'form.householdRegistration': d.householdRegistration || '',
      idVerified: !!d.idCardVerified,
      idName: d.idCardName || '',
      idMasked: d.idCardMasked || '',
      insBound: !!d.insuranceBound,
      insType: d.insuranceType || '',
      insMasked: d.insuranceMasked || ''
    })
  },

  // ==================== 头像（官方 chooseAvatar 能力） ====================

  onChooseAvatar(e) {
    const src = e && e.detail && e.detail.avatarUrl
    if (!src || this.data.savingAvatar) return
    // 先压缩控制上传体积（压缩失败按原图上传，不阻断）
    wx.compressImage({
      src,
      quality: 60,
      success: (r) => this._uploadAvatar(r.tempFilePath || src),
      fail: () => this._uploadAvatar(src)
    })
  },

  _uploadAvatar(path) {
    this.setData({ savingAvatar: true })
    userService.uploadAvatar(path).then(
      (u) => {
        this._applyMe(u)
        this._syncGlobalUser(u)
        this.setData({ savingAvatar: false })
        wx.showToast({ title: '头像已更新', icon: 'success' })
      },
      (err) => {
        this.setData({ savingAvatar: false })
        wx.showToast({ title: errText(err, '头像上传失败，请重试'), icon: 'none' })
      }
    )
  },

  // ==================== 姓名（官方 nickname 能力，失焦保存） ====================

  /** 输入中同步到 data（否则受控 input 在 setData 后会被回填旧值） */
  onNameInput(e) {
    this.setData({ 'form.displayName': (e && e.detail && e.detail.value) || '' })
  },

  /** 点右侧箭头聚焦姓名输入框（设计稿行尾有箭头，语义是"可编辑"） */
  onFocusName() {
    if (this.data.nameFocus) return
    this.setData({ nameFocus: true })
  },

  /** 头像签名 URL 过期 → 退回 CSS 人形占位（不留白块） */
  onAvatarErr() {
    this.setData({ avatarErr: true })
  },

  onNameBlur(e) {
    const name = String((e && e.detail && e.detail.value) || '').trim()
    this.setData({ nameFocus: false })
    // ⚠️ 输入过程中 onNameInput 已把值写进 form.displayName，
    //    所以必须与"上次保存成功的名字"比较（this._savedName），不能比对 data
    if (!name || name === this._savedName || this.data.savingName) return
    if (name.length > 20) {
      wx.showToast({ title: '姓名最多 20 字', icon: 'none' })
      return
    }
    this.setData({ savingName: true })
    userService.updateAccount(name).then(
      (u) => {
        this._applyMe(u)
        this._syncGlobalUser(u)
        this.setData({ savingName: false })
        wx.showToast({ title: '姓名已保存', icon: 'success' })
      },
      (err) => {
        this.setData({ savingName: false })
        wx.showToast({ title: errText(err, '姓名保存失败，请重试'), icon: 'none' })
      }
    )
  },

  /** 把更新后的契约 User 同步回全局与本地缓存（我的页 onShow 直接可用） */
  _syncGlobalUser(u) {
    if (!u) return
    userService.setUser({
      id: u.id || (app.globalData.user && app.globalData.user.id) || '',
      name: u.displayName || '',
      avatarUrl: userService.resolveAvatar(u.avatarUrl),
      phoneBound: !!u.phoneBound,
      roles: (u.roles || []).slice(),
      role: 'patient'
    })
    app.globalData.user = app.globalData.user || {}
    app.globalData.user.name = u.displayName || ''
    app.globalData.user.avatarUrl = userService.resolveAvatar(u.avatarUrl)
  },

  // ==================== 手机号（仅状态 + 脱敏号展示） ====================

  onPhoneTap() {
    if (this.data.phoneBound) {
      wx.showModal({
        title: '手机号已绑定',
        content: (this.data.maskedPhone ? this.data.maskedPhone + '\n\n' : '') +
          '号码由微信授权获取、服务端加密存储，页面不显示完整号码。如需更换，请退出登录后在登录页重新授权。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    wx.showModal({
      title: '绑定手机号',
      content: '手机号通过微信授权获取。请退出登录后，在登录页使用「微信一键登录」重新授权绑定。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  // ==================== 联系与住址 ====================

  onEmailInput(e) { this.setData({ 'form.email': e.detail.value }) },
  onResidenceInput(e) { this.setData({ 'form.residence': e.detail.value }) },
  onHouseholdInput(e) { this.setData({ 'form.householdRegistration': e.detail.value }) },

  saveContact() {
    if (this.data.savingContact) return
    const email = this.data.form.email.trim()
    if (email && !EMAIL_RE.test(email)) {
      wx.showToast({ title: '邮箱格式不正确', icon: 'none' })
      return
    }
    this.setData({ savingContact: true })
    userService.updateExtendedProfile({
      email,
      residence: this.data.form.residence.trim(),
      householdRegistration: this.data.form.householdRegistration.trim()
    }).then(
      (d) => {
        this._applyExtended(d)
        this.setData({ savingContact: false })
        wx.showToast({ title: '联系信息已保存', icon: 'success' })
      },
      (err) => {
        this.setData({ savingContact: false })
        wx.showToast({ title: errText(err, '保存失败，请重试'), icon: 'none' })
      }
    )
  },

  // ==================== 身份证实名 ====================

  toggleIdForm() {
    this.setData({ showIdForm: !this.data.showIdForm, idNameInput: '', idNumberInput: '' })
  },
  onIdNameInput(e) { this.setData({ idNameInput: e.detail.value }) },
  onIdNumberInput(e) { this.setData({ idNumberInput: e.detail.value }) },

  submitIdentity() {
    if (this.data.savingId) return
    const name = this.data.idNameInput.trim()
    const idNumber = this.data.idNumberInput.trim()
    if (!name) {
      wx.showToast({ title: '请输入姓名', icon: 'none' })
      return
    }
    if (!ID_CARD_RE.test(idNumber)) {
      wx.showToast({ title: '身份证号须为 18 位', icon: 'none' })
      return
    }
    this.setData({ savingId: true })
    userService.bindIdentity(name, idNumber).then(
      (d) => {
        this._applyExtended(d)
        this.setData({ savingId: false, showIdForm: false })
        wx.showToast({ title: '实名认证已完成', icon: 'success' })
      },
      (err) => {
        this.setData({ savingId: false })
        wx.showToast({ title: errText(err, '实名认证失败，请核对信息后重试'), icon: 'none' })
      }
    )
  },

  // ==================== 医保绑定 ====================

  toggleInsForm() {
    this.setData({ showInsForm: !this.data.showInsForm, insuranceNoInput: '' })
  },
  onInsuranceTypeChange(e) {
    this.setData({ insuranceTypeIndex: Number(e.detail.value) || 0 })
  },
  onInsuranceNoInput(e) { this.setData({ insuranceNoInput: e.detail.value }) },

  submitInsurance() {
    if (this.data.savingIns) return
    const type = this.data.insuranceTypes[this.data.insuranceTypeIndex]
    const no = this.data.insuranceNoInput.trim()
    if (!INSURANCE_NO_RE.test(no)) {
      wx.showToast({ title: '医保号须为 6~30 位字母或数字', icon: 'none' })
      return
    }
    this.setData({ savingIns: true })
    userService.bindInsurance(type, no).then(
      (d) => {
        this._applyExtended(d)
        this.setData({ savingIns: false, showInsForm: false })
        wx.showToast({ title: '医保绑定成功', icon: 'success' })
      },
      (err) => {
        this.setData({ savingIns: false })
        wx.showToast({ title: errText(err, '医保绑定失败，请核对后重试'), icon: 'none' })
      }
    )
  }
})
