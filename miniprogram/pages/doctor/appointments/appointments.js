/**
 * pages/doctor/appointments —— 挂号管理（医生端患者队列）
 *
 * 版式（对齐 design-output/医生端/E-医生端/13-挂号管理.png，1391×3014）：
 *   ① 自绘导航（返回 + 居中标题；右侧胶囊由微信自绘）
 *   ② 概览卡四列（待就诊 / 就诊中 / 已完成 / 今日总数）—— 同时作为状态筛选
 *   ③ 患者卡（候诊序号 + 状态徽章 / 姓名 / 就诊时间 / 分隔线 / 叫号·完成就诊）
 *
 * 后端（契约 M3）：
 *   GET  /api/v1/doctor/appointments            ≈ 医生自己的预约列表（服务端按 doctor_id 过滤）
 *   POST /api/v1/doctor/appointments/{id}/status  状态流转（expectedVersion + Idempotency-Key）
 *
 * ⚠️ 队列口径（2026-10-24 统一）：**今天及未来**的预约（前端按号源时间过滤掉过期历史）。
 *    此前带 date=今天 只显示当日队列，患者挂"明天"的号在医生端不可见（挂号管理显示 0、
 *    首页待就诊对不上）—— 张三 10-25 的预约就是因此看不到。现改为拉全量 + 前端过滤
 *    startTime >= 今日 00:00，首页统计（workbench）与挂号管理共用同一口径。
 *
 * ⚠️ 旧路径 /api/appoint/list、/api/appoint/updateStatus 是网关 compat 的 pending 条目
 *    （501 COMPAT_PENDING）。它们缺版本号/幂等头，网关刻意不代填，**不得再调用**。
 * ⚠️ 契约状态是英文枚举，展示一律经 utils/apt-status.js；统计与筛选只认 rawStatus（英文），
 *    不靠中文文案匹配 —— 文案改版即失效（本页 10-19 版就有这个 bug：rawStatus 被中文覆盖，
 *    三个状态数恒为 0，只有「今日总数」对）。
 * ⚠️ 不伪造：契约 Appointment 没有患者手机号/头像字段，页面就不渲染手机号与头像。
 */
const app = getApp()
const doctorService = require('../../../services/doctor.js')
const { paginate } = require('../../../utils/paginate.js')
const { errText } = require('../../../utils/err-text.js')
const icons = require('../../../utils/icons.js')
const { aptStatusText } = require('../../../utils/apt-status.js')
const { fmtLocalDateTime } = require('../../../utils/datetime.js')

/**
 * 医生端队列的状态展示 —— **不复用 apt-status.js 的患者端口径**。
 *
 * 原因：患者端需要区分「待确认 / 待就诊」（PENDING / CONFIRMED 是两个契约态），
 * 但医生队列的设计稿只有三档徽章：待就诊（蓝）/ 就诊中（薄荷）/ 已完成（灰）。
 * 医生视角里 PENDING 与 CONFIRMED 都是"还没来"，同属待就诊一档。
 * ⚠️ 只在本页做展示层归并，**不改 data.all 的 rawStatus**（统计与筛选仍按契约枚举分组）。
 */
const DOC_STATUS = {
  PENDING: { text: '待就诊', cls: 'badge-blue' },
  CONFIRMED: { text: '待就诊', cls: 'badge-blue' },
  CHECKED_IN: { text: '就诊中', cls: 'badge-mint' },
  COMPLETED: { text: '已完成', cls: 'badge-gray' },
  CANCELLED: { text: '已取消', cls: 'badge-gray' },
  EXPIRED: { text: '已过期', cls: 'badge-gray' },
  NO_SHOW: { text: '未到诊', cls: 'badge-gray' }
}

/** 契约状态 → 医生端展示（未知枚举原样透传，不吞不猜） */
function docStatus(raw) {
  const key = String(raw == null ? '' : raw).trim().toUpperCase()
  if (DOC_STATUS[key]) return DOC_STATUS[key]
  return { text: aptStatusText(raw), cls: 'badge-gray' }
}

/**
 * 概览四列的筛选桶 —— 统计与筛选**共用同一张表**，
 * 保证「点某一列看到的条数」与「该列显示的数字」永远一致。
 */
