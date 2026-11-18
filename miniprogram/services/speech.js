/**
 * speech.js —— 语音服务（V1.7 统一网关版）
 *
 * 模块 1：ASR —— 录音 → 上传 /api/v1/voice/asr（wx.getRecorderManager）
 * 模块 2：TTS —— 文本 → /api/v1/voice/tts → 服务端 TTS（当前引擎为 edge-tts，
 *          即微软 Edge 在线朗读音色，不是客户端直连 Azure API）→ 写临时文件 → InnerAudioContext
 *
 * ⚠️ 相对旧版的三个必改点（对照《前端适配说明》§5）：
 *   1. **不写死音频后缀**（服务端引擎可能返回 WAV/MP3）；
 *      播放前按文件头（RIFF/ID3/MPEG）判定后缀。
 *   2. 新增 `voice` 参数（音色 id，与后端内置音色一致，如 qwen3-female-1），见 §6 音色对照表。
 *   3. 新增降级识别：响应 `degraded === true` 或 `engine === 'placeholder'` 时回调
 *      onDegraded，由页面提示"当前为占位音质"。小程序无 SpeechSynthesis，
 *      不做浏览器朗读兜底；占位音频本身有声音且能听出音色差异，故照常播放、不阻断流程。
 *
 * ⚠️ 重要约定：朗读是**锦上添花**，不是主流程。
 * 因此 speak / speakUrl **永不 reject** —— 任何失败都只回调 onError 并 resolve(false)。
 * 否则调用方漏写 .catch() 会抛 MiniProgramError 打断页面（2026-09-06 教训）。
 */
const ENV = require('../config/env.js')
const req = require('./request.js')
const capabilities = require('./capabilities.js')
const { errText } = require('../utils/err-text.js')
const { ensurePrivacy } = require('../utils/privacy.js')
const API = req.API

const VOICE_STORAGE_KEY = 'wb_voice'
const VOICE_READ_KEY = 'wb_voice_read'
const RATE_STORAGE_KEY = 'wb_voice_rate'
const RATE_MIN = 0.5
const RATE_MAX = 2.0
const MAX_TTS_CHARS = 500

/**
 * 业务音色 → locale（2026-11-18 降级链）。
 * 粤语音色必须带 zh-HK，否则服务端会把粤语文本交给普通话 Qwen3/默认女声；
 * ASR 也据此决定是否直接走端侧 WechatSI（本地 FunASR 只覆盖普通话）。
 */
function voiceLocale(voice) {
  return /^yue-/i.test(String(voice || '')) ? 'zh-HK' : 'zh-CN'
}

/** 取 WechatSI 插件；后端快照否决（仅本地）、未声明/未授权/低版本一律返回 null。 */
function _wechatSI() {
  // WechatSI 是腾讯云端能力，属"云端供应商"：以后端 capabilities 快照为准，一票否决。
  if (!capabilities.allowed('wechatSi')) return null
  try {
    // eslint-disable-next-line no-undef
    return requirePlugin('WechatSI') || null
  } catch (e) {
    return null
  }
}

/** 端侧插件可承接的方言 locale：粤语、四川话（普通话仍走本地 FunASR）。 */
function _isWechatSILocale(locale) {
  return locale === 'zh-HK' || locale === 'zh-SICHUAN'
}

// ============ 朗读开关（设置页切换 → 全局生效；默认开启）============
// 之前设置页的「语音朗读」是死开关（只 setData，不生效、文案还写着"暂未接入"），
// 这里统一收敛到 storage `wb_voice_read`，问诊 / 导诊播报都读它。
function voiceReadEnabled() {
  try {
    const v = wx.getStorageSync(VOICE_READ_KEY)
    return (v === '' || v === null || v === undefined) ? true : !!v
  } catch (e) { return true }
}

function setVoiceRead(on) {
  try { wx.setStorageSync(VOICE_READ_KEY, !!on) } catch (e) {}
}

// ============ 音频播放（TTS / 音色试听 / 网关 audio 共用）============
let _audio = null
let _ttsSeq = 0
// 播报代次：每次 speak/speakUrl 领一个号，stopSpeak 或新一次播报会让旧号失效。
// 页面退出后仍在飞行的 TTS 请求回来时只允许"丢弃"，不得补播、不得再回调页面。
let _playSeq = 0
// 高频句预加载内存缓存：key=voice|rate|text，最多 8 条。
// 只缓存短音频（固定问候/提示），不缓存患者自由文本，避免内存无界增长。
const _bufCache = new Map()
const BUF_CACHE_MAX = 8

