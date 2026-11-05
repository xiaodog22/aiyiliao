/**
 * tools/test-pages-contract.js —— 患者端五个「后端契约数据页」的映射冒烟测试
 *
 * 为什么需要（2026-10-17）：五个页面从"前端固定/演示数据"切到后端契约端点后，
 * 最容易翻车的不是请求本身，而是**字段映射**（enum → 中文、ISO Instant → 本地日期、
 * 可选字段留空不显示、块缺失 → 空态）。这类错误 node --check / 静态门禁全绿也照样漏。
 * 本文件用**真实后端实测抓取的响应形状**打桩，断言各页归一化后的展示数据。
 *
 * 覆盖：我的(profile/ME) · 首页(home/summary) · 健康档案(health-records) ·
 *       家庭成员(family-members) · 我的问诊(consultations)。
 * 运行：node tools/test-pages-contract.js
 */
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
let PASS = 0
let FAIL = 0
const fails = []

function check(name, ok, extra) {
  if (ok) { PASS++; return }
  FAIL++
  fails.push(name + (extra ? '  ← ' + extra : ''))
}

// ==================== 桩数据（形状取自 2026-10-17 真实后端实测）====================
const SCENARIO = { mode: 'normal' }   // normal | http500

const ME = {
  id: 'u-dev-user-1', displayName: '开发用户甲', profileCompleteness: 33,
  roles: ['PATIENT'], phoneBound: true, consents: [],
  createdAt: '2026-10-14T17:30:30.373Z', updatedAt: '2026-10-16T17:17:01.625Z'
}

const HOME_NO_APT = {
  greeting: '夜深了，注意休息',
  blocks: [
    { kind: 'QUICK_SERVICES', status: 'ok' },
    { kind: 'CONTENT_FEED', status: 'ok' }
  ]
}
const HOME_WITH_APT = {
  greeting: '下午好',
  blocks: [
    {
      kind: 'NEXT_APPOINTMENT', status: 'ok',
      nextAppointment: {
        id: 'ap-1', status: 'CONFIRMED', departmentName: '消化内科', doctorName: '林建平',
        patientName: '张建国', startTime: '2026-10-18T01:30:00Z',  // +08 → 2026-10-18 09:30
        endTime: '2026-10-18T02:00:00Z', location: '门诊楼 3 楼 302 诊室'
      }
    },
    { kind: 'QUICK_SERVICES', status: 'ok' }
  ]
}

const HEALTH_RECORDS = [
  { id: 'hr-1', category: 'VITALS', title: '血压记录', summary: '120/80', recordedAt: '2026-10-14T10:00:00Z', attachments: [], version: 1 },
  { id: 'hr-2', category: 'EXAM', title: '血常规检验报告', summary: '未见异常', recordedAt: '2026-10-13T00:00:00Z', attachments: [], version: 1 }
]

const FAMILY = [
  { id: 'fm-1', displayName: '李秀英', relation: 'MOTHER', proxyStatus: 'NONE' },
  { id: 'fm-2', displayName: '张伟', relation: '配偶', proxyStatus: 'GRANTED', ageBand: '30-39' }
]

const CONSULTATIONS = [
  { id: 'cn-1', title: '最近一周饭后胃胀，偶尔反酸，晚上睡不好', status: 'ACTIVE', lastMessageAt: '2026-10-15T12:57:48.298Z', messageCount: 2, createdAt: '2026-10-15T12:57:43.323Z' },
  { id: 'cn-2', title: '咳嗽两周带痰', status: 'CLOSED', summary: '已建议到呼吸内科就诊', createdAt: '2026-09-01T03:00:00Z' }
]

