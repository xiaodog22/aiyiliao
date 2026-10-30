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
const { withFallback } = require('../../services/request.js')
const icons = require('../../utils/icons.js')
const { errText } = require('../../utils/err-text.js')
const { parseAptDate } = require('../../utils/apt-date.js')

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
 * 医生号源状态（复刻文档 §四.3-⑤ 三态之二）：
 * 契约 Doctor 只有 `hasAvailableSlot`（布尔，且**缺省不代表约满**），因此
 *   true  → 今日可预约（薄荷绿字）
 *   false → 约满（灰字 + 灰禁用按钮）
 *   其它  → 未知：不写状态、按钮照常可点（点进去由号源面板给出真实结论）
 * 「今日号源紧张」需要每医生余号总量，列表接口没有该字段 → 不臆造（见交付说明的偏离 2）。
 */
function docState(hasSlot) {
  if (hasSlot === true) return { statusText: '今日可预约', statusCls: 'doc-ok', bookable: true }
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
    /* 就诊时段（效果图 03）：am / pm 两档，本地过滤 slots，不额外请求 */
    period: 'am',
    filteredSlots: [],
    _allDepartments: [],
    _allDoctors: [],
    selDate: '',
    selDateText: '',
    selTime: '',
    selSlotId: '',
    patient: {},
    orderNo: '',
    // 加载/错误态
    loadingDept: false,
    deptError: '',
    loadingDoctors: false,
    loadingSlots: false,
    submitting: false
  },

  onShow() {
    // TabBar 高亮当前页（第 3 项）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().selectByPath('/pages/appointment/appointment')
    }
    // switchTab 进本页不带 query：导诊/问诊/结果页的预选科室走缓存传递，
    // tab 页常驻（onLoad 只触发一次），必须在 onShow 消费，否则再次跳转不生效。
    const pending = this._takePendingDept()
    if (pending && pending !== this.data.selDept) this.loadDepartments(pending)
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
      slots: [],
      filteredSlots: []
    })
    this.goStep('time', 2)
    /* 日期是独立维度（效果图里换医生不动日期条），所以不重置 selDate；
       已选日期就直接拉这位医生的号源，少一次点击。 */
    if (this.data.selDate) this._loadSlots(this.data.selDate)
  },

  pickDate(e) {
    const { value, text } = e.currentTarget.dataset
    if (value === this.data.selDate) return
    this.setData({ selDate: value, selDateText: text || '', selTime: '', selSlotId: '', slots: [], filteredSlots: [] })
    // 还没选医生时只记日期，别去请求一个没有 doctorId 的号源
    if (this.data.selDoctorId) this._loadSlots(value)
  },

  /** 拉取所选日期的真实号源（来自契约 slots 接口，含 slotId 与余号） */
  _loadSlots(date) {
    this.setData({ loadingSlots: true })
    const fetch = withFallback(
      appointmentService.listDoctorSlotsC(this.data.selDoctorId, date, date),
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
        const slots = (all || [])
          .map((s) => {
            const dt = appointmentService.slotDateTime(s.startTime)
            if (!dt || dt.date !== date) return null
            return { id: s.id, time: dt.time, remaining: s.remaining, fee: s.fee }
          })
          .filter(Boolean)
          .sort((a, b) => (a.time < b.time ? -1 : 1))
        this.setData({ slots, loadingSlots: false }, () => this._applyPeriod())
      })
      .catch((err) => {
        this.setData({ loadingSlots: false })
        wx.showToast({ title: '号源加载失败：' + errText(err, '请重试'), icon: 'none' })
      })
  },

  pickTime(e) {
    const { id, time, remaining } = e.currentTarget.dataset
    if (Number(remaining) <= 0) return // 约满不可选
    this.setData({ selSlotId: id, selTime: time })
  },

  /** 切换上午 / 下午；若已有选号源则提示用户重新选择具体时间 */
  onPeriod(e) {
    const period = e.currentTarget.dataset.period
    if (period === this.data.period) return
    const hadSelectedSlot = !!this.data.selSlotId
    this.setData({ period, selSlotId: '', selTime: '' }, () => {
      this._applyPeriod()
      if (hadSelectedSlot) wx.showToast({ title: '已切换时段，请重新选择时间', icon: 'none' })
    })
  },

  /** 按所选时段过滤号源（pure view 计算，不改服务端数据） */
  _applyPeriod() {
    const am = this.data.period !== 'pm'
    const h = (t) => {
      const n = parseInt(String(t || '').slice(0, 2), 10)
      return isNaN(n) ? 0 : n
    }
    const filtered = (this.data.slots || []).filter((s) => (h(s.time) < 12) === am)
    this.setData({ filteredSlots: filtered })
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
        // 契约 Appointment：预约号取 id；未返回不编造
        const orderNo = (res && res.id) || ''
        this.setData({ orderNo, step: 'done', stepIndex: 4, submitting: false })
      })
      .catch((err) => {
        this.setData({ submitting: false })
        const httpCode = (err && (err.httpCode || err.statusCode)) || 0
        const code = (err && err.code) || ''
        // 仅「结果未知」（超时/断网/服务端 5xx）保留键以便安全重试；
        // 明确的业务失败（400/403/409/429）必须作废，否则用户改完信息再提交会撞 409。
        if (!(code === 'TIMEOUT' || code === 'NETWORK_ERROR' || httpCode >= 500)) this._dropSubmitKey()
        if (httpCode === 409) {
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

  goHome() {
    wx.switchTab({ url: '/pages/home/home' })
  }
})
