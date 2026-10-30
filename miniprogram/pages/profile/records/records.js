/**
 * pages/profile/records —— 挂号记录（我的 → 挂号记录）
 * 数据源：GET /api/v1/appointments/me（服务端权威，后端已按认证主体过滤）
 * 骨架屏 + 降级（最小设计）：
 *   - 加载中：骨架屏（skeleton list）
 *   - 开发阶段（MOCK_FALLBACK=true）后端不可用 → 演示数据（APPOINTMENTS）兜底展示
 *   - 上线阶段（MOCK_FALLBACK=false）后端不可用 → 错误态 + 重新加载（不混入演示数据、不读本地缓存）
 */
const app = getApp()
// 只保留降级包装；接口一律走 services/user.js（页面不得直发接口）
const { withFallback } = require('../../../services/request.js')
const userService = require('../../../services/user.js')
const { paginate } = require('../../../utils/paginate.js')
const { errText } = require('../../../utils/err-text.js')
const { aptStatusText } = require('../../../utils/apt-status.js')
const { fmtLocalDateTime } = require('../../../utils/datetime.js')
const icons = require('../../../utils/icons.js')

/**
 * 科室 → 图标底板 + 字形（与预约页同一映射口径，跨页视觉一致）；未命中回退蓝底医院图标。
 * 颜色纪律：底板只用五色 pastel 装饰色，不挪用红/橙语义色（D-01④）。
 */
const DEPT_VISUAL = [
  { keys: ['呼吸', '肺'], tint: 'tile-blue', icon: icons.stethoscope },
  { keys: ['心血管', '心内', '心脏'], tint: 'tile-pink', icon: icons.heartbeat },
  { keys: ['消化', '胃肠', '肝'], tint: 'tile-mint', icon: icons.pill },
  { keys: ['骨', '关节', '脊柱'], tint: 'tile-amber', icon: icons.activity },
  { keys: ['神经'], tint: 'tile-purple', icon: icons.zap },
  { keys: ['儿', '小儿'], tint: 'tile-pink', icon: icons.user },
  { keys: ['皮肤'], tint: 'tile-mint', icon: icons.leaf },
  { keys: ['眼'], tint: 'tile-blue', icon: icons.eye },
  { keys: ['耳鼻喉', '口腔', '牙'], tint: 'tile-amber', icon: icons.hospital },
  { keys: ['妇'], tint: 'tile-pink', icon: icons.users }
]

function deptVisual(name) {
  const n = String(name || '')
  for (let i = 0; i < DEPT_VISUAL.length; i++) {
    const v = DEPT_VISUAL[i]
    for (let j = 0; j < v.keys.length; j++) {
      if (n.indexOf(v.keys[j]) >= 0) return { tint: v.tint, icon: v.icon }
    }
  }
  return { tint: 'tile-blue', icon: icons.hospital }
}

/** 状态文案 → 徽章配色（待就诊蓝 / 就诊中橙 / 已完成绿 / 已取消·过期灰） */
function statusCls(text) {
  const t = String(text || '')
  if (t.indexOf('就诊中') >= 0) return 'badge-amber'
  if (t.indexOf('已完成') >= 0) return 'badge-green'
  if (t.indexOf('取消') >= 0 || t.indexOf('过期') >= 0 || t.indexOf('未到') >= 0) return 'badge-gray'
  return 'badge-blue'
}

