/**
 * voice.js —— 音色管理服务（2026-10-23 换回远端数据源）
 *
 * 数据源（契约 business-openapi.yaml：GET/POST/DELETE /api/v1/voice/voices 等）：
 *   · catalogRemote()/list()：GET VOICE_LIST 远端优先（服务端内置 + 用户偏好 + 自定义），
 *     失败回落本地 CATALOG（源标注 source: remote|local），不假装远端数据。
 *   · 设默认 / 保存偏好：PUT VOICE_DEFAULT（服务端**立即持久化**，换机随账号恢复），
 *     本地 storage 同步生效；云端失败只降级不上报错误（本机仍可用）。
 *   · 删除自定义音色：DELETE VOICE_DELETE（幂等），本地再记一条隐藏记录。
 *   · 试听：POST VOICE_PREVIEW（固定示例文本，走契约试听通道），失败回落主 TTS 接口。
 *
 * storage 键（与 services/speech.js 共用，TTS 播报直接读，不经过本模块）：
 *   wb_voice         当前默认音色 id            —— speech.currentVoice() / setCurrentVoice()
 *   wb_voice_rate    语速 0.5~2.0（缺省 1.0）    —— speech.currentRate() / setCurrentRate()
 *   wb_voice_hidden  已删除的自定义音色 id 数组  —— 本模块私有
 */
const speech = require('./speech.js')
const { get, put, post, del, API, withPath, newIdempotencyKey } = require('./request.js')

const HIDDEN_KEY = 'wb_voice_hidden'
const DEFAULT_VOICE = 'preset_gentle'

/**
 * 最近一次远端目录（服务端内置 + 自定义）。
 * ⚠️ 必须留着：save()/remove() 的合法性校验若只认本地 CATALOG，
 *    **远端音色会被判"不存在"**，用户能看到却设不了默认、删不掉（审查 P2-10）。
 */
let _remoteRows = []

/**
 * 内置音色目录 —— 名称/描述取自设计稿，顺序与设计稿一致。
 * custom=true 的音色可删除（设计稿第三个音色带「删除」）；内置三项不可删。
 */
const CATALOG = [
  {
    id: 'preset_gentle',
    name: '温柔女声',
    locale: '普通话',
    trait: '温和细腻',
    // 设计稿未在列表里展示该音色的描述（它就是「当前默认音色」，只出现在顶部蓝边卡），
    // 按同组「语言 · 特点」体例补齐，待设计确认 —— 见遗留清单第 23 页。
    desc: '普通话 · 温和细腻',
    custom: false
  },
  {
    id: 'preset_pro',
    name: '专业男声',
    locale: '普通话',
    trait: '沉稳专业',
    desc: '普通话 · 沉稳专业',
    custom: false
  },
  {
    id: 'preset_warm',
    name: '亲切女声',
    locale: '普通话',
    trait: '温和亲切',
    desc: '普通话 · 温和亲切',
    custom: false
  },
  {
    id: 'preset_chaoshan',
    name: '潮汕话女声',
    locale: '潮汕话',
    trait: '本地口音',
    desc: '潮汕话 · 本地口音',
    custom: true
  }
]

