/**
 * tools/test-voice-local.js —— 「音色管理」本地存储服务的行为自测
 *
 * 背景：第 23 页（pages/profile/voice-settings）本轮改为**纯本地**（无后端接口，
 * 因为 business-service 至今没有 voice 路由），音色目录 / 选中音色 / 语速 / 删除记录
 * 全在 services/voice.js + storage 里。这层逻辑没有网络可依赖，最适合用桩测死。
 *
 * 用法：node tools/test-voice-local.js
 * 覆盖：目录顺序与默认项 · save 落本地 · 非法 id 拒绝 · 自定义可删/内置不可删 ·
 *       当前音色被删后回落 · restore 恢复 · list() 的 settings.js 兼容形状
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')

// 最小 wx 桩：只用 storage + speech 依赖的空音频上下文
const store = {}
global.wx = {
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v },
  createInnerAudioContext: () => ({
    stop() {}, play() {}, onEnded() {}, onError() {}, onCanplay() {}
  }),
  getFileSystemManager: () => ({ writeFile() {} }),
  env: { USER_DATA_PATH: '/tmp' }
}

const voice = require(path.join(MP, 'services/voice.js'))

let pass = 0
let fail = 0
function eq(label, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) { pass++; console.log('  ✓ ' + label) } else { fail++; console.log('  ✗ ' + label + ' → ' + g + ' ≠ ' + w) }
}

console.log('① 首次进入：目录 4 项，默认落到第一个')
const c0 = voice.catalog()
eq('行数', c0.rows.length, 4)
eq('名称顺序', c0.rows.map((r) => r.name), ['温柔女声', '专业男声', '亲切女声', '潮汕话女声'])
eq('当前音色', c0.current, 'preset_gentle')
eq('当前音色名', c0.currentName, '温柔女声')
eq('已删除数', c0.hiddenCount, 0)
eq('wb_voice 已写入', store['wb_voice'], 'preset_gentle')
eq('可删除项只有潮汕话', c0.rows.filter((r) => r.custom).map((r) => r.name), ['潮汕话女声'])

voice.save({ voiceId: 'preset_pro', rate: 1.2 })
  .then(() => {
    console.log('② save：音色 + 语速一起落本地')
    eq('wb_voice', store['wb_voice'], 'preset_pro')
    eq('wb_voice_rate', store['wb_voice_rate'], 1.2)
    eq('目录当前项', voice.catalog().current, 'preset_pro')

    console.log('③ 非法音色 id 被拒绝（不写脏数据）')
    return voice.save({ voiceId: 'nope' })
  })
  .catch((e) => {
    eq('拒绝码', e.code, 'NOT_FOUND')
    eq('wb_voice 未被改坏', store['wb_voice'], 'preset_pro')

    console.log('④ 删除自定义音色 → 隐藏并持久化')
    return voice.remove('preset_chaoshan')
  })
  .then(() => {
    eq('剩余行数', voice.catalog().rows.length, 3)
    eq('已删除数', voice.catalog().hiddenCount, 1)
    eq('hidden 已落盘', store['wb_voice_hidden'], ['preset_chaoshan'])

    console.log('⑤ 内置音色不可删')
    return voice.remove('preset_warm')
  })
  .catch((e) => {
    eq('拒绝码', e.code, 'FORBIDDEN')

    console.log('⑥ 当前音色被删 → 回落第一个可用并重写 wb_voice')
    store['wb_voice'] = 'preset_chaoshan'
    const after = voice.catalog()
    eq('回落到内置首项', after.current, 'preset_gentle')
    eq('wb_voice 已重写', store['wb_voice'], 'preset_gentle')

    console.log('⑦ restore：恢复默认音色列表')
    return voice.restore()
  })
  .then((r) => {
    eq('恢复后行数', r.rows.length, 4)
    eq('恢复后 hidden', r.hiddenCount, 0)

    console.log('⑧ list()（pages/profile/settings.js 的兼容形状）')
    return voice.list()
  })
  .then((res) => {
    eq('groups 数量', res.groups.length, 2)
    eq('第一组 label', res.groups[0].label, '内置音色')
    eq('第二组 label', res.groups[1].label, '自定义音色')
    eq('自定义组首项名', res.groups[1].items[0].name, '潮汕话女声')
    eq('defaultVoice', res.defaultVoice, 'preset_gentle')

    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
    process.exit(fail ? 1 : 0)
  })
  .catch((e) => {
    console.error('未预期异常：', e)
    process.exit(1)
  })
