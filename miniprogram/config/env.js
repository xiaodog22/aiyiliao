/*
 * env.js —— 小程序唯一网关与环境门禁
 *
 * 三档运行环境（只改 BUILD_ENV 一处）：
 *   'local'        PC 模拟器直连本机统一网关（不经内网穿透；见 DEV_DIRECT）
 *   'development'  隧道联调（真机 / 模拟器，经花生壳域名 qv56gv32944.vicp.fun:443 → 172.29.188.115:8080；
 *                  2026-10-20 真机排查：local 档在真机上会连 127.0.0.1（手机自己）必失败，
 *                  真机验证必须用本档；旧注释的 ChmlFrp 已废弃）
 *   'production'   发布包（流水线替换为 production；禁止临时隧道 / localhost）
 *
 * 后端服务均通过同一网关暴露（统一入口 :8080，穿透映射到同一端口）。local / development 可显式
 * 启用只读 mock；production 禁止临时隧道、localhost、写操作模拟成功和空网关。
 */
// 当前档位：development（真机联调）。模拟器本地调试改 'local'；发布流水线替换为 'production'。
const BUILD_ENV = 'development'

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
    gateway: DEV_DIRECT,
    aiTimeout: 90000,
    ttsTimeout: 120000,
    carePlanTimeout: 180000,
    mockReadFallback: true
  },
  development: {
    gateway: 'https://qv56gv32944.vicp.fun',
    aiTimeout: 90000,
    ttsTimeout: 120000,
    carePlanTimeout: 180000,
    mockReadFallback: true
  },
  production: {
    // 必须替换为已备案、已配置微信合法域名的正式 HTTPS 地址。
    gateway: '',
    aiTimeout: 45000,
    ttsTimeout: 60000,
    carePlanTimeout: 90000,
    mockReadFallback: false
  }
}

const CURRENT = ENVIRONMENTS[BUILD_ENV] || ENVIRONMENTS.development
const gateway = String(CURRENT.gateway || '').trim().replace(/\/$/, '')
const TEMPORARY_HOST = /(vicp\.fun|ngrok|natapp|localhost|127\.0\.0\.1)/i

if (BUILD_ENV === 'production') {
  if (!/^https:\/\//i.test(gateway) || TEMPORARY_HOST.test(gateway)) {
    throw new Error('生产构建缺少正式 HTTPS 网关，或仍在使用临时调试域名。')
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
 * ⚠️ 它不是生产机密：production 档 devLoginKey 恒为空（不发头），后端 prod 档也不装配该闸门。
 *    它的作用是「挡住不带密钥的盲扫」，真正的边界是 SPRING_PROFILES_ACTIVE=prod。
 * ⚠️ 换值时要**同步**改 env.local，否则真机联调会 403 DEV_LOGIN_FORBIDDEN。
 */
const DEV_LOGIN_KEY = 'wb-devlogin-21cbddfc3b21990d6df374f6fa3f92cc'

// 契约 WechatLoginRequest.consentVersion（必填，1~20）：用户确认过的隐私政策版本。
// ⚠️ 现有登录页只有"登录即代表同意"的文案，尚无独立的同意界面 —— 此处复用仓库内
//    既有联调登记版本 'v1.0'（M3IntegrationTest / fault_drill / 调试台同值）。
//    该合规交互（独立同意界面 + 版本号由运营登记）列为剩余风险，不在本次伪造"已同意"。
const CONSENT_VERSION = 'v1.0'

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
  consentVersion: CONSENT_VERSION,
  legacyManualLoginEnabled: LEGACY_MANUAL_LOGIN_ENABLED,
  // 联调登录密钥：仅 local/development 下发；production 恒空（不发 X-Dev-Login-Key）
  devLoginKey: DEV_ONLY ? DEV_LOGIN_KEY : ''
}