/* 问诊室（第 18 页）详情桩：形状取契约 Consultation + messages（getConsultation） */
const CONSULT_DETAIL = {
  id: 'cn-1', title: '咳嗽待查咨询', status: 'ACTIVE',
  doctorName: '陈医生', doctorTitle: '副主任医师', departmentName: '呼吸内科', accepting: true,
  lastMessageAt: '2026-10-15T01:33:00Z',
  messages: [
    { id: 'm1', role: 'system_notice', contentType: 'TEXT', content: '问诊已开始，您可以描述症状或上传检查报告', provenance: 'SYSTEM', createdAt: '2026-10-15T01:30:00Z' },
    { id: 'm2', role: 'user', contentType: 'TEXT', content: '医生您好，我咳嗽三天了', provenance: 'USER', createdAt: '2026-10-15T01:31:00Z' },
    { id: 'm3', role: 'user', contentType: 'IMAGE_NOTE', content: 'attachments/2026/10/a1b2c3.pdf', provenance: 'USER', createdAt: '2026-10-15T01:32:00Z' },
    { id: 'm4', role: 'assistant', contentType: 'TEXT', content: '建议先做血常规，暂不用抗生素。', provenance: 'AI', createdAt: '2026-10-15T01:33:00Z' },
    {
      id: 'm5', role: 'assistant', contentType: 'TEXT', content: '', provenance: 'AI', createdAt: '2026-10-15T01:34:00Z',
      structured: { kind: 'EXAM', title: '检查建议', items: [{ name: '血常规', dose: '今日' }, { name: '胸片', dose: '3 日内' }], note: '结果出具后请回传，以便复诊判断。' }
    }
  ]
}
const CONSULT_MESSAGES = CONSULT_DETAIL.messages

/* 医生端挂号管理（第 19 页）桩：契约 Appointment（status/queueNumber/startTime/version） */
// ⚠️ 日期动态生成：页面按「今天及未来」过滤（2026-10-24 口径），写死日期过几天就会
//    整体被过滤 → 队列断言全红（T7 的真实根因，不是页面缺陷）。
function isoToday(hour, minute) {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}
const TODAY_LABEL = (function () {
  const d = new Date()
  return (d.getMonth() + 1) + '月' + d.getDate() + '日'
})()
const DOCTOR_APPTS = [
  // 故意打乱顺序：服务端按 start_time 升序，页面要重排成「待就诊 → 就诊中 → 终端态」
  { id: 'ap-2', status: 'COMPLETED', patientName: '张**', queueNumber: 17, startTime: isoToday(9, 20), version: 3 },
  { id: 'ap-1', status: 'PENDING', patientName: '王**', queueNumber: 15, startTime: isoToday(9, 30), version: 1 },
  { id: 'ap-3', status: 'CHECKED_IN', patientName: '李**', queueNumber: 16, startTime: isoToday(9, 40), version: 2 }
]

/* 最近一次请求 URL（用于断言路径，如问诊详情/消息） */
let lastUrl = ''
/* 最近一次请求的 data（GET 的 query 参数由 wx.request 自动序列化到查询串） */
let lastData = null

// ==================== 打桩 ====================
const storage = {}
global.wx = {
  request(o) {
    lastUrl = String(o.url || '')
    lastData = o.data || null
    setTimeout(() => {
      if (SCENARIO.mode === 'http500') {
        o.success({ statusCode: 500, data: { message: 'Internal Server Error' } })
        return
      }
      const url = String(o.url || '')
      let data = null
      // 问诊室：详情（…/consultations/{id}）与消息（…/{id}/messages）必须先于列表匹配
      if (url.indexOf('/doctor/appointments') >= 0) {
        data = DOCTOR_APPTS
      } else if (/\/consultations\/[^/]+\/messages/.test(url)) {
        data = CONSULT_MESSAGES
      } else if (/\/consultations\/[^/]+$/.test(url)) {
        if (SCENARIO.consultDetail === 'off') { o.success({ statusCode: 501, data: { message: 'not implemented' } }); return }
        data = CONSULT_DETAIL
      } else if (url.indexOf('/api/v1/me') >= 0) data = ME
      else if (url.indexOf('/home/summary') >= 0) data = SCENARIO.home === 'noapt' ? HOME_NO_APT : HOME_WITH_APT
      else if (url.indexOf('/health-records') >= 0) data = HEALTH_RECORDS
      else if (url.indexOf('/family-members') >= 0) data = FAMILY
      else if (url.indexOf('/consultations') >= 0) data = CONSULTATIONS
      else data = []
      o.success({ statusCode: 200, data: { code: 'OK', data } })
    }, 0)
  },
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  showToast() {},
  showModal() {},
  showLoading() {},
  hideLoading() {},
  stopPullDownRefresh() {},
  reLaunch() {},
  navigateTo() {},
  switchTab() {},
  setNavigationBarTitle() {}
}

