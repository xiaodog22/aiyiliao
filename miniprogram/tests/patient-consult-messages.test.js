const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

/**
 * 患者端回归锁（2026-11-17）：
 * 1) 「不指定医生」不能回退到历史会话（尤其旧 AI 问诊）；
 * 2) 随机匹配必须带 doctorId，落到真实在线问诊；
 * 3) 患者消息中心必须注册，且入口/未读数/标已读都接真实服务。
 */
const ROOT = path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')

const consult = read('pages', 'consult', 'consult.js')
const picker = read('pages', 'consult', 'picker', 'picker.js')
const appJson = JSON.parse(read('app.json'))
const profileJs = read('pages', 'profile', 'profile.js')
const profileWxml = read('pages', 'profile', 'profile.wxml')
const msgJs = read('pages', 'profile', 'messages', 'messages.js')
const msgWxml = read('pages', 'profile', 'messages', 'messages.wxml')
const doctorSvc = read('services', 'doctor.js')
const scheduleJs = read('pages', 'doctor', 'schedule', 'schedule.js')
const scheduleWxml = read('pages', 'doctor', 'schedule', 'schedule.wxml')

test('consult.js：无会话且无指定医生时保持空态，不自动选历史会话', () => {
  const start = consult.indexOf('if (!id) {')
  const end = consult.indexOf('const first = this._fetchDetail(id)')
  assert.ok(start > 0 && end > start, '未找到无会话分支')
  const noIdBlock = consult.slice(start, end)
  assert.ok(noIdBlock.includes('hasDoctor: false'), '空态未显式关闭医生卡')
  assert.ok(noIdBlock.includes('请选择医生发起在线问诊'), '空态缺少选医引导')
  assert.strictEqual(noIdBlock.includes('_fetchList'), false, '无会话分支不得回退历史列表')
})

test('consult.js：列表兜底只认当前会话 id，不再取第一个 ACTIVE', () => {
  assert.strictEqual(consult.includes("c.status === 'ACTIVE'"), false, '不得用 ACTIVE 会话顶替当前会话')
  assert.ok(consult.includes('arr.find((c) => c.id === this.data.activeId)'), '缺少按当前 id 精确匹配')
})

test('picker.js：不指定医生 → 随机匹配在线医生并带 doctorId 进入', () => {
  assert.ok(picker.includes('available === true'), '缺少在线医生优先池')
  assert.ok(picker.includes('available !== false'), '缺少排除已知离线医生')
  assert.ok(picker.includes('_gotoConsult(pick)'), '匹配后未进入真实问诊')
  assert.ok(picker.includes("'doctorId=' + encodeURIComponent(d.id)"), '跳转未携带 doctorId')
  assert.strictEqual(picker.includes("wx.navigateTo({ url: '/pages/consult/consult' })"), false, '不得再进入无 doctorId 的旧路径')
})

test('患者消息中心：已注册页面，入口/未读数/标已读接真实服务', () => {
  assert.ok(appJson.pages.includes('pages/profile/messages/messages'), 'app.json 未注册患者消息页')
  assert.ok(profileWxml.includes('bindtap="goMessages"'), '我的页缺少消息入口')
  assert.ok(profileWxml.includes('msgUnread'), '我的页缺少未读红点绑定')
  assert.ok(profileJs.includes('userService.unreadCount()'), '我的页未拉真实未读数')
  assert.ok(msgJs.includes('userService.listMessages()'), '消息页未拉真实列表')
  assert.ok(msgJs.includes('userService.markMessageRead('), '消息页未写回已读状态')
  assert.ok(msgWxml.includes('<offline-bar />'), '消息页缺少离线提示')
})

test('医生排班与在线接诊状态一致：开关未开必须显式提示，状态查询不吃旧缓存', () => {
  assert.ok(doctorSvc.includes('withPath(API.DOCTOR_AVAILABILITY'), 'availability 路径 {id} 必须做替换')
  assert.ok(doctorSvc.includes('cacheTtl: 0'), 'availability 不能使用 15s GET 缓存')
  assert.ok(scheduleWxml.includes('!online && weekSlots > 0'), '缺少“有排班但未开接诊”提示')
  assert.ok(scheduleJs.includes('onEnableOnline'), '缺少一键开启接诊入口')
  assert.ok(scheduleJs.includes('当前「在线接诊」未开启'), '保存排班后未提示在线开关矛盾')
})
