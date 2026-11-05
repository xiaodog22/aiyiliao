/*
 * resource.manifest.test.js —— 资源清单并发单飞（零依赖，node:test）
 *
 * 背景：`app.js` 启动时调一次 `refreshManifest()`，登录页 `onShow` 又调一次。
 * 若无单飞，冷启动会并发打两条一模一样的清单请求（清单是 11 条 remote + 237 条 local 的
 * 聚合体，后端要查 DB 并算 sha256，不是零成本端点）。
 *
 * ⚠️ 这里测的是**最终行为**（网络请求条数），不是某一层的实现：
 *    单飞由两层共同保证——`resource.js` 的 `inflight` 与 `request.js` 的 GET 单飞。
 *    任一有效都能让请求数为 1。若要单独验证 resource 层，需要传 `noShare: true` 绕过
 *    request 层，但业务代码并未这么调，测了也不算真实路径。
 *    所以断言写成"并发刷新只产生 1 次网络请求"，不写"inflight 变量被复用"。
 *
 * 但**单飞位释放**必须单独测：inflight 若忘记置 null，就退化成"永久缓存"，
 * 清单改版后前端永远拿不到新 URL（这正是本模块设计里最危险的失败模式）。
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
  const API = require('../config/api.js')
  const session = require('../services/session.js')
  const resource = require('../services/resource.js')
  // 清单端点若要求会话，先给一对可用令牌（本模块不测鉴权）
  session.setTokens({ accessToken: 'at-test', refreshToken: 'rt-test', expiresIn: 7200 })
  return { stub, API, session, resource }
}

const manifestOf = (n) => ({
  statusCode: 200,
  data: {
    code: 'OK',
    data: {
      manifestVersion: `v${n}`,
      items: [
        { key: 'ai-doctor', level: 'remote', mime: 'image/png', size: 1234, sha256: 'a'.repeat(64), url: '' },
      ],
    },
  },
})

test('resource 层的 inflight 确实复用同一个 Promise（不是靠 request 层兜底）', () => {
  const { stub, resource } = loadFresh()
  stub.setDefault(manifestOf(1))

  // 精确断言层内行为：inflight 存在时 refreshManifest 是 `return inflight`，
  // 两次调用必须拿到**同一个 Promise 对象**。
  // 为什么需要这条：上面那条"只发 1 次请求"的断言，即使 resource 层的 inflight 被删掉，
  // request.js 的 GET 单飞也能把它兜住 → 测试仍绿。这条用引用相等绕开兜底，直接锁 resource 层。
  const p1 = resource.refreshManifest()
  const p2 = resource.refreshManifest()
  assert.strictEqual(p1, p2, 'resource.refreshManifest 必须复用 inflight，而不是每调一次新建 Promise')

  return Promise.all([p1, p2])
})

test('5 个并发 refreshManifest 只产生 1 次网络请求，且共享同一份结果', async () => {
  const { stub, resource } = loadFresh()
  stub.setDefault(manifestOf(1))

  const results = await Promise.all([
    resource.refreshManifest(),
    resource.refreshManifest(),
    resource.refreshManifest(),
    resource.refreshManifest(),
    resource.refreshManifest(),
  ])

  const calls = stub.httpRequests.filter((r) => r.url.includes('/api/v1/resources/manifest'))
  assert.strictEqual(calls.length, 1,
    `并发刷新必须只发 1 次清单请求（实际 ${calls.length}）——每次冷启动都会重复付这份 DB + sha256 成本`)
  // 5 个调用方都要拿到可用结果（单飞不能变成"只有一个调用方拿到 Promise"）
  for (const r of results) {
    assert.ok(r && Array.isArray(r.items), '每个并发调用方都必须拿到清单')
  }
  assert.strictEqual(results[0].manifestVersion, 'v1')
})

test('单飞位释放：一轮结束后再调用会重新发请求（不会退化成永久缓存）', async () => {
  const { stub, resource } = loadFresh()
  stub.setDefault(manifestOf(1))
  await resource.refreshManifest()
  assert.strictEqual(stub.httpRequests.length, 1)

  // 清单改版：若 inflight 未置 null，这里会拿到旧 Promise，永远读不到 v2
  stub.setDefault(manifestOf(2))
  const second = await resource.refreshManifest()

  assert.strictEqual(stub.httpRequests.length, 2,
    '第二轮必须重新发请求——inflight 忘记置 null 会让清单永久停留在旧版本')
  assert.strictEqual(second.manifestVersion, 'v2', '必须读到新版清单')
})

test('清单请求失败时返回本地缓存且不抛错，单飞位仍会释放', async () => {
  const { stub, resource } = loadFresh()
  // 先成功一次，把 v1 写进 storage
  stub.setDefault(manifestOf(1))
  await resource.refreshManifest()

  // 第二次失败：模块契约是"绝不阻断"，应回落缓存而不是 reject
  stub.setDefault({ statusCode: 500, data: { code: 'INTERNAL_ERROR' } })
  const fallback = await resource.refreshManifest()
  assert.strictEqual(fallback.manifestVersion, 'v1', '失败时必须回落上一份可用缓存')

  // 失败后单飞位也必须释放，否则后续永远不再重试
  stub.setDefault(manifestOf(3))
  const recovered = await resource.refreshManifest()
  assert.strictEqual(recovered.manifestVersion, 'v3', '失败后必须能恢复刷新')
})

test('无 manifest 时 resourceUrl 回落内置图标，不发请求', async () => {
  const { stub, resource } = loadFresh()
  const url = resource.resourceUrl('ai-doctor', '/assets/icons/ai-doctor.png')
  assert.strictEqual(url, '/assets/icons/ai-doctor.png')
  assert.strictEqual(stub.httpRequests.length, 0, '纯读缓存路径不得发网络请求')
})
