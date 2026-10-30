/**
 * pages/doctor/beds —— 床位管理（医生端）
 *
 * 数据：GET /api/v1/beds（config/api.js → API.BED_LIST，services/doctor.js → listBeds）
 *       POST /api/v1/beds/{bedId}/assignment（action=ASSIGN + expectedVersion 乐观锁 + 幂等键）
 *
 * 契约要点（backend/contracts/business-openapi.yaml · Bed / BedAssignmentRequest）：
 *   · 状态是英文枚举 BedStatus：AVAILABLE / OCCUPIED / RESERVED / CLEANING / OUT_OF_SERVICE
 *   · 中文文案与配色**只在本文件**映射（BED_META），模板不写英文判断
 *   · ASSIGN 只接受 patientRef（内部患者 ID），不接受姓名/手机号 → 抽屉里只收 patientRef
 *   · 写操作必须带 Idempotency-Key 与 expectedVersion；409 时提示刷新后重试
 *
 * 版式：design-output/医生端/E-医生端/14-床位管理.png（实测见 beds.wxss 头部注释）
 * 增强项（用户确认口径）：顶部四列统计 + 病区横滑筛选（仅 ≥2 个病区时出现）
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const doctorService = require('../../../services/doctor.js')
const { errText } = require('../../../utils/err-text.js')
const { paginate } = require('../../../utils/paginate.js')
const req = require('../../../services/request.js')

/* 状态 → 中文 / 卡片配色 / 是否可安排入住。未识别状态一律按「维修中」中性展示，不猜测语义。 */
const BED_META = {
  AVAILABLE: { text: '空闲', cls: 'avail', canAssign: true },
  OCCUPIED: { text: '占用', cls: 'occ' },
  RESERVED: { text: '已预留', cls: 'reserved' },
  CLEANING: { text: '待消毒', cls: 'clean' },
  OUT_OF_SERVICE: { text: '维修中', cls: 'off' }
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

    /* 安排入住抽屉 */
    showAssign: false,
    assignBedId: '',
    assignBedNo: '',
    assignVersion: 0,
    assignPatientRef: '',
    assignNote: '',
    assignErr: '',
    assigning: false,
    /* 同一抽屉内重试用同一幂等键，避免重复提交产生多条入住记录 */
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
      () => this.fetch()
    )
  },

  onBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
      return
    }
    // 栈底（开发者工具直接打开 / 从登录页 reLaunch 进来）：回工作台，不假装能返回
    wx.reLaunch({ url: '/pages/doctor/workbench/workbench' })
  },

  /* ============ 数据 ============ */

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

  /* ============ 安排入住 ============ */

  onAssignTap(e) {
    if (this.data.assigning) return
    const ds = e.currentTarget.dataset
    this.setData({
      showAssign: true,
      assignBedId: String(ds.id || ''),
      assignBedNo: String(ds.no || ''),
      assignVersion: Number(ds.version) || 0,
      assignPatientRef: '',
      assignNote: '',
      assignErr: '',
      idemKey: req.newIdempotencyKey()
    })
  },

  onAssignInput(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [field]: e.detail.value })
  },

  closeAssign() {
    if (this.data.assigning) return       // 提交中不允许关闭，避免状态错位
    this.setData({ showAssign: false, assignErr: '' })
  },

  confirmAssign() {
    if (this.data.assigning) return
    const ref = String(this.data.assignPatientRef || '').trim()
    if (!ref) {
      this.setData({ assignErr: '请填写患者内部 ID（patientRef）' })
      return
    }
    this.setData({ assigning: true, assignErr: '' })
    doctorService.assignBed(
      this.data.assignBedId,
      'ASSIGN',
      this.data.assignVersion,
      ref,
      { note: this.data.assignNote, idempotencyKey: this.data.idemKey }
    ).then(() => {
      this.setData({ assigning: false, showAssign: false })
      wx.showToast({ title: '已安排入住', icon: 'success' })
      this.fetch()
    }).catch((err) => {
      const code = String((err && err.code) || '')
      const msg = (err && err.message) || ''
      // 乐观锁/状态冲突（request.js 把非 2xx 统一包成 HTTP_ERROR + httpCode）：
      // 提示刷新后重试，不在这里猜「当前状态」
      if (Number((err && err.httpCode) || 0) === 409 || code === 'VERSION_CONFLICT' || /冲突/.test(msg)) {
        this.setData({ assigning: false, showAssign: false, assignErr: '' })
        wx.showToast({ title: '床位状态已变化，已为你刷新', icon: 'none' })
        this.fetch()
        return
      }
      this.setData({ assigning: false, assignErr: errText(err, '安排入住失败，请重试') })
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
    canAssign: !!meta.canAssign,
    // 患者仅在后端下发时展示（脱敏由后端负责，前端不拼假名）
    patient: String((b && (b.occupantDisplayName || b.patientName)) || ''),
    version: Number(b && b.version) || 0
  }
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