// 会话预置（受保护请求前置校验；access 只驻留内存 → 直接注入）
const session = require(path.join(ROOT, 'services', 'session.js'))
session.setTokens({ accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 7200 })

const MOCK = require(path.join(ROOT, 'utils', 'mock-data.js'))
const appStub = {
  globalData: {
    role: 'patient', theme: 'standard',
    user: { id: 'u-dev-user-1', name: '开发用户甲', phoneBound: true, roles: ['PATIENT'], role: 'patient' }
  },
  MOCK,
  setLogin() {}, logout() {}
}
global.getApp = () => appStub

let captured = null
function loadPage(rel) {
  captured = null
  global.Page = (c) => { captured = c }
  const abs = path.join(ROOT, rel)
  delete require.cache[require.resolve(abs)]
  require(abs)
  if (!captured) throw new Error('未捕获到 Page 配置：' + rel)
  return captured
}

function instantiate(cfg) {
  const inst = Object.assign({}, cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}))
  // 第二参按微信语义执行（页面常在 setData 回调里串联下一步；不支持会让链路静默断掉）
  inst.setData = (patch, cb) => {
    Object.keys(patch).forEach((k) => {
      const mm = /^([\w$]+)\.([\w$]+)$/.exec(k)
      if (mm) { inst.data[mm[1]] = inst.data[mm[1]] || {}; inst.data[mm[1]][mm[2]] = patch[k] }
      else inst.data[k] = patch[k]
    })
    if (typeof cb === 'function') cb()
  }
  return inst
}

/** 轮询等待条件成立（页面内部不返回 promise） */
function waitFor(fn, ms) {
  const limit = ms || 500
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (fn() || Date.now() - t0 > limit) resolve()
      else setTimeout(tick, 5)
    }
    tick()
  })
}

// ==================== 用例 ====================
async function testProfile() {
  const cfg = loadPage(path.join('pages', 'profile', 'profile.js'))
  const inst = instantiate(cfg)
  inst.onShow()
  await waitFor(() => inst.data.user && inst.data.user.name === '开发用户甲')

  check('[我的] 姓名取契约 displayName', inst.data.user.name === '开发用户甲', '实得 ' + inst.data.user.name)

  /* 2026-11 页面 6 复刻（设计稿 07 / §四.6）后，副标题口径改为「已登录 · 健康档案已同步」：
     · 手机号绑定态不再拼进这一行（改由个人信息页承载），/me 的 phoneBound 仍参与登录态判定；
     · 「健康档案已同步」由 /health-records 是否返回记录驱动（本桩返回 2 条 → 应出现）。 */
  await waitFor(() => inst.data.user.metaText === '已登录 · 健康档案已同步')
  check('[我的] 状态行 = 已登录 · 健康档案已同步（档案数据驱动）',
    inst.data.user.metaText === '已登录 · 健康档案已同步', '实得 ' + inst.data.user.metaText)
  check('[我的] 状态行不夹带手机号绑定态', inst.data.user.metaText.indexOf('手机号') < 0, '实得 ' + inst.data.user.metaText)

  /* 头像：无 avatarUrl 时不渲染 <image>（回落到 icons.userGray 的灰底占位），
     不再用姓名字形兜底（设计稿 07 的默认头像是灰色线性人形，不是文字）。 */
  check('[我的] 无头像时走占位（avatarUrl 为空串）', inst.data.user.avatarUrl === '', '实得 ' + JSON.stringify(inst.data.user.avatarUrl))

  /* 我的问诊未读点：由 /consultations 是否存在未结束会话驱动（桩里 cn-1 = ACTIVE） */
  await waitFor(() => inst.data.unread === true)
  check('[我的] 未读点=存在未结束问诊', inst.data.unread === true, '实得 ' + inst.data.unread)
}

