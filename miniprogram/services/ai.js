/**
 * ai.js —— AI 任务（异步生成）服务
 *
 * 为什么需要它：AI 任务不是同步接口。业务侧只负责**建任务**并返回 taskId，
 * 真正的模型生成在 ai-service 里跑（单并发 CPU 模型，秒级到几十秒），
 * 客户端必须轮询 `GET /api/v1/ai/tasks/{taskId}` 直到终态。
 *
 * 两类任务（2026-10-24 AI 问诊接入）：
 *   CHAT   —— AI 问诊对话（result.text）。业务侧 inputInline 已是**多轮上下文**。
 *   TRIAGE —— AI 分诊（result.recommendedDepartments[{departmentName,reason,confidence}]）。
 *
 * ⚠️ 不伪造：任务 FAILED 时把服务端 error.code/message 透传出去，
 *    调用方必须显示可见失败提示，不得用本地结论冒充 AI 输出。
 */
const req = require('./request.js')
const { post, get, API, withPath } = req

/** 任务终态（与 business-service AiTaskController.TERMINAL 同口径） */
const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']

/**
 * 查询任务（GET /api/v1/ai/tasks/{taskId}）
 * @returns {Promise<{taskId,taskType,status,progressPhase,result,error,...}>}
 *          result 仅 SUCCEEDED 时非空
 */
function getTask(taskId) {
  return get(withPath(API.AI_TASK, { taskId: String(taskId || '') }))
}

/**
 * 触发 AI 分诊（POST /api/v1/consultations/{id}/triage）
 * 服务端把会话内患者描述聚合成症状文本，建 TRIAGE 任务后立刻返回（不等模型）。
 * @param {string} consultationId
 * @param {{requestedProfile?: string}} [opts]
 */
function requestConsultationTriage(consultationId, opts) {
  const o = opts || {}
  const body = {}
  if (o.requestedProfile) body.requestedProfile = String(o.requestedProfile)
  return post(withPath(API.CONSULTATION_TRIAGE, { consultationId: String(consultationId || '') }), body)
}

/**
 * 轮询任务直到终态。
 *
 * @param {string} taskId
 * @param {{interval?:number, timeout?:number}} [opts] interval 默认 1200ms，timeout 默认 120s
 * @returns {Promise<Object>} 终态任务对象（status 可能是 SUCCEEDED / FAILED / …，由调用方判定）
 * @throws {{code:string,message:string}} 轮询期间网络失败或超时（code=TASK_POLL_TIMEOUT）
 */
function waitTask(taskId, opts) {
  const o = opts || {}
  const interval = Math.max(Number(o.interval) || 1200, 300)
  const timeout = Math.max(Number(o.timeout) || 120000, 5000)
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const tick = () => {
      getTask(taskId)
        .then((t) => {
          const status = String((t && t.status) || '')
          if (TERMINAL.indexOf(status) >= 0) {
            resolve(t)
            return
          }
          if (Date.now() - startedAt > timeout) {
            reject({ code: 'TASK_POLL_TIMEOUT', message: 'AI 生成超时，请稍后重试' })
            return
          }
          setTimeout(tick, interval)
        })
        .catch(reject)
    }
    // 首个 tick 也给一个间隔：建任务后立刻查必然是 QUEUED，白费一次往返
    setTimeout(tick, interval)
  })
}

/**
 * TRIAGE 结果 → 归一化科室建议
 * @param {Object} task 终态任务
 * @returns {{departments:Array<{name:string,reason:string,confidence:number}>}|null}
 *          null = 结果结构不合法（调用方按"暂无结论"处理，不猜）
 */
function parseTriage(task) {
  const r = (task && task.result) || null
  if (!r || !Array.isArray(r.recommendedDepartments)) return null
  const departments = r.recommendedDepartments
    .map((d) => ({
      name: String((d && d.departmentName) || '').trim(),
      reason: String((d && d.reason) || '').trim(),
      confidence: Number((d && d.confidence))
    }))
    .filter((d) => d.name)
    .map((d) => ({ name: d.name, reason: d.reason, confidence: isNaN(d.confidence) ? 0 : d.confidence }))
  if (!departments.length) return null
  return { departments }
}

module.exports = { getTask, requestConsultationTriage, waitTask, parseTriage, TERMINAL }