const BUCKETS = {
  wait: ['PENDING', 'CONFIRMED'],
  in: ['CHECKED_IN'],
  done: ['COMPLETED']
}

/** 空态文案用：当前筛选叫什么（total 走通用空态） */
const FILTER_TITLE = { wait: '待就诊', in: '就诊中', done: '已完成', total: '' }

/** 契约状态 → 可执行动作（唯一判定处，模板只读这两个布尔值） */
function actionsOf(status) {
  return {
    canCall: status === 'PENDING' || status === 'CONFIRMED',
    canFinish: status === 'CHECKED_IN'
  }
}

Page({
  data: {
    theme: 'standard',
    icons,
    statusBarHeight: 20,
    navH: 64,

    /** 归一化后的全量行（只存 ≤50 条，服务端 limit 上限） */
    all: [],
    /** 当前筛选下、当前页要渲染的行（字段名与 utils/paginate.js 返回值一致） */
    displayed: [],
    filter: 'total',
    filterTitle: '',
    page: 1,
    hasMore: false,
    stats: [],
    loading: true,
    error: '',
    // 服务端返回 nextCursor 即表示"还有更多"；onReachBottom 优先按 cursor 续拉服务端
    truncated: false,
    serverCursor: ''
  },

  onLoad() {
    if (app.globalData.role !== 'doctor') {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}
    this.setData(
      { theme: app.globalData.theme || 'standard', icons, statusBarHeight: sbh, navH: sbh + 44 },
      () => this.fetch()
    )
  },

  onBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
      return
    }
    // 栈底（多半是开发者工具直接打开或从登录页 reLaunch 进来）：回工作台，不假装能返回
    wx.reLaunch({ url: '/pages/doctor/workbench/workbench' })
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh())
  },

  /** 上拉触底：优先按服务端 cursor 续拉（去重追加）；无下一页才做本地切片 */
  onReachBottom() {
    if (this.data.serverCursor) {
      this._appendMore()
      return
    }
    if (!this.data.hasMore) return
    this._refresh(this.data.page + 1)
  },

  // ============ 拉取 ============
  /**
   * 拉医生预约列表（今天及未来）。
   * ⚠️ 不带 date：服务端返回该医生全量预约（cursor 分页），前端按号源时间
   *    过滤 startTime >= 今日 00:00，丢弃过期未就诊的历史数据（2026-10-24 统一口径，
   *    与首页 workbench 的概览统计共用同一规则；此前带 date=今天 会让"明天"的预约不可见）。
   */
  fetch() {
    this.setData({ loading: true, error: '' })
    return doctorService
      .listAppointments({ limit: 50 })
      .then((res) => {
        const arr = Array.isArray(res.items) ? res.items : []
        const t0 = this._todayStart()
        const all = arr
          .map((it) => this._mapRow(it))
          .filter((r) => r.ts >= t0)
        this.setData(
          {
            all,
            loading: false,
            truncated: !!res.nextCursor,
            serverCursor: res.nextCursor || '',
            page: 1
          },
          () => this._refresh(1)
        )
      })
      .catch((err) => {
        this.setData({ loading: false, error: errText(err, '挂号列表加载失败，请重试') })
      })
  },

  /** 服务端游标续拉：追加下一页（按 id 去重，避免重复行；同样按"今天及未来"过滤），并刷新筛选视图 */
  _appendMore() {
    const cursor = this.data.serverCursor
    if (!cursor || this.data.loading) return
    this.setData({ loading: true, error: '' })
    doctorService
      .listAppointments({ limit: 50, cursor })
      .then((res) => {
        const t0 = this._todayStart()
        const next = (Array.isArray(res.items) ? res.items : [])
          .map((it) => this._mapRow(it))
          .filter((r) => r.ts >= t0)
        const seen = new Set(this.data.all.map((r) => r.id))
        const merged = this.data.all.concat(next.filter((r) => !seen.has(r.id)))
        this.setData(
          {
            all: merged,
            loading: false,
            truncated: !!res.nextCursor,
            serverCursor: res.nextCursor || ''
          },
          () => this._refresh(1)
        )
      })
      .catch((err) => {
        this.setData({ loading: false, error: errText(err, '加载更多挂号失败，请重试') })
      })
  },

  /** 本地今天 00:00 的时间戳（前端"今天及未来"口径的基准） */
  _todayStart() {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  },

  /**
   * 队列排序：待就诊 → 就诊中 → 终端态，同组按时间先后。
   * 服务端是 `ORDER BY s.start_time ASC`（纯时间序），会把「已完成」插在中间；
   * 设计稿的三张卡是**按状态分组**的（A015 待就诊 / A016 就诊中 / A017 已完成）。
   * 这里只改展示顺序，不动数据本身，也不改服务端。
   */
  _sortRows(list) {
    const rank = (s) =>
      s === 'PENDING' || s === 'CONFIRMED' ? 0 : s === 'CHECKED_IN' ? 1 : s === 'COMPLETED' ? 2 : 3
    return list.slice().sort((a, b) => {
      const d = rank(a.rawStatus) - rank(b.rawStatus)
      if (d !== 0) return d
      const ta = String(a.sortKey || '')
      const tb = String(b.sortKey || '')
      if (ta !== tb) return ta < tb ? -1 : 1
      return String(a.no).localeCompare(String(b.no))
    })
  },

  /** 契约 Appointment → 视图行（字段全来自服务端，缺省留空不编造） */
  _mapRow(it) {
    const raw = String(it.status || '')
    const st = docStatus(raw)
    const act = actionsOf(raw)
    return {
      id: it.id,
      rawStatus: raw,          // ← 唯一「契约枚举」字段：统计/筛选只认它
      version: Number(it.version) || 0,
      no: this._queueNo(it.queueNumber),
      ts: it.startTime ? new Date(it.startTime).getTime() : Number.MAX_SAFE_INTEGER,  // 无号源时间 → 视同未来（不误过滤）
      sortKey: String(it.startTime || ''),
      name: it.patientName || '',
      whenText: this._whenText(fmtLocalDateTime(it.startTime)),
      status: st.text,
      statusCls: st.cls,
      canCall: act.canCall,
      canFinish: act.canFinish
    }
  },

  /**
   * 候诊序号：契约只有 queueNumber（整数），设计稿的「A015」里 A 是诊室/队列前缀，
   * 契约没有该字段 → 不猜字母，只把数字补足 3 位（015），无号显示「—」。
   */
  _queueNo(n) {
    if (n === null || n === undefined || n === '') return '—'
    const s = String(n)
    return /^\d{1,2}$/.test(s) ? ('00' + s).slice(-3) : s
  },

  /** ISO → 「10月20日 上午 09:30」（设计稿口径；日期/时分本身仍由 datetime.js 解析） */
  _whenText(t) {
    const date = (t && t.date) || ''
    const time = (t && t.time) || ''
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    const day = m ? Number(m[2]) + '月' + Number(m[3]) + '日' : date
    if (!time) return day
    const hh = Number(time.slice(0, 2))
    const period = hh < 12 ? '上午' : hh < 18 ? '下午' : '晚上'
    return day + ' ' + period + ' ' + time
  },

  /** 本地当天 yyyy-MM-dd（用设备本地日期，不用 toISOString —— 后者是 UTC 日） */
  _today() {
    const d = new Date()
    const p = (n) => (n < 10 ? '0' + n : String(n))
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  },

  /**
   * 重算「概览 + 当前筛选视图」。
   * 统计与列表同源（都基于 data.all 的 rawStatus），所以数字和列表永远对得上。
   */
  _refresh(page) {
    const all = this.data.all || []
    const stats = this._calcStats(all)
    const set = BUCKETS[this.data.filter]
    // 排序只作用于视图切片：状态流转后同一行的分组会变，顺序要跟着重排
    const matched = this._sortRows(set ? all.filter((t) => set.indexOf(t.rawStatus) >= 0) : all)
    const p = paginate(matched, page || 1)
    this.setData({
      stats,
      displayed: p.displayed,
      // 总数：paginate() 已给出，页面此前丢弃（门禁断言 total 需要）
      total: p.total,
      page: p.page,
      hasMore: p.hasMore,
      filterTitle: FILTER_TITLE[this.data.filter] || ''
    })
  },

  /**
   * 四列概览（设计稿 13 的"待就诊/就诊中/已完成/今日总数"；口径改后第四列为**今天及未来全部**，
   * 标签随口径改为「全部」，避免"今日总数"与实际值不符 —— 2026-10-24）
   * ⚠️ 按契约原始枚举分组（rawStatus），不靠中文文案匹配。
   */
  _calcStats(list) {
    const count = (set) => list.filter((t) => set.indexOf(t.rawStatus) >= 0).length
    return [
      { key: 'wait', label: '待就诊', value: count(BUCKETS.wait) },
      { key: 'in', label: '就诊中', value: count(BUCKETS.in) },
      { key: 'done', label: '已完成', value: count(BUCKETS.done) },
      { key: 'total', label: '全部', value: list.length }
    ]
  },

  /** 点概览列 = 切筛选（「今日总数」= 全部）；再点一次同一列不做事 */
  onFilter(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.filter) return
    this.setData({ filter: key, page: 1 }, () => this._refresh(1))
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },

  // ============ 状态流转 ============
  /** 叫号：待确认/待就诊 → 就诊中（契约里 CHECKED_IN 即"已签到"，无独立签到流转） */
  onCall(e) {
    this._change(e.currentTarget.dataset.id, 'CHECKED_IN', '已叫号')
  },

  /** 完成就诊：就诊中 → 已完成 */
  onFinish(e) {
    this._change(e.currentTarget.dataset.id, 'COMPLETED', '已完成就诊')
  },

  /**
   * 状态流转（乐观更新 + 失败回滚）
   * - 幂等键按 (预约, 目标状态, 版本) 生成：同一次操作的网络重试会重放，不会重复扣状态；
   * - 409 分两种：VERSION_CONFLICT（别人已改）→ 提示并刷新；IDEMPOTENCY_KEY_REUSE → 提示已提交过；
   * - 防连点：_submitting 期间忽略再次点击。
   * ⚠️ 行用 id 定位而不是 index：视图是筛选后的切片，index ≠ 全量下标。
   */
  _change(id, toStatus, okTitle) {
    if (this._submitting) return
    const row = (this.data.all || []).find((t) => t.id === id)
    if (!row) return
    this._submitting = true

    const prevAll = this.data.all
    const optimistic = prevAll.map((t) => {
      if (t.id !== id) return t
      const st = docStatus(toStatus)
      const act = actionsOf(toStatus)
      return Object.assign({}, t, {
        rawStatus: toStatus,
        status: st.text,
        statusCls: st.cls,
        canCall: act.canCall,
        canFinish: act.canFinish
      })
    })
    this.setData({ all: optimistic }, () => this._refresh(this.data.page))

    const key = 'docappt-' + id + '-' + toStatus + '-' + (row.version || 0)
    const finish = () => { this._submitting = false }

    doctorService.updateStatus(id, toStatus, row.version, { idempotencyKey: key }).then(
      (data) => {
        // 以服务端返回为准刷新该行（version 必须同步，否则下一次操作必然 409）
        const latest = this.data.all.map((t) => {
          if (t.id !== id) return t
          const rawNext = (data && data.status) || toStatus
          const st = docStatus(rawNext)
          const act = actionsOf(rawNext)
          return Object.assign({}, t, {
            rawStatus: String(rawNext),
            status: st.text,
            statusCls: st.cls,
            version: Number(data && data.version) || (t.version || 0) + 1,
            canCall: act.canCall,
            canFinish: act.canFinish
          })
        })
        this.setData({ all: latest }, () => this._refresh(this.data.page))
        wx.showToast({ title: okTitle, icon: 'success' })
        finish()
      },
      (err) => {
        this.setData({ all: prevAll }, () => this._refresh(this.data.page))
        if (err && err.httpCode === 409) {
          const code = (err.data && err.data.code) || err.code || ''
          wx.showToast({
            title: code === 'VERSION_CONFLICT' ? '已被更新，正在刷新' : '该操作已提交过，请刷新',
            icon: 'none'
          })
          this.fetch()
        } else {
          wx.showToast({ title: errText(err, '操作失败，请重试'), icon: 'none' })
        }
        finish()
      }
    )
  }
})