async function testHome() {
  const cfg = loadPage(path.join('pages', 'home', 'home.js'))

  // 场景 A：后端明确"无待就诊预约"→ 空态（不塞演示数据）
  SCENARIO.home = 'noapt'
  const a = instantiate(cfg)
  a.onShow()
  await waitFor(() => a.data.home && a.data.home.greeting)
  check('[首页] greeting 来自后端', a.data.home.greeting === '夜深了，注意休息', '实得 ' + a.data.home.greeting)
  check('[首页] 无 NEXT_APPOINTMENT 块 → hasApt=false（空态）', a.data.hasApt === false, '实得 ' + a.data.hasApt)
  check('[首页] 空态时 aptDate=null', a.data.aptDate === null)

  // 场景 B：有预约 → 契约字段映射
  SCENARIO.home = 'withapt'
  const b = instantiate(cfg)
  b.onShow()
  await waitFor(() => b.data.hasApt === true)
  const apt = b.data.home.appointment || {}
  check('[首页] hasApt=true', b.data.hasApt === true)
  check('[首页] departmentName → dept', apt.dept === '消化内科', '实得 ' + JSON.stringify(apt.dept))
  check('[首页] doctorName → doctor', apt.doctor === '林建平', '实得 ' + JSON.stringify(apt.doctor))
  check('[首页] startTime → 本地日期 2026-10-18', apt.date === '2026-10-18', '实得 ' + apt.date)
  check('[首页] startTime → 本地时间 09:30', apt.time === '09:30', '实得 ' + apt.time)
  check('[首页] CONFIRMED → 「待就诊」', apt.status === '待就诊', '实得 ' + apt.status)
  check('[首页] location → place', apt.place === '门诊楼 3 楼 302 诊室', '实得 ' + apt.place)
  check('[首页] 日期徽章已解析（parseAptDate）', !!b.data.aptDate && b.data.aptDate.day === '18',
    '实得 ' + JSON.stringify(b.data.aptDate))
}

async function testHealthRecords() {
  SCENARIO.mode = 'normal'
  const cfg = loadPage(path.join('pages', 'profile', 'health-records', 'health-records.js'))
  const inst = instantiate(cfg)
  inst.onLoad()
  await waitFor(() => inst.data.loading === false)

  // 2026-10-17 版式改版（对齐设计稿 05）：分组卡片 → 平铺时间轴 + 顶部分类筛选
  const items = inst.data.items || []
  check('[档案] 平铺为 2 条记录（时间轴）', items.length === 2, '实得 ' + items.length)
  const cats = items.map((it) => it.category).join(',')
  check('[档案] VITALS/EXAM 已转中文类别', cats === '体征记录,检查检验', '实得 ' + cats)
  const filters = inst.data.filters || []
  check('[档案] 筛选条 = 全部 + 2 个实际类别', filters.length === 3 && filters[0].key === 'ALL',
    '实得 ' + filters.map((f) => f.label).join(','))
  const item = items[0] || {}
  check('[档案] title/summary 原样展示', item.title === '血压记录' && item.summary === '120/80',
    'title=' + item.title + ' summary=' + item.summary)
  check('[档案] recordedAt 已转本地日期（不含 T）', /^\d{4}-\d{2}-\d{2}$/.test(item.dateText || ''), '实得 ' + item.dateText)
  check('[档案] 视觉字段齐备（tint/icon 供徽章与底板）', !!item.tint && !!item.icon,
    'tint=' + item.tint + ' icon=' + item.icon)
  inst.onFilter({ currentTarget: { dataset: { key: '检查检验' } } })
  check('[档案] 点分类 chip 后只留该类 1 条', (inst.data.view || []).length === 1,
    '实得 ' + (inst.data.view || []).length)
  check('[档案] 不再渲染固定「基本信息」块（data.records 已移除）', inst.data.records === undefined)
}

