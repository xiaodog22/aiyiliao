/**
 * tools/test-pages-paginate.js —— 四个长列表页的冒烟测试
 *
 * 为什么需要：node --check 只查语法、check-require.js 只查路径、check-exports.js 只查导入形状，
 * 三者都跑不出下面这类**运行时**才能暴露的错误：
 *   · paginate() 被当成函数调用 → "paginate is not a function"（整屏错误页）
 *   · this.setData({ all: p.all }) 而 paginate 不返回 all → data.all = undefined
 *     → onCall/onFinish 取不到行数据，**按钮点了没反应**（比报错更难发现）
 * 这里打桩 wx / getApp / Page，真实 require 页面文件，跑 onLoad → 触底 → 状态流转，
 * 直接用断言把上面两种回归钉死。
 *
 * 运行：node tools/test-pages-paginate.js
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

// ==================== 数据与打桩 ====================
const N = 45                     // 故意超过 PAGE_SIZE(20)，才能验证分页
const MY_PHONE = '13800138001'
// legacy 形态样本：仅当桩收到非契约端点时兜底使用（当前用例已全部走契约端点）。
const APPOINTMENTS = Array.from({ length: N }, (_, i) => ({
  id: i + 1,
  appointNo: 'YY' + String(i + 1).padStart(8, '0'),
  userName: '患者' + (i + 1),
  phone: MY_PHONE,
  appointTime: '2026-09-16 09:' + String(i % 60).padStart(2, '0'),
  deptName: '心血管内科',
  doctorName: '张医生',
  status: '待就诊',
  description: '胸闷'
}))

// /api/v1/appointments/me 的真实响应形状（契约 AppointmentData）——患者端页面用。
const CONTRACT_APPOINTMENTS = Array.from({ length: N }, (_, i) => ({
  id: 'apt' + (i + 1),
  status: 'PENDING',
  departmentName: '心血管内科',
  doctorName: '张医生',
  startTime: '2026-09-16T01:30:00Z',        // ISO Instant；+08 环境 → 2026-09-16 09:30
  location: '门诊楼 3 楼 302 诊室',
  patientName: '张建国'
}))

// /api/v1/doctor/appointments 的真实响应形状（契约 AppointmentData + version/queueNumber）
// ⚠️ 医生端挂号页 2026-10-18 起改调这里（患者端仍用 /appointments/me），
//    响应是**数组 + meta.nextCursor**，不是旧桩的 {list}。
// ⚠️ 日期必须动态生成：页面 2026-10-24 起按「今天及未来」过滤 startTime，
//    写死 2026-09-16 的夹具在 10 月之后全部被丢弃 → all=[] → 断言全红（T7 根因）。
function isoToday(hour, minute) {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}
const DOCTOR_APPOINTMENTS_STUB = Array.from({ length: N }, (_, i) => ({
  id: 'apt' + (i + 1),
  status: i === 0 ? 'PENDING' : 'CONFIRMED',
  version: 1,
  queueNumber: i + 1,
  departmentName: '心血管内科',
  doctorName: '张医生',
  startTime: isoToday(9, 30),
  location: '门诊楼 3 楼 302 诊室',
  patientName: '张建国'
}))

// /api/v1/consultations 的真实响应形状（契约 ConsultationData）
const CONSULTATIONS_STUB = Array.from({ length: 25 }, (_, i) => ({
  id: 'cons' + (i + 1),
  title: 'AI 智能问诊',
  status: i === 0 ? 'ACTIVE' : 'CLOSED',
  summary: '第 ' + (i + 1) + ' 次问诊记录摘要',
  lastMessageAt: '2026-09-16T01:30:00Z',
  messageCount: i + 1
}))

const storage = {}
// 每个用例可以改这个开关来模拟失败
let MODE = 'ok'                  // ok | http500

global.wx = {
  request(o) {
    setTimeout(() => {
      if (MODE === 'http500') {
        o.success({ statusCode: 500, data: { message: 'Internal Server Error' } })
        return
      }
      const url = String(o.url || '')
      // 医生端（契约）：列表返回数组 + meta；状态流转回写请求里的 toStatus
      if (url.indexOf('/api/v1/doctor/appointments') >= 0) {
        if (/\/status$/.test(url)) {
          // ⚠️ o.data 在桩环境里是对象（真机由 wx 序列化），两种形态都要认，否则回写恒为默认值
          let body = o.data
          if (typeof body === 'string') { try { body = JSON.parse(body) } catch (e) { body = {} } }
          const to = (body && body.toStatus) || 'CHECKED_IN'
          o.success({ statusCode: 200, data: { code: 'OK', data: { id: 'apt1', status: to, version: 2 } } })
        } else {
          o.success({
            statusCode: 200,
            data: { code: 'OK', data: DOCTOR_APPOINTMENTS_STUB, meta: { nextCursor: null } }
          })
        }
        return
      }
      // 床位走契约形状 {beds:[Bed]}（页面 toViewRow 读 status 英文枚举 + bedNo + wardId）。
      // ⚠️ 旧桩是 legacy {list:[{status:'空闲'}]}：英文枚举取不到 → 全部落「维修中」，且 rows 为空。
      if (url.indexOf('bed') >= 0) {
        o.success({
          statusCode: 200,
          data: {
            code: 'OK',
            data: {
              beds: [
                { id: 'bed-1', bedNo: 'A-01', wardId: 'w1', wardName: '心血管内科', status: 'AVAILABLE', version: 1 },
                { id: 'bed-2', bedNo: 'A-02', wardId: 'w1', wardName: '心血管内科', status: 'OCCUPIED', version: 1, occupantDisplayName: '张建国' }
              ]
            }
          }
        })
        return
      }
      // 其余按端点分流：契约端点返回契约形状（与真实后端一致）
      const list = url.indexOf('/consultations') >= 0
        ? CONSULTATIONS_STUB
        : url.indexOf('/appointments/me') >= 0
          ? CONTRACT_APPOINTMENTS
            : APPOINTMENTS
      o.success({ statusCode: 200, data: { code: 0, data: { list } } })
    }, 0)
  },
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  clearStorageSync() { Object.keys(storage).forEach((k) => delete storage[k]) },
  showToast() {},
  showModal() {},
  stopPullDownRefresh() {},
  reLaunch() {},
  navigateTo() {},
  setNavigationBarTitle() {}
}

// ⚠️ 会话预置（2026-10-16 认证改造后必须）：受保护请求先过本地会话守卫 ——
// 无 access 且无 refresh → 本地直接 reject、**不发网络**，列表恒空（正是本次门禁失效的根因）。
// access 只驻留内存、无法从 storage 预置 → 直接调 session.setTokens 注入测试会话。
const session = require(path.join(ROOT, 'services', 'session.js'))
session.setTokens({ accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 7200 })

const MOCK = require(path.join(ROOT, 'utils', 'mock-data.js'))
const appStub = {
  globalData: { role: 'doctor', theme: 'standard', user: { name: '张医生', phone: MY_PHONE } },
  MOCK
}
global.getApp = () => appStub

/** require 一个页面文件并取出它的 Page 配置 */
function loadPage(rel) {
  let cfg = null
  global.Page = (c) => { cfg = c }
  const abs = path.join(ROOT, rel)
  delete require.cache[require.resolve(abs)]
  require(abs)
  if (!cfg) throw new Error('未捕获到 Page 配置：' + rel)
  return cfg
}