// ============ 本地记忆：已隐藏（已删除）的自定义音色 ============
function hiddenIds() {
  try {
    const v = wx.getStorageSync(HIDDEN_KEY)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch (e) { return [] }
}

function _writeHidden(arr) {
  try { wx.setStorageSync(HIDDEN_KEY, Array.isArray(arr) ? arr : []) } catch (e) {}
}

// ============ 目录 ============
/**
 * 同步取目录（页面首屏直接用，无需 loading 态）
 * @returns {{rows:Array, current:string, currentName:string, hiddenCount:number}}
 */
function catalog() {
  const hidden = hiddenIds()
  const rows = CATALOG
    .filter((v) => !(v.custom && hidden.indexOf(v.id) >= 0))
    .map((v) => ({
      id: v.id,
      name: v.name,
      desc: v.desc,
      custom: !!v.custom
    }))

  let current = currentVoice()
  // 当前音色已被删除（或 storage 里的 id 不在目录里）→ 回落到第一个可用音色并重写记忆
  if (!rows.some((r) => r.id === current)) {
    current = rows.length ? rows[0].id : ''
    speech.setCurrentVoice(current)
  }
  const hit = rows.filter((r) => r.id === current)[0]
  return {
    rows,
    current,
    currentName: hit ? hit.name : '',
    currentDesc: hit ? hit.desc : '',
    hiddenCount: hidden.length
  }
}

/** 目录分组（settings.js 的「音色」行沿用此结构取当前音色名） */
function _groups(rows) {
  const groups = [
    { key: 'speaker', label: '内置音色', items: [] },
    { key: 'clone', label: '自定义音色', items: [] }
  ]
  rows.forEach((r) => {
    groups[r.custom ? 1 : 0].items.push({
      id: r.id,
      name: r.name,
      description: r.desc,
      type: r.custom ? 'clone' : 'speaker',
      available: true
    })
  })
  return groups.filter((g) => g.items.length > 0)
}

/**
 * 远端音色目录（契约 GET /api/v1/voice/voices：服务端内置音色 + 用户偏好 + 自定义）。
 * 远端失败/空目录时回落本地 CATALOG（不假装远端数据；source 标注数据来源，供页面排查）。
 * @returns {Promise<{rows, current, currentName, currentDesc, hiddenCount, source}>}
 */
function catalogRemote() {
  return get(API.VOICE_LIST)
    .then((list) => {
      const rows = (Array.isArray(list) ? list : [])
        .map((v) => ({
          id: v.id,
          name: v.displayName || '',
          desc: [v.locale, v.gender].filter(Boolean).join(' · '),
          custom: !!v.isCustom,
          available: v.available !== false
        }))
        .filter((v) => v.available)
      if (!rows.length) return null
      const hidden = hiddenIds()
      const visible = rows.filter((v) => !(v.custom && hidden.indexOf(v.id) >= 0))
      // 记住远端全集（含已隐藏的），供 save/remove 校验与删除判断使用
      _remoteRows = visible.slice()
      let current = currentVoice()
      if (!visible.some((r) => r.id === current)) {
        current = visible.length ? visible[0].id : ''
        speech.setCurrentVoice(current)
      }
      const hit = visible.filter((r) => r.id === current)[0]
      return {
        rows: visible,
        current,
        currentName: hit ? hit.name : '',
        currentDesc: hit ? hit.desc : '',
        hiddenCount: hidden.length,
        source: 'remote'
      }
    })
    .catch(() => {
      const c = catalog()
      return Object.assign({}, c, { source: 'local' })
    })
}

/**
 * 兼容旧调用方（pages/profile/settings.js）的异步清单接口。
 * 远端优先（GET /api/v1/voice/voices），失败回落本地目录。
 */
function list() {
  return catalogRemote().then((c) => ({
    rows: c.rows,
    groups: _groups(c.rows),
    current: c.current,
    currentName: c.currentName,
    // 出厂默认语义：本地常量（远端无"出厂默认第一项"概念）
    defaultVoice: DEFAULT_VOICE,
    count: c.rows.length
  }))
}

// ============ 当前音色 ============
function currentVoice() {
  return speech.currentVoice()
}

function setCurrentVoice(id) {
  speech.setCurrentVoice(id)
}

// ============ 保存 / 删除 / 恢复 ============
/** 合法音色全集：本地内置目录 ∪ 最近一次远端目录（远端音色不能被判"不存在"） */
function _knownRows() {
  return CATALOG.concat(_remoteRows.filter((r) => !CATALOG.some((c) => c.id === r.id)))
}

/**
 * 保存音色偏好（音色 + 语速）
 * 本地立即生效，同时 PUT 契约 /voices/default 持久化到账号（换机/重装后随账号恢复）。
 * ⚠️ 云端失败**不 reject**：音色偏好不是关键写操作，本机已生效就不该弹错误；
 *    返回值里的 synced=false 供页面提示「云端保存失败，本机仍生效」。
 * @param {{voiceId?:string, rate?:number}} cfg
 * @returns {Promise<{voiceId:string, rate:number, synced:boolean}>}
 */
function save(cfg) {
  const c = cfg || {}
  const voiceId = c.voiceId || ''
  if (voiceId && !_knownRows().some((r) => r.id === voiceId)) {
    const e = new Error('音色不存在')
    e.code = 'NOT_FOUND'
    return Promise.reject(e)
  }
  if (voiceId) speech.setCurrentVoice(voiceId)
  if (c.rate !== undefined) speech.setCurrentRate(c.rate)
  const local = { voiceId: voiceId || currentVoice(), rate: speech.currentRate() }

  const body = { voiceId: local.voiceId }
  if (local.rate !== undefined && local.rate !== null) body.rate = local.rate
  return put(API.VOICE_DEFAULT, body, { idempotencyKey: newIdempotencyKey() }).then(
    () => Object.assign({}, local, { synced: true }),
    (err) => {
      console.warn('[voice] 云端保存音色偏好失败（本机已生效）：' + (err && err.code))
      return Object.assign({}, local, { synced: false })
    }
  )
}

/**
 * 删除自定义音色（内置不可删；幂等）
 * 远端自定义音色走 DELETE 契约端点（服务端幂等，重复删同样成功）；本地再记一条隐藏记录。
 */
function remove(id) {
  const local = CATALOG.filter((v) => v.id === id)[0]
  const remote = _remoteRows.filter((v) => v.id === id)[0]
  const custom = (local && local.custom) || (remote && remote.custom)
  if (!custom) {
    const e = new Error('该音色不可删除')
    e.code = 'FORBIDDEN'
    return Promise.reject(e)
  }
  const hide = () => {
    const hidden = hiddenIds()
    if (hidden.indexOf(id) < 0) hidden.push(id)
    _writeHidden(hidden)
    _remoteRows = _remoteRows.filter((r) => r.id !== id)
    return { removed: id }
  }
  // 只在"远端确有这条自定义音色"时才打服务端，纯本地目录项不必发无谓请求
  if (!remote) return Promise.resolve(hide())
  return del(withPath(API.VOICE_DELETE, { voiceId: id }), null, { idempotencyKey: newIdempotencyKey() })
    .then(hide, (err) => {
      // 服务端删除失败（网络/权限）→ 如实 reject，不假装已删
      const e = new Error('删除失败，请稍后重试')
      e.code = (err && err.code) || 'DELETE_FAILED'
      throw e
    })
}

/**
 * 试听指定音色（契约 POST /voices/{voiceId}/previews，固定示例文本 → 签名音频地址）。
 * 与主 TTS 接口的区别：服务端只允许固定示例文本，不会变成任意合成通道。
 * @returns {Promise<boolean>} 是否开始播放（失败由调用方决定是否回落主接口）
 */
function preview(id, opts) {
  const o = opts || {}
  if (!id) return Promise.resolve(false)
  return post(withPath(API.VOICE_PREVIEW, { voiceId: id }), {}, { idempotencyKey: newIdempotencyKey() })
    .then((data) => {
      const url = (data && (data.audioUrl || data.audio_url)) || ''
      if (!url) throw Object.assign(new Error('试听未返回音频地址'), { code: 'EMPTY_AUDIO' })
      const meta = { engine: (data && data.engine) || '', degraded: !!(data && data.degraded) }
      if (o.onDegraded && meta.degraded) o.onDegraded(meta)
      return speech.speakUrl(url, o)
    })
    .catch((err) => {
      console.warn('[voice] 契约试听失败，回落主 TTS：' + (err && err.code))
      return false
    })
}

/** 恢复默认音色列表（清掉删除记录；已删音色重新出现） */
function restore() {
  _writeHidden([])
  return Promise.resolve(catalog())
}

module.exports = {
  catalog, catalogRemote, list,
  current: currentVoice,
  setCurrent: setCurrentVoice,
  save, remove, preview, restore,
  DEFAULT_VOICE,
  HIDDEN_KEY
}
