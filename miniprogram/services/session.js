/*
 * session.js —— 最小化会话状态
 *
 * access token 只驻留内存；本地仅保存可轮换的 refresh token、到期时间和非权威角色提示。
 * 用户资料、健康信息、预约、聊天等权威数据不得写入 storage。
 */
const REFRESH_KEY = 'wb_refresh_token'
const REFRESH_EXPIRES_KEY = 'wb_refresh_expires_at'
const ROLE_HINT_KEY = 'wb_role_hint'

/**
 * refresh 令牌有效期：**镜像服务端**规则（business-service …/common/AuthSessionStore.REFRESH_TTL = 7 天）。
 * ⚠️ 客户端不得延长本地有效期：
 *   - 契约 Session 只返回 `expiresIn`，它**仅代表本次 access token** 的有效期，禁止据此推断 refresh 过期；
 *   - 服务端才是权威判定；本地过期只用于提前拦掉注定无效的请求，避免无谓的 401。
 *   - 若本地与服务端 TTL 漂移，最坏结果是多一次无效刷新请求（随后被服务端 401 清理并要求重登），
 *     不会因本地更长而让失效令牌通过服务端校验。
 */
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60

let accessToken = ''
let accessExpiresAt = 0
/**
 * 会话代次：每次 clear() 自增。
 * 用途：异步刷新（refreshAccessToken）发出时记下代次，回来时代次变了说明期间已退出登录，
 * 必须丢弃结果——否则会把已清掉的 refresh 又写回 storage（"退出后令牌复活"）。
 */
let epoch = 0

function nowSeconds() { return Math.floor(Date.now() / 1000) }

function getAccessToken() {
  if (!accessToken || (accessExpiresAt && accessExpiresAt <= nowSeconds() + 15)) return ''
  return accessToken
}

function getRefreshToken() {
  try {
    const expiresAt = Number(wx.getStorageSync(REFRESH_EXPIRES_KEY) || 0)
    if (expiresAt && expiresAt <= nowSeconds()) {
      clear()
      return ''
    }
    return wx.getStorageSync(REFRESH_KEY) || ''
  } catch (e) {
    return ''
  }
}

function setTokens(tokens) {
  const t = tokens || {}
  accessToken = t.accessToken || t.access_token || ''
  // expiresIn 只用于 access token（契约 7200s）；不动 refresh 的有效期
  const accessExpiresIn = Number(t.expiresIn || t.expires_in || 900)
  accessExpiresAt = accessToken ? nowSeconds() + Math.max(30, accessExpiresIn) : 0

  const refresh = t.refreshToken || t.refresh_token
  if (refresh) {
    // 服务端不返回 refresh 过期时间 → 一律按 7 天规则重设（每次刷新轮换后同样重设，
    // 与"服务端新签发会话行"的 TTL 保持一致）。不接受任何客户端/响应体传入的延长期。
    try {
      wx.setStorageSync(REFRESH_KEY, refresh)
      wx.setStorageSync(REFRESH_EXPIRES_KEY, nowSeconds() + REFRESH_TTL_SECONDS)
    } catch (e) {}
  }
}

function setRoleHint(role) {
  try {
    if (role) wx.setStorageSync(ROLE_HINT_KEY, role)
    else wx.removeStorageSync(ROLE_HINT_KEY)
  } catch (e) {}
}

function getRoleHint() {
  try { return wx.getStorageSync(ROLE_HINT_KEY) || '' } catch (e) { return '' }
}

function hasSession() { return !!(getAccessToken() || getRefreshToken()) }

/** 当前会话代次（配合异步刷新判"结果是否已过期"） */
function getEpoch() { return epoch }

function clear() {
  epoch++
  accessToken = ''
  accessExpiresAt = 0
  try {
    wx.removeStorageSync(REFRESH_KEY)
    wx.removeStorageSync(REFRESH_EXPIRES_KEY)
    wx.removeStorageSync(ROLE_HINT_KEY)
  } catch (e) {}
}

/**
 * 会话快照 / 恢复 —— 供「清除缓存」这类全量 storage 操作保留登录态。
 * ⚠️ 只搬运 refresh 令牌原文与本地到期时间，不改任何 TTL 规则：
 *    到期判定仍由 getRefreshToken()（本地预拦）与服务端共同决定，恢复不会延长会话。
 */
function snapshot() {
  try {
    return {
      refresh: wx.getStorageSync(REFRESH_KEY) || '',
      expiresAt: Number(wx.getStorageSync(REFRESH_EXPIRES_KEY) || 0)
    }
  } catch (e) {
    return null
  }
}

function restore(snap) {
  if (!snap || !snap.refresh) return false
  try {
    wx.setStorageSync(REFRESH_KEY, snap.refresh)
    if (snap.expiresAt) wx.setStorageSync(REFRESH_EXPIRES_KEY, snap.expiresAt)
    return true
  } catch (e) {
    return false
  }
}

module.exports = {
  getAccessToken,
  getRefreshToken,
  setTokens,
  setRoleHint,
  getRoleHint,
  hasSession,
  getEpoch,
  clear,
  snapshot,
  restore
}