/**
 * 把 Page 配置变成可调用的实例（自带 setData 打桩）
 * ⚠️ 必须支持第二参数 callback：小程序 setData(patch, cb) 的 cb 在视图层更新后执行，
 *    页面用它串联「先 setData 再 fetch」（如挂号页 onLoad）。桩若吞掉 cb，
 *    fetch 永不触发，表现为 all 为空、断言连锁失败 —— 2026-10-22 门禁红灯即此因。
 */
function instantiate(cfg) {
  const inst = Object.assign({}, cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}))
  inst.setData = (patch, cb) => {
    Object.keys(patch).forEach((k) => {
      const mm = /^([\w$]+)\.([\w$]+)$/.exec(k)          // a.b
      const mb = /^([\w$]+)\[(\d+)\]$/.exec(k)           // a[0]
      if (mm) { inst.data[mm[1]] = inst.data[mm[1]] || {}; inst.data[mm[1]][mm[2]] = patch[k] }
      else if (mb) { inst.data[mb[1]] = inst.data[mb[1]] || []; inst.data[mb[1]][Number(mb[2])] = patch[k] }
      else inst.data[k] = patch[k]
    })
    if (typeof cb === 'function') cb()
  }
  return inst
}

/** 等页面把 loading 置回 false（页面内部不返回 promise，只能轮询） */
function settle(inst, ms) {
  const limit = ms || 300
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (inst.data.loading === false || Date.now() - t0 > limit) resolve()
      else setTimeout(tick, 5)
    }
    tick()
  })
}