async function testFamily() {
  const cfg = loadPage(path.join('pages', 'profile', 'family', 'family.js'))
  const inst = instantiate(cfg)
  inst.onLoad()
  await waitFor(() => inst.data.loading === false)

  const list = inst.data.members || []
  check('[家庭] 列表来自后端（2 条）', list.length === 2, '实得 ' + list.length)
  check('[家庭] MOTHER → 「母亲」', list[0] && list[0].relation === '母亲', '实得 ' + (list[0] && list[0].relation))
  check('[家庭] 中文关系原样保留（配偶）', list[1] && list[1].relation === '配偶', '实得 ' + (list[1] && list[1].relation))
  // 副行文案以设计稿 C-个人中心/08-家庭成员.png 为准：`60-70岁 · 已授权`（不是「已授权代管」）
  check('[家庭] proxyStatus NONE → 「未授权」', list[0] && list[0].metaText === '未授权', '实得 ' + (list[0] && list[0].metaText))
  check('[家庭] proxyStatus GRANTED + ageBand 组合文案',
    list[1] && list[1].metaText === '30-39 · 已授权', '实得 ' + (list[1] && list[1].metaText))

  // 添加浮层的必填校验（纯前端逻辑，不触网）：空姓名 → 提示；填了姓名但没选关系 → 提示
  inst.onAdd()
  inst.onSubmit()
  check('[家庭] 添加校验：空姓名 → 「请填写成员姓名」', inst.data.formErr === '请填写成员姓名', '实得 ' + inst.data.formErr)
  inst.onInputName({ detail: { value: '王老先生' } })
  inst.onSubmit()
  check('[家庭] 添加校验：未选关系 → 「请选择与本人的关系」',
    inst.data.formErr === '请选择与本人的关系', '实得 ' + inst.data.formErr)
}

async function testConsultations() {
  const cfg = loadPage(path.join('pages', 'profile', 'consultations', 'consultations.js'))
  const inst = instantiate(cfg)
  inst.onLoad()
  await waitFor(() => inst.data.loading === false)

  const list = inst.data.all || []
  check('[问诊] 列表来自后端（2 条）', list.length === 2, '实得 ' + list.length)
  check('[问诊] title 展示后端标题', list[0] && list[0].title.indexOf('饭后胃胀') >= 0, '实得 ' + (list[0] && list[0].title))
  // 文案与配色口径以设计稿 C-个人中心/07-我的问诊.png 为准：问诊中(蓝) / 已完成(薄荷) / 已结束(灰)
  check('[问诊] ACTIVE → 「问诊中」', list[0] && list[0].statusText === '问诊中', '实得 ' + (list[0] && list[0].statusText))
  check('[问诊] CLOSED → 「已完成」', list[1] && list[1].statusText === '已完成', '实得 ' + (list[1] && list[1].statusText))
  check('[问诊] 徽章配色档 ACTIVE=blue / CLOSED=mint',
    list[0] && list[0].tone === 'blue' && list[1] && list[1].tone === 'mint',
    '实得 ' + (list[0] && list[0].tone) + '/' + (list[1] && list[1].tone))
  check('[问诊] summary 缺失时退化为消息数', list[0] && list[0].brief === '共 2 条对话', '实得 ' + (list[0] && list[0].brief))
  // 设计稿日期行是「2026-10-15 14:30」（日期 + 本地时间），非纯日期
  check('[问诊] lastMessageAt 转本地「日期 时间」',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test((list[0] || {}).dateText || ''), '实得 ' + (list[0] && list[0].dateText))
}

