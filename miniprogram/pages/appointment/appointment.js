/**
 * pages/appointment —— 分步挂号（V4 契约版）
 * 状态机：dept → doctor → time → confirm → done
 * 数据来源：全部走契约接口（科室/医生/号源），提交走契约 AppointmentCreate（slotId + patientName + 幂等键）。
 * ⚠️ 开发档 withFallback 仅用于「科室/医生/号源」目录读取的演示；提交不做降级——
 *    挂号失败如实报错，绝不伪造"成功"写入本地（原 withFallback 掩盖契约 400 的问题已移除）。
 */
const app = getApp()
const appointmentService = require('../../services/appointment.js')
const userService = require('../../services/user.js')
const session = require('../../services/session.js')
const { withFallback } = require('../../services/request.js')
const icons = require('../../utils/icons.js')
const { errText } = require('../../utils/err-text.js')
const { parseAptDate } = require('../../utils/apt-date.js')
const { aptDirtyAt } = require('../../utils/apt-status.js')

/**
 * 预约终态 → 成功页退回时的提示文案。
 * 只登记「这单已经结束、不该再显示挂号成功」的状态；PENDING/CONFIRMED/CHECKED_IN 不在此表。
 */
const DONE_STATUS_TIP = {
  CANCELLED: '该预约已取消，可重新选择',
  COMPLETED: '本次就诊已完成',
  EXPIRED: '该预约已过期，请重新挂号',
  NO_SHOW: '本次预约未到诊'
}

/**
 * 科室 → 图标底板 + 字形（纯视觉映射，不参与业务判断）：
 * 未命中关键词时回退蓝底 + 医院图标 —— 宁可统一，不给错配的专科图标。
 * 颜色纪律：底板只用五色 pastel 装饰色，不挪用红/橙语义色（D-01④）。
 */
const DEPT_VISUAL = [
  { keys: ['呼吸', '肺'], tint: 'tile-blue', icon: icons.stethoscope },
  { keys: ['心血管', '心内', '心脏'], tint: 'tile-pink', icon: icons.heartbeat },
  { keys: ['消化', '胃肠', '肝'], tint: 'tile-mint', icon: icons.pill },
  { keys: ['骨', '关节', '脊柱'], tint: 'tile-amber', icon: icons.activity },
  { keys: ['神经'], tint: 'tile-purple', icon: icons.zap },
  { keys: ['儿', '小儿'], tint: 'tile-pink', icon: icons.user },
  { keys: ['皮肤'], tint: 'tile-mint', icon: icons.leaf },
  { keys: ['眼'], tint: 'tile-blue', icon: icons.eye },
  { keys: ['耳鼻喉', '口腔', '牙'], tint: 'tile-amber', icon: icons.hospital },
  { keys: ['妇'], tint: 'tile-pink', icon: icons.users }
]

function deptVisual(name) {
  const n = String(name || '')
  for (let i = 0; i < DEPT_VISUAL.length; i++) {
    const v = DEPT_VISUAL[i]
    for (let j = 0; j < v.keys.length; j++) {
      if (n.indexOf(v.keys[j]) >= 0) return { tint: v.tint, icon: v.icon }
    }
  }
  return { tint: 'tile-blue', icon: icons.hospital }
}

/** 开发档目录降级：MOCK 科室/医生映射成契约形状（仅供演示浏览，提交仍会走真实后端） */
function mockDepartments() {
  return (app.MOCK.DEPARTMENTS || []).map((d, i) => ({
    id: 'mock-dept-' + i,
    name: d.name,
    location: '',
    doctors: d.doctors || []
  }))
}

/**
 * 横向日期条的 7 天（复刻文档 §四.3-③：上排星期 + 下排日期数字）。
 * 复用 utils/apt-date.js 的 parseAptDate（已被 tools/test-apt-date.js 覆盖：
 * 年份可缺 / 分隔符变体 / 越界回退 null），避免再写一份"取星期的第二实现"。
 *   value → 提交/查询用的 ISO（YYYY-MM-DD，接口只认这个）
 *   label → 上排文字（今天 / 明天 / 周X）
 *   day   → 下排数字（补零，与效果图「18 / 20 / 21…」一致）
 *   full  → 抽屉里的「10月20日 周一」
 */