const tick5 = () => new Promise((r) => setTimeout(r, 5))

// ==================== ① paginate() 自身契约 ====================
;(function testPaginateContract() {
  const { paginate, PAGE_SIZE } = require(path.join(ROOT, 'utils', 'paginate.js'))
  const arr = Array.from({ length: 45 }, (_, i) => ({ id: i }))

  check('paginate 是函数（具名解构能拿到）', typeof paginate === 'function')
  check('PAGE_SIZE = 20', PAGE_SIZE === 20, '实得 ' + PAGE_SIZE)

  const p1 = paginate(arr, 1)
  check('p1.all 回传全量（页面写 all: p.all 才不会是 undefined）', p1.all === arr, '实得 ' + typeof p1.all)
  check('p1.displayed 长度 = 20', p1.displayed.length === 20, '实得 ' + p1.displayed.length)
  check('p1.hasMore = true', p1.hasMore === true)
  check('p1.total = 45', p1.total === 45)

  const p3 = paginate(arr, 3)
  check('第三页 displayed = 45（末尾不越界）', p3.displayed.length === 45, '实得 ' + p3.displayed.length)
  check('第三页 hasMore 翻 false', p3.hasMore === false)

  check('空输入安全', paginate(null, 1).displayed.length === 0)
  check('page 为 0/负 时按 1 处理', paginate(arr, 0).page === 1)
})()

// ==================== ② errText：绝不把英文怼给用户 ====================
;(function testErrText() {
  const { errText } = require(path.join(ROOT, 'utils', 'err-text.js'))
  const isAsciiOnly = (s) => /^[\x00-\x7F]*$/.test(String(s))

  const EN = errText(new Error('paginate is not a function'), '加载失败，请重试')
  check('JS 英文异常被拦下，换中文', !isAsciiOnly(EN) && EN === '加载失败，请重试', '实得 ' + EN)
  check('无 code 时回落 fallback', errText({}, '操作失败，请重试') === '操作失败，请重试')

  check('HTTP_ERROR 不给用户看状态码',
    errText({ code: 'HTTP_ERROR', message: 'Request failed with status code 500' }) === '服务暂时不可用，请稍后重试')
  check('NETWORK_ERROR 给网络提示',
    errText({ code: 'NETWORK_ERROR' }) === '网络连接失败，请检查网络后重试')
  check('TIMEOUT 给超时提示',
    errText({ code: 'TIMEOUT' }) === '网络较慢，请求超时，请重试')
  check('NO_BASE_URL 给未开通提示',
    errText({ code: 'NO_BASE_URL' }) === '服务地址未配置，请联系管理员')
  check('后端中文业务错误原样保留',
    errText({ code: 'BIZ_ERROR', message: '用户名或密码错误' }) === '用户名或密码错误')
  check('全 null 也安全', typeof errText(null, '重试') === 'string')
})()

