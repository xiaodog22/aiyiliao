/**
 * pages/doctor/workbench —— 医生工作台（医生端 01-医生工作台）
 *
 * 数据来源（全部为契约端点，页面不拼业务路径、不伪造数据）：
 *   · 医生本人     GET /api/v1/me                      → displayName / avatarUrl（userService.getMe）
 *   · 科室与职称   GET /api/v1/doctors                 → 按姓名唯一匹配本人（doctorService.listAllDoctors）
 *                   ⚠️ /api/v1/me 的 User 契约里**没有**科室/职称字段（additionalProperties:false），
 *                      而职称只能由医生名录提供；匹配不唯一/取不到时**不显示**该行，绝不猜。
 *   · 统计概览     GET /api/v1/doctor/appointments     → 本地聚合待就诊/就诊中/已完成（30s 缓存；
 *                   ⚠️ 口径与挂号管理一致：今天及未来，前端过滤过期历史 —— 2026-10-24 统一）
 *   · 待处理事项   GET /api/v1/doctor/appointments     → CHECKED_IN 今日数 = 预约签到待确认
 *                 GET /api/v1/doctor/consultations     → 已分配给我的 ACTIVE 会话数 = 在线问诊待回复
 *                   ⚠️ 契约里另有 GET /api/v1/doctor/todos（服务端判定待办），本页按任务书要求
 *                      改由上面两条列表端点派生；两者口径差异见交付说明。
 *
 * 角色：进入前要求 globalData.role === 'doctor'（服务端签发，客户端不做提权判断）。
 */
const app = getApp()
const doctorService = require('../../../services/doctor.js')
const userService = require('../../../services/user.js')
const ENV = require('../../../config/env.js')
const icons = require('../../../utils/icons.js')
const { errText } = require('../../../utils/err-text.js')

/**
 * 概览缓存（模块级，30s 有效）。
 * 预约量上来后每次进页面都全量拉一遍只为数 3 个数字，开销太大；
 * 后端 /api/v1/doctor/overview 尚未被本页采用（口径不同，见上），先用短 TTL 削掉反复进入的开销。
 */
const OV_TTL = 30000
let _ovCache = { at: 0, data: null, today: '' }

/** 契约状态 → 统计列（英文枚举，不用中文文案判分支） */
const WAITING = ['PENDING', 'CONFIRMED']
const IN_PROGRESS = ['CHECKED_IN']
const DONE = ['COMPLETED']

/** 待办徽章配色（效果图 01：问诊蓝 / 签到橙 / 报告薄荷） */
const TODO_BADGE = {
  CONSULT_REPLY: { cls: 'todo-badge-blue', icon: 'chatWhite' },
  CHECKIN_CONFIRM: { cls: 'todo-badge-amber', icon: 'alertWhite' },
  REPORT_REVIEW: { cls: 'todo-badge-mint', icon: 'fileTextWhite' }
}

/** 本地日期（YYYY-MM-DD），用于"今日"聚合；与后端 UTC 日窗口可能有偏移，仅用于前端展示口径 */
function localDay(ts) {
  const d = ts ? new Date(ts) : new Date()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
}

