/*
 * consent.js —— 隐私政策版本与独立同意记录（审计 M11）
 *
 * 服务端 GET /api/v1/consent/latest 下发当前版本；用户必须在独立同意页看到
 * 该版本全文并点击“同意”后，才允许登录携带 consentVersion。
 * 版本轮换 → 本地记录与最新版本不一致 → 登录页强制重新进入同意页。
 *
 * 本地只存版本号与用户点击时间戳（审计留痕），不存政策全文/用户身份。
 */
const req = require('./request.js')
const { get, API } = req

const POLICY_VERSION_KEY = 'wb_policy_version'
const POLICY_UPDATED_KEY = 'wb_policy_updated_at'
const CONSENT_VERSION_KEY = 'wb_consent_version'
const CONSENT_AT_KEY = 'wb_consent_at'

let _latest = null

function getStorage(key) {
  try { return wx.getStorageSync(key) || '' } catch (e) { return '' }
}

function setStorage(key, value) {
  try { wx.setStorageSync(key, value) } catch (e) {}
}

/** 拉取服务端当前政策元数据；失败时保留旧缓存但 isAccepted 会因版本不匹配失败关闭。 */
function refreshPolicy() {
  return get(API.CONSENT_LATEST).then((data) => {
    const d = data || {}
    if (!d.version) throw new Error('政策版本响应缺少 version')
    _latest = d
    setStorage(POLICY_VERSION_KEY, String(d.version))
    setStorage(POLICY_UPDATED_KEY, String(d.effectiveAt || ''))
    return d
  })
}

function latestPolicy() {
  if (_latest) return _latest
  const version = getStorage(POLICY_VERSION_KEY)
  if (!version) return null
  return { version, effectiveAt: getStorage(POLICY_UPDATED_KEY), title: '隐私政策' }
}

/** 用户是否已对“服务端当前版本”完成独立同意（版本 + 点击时间戳缺一不可）。 */
function isAccepted() {
  const latest = latestPolicy()
  if (!latest || !latest.version) return false
  const accepted = getStorage(CONSENT_VERSION_KEY)
  const at = Number(getStorage(CONSENT_AT_KEY) || 0)
  return accepted === String(latest.version) && at > 0
}

/** 登录请求可用的 consentVersion；未完成独立同意返回空串，调用方必须阻止登录。 */
function versionForLogin() {
  return isAccepted() ? String(latestPolicy().version) : ''
}

/** 独立同意页点击“同意”时调用：记录版本与用户点击时间戳。 */
function accept(version) {
  const v = String(version || '')
  if (!v) throw new Error('政策版本为空，不能记录同意')
  setStorage(CONSENT_VERSION_KEY, v)
  setStorage(CONSENT_AT_KEY, Date.now())
  return { version: v, acceptedAt: Number(getStorage(CONSENT_AT_KEY)) }
}

module.exports = {
  refreshPolicy,
  latestPolicy,
  isAccepted,
  versionForLogin,
  accept
}
