/**
 * pages/consult/picker —— 选择医生（在线问诊发起）
 *
 * 数据源（契约 · backend/contracts/business-openapi.yaml）：
 *   GET /api/v1/doctors                    全量医生（匿名只读，DoctorData[]）
 *   GET /api/v1/departments                科室目录（匿名只读，DepartmentData[]）
 *
 * ⚠️ 不伪造：
 *   · 医生职称/科室/专长一律取服务端字段，缺失 → 中性占位，不本地编造；
 *   · 有号状态（slotStatusText）只在服务端下发时展示；
 *   · 选中医生 → 跳转 consult 页（?doctorId=…）进入「指定医生」发起模式，
 *     后端按 ConsultationCreate.doctorId 直接分配（免认领，见 ConsultationService）。
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const userService = require('../../../services/user.js')
const doctorService = require('../../../services/doctor.js')
const { errText } = require('../../../utils/err-text.js')

Page({
  data: {
    icons,
    theme: 'standard',
    statusBarHeight: 20,
    navH: 64,

    loading: true,
    error: '',
    matching: false,
    departments: [],
    activeDept: '',
    doctors: [],
    shown: []
  },

  onLoad(options) {
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}
    this.setData({
      icons,
      theme: app.globalData.theme || 'standard',
      statusBarHeight: sbh,
      navH: sbh + 44
    })
    // 从挂号详情等入口直接带目标医生
    if (options && options.doctorId) {
      this._gotoConsult({
        id: options.doctorId,
        name: (options.doctorName || '').trim() || '',
        title: (options.doctorTitle || '').trim() || '',
        departmentName: (options.departmentName || '').trim() || ''
      })
      return
    }
    this.fetch()
  },

  onBack() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  },

  fetch() {
    this.setData({ loading: true, error: '' })
    return Promise.all([
      userService.listDepartments().catch(() => []),
      userService.listCatalogDoctors().catch((err) => {
        this.setData({ error: errText(err, '医生列表加载失败，请重试') })
        throw err
      })
    ]).then(([depts, docs]) => {
      const dArr = Array.isArray(depts) ? depts : []
      const docArr = Array.isArray(docs) ? docs : []
      this.setData({
        loading: false,
        departments: dArr,
        doctors: docArr,
        shown: this._filter(docArr, '')
      })
      // 同步医生端「线上问诊设置」的在线状态（异步补齐，不阻塞列表首屏）
      this._availabilityPromise = this._loadAvailability(docArr) || Promise.resolve()
    }).catch(() => this.setData({ loading: false }))
  },

  /**
   * 同步医生在线接诊状态（GET /api/v1/doctors/{id}/availability，与医生端设置同源）。
   * · 明确 online=false → 卡片置灰、点击提示「暂未开放线上问诊」，不下单；
   * · 请求失败或字段缺失 → 视为未知，**不拦截**患者（fail-open，避免误伤演示/断网场景）；
   * · 在线的排前面，未知保持原序，离线的沉底。
   */
  _loadAvailability(docs) {
    const arr = Array.isArray(docs) ? docs : []
    if (!arr.length) return Promise.resolve()
    return Promise.all(arr.map((d) => doctorService.getAvailability(d.id).catch(() => null)))
      .then((list) => {
        const av = {}
        arr.forEach((d, i) => { av[d.id] = list[i] || {} })
        const decorated = arr.map((d) => {
          const a = av[d.id] || {}
          const known = typeof a.online === 'boolean'
          const available = known ? !!a.online : null
          let availText = ''
          if (known) availText = available ? (a.inSlot === true ? '在线接诊' : '今日可约') : '暂不接诊'
          return Object.assign({}, d, {
            available,
            availText,
            availCls: known ? (available ? 'cp-avail-on' : 'cp-avail-off') : ''
          })
        })
        const sorted = decorated.filter((d) => d.available === true)
          .concat(decorated.filter((d) => d.available !== true))
        this.setData({ doctors: sorted, shown: this._filter(sorted, this.data.activeDept) })
      })
      .catch(() => { /* 状态是增强信息，失败不影响选择 */ })
  },

  _filter(list, deptId) {
    const arr = Array.isArray(list) ? list : []
    if (!deptId) return arr
    return arr.filter((d) => String(d.departmentId || '') === String(deptId))
  },

  onDeptTap(e) {
    const id = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '')
    this.setData({ activeDept: id, shown: this._filter(this.data.doctors, id) })
  },

  onPickDoctor(e) {
    const d = (e.currentTarget.dataset && e.currentTarget.dataset.doctor) || {}
    if (!d || !d.id) {
      wx.showToast({ title: '医生信息不完整，请重试', icon: 'none' })
      return
    }
    // 医生已在「线上问诊设置」里下线 → 明确拦截（未知状态不拦截）
    if (d.available === false) {
      wx.showToast({ title: '该医生暂未开放线上问诊，请选择其他医生', icon: 'none' })
      return
    }
    this._gotoConsult(d)
  },

  /** 不指定医生：从在线医生里随机匹配一位，带 doctorId 进入会话（不进入 AI 问诊） */
  onSkip() {
    if (this._matching) return
    if (this.data.loading) {
      wx.showToast({ title: '医生列表加载中，请稍后再试', icon: 'none' })
      return
    }
    this._matching = true
    this.setData({ matching: true })
    const ready = this._availabilityPromise || Promise.resolve()
    ready.then(() => {
      const docs = Array.isArray(this.data.doctors) ? this.data.doctors : []
      const eligible = docs.filter((d) => d && d.id && d.available !== false)
      const online = eligible.filter((d) => d.available === true)
      // 在线状态接口失败时 available=null：按 fail-open 处理，仍可随机匹配；
      // 但已知离线的医生绝不参与匹配。
      const candidates = online.length ? online : eligible.filter((d) => d.available !== true)
      if (!candidates.length) {
        wx.showToast({ title: '当前没有可接诊医生，请选择具体医生', icon: 'none', duration: 2500 })
        return
      }
      const pick = candidates[Math.floor(Math.random() * candidates.length)]
      wx.showToast({ title: '已匹配 ' + (pick.name || '在线医生'), icon: 'none', duration: 1800 })
      this._gotoConsult(pick)
    }).catch(() => {
      wx.showToast({ title: '匹配失败，请选择具体医生', icon: 'none' })
    }).then(() => {
      this._matching = false
      this.setData({ matching: false })
    })
  },

  _gotoConsult(d) {
    const q = [
      'doctorId=' + encodeURIComponent(d.id),
      'doctorName=' + encodeURIComponent(d.name || ''),
      'doctorTitle=' + encodeURIComponent(d.title || ''),
      'departmentName=' + encodeURIComponent(d.departmentName || '')
    ].join('&')
    wx.navigateTo({ url: '/pages/consult/consult?' + q })
  }
})