function buildDates(size) {
  const now = new Date()
  const out = []
  for (let i = 0; i < size; i++) {
    // 用「年月日 + i」构造，避开 date+86400000 在夏令时/时区上的跨天误差
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const value = yyyy + '-' + mm + '-' + dd
    const p = parseAptDate(value) || { day: dd, week: '', mon: mm + '月' }
    out.push({
      value,
      label: i === 0 ? '今天' : (i === 1 ? '明天' : p.week),
      day: p.day,
      full: Number(p.mon.replace(/\D/g, '')) + '月' + Number(p.day) + '日' + (p.week ? ' ' + p.week : '')
    })
  }
  return out
}

/**
 * 上午 / 下午分段的展示区间（2026-11-15）：首档起点 ~ 末档终点，如「08:00-11:00」。
 * 列表已按时间升序，因此首尾即可代表整段；无档返回空串（模板据此显示「暂无号源」）。
 * @param {Array<{time:string,endTime:string}>} list
 * @returns {string}
 */
function segRange(list) {
  if (!list || !list.length) return ''
  const first = list[0]
  const last = list[list.length - 1]
  return first.time + '-' + (last.endTime || last.time)
}

/**
 * 医生号源状态（复刻文档 §四.3-⑤ 三态之二）： * 契约 Doctor 只有 `hasAvailableSlot`（布尔，且**缺省不代表约满**），因此
 *   true  → 近期可约（薄荷绿字）
 *   false → 约满（灰字 + 灰禁用按钮）
 *   其它  → 未知：不写状态、按钮照常可点（点进去由号源面板给出真实结论）
 * 「今日号源紧张」需要每医生余号总量，列表接口没有该字段 → 不臆造（见交付说明的偏离 2）。
 *
 * ⚠️ D-09：原文案是「今日可预约」，但 hasAvailableSlot 的语义是「存在可约号源」，
 *    不限定日期。用户按"今日"预期点进去、选了今天却看到「该时段暂无号源」，
 *    文案与事实冲突。这里改成不承诺具体日期的「近期可约」。
 */
function docState(hasSlot) {
  if (hasSlot === true) return { statusText: '近期可约', statusCls: 'doc-ok', bookable: true }
  if (hasSlot === false) return { statusText: '约满', statusCls: 'doc-full', bookable: false }
  return { statusText: '', statusCls: '', bookable: true }
}