// ==================== ③ 挂号管理（本次翻车页）====================
async function testAppointments() {
  const cfg = loadPage(path.join('pages', 'doctor', 'appointments', 'appointments.js'))

  // 正常取数
  MODE = 'ok'
  const inst = instantiate(cfg)
  inst.onLoad()
  await settle(inst)

  check('[挂号] 不再出现 error（原来报 paginate is not a function）', inst.data.error === '', 'error=' + inst.data.error)
  check('[挂号] all 拿到 45 条（原来恒为 undefined）', (inst.data.all || []).length === 45,
    'all=' + (inst.data.all ? inst.data.all.length : inst.data.all))
  check('[挂号] 首屏只渲染 20 条', inst.data.displayed.length === 20, '实得 ' + inst.data.displayed.length)
  check('[挂号] total = 45', inst.data.total === 45)
  check('[挂号] hasMore = true', inst.data.hasMore === true)

  // 上拉触底
  inst.onReachBottom()
  check('[挂号] 触底后渲染 40 条', inst.data.displayed.length === 40, '实得 ' + inst.data.displayed.length)
  inst.onReachBottom()
  check('[挂号] 再次触底渲染 45 条', inst.data.displayed.length === 45, '实得 ' + inst.data.displayed.length)
  check('[挂号] 到最后 hasMore 翻 false', inst.data.hasMore === false)
  inst.onReachBottom()
  check('[挂号] hasMore=false 时触底不再变（幂等）', inst.data.displayed.length === 45)

  // 叫号：这一条是 data.all 被写成 undefined 时的"点了没反应"守卫
  // ⚠️ 行定位用 dataset.id（页面 _change 按 id 查，不再用 index —— 视图是筛选后的切片）
  inst.onCall({ currentTarget: { dataset: { id: 'apt1' } } })
  await tick5()
  // ⚠️ 不能断言 displayed[0]：_refresh 按状态分组排序（待就诊→就诊中→终态），
  //    叫号后该行下沉到「就诊中」组。此处按 id 定位，校验同一行在两处都同步。
  check('[挂号] 叫号后 all[0] 变「就诊中」', inst.data.all[0].status === '就诊中', '实得 ' + inst.data.all[0].status)
  const hitRow = inst.data.displayed.find((t) => t.id === 'apt1')
  check('[挂号] 叫号后该行在切片中同步变「就诊中」', !!hitRow && hitRow.status === '就诊中',
    '实得 ' + (hitRow ? hitRow.status : '切片中无此行'))

  inst.onFinish({ currentTarget: { dataset: { id: 'apt1' } } })
  await tick5()
  check('[挂号] 完成后 all[0] 变「已完成」', inst.data.all[0].status === '已完成', '实得 ' + inst.data.all[0].status)
  check('[挂号] 完成后仍保留 45 条全量（切片未丢）', inst.data.all.length === 45)

  // 失败路径：文案必须是中文
  MODE = 'http500'
  const bad = instantiate(cfg)
  bad.onLoad()
  await settle(bad)
  const msg = bad.data.error
  check('[挂号] 后端 500 时进入错误态', !!msg, 'error=' + JSON.stringify(msg))
  check('[挂号] 错误文案是中文（不含英文/状态码）',
    !!msg && !/^[\x00-\x7F]*$/.test(msg) && !/500|HTTP|paginate/i.test(msg), '实得 ' + msg)
  MODE = 'ok'
}

// ==================== ④ 床位管理 ====================
async function testBeds() {
  const cfg = loadPage(path.join('pages', 'doctor', 'beds', 'beds.js'))
  const inst = instantiate(cfg)
  inst.onLoad()
  await settle(inst)

  check('[床位] 不再出现 error', inst.data.error === '', 'error=' + inst.data.error)
  check('[床位] all 有值（原来恒为 undefined）', Array.isArray(inst.data.all) && inst.data.all.length > 0,
    'all=' + (inst.data.all ? inst.data.all.length : inst.data.all))
  check('[床位] displayed 与 all 一致（总量小于一页）', inst.data.displayed.length === inst.data.all.length)
  check('[床位] total 有值', inst.data.total === inst.data.all.length)
}

// ==================== ⑤ 我的问诊（2026-10-17 起数据源=后端契约 /api/v1/consultations）====================
async function testConsultations() {
  const cfg = loadPage(path.join('pages', 'profile', 'consultations', 'consultations.js'))
  const inst = instantiate(cfg)
  inst.onLoad()
  await settle(inst)   // 数据源改为后端契约（失败时开发档兜底演示数据）→ 必须等异步落定

  const src = CONSULTATIONS_STUB.length
  check('[问诊] all 拿到 ' + src + ' 条（原来恒为 undefined）', (inst.data.all || []).length === src,
    'all=' + (inst.data.all ? inst.data.all.length : inst.data.all))
  check('[问诊] 首屏渲染 ≤20 条', inst.data.displayed.length === Math.min(20, src))
  check('[问诊] total = ' + src, inst.data.total === src)
  // 文案口径以页面 STATUS_TEXT 为准（设计稿 07：问诊中 / 已完成 / 已结束；
  // CLOSED 由「已结束」改为「已完成」，ARCHIVED 才是「已结束」）
  check('[问诊] ACTIVE 映射为「问诊中」', inst.data.all[0].statusText === '问诊中',
    '实得 ' + inst.data.all[0].statusText)
  check('[问诊] CLOSED 映射为「已完成」', inst.data.all[1].statusText === '已完成',
    '实得 ' + inst.data.all[1].statusText)
  // 页面 dateText 已带时分（yyyy-MM-dd HH:mm），断言格式而非「不含 T」——仍为强校验
  check('[问诊] lastMessageAt 已格式化为本地日期时间',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(inst.data.all[0].dateText), '实得 ' + inst.data.all[0].dateText)

  inst.onReachBottom()
  check('[问诊] 触底后全量渲染 ' + src + ' 条', inst.data.displayed.length === src)
  check('[问诊] 到末尾 hasMore=false', inst.data.hasMore === false)

  // 详情跳转依赖 data.all 的行数据 + dataset.id（页面 onView 读 id → navigateTo 带 consultationId）
  let navUrl = ''
  const origNavigateTo = global.wx.navigateTo
  global.wx.navigateTo = (o) => { navUrl = String((o && o.url) || '') }
  inst.onView({ currentTarget: { dataset: { id: 'cons1' } } })
  global.wx.navigateTo = origNavigateTo
  check('[问诊] 查看详情能取到行数据（依赖 data.all + dataset.id）',
    navUrl.indexOf('consultationId=cons1') >= 0, 'url=' + navUrl)
}

