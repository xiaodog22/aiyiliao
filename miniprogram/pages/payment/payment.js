/**
 * pages/payment —— 演示支付（P0-1）
 *
 * 红线：
 * - 不调用 wx.requestPayment；本页只是本地/后端演示回调，不是真实收费。
 * - 成功文案固定「演示支付成功（未真实扣款）」；关闭时只显示「请到院窗口缴费」。
 * - 金额来自后端订单（号源费）；本地模拟单固定 0.01 元，仅用于界面演示。
 * - 个人主体/后端未开启时：提供「模拟支付（本地演示）」入口，
 * 在本地生成 0.01 元演示单并走模拟收银台，不写后端、不产生真实扣款；
 * 仅开发档显示，生产构建不出现。
 */
const payment = require('../../services/payment.js')
const { errText } = require('../../utils/err-text.js')
const icons = require('../../utils/icons.js')
const ENV = require('../../config/env.js')

const LOCAL_DEMO_AMOUNT = 0.01

Page({
  data: {
    icons,
    loading: true,
    enabled: false,
    disabledMessage: '演示支付未开启，请到院窗口缴费',
    successMessage: '演示支付成功（未真实扣款）',
    appointmentId: '',
    order: null,
    paying: false,
    refunding: false,
    // 开发/演示档：真实支付关闭时仍可在本地模拟收银台走通界面
    demoEnabled: ENV.legacyManualLoginEnabled,
    error: ''
  },

  onLoad(options) {
    const appointmentId = String((options && options.appointmentId) || '')
    this.setData({ appointmentId })
    this.loadConfig(appointmentId)
  },

  loadConfig(appointmentId) {
    // 5s 短超时：网关/后端不可达时尽快露出「模拟支付（本地演示）」，
    // 不让个人主体演示页面先转圈几十秒。
    payment.getConfig({ timeout: 5000 })
      .then((cfg) => {
        this.setData({
          enabled: cfg.enabled,
          disabledMessage: cfg.disabledMessage,
          successMessage: cfg.successMessage
        })
        if (!cfg.enabled) {
          this.setData({ loading: false })
          return
        }
        if (!appointmentId) {
          this.setData({ loading: false, error: '缺少预约信息，请从挂号成功页进入' })
          return
        }
        this.createOrder(appointmentId)
      })
      .catch((err) => {
        // 配置读取失败（含未登录/网络）按未开启处理，绝不猜测已开启
        this.setData({ enabled: false, loading: false, error: errText(err) })
      })
  },

  createOrder(appointmentId) {
    // 同一页面的建单键固定；页面重进时后端按 appointmentId 返回已有订单
    if (!this._createKey) this._createKey = payment.newIdempotencyKey()
    payment.createOrder(appointmentId, { idempotencyKey: this._createKey, timeout: 8000 })
      .then((order) => {
        this.setData({ order, loading: false, error: '' })
      })
      .catch((err) => {
        this.setData({ loading: false, error: errText(err, '订单创建失败，请到院窗口缴费') })
      })
  },

  onPay() {
    const order = this.data.order
    if (!order || order.status === 'PAID' || this.data.paying) return
    // 本地模拟单不请求后端，直接走模拟收银台
    if (order.localDemo) {
      this.onLocalDemoPay()
      return
    }
    this.setData({ paying: true, error: '' })
    payment.demoPay(order.orderNo)
      .then((next) => {
        this.setData({ order: next, paying: false })
        if (next && next.status === 'PAID') {
          wx.showToast({ title: '演示支付成功', icon: 'success' })
        } else {
          this.setData({ error: '支付未完成，请重试或到院窗口缴费' })
        }
      })
      .catch((err) => {
        this.setData({ paying: false, error: errText(err, '支付未完成，请稍后重试') })
        this.refreshOrder()
      })
  },

  /**
   * 演示退费（2026-11-21）：仅 PAID 可退，后端置 REFUNDED（refund_channel=LOCAL_DEMO）。
   * 不调用微信退款、不触发医院退费；弹窗与成功态都必须写明“未真实退款”。
   */
  onRefund() {
    const order = this.data.order
    if (!order || order.status !== 'PAID' || this.data.refunding || order.localDemo) return
    wx.showModal({
      title: '申请退费（演示）',
      content: '将把订单置为「已退费」。这是演示流程，不会发起真实退款，实际到账以医院窗口为准。',
      confirmText: '确认退费',
      success: (r) => {
        if (!r || !r.confirm) return
        this.setData({ refunding: true, error: '' })
        payment.refund(order.orderNo, '用户申请退费（演示）')
          .then((next) => {
            this.setData({ order: next, refunding: false })
            wx.showToast({ title: '已退费（演示）', icon: 'none' })
          })
          .catch((err) => {
            this.setData({ refunding: false, error: errText(err, '退费失败，请稍后重试') })
          })
      }
    })
  },

  /**
   * 本地模拟收银台 —— 不依赖后端支付开关/登录态。
   * 生成 0.01 元演示单，弹确认框，确认后只改本地状态；不写订单、不调微信支付。
   */
  startLocalDemo() {
    const stamp = Date.now()
    const order = {
      orderNo: 'DEMO-PAY-' + stamp,
      appointmentId: this.data.appointmentId || 'DEMO-APPOINTMENT',
      chargeNo: 'DEMO-CHARGE-' + stamp,
      amount: LOCAL_DEMO_AMOUNT,
      amountText: LOCAL_DEMO_AMOUNT.toFixed(2),
      currency: 'CNY',
      status: 'UNPAID',
      source: 'LOCAL_DEMO',
      demo: true,
      localDemo: true,
      createdAt: '',
      paidAt: ''
    }
    this.setData({ order, loading: false, paying: false, error: '' })
  },

  onLocalDemoPay() {
    if (this.data.paying || !this.data.order) return
    const amountText = this.data.order.amountText || LOCAL_DEMO_AMOUNT.toFixed(2)
    this.setData({ paying: true, error: '' })
    wx.showModal({
      title: '模拟收银台',
      content: '确认模拟支付 ¥' + amountText + '？这是本地演示，不会产生真实扣款。',
      confirmText: '模拟支付',
      success: (r) => {
        if (!r || !r.confirm) {
          this.setData({ paying: false })
          wx.showToast({ title: '已取消模拟支付', icon: 'none' })
          return
        }
        const order = Object.assign({}, this.data.order, {
          status: 'PAID',
          paidAt: new Date().toISOString()
        })
        this.setData({ order, paying: false })
        wx.showToast({ title: '模拟支付成功', icon: 'success' })
      },
      fail: () => this.setData({ paying: false })
    })
  },

  refreshOrder() {
    const order = this.data.order
    if (!order || !order.orderNo || order.localDemo) return
    payment.getOrder(order.orderNo)
      .then((next) => this.setData({ order: next }))
      .catch(() => {})
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  }
})