/** 给一条记录补视觉字段（模板只读 tint / icon / statusCls / isDone / isActive） */
function decorate(it) {
  const v = deptVisual(it.dept)
  const t = String(it.status || '')
  const isDone = t.indexOf('已完成') >= 0
  const isCancelled = t.indexOf('取消') >= 0 || t.indexOf('过期') >= 0
  return Object.assign({}, it, {
    tint: v.tint,
    icon: v.icon,
    statusCls: statusCls(it.status),
    isDone,
    isActive: !isDone && !isCancelled
  })
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
    error: '',
    // 顶部分段筛选（设计 06：全部 / 待就诊 / 已完成）——纯前端过滤已取回列表
    filter: '全部',
    // 分段计数（设计 06「全部① / 待就诊① / 已完成①」角标）
    counts: { all: 0, active: 0, done: 0 }
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'standard' })
    this.fetch()
  },

  // 上拉触底：首屏只渲染部分，触底追加下一页
  onReachBottom() {
    if (!this.data.hasMore) return
    const p = paginate(this._filtered(), this.data.page + 1)
    this.setData({ displayed: p.displayed, page: p.page, hasMore: p.hasMore })
  },

  /** 按当前分段筛选过滤全部记录（纯前端；服务端列表已是权威全集） */
  _filtered() {
    const f = this.data.filter
    if (f === '待就诊') return this.data.all.filter((it) => it.status.indexOf('已完成') < 0 && it.status.indexOf('取消') < 0 && it.status.indexOf('过期') < 0)
    if (f === '已完成') return this.data.all.filter((it) => it.status.indexOf('已完成') >= 0)
    return this.data.all
  },

  /** 分段切换（设计 06：全部 / 待就诊 / 已完成） */
  onSeg(e) {
    const f = e.currentTarget.dataset.f
    if (!f || f === this.data.filter) return
    this.setData({ filter: f })
    const p = paginate(this._filtered(), 1)
    this.setData({ displayed: p.displayed, page: p.page, hasMore: p.hasMore, total: p.total })
  },

  fetch() {
    this.setData({ loading: true, error: '' })
    // 开发阶段兜底：演示数据转成契约同形（departmentName/startTime/location），兼容下方归一化
    const mockFactory = () => (app.MOCK.APPOINTMENTS || []).map((a) => ({
      id: a.id,
      departmentName: a.dept,
      doctorName: a.doctor,
      startTime: (a.date || '') + ' ' + (a.time || ''),
      location: a.place,
      status: a.status,
      description: a.desc
    }))
    // 走服务层：契约 GET /api/v1/appointments/me（后端已按认证主体过滤），页面不再直连 API 规格
    return withFallback(userService.listMyAppointments(), mockFactory)
      .then((list) => {
        const arr = Array.isArray(list) ? list : (list && list.list) || []
        // 契约 AppointmentData 直读：departmentName/doctorName/startTime/location/status
        // （身份过滤在后端 SQL 完成，客户端不再自行过滤；字段名不得回退到 legacy 形态）
        const remote = arr.map((it) => {
          const when = fmtLocalDateTime(it.startTime)
          return {
            id: it.id,
            dept: it.departmentName || '',
            // 设计稿 06 是「陈医生 · 副主任医师」；契约 AppointmentData 目前只有 doctorName，
            // 没有 doctorTitle → 有职称才拼，没有就只显示姓名（不编造"副主任医师"）
            doctor: it.doctorTitle ? (it.doctorName + ' · ' + it.doctorTitle) : (it.doctorName || ''),
            date: when.date,
            time: when.time,
            place: it.location || '',
            status: aptStatusText(it.status) || '待就诊',
            // 契约 AppointmentData 无 description；保留字段以兼容本地缓存与非契约补充端点
            desc: it.description || ''
          }
        })
        // 服务端列表是权威数据源；请求成功时不再混入历史本地缓存，避免同一预约重复展示。
        const all = remote.map(decorate)
        this.setData({
          all,
          loading: false,
          counts: {
            all: all.length,
            active: all.filter((it) => it.isActive).length,
            done: all.filter((it) => it.isDone).length
          }
        })
        const p = paginate(this._filtered(), 1)
        this.setData({ displayed: p.displayed, page: p.page, hasMore: p.hasMore, total: p.total })
      })
      .catch((err) => {
        // 上线档：服务端是唯一权威源，不混入演示数据，也不读本地缓存。
        // （`wb_new_appointments` 已无任何写入点，原"本地兜底"恒为空，属死代码，已移除）
        this.setData({
          all: [],
          displayed: [],
          page: 1,
          hasMore: false,
          total: 0,
          loading: false,
          error: errText(err, '记录加载失败，请重试')
        })
      })
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh())
  },

  /** 查看详情：用列表已有字段拼装（不额外拉接口、不编造字段） */
  onDetail(e) {
    const idx = Number((e.currentTarget.dataset || {}).index)
    const it = this.data.displayed[idx]
    if (!it) return
    const lines = [
      '科室：' + (it.dept || '—'),
      '医生：' + (it.doctor || '—'),
      '时间：' + ((it.date || '') + ' ' + (it.time || '')).trim(),
      '状态：' + (it.status || '—')
    ]
    if (it.place) lines.push('地点：' + it.place)
    lines.push('预约号：' + (it.id || '—'))
    if (it.desc) lines.push('主诉：' + it.desc)
    wx.showModal({
      title: '预约详情',
      content: lines.join('\n'),
      showCancel: false,
      confirmText: '知道了',
      fail: () => console.warn('[records] 详情弹窗打开失败')
    })
  },

  /** 取消预约（契约已实现：POST /api/v1/appointments/{id}/cancel，幂等键自动生成） */
  onCancel(e) {
    // 在途守卫：快速双击会叠出两个确认弹窗 → 两次 cancel 请求（审查 P2-12）。
    // 与 family.onRemove 同范式：弹窗期间就不再受理第二次点击。
    if (this._cancelling) return
    const idx = Number(e.currentTarget.dataset.index)
    const row = this.data.displayed[idx]
    if (!row || !row.id) return
    this._cancelling = true
    const release = () => { this._cancelling = false }
    wx.showModal({
      title: '取消预约',
      content: '确定取消该预约吗？取消后号源将释放。',
      confirmText: '取消预约',
      confirmColor: '#E5484D',
      success: (res) => {
        if (!res.confirm) { release(); return }
        userService
          .cancelAppointment(row.id)
          .then(() => {
            wx.showToast({ title: '已取消', icon: 'success' })
            this.fetch()
          })
          .catch((err) => {
            wx.showToast({ title: errText(err, '取消失败，请重试'), icon: 'none' })
          })
          .then(release, release)
      },
      fail: release
    })
  },

  /** 查看报告：跳转健康档案页（已存在） */
  onViewReport() {
    wx.navigateTo({ url: '/pages/profile/health-records/health-records' })
  },

  /** 再次预约：跳转预约挂号页（tabBar 页，须 switchTab） */
  onRebook() {
    wx.switchTab({ url: '/pages/appointment/appointment' })
  },

  /** 空态「去挂号」：跳转预约挂号页（与再次预约同一入口） */
  onGoBook() {
    wx.switchTab({ url: '/pages/appointment/appointment' })
  }
})
