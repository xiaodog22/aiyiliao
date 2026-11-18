/**
 * capabilities.js —— AI 降级开关快照（2026-11-18）
 *
 * 单一事实来源在后端：ai-service 的 degradeMode / switches 经 business
 * `GET /api/v1/voice/capabilities` 透出。前端只缓存、不另立开关，
 * 避免 `AI_DEGRADE_ENABLED` 与小程序配置手工同步产生偏差。
 *
 * fail-closed：
 *   · 从未成功拉取 → local + 全部 false（宁可退回文字，也不放开云端）；
 *   · 请求失败但本地有旧快照 → 用旧快照（不因一次网络抖动放开云端）；
 *   · 后端返回缺字段 → 一律视为不允许。
 */
const req = require('./request.js')
const API = req.API

const STORAGE_KEY = 'wb_ai_caps'
const TTL_MS = 6 * 60 * 60 * 1000 // 6h；app 每次冷启动会主动刷新
let _cache = null

function _fallback() {
  return { degradeMode: 'local', switches: {}, source: 'fail-closed' }
}

/** 同步读取当前快照（speech.js 在录音/播报入口同步判定，不能 await）。 */
function snapshot() {
  if (_cache) return _cache
  try {
    const saved = wx.getStorageSync(STORAGE_KEY)
    if (saved && saved.ts && Date.now() - Number(saved.ts) < TTL_MS && saved.data) {
      _cache = saved.data
      return _cache
    }
  } catch (e) {}
  _cache = _fallback()
  return _cache
}

/** 后端快照是否允许某供应商（键与 ai-service switches 一致：wechatSi/edge/deepseek/asrCloud）。 */
function allowed(name) {
  const s = snapshot()
  return !!(s && s.switches && s.switches[name] === true)
}

/** 主动刷新；失败不抛错，返回当前可用快照。 */
function refresh() {
  return req.get(API.VOICE_CAPABILITIES, null, { timeout: 8000 })
    .then((data) => {
      const d = data || {}
      const next = {
        degradeMode: d.degradeMode === 'full' ? 'full' : 'local',
        switches: d.switches && typeof d.switches === 'object' ? d.switches : {},
        source: 'remote'
      }
      _cache = next
      try { wx.setStorageSync(STORAGE_KEY, { ts: Date.now(), data: next }) } catch (e) {}
      return next
    })
    .catch(() => snapshot())
}

module.exports = { snapshot, allowed, refresh }
