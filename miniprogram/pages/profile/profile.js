/**
 * pages/profile —— 我的 / 个人中心（TabBar 页）
 *
 * 版式：design-output/患者端/07-个人中心.png（逐项见 profile.wxml 顶部注释 / §四.6）
 * 数据：GET /api/v1/me（services/user.js#getMe → 契约 UserData）
 *   字段只有 id / displayName / avatarUrl / profileCompleteness / roles / phoneBound / createdAt / updatedAt
 *   ⚠️ 契约 additionalProperties:false，不含性别/年龄/手机号明文 → 页面按「未返回字段不显示」处理。
 *
 * 两项状态位都来自**真实数据**，不做静态假标：
 *   · archiveSynced：存在健康档案记录时才显示「健康档案已同步」
 *   · unread       ：存在未结束的问诊时才显示「我的问诊」未读小圆点
 *   两者失败一律静默降级（不弹错、不伪造），开发兜底档初始值取设计稿同态。
 */
const app = getApp()
const icons = require('../../utils/icons.js')
const userService = require('../../services/user.js')
const ENV = require('../../config/env.js')

Page({
  data: {
    theme: 'standard',
    icons,
    user: { name: '', metaText: '', avatarUrl: '' },
    /* 健康档案是否有记录（决定状态文案第二段） */
    archiveSynced: false,
    /* 我的问诊未读点：默认值 = 设计稿同态（仅开发兜底档），随后由真实列表覆盖 */
    unread: ENV.MOCK_FALLBACK,
    /* 版本号：优先取小程序真实版本（线上有值、开发工具为空）→ 兜底与 settings 页同值 */
    appVersion: 'V1.5.0'
  },

  onLoad() {
    /* 效果图 07 底部「版本 1.0.0」——用真实版本，不硬编码假数据。
       ⚠️ wx.getAccountInfoSync 在低版本基础库不存在 → 必须 try/catch，
       否则整页 onLoad 抛错，后续 onShow 的 setData 也会被连带跳过。 */
    try {
      const info = wx.getAccountInfoSync()
      const v = info && info.miniProgram && info.miniProgram.version
      if (v) this.setData({ appVersion: 'V' + v })
    } catch (e) {
      console.warn('[profile] 取版本号失败，沿用兜底值', e)
    }
  },

  onShow() {
    if (!app.globalData.role) {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    // 先用登录态立即可视（登录响应已含 displayName/avatarUrl），再拉 /me 刷新
    this.setData({ theme: app.globalData.theme || 'standard' })
    this._apply(app.globalData.user)
    // 自绘 TabBar 高亮
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().selectByPath('/pages/profile/profile')
    }
    this._loadMe()
    this._loadBadges()
  },

  /** 契约 GET /api/v1/me 刷新用户信息（失败静默：登录态字段仍可用，不弹错、不伪造） */
  _loadMe() {
    userService.getMe()
      .then((u) => { if (u) this._apply(u) })
      .catch(() => {})
  },

  /**
   * 状态位（并行、静默）：档案记录数 → archiveSynced；未结束问诊 → unread。
   * 设计稿 07 的状态文案与未读圆点都取真实数据，不用静态假值冒充业务状态。
   */
  _loadBadges() {
    userService.listHealthRecords()
      .then((list) => {
        const synced = Array.isArray(list) && list.length > 0
        if (synced === this.data.archiveSynced) return
        this.setData({
          archiveSynced: synced,
          'user.metaText': this._metaText(synced)
        })
      })
      .catch(() => {})

    userService.listMyConsultations()
      .then((list) => { this.setData({ unread: this._hasOpenConsultation(list) }) })
      .catch(() => {})
  },

  /** 是否存在「未结束」的问诊（已关闭/已完成/已取消视为已读） */
  _hasOpenConsultation(list) {
    const CLOSED = /closed|completed|cancelled|canceled|finished|done/i
    return (Array.isArray(list) ? list : []).some(
      (c) => c && !CLOSED.test(String(c.status || ''))
    )
  },

  /** 状态文案：「已登录」恒真（onShow 已保证有登录态），第二段只在确有档案时追加 */
  _metaText(synced) {
    const on = (synced === undefined) ? this.data.archiveSynced : synced
    return on ? '已登录 · 健康档案已同步' : '已登录'
  },

  /**
   * 契约 UserData / 登录 profile → 页面展示字段
   *  - 姓名：displayName 优先，兼容登录态 name
   *  - 头像：有值才走 resolveAvatar（远端绝对地址 / 站内相对路径）；**空值返回空串**，
   *    由 WXML 渲染纯 CSS 灰剪影占位（设计稿的默认头像就是浅灰底灰剪影，
   *    与包内 avatar-default.png 的「蓝底白人形」不一致，故不在本页使用）。
   *  - 副标题：登录状态，不用性别/年龄/手机号（契约根本不返回这些字段）
   *  - 演示兜底仅限 MOCK_FALLBACK 档（README「运行档」：生产档不得有固定前端数据）
   */
  _apply(u) {
    const src = u || (ENV.MOCK_FALLBACK ? app.MOCK.PATIENT : {})
    const name = src.displayName || src.name || '患者'
    this.setData({
      user: {
        name,
        avatarUrl: src.avatarUrl ? userService.resolveAvatar(src.avatarUrl) : '',
        metaText: this._metaText()
      }
    })
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/profile/records/records' })
  },

  goHealthRecords() {
    wx.navigateTo({ url: '/pages/profile/health-records/health-records' })
  },

  goConsultations() {
    wx.navigateTo({ url: '/pages/profile/consultations/consultations' })
  },

  goFamily() {
    wx.navigateTo({ url: '/pages/profile/family/family' })
  },

  goPersonalInfo() {
    wx.navigateTo({ url: '/pages/profile/personal-info/personal-info' })
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/profile/settings/settings' })
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/profile/privacy/privacy' })
  },

  goAgreement() {
    wx.navigateTo({ url: '/pages/profile/agreement/agreement' })
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号吗？',
      success: (res) => {
        if (res.confirm) {
          app.logout()
          wx.reLaunch({ url: '/pages/auth/login/login' })
        }
      }
    })
  },

  /**
   * 设计 07 里有行、但**暂无落地页**的两个入口（消息通知 / 账号安全）→ 显式降级，不伪造页面。
   * ⚠️ 语音设置已从本页移除（设计稿 07 无此行）：入口仍在「设置」页，功能未丢。
   */
  onTodo() {
    wx.showToast({ title: '该功能暂未开放，敬请期待', icon: 'none' })
  }
})
