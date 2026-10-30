/**
 * pages/doctor/schedule —— 排班设置（医生端，V22）
 *
 * 数据源（契约 DoctorSchedule，backend/contracts/business-openapi.yaml）：
 *   GET  /api/v1/doctor/schedule    医生本人周模板 + 在线状态（403 非医生）
 *   PUT  /api/v1/doctor/schedule    整体替换周模板（Idempotency-Key 必填；409 版本冲突）
 *   POST /api/v1/doctor/online-status 开关在线接诊（Idempotency-Key 必填；409 仍有待回复问诊）
 *
 * ⚠️ 不伪造：
 *   · weekdays 只含有排班的天；无排班的天显示「休诊」，保存时不提交该天；
 *   · 时段字段全部来自服务端（startTime/endTime/capacity），客户端只做编辑与保存；
 *   · 保存失败（409 VERSION_CONFLICT）→ 提示重新加载后重试，绝不静默覆盖。
 */
const app = getApp()
const doctorService = require('../../../services/doctor.js')
const icons = require('../../../utils/icons.js')
const { errText } = require('../../../utils/err-text.js')

const WEEK_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const PRESET_SLOTS = [
  { label: '上午 09:00-12:00', startTime: '09:00', endTime: '12:00' },
  { label: '下午 14:00-17:30', startTime: '14:00', endTime: '17:30' }
]

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
    version: 0
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
            capacity: sl.capacity || 0,
            onlineOnly: sl.onlineOnly === true
          }))
          return { weekday, name, slots, hasSchedule: slots.length > 0 }
        })
        this.setData({
          loading: false,
          days,
          version: sch.version || 0,
          online: !!(sch.online && sch.online.online)
        })
      })
      .catch((err) => {
        this.setData({ loading: false, error: errText(err, '排班加载失败，请重试') })
      })
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
            capacity: 20,
            onlineOnly: true
          }])
          return Object.assign({}, d, { slots, hasSchedule: slots.length > 0 })
        })
        this.setData({ days })
      },
      fail: () => {}
    })
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
    this.setData({ days })
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
          capacity: Math.max(1, Math.min(50, Number(sl.capacity) || 20)),
          onlineOnly: true
        }))
      }))
    this.setData({ saving: true })
    doctorService.saveSchedule(this.data.version, weekdays)
      .then((res) => {
        const s = (res && res.schedule) || {}
        this.setData({ version: s.version || 0, saving: false })
        wx.showToast({ title: '排班已保存', icon: 'success' })
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
