/**
 * icons-remote.js —— 未进主包的图标（走网关素材通道，按需取）
 *
 * 背景（2026-11-27）：主包「图片 + 音频」有 200KB 建议线，`assets/icons` 已 557KB。
 * 一批新增图标在页面里并无引用（未登记 utils/icons.js），继续留在包内只占体积。
 * 处理方式：PNG 归档到后端 `backend/deploy/resources/icons/`，由既有公开通道
 * `GET {gateway}/api/gw/assets/icons/<file>` 分发（白名单 + ETag + Cache-Control 1 天），
 * 小程序这边**不预先登记、不预先请求**——页面真正要用的那一刻调 `url(key)` 才拼出地址。
 *
 * 约定：
 *   - 只有 require 本模块并调用 url() 才会产生地址；页面静态引用仍走 utils/icons.js（本地）。
 *   - 键名与 utils/icons.js 同风格（camelCase），文件名保持后端原样（含大写，如 fileText_purple）。
 *   - 远程图标需要小程序把网关域名加入 downloadFile 合法域名；本地开发请在
 *     开发者工具勾选「不校验合法域名」。未配置时 <image> 会裂图，属预期。
 */
const FILES = {
  activityAmber: 'activity_amber.png',
  bedMint: 'bed_mint.png',
  calendarGreen: 'calendar_green.png',
  chatPink: 'chat_pink.png',
  chatPurple: 'chat_purple.png',
  fileTextPurple: 'fileText_purple.png',
  heartbeatRed: 'heartbeat_red.png',
  homeAmber: 'home_amber.png',
  leafAmber: 'leaf_amber.png',
  pillGreen: 'pill_green.png',
  tvAmber: 'tv_amber.png',
  userAmber: 'user_amber.png',
  userPurple: 'user_purple.png',
  usersPurple: 'users_purple.png'
}

/** 单个图标的完整地址；key 不存在返回空串（页面按空态处理，不抛错）。 */
function url(key) {
  const file = FILES[key]
  if (!file) return ''
  // 延迟 require：避免仅引用本模块就把 env 的 fail-closed 求值提前到启动期
  const env = require('../config/env')
  const base = String((env && env.gateway) || '').replace(/\/$/, '')
  return base ? base + '/api/gw/assets/icons/' + file : ''
}

/** 一次性拿全部地址（仅在确实要预取时调用，正常按需用 url）。 */
function all() {
  const out = {}
  Object.keys(FILES).forEach((k) => { out[k] = url(k) })
  return out
}

module.exports = { files: FILES, url, all }
