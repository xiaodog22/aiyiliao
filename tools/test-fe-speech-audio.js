/**
 * tools/test-fe-speech-audio.js —— services/speech.js 播放器监听 / 临时文件回收回归
 *
 * 背景（2026-11-20 兼容性排查）：
 *   ① InnerAudioContext 的 onEnded/onError/onCanplay 是"追加监听"语义。原实现每次播放都 on 一遍、
 *      从不 off，长会话下回调线性堆叠（旧 Promise 也永不 settle）。本测试钉死"反复播报后每类监听
 *      仍只有 1 个"。
 *   ② 每次播报往 USER_DATA_PATH 写一个 tts_*.wav，原实现只写不删，目录持续膨胀直到 配额写失败
 *      （TTS 静默变哑）。本测试钉死"写新文件前删掉上一份"。
 *   ③ 老基础库（< 2.2.1）没有 off* 方法，必须保持"只 on 不 off"的旧行为，不能因为解绑不可用而崩。
 *
 * 运行：node tools/test-fe-speech-audio.js
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')

const SPEECH_PATH = path.join(__dirname, '..', 'miniprogram', 'services', 'speech.js')

/**
 * 造一个可观测的 wx 桩：音频上下文记录每次监听注册/解绑，文件系统记录写入/删除。
 * @param {{legacy?: boolean}} [opts] legacy=true 模拟老基础库（不提供 off* 方法）
 */
function makeWx(opts) {
  const o = opts || {}
  const state = {
    ended: [],
    error: [],
    canplay: [],
    writes: [],
    unlinks: [],
    playCount: 0,
    stopCount: 0
  }

  const audio = {
    obeyMuteSwitch: true,
    autoplay: false,
    src: '',
    playbackRate: 1,
    play() { state.playCount += 1 },
    stop() { state.stopCount += 1 },
    onEnded(fn) { state.ended.push(fn) },
    onError(fn) { state.error.push(fn) },
    onCanplay(fn) { state.canplay.push(fn) }
  }
  // 老基础库没有 off*：不给这两个方法，源码必须靠 typeof 守卫活下来
  if (!o.legacy) {
    audio.offEnded = (fn) => { state.ended = state.ended.filter((x) => x !== fn) }
    audio.offError = (fn) => { state.error = state.error.filter((x) => x !== fn) }
    audio.offCanplay = (fn) => { state.canplay = state.canplay.filter((x) => x !== fn) }
  }

  return {
    state,
    wx: {
      env: { USER_DATA_PATH: '/tmp' },
      createInnerAudioContext: () => audio,
      getFileSystemManager: () => ({
        writeFile(req) {
          state.writes.push(req.filePath)
          queueMicrotask(() => { req.success && req.success() })
        },
        unlink(req) {
          state.unlinks.push(req.filePath)
          queueMicrotask(() => { req.success && req.success() })
        }
      }),
      getStorageSync: () => '',
      setStorageSync: () => {}
    }
  }
}

/** 重新加载 speech.js（切掉 require 缓存，保证模块级单例状态从零开始） */
function loadSpeech(stub) {
  global.wx = stub.wx
  delete require.cache[require.resolve(SPEECH_PATH)]
  return require(SPEECH_PATH)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('反复播报：每类监听始终只有 1 个（不叠加）', async () => {
  const stub = makeWx()
  const speech = loadSpeech(stub)

  const first = speech.playArrayBuffer(new Uint8Array([1, 2, 3]))
  await flush()
  assert.equal(stub.state.ended.length, 1, '首次播放应注册 1 个 ended 监听')
  assert.equal(stub.state.canplay.length, 1, '首次播放应注册 1 个 canplay 监听')

  // 第二次播报：先解绑上一轮，再注册本轮
  const second = speech.playArrayBuffer(new Uint8Array([4, 5, 6]))
  await flush()
  assert.equal(stub.state.ended.length, 1, '第二次播放后 ended 监听仍应是 1 个，不能堆叠')
  assert.equal(stub.state.error.length, 1, '第二次播放后 error 监听仍应是 1 个')
  assert.equal(stub.state.canplay.length, 1, '第二次播放后 canplay 监听仍应是 1 个')

  // 只有"当前这一轮"的回调能结算：触发 ended 只应结算第二次
  stub.state.ended[0]()
  assert.equal(await second, true, '当前播报应 resolve(true)')
  first.catch(() => {})   // 被新播报接管的旧 Promise 允许悬挂（页面回调已被 token 拦下）
})

test('临时音频回收：写新文件前删掉上一份', async () => {
  const stub = makeWx()
  const speech = loadSpeech(stub)

  speech.playArrayBuffer(new Uint8Array([7, 8, 9]))
  await flush()
  assert.equal(stub.state.writes.length, 1, '首次播放应写 1 个临时文件')

  speech.playArrayBuffer(new Uint8Array([9, 8, 7]))
  await flush()
  assert.equal(stub.state.writes.length, 2, '第二次播放应写第 2 个临时文件')
  assert.equal(stub.state.unlinks.length, 1, '第二次播放前应回收第 1 份临时文件')
  assert.equal(stub.state.unlinks[0], stub.state.writes[0], '被回收的应是第一份文件的路径，不是新文件')
})

test('老基础库无 off*：不崩，保持旧行为', async () => {
  const stub = makeWx({ legacy: true })
  const speech = loadSpeech(stub)

  speech.playArrayBuffer(new Uint8Array([1, 2, 3]))
  await flush()
  speech.playArrayBuffer(new Uint8Array([4, 5, 6]))
  await flush()

  assert.equal(stub.state.ended.length, 2, '无 off* 时按旧行为追加监听（不抛错即可）')
  assert.ok(stub.state.playCount > 0, '播放仍应发起')
})
