/**
 * privacy.js —— 微信隐私授权统一入口（2026-11-17）
 *
 * 背景：
 *   自 2023-09 起，涉及收集用户信息的类目必须完成「隐私保护指引」配置与授权弹窗，
 *   否则平台会限制相关接口能力。本项目此前只做了**站内隐私政策页**（pages/profile/privacy），
 *   没有接平台侧 `wx.getPrivacySetting / wx.requirePrivacyAuthorize`，属于上架硬门槛缺口。
 *
 * 约定：
 *   1. 只在**真正要采集**的动作前调用（本项目=录音做 ASR），不要在启动/切页时弹；
 *   2. 失败不阻断整个页面，只让当前动作退回文字输入（语音是增强能力，不是主流程）；
 *   3. 基础库过低 / 开发者工具不支持该 API 时**放行**（不能因为平台缺 API 把功能锁死），
 *      但 `app.json` 已声明 `__usePrivacyCheck__`，正式环境由微信侧兜底。
 *
 * 用法（具名解构，见 AGENTS 红线 13）：
 *   const { ensurePrivacy } = require('../utils/privacy.js')
 *   ensurePrivacy().then((ok) => { if (!ok) 退回文字输入 })
 */
function ensurePrivacy() {
  return new Promise((resolve) => {
    if (typeof wx === 'undefined' || typeof wx.getPrivacySetting !== 'function') {
      resolve(true)
      return
    }
    wx.getPrivacySetting({
      success: (res) => {
        // 已同意 / 无需授权 / 平台未配置隐私指引 → 不弹窗
        if (!res || !res.needAuthorization) { resolve(true); return }
        if (typeof wx.requirePrivacyAuthorize !== 'function') { resolve(true); return }
        wx.requirePrivacyAuthorize({
          success: () => resolve(true),
          fail: () => resolve(false)
        })
      },
      fail: () => resolve(true)
    })
  })
}

/** 打开微信侧《隐私保护指引》（用户拒绝后自查/重新授权用；失败静默） */
function openPrivacyContract() {
  if (typeof wx === 'undefined' || typeof wx.openPrivacyContract !== 'function') return
  try {
    wx.openPrivacyContract({ fail: () => {} })
  } catch (e) { /* 平台不支持，忽略 */ }
}

module.exports = { ensurePrivacy, openPrivacyContract }
