/**
 * triage.js —— AI 导诊服务（本地引擎 + 后端 AI 融合）
 *
 * 设计原则（为什么这样分层）：
 *  1. **本地引擎先算**：分诊不能依赖网络。断网/后端抖动时也要给出分级与科室建议；
 *     本地 0ms 出结果，还能立刻把"我理解到了什么"回执给用户（感知快、可纠错）。
 *  2. **安全优先，抢先响应**：本地命中红旗时**不等待后端**直接返回（省掉 1~3 秒的关键时间）。
 *  3. **证据融合**：后端 AI（recommend-department / emergency-check）与本地规则取长补短 ——
 *     AI 强在语义泛化，规则强在可解释与安全底线；急诊信号取并集（任一报警即报警）。
 *  4. **失败不影响可用**：任一后端接口失败都降级为纯本地结论，绝不让用户卡在 loading。
 *
 * 隐私（合规要求落地）：
 *  - 只把**症状文本**发给后端做分诊，不发送姓名/手机号/身份证等身份信息；
 *  - 导诊记录仅存本机 storage（含一键清除），不上传到任何第三方；
 *  - 质量统计只存**计数**（总量/急诊数/AI 是否与规则一致），不存原始症状文本。
 */
const req = require('./request.js')
const API = req.API
const engine = require('../utils/triage-engine.js')

const HISTORY_KEY = 'wb_triage_history'
const QUALITY_KEY = 'wb_triage_quality'
const NOTICE_KEY = 'wb_triage_notice_v1'
const MAX_HISTORY = 20
const MAX_TEXT_FOR_API = 200

const EMERGENCY_TIMEOUT = 15000
const RECOMMEND_TIMEOUT = 45000

// 隐私告知（首次进入导诊页展示，用户确认后才继续）
const PRIVACY_NOTICE = '为提高分诊准确性，您描述的症状文字会发送到院内导诊服务进行分析；'
  + '我们不会上传姓名、手机号等身份信息，导诊记录仅保存在本机、可随时清除。'

// 统一免责口径（页面与结果页共用一份，避免各写各的）
const DISCLAIMER = '本结果为 AI 分诊建议，仅供参考，不能替代医生面诊与检查；'
  + '急危重症请立即拨打 120。如症状加重，请及时就医。'

// ==================== 路线询问的应答词 ====================
// 导诊结果卡之后会问「要不要告诉您怎么走」：用户懒得点按钮、直接打字「要 / 是 / 好」也要认出来。
// ⚠️ 判定顺序：先否定再肯定 —— "不要" 里也含 "要"，顺序反了会把拒绝误判成去导航。
const NAV_NO = ['不用', '不要', '不了', '不必', '别', '否', '算了', '暂时不', '先不', '不去了']
const NAV_YES = ['要', '是', '好', '对', '行', '可以', '需要', '带路', '带我去', '去', '嗯', '麻烦']

/**
 * 判断这句话是不是在回答「要不要告诉您怎么走」
 * @param {string} text 用户输入
 * @returns {'yes'|'no'|''} 空串 = 不是应答（应按新的症状描述处理）
 */
function answerNav(text) {
  const t = String(text || '').replace(/[，。！？、,.!?~\s]/g, '')
  if (!t || t.length > 8) return ''
  for (let i = 0; i < NAV_NO.length; i++) if (t.indexOf(NAV_NO[i]) >= 0) return 'no'
  for (let i = 0; i < NAV_YES.length; i++) if (t.indexOf(NAV_YES[i]) >= 0) return 'yes'
  return ''
}

function hasSeenNotice() {
  try { return !!wx.getStorageSync(NOTICE_KEY) } catch (e) { return true }
}

function markNoticeSeen() {
  try { wx.setStorageSync(NOTICE_KEY, 1) } catch (e) {}
}

// ==================== 后端调用（可失败，失败即降级）====================
/** 急诊判定：POST /api/v1/consultation/emergency/check?text= */
function checkEmergency(text) {
  const t = String(text || '').slice(0, MAX_TEXT_FOR_API)
  const spec = {
    base: 'python',
    path: API.TRIAGE_EMERGENCY.path + '?text=' + encodeURIComponent(t)
  }
  return req.post(spec, null, { timeout: EMERGENCY_TIMEOUT })
    .then((d) => {
      // 实测契约（2026-09-12 经网关验证）：
      // { risk_level, risk_score, matched_keywords, is_emergency, emergency_message, suggestion, safe }
      const x = d || {}
      const flag = !!(x.is_emergency || x.emergency || x.isEmergency)
        || x.risk_level === 'high' || x.level === 'high' || x.risk === 'high'
      return {
        is_emergency: flag,
        level: x.risk_level || x.level || x.risk || '',
        text: x.emergency_message || x.suggestion || x.text || x.advice || ''
      }
    })
    .catch((err) => {
      console.warn('[triage] 急诊判定不可用，使用本地红旗规则：' + (err && err.code))
      return null
    })
}

