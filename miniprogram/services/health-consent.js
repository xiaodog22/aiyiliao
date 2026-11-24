/**
 * services/health-consent.js —— 健康数据单独同意门禁（审计 F4-1）
 *
 * 为什么需要单独一层：
 *   《个人信息保护法》第 29 条要求处理敏感个人信息取得**单独同意**，不能拿登录时的
 *   一般《隐私政策》同意代替。此前前端没有任何授予入口，后端也只在"已撤回"时拦截，
 *   导致患者第一次发症状就会直接进入 AI 链路（敌意审计 HIGH）。
 *
 * 口径：
 *   - HEALTH_DATA_PROCESSING —— 症状文本 / 健康档案 / 报告摘要 / 问诊上下文；
 *   - VOICE_RECORDING        —— 录音与转写（语音入口额外授予）；
 *   - 版本必须等于服务端当前政策版本；政策轮换后需重新同意（后端 409 兜底）。
 *
 * 用法：
 *   healthConsent.ensure().then(ok => { if (!ok) return; ... })
 *   ensure 在未授权时会打开独立授权页，并在用户同意/拒绝后 resolve true/false；
 *   页面 JS 上下文不会销毁，因此调用方的 Promise 链可原地继续。
 */
const req = require('./request.js')
const { get, post, withPath, API } = req
const consent = require('./consent.js')

const HEALTH = 'HEALTH_DATA_PROCESSING'
const VOICE = 'VOICE_RECORDING'

let _cache = null
let _loading = null
let _pending = null

function purposeRow(rows, purpose) {
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {}
    if (String(r.purpose || '') === purpose) return r
  }
  return null
}

function normalize(rows, policyVersion) {
  const list = Array.isArray(rows) ? rows : []
  const h = purposeRow(list, HEALTH) || {}
  const v = purposeRow(list, VOICE) || {}
  return {
    policyVersion: String(policyVersion || ''),
    healthGranted: String(h.status || '') === 'GRANTED',
    healthVersion: String(h.policyVersion || ''),
    voiceGranted: String(v.status || '') === 'GRANTED',
    voiceVersion: String(v.policyVersion || '')
  }
}

/** 读取服务端同意状态 + 当前政策版本；同一启动周期只成功拉取一次。 */
function load(force) {
  if (!force && _cache) return Promise.resolve(_cache)
  if (_loading) return _loading
  _loading = Promise.all([
    get(API.CONSENTS),
    consent.refreshPolicy().catch(() => consent.latestPolicy())
  ]).then(([rows, policy]) => {
    _cache = normalize(rows, policy && policy.version)
    _loading = null
    return _cache
  }, (err) => {
    _loading = null
    throw err
  })
  return _loading
}

/** 设置页撤回 / 重新授权后调用，避免同一次启动继续使用旧状态。 */
function invalidate() {
  _cache = null
  _loading = null
}

function scopeOf(purpose) {
  return purpose === VOICE
    ? ['VOICE_AUDIO', 'VOICE_TRANSCRIPT']
    : ['SYMPTOM_TEXT', 'HEALTH_RECORD', 'REPORT_SUMMARY', 'CONSULTATION_CONTEXT']
}

/**
 * 授予缺失的处理目的（已授予的不重复追加）。
 * @param {{voice?:boolean}} [opts]
 * @returns {Promise<Object>} 最新的本地状态
 */
function grant(opts) {
  const o = opts || {}
  const policy = consent.latestPolicy()
  const version = String((policy && policy.version) || '')
  if (!version) return Promise.reject({ code: 'CONSENT_POLICY_UNAVAILABLE', message: '政策版本未加载，请返回重试' })

  const prev = _cache || {}
  const need = []
  if (!prev.healthGranted || prev.healthVersion !== version) need.push(HEALTH)
  if (o.voice && (!prev.voiceGranted || prev.voiceVersion !== version)) need.push(VOICE)
  if (!need.length) return Promise.resolve(prev)

  return Promise.all(need.map((purpose) => post(API.CONSENTS, {
    purpose,
    policyVersion: version,
    channel: 'MINIPROGRAM',
    scope: scopeOf(purpose)
  }, { idempotencyKey: req.newIdempotencyKey() })))
    .then(() => {
      const next = {
        policyVersion: version,
        healthGranted: need.indexOf(HEALTH) >= 0 ? true : !!prev.healthGranted,
        healthVersion: need.indexOf(HEALTH) >= 0 ? version : prev.healthVersion,
        voiceGranted: need.indexOf(VOICE) >= 0 ? true : !!prev.voiceGranted,
        voiceVersion: need.indexOf(VOICE) >= 0 ? version : prev.voiceVersion
      }
      _cache = next
      return next
    })
    .catch((err) => {
      // 部分成功时让下一次重新读服务端，不把本地状态停留在半授予
      invalidate()
      return Promise.reject(err)
    })
}

function emit(channel, event, payload) {
  try {
    if (channel && channel.emit) channel.emit(event, payload)
  } catch (e) { /* 事件通道失效时以本地状态为准 */ }
}

/** 打开独立授权页；用户同意 → true，取消/返回 → false。 */
function openPage(voice) {
  return new Promise((resolve) => {
    wx.navigateTo({
      url: '/pages/auth/health-consent/health-consent' + (voice ? '?voice=1' : ''),
      events: {
        granted: () => resolve(true),
        declined: () => resolve(false)
      },
      fail: () => resolve(false)
    })
  })
}

/**
 * 确保当前用户已对健康数据（及可选语音）完成单独同意。
 * @param {{voice?:boolean}} [opts]
 * @returns {Promise<boolean>} false = 用户拒绝/页面打开失败，调用方必须中止本次处理
 */
function ensure(opts) {
  if (_pending) return _pending
  const voice = !!(opts && opts.voice)
  _pending = load().then((state) => {
    const needHealth = !state.healthGranted || state.healthVersion !== state.policyVersion
    const needVoice = voice && (!state.voiceGranted || state.voiceVersion !== state.policyVersion)
    if (!needHealth && !needVoice) return true
    return openPage(voice)
  })
  _pending.then(() => { _pending = null }, () => { _pending = null })
  return _pending
}

/** 设置页撤回（只追加 WITHDRAWN，不删除历史；后端立即生效）。 */
function withdraw(purpose, reason) {
  const p = purpose === VOICE ? VOICE : HEALTH
  return post(withPath(API.CONSENT_WITHDRAW, { purpose: p }), {
    reason: String(reason || '用户在设置页撤回').slice(0, 200)
  }, { idempotencyKey: req.newIdempotencyKey() }).then((data) => {
    invalidate()
    return data
  })
}

/** 仅供授权页在用户勾选后调用，保持 grant 的单一实现。 */
module.exports = {
  HEALTH,
  VOICE,
  ensure,
  grant,
  withdraw,
  invalidate,
  load,
  emit
}