async function testConsultRoom() {
  SCENARIO.mode = 'normal'
  SCENARIO.consultDetail = 'on'
  const cfg = loadPage(path.join('pages', 'consult', 'consult.js'))
  const inst = instantiate(cfg)

  /* ① 详情通道：医生卡四字段来自服务端（缺失才走占位，见 ② ） */
  inst.onLoad({ consultationId: 'cn-1' })
  await waitFor(() => inst.data.loading === false)
  await waitFor(() => (inst.data.messages || []).length > 0)
  check('[问诊室] doctorName 来自详情', inst.data.doctorName === '陈医生', '实得 ' + inst.data.doctorName)
  check('[问诊室] 科室拼成「呼吸内科 · 互联网医院」', inst.data.docSub === '呼吸内科 · 互联网医院', '实得 ' + inst.data.docSub)
  check('[问诊室] accepting=true → 接诊中', inst.data.accepting === true && inst.data.tipText.indexOf('正在查看') >= 0, '实得 ' + inst.data.tipText)

  /* ② 消息归一化：日期分隔只插 1 条、系统提示 → 胶囊、IMAGE_NOTE → 文件卡不再显示 objectKey */
  const msgs = inst.data.messages || []
  check('[问诊室] 日期分隔只插 1 条（跨天才插）',
    msgs.filter((m) => m.kind === 'day').length === 1, '实得 ' + msgs.filter((m) => m.kind === 'day').length)
  check('[问诊室] system_notice → sys 胶囊（非气泡）',
    msgs.some((m) => m.kind === 'sys' && m.text.indexOf('问诊已开始') >= 0))
  const file = msgs.find((m) => m.kind === 'file') || {}
  check('[问诊室] IMAGE_NOTE → 文件卡', file.fileName === 'a1b2c3.pdf', '实得 ' + file.fileName)
  check('[问诊室] 文件卡不把 objectKey 当气泡正文（回归）',
    !msgs.some((m) => m.kind === 'user' && String(m.text || '').indexOf('attachments/') >= 0))
  check('[问诊室] 已传资料计数 = 1', inst.data.attachCount === 1, '实得 ' + inst.data.attachCount)

  /* ③ 结构化回复卡：只在服务端下发 structured 时出现，空 content 不落成空气泡 */
  const rx = msgs.find((m) => m.kind === 'rx') || {}
  check('[问诊室] structured → 检查建议卡（2 条）',
    rx.rxTitle === '检查建议' && (rx.rxItems || []).length === 2, '实得 ' + JSON.stringify(rx.rxItems))
  check('[问诊室] 结构化消息不重复渲染空气泡',
    !msgs.some((m) => m.kind === 'doc' && !String(m.text || '').trim()))

  /* ④ 摘要卡：契约无 remainingMinutes → 不渲染「剩余时间」（不自己按 createdAt 推算） */
  check('[问诊室] 无 remainingMinutes → 剩余时间为空', inst.data.remainingText === '', '实得 ' + inst.data.remainingText)
  check('[问诊室] 就诊事项取后端 title', inst.data.activeTitle === '咳嗽待查咨询', '实得 ' + inst.data.activeTitle)

  /* ⑤ 详情 501 → 回退「列表 + 消息」，页面仍可用；医生字段缺省走中性占位 */
  SCENARIO.consultDetail = 'off'
  const b = instantiate(cfg)
  b.onLoad({ consultationId: 'cn-1' })
  await waitFor(() => b.data.loading === false)
  await waitFor(() => (b.data.messages || []).length > 0)
  check('[问诊室] 详情 501 回退到列表（不报错）', b.data.error === '', '实得 ' + b.data.error)
  check('[问诊室] 回退后医生缺省为「接诊医生」', b.data.doctorName === '接诊医生', '实得 ' + b.data.doctorName)
  /* accepting 缺省语义拆两条：
     · 页面初始值必须是"未接诊"（不得默认接诊中）——判据取页面 data 定义，稳定可回归；
     · 拿到含医生侧/系统消息的会话后按消息升级为"接诊中"，这是 2026-10-24 起的既定口径
       （与后端 hasNonUserMessage 同源，见 consult.js:307-309、:359）。原断言把这两件事
       混在一条里，夹具本身带 assistant 消息，故必然"失败"——属断言与实现口径不一致。 */
  check('[问诊室] accepting 缺省不默认接诊中：初始 false + 「接诊后」提示',
    cfg.data.accepting === false && String(cfg.data.tipText || '').indexOf('接诊后') >= 0,
    '实得 ' + JSON.stringify({ accepting: cfg.data.accepting, tip: cfg.data.tipText }))
  check('[问诊室] 会话含医生侧消息 → 按消息升级为接诊中（不依赖详情字段）',
    b.data.accepting === true && b.data.tipText.indexOf('正在查看') >= 0, '实得 ' + b.data.tipText)
  check('[问诊室] 回退通道仍能拉到消息（详情缺失不影响看历史）',
    (b.data.messages || []).length > 0, '实得 ' + (b.data.messages || []).length)
  SCENARIO.consultDetail = 'on'
}

