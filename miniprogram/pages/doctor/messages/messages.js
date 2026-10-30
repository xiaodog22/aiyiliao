/**
 * pages/doctor/messages —— 消息通知（医生端，V21 消息中心）
 *
 * 数据源（契约 MessageCenterItem，backend/contracts/business-openapi.yaml）：
 *   GET  /api/v1/messages                  列表（read/type/title/body/refType/refId/createdAt）
 *   GET  /api/v1/messages/unread-count     未读数（裸数字）
 *   POST /api/v1/messages/{messageId}/read 标记已读（写操作需 Idempotency-Key）
 *
 * ⚠️ 不伪造：
 *   · 消息正文/标题全部来自服务端；未读数由接口返回，不在本地猜；
 *   · 点击未读消息 → 标记已读；若 refType=consultation 且有 refId → 跳医生问诊会话
 *     （只跳服务端给出的对象，不自行构造路径）；其余类型仅标已读。
 */
const app = getApp()
const userService = require('../../../services/user.js')
const doctorService = require('../../../services/doctor.js')
const icons = require('../../../utils/icons.js')
const { errText } = require('../../../utils/err-text.js')
const { fmtLocalDateTime } = require('../../../utils/datetime.js')

Page({
  data: {
    icons,
    theme: 'standard',
    statusBarHeight: 20,
    navH: 64,
    loading: true,
    error: '',
    unread: 0,
    messages: []
  },

  onShow() {
    if (app.globalData.role !== 'doctor') {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    this.fetch()
  },

  onBack() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.reLaunch({ url: '/pages/doctor/workbench/workbench' })
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
          const t = fmtLocalDateTime(m.createdAt)
          return {
            id: m.id,
            type: m.type || '',
            title: m.title || '',
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
    // 未读 → 先标已读（本地乐观更新 + 服务端落库）
    if (!msg.read) {
      const messages = this.data.messages.map((m) => (m.id === msg.id ? Object.assign({}, m, { read: true }) : m))
      const unread = Math.max(0, this.data.unread - 1)
      this.setData({ messages, unread })
      userService.markMessageRead(msg.id).catch(() => {})
    }
    // 会话类消息 → 跳医生问诊会话
    if (msg.refType === 'consultation' && msg.refId) {
      wx.navigateTo({ url: '/pages/doctor/consult/consult?id=' + encodeURIComponent(msg.refId) })
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
