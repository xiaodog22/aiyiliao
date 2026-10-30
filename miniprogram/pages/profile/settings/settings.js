/**
 * pages/profile/settings —— 系统设置（我的 → 系统设置与关于）
 * 设计稿：design-output/患者端/C-个人中心/10-系统设置.png
 *
 * 三块内容：
 *   ① 服务状态：轮询统一网关 /api/gw/health（30s，onHide/onUnload 立即停表），四态角标
 *   ② 通用设置：音色 / 字号三档 / 高对比 / 语音播报 / 缓存
 *   ③ 关于与隐私：协议 / 隐私政策 / 撤回授权 + 账号注销
 *
 * 偏好全部落本地（无后端接口）：wb_theme（app.setTheme）、wb_high_contrast、wb_voice_read
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const gateway = require('../../../services/gateway.js')
const speech = require('../../../services/speech.js')
const session = require('../../../services/session.js')
const voice = require('../../../services/voice.js')

// 后端健康探针间隔：设置页是低频页面，30s 足够反映"后端是否可用"，
// 且 onHide/onUnload 都会立即停表。
const HEALTH_INTERVAL = 30000

// 高对比开关的本地键（清缓存时必须原样保留，否则用户的无障碍设置会被清掉）
const HC_KEY = 'wb_high_contrast'

// 四态文案：设计稿出现了「在线 / 未知 / 检查中 / 离线」四种
const STATE_TEXT = { online: '在线', checking: '检查中', offline: '离线', unknown: '未知' }

Page({
  data: {
    icons,
    theme: 'standard',
    themeLabel: '标准',
    voiceName: '',
    highContrast: false,
    voiceRead: true,
    healthItems: [],
    sheetOpen: false,
    // 三档：label 用词与 app.wxss 的 .theme-* 语义对齐（large=放大一档，xlarge=最大）
    themeOptions: [
      { value: 'standard', label: '标准', desc: '当前默认字号' },
      { value: 'large', label: '大字', desc: '放大一档，看得更清楚' },
      { value: 'xlarge', label: '超大字', desc: '字号最大，适合视力较弱' }
    ]
  },

  onLoad() {
    const theme = app.globalData.theme || 'standard'
    let hc = false
    try { hc = wx.getStorageSync(HC_KEY) === true } catch (e) { hc = false }
    this.setData({
      theme,
      themeLabel: this._themeLabel(theme),
      highContrast: hc,
      voiceRead: speech.voiceReadEnabled(),
      // 首次探针回来前先给「检查中」：不假装在线，也不谎报离线
      healthItems: this._pendingItems()
    })
  },

  onShow() {
    const vr = speech.voiceReadEnabled()
    if (vr !== this.data.voiceRead) this.setData({ voiceRead: vr })
    this._loadHealth()
    this._loadVoiceName()
    if (this._healthTimer) clearInterval(this._healthTimer)
    this._healthTimer = setInterval(() => this._loadHealth(), HEALTH_INTERVAL)
  },

  onHide() {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null }
  },

  onUnload() {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null }
  },

  /** 浮层/遮罩的空处理器：catchtap / catchtouchmove 必须有绑定，否则会被当未定义方法告警 */
  noop() {},

  /** 取当前字号档中文标签 */
  _themeLabel(value) {
    const hit = this.data.themeOptions.filter((o) => o.value === value)
    return hit.length ? hit[0].label : '标准'
  },

  /** 探针未回 / 正在探测时的占位态 */
  _pendingItems() {
    return ['统一网关', 'AI 问诊 / 语音', '挂号 / 医生'].map((name) => ({
      name, tone: 'checking', stateText: STATE_TEXT.checking
    }))
  },

  /** 单个上游 → 四态。缺字段按「未知」处理，不猜在线 */
  _upItem(name, u) {
    let tone = 'unknown'
    if (u && u.reachable === true) tone = 'online'
    else if (u && u.reachable === false) tone = 'offline'
    return { name, tone, stateText: STATE_TEXT[tone] }
  },

  /** 读当前默认音色名（失败静默：行内回落「默认」，不阻塞设置页） */
  _loadVoiceName() {
    voice.list().then((res) => {
      let name = ''
      res.groups.forEach((g) => g.items.forEach((v) => {
        if (v.id === res.current) name = v.name
      }))
      if (name) this.setData({ voiceName: name })
    }).catch(() => {})
  },

  /**
   * 后端服务状态（网关 + 上游）
   * 响应结构以网关实测为准：{ status: 'ok'|'degraded', upstreams: [{ name, reachable, latencyMs }] }
   * status=down 时网关映射 503 → 走 catch，全部按「离线」展示。
   */
  _loadHealth() {
    gateway.health().then((h) => {
      const list = (h && Array.isArray(h.upstreams)) ? h.upstreams : []
      const byName = {}
      for (const u of list) { if (u && u.name) byName[u.name] = u }
      // 能拿到响应即网关自身可达；网关自报 degraded（有上游异常）→ 网关侧「检查中」
      const gwTone = (h && h.status === 'degraded') ? 'checking' : 'online'
      const items = [
        { name: '统一网关', tone: gwTone, stateText: STATE_TEXT[gwTone] },
        this._upItem('AI 问诊 / 语音', byName.python),
        this._upItem('挂号 / 医生', byName.java)
      ]
      this._pushHealth(items)
    }).catch(() => {
      // 拿不到响应：网关与上游都无从确认，按「离线」而不是「未知」（用户需要知道要排查）
      const items = [
        { name: '统一网关', tone: 'offline', stateText: STATE_TEXT.offline },
        this._upItem('AI 问诊 / 语音', null),
        this._upItem('挂号 / 医生', null)
      ]
      this._pushHealth(items)
    })
  },

  /** 只在状态真的变了才 setData（30s 轮询，避免无谓重渲染） */
  _pushHealth(items) {
    const sig = JSON.stringify(items)
    if (sig === this._healthSig) return
    this._healthSig = sig
    this.setData({ healthItems: items })
  },

  // ==================== 通用设置 ====================

  // 音色管理（列表 / 试听 / 设为默认）
  onVoiceSettings() {
    wx.navigateTo({ url: '/pages/profile/voice-settings/voice-settings' })
  },

  // 字号模式行：设计稿是「值 + 箭头」的行，点开浮层做三档选择
  onThemeRow() {
    this.setData({ sheetOpen: true })
  },

  onSheetClose() {
    if (this.data.sheetOpen) this.setData({ sheetOpen: false })
  },

  // 字号三档切换（全局实时生效：改 data.theme → 根节点 theme-* 类即时换令牌）
  onTheme(e) {
    const value = (e.currentTarget.dataset || {}).value
    if (!value || value === this.data.theme) {
      this.setData({ sheetOpen: false })
      return
    }
    app.setTheme(value)
    this.setData({ theme: value, themeLabel: this._themeLabel(value), sheetOpen: false })
    const label = this._themeLabel(value)
    wx.showToast({ title: '已切换为' + label, icon: 'none' })
  },

  // 高对比模式：落本地并即时作用于本页根节点（.high-contrast 覆盖文字/底色令牌）
  onContrast(e) {
    const on = !!e.detail.value
    this.setData({ highContrast: on })
    try { wx.setStorageSync(HC_KEY, on) } catch (err) {}
  },

  // 语音朗读开关：写入 storage（wb_voice_read），问诊自动朗读全局生效
  onVoiceRead(e) {
    const on = !!e.detail.value
    speech.setVoiceRead(on)
    this.setData({ voiceRead: on })
    wx.showToast({ title: on ? '已开启自动朗读' : '已关闭自动朗读', icon: 'none' })
  },

  onClearCache() {
    wx.showModal({
      title: '清除缓存',
      content: '将清除本地缓存（不影响登录状态），确定继续吗？',
      success: (res) => {
        if (!res.confirm) return
        // ⚠️ clearStorageSync 会连 refresh 令牌一起清掉。原实现只恢复 wb_role/wb_user，
        //   结果是"页面仍显示已登录、令牌却已丢" → 之后每个受保护请求都报登录已过期。
        //   会话按快照原样恢复（TTL 仍走服务端 7 天规则，这里不延长任何有效期）。
        const tokens = session.snapshot()
        const role = app.globalData.role
        const user = app.globalData.user
        const loginAt = wx.getStorageSync('wb_login_at') || 0
        const voiceRead = speech.voiceReadEnabled()
        // 音色偏好同属"用户设置"：清缓存后若丢掉，用户会以为自己的选择被重置了（审查 P2-11）
        const voiceId = speech.currentVoice()
        const voiceRate = speech.currentRate()
        const highContrast = this.data.highContrast
        wx.clearStorageSync()
        // 保留登录态、会话、主题与无障碍偏好（都属于"用户设置"，不该被清缓存重置）
        if (role) wx.setStorageSync('wb_role', role)
        if (user) wx.setStorageSync('wb_user', user)
        if (loginAt) wx.setStorageSync('wb_login_at', loginAt)
        try {
          wx.setStorageSync('wb_theme', app.globalData.theme)
          wx.setStorageSync(HC_KEY, highContrast)
        } catch (err) {}
        speech.setVoiceRead(voiceRead)
        if (voiceId) speech.setCurrentVoice(voiceId)
        if (voiceRate) speech.setCurrentRate(voiceRate)
        session.restore(tokens)
        wx.showToast({ title: '缓存已清除', icon: 'success' })
      }
    })
  },

  // ==================== 关于与隐私 ====================

  onPolicy() {
    wx.navigateTo({ url: '/pages/profile/privacy/privacy' })
  },

  onAgreement() {
    wx.navigateTo({ url: '/pages/profile/agreement/agreement' })
  },

  /**
   * 撤回授权同意：本地没有"撤回"的写接口，能做的是把用户带到微信授权面板，
   * 由其自行关闭已授予的用户信息权限 —— 真操作，不伪造"撤回成功"。
   */
  onRevoke() {
    wx.showModal({
      title: '撤回授权同意',
      content: '撤回后可关闭头像、昵称等授权。关闭后再次使用相关功能时需要重新授权。',
      confirmText: '去设置',
      success: (res) => {
        if (!res.confirm) return
        wx.openSetting({
          fail: () => wx.showToast({ title: '请在微信设置中管理授权', icon: 'none' })
        })
      }
    })
  },

  /** 退出登录：app.logout 只清状态，导航由调用方负责（与 profile/doctor/personal 同范式） */
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号吗？',
      success: (res) => {
        if (!res.confirm) return
        app.logout()
        wx.reLaunch({ url: '/pages/auth/login/login' })
      }
    })
  },

  /** 账号注销：后端无注销接口 → 明确告知，不假装已受理 */
  onLogoutAccount() {
    wx.showModal({
      title: '账号注销',
      content: '账号注销将清除您的全部就诊与健康档案记录，且不可恢复。当前版本尚未开放线上注销，如需办理请联系院内服务台。',
      confirmText: '知道了',
      showCancel: false
    })
  }
})