function _bufKey(text, voice, rate) {
  return (voice || '') + '|' + _safeRate(rate) + '|' + text
}

function _rememberBuf(key, buf) {
  if (!key || !buf) return
  if (_bufCache.has(key)) _bufCache.delete(key)
  _bufCache.set(key, buf)
  while (_bufCache.size > BUF_CACHE_MAX) {
    const oldest = _bufCache.keys().next().value
    _bufCache.delete(oldest)
  }
}

function _getAudio() {
  if (!_audio) {
    _audio = wx.createInnerAudioContext()
    _audio.obeyMuteSwitch = false   // 静音键不拦播报（否则 iOS 上会"点了没声"）
    _audio.autoplay = true
  }
  return _audio
}

function _stopAudio() {
  if (_audio) {
    try { _audio.stop() } catch (e) {}
  }
}

function stopSpeak() {
  // +1 让所有在飞行的 speak/speakUrl 过期；仅 stop() 拦不住已经发出的请求。
  _playSeq += 1
  _stopAudio()
}

function _isCurrentPlay(token) {
  return token === undefined || token === _playSeq
}

/** 按文件头判定音频后缀：WAV(RIFF) / MP3(ID3 或 0xFFEx) / 兜底 wav */
function _extOf(buf) {
  try {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    if (b.length >= 4) {
      // RIFF
      if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'wav'
      // ID3
      if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3'
      // MPEG frame sync 0xFF Ex
      if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'mp3'
    }
  } catch (e) {}
  return 'wav'
}

/** 语速归一：契约/音色页都是 0.5~2.0，异常值回落 1.0 */
function _safeRate(value) {
  const v = Number(value)
  if (!isFinite(v)) return 1
  return Math.min(RATE_MAX, Math.max(RATE_MIN, v))
}

/** 播放倍速（InnerAudioContext.playbackRate）：老基础库不支持时静默跳过，不影响播放 */
function _applyPlaybackRate(audio, opts) {
  const o = opts || {}
  const rate = _safeRate(o.rate !== undefined ? o.rate : currentRate())
  try { audio.playbackRate = rate } catch (e) {}
}

/**
 * 播放一段音频二进制（ArrayBuffer / base64 字符串）
 * @param {ArrayBuffer|string} data
 * @param {{rate?:number, token?:number, onStart?:Function,onEnd?:Function,onError?:Function}} [opts]
 * @returns {Promise<boolean>} 是否成功开始播放（永不 reject）
 */