async function testDoctorQueue() {
  SCENARIO.mode = 'normal'
  const prevRole = appStub.globalData.role
  appStub.globalData.role = 'doctor'

  const cfg = loadPage(path.join('pages', 'doctor', 'appointments', 'appointments.js'))
  const inst = instantiate(cfg)
  inst.onLoad()
  await waitFor(() => inst.data.loading === false)
  await waitFor(() => (inst.data.displayed || []).length > 0)

  /* ① 队列口径：**不传 date**，由前端按「今天及未来」过滤（2026-10-24 统一口径）。
     服务端返回全量预约，带 date=今天 会让"明天"的预约不可见 —— 旧断言（要求带 date）
     对应的是已废弃实现，此处按现码改判。 */
  check('[挂号管理] 不传 date（今天及未来由前端过滤）',
    !lastData || !lastData.date,
    '实得 date=' + (lastData && lastData.date))

  /* ② 概览四列：按契约枚举分组 —— 回归项：rawStatus 曾被执行 status 覆盖成中文，前三列恒 0 */
  const st = inst.data.stats || []
  check('[挂号管理] 四列顺序 = 待就诊/就诊中/已完成/全部',
    st.map((s) => s.label).join(',') === '待就诊,就诊中,已完成,全部', '实得 ' + st.map((s) => s.label).join(','))
  check('[挂号管理] 三列计数不再恒 0（1/1/1，总数 3）',
    st[0] && st[0].value === 1 && st[1] && st[1].value === 1 && st[2] && st[2].value === 1 && st[3] && st[3].value === 3,
    '实得 ' + st.map((s) => s.value).join('/'))

  /* ③ 展示顺序：待就诊 → 就诊中 → 终端态（服务端给的是纯时间序） */
  const view = inst.data.displayed || []
  check('[挂号管理] 待就诊置顶（即使服务端按时间把已完成排在最前）',
    view[0] && view[0].id === 'ap-1', '实得首行 ' + (view[0] && view[0].id))
  check('[挂号管理] 队列顺序 015→016→017', view.map((r) => r.no).join(',') === '015,016,017',
    '实得 ' + view.map((r) => r.no).join(','))

  /* ④ 序号：queueNumber 补足 3 位（契约无「A」前缀字段，不猜字母） */
  check('[挂号管理] queueNumber 15 → 「015」', view[0] && view[0].no === '015', '实得 ' + (view[0] && view[0].no))

  /* ⑤ 就诊时间：ISO → 「<今天> 上午 09:30」（夹具为今天 09:30，故日期前缀动态比对） */
  check('[挂号管理] startTime → 「' + TODAY_LABEL + ' 上午 09:30」',
    ((view[0] || {}).whenText || '').indexOf(TODAY_LABEL + ' 上午 09:30') === 0,
    '实得 ' + (view[0] && view[0].whenText))

  /* ⑥ 状态/徽章/动作三件套 */
  const byId = {}
  view.forEach((r) => { byId[r.id] = r })
  check('[挂号管理] PENDING → 待就诊 + 蓝徽章 + 可叫号',
    byId['ap-1'] && byId['ap-1'].status === '待就诊' && byId['ap-1'].statusCls === 'badge-blue' && byId['ap-1'].canCall === true,
    '实得 ' + JSON.stringify(byId['ap-1'] && [byId['ap-1'].status, byId['ap-1'].statusCls, byId['ap-1'].canCall]))
  check('[挂号管理] CHECKED_IN → 就诊中 + 薄荷徽章 + 可完成',
    byId['ap-3'] && byId['ap-3'].status === '就诊中' && byId['ap-3'].statusCls === 'badge-mint' && byId['ap-3'].canFinish === true)
  check('[挂号管理] COMPLETED → 已完成 + 灰徽章 + 无动作',
    byId['ap-2'] && byId['ap-2'].statusCls === 'badge-gray' && !byId['ap-2'].canCall && !byId['ap-2'].canFinish)

  /* ⑦ 概览列即筛选：点「待就诊」只剩 1 条，点「今日总数」回全量 */
  inst.onFilter({ currentTarget: { dataset: { key: 'wait' } } })
  check('[挂号管理] 点「待就诊」筛出 1 条', (inst.data.displayed || []).length === 1, '实得 ' + (inst.data.displayed || []).length)
  check('[挂号管理] 筛选后概览数字不变（同源聚合）', (inst.data.stats || [])[3].value === 3)
  inst.onFilter({ currentTarget: { dataset: { key: 'total' } } })
  check('[挂号管理] 点「今日总数」回全量 3 条', (inst.data.displayed || []).length === 3, '实得 ' + (inst.data.displayed || []).length)

  appStub.globalData.role = prevRole
}

