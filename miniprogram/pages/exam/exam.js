/**
 * pages/exam —— 检查预约（P0-2，演示排期）
 *
 * 边界：
 * - 仅演示排期，不接真实医院检查号源；页面固定显示「演示预约（未真实排期）」。
 * - 金额由后端取 HIS 项目价，前端不传金额。
 * - 关闭态（enabled=false）只显示后端提示，不请求项目/排期。
 */
const app = getApp()
const examService = require('../../services/exam.js')
const { errText } = require('../../utils/err-text.js')

function groupSlots(slots) {
  const groups = []
  const map = {}
  ;(slots || []).forEach((s) => {
    if (!s.slotDate) return
    if (!map[s.slotDate]) {
      map[s.slotDate] = { date: s.slotDate, label: s.dateLabel || s.slotDate.slice(5), slots: [] }
      groups.push(map[s.slotDate])
    }
    map[s.slotDate].slots.push(s)
  })
  return groups
}

Page({
  data: {
    loading: true,
    enabled: false,
    disabledMessage: '检查预约暂未开放，请到院窗口办理',
    demoNotice: '演示预约（未真实排期，不产生检查费用）',
    items: [],
    selectedItem: null,
    slotGroups: [],
    selectedSlot: null,
    patientName: '',
    submitting: false,
    order: null,
    orders: [],
    error: ''
  },

  onLoad() {
    this._idem = ''
    const user = wx.getStorageSync('wb_user') || {}
    this.setData({ patientName: user.name || '' })
    this.loadConfig()
  },

  loadConfig() {
    this.setData({ loading: true, error: '' })
    examService.getConfig().then((cfg) => {
      this.setData({
        enabled: cfg.enabled,
        disabledMessage: cfg.disabledMessage,
        demoNotice: cfg.demoNotice,
        loading: false
      })
      if (cfg.enabled) {
        this.loadItems()
        this.loadMine()
      }
    }).catch((err) => {
      this.setData({ loading: false, enabled: false, error: errText(err, '检查预约加载失败，请重试') })
    })
  },

  loadItems() {
    examService.listItems().then((items) => {
      this.setData({ items })
    }).catch((err) => {
      this.setData({ error: errText(err, '检查项目加载失败，请重试') })
    })
  },

  loadMine() {
    examService.listMine().then((orders) => {
      this.setData({ orders })
    }).catch(() => { /* 我的预约失败不阻塞选项目 */ })
  },

  pickItem(e) {
    const itemCode = e.currentTarget.dataset.code
    const item = this.data.items.filter((i) => i.itemCode === itemCode)[0]
    if (!item) return
    this.setData({
      selectedItem: item, selectedSlot: null, slotGroups: [], order: null, error: ''
    })
    examService.listSlots(itemCode).then((data) => {
      this.setData({ slotGroups: groupSlots(data.slots) })
    }).catch((err) => {
      this.setData({ error: errText(err, '检查排期加载失败，请重试') })
    })
  },

  pickSlot(e) {
    const slot = e.currentTarget.dataset.slot
    if (!slot || !slot.available) return
    this.setData({ selectedSlot: slot, order: null, error: '' })
  },

  onNameInput(e) {
    this.setData({ patientName: e.detail.value })
  },

  submit() {
    if (this.data.submitting) return
    const item = this.data.selectedItem
    const slot = this.data.selectedSlot
    const name = String(this.data.patientName || '').trim()
    if (!item) return this.toast('请先选择检查项目')
    if (!slot) return this.toast('请选择检查时段')
    if (!name) return this.toast('请填写就诊人姓名')
    if (!this._idem) this._idem = examService.newIdempotencyKey()

    this.setData({ submitting: true, error: '' })
    examService.createOrder({
      itemCode: item.itemCode, slotKey: slot.slotKey, patientName: name
    }, { idempotencyKey: this._idem }).then((order) => {
      this._idem = ''
      this.setData({ submitting: false, order, selectedSlot: null })
      this.loadMine()
      wx.showToast({ title: '预约成功', icon: 'success' })
    }).catch((err) => {
      this.setData({ submitting: false, error: errText(err, '检查预约失败，请重试') })
    })
  },

  cancelOrder(e) {
    const requestNo = e.currentTarget.dataset.no
    if (!requestNo) return
    const self = this
    wx.showModal({
      title: '取消检查预约',
      content: '取消后需重新选择时段，确认取消？',
      success(res) {
        if (!res.confirm) return
        examService.cancel(requestNo, { idempotencyKey: examService.newIdempotencyKey() }).then(() => {
          self.setData({ order: null })
          self.loadMine()
          wx.showToast({ title: '已取消', icon: 'none' })
        }).catch((err) => {
          wx.showToast({ title: errText(err, '取消失败，请重试'), icon: 'none' })
        })
      }
    })
  },

  goHome() {
    wx.reLaunch({ url: '/pages/home/home' })
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' })
  }
})