/** 科室推荐：POST /api/v1/case/recommend-department { text } */
function recommendDepartment(text) {
  return req.post(API.TRIAGE_RECOMMEND, { text: String(text || '').slice(0, 500) }, { timeout: RECOMMEND_TIMEOUT })
    .then((d) => {
      const x = d || {}
      const clinic = x.clinic || x.department || x.dept || x.deptName || ''
      return clinic ? { clinic: clinic, reason: x.reason || x.advice || '' } : null
    })
    .catch((err) => {
      console.warn('[triage] 科室推荐不可用，使用本地匹配：' + (err && err.code))
      return null
    })
}

// ==================== 主流程 ====================
/**
 * 一次分诊分析（本地优先 + 后端增强）
 * @param {string} text 本次输入
 * @param {Object} ctx { history:[], asked:[], rounds:number, useRemote:boolean }
 * @returns {Promise<Object>} 结构化结果（结构见 triage-engine.analyze）
 */
function analyze(text, ctx) {
  const o = ctx || {}
  const local = engine.analyze(text, o)

  // ① 红旗命中：不等后端，立刻返回（安全优先）
  if (local.emergency) {
    _countQuality(local, null)
    return Promise.resolve(local)
  }
  // ② 信息不足：先补问，不急着给科室结论（准确性优先）
  if (local.question && !o.forceResult) {
    return Promise.resolve(local)
  }
  // ③ 隐私开关：用户在隐私告知里选了「仅本地分析」→ **一个字都不发后端**，直接用本地规则结论。
  //    此前 useRemote 只传不判，等于隐私开关失效（2026-09-13 修复）。
  if (o.useRemote === false) {
    local.aiFallback = true
    _countQuality(local, null)
    return Promise.resolve(local)
  }
  // ④ 需要 AI 增强：并发两个接口，各自失败各自降级
  const merged = o.history ? o.history.concat([text]).join('。') : text
  return Promise.all([checkEmergency(merged), recommendDepartment(merged)])
    .then(([em, rec]) => {
      const result = engine.mergeRemote(local, {
        clinic: rec ? rec.clinic : '',
        reason: rec ? rec.reason : '',
        emergency: em || undefined
      })
      result.aiUsed = !!(rec || em)
      result.aiFallback = !rec
      _countQuality(result, rec)
      return result
    })
    .catch(() => {
      // 兜底：任何意外都用本地结果，绝不让导诊中断
      local.aiFallback = true
      _countQuality(local, null)
      return local
    })
}

/** 症状解析（不联网，用于"已理解"回执与本地预览） */
function parse(text, ctx) { return engine.analyze(text, ctx) }

// ==================== 本地记录 / 质量统计 ====================
/** 保存一次导诊记录（本机，最多 20 条；含一键清除） */
function saveSession(result, symptomText) {
  try {
    const list = listSessions()
    list.unshift({
      t: Date.now(),
      level: result.level,
      levelText: result.levelText,
      dept: result.primary ? result.primary.dept : '',
      navigable: !!result.navigable,
      slotsText: result.slotsText || '',
      symptom: String(symptomText || '').slice(0, 200)   // 只留本次症状，便于回看
    })
    wx.setStorageSync(HISTORY_KEY, list.slice(0, MAX_HISTORY))
  } catch (e) {}
}

function listSessions() {
  try { return wx.getStorageSync(HISTORY_KEY) || [] } catch (e) { return [] }
}

function clearSessions() {
  try { wx.removeStorageSync(HISTORY_KEY) } catch (e) {}
}

/** 质量统计：只累加计数，不存症状文本（隐私 + 可用于观察准确性） */
function _countQuality(result, rec) {
  try {
    const q = wx.getStorageSync(QUALITY_KEY) || { total: 0, emergency: 0, aiUsed: 0, aiMatched: 0, localOnly: 0, byDept: {} }
    q.total += 1
    if (result.emergency) q.emergency += 1
    if (rec) {
      q.aiUsed += 1
      if (result.aiMatched) q.aiMatched += 1
    } else {
      q.localOnly += 1
    }
    const dept = result.primary ? result.primary.dept : ''
    if (dept) q.byDept[dept] = (q.byDept[dept] || 0) + 1
    wx.setStorageSync(QUALITY_KEY, q)
  } catch (e) {}
}

function quality() {
  try { return wx.getStorageSync(QUALITY_KEY) || null } catch (e) { return null }
}

function clearAll() {
  clearSessions()
  try { wx.removeStorageSync(QUALITY_KEY) } catch (e) {}
}

module.exports = {
  analyze, parse,
  toReport: engine.toReport,
  checkEmergency, recommendDepartment,
  answerNav,   // 路线询问应答词判定（问诊页/导诊页共用一份）
  saveSession, listSessions, clearSessions, clearAll, quality,
  hasSeenNotice, markNoticeSeen,
  PRIVACY_NOTICE, DISCLAIMER
}