function playArrayBuffer(data, opts) {
  const o = opts || {}
  return new Promise((resolve) => {
    if (!data) {
      if (o.onError) o.onError('音频为空')
      resolve(false)
      return
    }
    let buf = data
    if (typeof data === 'string') {
      try { buf = wx.base64ToArrayBuffer(data) } catch (e) { buf = null }
    }
    if (!buf) {
      if (o.onError) o.onError('音频数据无法解码')
      resolve(false)
      return
    }
    if (!_isCurrentPlay(o.token)) {
      resolve(false)
      return
    }

    _stopAudio()
    const audio = _getAudio()
    // 语速在客户端生效：后端当前只把 rate 用于缓存键，未下发给 edge-tts；
    // 这里直接设置播放倍速，已缓存的音频也能立刻按新语速播放。
    _applyPlaybackRate(audio, o)
    if (!_isCurrentPlay(o.token)) {
      resolve(false)
      return
    }
    if (o.onStart) o.onStart()

    const fsm = wx.getFileSystemManager()
    // ⚠️ 文件名加自增序号：同一毫秒内连续播报会用 Date.now() 撞名，后一次覆盖前一次的文件
    _ttsSeq += 1
    const tmpPath = wx.env.USER_DATA_PATH + '/tts_' + Date.now() + '_' + _ttsSeq + '.' + _extOf(buf)
    // ⚠️ data 是 ArrayBuffer 时**不要传 encoding**（encoding 只对 string 有意义；
    //    个别基础库会把 ArrayBuffer 当字符串处理 → 写出的音频文件损坏、播放无声）
    fsm.writeFile({
      filePath: tmpPath,
      data: buf,
      success: () => {
        if (!_isCurrentPlay(o.token)) {
          resolve(false)
          return
        }
        let done = false
        const finish = (ok) => {
          if (done) return
          done = true
          // 页面已离开/被新播报接管：不回调页面回调，避免 unloading 页面再 setData。
          if (_isCurrentPlay(o.token) && o.onEnd) o.onEnd()
          resolve(ok)
        }
        audio.onEnded(() => finish(true))
        audio.onError((e) => {
          console.warn('[speech] 音频播放出错，已跳过（不影响主流程）' + JSON.stringify(e || {}))
          if (_isCurrentPlay(o.token) && o.onError) o.onError('音频播放失败')
          finish(false)
        })
        // ⚠️ 只赋值 src 后立刻 play()，在部分机型上是空操作（资源尚未就绪）。
        //    所以：赋值后**立即试播一次**，并在 onCanplay 里**再播一次**（重复调用幂等）。
        audio.onCanplay(() => {
          if (!_isCurrentPlay(o.token)) return
          _applyPlaybackRate(audio, o)
          try { audio.play() } catch (e) {}
        })
        audio.src = tmpPath
        try { audio.play() } catch (e) {}
      },
      fail: (e) => {
        console.warn('[speech] 音频写入失败，已跳过（不影响主流程）' + JSON.stringify(e || {}))
        if (_isCurrentPlay(o.token) && o.onError) o.onError('音频播放失败')
        if (_isCurrentPlay(o.token) && o.onEnd) o.onEnd()
        resolve(false)
      }
    })
  })
}

/**
 * 播放本地临时文件（WechatSI 端侧 TTS 返回 filename 时使用）。
 * 与 playArrayBuffer 一样：永不 reject，失败只回调 onError 并 resolve(false)。
 */
function playFilePath(filePath, opts) {
  const o = opts || {}
  return new Promise((resolve) => {
    if (!filePath) {
      if (o.onError) o.onError('音频文件为空')
      resolve(false)
      return
    }
    if (!_isCurrentPlay(o.token)) {
      resolve(false)
      return
    }
    _stopAudio()
    const audio = _getAudio()
    _applyPlaybackRate(audio, o)
    if (o.onStart) o.onStart()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      if (_isCurrentPlay(o.token) && o.onEnd) o.onEnd()
      resolve(ok)
    }
    audio.onEnded(() => finish(true))
    audio.onError((e) => {
      console.warn('[speech] 端侧音频播放出错，已跳过' + JSON.stringify(e || {}))
      if (_isCurrentPlay(o.token) && o.onError) o.onError('音频播放失败')
      finish(false)
    })
    audio.onCanplay(() => {
      if (!_isCurrentPlay(o.token)) return
      _applyPlaybackRate(audio, o)
      try { audio.play() } catch (e) {}
    })
    audio.src = filePath
    try { audio.play() } catch (e) {}
  })
}

// ============ 音色（本地记忆，进页面时由 services/voice.js 与后端同步）============
function currentVoice() {
  try { return wx.getStorageSync(VOICE_STORAGE_KEY) || '' } catch (e) { return '' }
}

function setCurrentVoice(id) {
  try { wx.setStorageSync(VOICE_STORAGE_KEY, id || '') } catch (e) {}
}

// ============ 语速（本地记忆；契约 rate ∈ [0.5, 2.0]，缺省 1.0）============
function currentRate() {
  try {
    const v = Number(wx.getStorageSync(RATE_STORAGE_KEY))
    return (isFinite(v) && v >= RATE_MIN && v <= RATE_MAX) ? v : 1
  } catch (e) { return 1 }
}

function setCurrentRate(rate) {
  const v = Number(rate)
  if (!isFinite(v)) return
  try { wx.setStorageSync(RATE_STORAGE_KEY, Math.min(RATE_MAX, Math.max(RATE_MIN, v))) } catch (e) {}
}

