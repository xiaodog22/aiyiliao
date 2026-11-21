/**
 * exam.js —— 检查预约服务（P0-2）
 *
 * 边界（不可越线）：
 * - 仅演示排期，不接真实医院检查号源；页面固定标「演示预约（未真实排期）」。
 * - 金额由后端取 HIS 项目价，前端不传金额。
 * - 关闭态（enabled=false）页面只显示后端提示，不请求项目/排期。
 *
 * 契约（backend/contracts/business-openapi.yaml）：
 * - GET  /api/v1/exam/config
 * - GET  /api/v1/exam/items
 * - GET  /api/v1/exam/items/{itemCode}/slots
 * - POST /api/v1/exam/orders                    （Idempotency-Key 必填）
 * - GET  /api/v1/exam/orders/me
 * - GET  /api/v1/exam/orders/{requestNo}
 * - POST /api/v1/exam/orders/{requestNo}/cancel （Idempotency-Key 必填）
 */
const { get, post, withPath, API, newIdempotencyKey } = require('./request.js')

function amountText(value) {
  const n = Number(value)
  return (Number.isFinite(n) ? n : 0).toFixed(2)
}

function normalizeItem(data) {
  if (!data) return null
  return {
    itemCode: String(data && data.itemCode || ''),
    itemName: String(data && data.itemName || ''),
    category: String(data && data.category || ''),
    price: Number(data && data.price) || 0,
    priceText: amountText(data && data.price),
    demo: data && data.demo !== false
  }
}

function normalizeSlot(data) {
  if (!data) return null
  return {
    slotKey: String(data.slotKey || ''),
    slotDate: String(data.slotDate || ''),
    slotTime: String(data.slotTime || ''),
    available: !!(data && data.available),
    dateLabel: String(data.slotDate || '').replace(/-/g, '/').slice(5),
    fullLabel: String(data.slotDate || '') + ' ' + String(data.slotTime || '')
  }
}

function normalizeOrder(data) {
  if (!data) return null
  const price = Number(data.price) || 0
  return {
    requestNo: String(data.requestNo || ''),
    examOrderNo: String(data.examOrderNo || ''),
    itemCode: String(data.itemCode || ''),
    itemName: String(data.itemName || ''),
    price,
    priceText: amountText(price),
    slotKey: String(data.slotKey || ''),
    slotDate: String(data.slotDate || ''),
    slotTime: String(data.slotTime || ''),
    fullLabel: String(data.slotDate || '') + ' ' + String(data.slotTime || ''),
    status: String(data.status || 'BOOKED'),
    statusText: ({ BOOKED: '已预约', CANCELLED: '已取消', COMPLETED: '已完成' })[data.status] || '已预约',
    source: String(data.source || 'DEMO'),
    demo: true,
    replayed: !!data.replayed,
    createdAt: data.createdAt || ''
  }
}

function getConfig() {
  return get(API.EXAM_CONFIG).then((data) => ({
    enabled: !!(data && data.enabled),
    mode: (data && data.mode) || 'DEMO',
    source: (data && data.source) || 'DEMO',
    disabledMessage: (data && data.disabledMessage) || '检查预约暂未开放，请到院窗口办理',
    demoNotice: (data && data.demoNotice) || '演示预约（未真实排期，不产生检查费用）'
  }))
}

function listItems() {
  return get(API.EXAM_ITEMS).then((list) => (list || []).map(normalizeItem).filter(Boolean))
}

function listSlots(itemCode) {
  return get(withPath(API.EXAM_SLOTS, { itemCode: String(itemCode || '') })).then((data) => ({
    itemCode: String(data && data.itemCode || itemCode || ''),
    itemName: String(data && data.itemName || ''),
    slots: ((data && data.slots) || []).map(normalizeSlot).filter(Boolean)
  }))
}

function createOrder(payload, opts) {
  const o = opts || {}
  const body = {
    itemCode: String(payload && payload.itemCode || ''),
    slotKey: String(payload && payload.slotKey || ''),
    patientName: String(payload && payload.patientName || '')
  }
  if (payload && payload.familyMemberId) body.familyMemberId = String(payload.familyMemberId)
  return post(API.EXAM_ORDER_CREATE, body, {
    idempotencyKey: o.idempotencyKey || newIdempotencyKey()
  }).then(normalizeOrder)
}

function listMine() {
  return get(API.EXAM_ORDER_LIST).then((list) => (list || []).map(normalizeOrder).filter(Boolean))
}

function getOrder(requestNo) {
  return get(withPath(API.EXAM_ORDER_GET, { requestNo: String(requestNo || '') })).then(normalizeOrder)
}

function cancel(requestNo, opts) {
  const o = opts || {}
  return post(withPath(API.EXAM_ORDER_CANCEL, { requestNo: String(requestNo || '') }), {}, {
    idempotencyKey: o.idempotencyKey || newIdempotencyKey()
  }).then(normalizeOrder)
}

module.exports = {
  getConfig,
  listItems,
  listSlots,
  createOrder,
  listMine,
  getOrder,
  cancel,
  newIdempotencyKey
}
