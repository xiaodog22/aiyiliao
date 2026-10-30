/**
 * gateway.js —— 统一网关自身状态（/api/gw/**）
 *
 * 为什么单独成文件：网关健康检查不属于任何业务域（既不是问诊、也不是挂号/语音），
 * 但设置页的「后端服务状态」面板需要它。原先它和手势编排耦合在 gesture.js 里，
 * 手势功能下线后按职责拆出来，这里只保留"网关自身"这一小类请求。
 *
 * 返回结构（网关实测，2026-10-17 对齐）：
 *   { status: 'ok'|'degraded', upstreams: [{ name: 'java'|'python', reachable, latencyMs }] }
 *   （全部上游不可达时网关直接回 503 错误信封 → 本调用 reject，由调用方展示"未连接"）
 */
const req = require('./request.js')
const API = req.API
const ENV = req.ENV

/** 网关 + 各上游健康状态（失败 reject，由调用方决定展示成"未连接"） */
function health() {
  return req.get(API.GW_HEALTH, null, { timeout: ENV.aiTimeout })
}

/** 网关路由总表（排查用） */
function routes() {
  return req.get(API.GW_ROUTES, null, { timeout: ENV.aiTimeout })
}

module.exports = { health, routes }