// ============ TTS 合成 ============
/** 音频地址 → 路径（含 query）。绝对地址（可能来自别处）只保留 path，统一打到 ENV.gateway */
function pathOf(urlOrPath) {
  const p = String(urlOrPath || '').trim()
  if (!/^https?:\/\//i.test(p)) return p
  const m = p.match(/^https?:\/\/[^/]+(\/.*)?$/i)
  return (m && m[1]) || ''
}

/**
 * 契约 TtsResult → { buf, meta }
 * 契约**不内联音频字节**，只给短期签名地址（/api/gw/tts/audio/{file}?token=…，该路径按设计免登录，
 * 因 audio 元素无法携带 Authorization），因此这里再取一次流把音频拉成 ArrayBuffer 交播放器。
 * 保留 audio_base64 与二进制兜底（旧形状）。
 * @returns {Promise<{buf:ArrayBuffer, meta:Object}>}
 */
function _normalize(res) {
  if (req.isArrayBuffer(res)) {
    return Promise.resolve({ buf: res, meta: { engine: '', degraded: false, voice_id: '' } })
  }
  if (!res || typeof res !== 'object') {
    const e = new Error('语音合成响应异常')
    e.code = 'PARSE_ERROR'
    return Promise.reject(e)
  }
  const meta = {
    engine: res.engine || '',
    degraded: !!res.degraded,
    cached: !!res.cached,
    voice_id: res.voiceId || res.voice_id || ''
  }
  if (res.audio_base64) {
    return Promise.resolve({ buf: wx.base64ToArrayBuffer(res.audio_base64), meta })
  }
  const url = res.audioUrl || res.audio_url || ''
  if (!url) {
    const e = new Error('语音合成未返回音频地址')
    e.code = 'EMPTY_AUDIO'
    return Promise.reject(e)
  }
  return req.getBinary({ base: 'gateway', path: pathOf(url) }, null, { timeout: ENV.ttsTimeout })
    .then((buf) => ({ buf, meta }))
}

/**
 * 调后端合成语音（不播放）
 * 契约 POST /api/v1/voice/tts：**JSON** body {text, voiceId, rate, format, locale}
 * + `Idempotency-Key`（required）+ Bearer。
 * ⚠️ 旧实现用 multipart `{text, raw, voice}` 打这个 JSON 接口 —— 形态不符必然 400/415；
 *    且旧代码 404/405 时退到的 /api/v1/voice/tts/edge 在网关只是"转发到同一端点"的兼容别名，
 *    契约端点已实现，别名不带来额外可达性，故不再保留该回退。
 * @returns {Promise<{buf:ArrayBuffer, meta:Object}>}
 */
function synthesize(text, opts) {
  const o = opts || {}
  const slice = String(text || '').trim().slice(0, MAX_TTS_CHARS)
  if (!slice) return Promise.reject(Object.assign(new Error('空文本'), { code: 'BAD_SPEC' }))

  const voice = o.voice || currentVoice()
  // rate 由音色管理页写入本地（wb_voice_rate），契约范围 0.5~2.0
  const rate = _safeRate(o.rate !== undefined ? o.rate : currentRate())
  const body = { text: slice, format: 'mp3', rate, locale: o.locale || voiceLocale(voice) }
  if (voice) body.voiceId = voice

  return req.post(API.VOICE_TTS, body, {
    timeout: ENV.ttsTimeout,
    idempotencyKey: req.newIdempotencyKey()
  }).then(_normalize)
}

/**
 * 预取高频句音频到内存（不播放）。
 * 页面首屏调用一次，之后 speak 同 voice/rate/text 命中内存缓存，省掉网关往返。
 * 只用于固定问候/提示，不要传患者自由文本。
 * @param {string|string[]} texts
 * @param {{voice?:string, rate?:number}} [opts]
 * @returns {Promise<boolean[]>}
 */
function prefetch(texts, opts) {
  const o = opts || {}
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((t) => String(t || '').trim().slice(0, MAX_TTS_CHARS))
    .filter(Boolean)
  if (!list.length) return Promise.resolve([])
  const voice = o.voice || currentVoice()
  const rate = _safeRate(o.rate !== undefined ? o.rate : currentRate())
  return Promise.all(list.map((text) => {
    const key = _bufKey(text, voice, rate)
    if (_bufCache.has(key)) return true
    // 预取只写缓存，不触发 onStart/onEnd，也不占用播报代次
    return synthesize(text, { voice, rate }).then((r) => {
      if (r && r.buf) {
        _rememberBuf(key, r.buf)
        return true
      }
      return false
    }).catch(() => false)
  }))
}

/**
 * 端侧 WechatSI 朗读（仅普通话；粤语/潮汕不走，避免音色与语言错配）。
 * @returns {Promise<boolean>|null} 插件不可用返回 null（交给调用方报原错误），否则返回播放结果
 */
function _speakWechatSI(text, opts, token) {
  const plugin = _wechatSI()
  if (!plugin || typeof plugin.textToSpeech !== 'function') return null
  const o = opts || {}
  return new Promise((resolve) => {
    plugin.textToSpeech({
      lang: 'zh_CN',
      tts: true,
      content: String(text || ''),
      success: (res) => {
        if (!_isCurrentPlay(token)) { resolve(false); return }
        if (o.onMeta) o.onMeta({ engine: 'wechat_si', degraded: true, voice_id: '' })
        if (o.onDegraded) o.onDegraded({ engine: 'wechat_si', degraded: true })
        const file = res && (res.filename || res.filePath)
        if (!file) {
          if (o.onError) o.onError('端侧语音未返回音频')
          if (o.onEnd) o.onEnd()
          resolve(false)
          return
        }
        playFilePath(file, Object.assign({}, o, { token })).then(resolve)
      },
      fail: (err) => {
        console.warn('[speech] 端侧朗读失败：' + JSON.stringify(err || {}))
        if (_isCurrentPlay(token) && o.onError) o.onError('端侧语音暂不可用')
        if (_isCurrentPlay(token) && o.onEnd) o.onEnd()
        resolve(false)
      }
    })
  })
}

/**
 * 文本转语音并播放（永不 reject）
 * @param {string} text
 * @param {Object} opts { voice, rate, active, onStart, onEnd, onError, onDegraded, onMeta }
 * @returns {Promise<boolean>} 是否成功开始播放
 */
function speak(text, opts) {
  const o = opts || {}
  const t = String(text || '').trim().slice(0, MAX_TTS_CHARS)
  if (!t) {
    if (o.onError) o.onError('空文本')
    return Promise.resolve(false)
  }
  if (typeof o.active === 'function' && !o.active()) return Promise.resolve(false)

  // 每次播报领一个代次；新一次播报或 stopSpeak 会让旧请求回来时自动作废
  const token = (_playSeq += 1)
  const voice = o.voice || currentVoice()
  const rate = _safeRate(o.rate !== undefined ? o.rate : currentRate())

  const cached = _bufCache.get(_bufKey(t, voice, rate))
  if (cached) {
    return playArrayBuffer(cached, Object.assign({}, o, { token }))
  }

  // onStart 由 playArrayBuffer 在真正开始播放时回调（合成失败不误报"播放中"）
  return synthesize(t, { voice, rate }).then((r) => {
    if (!_isCurrentPlay(token)) return false
    if (o.onMeta) o.onMeta(r.meta)
    // 降级提示：engine=placeholder / degraded=true → 占位音质（仍有声音，照常播放）
    if (o.onDegraded && (r.meta.degraded || r.meta.engine === 'placeholder')) {
      o.onDegraded(r.meta)
    }
    return playArrayBuffer(r.buf, Object.assign({}, o, { token }))
  }).catch((err) => {
    if (!_isCurrentPlay(token)) return false
    const code = err && err.code
    console.warn('[speech] TTS 失败（' + code + '）：' + (err && err.message))
    // L4 端侧兜底：普通话才用 WechatSI 朗读；粤语保持文字（不做机器口语化/错音色）。
    if (voiceLocale(voice) === 'zh-CN') {
      const viaSi = _speakWechatSI(t, o, token)
      if (viaSi) return viaSi
    }
    const msg = code === 'EMPTY_AUDIO' || code === 'PARSE_ERROR'
      ? '语音合成失败，请稍后重试'
      : (code === 'TIMEOUT' ? '语音合成超时，请稍后重试' : '语音服务暂不可用')
    if (o.onError) o.onError(msg)
    if (o.onEnd) o.onEnd()
    return false
  })
}

/**
 * 播放网关会话生成的语音（SSE `tts` 事件给的是 /api/gw/audio/{token}）
 * @param {string} urlOrPath 绝对地址或以 / 开头的网关路径
 * @param {Object} opts { rate, active, onStart, onEnd, onError }
 * @returns {Promise<boolean>}
 */
function speakUrl(urlOrPath, opts) {
  const o = opts || {}
  const p = String(urlOrPath || '').trim()
  if (!p) {
    if (o.onError) o.onError('语音地址为空')
    return Promise.resolve(false)
  }
  if (typeof o.active === 'function' && !o.active()) return Promise.resolve(false)
  // 统一取路径部分（复用 pathOf）：绝对地址只保留 path，避免拼成"网关+完整URL"
  const path = pathOf(p)
  if (!path) {
    if (o.onError) o.onError('语音地址无效')
    return Promise.resolve(false)
  }
  const token = (_playSeq += 1)
  const spec = { base: 'gateway', path }
  return req.getBinary(spec, null, { timeout: ENV.ttsTimeout })
    .then((buf) => {
      if (!_isCurrentPlay(token)) return false
      return playArrayBuffer(buf, Object.assign({}, o, { token }))
    })
    .catch((err) => {
      if (!_isCurrentPlay(token)) return false
      console.warn('[speech] 网关语音获取失败：' + (err && err.code))
      if (o.onError) o.onError(err && err.code === 'HTTP_ERROR' ? err.message : '语音播放失败')
      if (o.onEnd) o.onEnd()
      return false
    })
}

// ============ ASR（录音 → /api/v1/voice/asr）============
let recorder = null
let stoppedByUser = false
let _siRec = null

function _ensureRecorder() {
  if (!recorder) recorder = wx.getRecorderManager()
  return recorder
}

/**
 * 端侧 WechatSI 识别（仅粤语/显式指定时）。
 * 与 wx.getRecorderManager 不同：插件自己录音并返回最终文本，无法识别"已录好的文件"，
 * 所以粤语必须在**开始录音时**就选它，不能在服务端失败后再补救同一段音频。
 */
function _startWechatSIRecord(h, locale) {
  if (!capabilities.allowed('wechatSi')) {
    if (h.onError) h.onError('当前仅本地模式或方言识别未启用，请改用文字输入')
    if (h.onEnd) h.onEnd()
    return
  }
  const plugin = _wechatSI()
  if (!plugin || typeof plugin.getRecordRecognitionManager !== 'function') {
    if (h.onError) h.onError('当前微信版本不支持端侧粤语识别，请改用文字输入')
    if (h.onEnd) h.onEnd()
    return
  }
  const mgr = plugin.getRecordRecognitionManager()
  _siRec = mgr
  stoppedByUser = false

  mgr.onStart = () => { if (h.onStart) h.onStart() }
  mgr.onRecognize = () => { if (h.onRecognizing) h.onRecognizing() }
  mgr.onStop = (res) => {
    _siRec = null
    const text = String((res && res.result) || '').trim()
    if (text) {
      if (h.onResult) h.onResult(text, { engine: 'wechat_si', locale })
    } else {
      if (h.onError) h.onError('没有听清，请再说一次或改用文字输入')
    }
    if (h.onEnd) h.onEnd()
  }
  mgr.onError = (err) => {
    _siRec = null
    console.warn('[speech] 端侧识别失败：' + JSON.stringify(err || {}))
    if (h.onError) h.onError('端侧语音识别暂不可用，请改用文字输入')
    if (h.onEnd) h.onEnd()
  }

  try {
    mgr.start({ lang: locale === 'zh-HK' ? 'zh_HK' : 'zh_CN', duration: 60000 })
  } catch (e) {
    _siRec = null
    if (h.onError) h.onError('端侧语音识别启动失败，请改用文字输入')
    if (h.onEnd) h.onEnd()
    return
  }
  setTimeout(() => { if (!stoppedByUser) stopRecord() }, 60000)
}

function checkAuth() {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.record'] === false) {
          wx.showModal({
            title: '需要麦克风权限',
            content: '语音输入需要麦克风权限，请在设置中开启。',
            confirmText: '去设置',
            success: (r) => {
              if (r.confirm) {
                wx.openSetting({
                  success: (s) => {
                    if (s.authSetting['scope.record']) resolve()
                    else reject(new Error('未获得麦克风权限'))
                  },
                  // openSetting 也可能失败（如非用户手势触发）→ 同样收口为「未获得权限」；
                  // 否则该 fail 会被框架原样打到控制台（表现为 [object Object]）
                  fail: () => reject(new Error('未获得麦克风权限'))
                })
              } else { reject(new Error('未获得麦克风权限')) }
            }
          })
        } else { resolve() }
      },
      fail: () => resolve()
    })
  })
}

