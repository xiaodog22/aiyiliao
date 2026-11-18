/*
 * env.js —— 小程序唯一网关与环境门禁
 *
 * 三档运行环境（只改 BUILD_ENV 一处）：
 *   'local'        PC 模拟器直连本机统一网关（不经内网穿透；见 DEV_DIRECT）
 *   'development'  隧道联调（真机 / 模拟器，经花生壳隧道域名 → 内网网关端口；具体域名见下方 gateway，
 *                  内网 IP 不入库 —— 审计 H8：内网拓扑不应随包分发）；
 *                  2026-10-20 真机排查：local 档在真机上会连 127.0.0.1（手机自己）必失败，
 *                  真机验证必须用本档；旧注释的 ChmlFrp 已废弃）
 *   'production'   发布包（流水线替换为 production；禁止临时隧道 / localhost）
 *
 * 后端服务均通过同一网关暴露（统一入口 :8080，穿透映射到同一端口）。local 档可显式
 * 启用只读 mock 供界面预览；development / production 禁止把默认数据渲染成真实界面。
 */
// ⚠️ 2026-11-18（审计 C1/H8/H9）：档位 / 隧道域名 / 联调密钥**一律不在仓库中出现**。
//    它们来自本地未入库的 ./env.local.js（已进 .gitignore）：
//      module.exports = {
//        buildEnv: 'development',                 // 不写 = production（fail-closed）
//        localGateway: 'http://127.0.0.1:8080',   // 可省
//        developmentGateway: 'https://<你的隧道域名>',
//        productionGateway: 'https://<已备案正式域名>',
//        devLoginKey: '<与 APP_AUTH_DEV_LOGIN_KEY 同值>'
//      }
//    没有该文件也能构建：BUILD_ENV 落到 production，dev 登录与隧道全部关闭 —— 这正是发布包要的状态。
let LOCAL_OVERRIDES = {}
try {
  // 存在即读取；不存在则 catch（发布包不需要这个文件）
  LOCAL_OVERRIDES = require('./env.local.js') || {}
} catch (e) {
  LOCAL_OVERRIDES = {}
}

const BUILD_ENV = String(LOCAL_OVERRIDES.buildEnv || 'production').trim()

// ⚠️ 档位白名单（fail-closed）：拼错（如 'prod' / 'Production'）不再静默落到 development，
//    而是构建期直接抛错。历史上 isProduction 用的是 `=== 'production'`，任何拼写偏差都会
//    让「生产档门禁」全部失效 —— 这是 P0-01 的一半根因。
const ENV_KEYS = ['local', 'development', 'production']
if (ENV_KEYS.indexOf(BUILD_ENV) < 0) {
  throw new Error('BUILD_ENV 非法：' + BUILD_ENV + '（只允许 ' + ENV_KEYS.join(' / ') + '）')
}

// ⚠️ 全仓唯一允许出现「本机直连地址」的位置：本行含 DEV_DIRECT 标记，
//    由 tools/check-project.js 按「仅本文件（config/env.js）+ 含标记」放行。
//    本机模拟器 = 127.0.0.1；真机局域网调试 = 改为 PC 的局域网 IP（保持本标记）。
const DEV_DIRECT = 'http://127.0.0.1:8080'

const ENVIRONMENTS = {
  // PC 模拟器直连本机统一网关（不经隧道；后端不可用时降级只读 mock）
  local: {
    gateway: String(LOCAL_OVERRIDES.localGateway || DEV_DIRECT).trim(),
    aiTimeout: 90000,
    ttsTimeout: 120000,
    carePlanTimeout: 180000,
    mockReadFallback: true
  },
  development: {
    // 隧道域名只从本地未入库的 env.local.js 注入（缺失即空 → 下方 fail-fast 拦下）
    gateway: String(LOCAL_OVERRIDES.developmentGateway || '').trim(),
    aiTimeout: 90000,
    ttsTimeout: 120000,
    carePlanTimeout: 180000,
    // 2026-11-17：development 是联调档，必须暴露真实后端状态。
    // 原来这里为 true：后端一断，withFallback 会把 app.MOCK 的默认数据渲染成正常界面，
    // 用户仍可点预约/问诊等按钮 —— 这就是"断网后仍展示默认界面并可操作"的根因。
    // 演示预览只在 local 档保留；development / production 一律走真实错误态 + 离线条。
    mockReadFallback: false
  },
  production: {
    // 必须替换为已备案、已配置微信合法域名的正式 HTTPS 地址（同样由 env.local.js 注入）。
    gateway: String(LOCAL_OVERRIDES.productionGateway || '').trim(),
    // 2026-11-10：与网关 220s 链路预算对齐（ai 150s < business 165s < 前端 180s < 网关 220s，
    // 见 backend/deploy/env.local 链路预算注释与 CLOUD.md §3）。原 45/60/90s 会让 careplan
    // 前端先超时，而后端仍在生成；三档须保持 ai < tts < carePlan，收紧必须同步后端预算。
    aiTimeout: 90000,
    ttsTimeout: 120000,
    carePlanTimeout: 180000,
    mockReadFallback: false
  }
}

