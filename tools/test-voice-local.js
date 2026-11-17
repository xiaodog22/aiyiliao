/**
 * tools/test-voice-local.js —— 「音色管理」目录/存储服务的行为自测
 *
 * 背景：pages/profile/voice-settings 的目录已改为**远端优先 + 本地兜底**
 * （GET /api/v1/voice/voices 成功即以远端为唯一可见列表；失败才用本地 CATALOG）。
 * 这里钉死本地这一层：内置项与后端同 id、无方言音色、save/remove/restore 语义，
 * 以及旧版 preset_* 残留数据（悬浮 storage id / hidden 记录）不会把列表撑大。
 *
 * 用法：node tools/test-voice-local.js
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

console.log('① 首次进入：目录 2 项，id 与后端内置音色一致，默认落到第一个')
const c0 = voice.catalog()
eq('行数', c0.rows.length, 2)
eq('id 顺序', c0.rows.map((r) => r.id), ['qwen3-female-1', 'qwen3-male-1'])
eq('名称顺序', c0.rows.map((r) => r.name), ['温柔女声', '沉稳男声'])
eq('当前音色', c0.current, 'qwen3-female-1')
eq('当前音色名', c0.currentName, '温柔女声')
eq('已删除数', c0.hiddenCount, 0)
eq('wb_voice 已写入', store['wb_voice'], 'qwen3-female-1')
eq('无自定义/方言音色', c0.rows.filter((r) => r.custom).length, 0)
eq('目录不含潮汕话', c0.rows.some((r) => (r.name + r.desc).indexOf('潮汕') >= 0), false)

voice.save({ voiceId: 'qwen3-male-1', rate: 1.2 })
  .then(() => {
    console.log('② save：音色 + 语速一起落本地')
    eq('wb_voice', store['wb_voice'], 'qwen3-male-1')
    eq('wb_voice_rate', store['wb_voice_rate'], 1.2)
    eq('目录当前项', voice.catalog().current, 'qwen3-male-1')

    console.log('③ 非法音色 id 被拒绝（不写脏数据）')
    return voice.save({ voiceId: 'nope' })
  })
  .catch((e) => {
    eq('拒绝码', e.code, 'NOT_FOUND')
    eq('wb_voice 未被改坏', store['wb_voice'], 'qwen3-male-1')

    console.log('④ 内置音色不可删')
    return voice.remove('qwen3-female-1')
  })
  .catch((e) => {
    eq('拒绝码', e.code, 'FORBIDDEN')

    console.log('⑤ 旧版 preset_* 残留：悬浮 id 自愈 + 隐藏记录不计数')
    store['wb_voice'] = 'preset_gentle'          // 老版本写入的 id
    store['wb_voice_hidden'] = ['preset_chaoshan'] // 老版本删过潮汕话
    const after = voice.catalog()
    eq('回落到内置首项', after.current, 'qwen3-female-1')
    eq('wb_voice 已重写', store['wb_voice'], 'qwen3-female-1')
    eq('旧隐藏记录不计数（底部不空挂恢复入口）', after.hiddenCount, 0)
    eq('旧 id 不混进列表', after.rows.map((r) => r.id), ['qwen3-female-1', 'qwen3-male-1'])
    eq('wb_voice_hidden 仍保留原记录（不擅自清用户数据）', store['wb_voice_hidden'], ['preset_chaoshan'])

    console.log('⑥ restore：恢复默认音色列表')
    return voice.restore()
  })
  .then((r) => {
    eq('恢复后行数', r.rows.length, 2)
    eq('恢复后 hiddenCount', r.hiddenCount, 0)

    console.log('⑦ list()（pages/profile/settings.js 的兼容形状）')
    return voice.list()
  })
  .then((res) => {
    // 本地兜底目录全为内置项 → 只剩「内置音色」一组（自定义组为空时被过滤）
    eq('groups 数量', res.groups.length, 1)
    eq('第一组 label', res.groups[0].label, '内置音色')
    eq('第一组项数', res.groups[0].items.length, 2)
    eq('defaultVoice', res.defaultVoice, 'qwen3-female-1')

    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
    process.exit(fail ? 1 : 0)
  })
  .catch((e) => {
    console.error('未预期异常：', e)
    process.exit(1)
  })
