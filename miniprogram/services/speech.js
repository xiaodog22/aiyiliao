/**
 * speech.js —— 语音服务（V1.7 统一网关版 · Qwen3-TTS）
 *
 * 模块 1：ASR —— 录音 → 上传 /api/v1/voice/asr（wx.getRecorderManager）
 * 模块 2：TTS —— 文本 → /api/v1/voice/tts（multipart，Qwen3-TTS）→ 写临时文件 → InnerAudioContext
 *
 * ⚠️ 相对旧版的三个必改点（对照《前端适配说明》§5）：
 *   1. **格式由 MP3 换为 WAV**（本地模型直接出 WAV，项目无 mp3 编码器）；
 *      前端不再写死 .mp3，播放前按文件头（RIFF）判定后缀。
 *   2. 新增 `voice` 参数（音色 id，如 preset_gentle），见 §6 音色对照表。
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
const { errText } = require('../utils/err-text.js')
const API = req.API

const VOICE_STORAGE_KEY = 'wb_voice'
const VOICE_READ_KEY = 'wb_voice_read'
const RATE_STORAGE_KEY = 'wb_voice_rate'
const RATE_MIN = 0.5
const RATE_MAX = 2.0
const MAX_TTS_CHARS = 500

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

function _getAudio() {
  if (!_audio) {
    _audio = wx.createInnerAudioContext()
    _audio.obeyMuteSwitch = false   // 静音键不拦播报（否则 iOS 上会"点了没声"）
    _audio.autoplay = true
  }
  return _audio
}

function stopSpeak() {
  if (_audio) {
    try { _audio.stop() } catch (e) {}
  }
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

/**
 * 播放一段音频二进制（ArrayBuffer / base64 字符串）
 * @param {ArrayBuffer|string} data
 * @param {{onStart?:Function,onEnd?:Function,onError?:Function}} [opts]
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

    stopSpeak()
    const audio = _getAudio()
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
        let done = false
        const finish = (ok) => {
          if (done) return
          done = true
          if (o.onEnd) o.onEnd()
          resolve(ok)
        }
        audio.onEnded(() => finish(true))
        audio.onError((e) => {
          console.warn('[speech] 音频播放出错，已跳过（不影响主流程）' + JSON.stringify(e || {}))
          if (o.onError) o.onError('音频播放失败')
          finish(false)
        })
        // ⚠️ 只赋值 src 后立刻 play()，在部分机型上是空操作（资源尚未就绪）。
        //    所以：赋值后**立即试播一次**，并在 onCanplay 里**再播一次**（重复调用幂等）。
        audio.onCanplay(() => { try { audio.play() } catch (e) {} })
        audio.src = tmpPath
        try { audio.play() } catch (e) {}
      },
      fail: (e) => {
        console.warn('[speech] 音频写入失败，已跳过（不影响主流程）' + JSON.stringify(e || {}))
        if (o.onError) o.onError('音频播放失败')
        if (o.onEnd) o.onEnd()
        resolve(false)
      }
    })
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
  const body = { text: slice, format: 'mp3', rate: o.rate || currentRate() }
  if (voice) body.voiceId = voice

  return req.post(API.VOICE_TTS, body, {
    timeout: ENV.ttsTimeout,
    idempotencyKey: req.newIdempotencyKey()
  }).then(_normalize)
}

/**
 * 文本转语音并播放（永不 reject）
 * @param {string} text
 * @param {Object} opts { voice, onStart, onEnd, onError, onDegraded, onMeta }
 * @returns {Promise<boolean>} 是否成功开始播放
 */
function speak(text, opts) {
  const o = opts || {}
  const t = String(text || '').trim()
  if (!t) {
    if (o.onError) o.onError('空文本')
    return Promise.resolve(false)
  }
  // onStart 由 playArrayBuffer 在真正开始播放时回调（合成失败不误报"播放中"）

  return synthesize(t, o).then((r) => {
    if (o.onMeta) o.onMeta(r.meta)
    // 降级提示：engine=placeholder / degraded=true → 占位音质（仍有声音，照常播放）
    if (o.onDegraded && (r.meta.degraded || r.meta.engine === 'placeholder')) {
      o.onDegraded(r.meta)
    }
    return playArrayBuffer(r.buf, o)
  }).catch((err) => {
    const code = err && err.code
    const msg = code === 'EMPTY_AUDIO' || code === 'PARSE_ERROR'
      ? '语音合成失败，请稍后重试'
      : (code === 'TIMEOUT' ? '语音合成超时，请稍后重试' : '语音服务暂不可用')
    console.warn('[speech] TTS 失败（' + code + '）：' + (err && err.message))
    if (o.onError) o.onError(msg)
    if (o.onEnd) o.onEnd()
    return false
  })
}

/**
 * 播放网关会话生成的语音（SSE `tts` 事件给的是 /api/gw/audio/{token}）
 * @param {string} urlOrPath 绝对地址或以 / 开头的网关路径
 * @param {Object} opts { onStart, onEnd, onError }
 * @returns {Promise<boolean>}
 */
function speakUrl(urlOrPath, opts) {
  const o = opts || {}
  const p = String(urlOrPath || '').trim()
  if (!p) {
    if (o.onError) o.onError('语音地址为空')
    return Promise.resolve(false)
  }
  // 统一取路径部分（复用 pathOf）：绝对地址只保留 path，避免拼成"网关+完整URL"
  const path = pathOf(p)
  if (!path) {
    if (o.onError) o.onError('语音地址无效')
    return Promise.resolve(false)
  }
  const spec = { base: 'gateway', path }
  return req.getBinary(spec, null, { timeout: ENV.ttsTimeout })
    .then((buf) => playArrayBuffer(buf, o))
    .catch((err) => {
      console.warn('[speech] 网关语音获取失败：' + (err && err.code))
      if (o.onError) o.onError(err && err.code === 'HTTP_ERROR' ? err.message : '语音播放失败')
      if (o.onEnd) o.onEnd()
      return false
    })
}

// ============ ASR（录音 → /api/v1/voice/asr）============
let recorder = null
let stoppedByUser = false

function _ensureRecorder() {
  if (!recorder) recorder = wx.getRecorderManager()
  return recorder
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

function startRecord(handlers) {
  const h = handlers || {}
  checkAuth().then(() => {
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
  if (recorder) { try { recorder.stop() } catch (e) {} }
}

module.exports = {
  // TTS
  speak, synthesize, speakUrl, playArrayBuffer, stopSpeak,
  currentVoice, setCurrentVoice,
  currentRate, setCurrentRate,
  voiceReadEnabled, setVoiceRead,
  // 音频地址 → 网关路径（voice.js 试听复用）
  pathOf,
  // ASR
  startRecord, stopRecord, checkAuth
}
