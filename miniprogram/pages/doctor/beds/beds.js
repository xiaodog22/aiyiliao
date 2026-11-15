/**
 * pages/doctor/beds —— 床位管理（医生端·申请制，2026-11-15）
 *
 * 数据：GET  /api/v1/beds（config/api.js → API.BED_LIST，services/doctor.js → listBeds）
 *       GET  /api/v1/beds/applications（我的申请列表，services/doctor.js → listBedApplications）
 *       POST /api/v1/beds/applications（提交申请，Idempotency-Key 必填）
 *
 * 申请制口径：医生端**不再直接改床位状态**（ASSIGN/RELEASE 留给护士站），
 *   对空闲床位只能「申请床位」→ 生成 PENDING 申请单 → 由病区护士站/住院处审批；
 *   审批通过且指定了床位时后端在同一事务内落床。
 *
 * 契约要点（backend · BedApplicationRequest / BedApplicationData）：
 *   · patientRef 只接受内部患者 ID，姓名/手机号一律 422 → 抽屉里只收 patientRef
 *   · reason ≤200；priority 只认 NORMAL / URGENT，其余按 NORMAL
 *   · 申请状态：PENDING（待审批）/ APPROVED（已通过）/ REJECTED（已驳回）/ CANCELLED（已撤销）
 *   · 中文文案与配色**只在本文件**映射（BED_META / APP_META），模板不写英文判断
 *
 * 版式：design-output/医生端/E-医生端/14-床位管理.png（实测见 beds.wxss 头部注释）
 * 增强项：顶部四列统计 + 病区横滑筛选（仅 ≥2 个病区时出现）+ 我的申请列表（申请制新增）
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const doctorService = require('../../../services/doctor.js')
const { errText } = require('../../../utils/err-text.js')
const { paginate } = require('../../../utils/paginate.js')
const req = require('../../../services/request.js')

/* 床位状态 → 中文 / 卡片配色 / 是否可申请。未识别状态一律按「维修中」中性展示，不猜测语义。 */
const BED_META = {
  AVAILABLE: { text: '空闲', cls: 'avail', canApply: true },
  OCCUPIED: { text: '占用', cls: 'occ' },
  RESERVED: { text: '已预留', cls: 'reserved' },
  CLEANING: { text: '待消毒', cls: 'clean' },
  OUT_OF_SERVICE: { text: '维修中', cls: 'off' }
}

/* 申请状态 → 中文 / 标签配色。未识别状态按「待审批」中性展示，不猜测语义。 */
const APP_META = {
  PENDING: { text: '待审批', cls: 'pending' },
  APPROVED: { text: '已通过', cls: 'approved' },
  REJECTED: { text: '已驳回', cls: 'rejected' },
  CANCELLED: { text: '已撤销', cls: 'cancelled' }
}

/* 图例固定三项（设计稿），出现待消毒/已预留床位时再追加对应项 */
const LEGEND_BASE = [
  { cls: 'free', text: '空闲' },
  { cls: 'occ', text: '占用' },
  { cls: 'off', text: '维修中' }
]
const LEGEND_EXTRA = {
  CLEANING: { cls: 'clean', text: '待消毒' },
  RESERVED: { cls: 'reserved', text: '已预留' }
}