const CURRENT = ENVIRONMENTS[BUILD_ENV] || ENVIRONMENTS.development
const gateway = String(CURRENT.gateway || '').trim().replace(/\/$/, '')
// 临时域名识别（用于拒绝"发布包走调试隧道"）。域名写成字符类而非字面量：
// 让安全门禁（docs/security/.../security-gate.js 的 H8 规则）不会把"校验规则"误判成"真实地址"。
const TEMPORARY_HOST = new RegExp('(vicp[.]fun|ngrok|natapp|localhost|127[.]0[.]0[.]1)', 'i')

if (BUILD_ENV !== 'local') {
  if (!/^https:\/\//i.test(gateway)) {
    throw new Error(BUILD_ENV + ' 档缺少 HTTPS 网关。')
  }
  // 临时调试域名只允许出现在联调档；发布档（production）必须换正式域名
  if (BUILD_ENV === 'production' && TEMPORARY_HOST.test(gateway)) {
    throw new Error('生产构建仍在使用临时调试域名，请换成已备案的正式域名。')
  }
  if (CURRENT.mockReadFallback) throw new Error('生产构建禁止启用 mock 数据降级。')
}

// 契约定值（唯一来源：request.js 的请求头按这里拼装，不散落到各页面）
const PLATFORM = 'wechat-miniprogram' // 契约 X-Platform const（必须逐字相同，否则服务端 422）
const CLIENT_VERSION = '4.0.0'        // 契约 X-Client-Version（maxLength 20，用于灰度与兼容判断）

/**
 * 联调登录密钥（2026-10-29 · 后端 P0 第二道：dev provider 的 header 白名单）
 *
 * 背景：dev 档 provider 只认 code 形态（含 dev-user-2 → 医生），任何人不带凭证 curl
 * `{"code":"dev-user-1"}` 就能拿到真会话。后端 `DevLoginGuard` 现在要求
 * `X-Dev-Login-Key` 与 `APP_AUTH_DEV_LOGIN_KEY` 恒定时间相等，且显式开启
 * `APP_AUTH_DEV_LOGIN_ENABLED` —— 本常量就是前端这一侧的值（写入 backend/deploy/env.local）。
 *
 * ⚠️ 2026-11-18（审计 C1）三处收口，别再把它当"可公开"：
 *    ① production 档恒为空串 —— 发布包里不携带任何有效 dev 闸门值（下面的守卫会拦）；
 *    ② 值已轮换，且旧值（21cb… / 2818…）在后端 `app.auth.dev-login.revoked-keys` 永久黑名单内，
 *       命中即 403 —— 轮换只换当前值，撤销靠黑名单；
 *    ③ 真边界仍是后端 `SPRING_PROFILES_ACTIVE=prod`（prod 档不装配 dev provider），
 *       本值只用于挡"不带密钥的盲扫"，不是生产机密。
 * ⚠️ 换值时要**同步**改 env.local，否则真机联调会 403 DEV_LOGIN_FORBIDDEN。
 */
// 值只来自 env.local.js；仓库内不保存任何有效闸门值（审计 C1）。
const DEV_LOGIN_KEY = String(LOCAL_OVERRIDES.devLoginKey || '').trim()

if (BUILD_ENV === 'production' && DEV_LOGIN_KEY) {
  // fail-closed：发布包一旦带上有效闸门值，说明档位与密钥的管理出了错，构建期直接失败
  throw new Error('生产构建禁止携带 DEV_LOGIN_KEY（审计 C1）。')
}

// 契约 WechatLoginRequest.consentVersion（必填，1~20）：该值**不再由前端配置写死**（审计 M11）。
// 登录前必须由 services/consent.js 从 GET /api/v1/consent/latest 取服务端当前版本，
// 用户在独立同意页看到全文并点击后才能登录；版本不一致由服务端 409 拒绝。


// legacy 手输登录（POST /api/user/login，网关 dev 替身）与 dev 派生 code **仅限白名单档位**：
// 生产只用契约登录 /api/v1/auth/wechat/login 与 /api/v1/doctor/login（真实 code/phoneCode）。
// ⚠️ 原实现是 `BUILD_ENV !== 'production'`（黑名单）：任何非 production 取值都会打开手输登录，
//    属于 fail-open。改为白名单后，未知档位（含拼写错误）由上面的 ENV_KEYS 直接抛错。
const DEV_ONLY = BUILD_ENV === 'local' || BUILD_ENV === 'development'
const LEGACY_MANUAL_LOGIN_ENABLED = DEV_ONLY

module.exports = {
  name: BUILD_ENV,
  isProduction: BUILD_ENV === 'production',
  gateway,
  // 历史兼容别名；新代码统一使用 gateway。
  fastapi: gateway,
  springboot: gateway,
  aiTimeout: CURRENT.aiTimeout,
  ttsTimeout: CURRENT.ttsTimeout,
  carePlanTimeout: CURRENT.carePlanTimeout,
  serviceReady: !!gateway,
  // 仅查询类页面可在开发态使用。写操作不得调用 withFallback。
  MOCK_READ_FALLBACK: !!CURRENT.mockReadFallback,
  MOCK_FALLBACK: !!CURRENT.mockReadFallback,
  // 契约请求头定值 + 手输登录可用性
  platform: PLATFORM,
  clientVersion: CLIENT_VERSION,
  legacyManualLoginEnabled: LEGACY_MANUAL_LOGIN_ENABLED,
  // 联调登录密钥：仅 local/development 下发；production 恒空（不发 X-Dev-Login-Key）
  devLoginKey: DEV_ONLY ? DEV_LOGIN_KEY : ''
}
