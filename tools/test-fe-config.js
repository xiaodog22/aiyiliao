/**
 * tools/test-fe-config.js —— config/env.js + config/api.js 不变量测试（前端测试文档 TC-FE-CF-*）
 *
 * 覆盖：唯一网关语义、契约请求头定值、三档环境参数、路径表形状、
 *       「服务引用的路径必须在表中登记」一致性（防拼错常量静默 undefined）。
 *
 * 运行：node tools/test-fe-config.js
 */
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
const ENV = require(path.join(ROOT, 'config', 'env.js'))
const API = require(path.join(ROOT, 'config', 'api.js'))

// ==================== env.js：环境门禁与契约定值 ====================

test('CF-01 核心：当前档位网关非空且 serviceReady（档位无关）', () => {
  // 档位随联调场景切换（local=模拟器 / development=花生壳真机 / production=发布），
  // 测试只约束"非生产档必须有可用网关"，不把档位写死（写死会在切档时误报）。
  assert.ok(['local', 'development', 'production'].includes(ENV.name), '未知档位: ' + ENV.name)
  if (ENV.isProduction) {
    assert.ok(/^https:\/\//.test(ENV.gateway) && !/(vicp\.fun|ngrok|natapp|localhost|127\.0\.0\.1)/i.test(ENV.gateway),
      '生产档必须是正式 HTTPS 且禁临时域名')
    assert.strictEqual(ENV.MOCK_READ_FALLBACK, false, '生产档禁止 mock 降级')
  } else {
    assert.ok(ENV.gateway && /^https?:\/\//.test(ENV.gateway), 'gateway 必须是完整 URL: ' + ENV.gateway)
    assert.strictEqual(ENV.serviceReady, true)
    assert.strictEqual(ENV.isProduction, false)
  }
})

test('CF-01b 档位语义：development 档必须走隧道域名（真机可达），local 档走本机', () => {
  if (ENV.name === 'development') {
    assert.ok(/^https:\/\//.test(ENV.gateway), 'development 档须 HTTPS 隧道域名（真机不能连 127.0.0.1）')
    assert.ok(!/127\.0\.0\.1|localhost/.test(ENV.gateway), 'development 档不得指向本机回环')
  }
  if (ENV.name === 'local') {
    assert.ok(/^http:\/\//.test(ENV.gateway), 'local 档为本机模拟器直连（http 回环）')
  }
})

test('CF-02 核心：历史别名 fastapi/springboot 与 gateway 同址（唯一入口语义）', () => {
  assert.strictEqual(ENV.fastapi, ENV.gateway)
  assert.strictEqual(ENV.springboot, ENV.gateway)
})

test('CF-03 核心：契约请求头定值 —— X-Platform 逐字等于 const，版本号 ≤20', () => {
  assert.strictEqual(ENV.platform, 'wechat-miniprogram')
  assert.ok(ENV.clientVersion.length >= 1 && ENV.clientVersion.length <= 20)
  assert.strictEqual(ENV.consentVersion, ENV.consentVersion.trim())
  assert.ok(ENV.consentVersion.length >= 1 && ENV.consentVersion.length <= 20)
})

test('CF-04 核心：超时预算分级 ai < tts < carePlan', () => {
  assert.ok(ENV.aiTimeout < ENV.ttsTimeout, 'aiTimeout 应小于 ttsTimeout')
  assert.ok(ENV.ttsTimeout < ENV.carePlanTimeout, 'ttsTimeout 应小于 carePlanTimeout')
})

test('CF-05 边界：local/development 档允许 mock 只读降级；legacy 手输登录仅非生产', () => {
  assert.strictEqual(ENV.MOCK_READ_FALLBACK, true)
  assert.strictEqual(ENV.legacyManualLoginEnabled, true) // 当前非生产档
})

// ==================== api.js：路径表形状与禁址 ====================

const entries = Object.entries(API).filter(([, v]) => v && typeof v === 'object' && v.path)

test('CF-06 核心：路径表非空且每条都是 { base, path } 形状', () => {
  assert.ok(entries.length >= 40, '路径表应覆盖全部页面服务（当前 ' + entries.length + ' 条）')
  const LEGAL_BASE = new Set(['gateway', 'python', 'java'])
  // 唯一合法非 /api/ 路径：健康探针 /health（编排器轮询用，登记在案）
  const NON_API_OK = new Set(['/health'])
  for (const [name, spec] of entries) {
    assert.ok(LEGAL_BASE.has(spec.base), name + ' base 非法: ' + spec.base)
    assert.ok(spec.path.startsWith('/'), name + ' path 必须以 / 开头: ' + spec.path)
    if (!NON_API_OK.has(spec.path)) {
      assert.ok(spec.path.startsWith('/api/'), name + ' path 必须以 /api/ 开头: ' + spec.path)
    }
  }
})

test('CF-07 红线：路径表禁止出现本机地址与后端直连端口', () => {
  const FORBIDDEN = ['127.0.0.1', 'localhost', ':8001', ':8088', '8001', '8088']
  for (const [name, spec] of entries) {
    for (const bad of FORBIDDEN) {
      assert.ok(!spec.path.includes(bad), name + ' 含禁址 ' + bad + ': ' + spec.path)
    }
  }
})

test('CF-08 边界：路径占位符统一 {id} 花括号风格（不混用 :id）', () => {
  for (const [name, spec] of entries) {
    assert.ok(!/:[a-zA-Z]/.test(spec.path), name + ' 使用了 :param 风格: ' + spec.path)
  }
})

// ==================== 一致性：services/*.js 引用的 API.X 必须已登记 ====================

test('CF-09 一致性：服务层引用的每个 API 常量都在路径表中（防拼错静默 undefined）', () => {
  const svcDir = path.join(ROOT, 'services')
  const files = fs.readdirSync(svcDir).filter((f) => f.endsWith('.js'))
  const missing = []
  for (const f of files) {
    // 先剥离注释再扫描：文档注释里的示例写法（如 API.XXX）不是真实引用
    const raw = fs.readFileSync(path.join(svcDir, f), 'utf8')
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const re = /\bAPI\.([A-Z][A-Z0-9_]*)/g
    let m
    while ((m = re.exec(src))) {
      if (!Object.prototype.hasOwnProperty.call(API, m[1])) {
        missing.push(f + ' → API.' + m[1])
      }
    }
  }
  assert.deepStrictEqual(missing, [], '以下引用未登记: ' + missing.join(', '))
})

test('CF-10 核心：关键契约路径已登记（登录/刷新/me/科室/号源/挂号/档案/问诊/语音）', () => {
  const must = ['AUTH_WECHAT_LOGIN', 'AUTH_REFRESH', 'AUTH_LOGOUT', 'ME',
    'DEPARTMENT_LIST', 'DEPARTMENT_DOCTORS', 'DOCTOR_SLOTS',
    'APPOINT_SUBMIT', 'APPOINT_LIST', 'HEALTH_RECORDS',
    'CONSULTATION_LIST', 'VOICE_ASR', 'VOICE_TTS']
  for (const key of must) {
    assert.ok(API[key], '缺少关键路径 ' + key)
    assert.ok(API[key].path.startsWith('/api/v1/'), key + ' 应为契约 /api/v1 路径')
  }
})
