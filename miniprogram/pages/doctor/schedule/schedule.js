/**
 * pages/doctor/schedule —— 线上问诊设置（医生端，V22 / 2026-11-15 语义修正）
 *
 * 数据源（契约 DoctorSchedule，backend/contracts/business-openapi.yaml）：
 *   GET  /api/v1/doctor/schedule    医生本人周模板 + 在线状态（403 非医生）
 *   PUT  /api/v1/doctor/schedule    整体替换周模板（Idempotency-Key 必填；409 版本冲突）
 *   POST /api/v1/doctor/online-status 开关在线接诊（Idempotency-Key 必填；409 仍有待回复问诊）
 *
 * ⚠️ 这一页配置的是**线上问诊**（图文咨询）的接诊能力，不是线下门诊号源：
 *   · 在线接诊开关 = 患者能否在「在线问诊 → 选择医生」中看到并选择您；
 *   · 时段 = 您可以接诊的时间窗，capacity = 该时段最多接诊人数；
 *   · 患者提交预约后仍需您在工作台「接单」，接单后双方才能对话。
 * ⚠️ 不伪造：
 *   · weekdays 只含有排班的天；无排班的天显示「休息」，保存时不提交该天；
 *   · 时段字段全部来自服务端（startTime/endTime/capacity），客户端只做编辑与保存；
 *   · 保存失败（409 VERSION_CONFLICT）→ 提示重新加载后重试，绝不静默覆盖。
 */
const app = getApp()
const doctorService = require('../../../services/doctor.js')
const icons = require('../../../utils/icons.js')
const { errText } = require('../../../utils/err-text.js')

const WEEK_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
/** 线上问诊常用时段（含晚间，区别于线下门诊的 8:00-17:30 排班） */
const PRESET_SLOTS = [
  { label: '上午 09:00-12:00', startTime: '09:00', endTime: '12:00' },
  { label: '下午 14:00-17:30', startTime: '14:00', endTime: '17:30' },
  { label: '晚间 19:00-21:30', startTime: '19:00', endTime: '21:30' }
]
const DEFAULT_CAPACITY = 10
const MIN_CAPACITY = 1
const MAX_CAPACITY = 50

