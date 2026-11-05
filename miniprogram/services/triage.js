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
const engine = require('../utils/triage-engine.js')
const ai = require('./ai.js')
const userService = require('./user.js')

const HISTORY_KEY = 'wb_triage_history'
const QUALITY_KEY = 'wb_triage_quality'
const NOTICE_KEY = 'wb_triage_notice_v1'
const MAX_HISTORY = 20

// AI 分诊任务：模型在 CPU 上跑，首次要等权重加载，给足 3 分钟；轮询 1.5s 一次（与问诊页同口径）
const AI_TRIAGE_TIMEOUT = 180000
const AI_TRIAGE_INTERVAL = 1500

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

// ==================== 后端 AI（任务链，可失败，失败即降级）====================
/**
 * 院内 AI 分诊任务链（2026-11-04 接入）。
 *
 * 为什么换实现：此前 `recommendDepartment` 打 `POST /api/v1/case/recommend-department`、
 * `checkEmergency` 打 `/api/v1/consultation/emergency/check` —— 这两个是 Phase 1 FastAPI
 * 的老路由。现网网关把 /api 下的全部请求代理到 business（java），ai-service 也没有这两条路由，
 * 于是每轮稳定 404：页面看起来"没接 AI"，实际是**一直在请求一个不存在的接口**，
 * 还白等两次超时。正解走契约的任务链：
 *   ① 建会话（首轮）/ 追加消息（后续）—— 会话承载症状文本，服务端据此聚合；
 *   ② POST /api/v1/consultations/{id}/triage 建 TRIAGE 任务（立刻返回，不同步等模型）；
 *   ③ 轮询 GET /api/v1/ai/tasks/{taskId} 到终态，取 result.recommendedDepartments[]。
 *
 * @param {string} text 本轮用户输入
 * @param {{consultationId?:string}} [state] 页面持有的会话 id（一轮会话只建一次）
 * @returns {Promise<{consultationId:string, task:Object}>}
 */
function aiTriage(text, state) {
  const s = state || {}
  const cid = String(s.consultationId || '')
  const content = String(text || '')
  const p = cid
    ? userService.sendConsultationMessage(cid, { content: content })
    : userService.createConsultation({ initialMessage: content })
  return p.then((res) => {
    const created = res && res.consultation
    const id = (created && created.id) || cid
    if (!id) throw { code: 'NO_CONSULTATION', message: '未能创建分诊会话' }
    // ⚠️ 必须走 large 档（qwen2.5:7b）：0.5b 实测会把「嗓子疼」判成消化内科（2026-10-24 记录），
    //    而导诊结论会直接决定患者挂哪个科的号 —— 准确率优先于速度。
    //    CPU 上约 30~60s，业务侧 TRIAGE 预算 180s，前端 thinking 态承接，不会超时。
    return ai.requestConsultationTriage(id, { requestedProfile: 'large-upgrade' }).then((task) => {
      if (!task || !task.taskId) throw { code: 'NO_TASK', message: '服务端没有返回分诊任务' }
      return ai.waitTask(task.taskId, { interval: AI_TRIAGE_INTERVAL, timeout: AI_TRIAGE_TIMEOUT })
        .then((t) => ({ consultationId: id, task: t }))
    })
  })
}

// ==================== 主流程 ====================
/**
 * 一次分诊分析（本地优先 + 后端 AI 任务链增强）
 * @param {string} text 本次输入
 * @param {Object} ctx { history:[], asked:[], rounds:number, useRemote:boolean, consultationId?:string }
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
  // ④ 走院内 AI 任务链（会话尽量复用：一轮导诊只建一个会话，后续轮次追加消息）
  return aiTriage(text, { consultationId: o.consultationId })
    .then(({ consultationId, task }) => {
      const parsed = task && task.status === 'SUCCEEDED' ? ai.parseTriage(task) : null
      const top = parsed && parsed.departments[0]
      const result = engine.mergeRemote(local, {
        clinic: top ? top.name : '',
        reason: top ? top.reason : ''
      })
      // 会话 id 回传给页面：下一轮继续往同一会话追加，AI 才能看到完整病史
      result.consultationId = consultationId
      result.aiUsed = !!top
      result.aiFallback = !top
      result.aiDepartments = parsed ? parsed.departments : []
      result.aiTaskId = (task && task.taskId) || ''
      if (task && task.status !== 'SUCCEEDED') {
        const e = (task && task.error) || {}
        result.aiError = { code: e.code || (task && task.status) || 'AI_TASK_FAILED', message: e.message || '' }
      }
      _countQuality(result, top ? { clinic: top.name } : null)
      return result
    })
    .catch((err) => {
      // 兜底：任何意外都用本地结果，绝不让导诊中断（但**必须**标记降级，页面要如实告知）
      console.warn('[triage] AI 分诊不可用，回落本地规则：' + ((err && (err.code || err.message)) || ''))
      local.aiFallback = true
      local.aiError = { code: (err && err.code) || 'AI_UNAVAILABLE', message: (err && err.message) || '' }
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
  aiTriage,    // 单步任务链（页面/测试需要直接驱动时用）
  answerNav,   // 路线询问应答词判定（问诊页/导诊页共用一份）
  saveSession, listSessions, clearSessions, clearAll, quality,
  hasSeenNotice, markNoticeSeen,
  PRIVACY_NOTICE, DISCLAIMER
}