// ==================== ⑥ 挂号记录 ====================
async function testRecords() {
  const cfg = loadPage(path.join('pages', 'profile', 'records', 'records.js'))
  const inst = instantiate(cfg)
  inst.onLoad()
  await settle(inst)

  check('[记录] 不再出现 error', inst.data.error === '', 'error=' + inst.data.error)
  check('[记录] all 拿到 45 条（原来恒为 undefined）', (inst.data.all || []).length === 45,
    'all=' + (inst.data.all ? inst.data.all.length : inst.data.all))
  check('[记录] 首屏只渲染 20 条', inst.data.displayed.length === 20)
  check('[记录] total = 45', inst.data.total === 45)

  // 契约字段映射（2026-10-17 修复：此前按 legacy deptName/appointTime 取，契约端点下全为空）
  const row0 = inst.data.all[0]
  check('[记录] 契约 departmentName 映射到 dept', row0.dept === '心血管内科', '实得 ' + JSON.stringify(row0.dept))
  check('[记录] 契约 doctorName 映射到 doctor', row0.doctor === '张医生', '实得 ' + JSON.stringify(row0.doctor))
  check('[记录] startTime 转本地日期（不含 T）', /^\d{4}-\d{2}-\d{2}$/.test(row0.date), '实得 ' + row0.date)
  check('[记录] PENDING 状态映射为「待确认」', row0.status === '待确认', '实得 ' + row0.status)
  check('[记录] 契约 location 映射到 place', row0.place === '门诊楼 3 楼 302 诊室', '实得 ' + row0.place)

  inst.onReachBottom()
  check('[记录] 触底后渲染 40 条', inst.data.displayed.length === 40, '实得 ' + inst.data.displayed.length)

  // records 走 withFallback：开发阶段（MOCK_FALLBACK=true）后端失败会被演示数据兜底，
  // 压根到不了 catch 分支。要验证真正的错误态文案，得临时关掉降级开关。
  const ENV = require(path.join(ROOT, 'config', 'env.js'))
  const prevMock = ENV.MOCK_FALLBACK
  ENV.MOCK_FALLBACK = false
  MODE = 'http500'
  const bad = instantiate(cfg)
  bad.onLoad()
  await settle(bad)
  const msg = bad.data.error
  check('[记录] 错误文案是中文（不含英文/状态码）',
    !!msg && !/^[\x00-\x7F]*$/.test(msg) && !/500|HTTP/i.test(msg), '实得 ' + JSON.stringify(msg))
  ENV.MOCK_FALLBACK = prevMock
  MODE = 'ok'
}

// ==================== 汇总 ====================
// ⚠️ 必须**串行**跑：五个用例共享 MODE 开关与 storage，
// 并发会互相污染（曾造成"完成后状态回退"的假失败）。
;(async () => {
  await testAppointments()
  await testBeds()
  await testConsultations()
  await testRecords()

  console.log('== test-pages-paginate ==')
  if (fails.length) {
    console.log('❌ 失败 ' + FAIL + ' 项：')
    fails.forEach((f) => console.log('   · ' + f))
  }
  console.log('通过 ' + PASS + ' / 共 ' + (PASS + FAIL))
  process.exit(FAIL ? 1 : 0)
})()