Page({
  data: {
    icons,
    theme: 'standard',
    steps: ['选科室', '选医生', '选时段', '确认'],
    stepIndex: 0,
    step: 'dept',
    // 目录数据（契约形状）
    departments: [],
    selDept: '',
    selDeptId: '',
    selDoctors: [],
    selDoctor: '',
    selDoctorId: '',
    selDoctorTitle: '',
    dates: [],
    slots: [],        // 当前所选日期的号源：[{id,time,remaining,fee}]
    /* 效果图 03「单页 + 底部抽屉」：搜索与筛选只做**本地过滤**，
       `_all*` 保存服务端原样返回的全量，过滤后再写回渲染字段。 */
    keyword: '',
    deptFilterOn: false,
    showConfirm: false,
    /* 就诊时段（效果图 03）：am / pm 两档，本地过滤 slots，不额外请求。
       amCount / pmCount / amRange / pmRange 用于在切换前就把「哪段有号、覆盖几点到几点」
       写清楚（2026-11-15 号源扩到每天 12 档后，用户需要先看到段信息再决定点哪一段）。 */
    period: 'am',
    amCount: 0,
    pmCount: 0,
    amRange: '',
    pmRange: '',
    emptyTip: '',
    filteredSlots: [],
    _allDepartments: [],
    _allDoctors: [],
    selDate: '',
    selDateText: '',
    selTime: '',
    /* 就诊时间段的完整文案（「上午 08:00-08:30」）：抽屉与成功页直接显示，
       避免只给一个起点让用户自己猜这一档到几点结束 */
    selTimeText: '',
    selSlotId: '',
    patient: {},
    orderNo: '',
    // 「取号」/「预约单号」：queueNumber 缺失时文案要跟着变，不能把内部单号也叫预约号（D-07）
    orderLabel: '取号',
    // P0-1：成功页「去缴费（演示）」入口；仅本次会话记住，不写入本地存储
    lastAptId: '',
    // 加载/错误态
    loadingDept: false,
    deptError: '',
    loadingDoctors: false,
    loadingSlots: false,
    submitting: false,
    /* REQ-14（V1.20 受限接入）：预约来源与演示标识。
       LOCAL_DEMO / HIS_MOCK → 成功页必须显示「演示预约」；仅 HIS_LIVE（真实受理）隐藏。
       默认 false：选号阶段还没发生受理，不提前给结论。 */
    bookingSource: '',
    isDemo: false
  },

  onShow() {
    // TabBar 高亮当前页（第 3 项）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().selectByPath('/pages/appointment/appointment')
    }
    // D-10：高对比 / 字号在设置页改完后，回到本页要立刻生效
    const theme = app.globalData.theme || 'standard'
    const hc = !!app.globalData.highContrast
    if (theme !== this.data.theme || hc !== this.data.hc) this.setData({ theme, hc })
    // switchTab 进本页不带 query：导诊/问诊/结果页的预选科室走缓存传递，
    // tab 页常驻（onLoad 只触发一次），必须在 onShow 消费，否则再次跳转不生效。
    const pending = this._takePendingDept()
    if (pending && pending !== this.data.selDept) this.loadDepartments(pending)
    // 取消同步（2026-11-15）：在「我的预约」取消后切回本页，不能还停在「挂号成功」页，
    // 余号也不能沿用取消前那份 —— 状态机退回选科室，号源强制绕过短缓存重拉一次。
    // 用游标比较而非"读一次即删"：标记是广播，别的页面读走不影响本页（见 utils/apt-status.js）。
    const dirtyAt = aptDirtyAt()
    if (dirtyAt > (this._aptSeen || 0)) {
      this._aptSeen = dirtyAt
      this._syncAfterCancel()
    }
    // 兜底：标记只覆盖「本机 10 分钟内的变更」。成功页常驻时再直接问服务端这一单还在不在，
    // 否则用户在别处取消、或隔很久才切回来，仍会看到旧的「挂号成功」。
    this._verifyDoneStillValid()
  },

  /**
   * 成功页兜底校验（2026-11-15）：不依赖任何本地标记。
   * 判据：本人预约列表里找不到这一单，或状态已进入**终态**（已取消 / 已完成 / 已过期 / 未到诊）
   *      → 退回选科室，并按终态给对应文案。
   * ⚠️ 就诊中（CHECKED_IN）不算终态：叫号后医生还在看，患者仍该看到这张单。
   * ⚠️ 接口失败一律保持现状 —— 宁可多显示一次成功页，也不能把有效预约误退掉。
   */
  _verifyDoneStillValid() {
    if (this.data.step !== 'done' || !this._lastAptId) return
    const id = this._lastAptId
    userService.listMyAppointments()
      .then((list) => {
        // 期间用户可能已经重新挂号/退出成功页，别用过期的响应改状态
        if (this.data.step !== 'done' || this._lastAptId !== id) return
        const hit = (list || []).filter((it) => String((it && it.id) || '') === id)[0]
        if (!hit) return this._leaveDone('该预约已不存在，请重新选择')
        const st = String(hit.status || '').trim().toUpperCase()
        const done = DONE_STATUS_TIP[st]
        if (!done) return // 待确认/待就诊/就诊中：这单还成立，保持成功页
        this._leaveDone(done)
      })
      .catch(() => { /* 校验失败不改状态：没证据就不动 */ })
  },

  /** 成功页退回选科室（终态收口共用），tip 为提示文案 */
  _leaveDone(tip) {
    this._lastAptId = ''
    this.setData({ step: 'dept', stepIndex: 0, orderNo: '', submitting: false, selTime: '', selSlotId: '', selTimeText: '', showConfirm: false, isDemo: false, bookingSource: '', lastAptId: '' })
    if (tip) wx.showToast({ title: tip, icon: 'none' })
  },

  /** 别处取消了预约：退回选科室 + 刷新当前医生/日期余号 */
  _syncAfterCancel() {
    if (this.data.step === 'done') {
      this.setData({ step: 'dept', stepIndex: 0, orderNo: '', submitting: false, selTime: '', selSlotId: '', selTimeText: '', showConfirm: false, isDemo: false, bookingSource: '', lastAptId: '' })
      wx.showToast({ title: '预约已取消，可重新选择', icon: 'none' })
    }
    if (this.data.selDoctorId && this.data.selDate) this._loadSlots(this.data.selDate, true)
  },

  onLoad(options) {
    /* 复刻文档 §四.3-③：横向 **7 天**（原来是 3 天）。
       默认选中今天 —— 效果图里日期条始终有一格是蓝色选中态，没有"未选"的空档。 */
    const dates = buildDates(7)
    this.setData({
      icons,
      theme: app.globalData.theme || 'standard',
      dates,
      selDate: dates[0].value,
      selDateText: dates[0].full,
      // 就诊人：以登录态为准；未登录无真实姓名时留空，提交环节再阻断引导
      patient: app.globalData.user || {}
    })
    // 深链 ?dept= 可能被手改出畸形 % 序列 → decodeURIComponent 抛 URIError 会让整页 onLoad
    // 中断（白屏）。解码失败退回原文，再走缓存兜底（D-B-P2-02）。
    let dept = ''
    if (options && options.dept) {
      try { dept = decodeURIComponent(options.dept) } catch (e) { dept = String(options.dept) }
    }
    dept = dept || this._takePendingDept() || ''
    this.loadDepartments(dept)
  },

  /** 读取并消费一次「导诊直达预选科室」（wb_appoint_dept，跨页缓存键） */
  _takePendingDept() {
    const v = wx.getStorageSync('wb_appoint_dept') || ''
    if (v) wx.removeStorageSync('wb_appoint_dept')
    return v
  },

  // ============ 目录加载 ============

  /** 拉取科室目录；preloadDept 为导诊直达预选科室名（无则空串） */
  loadDepartments(preloadDept) {
    this.setData({ loadingDept: true, deptError: '' })
    const fetch = withFallback(appointmentService.listDepartmentsC(), mockDepartments)
    fetch
      .then((list) => {
        // 科室补视觉字段（图标底板 + 字形），模板只读 item.tint / item.icon
        const departments = (list || []).map((d) => {
          const v = deptVisual(d.name)
          return { id: d.id, name: d.name, location: d.location || '', tint: v.tint, icon: v.icon }
        })
        this.setData({ departments, loadingDept: false, _allDepartments: departments })
        if (preloadDept) {
          const hit = departments.find((d) => d.name === preloadDept)
          if (hit) this._selectDept(hit)
        }
      })
      .catch((err) => {
        this.setData({ loadingDept: false, deptError: errText(err, '科室列表加载失败') })
      })
  },

  retryDepartments() {
    this.loadDepartments('')
  },

  // ============ 步骤推进 ============

  goStep(step, index) {
    this.setData({ step, stepIndex: index })
  },

  pickDept(e) {
    const id = e.currentTarget.dataset.id
    const dept = this.data.departments.find((d) => d.id === id)
    if (!dept) return
    this._selectDept(dept)
  },

  _selectDept(dept) {
    this.setData({
      selDept: dept.name,
      selDeptId: dept.id,
      selDoctor: '',
      selDoctorId: '',
      selDoctorTitle: '',
      selDoctors: [],
      selTime: '',
      selSlotId: '',
      selTimeText: '',
      slots: [],
      filteredSlots: [],
      loadingDoctors: true
    })
    this.goStep('doctor', 1)
    const fetch = withFallback(appointmentService.listDeptDoctorsC(dept.id), () => {
      const mock = (app.MOCK.DEPARTMENTS || []).find((d) => d.name === dept.name)
      return ((mock && mock.doctors) || []).map((doc, i) => ({
        id: 'mock-doc-' + i,
        name: doc.name,
        title: doc.title || '',
        specialties: doc.expertise ? [doc.expertise] : [],
        hasAvailableSlot: true
      }))
    })
    fetch
      .then((list) => {
        /* 医生卡需要的三行（复刻文档 §四.3-⑤）+ 右侧按钮两态，统一在这里算好，
           模板只做展示（模板里塞判断会让 class 拼接出错时无迹可循）。 */
        const doctors = (list || []).map((d) => {
          const st = docState(d.hasAvailableSlot)
          return {
            id: d.id,
            name: d.name,
            title: d.title || '',
            specialties: d.specialties || [],
            deptName: dept.name,
            // deptId 必须留：搜索命中医生时要用它反查所属科室并展开（审查 P2-05）。
            // 此前只存 deptName，`deptIds[d.deptId]=1` 的键恒为 "undefined"，反查永不命中。
            deptId: dept.id,
            statusText: st.statusText,
            statusCls: st.statusCls,
            bookable: st.bookable
          }
        })
        this.setData({ selDoctors: doctors, loadingDoctors: false, _allDoctors: doctors })
      })
      .catch((err) => {
        this.setData({ loadingDoctors: false })
        wx.showToast({ title: '医生列表加载失败：' + errText(err, '请重试'), icon: 'none' })
      })
  },

  pickDoctor(e) {
    const id = e.currentTarget.dataset.id
    const doc = this.data.selDoctors.find((d) => d.id === id)
    if (!doc) return
    this.setData({
      selDoctor: doc.name,
      selDoctorId: doc.id,
      selDoctorTitle: doc.title || '',
      selTime: '',
      selSlotId: '',
      selTimeText: '',
      slots: [],
      filteredSlots: []
    })
    // 换医生后重新按「哪段有号」自动选段（上一位医生可能只有下午）
    this._periodTouched = false
    this.goStep('time', 2)
    /* 日期是独立维度（效果图里换医生不动日期条），所以不重置 selDate；
       已选日期就直接拉这位医生的号源，少一次点击。 */
    if (this.data.selDate) this._loadSlots(this.data.selDate)
  },

  pickDate(e) {
    const { value, text } = e.currentTarget.dataset
    if (value === this.data.selDate) return
    this.setData({ selDate: value, selDateText: text || '', selTime: '', selSlotId: '', selTimeText: '', slots: [], filteredSlots: [] })
    // 换日期后重新按「哪段有号」自动选段（今天的上午过了、明天上午却还有）
    this._periodTouched = false
    // 还没选医生时只记日期，别去请求一个没有 doctorId 的号源
    if (this.data.selDoctorId) this._loadSlots(value)
  },

  /** 拉取所选日期的真实号源（来自契约 slots 接口，含 slotId 与余号）
   *  @param {boolean} [force] true = 跳过 15s GET 短缓存（取消预约后余号要立刻反映） */
  _loadSlots(date, force) {
    this.setData({ loadingSlots: true })
    const fetch = withFallback(
      appointmentService.listDoctorSlotsC(this.data.selDoctorId, date, date, force ? { cacheTtl: 0 } : undefined),
      () => (app.MOCK.TIME_SLOTS || []).map((t) => ({
        id: 'mock-slot-' + date + '-' + t,
        startTime: date + ' ' + t + ':00',
        endTime: '',
        remaining: 1,
        fee: null
      }))
    )
    fetch
      .then((all) => {
        // 只保留所选日期且能解析出时间的号源；按时间排序
        // 2026-11-04：过滤掉「今天已过」的时段。后端虽已按 start_time > NOW() 过滤，
        // 这里再兜一层 —— 页面停留跨过整点时，列表里残留的上一时段不能再被选中提交
        // （提交必然 422 SLOT_IN_PAST，用户只看到"服务异常"）。
        const now = new Date()
        const pad = (n) => (n < 10 ? '0' + n : '' + n)
        const todayStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
        const nowHm = pad(now.getHours()) + ':' + pad(now.getMinutes())
        const slots = (all || [])
          .map((s) => {
            const dt = appointmentService.slotDateTime(s.startTime)
            if (!dt || dt.date !== date) return null
            // 结束时间同一口径解析；解析不出就不编造，range 退回单点时间
            const et = appointmentService.slotDateTime(s.endTime)
            const endTime = (et && et.date === date) ? et.time : ''
            return {
              id: s.id,
              date: dt.date,
              time: dt.time,
              endTime,
              range: endTime ? (dt.time + '-' + endTime) : dt.time,
              // < 12:00 归上午，其余归下午（时段都是整/半点，字符串比较与时刻比较等价）
              period: dt.time < '12:00' ? 'am' : 'pm',
              remaining: s.remaining,
              fee: s.fee
            }
          })
          .filter((s) => s && (s.date > todayStr || (s.date === todayStr && s.time > nowHm)))
          .sort((a, b) => (a.time < b.time ? -1 : 1))
        // 空态文案要能区分「本来没排班」和「今天排的都已经过了」—— 后者是用户最常见的困惑
        // 2026-11-21：后端 listSlots 已按 start_time > NOW() 过滤，今日过号不会出现在 all 里，
        // 原判据 rawCount>0 恒为假 → “今日号源已过”永不命中。改为只按日期判定，
        // 文案合并两种可能（无排班/已过号），不猜测具体原因。
        const emptyHint = (!slots.length && date === todayStr)
          ? '今日号源已过或暂无排班，请选择其他日期'
          : '该时段暂无号源，请换一天或切换时段试试。'
        this.setData({ slots, loadingSlots: false, emptyHint }, () => this._applyPeriod())
      })
      .catch((err) => {
        this.setData({ loadingSlots: false })
        wx.showToast({ title: '号源加载失败：' + errText(err, '请重试'), icon: 'none' })
      })
  },

  pickTime(e) {
    const { id, time, remaining } = e.currentTarget.dataset
    if (Number(remaining) <= 0) return // 约满不可选
    // 完整就诊时间段文案（上午 08:00-08:30）：确认抽屉 / 成功页 / 侧栏摘要共用
    const hit = (this.data.slots || []).filter((s) => s.id === id)[0]
    const selTimeText = hit ? ((hit.period === 'am' ? '上午 ' : '下午 ') + hit.range) : time
    this.setData({ selSlotId: id, selTime: time, selTimeText })
  },

  /** 切换上午 / 下午；若已有选号源则提示用户重新选择具体时间 */
  onPeriod(e) {
    const period = e.currentTarget.dataset.period === 'pm' ? 'pm' : 'am'
    if (period === this.data.period) return
    // 用户手动切过段，后续换日期不再自动改段（尊重用户选择）
    this._periodTouched = true
    const hadSelectedSlot = !!this.data.selSlotId
    this.setData({ period, selSlotId: '', selTime: '', selTimeText: '' }, () => {
      this._applyPeriod()
      if (hadSelectedSlot) wx.showToast({ title: '已切换时段，请重新选择时间', icon: 'none' })
    })
  },

  /**
   * 按上午 / 下午分段（2026-11-15 扩容：每天 12 档，上下午各 6 档）。
   * 除了过滤，还要给出两段各自的档数与区间（「08:00-11:00」/「14:00-17:00」），
   * 让用户在切换前就知道哪一段有号 —— 之前只按 period 过滤、页面又没有切换入口，
   * 下午号源实际上永远看不到。
   */
  _applyPeriod() {
    const all = this.data.slots || []
    const am = all.filter((s) => s.period !== 'pm')
    const pm = all.filter((s) => s.period === 'pm')
    let period = this.data.period === 'pm' ? 'pm' : 'am'
    // 未手动切过段：当前段一档都没有、另一段有 → 自动落到有号的那一段
    // （最常见场景是下午打开页面，「今天上午」的档已经全部过期被过滤掉）
    if (!this._periodTouched) {
      const cur = period === 'am' ? am : pm
      const other = period === 'am' ? pm : am
      if (!cur.length && other.length) period = (period === 'am') ? 'pm' : 'am'
    }
    const otherCount = period === 'am' ? pm.length : am.length
    const otherName = period === 'am' ? '下午' : '上午'
    const emptyTip = otherCount
      ? ('本段暂无可约时段，可切换到' + otherName + '（' + otherCount + ' 个时段）')
      : '当天暂无可约时段，请换一天试试'
    this.setData({
      period,
      filteredSlots: period === 'am' ? am : pm,
      amCount: am.length,
      pmCount: pm.length,
      amRange: segRange(am),
      pmRange: segRange(pm),
      emptyTip
    })
  },

  /**
   * 本地过滤（唯一实现；此前文件里有两份同名方法，后者静默覆盖前者 —— 已合并）：
   * 关键词命中「科室名」或「医生姓名 / 擅长标签」，命中科室就展开其医生。
   */
  _applyFilter() {
    const kw = (this.data.keyword || '').trim()
    const all = this.data._allDoctors || this.data.selDoctors || []
    const depts = this.data._allDepartments || this.data.departments || []
    if (!kw) {
      this.setData({ departments: depts, selDoctors: all }, () => this._applyPeriod())
      return
    }
    const hitDoctors = all.filter((d) =>
      [d.name, (d.specialties || []).join(' ')].join(' ').indexOf(kw) >= 0
    )
    const deptIds = {}
    hitDoctors.forEach((d) => { deptIds[d.deptId] = 1 })
    const hitDepts = depts.filter((d) => d.name.indexOf(kw) >= 0 || deptIds[d.id])
    this.setData({ departments: hitDepts, selDoctors: hitDoctors }, () => this._applyPeriod())
  },

  // 时段 → 确认（必须已选到真实号源 slotId）
  goConfirm() {
    const { selDate, selSlotId } = this.data
    if (!selDate || !selSlotId) {
      wx.showToast({ title: '请选择日期和时间', icon: 'none' })
      return
    }
    /* 效果图 03：确认信息是**底部半模态抽屉**，列表仍在其后可见，
       而不是整页切走 —— step 语义保留，只是同时把抽屉打开。 */
    this.goStep('confirm', 3)
    this.setData({ showConfirm: true })
  },

  /** 关闭抽屉：回到选时段步骤（不清空已选，用户可继续改） */
  onCloseConfirm() {
    this.setData({ showConfirm: false })
    this.goStep('time', 2)
  },

  /** 搜索关键字（本地过滤科室名 / 医生名 / 擅长标签，不发请求） */
  onSearch(e) {
    const keyword = (e && e.detail && e.detail.value) || ''
    this.setData({ keyword }, () => this._applyFilter())
  },

  /** 右侧「搜索」按钮（复刻文档 §四.3-①）：只是收起键盘 + 反馈命中数，不新增接口 */
  onSearchSubmit() {
    const kw = (this.data.keyword || '').trim()
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard()
    if (!kw) {
      wx.showToast({ title: '请输入关键词', icon: 'none' })
      return
    }
    wx.showToast({ title: '匹配 ' + (this.data.departments || []).length + ' 个科室', icon: 'none' })
  },

  onClearSearch() {
    this.setData({ keyword: '' }, () => this._applyFilter())
  },

  /** 院区 / 科室筛选（当前为单院区演示口径：仅科室生效，院区恒定"本院区"） */
  onFilter(e) {
    const type = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.type
    if (type !== 'dept') {
      wx.showToast({ title: '当前仅开放本院区', icon: 'none' })
      return
    }
    const hint = this.data.deptFilterOn ? '已显示全部科室' : '已筛选推荐科室'
    this.setData({ deptFilterOn: !this.data.deptFilterOn }, () => {
      this._applyFilter()
      wx.showToast({ title: hint, icon: 'none' })
    })
  },

  /**
   * 抽屉里「就诊人 ›」（效果图 03 的箭头）。
   * 本项目就诊人在「我的 · 家庭成员」维护，这里**不擅自跳走**（会丢掉已选的科室/医生/号源），
   * 只给出可执行的提示，避免画一枚点了没反应的箭头。
   */
  onSwitchPatient() {
    wx.showToast({ title: '就诊人请在「我的 · 家庭成员」中管理', icon: 'none' })
  },

  // 确认挂号（契约 AppointmentCreate：slotId + patientName；幂等键由 user.js 统一生成）
  onSubmit() {
    if (this.data.submitting) return
    const { selSlotId, selDept, selDoctor, selDate, selTime, patient } = this.data
    if (!selSlotId) {
      wx.showToast({ title: '请选择日期和时间', icon: 'none' })
      return
    }
    const patientName = (patient && patient.name) || ''
    if (!patientName) {
      // 未登录或无真实姓名：不伪造就诊人，引导登录
      wx.showModal({
        title: '请先登录',
        content: '挂号需要使用您的真实就诊人信息，请先完成登录。',
        confirmText: '去登录',
        success: (r) => {
          if (r.confirm) wx.navigateTo({ url: '/pages/auth/login/login' })
        }
      })
      return
    }
    // 本地演示登录没有服务端 token：目录可用 mock 浏览，但挂号必须真会话，否则 401 看似“页面坏了”
    if (!session.hasSession()) {
      wx.showModal({
        title: '请先完成有效登录',
        content: '当前是本地演示登录，未连接后端，无法提交真实挂号。请重新用「模拟手机号登录」获取后端会话后再试。',
        confirmText: '去登录',
        cancelText: '稍后',
        success: (r) => {
          if (r && r.confirm) wx.reLaunch({ url: '/pages/auth/login/login' })
        }
      })
      return
    }
    this.setData({ submitting: true })
    // 幂等键与「本次挂号内容」绑定：同内容重试复用同一键 —— 服务端按键去重，
    // 避免"请求超时其实已下单，用户再点一次"产生两笔真实预约；
    // 内容变更（换时段/换医生/换就诊人）立即换键，否则同键不同载荷会被判 409。
    const submitSig = selSlotId + '|' + patientName
    if (this._submitSig !== submitSig) {
      this._submitSig = submitSig
      this._submitKey = userService.newIdempotencyKey()
    }
    // 契约 AppointmentCreate：required [slotId, patientName]，additionalProperties:false —— 不夹带契约外字段
    userService.submitAppointment({
      slotId: selSlotId,
      patientName,
      symptomSummary: '智能导诊推荐挂号'
    }, { idempotencyKey: this._submitKey })
      .then((res) => {
        this._dropSubmitKey()   // 成功即作废：下一次挂号是全新一笔
        // D-07：原先把裸 UUID（ap-04c6a996-…，换行两排）当「预约号」展示，用户没法念、没法抄。
        // 现在优先用后端分配的取号序号（queueNumber）→「第 003 号」；
        // 只有后端未给序号时，才退回内部单号（并明确标成「预约单号」而非「取号」）。
        const qn = res && res.queueNumber
        const orderNo = (qn === 0 || qn) ? String(qn).padStart(3, '0') : ''
        const orderLabel = orderNo ? '取号' : '预约单号'
        const orderText = orderNo || ((res && res.id) || '').slice(-8)
        // 记住这一单：成功页可能在后台常驻很久，onShow 要能回头校验它是否已被取消
        this._lastAptId = (res && res.id) ? String(res.id) : ''
        // REQ-14⑧：来源由服务端下发（LOCAL_DEMO/HIS_MOCK/HIS_LIVE），前端不猜。
        // 未接真实 HIS 时成功页必须标「演示预约」，只有真实受理才隐藏。
        const bookingSource = (res && res.bookingSource) || 'LOCAL_DEMO'
        // showConfirm 必须一起关：成功页是整屏遮罩，抽屉只是被压在下面；
        // 若不关，取消后退出成功页时抽屉会带着空的「预约时间」露出来。
        this.setData({ orderNo: orderText, orderLabel, step: 'done', stepIndex: 4, submitting: false, showConfirm: false, bookingSource, isDemo: bookingSource !== 'HIS_LIVE', lastAptId: this._lastAptId })
      })
      .catch((err) => {
        this.setData({ submitting: false })
        const httpCode = (err && (err.httpCode || err.statusCode)) || 0
        const code = (err && err.code) || ''
        // 仅「结果未知」（超时/断网/服务端 5xx）保留键以便安全重试；
        // 明确的业务失败（400/403/409/429）必须作废，否则用户改完信息再提交会撞 409。
        if (!(code === 'TIMEOUT' || code === 'NETWORK_ERROR' || httpCode >= 500)) this._dropSubmitKey()
        if (httpCode === 409) {
          // 409 有两种业务含义（DEF-03 新增 DUPLICATE_APPOINTMENT）：不能一律说成"号源已满"，
          // 否则用户会一直换时段重试，而真正的问题是"这个号您已经约过了"。
          if (code === 'DUPLICATE_APPOINTMENT') {
            wx.showModal({
              title: '请勿重复挂号',
              content: '您在该时段已有一笔有效预约。可在「我的 · 挂号记录」查看，无需再次挂号。',
              showCancel: false,
              confirmText: '查看挂号记录',
              success: () => wx.navigateTo({ url: '/pages/profile/records/records' })
            })
            return
          }
          // 号源已满：按契约要求回退号源列表重新选择（不使用旧快照）
          wx.showModal({
            title: '号源已满',
            content: '该时段刚刚约满，请重新选择其他时段。',
            showCancel: false,
            success: () => {
              this.goStep('time', 2)
              this._loadSlots(selDate)
            }
          })
          return
        }
        wx.showToast({ title: '挂号失败：' + errText(err, '请重试'), icon: 'none' })
      })
  },

  // 作废挂号幂等键（成功 / 明确业务失败时调用；重新挂号必须换新键）
  _dropSubmitKey() {
    this._submitSig = ''
    this._submitKey = ''
  },

  // 院内导航：带着刚挂的科室直达目的地（未登录科室名时进页面手动选）
  goNav() {
    const q = this.data.selDept ? ('?dept=' + encodeURIComponent(this.data.selDept)) : ''
    wx.navigateTo({ url: '/packageNav/pages/nav/nav' + q })
  },

  /** 挂号完成 → 向所选医生发起在线问诊（直接进入指定医生发起模式） */
  goConsult() {
    const q = [
      'doctorId=' + encodeURIComponent(this.data.selDoctorId || ''),
      'doctorName=' + encodeURIComponent(this.data.selDoctor || ''),
      'doctorTitle=' + encodeURIComponent(this.data.selDoctorTitle || ''),
      'departmentName=' + encodeURIComponent(this.data.selDept || '')
    ].join('&')
    wx.navigateTo({ url: '/pages/consult/consult?' + q })
  },

  /** P0-1：挂号成功 → 演示支付页（页面再判支付开关；未开启只显示到院窗口缴费） */
  goPay() {
    if (!this.data.lastAptId) return
    wx.navigateTo({ url: '/pages/payment/payment?appointmentId=' + encodeURIComponent(this.data.lastAptId) })
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  }
})
