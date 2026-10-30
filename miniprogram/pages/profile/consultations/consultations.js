/**
 * pages/profile/consultations —— 我的问诊（我的 → 我的问诊）
 *
 * 版式（设计稿 design-output/患者端/C-个人中心/07-我的问诊.png）：
 *   白卡 × N —— 科室标题 + 状态徽章 / 日期时间 / 摘要（单行截断）/ 分隔线 + 右对齐「查看详情」
 *   ⚠️ 设计稿**没有**状态筛选 tab、也没有医生头像与姓名 → 本页不做（见 DEV_LOG 偏离项）。
 *
 * 数据源：GET /api/v1/consultations（契约 Consultation[]，见 backend/contracts/business-openapi.yaml）
 *   id / title? / status（ACTIVE|CLOSED|ARCHIVED）/ summary? / lastMessageAt? / messageCount / createdAt
 *   2026-10-19 契约追加 doctorName / doctorTitle / departmentName / accepting（供在线问诊页医生卡）；
 *   本页设计稿不展示医生信息，故只取 title / status / 时间 / 摘要。
 *
 * 点击卡片 → /pages/consult/consult?consultationId=（在线问诊会话页，navigateTo）
 * 降级（与挂号记录页同一口径）：
 *   - 加载中：骨架屏；开发档（MOCK_FALLBACK）后端不可用 → 演示数据；上线档 → 错误态 + 重试。
 */
const app = getApp()
const { paginate } = require('../../../utils/paginate.js')
const icons = require('../../../utils/icons.js')
const userService = require('../../../services/user.js')
const { withFallback } = require('../../../services/request.js')
const { errText } = require('../../../utils/err-text.js')
const { fmtLocalDateTime } = require('../../../utils/datetime.js')

/** 契约状态 → 展示文案（设计稿 07 的三个词：问诊中 / 已完成 / 已结束；未知值原样透传） */
const STATUS_TEXT = { ACTIVE: '问诊中', CLOSED: '已完成', ARCHIVED: '已结束' }

/** 状态 → 徽章配色档（只决定视觉，不改变 statusText 本身） */
const STATUS_TONE = { ACTIVE: 'blue', CLOSED: 'mint', ARCHIVED: 'gray' }

/** 徽章配色：优先按契约枚举；演示数据/后端直接下发中文时按文案兜底 */
function toneOf(raw, text) {
  const tone = STATUS_TONE[String(raw || '').toUpperCase()]
  if (tone) return tone
  if (text === '问诊中' || text === '进行中') return 'blue'
  if (text === '已完成') return 'mint'
  return 'gray'
}

/** 契约会话记录 → 页面字段（未返回字段留空不显示） */
function normalize(list) {
  return (Array.isArray(list) ? list : []).map((c) => {
    const when = fmtLocalDateTime(c.lastMessageAt || c.createdAt)
    const statusText = STATUS_TEXT[String(c.status || '').toUpperCase()] || String(c.status || '')
    return {
      id: c.id || '',
      // 契约 title 可空 → 用真实科室名兜底，仍无则「在线问诊」（不编造科室/医生）
      title: c.title || (c.departmentName ? c.departmentName + '咨询' : '在线问诊'),
      statusText,
      tone: toneOf(c.status, statusText),
      dateText: [when.date, when.time].filter(Boolean).join(' '),
      // 摘要优先取后端 summary；缺省退化为消息数（都缺则留空，wxml 不渲染该行）
      brief: c.summary || (c.messageCount ? '共 ' + c.messageCount + ' 条对话' : '')
    }
  })
}

/** 演示兜底：mock CONSULTATIONS → 契约同形（仅开发档可达） */
function mockConsultations() {
  return ((app && app.MOCK && app.MOCK.CONSULTATIONS) || []).map((c) => ({
    id: c.id,
    title: c.type,
    status: c.status,
    summary: c.brief,
    lastMessageAt: c.date
  }))
}

Page({
  data: {
    theme: 'standard',
    icons,
    all: [],
    displayed: [],
    page: 1,
    hasMore: false,
    total: 0,
    loading: true,
    error: ''
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'standard' })
    this.fetch()
  },

  /** 拉取问诊记录（全量 → 归一化 → 客户端分页首屏） */
  fetch() {
    this.setData({ loading: true, error: '' })
    return withFallback(userService.listMyConsultations(), mockConsultations)
      .then((list) => {
        const p = paginate(normalize(list), 1)
        this.setData({
          all: p.all, displayed: p.displayed, page: p.page,
          hasMore: p.hasMore, total: p.total, loading: false
        })
      })
      .catch((err) => {
        this.setData({
          all: [], displayed: [], page: 1, hasMore: false, total: 0,
          loading: false, error: errText(err, '问诊记录加载失败，请重试')
        })
      })
  },

  // 上拉触底：首屏只渲染部分，触底追加下一页
  onReachBottom() {
    if (!this.data.hasMore) return
    const p = paginate(this.data.all, this.data.page + 1)
    this.setData({ displayed: p.displayed, page: p.page, hasMore: p.hasMore })
  },

  /** 查看详情：进会话页（该页自带错误态，消息未实现时不会伪造对话内容） */
  onView(e) {
    const id = (e.currentTarget.dataset || {}).id || ''
    if (!id) {
      wx.showToast({ title: '该记录暂无会话详情', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/consult/consult?consultationId=' + encodeURIComponent(id) })
  },

  /** 空态「去问医生」：AI 问诊是 TabBar 页，必须 switchTab */
  onGoConsult() {
    wx.switchTab({ url: '/pages/consultation/consultation' })
  }
})
