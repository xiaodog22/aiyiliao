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
const { errText } = require('../../../utils/err-text.js')

Page({
  data: {
    icons,
    theme: 'standard',
    statusBarHeight: 20,
    navH: 64,

    loading: true,
    error: '',
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
    }).catch(() => this.setData({ loading: false }))
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
    this._gotoConsult(d)
  },

  /** 不指定医生：进入 consult 页「智能匹配」空态（可再选医生） */
  onSkip() {
    wx.navigateTo({ url: '/pages/consult/consult' })
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
