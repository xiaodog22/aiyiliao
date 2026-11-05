/**
 * pages/profile/reports —— 电子检查报告列表（V27）
 *
 * 数据源：GET /api/v1/reports（ReportSummaryData[]），后端已按报告时间倒序并完成
 *   分类/状态/时间/就诊人筛选；页面不自行排序或补数据。
 * 红线：报告属于真实业务数据，**不使用 withFallback 演示兜底**。后端不可用时显示
 *   错误态（文案走 utils/err-text.js），不伪造报告编号、机构或结论。
 * 状态：REVIEWING / PENDING 只在卡片上显示文字状态，结果由后端门禁拦截。
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const userService = require('../../../services/user.js')
const { errText } = require('../../../utils/err-text.js')

const TABS = [
  { key: '', label: '全部报告' },
  { key: 'LAB', label: '检验报告' },
  { key: 'IMAGING', label: '影像检查' },
  { key: 'CHECKUP', label: '体检报告' }
]
const STATUSES = [
  { key: '', label: '全部状态' },
  { key: 'READY', label: '已出报告' },
  { key: 'REVIEWING', label: '待审核' },
  { key: 'PENDING', label: '待出结果' }
]
const STATUS_TEXT = { READY: '已出报告', REVIEWING: '待审核', PENDING: '待出结果' }
const STATUS_CLS = { READY: 'ok', REVIEWING: 'wait', PENDING: 'wait' }

/** ISO 时间 → 'YYYY-MM-DD HH:mm'；后端时间按 UTC 口径保存，此处只做展示切片不换算时区。 */
function fmt(v) {
  return v ? String(v).replace('T', ' ').slice(0, 16) : ''
}

function normalize(list) {
  return (list || []).map(function (r) {
    var count = Number(r.abnormalCount) || 0
    var status = r.reportStatus || ''
    return {
      recordId: r.recordId,
      reportNo: r.reportNo || '',
      title: r.title || '检查报告',
      institutionName: r.institutionName || '',
      departmentName: r.departmentName || '',
      patientName: r.patientName || '',
      status: status,
      statusText: STATUS_TEXT[status] || '状态未知',
      statusCls: STATUS_CLS[status] || 'unknown',
      recordedAt: fmt(r.recordedAt),
      reportedAt: fmt(r.reportedAt),
      abnormalCount: count,
      // 异常不靠颜色：始终给文字；0 项只说「未提示异常」，不冒充「全部正常」
      abnormalText: status !== 'READY'
        ? '结果暂不展示'
        : (count > 0 ? '异常项目 ' + count + ' 项' : '未提示异常项目'),
      isDemo: !!r.isDemo
    }
  })
}

Page({
  data: {
    icons,
    theme: 'standard',
    tabs: TABS,
    activeTab: '',
    statuses: STATUSES,
    statusIndex: 0,
    members: [{ id: '', name: '全部就诊人' }],
    memberIndex: 0,
    from: '',
    to: '',
    items: [],
    loading: true,
    error: ''
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'standard' })
    this.loadMembers()
    this.fetch()
  },

  /** 就诊人切换：只取后端真实家庭成员，不做本地假成员。 */
  loadMembers() {
    return userService.listFamilyMembers()
      .then((list) => {
        const members = [{ id: '', name: '全部就诊人' }].concat(
          (list || []).map((m) => ({ id: m.id, name: m.displayName || m.name || '家庭成员' })))
        this.setData({ members: members, memberIndex: 0 })
      })
      .catch(() => { /* 就诊人列表不可用不阻塞报告查询：保留「全部就诊人」 */ })
  },

  fetch() {
    this.setData({ loading: true, error: '' })
    const params = { limit: 50 }
    const status = this.data.statuses[this.data.statusIndex] || {}
    const member = this.data.members[this.data.memberIndex] || {}
    if (this.data.activeTab) params.reportType = this.data.activeTab
    if (status.key) params.status = status.key
    if (member.id) params.familyMemberId = member.id
    if (this.data.from) params.from = this.data.from
    if (this.data.to) params.to = this.data.to

    return userService.listReports(params)
      .then((list) => {
        this.setData({ items: normalize(list), loading: false })
      })
      .catch((err) => {
        this.setData({ items: [], loading: false, error: errText(err) })
      })
  },

  onTab(e) {
    const key = e.currentTarget.dataset.key || ''
    if (key === this.data.activeTab) return
    this.setData({ activeTab: key })
    this.fetch()
  },

  onStatus(e) {
    this.setData({ statusIndex: Number(e.detail.value) || 0 })
    this.fetch()
  },

  onMember(e) {
    this.setData({ memberIndex: Number(e.detail.value) || 0 })
    this.fetch()
  },

  onFrom(e) {
    this.setData({ from: e.detail.value })
    this.fetch()
  },

  onTo(e) {
    this.setData({ to: e.detail.value })
    this.fetch()
  },

  onClearFilter() {
    this.setData({ activeTab: '', statusIndex: 0, memberIndex: 0, from: '', to: '' })
    this.fetch()
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/profile/report-detail/report-detail?recordId=' + encodeURIComponent(id) })
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh())
  }
})