Page({
  data: {
    theme: 'standard',
    icons,
    statusBarHeight: 20,
    navH: 64,

    loading: true,
    error: '',

    /** 全量床位（映射后的视图行） */
    all: [],
    /** 病区筛选项（[{id, name}]，仅在 ≥2 个时渲染 tabs） */
    wards: [],
    /** 当前病区（'' = 全部） */
    wardId: '',

    /** 四列统计：总床位 / 占用 / 空闲 / 待消毒 */
    stats: [
      { key: 'total', label: '总床位', value: 0 },
      { key: 'occ', label: '占用', value: 0 },
      { key: 'free', label: '空闲', value: 0 },
      { key: 'clean', label: '待消毒', value: 0 }
    ],

    legend: LEGEND_BASE.slice(),

    displayed: [],
    page: 1,
    hasMore: false,

    /** 我的床位申请（视图行）与加载态 */
    apps: [],
    appsLoading: true,
    appsError: '',

    /* 申请抽屉（仅 AVAILABLE 床位可发起） */
    showApply: false,
    applyBedId: '',
    applyBedNo: '',
    applyWardId: '',
    applyPatientRef: '',
    applyReason: '',
    applyPriority: 'NORMAL',
    applyErr: '',
    applying: false,
    /* 同一抽屉内重试用同一幂等键，避免重复提交产生多张申请单 */
    idemKey: ''
  },

  onLoad() {
    if (app.globalData.role !== 'doctor') {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}
    this.setData(
      { theme: app.globalData.theme || 'standard', statusBarHeight: sbh, navH: sbh + 44 },
      () => { this.fetch(); this.fetchApplications() }
    )
  },

  onShow() {
    // 从抽屉/其他页返回时静默刷新申请列表（审批结果可能已变化）
    if (this.data.apps.length || this.data.appsError) this.fetchApplications()
  },

  onBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
      return
    }
    // 栈底（开发者工具直接打开 / 从登录页 reLaunch 进来）：回工作台，不假装能返回
    wx.reLaunch({ url: '/pages/doctor/workbench/workbench' })
  },

  /* ============ 床位数据（只读展示） ============ */

  fetch() {
    if (this._loading) return           // 重试按钮连点保护
    this._loading = true
    this.setData({ loading: true, error: '' })

    doctorService.listBeds().then((data) => {
      const rows = Array.isArray(data) ? data : ((data && data.beds) || [])
      const all = rows.map(toViewRow)
      const wards = buildWards(all)
      this.setData({ all, wards, loading: false }, () => {
        // 病区列表变了（例如授权调整），当前选中的病区已不存在 → 回落到「全部」
        if (this.data.wardId && !wards.some((w) => w.id === this.data.wardId)) {
          this.setData({ wardId: '' }, () => this._applyFilter())
          return
        }
        this._applyFilter()
      })
    }).catch((err) => {
      this.setData({
        loading: false,
        error: errText(err, '床位信息加载失败，请重试'),
        all: [],
        wards: [],
        wardId: '',
        displayed: [],
        hasMore: false,
        legend: LEGEND_BASE.slice()
      })
    }).then(() => {
      this._loading = false
    })
  },

  /* ============ 我的床位申请 ============ */

  fetchApplications() {
    if (this._appsLoading) return
    this._appsLoading = true
    this.setData({ appsLoading: true, appsError: '' })
    doctorService.listBedApplications().then((list) => {
      this.setData({ apps: (Array.isArray(list) ? list : []).map(toAppRow), appsLoading: false })
    }).catch((err) => {
      this.setData({ apps: [], appsLoading: false, appsError: errText(err, '申请记录加载失败') })
    }).then(() => {
      this._appsLoading = false
    })
  },

  /* ============ 申请抽屉 ============ */

  onApplyTap(e) {
    if (this.data.applying) return
    const ds = e.currentTarget.dataset
    this.setData({
      showApply: true,
      applyBedId: String(ds.id || ''),
      applyBedNo: String(ds.no || ''),
      applyWardId: String(ds.ward || ''),
      applyPatientRef: '',
      applyReason: '',
      applyPriority: 'NORMAL',
      applyErr: '',
      idemKey: req.newIdempotencyKey()
    })
  },

  onApplyInput(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [field]: e.detail.value })
  },

  onPriorityTap(e) {
    const p = String(e.currentTarget.dataset.p || '').toUpperCase()
    // 只认 NORMAL / URGENT，其余档位不响应（与后端 normalizedPriority 同口径）
    if (p !== 'NORMAL' && p !== 'URGENT') return
    this.setData({ applyPriority: p })
  },

  closeApply() {
    if (this.data.applying) return       // 提交中不允许关闭，避免状态错位
    this.setData({ showApply: false, applyErr: '' })
  },

  confirmApply() {
    if (this.data.applying) return
    const ref = String(this.data.applyPatientRef || '').trim()
    if (!ref) {
      this.setData({ applyErr: '请填写患者内部 ID（patientRef）' })
      return
    }
    // 与后端同口径的前置拦截：手机号一律 422，提前提示省一次往返
    if (/^1\d{10}$/.test(ref)) {
      this.setData({ applyErr: 'patientRef 只接受内部患者 ID，不接受手机号' })
      return
    }
    this.setData({ applying: true, applyErr: '' })
    doctorService.submitBedApplication({
      patientRef: ref,
      bedId: this.data.applyBedId,
      wardId: this.data.applyWardId,
      reason: String(this.data.applyReason || '').trim(),
      priority: this.data.applyPriority
    }, { idempotencyKey: this.data.idemKey }).then(() => {
      this.setData({ applying: false, showApply: false })
      wx.showToast({ title: '已提交，待护士站审批', icon: 'none' })
      this.fetchApplications()
    }).catch((err) => {
      const http = Number((err && err.httpCode) || 0)
      // 床位刚被别人占走（BED_STATE_CONFLICT/409）：关抽屉刷新，提示换床申请
      if (http === 409) {
        this.setData({ applying: false, showApply: false, applyErr: '' })
        wx.showToast({ title: '床位状态已变化，已为你刷新', icon: 'none' })
        this.fetch()
        return
      }
      this.setData({ applying: false, applyErr: errText(err, '提交申请失败，请重试') })
    })
  },

  onWardTap(e) {
    const id = String(e.currentTarget.dataset.id || '')
    if (id === this.data.wardId) return
    this.setData({ wardId: id }, () => this._applyFilter())
  },

  onReachBottom() {
    if (!this.data.hasMore) return
    const { all, wardId, page } = this.data
    const list = wardId ? all.filter((b) => b.wardId === wardId) : all
    const p = paginate(list, page + 1)
    this.setData({ displayed: p.displayed, page: p.page, hasMore: p.hasMore })
  },

  /** 按当前病区过滤 → 重算统计/图例 → 重置分页 */
  _applyFilter() {
    const { all, wardId } = this.data
    const list = wardId ? all.filter((b) => b.wardId === wardId) : all
    const p = paginate(list, 1)
    this.setData({
      displayed: p.displayed,
      // 总数：paginate() 已给出，页面此前丢弃（门禁断言 total 需要）
      total: p.total,
      page: p.page,
      hasMore: p.hasMore,
      stats: buildStats(list),
      legend: buildLegend(all)
    })
  },

  noop() {}
})

