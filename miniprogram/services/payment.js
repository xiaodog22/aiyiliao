/**
 * payment.js —— 演示支付服务（P0-1）
 *
 * 边界（不可越线）：
 * - 仅 DEMO 档；不调用 wx.requestPayment，不接微信真实/沙箱支付。
 * - 页面文案固定「演示支付成功（未真实扣款）」；enabled=false 时只显示「请到院窗口缴费」。
 * - 金额由后端按号源费确定，前端不传金额。
 *
 * 契约（backend/contracts/business-openapi.yaml）：
 * - GET  /api/v1/payment/config
 * - POST /api/v1/payment/orders                  （Idempotency-Key 必填）
 * - GET  /api/v1/payment/orders/{orderNo}
 * - POST /api/v1/payment/orders/{orderNo}/demo-pay（Idempotency-Key 必填）
 * - POST /api/v1/payment/orders/{orderNo}/refund  （Idempotency-Key 必填；仅本地演示退费）
 */
const { get, post, withPath, API, newIdempotencyKey } = require('./request.js')

function normalizeOrder(data) {
  if (!data) return null
  const amount = Number(data.amount)
  return {
    orderNo: String(data.orderNo || ''),
    appointmentId: String(data.appointmentId || ''),
    chargeNo: String(data.chargeNo || ''),
    amount: Number.isFinite(amount) ? amount : 0,
    amountText: (Number.isFinite(amount) ? amount : 0).toFixed(2),
    currency: data.currency || 'CNY',
    status: String(data.status || 'UNPAID'),
    source: String(data.source || 'DEMO'),
    demo: data.demo !== false,
    createdAt: data.createdAt || '',
    paidAt: data.paidAt || '',
    refundedAt: data.refundedAt || '',
    refundReason: String(data.refundReason || '')
  }
}

/**
 * 支付能力快照。失败（含 503 PAYMENT_DISABLED）由页面降级为「请到院窗口缴费」。
 * @param {{timeout?:number}} [opts] 可用短超时；网关不可达时尽快进入本地模拟收银台
 */
function getConfig(opts) {
  const o = opts || {}
  return get(API.PAY_CONFIG, undefined, { timeout: o.timeout || 15000 }).then((data) => ({
    enabled: !!(data && data.enabled),
    mode: (data && data.mode) || 'DEMO',
    source: (data && data.source) || 'DEMO',
    disabledMessage: (data && data.disabledMessage) || '请到院窗口缴费',
    successMessage: (data && data.successMessage) || '演示支付成功（未真实扣款）'
  }))
}

/** 按预约建单；重复调用同一预约由后端返回已有订单（不重复建账）。 */
function createOrder(appointmentId, opts) {
  const o = opts || {}
  return post(API.PAY_ORDER_CREATE, { appointmentId: String(appointmentId || '') }, {
    idempotencyKey: o.idempotencyKey || newIdempotencyKey(),
    timeout: o.timeout || 15000
  }).then(normalizeOrder)
}

function getOrder(orderNo) {
  return get(withPath(API.PAY_ORDER_GET, { orderNo: String(orderNo || '') })).then(normalizeOrder)
}

/** 演示支付：显式点击后调用，后端置 PAID；绝不触发微信收银台。 */
function demoPay(orderNo, opts) {
  const o = opts || {}
  return post(withPath(API.PAY_DEMO_PAY, { orderNo: String(orderNo || '') }), {}, {
    idempotencyKey: o.idempotencyKey || newIdempotencyKey()
  }).then(normalizeOrder)
}

/**
 * 演示退费：仅 PAID 可退，后端把状态置 REFUNDED（refund_channel=LOCAL_DEMO）。
 * 不调用微信支付、不触发 clinic-his 退费；页面必须标注「演示退费」。
 */
function refund(orderNo, reason, opts) {
  const o = opts || {}
  return post(withPath(API.PAY_ORDER_REFUND, { orderNo: String(orderNo || '') }), {
    reason: String(reason || '').slice(0, 100)
  }, {
    idempotencyKey: o.idempotencyKey || newIdempotencyKey()
  }).then(normalizeOrder)
}

/* ------------------------------------------------ 费用清单（P2，2026-11-27） */

function normalizeBill(data) {
  const items = Array.isArray(data && data.items) ? data.items : []
  const sum = (data && data.summary) || {}
  return {
    appointmentId: String((data && data.appointmentId) || ''),
    hisOrderNo: (data && data.hisOrderNo) || '',
    items: items.map((it) => {
      const amount = Number(it.amount) || 0
      return {
        chargeNo: String(it.chargeNo || ''),
        categoryText: String(it.categoryText || '其他费用'),
        description: String(it.description || ''),
        amount,
        amountText: amount.toFixed(2),
        status: String(it.status || ''),
        statusText: String(it.statusText || ''),
        paidAt: it.paidAt || '',
        payable: String(it.status || '') === 'UNPAID'
      }
    }),
    payableText: (Number(sum.payable) || 0).toFixed(2),
    paidText: (Number(sum.paid) || 0).toFixed(2),
    count: items.length
  }
}

/**
 * 院内侧费用清单：挂号费 + 就诊过程中开立的处方/检查。
 * 金额与状态一律以后端（院内侧 charges）为准，前端不做任何计算。
 */
function getBill(appointmentId, opts) {
  const o = opts || {}
  return get(API.PAY_BILL, { appointmentId: String(appointmentId || '') },
    { timeout: o.timeout || 15000 }).then(normalizeBill)
}

/** 缴纳单笔费用（演示态，不调起微信支付；金额由后端按院内侧账单确定）。 */
function payBill(appointmentId, chargeNo, opts) {
  const o = opts || {}
  return post(API.PAY_BILL_PAY, {
    appointmentId: String(appointmentId || ''),
    chargeNo: String(chargeNo || '')
  }, {
    timeout: o.timeout || 20000,
    idempotencyKey: o.idempotencyKey || newIdempotencyKey()
  }).then(normalizeBill)
}

module.exports = {
  getConfig,
  createOrder,
  getOrder,
  demoPay,
  refund,
  getBill,
  payBill,
  newIdempotencyKey
}
