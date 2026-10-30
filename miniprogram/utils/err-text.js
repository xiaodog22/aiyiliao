/**
 * utils/err-text.js —— 把结构化错误翻译成「给人看」的中文文案
 *
 * 为什么单独抽一层：
 *   services/request.js 统一 reject { code, message }，其中 message 可能是
 *   后端业务原文，也可能是**本地 JS 运行时异常**（例如 "paginate is not a function"）。
 *   页面里写 `error: err.message` 就等于把这个英文句子直接渲染到界面上 ——
 *   违反项目两条红线：「用户文案禁英文报错」「用户文案禁 HTTP 码」。
 *   2026-09-16 挂号管理页真实发生：整屏只剩一句 "加载失败：paginate is not a function"。
 *
 * 规则（按优先级）：
 *   ① 已知 code → 直接给确定的中文（不再透传 message，杜绝英文/状态码漏出）；
 *   ② 未知 code 或没有 code → 只有当 message **含中文**时才敢展示；
 *      纯 ASCII 一律判定为"非人话" → 换成 fallback。
 *   ③ 只要发生了兜底替换，就把原文 console.warn 一次：用户看不到英文，
 *      但开发者在控制台仍能溯源 —— 不静默吞错。
 */
const ASCII_ONLY = /^[\x00-\x7F]*$/
const CN = /[\u4e00-\u9fa5]/

/** message 是否"像人话"：含中文且不是纯 ASCII */
function readable(msg) {
  const s = String(msg || '')
  if (!s) return false
  if (ASCII_ONLY.test(s)) return false   // 全英文/纯符号（含 JS 异常、HTTP 码）→ 不给用户看
  return CN.test(s)
}

/**
 * 取一句可以安全展示给用户的中文错误文案。
 * @param {*} err        require.js reject 出来的结构化错误（{ code, message }）
 * @param {string} [fallback] 兜底文案，建议写成「XX加载失败，请重试」
 * @returns {string} 一定是不含英文与 HTTP 状态码的中文
 */
function errText(err, fallback) {
  const fb = fallback || '操作失败，请稍后重试'
  const code = String((err && err.code) || '')
  const raw = String((err && err.message) || '')

  // ① 已知错误码：文案确定，不看 message
  if (code === 'NO_BASE_URL') return '服务地址未配置，请联系管理员'
  if (code === 'NETWORK_ERROR') return '网络连接失败，请检查网络后重试'
  if (code === 'TIMEOUT') return '网络较慢，请求超时，请重试'
  if (code === 'HTTP_ERROR') return '服务暂时不可用，请稍后重试'
  if (code === 'PARSE_ERROR') return '数据格式异常，请稍后重试'
  // 会话类（request.js 的 AUTH_REQUIRED / AUTH_EXPIRED / SESSION_REVOKED 同义：
  // 会话不可用即需重新登录，不向用户暴露 HTTP 码或英文原文）
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_EXPIRED' || code === 'SESSION_REVOKED') {
    return '登录已过期，请重新登录'
  }
  // 限流（网关 429 / 业务 RATE_LIMITED）：中文确定性文案，不走 HTTP_ERROR 通用分支
  if (code === 'RATE_LIMITED') return '操作过于频繁，请稍后再试'

  // ② 业务错误 / 无 code：仅当 message 是中文才展示
  if (readable(raw)) return raw

  // ③ 兜底：把原文留给控制台（不静默吞错），界面只给中文
  if (raw) console.warn('[err-text] 已拦下非中文错误：' + (code || '(no code)') + ' / ' + raw)
  return fb
}

module.exports = { errText, readable }
