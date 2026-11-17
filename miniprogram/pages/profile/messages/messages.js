/**
 * pages/profile/messages —— 患者端消息通知（V21 消息中心补齐）
 *
 * 数据源（契约 MessageCenterItem）：
 *   GET  /api/v1/messages                  列表（read/type/title/body/refType/refId/createdAt）
 *   GET  /api/v1/messages/unread-count     未读数（裸数字）
 *   POST /api/v1/messages/{messageId}/read 标记已读（写操作需 Idempotency-Key）
 *
 * ⚠️ 不伪造：
 *   · 标题/正文/未读数全部来自服务端；没有消息就显示空态，不塞演示通知；
 *   · 报告出具 / 缴费 / 病历查询等类型先做展示映射，等后端事件真正写入 messages 后自动出现；
 *     页面不自行编造这些业务事件。
 *   · 点击消息按 refType 跳真实对象：consultation → 问诊会话；appointment → 挂号记录；
 *     report → 报告详情；未知类型只标已读，不猜路径。
 */
const app = getApp()
const userService = require('../../../services/user.js')
const icons = require('../../../utils/icons.js')
const { errText } = require('../../../utils/err-text.js')
const { fmtLocalDateTime } = require('../../../utils/datetime.js')

const TYPE_META = {
  APPOINTMENT_CREATED: { label: '预约提醒', icon: icons.calendar, tone: 'blue' },
  APPOINTMENT_STATUS: { label: '预约提醒', icon: icons.calendar, tone: 'blue' },
  CONSULT_REPLY: { label: '问诊回复', icon: icons.chat, tone: 'mint' },
  CONSULT_APPLY: { label: '问诊通知', icon: icons.chat, tone: 'mint' },
  REPORT_READY: { label: '报告出具', icon: icons.fileText, tone: 'blue' },
  PAYMENT_DUE: { label: '缴费提醒', icon: icons.fileText, tone: 'amber' },
  RECORD_READY: { label: '病历查询', icon: icons.archive, tone: 'blue' },
  SYSTEM_NOTICE: { label: '系统通知', icon: icons.bell, tone: 'gray' }
}
const DEFAULT_META = { label: '系统通知', icon: icons.bell, tone: 'gray' }

Page({
  data: {
    icons,
    theme: 'standard',
    hc: false,
    statusBarHeight: 20,
    navH: 64,
    loading: true,
    error: '',
    unread: 0,
    messages: []
  },

  onLoad() {
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}
    this.setData({
      theme: app.globalData.theme || 'standard',
      hc: !!app.globalData.highContrast,
      statusBarHeight: sbh,
      navH: sbh + 44
    })
  },

  onShow() {
    if (!app.globalData.role) {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    const theme = app.globalData.theme || 'standard'
    const hc = !!app.globalData.highContrast
    if (theme !== this.data.theme || hc !== this.data.hc) this.setData({ theme, hc })
    this.fetch()
  },

  onBack() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  },

  fetch() {
    this.setData({ loading: true, error: '' })
    return Promise.all([
      userService.unreadCount().catch(() => 0),
      userService.listMessages().catch((err) => {
        this.setData({ error: errText(err, '消息加载失败，请重试') })
        throw err
      })
    ]).then(([unread, list]) => {
      const arr = Array.isArray(list) ? list : []
      this.setData({
        loading: false,
        unread: Number(unread) || 0,
        messages: arr.map((m) => {
          const meta = TYPE_META[m.type] || DEFAULT_META
          const t = fmtLocalDateTime(m.createdAt)
          return {
            id: m.id,
            type: m.type || '',
            typeLabel: meta.label,
            icon: meta.icon,
            tone: meta.tone,
            title: m.title || meta.label,
            body: m.body || '',
            read: m.read === true,
            refType: m.refType || '',
            refId: m.refId || '',
            timeText: (t.date || '') + (t.time ? ' ' + t.time : '')
          }
        })
      })
    }).catch(() => this.setData({ loading: false }))
  },

  onTapMessage(e) {
    const msg = e.currentTarget.dataset.msg
    if (!msg || !msg.id) return
    if (!msg.read) {
      const messages = this.data.messages.map((m) => (m.id === msg.id ? Object.assign({}, m, { read: true }) : m))
      const unread = Math.max(0, this.data.unread - 1)
      this.setData({ messages, unread })
      userService.markMessageRead(msg.id).catch(() => {})
    }
    const refType = String(msg.refType || '')
    if (refType === 'consultation' && msg.refId) {
      wx.navigateTo({ url: '/pages/consult/consult?consultationId=' + encodeURIComponent(msg.refId) })
      return
    }
    if (refType === 'appointment') {
      // 预约类通知：挂号记录页是患者端唯一的预约详情入口
      wx.navigateTo({ url: '/pages/profile/records/records' })
      return
    }
    if (refType === 'report' && msg.refId) {
      wx.navigateTo({ url: '/pages/profile/report-detail/report-detail?recordId=' + encodeURIComponent(msg.refId) })
    }
  },

  onMarkAllRead() {
    const ids = this.data.messages.filter((m) => !m.read).map((m) => m.id)
    if (!ids.length) return
    this.setData({ messages: this.data.messages.map((m) => Object.assign({}, m, { read: true })), unread: 0 })
    ids.forEach((id) => userService.markMessageRead(id).catch(() => {}))
    wx.showToast({ title: '已全部标记为已读', icon: 'none' })
  }
})