Page({
  data: {
    icons,
    theme: 'standard',
    statusBarHeight: 20,
    navH: 64,
    loading: true,
    error: '',
    saving: false,
    online: false,
    days: [],          // 7 行展示：[{weekday, name, slots:[...], hasSchedule}]
    version: 0,
    // 周模板汇总（页面顶部提示条）：本周接诊时段数 + 预计可接诊人数
    weekSlots: 0,
    weekCapacity: 0
  },

  onLoad() {
    if (app.globalData.role !== 'doctor') {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}
    this.setData({ theme: app.globalData.theme || 'standard', statusBarHeight: sbh, navH: sbh + 44 })
    this.fetch()
  },

  onBack() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.reLaunch({ url: '/pages/doctor/workbench/workbench' })
  },

  fetch() {
    this.setData({ loading: true, error: '' })
    doctorService.getSchedule()
      .then((s) => {
        const sch = s || {}
        const weekdays = Array.isArray(sch.weekdays) ? sch.weekdays : []
        const byDay = {}
        weekdays.forEach((d) => {
          if (d && d.weekday >= 1 && d.weekday <= 7) byDay[d.weekday] = d.slots || []
        })
        const days = WEEK_NAMES.map((name, idx) => {
          const weekday = idx + 1
          const slots = (byDay[weekday] || []).map((sl) => ({
            startTime: sl.startTime || '',
            endTime: sl.endTime || '',
            capacity: sl.capacity || DEFAULT_CAPACITY,
            onlineOnly: sl.onlineOnly !== false
          }))
          return { weekday, name, slots, hasSchedule: slots.length > 0 }
        })
        this.setData(Object.assign({
          loading: false,
          days,
          version: sch.version || 0,
          online: !!(sch.online && sch.online.online)
        }, this._summarize(days)))
      })
      .catch((err) => {
        this.setData({ loading: false, error: errText(err, '线上问诊设置加载失败，请重试') })
      })
  },

  /** 周模板汇总：时段数 + 预计可接诊人数（纯本地计算，保存前后都展示） */
  _summarize(days) {
    let weekSlots = 0
    let weekCapacity = 0
    ;(days || []).forEach((d) => {
      (d.slots || []).forEach((sl) => {
        weekSlots += 1
        weekCapacity += Math.max(0, Number(sl.capacity) || 0)
      })
    })
    return { weekSlots, weekCapacity }
  },

  /** 在线接诊开关（POST /api/v1/doctor/online-status） */
  onOnlineChange(e) {
    const next = !!(e.detail && e.detail.value)
    this.setData({ online: next })
    doctorService.setOnlineStatus(next)
      .catch((err) => {
        this.setData({ online: !next })
        if (err && err.code === 'VERSION_CONFLICT') {
          wx.showToast({ title: '仍有待回复的问诊，暂时无法下线', icon: 'none', duration: 2500 })
        } else {
          wx.showToast({ title: errText(err, '操作失败，请重试'), icon: 'none' })
        }
      })
  },

  /** 排班已配置但未开接诊：一键开启，避免患者端一直显示「暂不接诊」 */
  onEnableOnline() {
    if (this.data.online) return
    this.onOnlineChange({ detail: { value: true } })
  },

  /** 为某天添加预设时段（ActionSheet 选时段） */
  onAddSlot(e) {
    const weekday = Number(e.currentTarget.dataset.weekday)
    const day = this.data.days.filter((d) => d.weekday === weekday)[0]
    if (!day) return
    const acts = PRESET_SLOTS.map((p) => p.label)
    wx.showActionSheet({
      itemList: acts,
      success: (res) => {
        const p = PRESET_SLOTS[res.tapIndex]
        if (!p) return
        // 冲突检查：同天已有重叠时段 → 提示不落
        const clash = day.slots.some((sl) => sl.startTime < p.endTime && p.startTime < sl.endTime)
        if (clash) {
          wx.showToast({ title: '与已有时段重叠，请选择其他时段', icon: 'none' })
          return
        }
        const days = this.data.days.map((d) => {
          if (d.weekday !== weekday) return d
          const slots = d.slots.concat([{
            startTime: p.startTime,
            endTime: p.endTime,
            capacity: DEFAULT_CAPACITY,
            onlineOnly: true
          }])
          return Object.assign({}, d, { slots, hasSchedule: slots.length > 0 })
        })
        this.setData(Object.assign({ days }, this._summarize(days)))
      },
      fail: () => {}
    })
  },

  /** 调整某时段可接诊人数（±1，范围 1~50；保存时随模板提交） */
  onCapStep(e) {
    const weekday = Number(e.currentTarget.dataset.weekday)
    const index = Number(e.currentTarget.dataset.index)
    const delta = Number(e.currentTarget.dataset.delta) || 0
    const days = this.data.days.map((d) => {
      if (d.weekday !== weekday) return d
      const slots = d.slots.map((sl, i) => {
        if (i !== index) return sl
        const next = Math.max(MIN_CAPACITY, Math.min(MAX_CAPACITY, (Number(sl.capacity) || 0) + delta))
        return Object.assign({}, sl, { capacity: next })
      })
      return Object.assign({}, d, { slots })
    })
    this.setData(Object.assign({ days }, this._summarize(days)))
  },

  /** 删除某天某时段（本地移除，保存时生效） */
  onRemoveSlot(e) {
    const weekday = Number(e.currentTarget.dataset.weekday)
    const index = Number(e.currentTarget.dataset.index)
    const days = this.data.days.map((d) => {
      if (d.weekday !== weekday) return d
      const slots = d.slots.filter((_, i) => i !== index)
      return Object.assign({}, d, { slots, hasSchedule: slots.length > 0 })
    })
    this.setData(Object.assign({ days }, this._summarize(days)))
  },

  /** 保存周模板（整体替换；expectedVersion 乐观锁） */
  onSave() {
    if (this.data.saving) return
    const weekdays = this.data.days
      .filter((d) => d.hasSchedule)
      .map((d) => ({
        weekday: d.weekday,
        slots: d.slots.map((sl) => ({
          startTime: sl.startTime,
          endTime: sl.endTime,
          slotMinutes: 30,
          capacity: Math.max(MIN_CAPACITY, Math.min(MAX_CAPACITY, Number(sl.capacity) || DEFAULT_CAPACITY)),
          onlineOnly: true
        }))
      }))
    this.setData({ saving: true })
    doctorService.saveSchedule(this.data.version, weekdays)
      .then((res) => {
        const s = (res && res.schedule) || {}
        this.setData({ version: s.version || 0, saving: false })
        if (!this.data.online && weekdays.length) {
          // 只保存排班不会改变在线开关；不提示的话医生会以为患者已经能挂号。
          wx.showModal({
            title: '排班已保存',
            content: '当前「在线接诊」未开启，患者端仍会显示「暂不接诊」。是否现在开启？',
            confirmText: '开启接诊',
            cancelText: '稍后再说',
            success: (r) => { if (r.confirm) this.onEnableOnline() }
          })
          return
        }
        wx.showToast({ title: '线上问诊排班已保存', icon: 'success' })
      })
      .catch((err) => {
        this.setData({ saving: false })
        if (err && err.code === 'VERSION_CONFLICT') {
          wx.showToast({ title: '排班已被更新，请重新加载', icon: 'none', duration: 2500 })
          this.fetch()
        } else {
          wx.showToast({ title: errText(err, '保存失败，请重试'), icon: 'none' })
        }
      })
  }
})
