/**
 * services/careplan.js —— 养生/照护建议（契约端点）
 *
 * 契约：POST /api/v1/care-plans（business-service 承接，**同步**返回）
 *   请求：{ goal: string(≤300, 必填), constraints?: string[], locale?, ageBand?: child|adult|elderly }
 *   响应：{ suggestions: [{ title, detail, provenance, citations? }],
 *           limitations: string, refused: boolean, refusalReason?: string }
 *   幂等：Idempotency-Key 必填；同键同载荷 → 重放落库结果（响应头 Idempotency-Replayed: true）
 *
 * ⚠️ 旧路径 POST /api/v1/case/health/care-plan 已是网关 compat pending（501 COMPAT_PENDING），
 *    且其响应是 day1~day3 结构；契约端点是 suggestions[] 结构 —— 页面按新结构渲染（见 health 页）。
 * ⚠️ 生成耗时不定：必须用 ENV.carePlanTimeout（180s）。后端等待预算 75s，超预算返 503（可重试）。
 * ⚠️ 分层约束：页面只调本服务，不得再直连 request.js / config/api.js / config/env.js。
 */
const request = require('./request.js')
const API = require('../config/api.js')
const ENV = require('../config/env.js')

/** 精确年龄 → 契约 ageBand（只传分档，不传生日；缺省按 adult） */
function ageBandOf(age) {
  const n = Number(age)
  if (!isFinite(n) || n <= 0) return 'adult'
  if (n < 14) return 'child'
  if (n >= 60) return 'elderly'
  return 'adult'
}

/** 请求参数：只做契约约束内的兜底（goal 必填且 ≤300），不做业务裁剪 */
function buildPayload(input) {
  const d = input || {}
  const goal = String(d.userInfo || '').trim().slice(0, 300)
  const constraints = Array.isArray(d.constraints)
    ? d.constraints.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 8)
    : []
  return { goal, constraints, ageBand: d.ageBand || ageBandOf(d.age) }
}

/**
 * 开发档演示方案（仅 ENV.MOCK_FALLBACK=true 时被 withFallback 调用）。
 * 数据取自 app.MOCK.WELLNESS，不在此新增任何硬编码方案；结构仍是旧的 days[]，
 * 页面 _normalize 两种结构都认（演示档不会假装是 AI 生成）。
 */
function demoPlan() {
  const app = typeof getApp === 'function' ? getApp() : null
  const src = (app && app.MOCK && app.MOCK.WELLNESS && app.MOCK.WELLNESS.plan) || []
  return {
    days: src.map((d) => ({
      diet: d.diet,
      exercise: d.exercise,
      sleep: d.sleep
    }))
  }
}

/**
 * 生成养生方案（长耗时，调用方需自备阶段提示与超时文案）
 * @param {{ userInfo: string, age: number, ageBand?: string, constraints?: string[] }} input
 * @param {{ idempotencyKey?: string }} [opts] 幂等键：同一次操作重试必须复用同一个键
 * @returns {Promise<Object>} 后端 data 原样返回（suggestions / limitations / refused / refusalReason）
 */
function generate(input, opts) {
  const payload = buildPayload(input)
  if (!payload.goal) {
    return Promise.reject(Object.assign(new Error('请先描述您的健康诉求'), { code: 'BAD_SPEC' }))
  }
  const o = opts || {}
  const reqOpts = { timeout: ENV.carePlanTimeout }
  if (o.idempotencyKey) reqOpts.idempotencyKey = o.idempotencyKey
  return request.withFallback(request.post(API.CARE_PLAN_CREATE, payload, reqOpts), demoPlan)
}

module.exports = {
  generate,
  buildPayload,
  ageBandOf,
  // 幂等键生成（页面不直连 request.js，由服务层代发）
  newKey: () => request.newIdempotencyKey()
}
