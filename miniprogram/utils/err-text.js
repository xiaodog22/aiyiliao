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
  if (code === 'OFFLINE') return '当前未连接院内服务，暂时不能提交，请恢复网络后重试'
  if (code === 'NETWORK_ERROR') return '网络连接失败，请检查网络后重试'
  if (code === 'TIMEOUT') return '网络较慢，请求超时，请重试'
  if (code === 'HTTP_ERROR') return '服务暂时不可用，请稍后重试'
  if (code === 'INTERNAL_ERROR' || code === 'SERVICE_UNAVAILABLE') return '服务暂时不可用，请稍后重试'
  // 乐观锁/幂等冲突：这是“数据已变，重读即可”，不是服务故障；必须与 HTTP_ERROR 分开。
  if (code === 'VERSION_CONFLICT') return '内容已被更新，请重新加载后重试'
  if (code === 'IDEMPOTENCY_KEY_REUSE') return '该操作已提交过，请刷新后查看'
  if (code === 'SCHEDULE_OVERLAP') return '时段有重叠，请调整后再保存'
  if (code === 'PARSE_ERROR') return '数据格式异常，请稍后重试'
  // 会话类（request.js 的 AUTH_REQUIRED / AUTH_EXPIRED / SESSION_REVOKED 同义：
  // 会话不可用即需重新登录，不向用户暴露 HTTP 码或英文原文）
  // ⚠️ TOKEN_EXPIRED 是**向前兼容**（2026-11-01）：后端目前对 access 过期统一回 SESSION_REVOKED，
  //    语义不准（过期 ≠ 撤销），后续可能拆成 TOKEN_EXPIRED。前端先认它，后端再改 code——
  //    顺序反过来会让"已发布的老版本小程序"把过期显示成默认文案。
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_EXPIRED' || code === 'SESSION_REVOKED'
      || code === 'TOKEN_EXPIRED') {
    return '登录已过期，请重新登录'
  }
  // 限流（网关 429 / 业务 RATE_LIMITED）：中文确定性文案，不走 HTTP_ERROR 通用分支
  if (code === 'RATE_LIMITED') return '操作过于频繁，请稍后再试'
  // 挂号业务冲突（DEF-03）：同一号源已有在办预约 —— 明确告知，别让用户以为是号源被抢
  if (code === 'DUPLICATE_APPOINTMENT') return '您已预约该时段，请勿重复挂号'
  // 家庭代管授权（DEF-01/04）：添加家人不等于拿到授权，授权未完成或已失效
  if (code === 'FAMILY_MEMBER_NOT_FOUND') return '尚未获得该成员的代管授权'
  if (code === 'INVITATION_EXPIRED') return '授权码已使用或已过期，请重新申请'
  if (code === 'INVITATION_NOT_FOUND') return '授权码无效，请重新申请'
  // 在线问诊：先预约、等医生接单后才能继续对话（后端 409 WAITING_ACCEPT）
  if (code === 'WAITING_ACCEPT') return '医生接单后才能继续对话，请耐心等待'
  // 健康数据/语音单独同意（审计 F4-1）：后端 422/409 与前端取消分支统一给人话，不透传英文
  if (code === 'CONSENT_REQUIRED') return '请先阅读并同意《健康数据处理授权说明》后再使用 AI 功能'
  if (code === 'CONSENT_VERSION_MISMATCH') return '健康数据授权版本已更新，请重新阅读并同意'
  if (code === 'CONSENT_WITHDRAWN') return '健康数据授权已撤回，请到「设置 — 健康数据授权」重新授权'
  if (code === 'CONSENT_DECLINED') return '本次未同意健康数据授权，操作已取消'
  // 检查预约（P0-2）：时段被占/项目不存在/状态不可取消一律给人话，不透传 HIS 英文
  if (code === 'EXAM_DISABLED') return '检查预约暂未开放，请到院窗口办理'
  if (code === 'EXAM_SLOT_TAKEN') return '该时段已被预约，请换一个时段'
  if (code === 'EXAM_SLOT_INVALID') return '所选时段已不在排期内，请重新选择'
  if (code === 'EXAM_ITEM_NOT_FOUND') return '检查项目不存在，请刷新后重试'
  if (code === 'EXAM_ORDER_NOT_FOUND') return '检查预约不存在'
  if (code === 'EXAM_ORDER_FORBIDDEN') return '无权查看该检查预约'
  if (code === 'EXAM_NOT_CANCELLABLE') return '当前检查预约状态不可取消'
  if (code === 'HIS_UNAVAILABLE') return '院内服务暂时不可用，请稍后重试'
  // 号源类（2026-11-22 补齐）：此前无专属文案，只能靠后端 message 含中文兜底；
  // 后端一旦改成英文/结构化 message，用户就会看到默认文案，语义丢失。
  if (code === 'SLOT_FULL') return '该号源已满，请重新选择号源'
  if (code === 'SLOT_IN_PAST') return '该时段已过，请选择未来号源'
  if (code === 'SLOT_NOT_FOUND') return '号源不存在，请刷新后重试'
  // 终态保护（409 APPOINTMENT_STATE_FINAL）：已取消/已完成不可再改
  if (code === 'APPOINTMENT_STATE_FINAL') return '该预约已完成或已取消，不能继续操作'
  // 支付开关关闭（503 PAYMENT_DISABLED）：只能到院缴费
  if (code === 'PAYMENT_DISABLED') return '线上缴费暂未开放，请到院窗口缴费'

  // ② 业务错误 / 无 code：仅当 message 是中文才展示
  if (readable(raw)) return raw

  // ③ 兜底：把原文留给控制台（不静默吞错），界面只给中文
  if (raw) console.warn('[err-text] 已拦下非中文错误：' + (code || '(no code)') + ' / ' + raw)
  return fb
}

module.exports = { errText, readable }