Page({
  data: {
    theme: 'standard',
    icons,
    statusBarHeight: 20,
    canGoBack: false,
    // 医生资料（name/dept/title/avatarUrl 均可能为空 → 模板按"没有就不显示"处理）
    doctor: { name: '', dept: '', title: '', avatarUrl: '' },
    doctorMeta: '',
    overview: { waiting: 0, inProgress: 0, done: 0 },
    loading: true,
    error: '',
    todos: [],
    todosLoading: true,
    todosError: '',
    // 未读红点：暂无消息接口，收敛为"有待处理事项"这一真实信号（详见交付说明）
    unread: false
  },

  onLoad() {
    if (app.globalData.role !== 'doctor') {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }

    // 状态栏高度：不同机型差异大，必须由系统信息注入（不是设计稿里的固定值）
    let statusBarHeight = 20
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (info && info.statusBarHeight) statusBarHeight = info.statusBarHeight
    } catch (e) { /* 低版本基础库：退回 20px */ }

    this.setData({
      theme: app.globalData.theme || 'standard',
      statusBarHeight,
      // 从登录页 reLaunch 进来时栈里只有本页 → 不画返回键（画了也退无可退）
      canGoBack: getCurrentPages().length > 1
    })

    this.loadProfile()
    this.loadOverview()
    this.loadTodos()
  },

  onShow() {
    // 会话/角色复查（审查 P2-03）：onLoad 只在进入时判一次，页面停留超过 72h 或
    // 本地 role 被清掉后再次回到前台，这里必须能把人送回登录页（不是只靠请求层 401 兜底）。
    if (app.globalData.role !== 'doctor' || !app.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    // 主题可能在「个人管理/隐私设置」里改过，回到本页重新同步（本页不在 tabBar 里，没有 getTabBar）
    const theme = app.globalData.theme || 'standard'
    if (theme !== this.data.theme) this.setData({ theme })
    // 消息中心未读数（医生端红点；失败不阻断页面，保持原值）
    userService.unreadCount()
      .then((n) => { this.setData({ unread: (Number(n) || 0) > 0 }) })
      .catch(() => {})
    // 从「患者队列」处理完签到回来，概览与待办要跟着变
    if (this._loadedOnce) {
      this.loadOverview()
      this.loadTodos()
    }
    this._loadedOnce = true
  },

  onPullDownRefresh() {
    Promise.all([this.loadOverview(true), this.loadTodos()])
      .then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh())
  },

  // ==================== 医生资料 ====================

  /**
   * GET /api/v1/me → 姓名/头像；GET /api/v1/doctors → 科室/职称（同名唯一匹配）。
   * ⚠️ 两个请求独立降级：任一失败都不阻塞页面，只影响对应字段是否显示。
   */
  loadProfile() {
    userService.getMe()
      .then((me) => {
        const name = (me && me.displayName) || ''
        const avatarUrl = userService.resolveAvatar(me && me.avatarUrl)
        this._applyDoctor({ name, avatarUrl })
      })
      .catch(() => {
        // 退回登录会话里的资料（服务端签发时已带 displayName/avatarUrl）
        const u = (app.globalData.user || {})
        this._applyDoctor({
          name: u.displayName || u.name || '',
          avatarUrl: userService.resolveAvatar(u.avatarUrl)
        })
      })

    doctorService.listAllDoctors()
      .then((res) => {
        const list = Array.isArray(res) ? res : (res && res.items) || []
        const me = this.data.doctor.name
        if (!me) return
        const hits = list.filter((d) => d && d.name === me)
        // 同名多人 → 无法确定是哪一位，宁可不显示职称（不猜）
        if (hits.length !== 1) return
        this._applyDoctor({ dept: hits[0].departmentName || '', title: hits[0].title || '' })
      })
      .catch(() => { /* 名录不可用：只显示姓名/头像 */ })
  },

  /** 合并医生资料并重算「科室 · 职称」单行文案（缺一项就不拼分隔符） */
  _applyDoctor(patch) {
    const doctor = Object.assign({}, this.data.doctor, patch || {})
    const parts = []
    if (doctor.dept) parts.push(doctor.dept)
    if (doctor.title) parts.push(doctor.title)
    this.setData({
      doctor,
      doctorMeta: parts.join(' · ')
    })
  },

  // ==================== 统计概览 ====================

  /**
   * 统计 = 医生自己的排队列表本地聚合（不新增接口）。
   * 口径（2026-10-24 统一）与「挂号管理」页一致：**今天及未来**的预约
   * （不带 date 拉全量，前端按号源时间过滤 startTime >= 今日 00:00，丢弃过期历史）。
   * 此前两页口径不一（首页曾统计全量历史 = 6、挂号管理只统计今日 = 0）导致数字对不上，
   * 且患者挂"明天"的号在医生端不可见。
   * force=true 跳过缓存（下拉刷新 / 错误重试必须绕过，否则拿着坏结果直接返回）。
   */
  loadOverview(force) {
    const today = localDay()
    if (!force && _ovCache.data && _ovCache.today === today && (Date.now() - _ovCache.at) < OV_TTL) {
      this.setData({ overview: _ovCache.data, loading: false, error: '' })
      return Promise.resolve()
    }

    this.setData({ loading: true, error: '' })
    const t0 = (() => {
      const d = new Date()
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    })()
    return doctorService.listAppointments({ limit: 50 })
      .then((res) => {
        const arr = Array.isArray(res && res.items) ? res.items : []
        const overview = { waiting: 0, inProgress: 0, done: 0 }
        arr.forEach((it) => {
          if (!it.startTime) return
          if (new Date(it.startTime).getTime() < t0) return   // 过期历史不计入
          const s = String(it.status || '').toUpperCase()
          if (WAITING.indexOf(s) >= 0) overview.waiting++
          else if (IN_PROGRESS.indexOf(s) >= 0) overview.inProgress++
          else if (DONE.indexOf(s) >= 0) overview.done++
        })
        _ovCache = { at: Date.now(), data: overview, today }
        this.setData({ overview, loading: false })
      })
      .catch((err) => {
        if (ENV.MOCK_FALLBACK) {
          // 开发阶段后端不可用：不阻断演示（仅开发构建会走到这里）
          console.warn('[workbench] 开发降级：概览接口不可用')
          this.setData({
            overview: app.MOCK.DOCTOR.overview || { waiting: 0, inProgress: 0, done: 0 },
            loading: false,
            error: ''
          })
          return
        }
        this.setData({ loading: false, error: errText(err, '概览加载失败') })
      })
  },

  reloadOverview() {
    this.loadOverview(true)
  },

  // ==================== 待处理事项 ====================

  /**
   * 待办由两条列表端点派生（任务书指定）：
   *   ① 预约签到待确认 = GET /api/v1/doctor/appointments 里 status=CHECKED_IN 的条数
   *      （后端语义：已签到待叫号确认；与 /doctor/todos 的 CHECKIN_CONFIRM 一致）
   *   ② 在线问诊待回复 = GET /api/v1/doctor/consultations 里「已分配给我」的 ACTIVE 会话数
   *      ⚠️ 2026-10-24 修复：此前误用患者端 listMyConsultations()（按 user_id 查，医生账号
   *         名下没有会话 → 该待办恒为 0），医生端已有专属端点却未启用。
   *         现改为医生视角端点，并只统计 assignedDoctorId 非空（认领池里"待认领"的
   *         全局会话不算"待回复"）。
   * 两个请求各自降级：一个失败不影响另一个；都为 0 条时展示空态（不伪造条目）。
   */
  loadTodos() {
    this.setData({ todosLoading: true, todosError: '' })

    const pAppt = doctorService.listAppointments({ limit: 50, date: localDay() })
      .then((res) => (Array.isArray(res && res.items) ? res.items : []))

    const pConsult = doctorService.listConsultations()
      .then((res) => (Array.isArray(res && res.items) ? res.items : []))

    return Promise.all([
      pAppt.then((items) => ({ ok: true, items }), (err) => ({ ok: false, err })),
      pConsult.then((list) => ({ ok: true, list }), (err) => ({ ok: false, err }))
    ]).then((results) => {
      const apptRes = results[0]
      const consultRes = results[1]
      const todos = []

      // ① 预约签到待确认
      if (apptRes.ok) {
        const arr = apptRes.items || []
        const today = localDay()
        const checkin = arr.filter((it) => String(it.status || '').toUpperCase() === 'CHECKED_IN'
          && (!it.startTime || localDay(it.startTime) === today)).length
        if (checkin > 0) {
          todos.push({
            kind: 'CHECKIN_CONFIRM',
            title: '预约签到待确认',
            subtitle: '今日 ' + checkin + ' 位到院患者待叫号确认',
            badgeCls: TODO_BADGE.CHECKIN_CONFIRM.cls,
            badgeIcon: TODO_BADGE.CHECKIN_CONFIRM.icon
          })
        }
      }

      // ② 在线问诊待回复（医生视角：已分配给我的 ACTIVE 会话）
      if (consultRes.ok) {
        const list = consultRes.list || []
        const active = list.filter((c) => String(c.status || '').toUpperCase() === 'ACTIVE'
          && !!c.assignedDoctorId).length
        if (active > 0) {
          todos.push({
            kind: 'CONSULT_REPLY',
            title: '在线问诊待回复',
            subtitle: '当前有 ' + active + ' 个进行中的问诊会话',
            badgeCls: TODO_BADGE.CONSULT_REPLY.cls,
            badgeIcon: TODO_BADGE.CONSULT_REPLY.icon
          })
        }
      }

      // 两条都失败才算失败（单条失败时按"该类别无待办"处理，并在控制台留痕）
      const allFailed = !apptRes.ok && !consultRes.ok
      if (allFailed) {
        if (ENV.MOCK_FALLBACK) {
          this.setData({ todos: [], todosLoading: false, todosError: '', unread: false })
          return
        }
        const err = apptRes.err || consultRes.err
        this.setData({
          todosLoading: false,
          todos: [],
          unread: false,
          todosError: errText(err, '待办加载失败')
        })
        return
      }
      if (!apptRes.ok) console.warn('[workbench] 预约列表不可用，签到待办按 0 处理')
      if (!consultRes.ok) console.warn('[workbench] 问诊列表不可用，问诊待办按 0 处理')

      this.setData({
        todos,
        todosLoading: false,
        todosError: '',
        unread: todos.length > 0
      })
    })
  },

  /** 「处理」/整行点击：按类别跳转（问诊处理页 V21 已上线 → 直达会话列表） */
  onTodo(e) {
    const kind = e.currentTarget.dataset.kind
    if (kind === 'CHECKIN_CONFIRM') {
      wx.navigateTo({ url: '/pages/doctor/appointments/appointments?from=todo' })
      return
    }
    if (kind === 'CONSULT_REPLY') {
      wx.navigateTo({ url: '/pages/doctor/consult/consult' })
      return
    }
    wx.showToast({ title: '该待办：暂无对应页面', icon: 'none' })
  },

  /** 「查看全部」：待办都落在患者队列里 */
  onViewAllTodo() {
    wx.navigateTo({ url: '/pages/doctor/appointments/appointments?from=todo' })
  },

  // ==================== 导航栏 ====================

  onBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
      return
    }
    // 栈底（多数情况是从登录页 reLaunch 进来的）：没有可返回的页面，如实提示
    wx.showToast({ title: '已经在工作台首页', icon: 'none' })
  },

  /** 消息中心：医生端消息中心（2026-10-24 上线），患者申请/回复均在医生身份可见 */
  onNotify() {
    wx.navigateTo({ url: '/pages/doctor/messages/messages' })
  },

  /** 智能电视大屏（医生端专属页面，已存在） */
  onCast() {
    wx.navigateTo({ url: '/pages/tv/cast/cast' })
  },

  // ==================== 宫格 / 快捷功能 ====================

  /**
   * 今日工作 / 快捷功能 / 统计列 的点击。
   * 有真实页面的直接跳；暂无页面的入口如实提示，不伪造页面。
   */
  onQuick(e) {
    const key = e.currentTarget.dataset.key
    const ROUTES = {
      appointments: '/pages/doctor/appointments/appointments',
      patientQueue: '/pages/doctor/appointments/appointments',
      patientMgmt: '/pages/doctor/appointments/appointments',
      beds: '/pages/doctor/beds/beds',
      personal: '/pages/doctor/personal/personal',
      consult: '/pages/doctor/consult/consult',
      schedule: '/pages/doctor/schedule/schedule',
      notify: '/pages/doctor/messages/messages'
    }
    const route = ROUTES[key]
    if (route) {
      wx.navigateTo({ url: route })
      return
    }
    wx.showToast({ title: '该功能：暂无对应页面', icon: 'none' })
  }
})