function startRecord(handlers, opts) {
  const h = handlers || {}
  const o = opts || {}
  // locale 路由：粤语音色/显式 zh-HK → 端侧 WechatSI；其余保留服务端本地 FunASR。
  const locale = o.locale || voiceLocale(currentVoice())
  // 平台隐私授权先于录音权限：录音属"收集个人信息"，未同意《隐私保护指引》不得采集。
  // 拒绝时只让本次语音输入退回文字，不阻断页面。
  ensurePrivacy().then((allowed) => {
    if (!allowed) {
      if (h.onError) h.onError('需同意《隐私保护指引》后才能使用语音输入，请改用文字输入')
      if (h.onEnd) h.onEnd()
      return null
    }
    return checkAuth()
  }).then((gate) => {
    if (gate === null) return  // 隐私未授权，回调已发出
    if (_isWechatSILocale(locale)) {
      _startWechatSIRecord(h, locale)
      return
    }
    const rm = _ensureRecorder()
    stoppedByUser = false

    rm.onStart(() => { if (h.onStart) h.onStart() })

    rm.onStop((res) => {
      const duration = res.duration || 0
      if (duration < 1000) {
        if (h.onError) h.onError('录音时间太短，请再说一次')
        if (h.onEnd) h.onEnd()
        return
      }
      if (h.onRecognizing) h.onRecognizing()
      // 上传 ASR：契约 POST /api/v1/voice/asr（multipart，name=audio）
      //  - 契约 Header `Idempotency-Key` 为 required:true（旧实现只传 multipart 字段 → 恒 400）
      //  - 该路径是受保护接口：Authorization 与平台/版本头由 request.uploadFile 统一附加（旧实现都没有 → 401）
      //  - 响应已按契约信封脱壳，data 即 AsrResultData（transcript/language/requiresConfirmation…），
      //    故不再需要旧的"递归深搜猜文本"兼容层
      req.uploadFile(
        API.VOICE_ASR,
        res.tempFilePath,
        'audio',
        null,
        { timeout: ENV.aiTimeout || 60000, idempotencyKey: req.newIdempotencyKey() }
      ).then((data) => {
        const d = data || {}
        const text = d.transcript || d.text || ''
        if (text) {
          if (h.onResult) h.onResult(text)
        } else {
          if (h.onError) h.onError('没有听清，请再说一次或改用文字输入')
        }
        if (h.onEnd) h.onEnd()
      }).catch((err) => {
        // 用户文案走 errText：已知 code 给确定中文，纯英文/含状态码的原文一律不展示
        if (h.onError) h.onError(errText(err, '语音识别失败，请改用文字输入'))
        if (h.onEnd) h.onEnd()
      })
    })

    rm.onError((err) => {
      if (h.onError) h.onError((err && err.errMsg) || '录音失败')
      if (h.onEnd) h.onEnd()
    })

    rm.start({ duration: 60000, format: 'mp3', sampleRate: 16000, numberOfChannels: 1 })
    setTimeout(() => { if (!stoppedByUser) stopRecord() }, 60000)
  }).catch((err) => {
    if (h.onError) h.onError(err.message || '无法开始录音')
    if (h.onEnd) h.onEnd()
  })
}

function stopRecord() {
  stoppedByUser = true
  if (_siRec) {
    try { _siRec.stop() } catch (e) {}
    return
  }
  if (recorder) { try { recorder.stop() } catch (e) {} }
}

module.exports = {
  // TTS
  speak, synthesize, speakUrl, prefetch, playArrayBuffer, stopSpeak,
  currentVoice, setCurrentVoice,
  currentRate, setCurrentRate,
  voiceReadEnabled, setVoiceRead,
  // 音频地址 → 网关路径（voice.js 试听复用）
  pathOf,
  // ASR
  startRecord, stopRecord, checkAuth,
  // 音色 → locale（页面/调试可复用）
  voiceLocale
}
