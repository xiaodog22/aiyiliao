/**
 * consultation-safety.js —— 在线问诊「服务端安全提示」的纯函数（2026-11-22 L1）
 *
 * 设计口径：**前端只认服务端 safety，不在本地复核红旗**。
 *   急症判定必须由服务端确定性规则（TriageRuleEngine → ConsultationService.safetyFor）
 *   给出；页面若再跑一套本地词表，就会重新出现「前端 15 类、服务端 7 类」的分裂。
 *   本模块只负责把服务端 safety 转成页面可渲染的文案/科室，不做任何症状匹配。
 *
 * 为什么单独拆文件：页面 consultation.js 依赖 wx/Page，无法在 Node 里直接跑；
 * 把判定收敛到无副作用的纯函数后可做契约测试（tools/test-consultation-safety.js）。
 */

/** 服务端 safety → 急救横幅文案；未命中返回空串（调用方据此决定是否渲染）。 */
function emergencyText(safety) {
  if (!safety || safety.emergency !== true) return ''
  const msg = typeof safety.message === 'string' ? safety.message.trim() : ''
  return msg || '请立即拨打 120 或前往最近医院急诊科。'
}

/** 服务端 safety → 主推荐科室；未命中返回空串。 */
function emergencyDept(safety) {
  return safety && safety.emergency === true ? '急诊科' : ''
}

module.exports = { emergencyText, emergencyDept }