async function testErrorPath() {
  // 生产档（关掉演示兜底）+ 后端 500 → 错误态中文文案（不混入演示数据）
  const ENV = require(path.join(ROOT, 'config', 'env.js'))
  const prev = ENV.MOCK_FALLBACK
  ENV.MOCK_FALLBACK = false
  SCENARIO.mode = 'http500'

  const cfg = loadPage(path.join('pages', 'profile', 'health-records', 'health-records.js'))
  const inst = instantiate(cfg)
  inst.onLoad()
  await waitFor(() => inst.data.loading === false)

  const msg = inst.data.error
  check('[错误态] 档案页 500 → 中文错误文案', !!msg && !/^[\x00-\x7F]*$/.test(msg), '实得 ' + JSON.stringify(msg))
  check('[错误态] 错误时列表为空（不伪造）', (inst.data.sections || []).length === 0)

  ENV.MOCK_FALLBACK = prev
  SCENARIO.mode = 'normal'
}

// ==================== 运行 ====================
;(async () => {
  await testProfile()
  await testHome()
  await testHealthRecords()
  await testFamily()
  await testConsultations()
  await testConsultRoom()
  await testDoctorQueue()
  await testErrorPath()

  console.log('== test-pages-contract ==')
  if (fails.length) {
    console.log('❌ 失败 ' + FAIL + ' 项：')
    fails.forEach((f) => console.log('   · ' + f))
  }
  console.log('通过 ' + PASS + ' / 共 ' + (PASS + FAIL))
  process.exit(FAIL ? 1 : 0)
})()
