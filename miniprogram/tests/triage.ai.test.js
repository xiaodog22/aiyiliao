/*
 * triage.ai.test.js —— 智能导诊接 AI（任务链）回归（零依赖，node:test）
 *
 * 背景（2026-11-04）：导诊页号称"本地 + 后端 AI 融合"，但后端调用打的是 Phase 1 的两条
 * FastAPI 老路由（/api/v1/case/recommend-department、/api/v1/consultation/emergency/check）。
 * 现网网关把 /api/** 全量代理到 business，ai-service 也没有这两条路由 —— 每轮稳定 404，
 * 页面看起来"没接 AI"。改成契约任务链后，这几条断言防止再退回老路：
 *   ① 首轮：建会话 → POST /consultations/{id}/triage → 轮询 /ai/tasks/{taskId}
 *   ② 后续轮：追加消息到**同一会话**（不重复建会话，否则 AI 只看得到最后一句）
 *   ③ AI 全挂：analyze 必须回落本地并标记 aiFallback（不抛错、不卡住）
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { createWxStub, purgeModuleCache } = require('./support/wx-stub.js')

const MINIPROGRAM_ROOT = path.resolve(__dirname, '..')

function loadFresh() {
  purgeModuleCache(MINIPROGRAM_ROOT)
  const stub = createWxStub()
  stub.install()
  const session = require('../services/session.js')
  const triage = require('../services/triage.js')
  session.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
  return { stub, triage }
}

const ok = (data) => ({ statusCode: 200, data: { code: 'OK', data } })
const boom = () => ({ statusCode: 503, data: { code: 'UPSTREAM_UNAVAILABLE', message: '上游不可用' } })

test('aiTriage 首轮：建会话 → 建分诊任务 → 轮询到 SUCCEEDED', async () => {
  const { stub, triage } = loadFresh()
  stub.queue(
    ok({ consultation: { id: 'cn-1' }, task: { taskId: 'chat-1' } }),
    ok({ taskId: 'triage-1' }),
    ok({ taskId: 'triage-1', status: 'SUCCEEDED', result: { recommendedDepartments: [{ departmentName: '耳鼻喉科', reason: '咽痛伴吞咽痛', confidence: 0.8 }] } })
  )

  const out = await triage.aiTriage('嗓子疼三天了，吞咽时更痛', {})

  assert.strictEqual(out.consultationId, 'cn-1')
  assert.strictEqual(out.task.status, 'SUCCEEDED')

  const urls = stub.httpRequests.map((r) => r.method + ' ' + r.url)
  assert.ok(urls.some((u) => u === 'POST ' + require('../config/env.js').gateway + '/api/v1/consultations'),
    `首轮必须建会话，实际：${urls.join(' , ')}`)
  assert.ok(urls.some((u) => u.indexOf('/consultations/cn-1/triage') >= 0),
    '必须调契约分诊端点（不是老的 /case/recommend-department）')
  assert.ok(!urls.some((u) => u.indexOf('case/recommend-department') >= 0),
    '不得再出现 Phase 1 的 /case/recommend-department（现网 404）')
})

test('aiTriage 后续轮：追加到同一会话，不再新建', async () => {
  const { stub, triage } = loadFresh()
  stub.queue(
    ok({ consultation: { id: 'cn-1' }, task: { taskId: 'chat-2' } }),
    ok({ taskId: 'triage-2' }),
    ok({ taskId: 'triage-2', status: 'SUCCEEDED', result: { recommendedDepartments: [{ departmentName: '呼吸内科', confidence: 0.7 }] } })
  )

  const out = await triage.aiTriage('还开始咳嗽了', { consultationId: 'cn-1' })

  assert.strictEqual(out.consultationId, 'cn-1')
  const created = stub.httpRequests.filter((r) => r.method === 'POST' && /\/api\/v1\/consultations$/.test(r.url))
  assert.strictEqual(created.length, 0, '已有会话时不应再 POST /consultations')
  assert.ok(stub.httpRequests.some((r) => r.method === 'POST' && r.url.indexOf('/consultations/cn-1/messages') >= 0),
    '后续轮必须把新症状追加到同一会话')
})

test('analyze 在 AI 全不可用时回落本地规则，并标记 aiFallback', async () => {
  const { stub, triage } = loadFresh()
  stub.setDefault(boom())

  const result = await triage.analyze('嗓子疼三天了，吞咽时更痛', { useRemote: true, history: [] })

  assert.ok(result, '必须返回结果，不能抛错')
  assert.strictEqual(result.aiFallback, true, 'AI 失败必须如实标记降级（页面据此显示"本地规则结果"）')
  assert.ok(result.primary && result.primary.dept, '本地规则仍要给出科室，导诊不能中断')
})
