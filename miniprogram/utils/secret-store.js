/*
 * secret-store.js —— 本地敏感值「静态混淆」存储（审计 M14）
 *
 * ⚠️ 先说清边界：**这不是加密，小程序也没有应用级安全存储**。
 *   微信小程序没有 Keychain / Keystore，也没有可供业务使用的安全 enclave；任何写在
 *   storage 里的东西，只要攻击者能拿到设备并导出 storage，就一定读得出来。本模块
 *   解决的是下面这三类**现实**风险，而不是"设备被攻破"：
 *     1. 直接扫 storage：`wx.getStorageSync('wb_refresh_token')` 以前拿到的是 `rt-…` 明文，
 *        恶意/第三方代码、调试面板、自动化脚本按 key 名一扫即得；
 *     2. 日志与错误上报：明文令牌经 console/日志/崩溃上报外泄（现在扫不到令牌形态）；
 *     3. 备份与截图：整包 storage 导出后直接可读。
 *
 *   密钥（wb_sk）与密文存在同一 storage 里 —— 拿得到密文就拿得到密钥，所以它挡不住
 *   "整盘 dump 后自行还原"。真正的边界仍是：**24h refresh TTL + 一次一换 + 服务端撤销整链**。
 *   若后续要更强，只能换成"不落盘 + 每次冷启动 wx.login 静默换会话"（需改登录流程）。
 *
 * 格式：v1.<seed8hex>.<base64(明文按字节 XOR keystream)>
 * 说明：keystream 由 seed 与每装机随机密钥共同派生，只做字节掩码；不含任何密码学承诺。
 */

const SECRET_KEY = 'wb_sk'
const VERSION_TAG = 'v1'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 每装机随机密钥（32 hex）。取不到就现生成并写入；写入失败则不落盘明文（见 put）。 */
function secret() {
  try {
    let s = wx.getStorageSync(SECRET_KEY)
    if (typeof s === 'string' && s.length >= 16) return s
    s = randomHex(32)
    wx.setStorageSync(SECRET_KEY, s)
    return s
  } catch (e) {
    return ''
  }
}

function randomHex(len) {
  let out = ''
  while (out.length < len) {
    out += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  }
  return out.slice(0, len)
}

/** xorshift32：够快、无依赖；这里只用来生成掩码，不承担任何安全强度承诺。 */
function keystream(seed, len) {
  let x = seed >>> 0 || 0x9e3779b9
  const out = new Array(len)
  for (let i = 0; i < len; i++) {
    x ^= (x << 13); x >>>= 0
    x ^= (x >>> 17)
    x ^= (x << 5); x >>>= 0
    out[i] = x & 0xff
  }
  return out
}

/** FNV-1a 32bit：只用来判「密钥是否对 / 密文是否被截断」，不承担密码学作用。 */
function fnv1a(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h >>> 0
}

function seedOf(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h >>> 0
}

function b64encode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : null
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : null
    out += B64[b0 >> 2]
    out += B64[((b0 & 0x03) << 4) | ((b1 === null ? 0 : b1) >> 4)]
    out += b1 === null ? '=' : B64[((b1 & 0x0f) << 2) | ((b2 === null ? 0 : b2) >> 6)]
    out += b2 === null ? '=' : B64[b2 & 0x3f]
  }
  return out
}

function b64decode(text) {
  const clean = String(text || '').replace(/[^A-Za-z0-9+/]/g, '')
  const bytes = []
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i])
    const c1 = B64.indexOf(clean[i + 1])
    const c2 = B64.indexOf(clean[i + 2])
    const c3 = B64.indexOf(clean[i + 3])
    if (c0 < 0 || c1 < 0) break
    bytes.push((c0 << 2) | (c1 >> 4))
    if (c2 >= 0) bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2))
    if (c3 >= 0) bytes.push(((c2 & 0x03) << 6) | c3)
  }
  return bytes
}

/** 明文 → 混淆串。仅接受 ASCII（令牌按契约就是 at-/rt- + UUID）。 */
function seal(plain) {
  const text = String(plain == null ? '' : plain)
  if (!text) return ''
  const key = secret()
  if (!key) return ''
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) return '' // 非 ASCII 不落盘，绝不退化成明文
  }
  const seedHex = randomHex(8)
  const payload = text.length + 4
  const mask = keystream(seedOf(seedHex + key), payload)
  const bytes = new Array(payload)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) ^ mask[i]
  const sum = fnv1a(text)
  for (let i = 0; i < 4; i++) {
    bytes[text.length + i] = ((sum >>> (24 - i * 8)) & 0xff) ^ mask[text.length + i]
  }
  return VERSION_TAG + '.' + seedHex + '.' + b64encode(bytes)
}

/** 混淆串 → 明文；损坏/密钥丢失返回 ''（绝不返回半截令牌）。 */
function open(sealed) {
  const raw = String(sealed == null ? '' : sealed)
  if (!raw) return ''
  const parts = raw.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION_TAG) return ''
  const key = secret()
  if (!key) return ''
  const bytes = b64decode(parts[2])
  // 至少要有 1 字节明文 + 4 字节校验；短于此一律视为损坏
  if (bytes.length < 5) return ''
  const mask = keystream(seedOf(parts[1] + key), bytes.length)
  const n = bytes.length - 4
  let text = ''
  for (let i = 0; i < n; i++) text += String.fromCharCode(bytes[i] ^ mask[i])
  let sum = 0
  for (let i = 0; i < 4; i++) sum = (sum << 8) | ((bytes[n + i] ^ mask[n + i]) & 0xff)
  // 密钥不对或密文被截断时，解出来的校验必然不符 → 返回空串，绝不返回半截令牌
  if ((sum >>> 0) !== fnv1a(text)) return ''
  return text
}

/** 写入：混淆失败时**不写**（不静默退化成明文），并清掉旧值避免新旧混用。 */
function put(key, plain) {
  try {
    const sealed = seal(plain)
    if (!sealed) {
      wx.removeStorageSync(key)
      return false
    }
    wx.setStorageSync(key, sealed)
    return true
  } catch (e) {
    return false
  }
}

/**
 * 读取：兼容历史明文（升级前写入的 `rt-…`）。
 * 命中明文时**就地重写**为混淆串，下一次读起不再有明文留存。
 */
function get(key) {
  try {
    const raw = wx.getStorageSync(key)
    if (!raw) return ''
    const text = String(raw)
    if (text.indexOf(VERSION_TAG + '.') === 0) return open(text)
    // 旧格式：明文直存。迁移一次，失败也不影响本次返回。
    put(key, text)
    return text
  } catch (e) {
    return ''
  }
}

function remove(key) {
  try { wx.removeStorageSync(key) } catch (e) {}
}

module.exports = { put, get, remove, seal, open, _randomHex: randomHex }
