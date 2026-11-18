/*
 * voice-settings.test.js —— 音色切换 / 语速调节回归（2026-11-17）
 *
 * 两个真实缺陷：
 *   ① AI_TTS_VOICE_MAP 为空时，qwen3-female-1 与 qwen3-male-1 都回落同一个
 *      zh-CN-XiaoxiaoNeural，患者端切换听不出区别；
 *   ② 后端把 rate 用进了缓存键却没下发给 edge-tts，语速滑块怎么拖音频都一样。
 * 这里用静态断言把“必须有内置音色兜底”和“客户端播放倍速”钉住，
 * 避免以后又把两段逻辑删回去。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

function read(...parts) {
  return fs.readFileSync(path.resolve(__dirname, '..', ...parts), 'utf8')
}

test('音色切换：内置男女音色必须映射到不同引擎音色，不能再一起回落默认女声', () => {
  const py = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'ai-service', 'app', 'voice.py'), 'utf8')
  assert.ok(py.includes('EDGE_BUILTIN_VOICES'), '缺少内置音色兜底映射')
  assert.ok(py.includes('qwen3-female-1') && py.includes('zh-CN-XiaoxiaoNeural'))
  assert.ok(py.includes('qwen3-male-1') && py.includes('zh-CN-YunxiNeural'))
})

test('语速调节：播放层读取 rate 并设置 playbackRate，滑块事件不能是空操作', () => {
  const speech = read('services', 'speech.js')
  assert.ok(speech.includes('playbackRate'), '播放层没有应用播放倍速')
  assert.ok(speech.includes('o.rate !== undefined'), '播放层没有读取调用方传入的 rate')

  const wxml = read('pages', 'profile', 'voice-settings', 'voice-settings.wxml')
  assert.ok(wxml.includes('catchtouchmove="onSpeedTouch"'), '滑块拖动事件没有绑定到 onSpeedTouch')
  assert.ok(!wxml.includes('catchtouchmove="noop"'), '滑块仍被空操作拦截')
})

test('语音取消：stopSpeak 递增播报代次，离场页面必须在 onHide/onUnload 停止', () => {
  const speech = read('services', 'speech.js')
  assert.ok(speech.includes('_playSeq += 1'), 'stopSpeak 没有让在飞行的播报失效')
  assert.ok(speech.includes('function _isCurrentPlay'), '缺少播报代次校验')
  assert.ok(speech.includes('_isCurrentPlay(o.token)'), 'playArrayBuffer 没有校验代次')

  const pages = [
    ['pages', 'consultation', 'consultation.js'],
    ['pages', 'health', 'health.js'],
    ['pages', 'triage', 'triage.js'],
    ['pages', 'consult', 'consult.js'],
    ['pages', 'profile', 'voice-settings', 'voice-settings.js']
  ]
  for (const parts of pages) {
    const js = read(...parts)
    assert.ok(js.includes('stopSpeak()'), parts.join('/') + ' 缺少 stopSpeak')
  }
  const speechPages = [
    ['pages', 'consultation', 'consultation.js'],
    ['pages', 'health', 'health.js'],
    ['pages', 'triage', 'triage.js']
  ]
  for (const parts of speechPages) {
    const js = read(...parts)
    assert.ok(js.includes('_pageVisible = false'), parts.join('/') + ' 缺少离场状态标记')
    assert.ok(js.includes('_pageVisible === false'), parts.join('/') + ' 缺少迟到播报拦截')
  }
})

test('高频句预加载：前端有 prefetch，首屏问候与后端预生成清单对齐', () => {
  const speech = read('services', 'speech.js')
  assert.ok(speech.includes('function prefetch'), '缺少前端音频预取能力')

  const consultation = read('pages', 'consultation', 'consultation.js')
  const triage = read('pages', 'triage', 'triage.js')
  const health = read('pages', 'health', 'health.js')
  assert.ok(consultation.includes('speechService.prefetch('), '问诊页没有预取首句')
  assert.ok(triage.includes('speechService.prefetch('), '导诊页没有预取首句')
  assert.ok(health.includes('speechService.prefetch('), '养生页没有预取首句')

  const json = read('..', 'backend', 'ai-service', 'config', 'tts-pregen-phrases.json')
  assert.ok(json.includes('consult-greeting') && json.includes('triage-greeting') && json.includes('health-greeting'))
  assert.ok(!json.includes('{科室}'), '预生成清单仍含无法命中的占位符模板')

  const mainPy = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'ai-service', 'app', 'main.py'), 'utf8')
  assert.ok(mainPy.includes('EDGE_BUILTIN_VOICES'), '后端预生成没有覆盖可选音色')
  const configPy = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'ai-service', 'app', 'config.py'), 'utf8')
  assert.ok(configPy.includes('AI_TTS_PREGEN_ENABLED", "true"'), '预生成默认未开启')
})