/* ============ 纯函数（无副作用，便于对照契约阅读） ============ */

/** 后端 Bed → 视图行；未知状态按「维修中」中性展示，不做语义猜测 */
function toViewRow(b) {
  const raw = String((b && b.status) || '').toUpperCase()
  const meta = BED_META[raw] || BED_META.OUT_OF_SERVICE
  const wardId = String((b && b.wardId) || '')
  return {
    id: String((b && b.id) || ''),
    no: String((b && (b.bedNo || b.label)) || ''),   // 契约字段 bedNo；兼容旧 label
    wardId,
    wardName: String((b && b.wardName) || ''),
    status: raw,
    statusText: meta.text,
    cls: meta.cls,
    canApply: !!meta.canApply,
    // 患者仅在后端下发时展示（脱敏由后端负责，前端不拼假名）
    patient: String((b && (b.occupantDisplayName || b.patientName)) || ''),
    version: Number(b && b.version) || 0
  }
}

/** 后端申请单 → 视图行；未识别状态按「待审批」中性展示 */
function toAppRow(a) {
  const raw = String((a && a.status) || '').toUpperCase()
  const meta = APP_META[raw] || APP_META.PENDING
  return {
    id: String((a && a.id) || ''),
    // 床位可能为空（只申请病区、尚未排床）→ 回退展示病区名
    target: String((a && a.bedLabel) || '') || (a && a.wardName ? a.wardName + '（待排床）' : '病区待定'),
    patient: String((a && a.patientDisplayName) || ''),
    reason: String((a && a.reason) || ''),
    reviewNote: String((a && a.reviewNote) || ''),
    urgent: String((a && a.priority) || '').toUpperCase() === 'URGENT',
    status: raw,
    statusText: meta.text,
    cls: meta.cls,
    time: fmtTime(a && a.createdAt)
  }
}

/** ISO 时间 → 'MM-DD HH:mm'；解析失败返回空串（不伪造时间） */
function fmtTime(iso) {
  const d = new Date(iso || '')
  if (isNaN(d.getTime())) return ''
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 病区去重：id 必须存在才成项（无 wardId 的床位不进筛选，仍出现在「全部」里） */
function buildWards(all) {
  const seen = {}
  const out = []
  all.forEach((b) => {
    if (!b.wardId || seen[b.wardId]) return
    seen[b.wardId] = true
    out.push({ id: b.wardId, name: b.wardName || b.wardId })
  })
  return out
}

function buildStats(list) {
  let occ = 0
  let free = 0
  let clean = 0
  list.forEach((b) => {
    if (b.status === 'OCCUPIED' || b.status === 'RESERVED') occ++
    else if (b.status === 'AVAILABLE') free++
    else if (b.status === 'CLEANING') clean++
  })
  return [
    { key: 'total', label: '总床位', value: list.length },
    { key: 'occ', label: '占用', value: occ },
    { key: 'free', label: '空闲', value: free },
    { key: 'clean', label: '待消毒', value: clean }
  ]
}

/** 图例：先固定三项（设计稿），再按数据里实际出现的扩展状态追加，避免「有橙卡没图例」 */
function buildLegend(all) {
  const out = LEGEND_BASE.slice()
  Object.keys(LEGEND_EXTRA).forEach((k) => {
    if (all.some((b) => b.status === k)) out.push(LEGEND_EXTRA[k])
  })
  return out
}
