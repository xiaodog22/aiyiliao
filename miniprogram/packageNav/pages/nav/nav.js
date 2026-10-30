/**
 * packageNav/pages/nav —— 院内导航（患者端 16-院内导航）
 *
 * 渲染方案（沿用本页既有取舍，未引入第三方地图库）：
 *   · 底图 = 项目自绘的平面图 PNG（packageNav/assets/floor1.png，1440×860）
 *   · 底图 + 路线 + 标记**同层画在一张 canvas 上**，缩放/拖动由 JS 自绘。
 *     原因：小程序 canvas 是原生组件，放进 movable-view / image 的 transform 图层时真机（尤其 iOS）
 *     不跟随位移 → 出现"图动了线不动"；同层绘制从根上避免。
 *   · 坐标真源 = packageNav/data/indoor-map.js（由 tools/build-floorplan.py 生成，百分比坐标，
 *     与底图同源）。路线**本地计算**（离线矩形走廊 + 已知房间坐标），不调后端。
 *
 * 数据对接：
 *   · 科室清单 GET /api/v1/departments（appointmentService.listDepartmentsC）
 *     → 用于：①「到」显示后端科室全名（如"呼吸内科门诊"）；②楼层分组（2F/3F 楼层 tab 的科室清单）；
 *       ③搜索关键词（搜后端科室名也能落到平面图房间）。
 *     ⚠️ 后端科室表里**没有设施**（卫生间/电梯/楼梯…），设施数据只有本地 indoor-map.js 一份真源，
 *        故不伪造接口；页面里"科室走接口、设施走本地"的边界如实写在弹层分组上。
 *   · 路线/坐标/步数：纯本地（不请求网络）。
 *
 * 交互：点「到」→ 目的地弹层（搜索框 + 常用词 + 分类 + 结果列表）；
 *       点平面图圆点 → 直接选中；左下角楼层胶囊 → 楼层 tab；右下角 +/−/定位。
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const MAP = require('../../data/indoor-map.js')
const speech = require('../../../services/speech.js')
const appointmentService = require('../../../services/appointment.js')
const { errText } = require('../../../utils/err-text.js')
// 科室楼层（2F/3F/4F）来自导诊知识库 —— 楼层只有一处真源，避免两处各写一份而对不上
const KB = require('../../../utils/triage-kb.js')
const DEPT_INFO = (KB && KB.DEPARTMENT_INFO) || {}

/**
 * 画布颜色。
 * ⚠️ canvas 不支持 CSS 变量（不能读 app.wxss 的 --primary），故在此集中一份，
 *    取值与 app.wxss 令牌**同值**：--primary / --text-main / --bg。
 *    改主题色时这两处要一起改（本页是唯一在画布里用色的页面）。
 */
const C = {
  paper: '#F3F8FF',      // = --bg（图纸底色）
  primary: '#0B6EF8',    // = --primary
  primarySoft: 'rgba(11, 110, 248, 0.16)',
  white: '#FFFFFF',
  textMain: '#14264C',   // = --text-main
  shadow: 'rgba(20, 38, 76, 0.14)'
}

const ZOOM_MIN = 0.4
const ZOOM_MAX = 2.2
const ZOOM_STEP = 0.18
const FONT_BY_THEME = { standard: 13, large: 15, xlarge: 17 }
const CAT_COLOR = { '门诊': '#0B6EF8', '检查': '#00B42A', '服务': '#FF7D00', '治疗': '#9566FA', '设施': '#86909C' }

/** 搜索俗称 → 平面图上的名字（用户不按科室正式名说话：厕所 / 化验 / 拍片 …） */
const ALIAS = {
  '厕所': '卫生间', '洗手间': '卫生间', 'wc': '卫生间', '方便': '卫生间',
  '化验': '检验科', '抽血': '检验科', '验血': '检验科', '报告': '检验科',
  'ct': '放射科', '拍片': '放射科', '影像': '放射科', 'b超': '放射科',
  '取药': '药房', '拿药': '药房', '药品': '药房',
  '收费': '挂号 / 缴费', '缴费': '挂号 / 缴费', '交费': '挂号 / 缴费', '挂号处': '挂号 / 缴费',
  '电梯': '电梯厅', '升降梯': '电梯厅', '楼梯': '楼梯间', '上楼': '电梯厅',
  '打针': '输液室', '输液': '输液室', '吊水': '输液室',
  'x光': '放射科'
}

// 科室名 → 目的地 id（导诊/挂号页深链直达用；只做**精确**匹配，不做臆测）
const DEPT_MAP = {
  '消化内科': 'gi', '消化科': 'gi', '消化内科门诊': 'gi',
  '呼吸内科': 'resp', '呼吸科': 'resp', '呼吸内科门诊': 'resp',
  '心血管内科': 'cardio', '心内科': 'cardio', '心脏内科': 'cardio', '心血管科': 'cardio',
  '骨科': 'ortho', '骨外科': 'ortho', '关节外科': 'ortho', '脊柱外科': 'ortho',
  '儿科': 'pediatric', '小儿内科': 'pediatric', '小儿科': 'pediatric',
  '全科医学科': 'gp', '全科门诊': 'gp', '全科': 'gp', '综合门诊': 'gp',
  '放射科': 'radiology', '影像科': 'radiology', '医学影像科': 'radiology', 'CT室': 'radiology',
  '检验科': 'lab', '化验室': 'lab', '检验': 'lab',
  '药房': 'pharmacy', '药剂科': 'pharmacy', '取药': 'pharmacy',
  '输液室': 'infusion', '输液': 'infusion', '治疗室': 'infusion',
  '挂号': 'reg', '收费': 'reg', '缴费': 'reg'
}

// 深链兜底规则：遇到未登记的科室名，按关键字就近归位（只在深链场景用，选择器列表不用它）
const DEPT_RULES = [
  [/消化|胃肠|肝胆|脾胃/, 'gi'],
  [/心血管|心内|心脏|冠状/, 'cardio'],
  [/呼吸|肺|哮喘/, 'resp'],
  [/骨|关节|脊柱|创伤/, 'ortho'],
  [/儿|小儿|新生儿/, 'pediatric'],
  [/放射|影像|CT|核磁|超声/, 'radiology'],
  [/检验|化验|病理/, 'lab'],
  [/药/, 'pharmacy'],
  [/输液|注射|治疗/, 'infusion'],
  [/挂号|收费|缴费/, 'reg'],
  [/全科|综合门诊/, 'gp'],
  [/内分泌|肾内|血液|风湿|免疫|肿瘤|感染|老年|糖尿病/, 'resp'],
  [/皮肤|泌尿|胸外|普外|肛肠|肝胆外|血管外/, 'ortho'],
  [/内科/, 'resp'],
  [/外科|手术/, 'ortho']
]

/** 楼层字符串（"门诊楼 2F"）→ "2F" */
function floorKey(s) {
  const m = /(\d+)\s*F/i.exec(String(s || ''))
  return m ? m[1] + 'F' : ''
}

Page({
  data: {
    icons,
    theme: 'standard',
    origin: MAP.ORIGIN,
    floor: MAP.FLOOR,
    // 楼层：1F 有底图；2F/3F 来自科室楼层表（有科室、无底图）
    floorSel: '1F',
    floorStrip: '1F',
    floors: [{ key: '1F', label: '1F' }],
    floorPick: false,
    floorDepts: [],
    floorDeptsText: '',
    floorSelNum: 1,
    // 当前目的地
    active: null,
    activeLabel: '',
    activeFloor: '1F',
    steps: [],
    floorTip: '',
    speaking: false,
    // 目的地弹层
    pickerOpen: false,
    q: '',
    cats: ['全部'].concat(MAP.CATEGORIES),
    cat: '全部',
    hotWords: ['检验科', '卫生间', '电梯', '药房', '挂号 / 缴费'],
    list: [],
    deptErr: ''
  },

  onLoad(q) {
    const theme = app.globalData.theme || 'standard'
    this._font = FONT_BY_THEME[theme] || 13

    // 本地目的地（带坐标/路线/步数）——设施（卫生间/电梯/楼梯）只有这一份真源
    this._all = MAP.DESTINATIONS.map((d) => Object.assign({}, d, {
      iconPath: icons[d.icon] || icons.mapPin,
      color: CAT_COLOR[d.category] || '#0B6EF8',
      label: d.name,
      floor: '1F',
      floorLabel: '1F',
      needRegister: d.category === '门诊' && d.id !== 'reg'
    }))

    this._view = { scale: 0.5, tx: 0, ty: 0 }
    this._dept = (q && q.dept) ? decodeURIComponent(q.dept) : ''
    this._watchWide()
    this.setData({ theme, list: this._all })
    this.loadDepartments()
  },

  onReady() {
    this._initCanvas(() => {
      this._fitView()
      this._draw()
      if (this._dept) this._applyDeepLink(this._dept)
    })
  },

  onShow() {
    const theme = app.globalData.theme || 'standard'
    if (theme !== this.data.theme) {
      this._font = FONT_BY_THEME[theme] || 13
      this.setData({ theme }, () => this._draw())
    }
  },

  onHide() { speech.stopSpeak() },

  onUnload() { speech.stopSpeak() },

  /** 旋转屏幕 / 平板布局变化 → 重新测量画布分辨率并重绘 */
  onResize() {
    this._watchWide()
    this._relayout()
  },

  _watchWide() {
    let info = {}
    try { info = wx.getWindowInfo() } catch (e) {}
    this._isWide = (info.windowWidth || 0) >= 600
  },

  // ================= 科室数据（GET /api/v1/departments）=================

  /**
   * 拉科室清单：
   *   ① 精确命中的 1F 科室 → 把本地目的地的显示名升级为**后端科室名**（"呼吸内科门诊"），
   *      坐标/路线仍用本地房间（几何真源在平面图里，不在后端）；
   *   ② 2F/3F 的科室 → 归到「电梯厅」并带换层提示（1F 平面图上没有它们的房间，不硬画）；
   *   ③ 楼层清单（楼层 tab）也从这里来：1F 恒有（有底图），其余楼层按实际有科室才出现。
   * 失败时：只影响"科室名/楼层"，本地 14 个目的地照常可用（提示条 + 重试）。
   */
  loadDepartments() {
    this.setData({ deptErr: '' })
    return appointmentService.listDepartmentsC()
      .then((depts) => {
        const upper = []
        depts.forEach((d) => {
          const fk = floorKey(d.floor)
          const localId = DEPT_MAP[d.name]
          if (fk && fk !== '1F' && !localId) {
            upper.push({ name: d.name, floor: fk })
            return
          }
          if (!localId) return
          const hit = this._all.filter((x) => x.id === localId)[0]
          if (!hit) return
          // 已有后端名就不覆盖（同一房间多个别名时以第一条为准）
          if (!hit._deptNamed) {
            hit.label = d.name
            hit._deptNamed = true
          }
          if (fk) {
            hit.floor = fk
            hit.floorLabel = fk
          }
        })
        this._upper = upper
        this._buildFloors()
        this._filter()
      })
      .catch((err) => {
        this._buildFloors()
        this._filter()
        this.setData({ deptErr: errText(err, '科室数据加载失败，已显示常用目的地') })
      })
  },

  /** 楼层 tab：1F 恒有；其余楼层从"楼上科室"里归纳（没有科室的楼层不出现） */
  _buildFloors() {
    const keys = ['1F']
    const upper = this._upper || []
    upper.forEach((u) => { if (keys.indexOf(u.floor) < 0) keys.push(u.floor) })
    // 后端没给楼上科室时，退回导诊知识库里的楼层（同一份真实数据，不是编造）
    if (!upper.length) {
      Object.keys(DEPT_INFO).forEach((k) => {
        const fk = floorKey(DEPT_INFO[k].floor)
        if (fk && keys.indexOf(fk) < 0) keys.push(fk)
      })
    }
    keys.sort()
    this._floors = keys
    this.setData({
      floors: keys.map((k) => ({ key: k, label: k })),
      floorStrip: keys.join('/')
    })
  },

  /** 指定楼层上的科室名（后端优先，缺失时用导诊知识库） */
  _deptsOnFloor(fk) {
    const upper = this._upper || []
    const fromApi = upper.filter((u) => u.floor === fk).map((u) => u.name)
    if (fromApi.length) return fromApi
    return Object.keys(DEPT_INFO)
      .filter((k) => floorKey(DEPT_INFO[k].floor) === fk)
      .map((k) => k)
  },

  // ================= 楼层切换 =================

  onToggleFloorPick() {
    this.setData({ floorPick: !this.data.floorPick })
  },

  onPickFloor(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const num = parseInt(String(key).replace(/[^\d]/g, ''), 10) || 1
    const names = key === '1F' ? [] : this._deptsOnFloor(key)
    this.setData({
      floorSel: key,
      floorPick: false,
      floorDepts: names,
      floorDeptsText: names.slice(0, 6).join('、') + (names.length > 6 ? ' 等' : ''),
      floorSelNum: num
    })
    if (key === '1F') this._draw()
  },

  onBackTo1F() {
    this.setData({ floorSel: '1F', floorPick: false })
    this._draw()
  },

  // ================= 目的地弹层 =================

  onOpenPicker() {
    this._filter()
    this.setData({ pickerOpen: true, floorPick: false })
  },

  onClosePicker() {
    this.setData({ pickerOpen: false })
  },

  onSearchInput(e) {
    this.setData({ q: e.detail.value || '' }, () => this._filter())
  },

  /** 搜索按钮：立即按当前关键词过滤；只有一个结果时直接选中（少点一次） */
  onSearch() {
    this._filter()
    const list = this.data.list
    if (list.length === 1) this.onPickItem({ currentTarget: { dataset: { id: list[0].id } } })
  },

  onHotWord(e) {
    const w = e.currentTarget.dataset.w
    this.setData({ q: w }, () => this._filter())
  },

  onCat(e) {
    this.setData({ cat: e.currentTarget.dataset.c }, () => this._filter())
  },

  /** 过滤：分类 → 关键词（名称/分类/描述/俗称别名） */
  _filter() {
    const raw = String(this.data.q || '').trim().toLowerCase()
    const cat = this.data.cat
    let list = this._all.slice()
    if (cat !== '全部') list = list.filter((d) => d.category === cat)
    if (raw) {
      const keys = [raw]
      if (ALIAS[raw]) keys.push(ALIAS[raw])
      list = list.filter((d) => {
        const hay = [d.label, d.name, d.category, d.desc].join(' ').toLowerCase()
        return keys.some((k) => hay.indexOf(k) >= 0)
      })
    }
    this.setData({ list })
  },

  onPickItem(e) {
    const id = e.currentTarget.dataset.id
    const d = this._all.filter((x) => x.id === id)[0]
    if (d) this._pick(d)
  },

  // ================= 选中目的地 / 深链 =================

  _pick(d) {
    const steps = d.steps || []
    this.setData({
      active: d,
      activeLabel: d.label || d.name,
      activeFloor: d.floor || '1F',
      // 门诊目的地附「先取号」提示：字段早已算在每条数据上（_all 的 needRegister），
      // 但 WXML 一直没渲染（审查 P2-19）；这里把它带到顶层给信息卡用。
      needRegister: !!d.needRegister,
      steps,
      floorTip: '',
      speaking: false,
      pickerOpen: false,
      // 「当前楼层」跟着目的地走：去 2F 的科室时，用户至少知道自己在找几楼
      floorSel: '1F',
      floorPick: false
    }, () => {
      // 选中后回到全览：整条路线一眼看全（设计稿也是全览 + 路线）
      this._fitView()
      this._animateRoute()
    })
  },

  /**
   * 科室名 → 带路方案（**纯函数**，不碰页面状态；tools/test-triage.js 直接调它守产品承诺）
   *   ① 2F/3F/4F 的科室在 1F 平面图上没有房间 → 先带到「电梯厅」出 1F 段路线，
   *      并在路线详情里写清「上几楼」换层指引；
   *   ② 1F 有房间的科室 → 精确/规则匹配到房间；
   *   ③ 急诊科不给带路（绿色通道独立入口），返回 null 由调用方单独给指引。
   * @returns {Object|null} { dest, floorTip }
   */
  _resolveDept(name) {
    const raw = String(name || '').trim()
    if (!raw) return null
    const info = this._deptInfo(raw)
    const fk = info ? floorKey(info.floor) : ''
    if (fk && fk !== '1F') {
      const hub = this._all.filter((d) => d.id === 'elevator')[0]
      if (hub) {
        return {
          dest: hub,
          floorTip: '「' + raw + '」在' + info.floor + '：请先在「挂号 / 缴费」窗口取号，'
            + '再按下方路线到「电梯厅」，乘电梯上 ' + fk.replace('F', '') + ' 楼后按楼层指示牌找到诊室'
        }
      }
    }
    const dest = this._matchDept(raw)
    return dest ? { dest: dest, floorTip: '' } : null
  },

  _applyDeepLink(name) {
    const raw = String(name || '').trim()
    if (!raw) return
    const hit = this._resolveDept(raw)
    if (hit) {
      this._pick(hit.dest)
      this.setData({
        activeLabel: raw,
        activeFloor: hit.floorTip ? (String(hit.dest.floor || '1F')) : '1F',
        floorTip: hit.floorTip
      })
      return
    }
    if (/急诊|抢救|120/.test(raw)) {
      // 急诊是独立绿色通道（不在门诊楼 1F 平面图内）—— 给明确指引，不显示"未找到"
      wx.showToast({ title: '急诊走大门旁绿色通道，不在本层平面图内', icon: 'none', duration: 3000 })
      return
    }
    wx.showToast({ title: '未找到「' + raw + '」的位置，请手动选择目的地', icon: 'none', duration: 2600 })
  },

  _matchDept(name) {
    const raw = String(name || '').trim()
    if (!raw) return null
    const byId = (id) => this._all.filter((d) => d.id === id)[0] || null
    const short = (d) => d.name.replace('（取药）', '')
    if (DEPT_MAP[raw]) {
      const hit = byId(DEPT_MAP[raw])
      if (hit) return hit
    }
    for (let i = 0; i < DEPT_RULES.length; i++) {
      if (DEPT_RULES[i][0].test(raw)) {
        const hit = byId(DEPT_RULES[i][1])
        if (hit) return hit
      }
    }
    return this._all.filter((d) => raw.indexOf(short(d)) >= 0 || short(d).indexOf(raw) >= 0)[0] || null
  },

  _deptInfo(name) {
    const s = String(name || '').trim().replace(/门诊$/, '')
    if (!s) return null
    if (DEPT_INFO[s]) return DEPT_INFO[s]
    const keys = Object.keys(DEPT_INFO)
    for (let i = 0; i < keys.length; i++) {
      if (s.indexOf(keys[i]) >= 0 || keys[i].indexOf(s) >= 0) return DEPT_INFO[keys[i]]
    }
    return null
  },

  // ================= Canvas 初始化 =================
  _initCanvas(cb) {
    wx.createSelectorQuery().in(this).select('#nvmap').fields({ node: true, size: true }).exec((res) => {
      const r = res && res[0]
      if (!r || !r.node) {
        wx.showToast({ title: '当前环境不支持地图渲染，请升级微信后重试', icon: 'none' })
        return
      }
      const canvas = r.node
      let dpr = 2
      try {
        const info = wx.getWindowInfo()
        dpr = Math.min(2, info.pixelRatio || 2)   // dpr≤2，控制总像素
      } catch (e) {}
      canvas.width = Math.round(r.width * dpr)
      canvas.height = Math.round(r.height * dpr)
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      this._canvas = canvas
      this._ctx = ctx
      this._dpr = dpr
      this._vw = r.width
      this._vh = r.height

      if (this._img) { cb && cb(); return }
      const img = canvas.createImage()
      img.onload = () => { this._img = img; cb && cb() }
      img.onerror = () => {
        if (this._imgTried) { wx.showToast({ title: '平面图加载失败，请检查分包资源', icon: 'none' }); return }
        this._imgTried = true
        img.src = '../../assets/floor1.png'  // 兜底：相对本页路径
      }
      img.src = MAP.FLOOR.image
    })
  },

  _relayout() {
    if (!this._canvas) return
    wx.createSelectorQuery().in(this).select('#nvmap').fields({ node: true, size: true }).exec((res) => {
      const r = res && res[0]
      if (!r || !r.node || !r.width || !r.height) return
      const canvas = r.node
      canvas.width = Math.round(r.width * this._dpr)
      canvas.height = Math.round(r.height * this._dpr)
      this._vw = r.width
      this._vh = r.height
      const ctx = canvas.getContext('2d')
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0)
      this._ctx = ctx
      this._fitView()
      this._draw()
    })
  },

  // ================= 视图（缩放 / 平移）=================
  _fitScale() {
    return Math.min(this._vw / MAP.FLOOR.baseW, this._vh / MAP.FLOOR.baseH)
  },

  _clampView() {
    const v = this._view
    const w = MAP.FLOOR.baseW * v.scale
    const h = MAP.FLOOR.baseH * v.scale
    if (w <= this._vw) v.tx = (this._vw - w) / 2
    else v.tx = Math.min(0, Math.max(this._vw - w, v.tx))
    if (h <= this._vh) v.ty = (this._vh - h) / 2
    else v.ty = Math.min(0, Math.max(this._vh - h, v.ty))
  },

  /** 全览：整张平面图放进画布（等比，居中） */
  _fitView() {
    const v = this._view
    v.scale = Math.max(0.2, Math.min(1, this._fitScale()))
    v.tx = (this._vw - MAP.FLOOR.baseW * v.scale) / 2
    v.ty = (this._vh - MAP.FLOOR.baseH * v.scale) / 2
    this._clampView()
  },

  /** 以某个屏幕点为锚点缩放（锚点下的平面图位置保持不动） */
  _zoomAt(nextScale, ax, ay) {
    const v = this._view
    const s2 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextScale))
    if (s2 === v.scale) return
    const mx = (ax - v.tx) / v.scale
    const my = (ay - v.ty) / v.scale
    v.scale = s2
    v.tx = ax - mx * s2
    v.ty = ay - my * s2
    this._clampView()
    this._draw()
  },

  onZoomIn() { this._zoomAt(this._view.scale + ZOOM_STEP, this._vw / 2, this._vh / 2) },

  onZoomOut() { this._zoomAt(this._view.scale - ZOOM_STEP, this._vw / 2, this._vh / 2) },

  /** 回到当前位置：把「医院大门」移到视野中心，并放大到能看清周边（全览的 1.7 倍） */
  onLocate() {
    if (!this._ctx) return
    const target = Math.min(ZOOM_MAX, Math.max(this._fitScale() * 1.7, ZOOM_MIN))
    this._view.scale = target
    this._centerOn(MAP.ORIGIN.x, MAP.ORIGIN.y, 0.5)
  },

  /** 把平面图坐标点移到视野中心（biasY：纵向落点比例，0.5 = 正中） */
  _centerOn(xPct, yPct, biasY) {
    const v = this._view
    const k = typeof biasY === 'number' ? biasY : 0.5
    const px = xPct / 100 * MAP.FLOOR.baseW
    const py = yPct / 100 * MAP.FLOOR.baseH
    v.tx = this._vw / 2 - px * v.scale
    v.ty = this._vh * k - py * v.scale
    this._clampView()
    this._draw()
  },

  // ================= 手势 =================
  onTouchStart(e) {
    // 手指落在地图上 = 收起楼层 tab 面板（否则它只能靠再点一次胶囊关掉）
    if (this.data.floorPick) this.setData({ floorPick: false })
    const ts = e.touches || []
    if (ts.length === 1) {
      this._moved = false
      this._start = { x: ts[0].x, y: ts[0].y }
      this._last = { x: ts[0].x, y: ts[0].y }
      this._pinch = null
    } else if (ts.length >= 2) {
      const a = ts[0]
      const b = ts[1]
      this._pinch = {
        d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        scale: this._view.scale,
        tx: this._view.tx,
        ty: this._view.ty
      }
    }
  },

  onTouchMove(e) {
    const ts = e.touches || []
    const v = this._view
    if (ts.length >= 2 && this._pinch) {
      const a = ts[0]
      const b = ts[1]
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this._pinch.scale * (d / this._pinch.d)))
      const mx = (mid.x - this._pinch.tx) / this._pinch.scale
      const my = (mid.y - this._pinch.ty) / this._pinch.scale
      v.scale = next
      v.tx = mid.x - mx * next
      v.ty = mid.y - my * next
      this._clampView()
      this._draw()
      return
    }
    if (ts.length === 1 && this._last && !this._pinch) {
      const dx = ts[0].x - this._last.x
      const dy = ts[0].y - this._last.y
      this._last = { x: ts[0].x, y: ts[0].y }
      if (this._start && (Math.abs(ts[0].x - this._start.x) + Math.abs(ts[0].y - this._start.y) > 8)) {
        this._moved = true
      }
      v.tx += dx
      v.ty += dy
      this._clampView()
      this._draw()
    }
  },

  onTouchEnd() {
    if (this._pinch) {
      this._pinch = null
      this._last = null
      return
    }
    // 点击（位移很小）→ 命中检测圆点
    if (!this._moved && this._start) this._hitTest(this._start.x, this._start.y)
    this._last = null
    this._start = null
  },

  _hitTest(sx, sy) {
    const v = this._view
    const px = (sx - v.tx) / v.scale
    const py = (sy - v.ty) / v.scale
    const R = 30 / v.scale   // 命中半径：屏幕上 30px，手指点得准
    let best = null
    let bestD = R
    this._all.forEach((d) => {
      const dx = d.x / 100 * MAP.FLOOR.baseW - px
      const dy = d.y / 100 * MAP.FLOOR.baseH - py
      const dist = Math.hypot(dx, dy)
      if (dist < bestD) { bestD = dist; best = d }
    })
    if (best) {
      if (this.data.active && this.data.active.id === best.id) return
      this._pick(best)
    }
  },

  // ================= 路径动画 =================
  _route() {
    const d = this.data.active
    if (!d || !d.path) return null
    return d.path.map((p) => [p[0] / 100 * MAP.FLOOR.baseW, p[1] / 100 * MAP.FLOOR.baseH])
  },

  _animateRoute() {
    const route = this._route()
    if (!route) { this._draw(); return }
    const t0 = Date.now()
    const DUR = 800
    this._animStop = false
    const step = () => {
      if (this._animStop || !this._ctx) return
      const p = Math.min(1, (Date.now() - t0) / DUR)
      this._draw(p)
      if (p < 1) this._raf(step)
      else this._draw(1)
    }
    this._raf(step)
  },

  _raf(cb) {
    if (this._canvas && typeof this._canvas.requestAnimationFrame === 'function') {
      this._canvas.requestAnimationFrame(cb)
    } else {
      setTimeout(cb, 16)
    }
  },

  // ================= 绘制 =================
  _draw(progress) {
    const ctx = this._ctx
    if (!ctx) return
    const v = this._view
    const W = MAP.FLOOR.baseW
    const H = MAP.FLOOR.baseH

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0)
    // 图纸底色（设计稿：图卡里是一整张浅灰蓝"图纸"，不是白底）
    ctx.fillStyle = C.paper
    ctx.fillRect(0, 0, this._vw, this._vh)

    ctx.save()
    ctx.translate(v.tx, v.ty)
    ctx.scale(v.scale, v.scale)

    if (this._img) ctx.drawImage(this._img, 0, 0, W, H)

    const route = this._route()
    if (route) {
      this._drawRoute(ctx, route, typeof progress === 'number' ? progress : 1)
      this._drawOrigin(ctx, true)
      this._drawTarget(ctx, route[route.length - 1])
    } else {
      this._drawIdleDots(ctx)
      this._drawOrigin(ctx, false)
    }
    this._drawEntry(ctx)

    ctx.restore()
  },

  /** 蓝色主路线 + 中段方向箭头（设计稿：实心蓝线，圆角拐点，无光晕） */
  _drawRoute(ctx, pts, progress) {
    const s = this._view.scale
    const lineW = 5.4 / s
    const segs = []
    let total = 0
    for (let i = 0; i < pts.length - 1; i++) {
      const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
      segs.push(L)
      total += L
    }
    if (total <= 0) return

    const target = total * progress
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = C.primary
    ctx.lineWidth = lineW
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    let acc = 0
    for (let i = 0; i < segs.length; i++) {
      if (acc + segs[i] <= target) {
        ctx.lineTo(pts[i + 1][0], pts[i + 1][1])
        acc += segs[i]
      } else {
        const r = (target - acc) / segs[i]
        ctx.lineTo(
          pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r,
          pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r
        )
        break
      }
    }
    ctx.stroke()

    // 方向箭头：只在画完时画，且只落在"屏幕上够长"的段中点（短线塞箭头反而乱）
    if (progress >= 1) {
      for (let i = 0; i < segs.length; i++) {
        if (segs[i] * s < 70) continue
        const a = pts[i]
        const b = pts[i + 1]
        this._arrow(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, b[0] - a[0], b[1] - a[1], 6.5 / s)
      }
    }
  },

  _arrow(ctx, x, y, dx, dy, size) {
    const L = Math.hypot(dx, dy) || 1
    const ux = dx / L
    const uy = dy / L
    const nx = -uy
    const ny = ux
    ctx.beginPath()
    ctx.moveTo(x + ux * size * 1.5, y + uy * size * 1.5)
    ctx.lineTo(x - ux * size + nx * size, y - uy * size + ny * size)
    ctx.lineTo(x - ux * size - nx * size, y - uy * size - ny * size)
    ctx.closePath()
    ctx.fillStyle = C.primary
    ctx.fill()
  },

  /** 起点（医院大门）：浅蓝光晕 + 白圈 + 蓝心（设计稿入口标记，直径约 2 倍线宽） */
  _drawOrigin(ctx, hasRoute) {
    const s = this._view.scale
    const x = MAP.ORIGIN.x / 100 * MAP.FLOOR.baseW
    const y = MAP.ORIGIN.y / 100 * MAP.FLOOR.baseH
    const glow = (hasRoute ? 7.5 : 6.2) / s
    ctx.beginPath()
    ctx.arc(x, y, glow, 0, Math.PI * 2)
    ctx.fillStyle = C.primarySoft
    ctx.fill()

    ctx.beginPath()
    ctx.arc(x, y, 5.2 / s, 0, Math.PI * 2)
    ctx.fillStyle = C.white
    ctx.fill()

    ctx.beginPath()
    ctx.arc(x, y, 2.8 / s, 0, Math.PI * 2)
    ctx.fillStyle = C.primary
    ctx.fill()
  },

  /** 终点：蓝色实心点 + 白圈，上方旗帜气泡（设计稿） */
  _drawTarget(ctx, pt) {
    const s = this._view.scale
    const x = pt[0]
    const y = pt[1]

    ctx.beginPath()
    ctx.arc(x, y, 7 / s, 0, Math.PI * 2)
    ctx.fillStyle = C.white
    ctx.fill()

    ctx.beginPath()
    ctx.arc(x, y, 4.6 / s, 0, Math.PI * 2)
    ctx.fillStyle = C.primary
    ctx.fill()

    this._drawBubble(ctx, x, y, this.data.active ? this.data.active.name.replace('（取药）', '') : '')
  },

  /** 未选目的地时：把所有目的地画成小圆点（设计稿的"已选"态不画它们） */
  _drawIdleDots(ctx) {
    const s = this._view.scale
    const activeId = this.data.active ? this.data.active.id : ''
    this._all.forEach((d) => {
      if (d.id === activeId) return
      const x = d.x / 100 * MAP.FLOOR.baseW
      const y = d.y / 100 * MAP.FLOOR.baseH
      ctx.beginPath()
      ctx.arc(x, y, 4.6 / s, 0, Math.PI * 2)
      ctx.fillStyle = C.white
      ctx.fill()
      ctx.lineWidth = 2.4 / s
      ctx.strokeStyle = d.color
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(x, y, 2 / s, 0, Math.PI * 2)
      ctx.fillStyle = d.color
      ctx.fill()
    })
  },

  /** 起点下方的「入口」标注（设计稿）
   *  ⚠️ 纵向锚在**平面图下沿**（baseH）再往下 16px，而不是锚在起点圆点上：
   *     底图自身在大门处已印了「医院大门」四个字，锚在圆点上会与它重叠。 */
  _drawEntry(ctx) {
    const s = this._view.scale
    const x = MAP.ORIGIN.x / 100 * MAP.FLOOR.baseW
    const f = 16 / s
    ctx.font = '700 ' + f + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = C.textMain
    ctx.fillText('入口', x, MAP.FLOOR.baseH + 16 / s)
    ctx.textAlign = 'left'
  },

  /** 终点旗帜气泡：白底圆角 + 蓝旗 + 蓝色科名 + 指向终点的小尾巴 */
  _drawBubble(ctx, x, y, text) {
    if (!text) return
    const s = this._view.scale
    const f = 15 / s
    const iconW = 15 / s
    const iconGap = 7 / s
    const padX = 13 / s
    const padY = 10 / s
    const lineH = 19 / s

    ctx.font = '700 ' + f + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
    const tw = ctx.measureText(text).width
    const bw = padX * 2 + iconW + iconGap + tw
    const bh = lineH + padY * 2

    let bx = x - bw / 2
    let by = y - 14 / s - bh
    let below = false
    // 气泡超出画布上沿时翻到终点下方（否则科名会被裁掉）
    if (by * s < 2) {
      by = y + 14 / s
      below = true
    }
    // 左右贴边时往画布内推
    if (bx * s < 4) bx = 4 / s
    if ((bx + bw) * s > this._vw - 4) bx = (this._vw - 4) / s - bw

    ctx.save()
    ctx.shadowColor = C.shadow
    ctx.shadowBlur = 10 / s
    ctx.shadowOffsetY = 2 / s
    this._roundRect(ctx, bx, by, bw, bh, 8 / s)
    ctx.fillStyle = C.white
    ctx.fill()
    ctx.restore()

    // 尾巴（指向终点的小三角）
    const tipX = x
    const baseY = below ? by : by + bh
    const dir = below ? -1 : 1
    const tailW = 6 / s
    const tailH = 7 / s
    ctx.beginPath()
    ctx.moveTo(tipX - tailW, baseY)
    ctx.lineTo(tipX + tailW, baseY)
    ctx.lineTo(tipX, baseY + tailH * dir)
    ctx.closePath()
    ctx.fillStyle = C.white
    ctx.fill()

    // 蓝旗（旗杆 + 三角旗）
    const px0 = bx + padX
    const cy = by + bh / 2
    ctx.strokeStyle = C.primary
    ctx.lineWidth = 2.2 / s
    ctx.beginPath()
    ctx.moveTo(px0 + 2 / s, cy - iconW / 2)
    ctx.lineTo(px0 + 2 / s, cy + iconW / 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(px0 + 2 / s, cy - iconW / 2)
    ctx.lineTo(px0 + iconW, cy - iconW / 2 + iconW * 0.28)
    ctx.lineTo(px0 + 2 / s, cy - iconW / 2 + iconW * 0.56)
    ctx.closePath()
    ctx.fillStyle = C.primary
    ctx.fill()

    // 科名
    ctx.fillStyle = C.primary
    ctx.textBaseline = 'middle'
    ctx.fillText(text, px0 + iconW + iconGap, cy)
  },

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
  },

  // ================= 语音播报 =================
  onSpeak() {
    const d = this.data.active
    if (!d) {
      wx.showToast({ title: '请先选择目的地', icon: 'none' })
      return
    }
    if (this.data.speaking) {
      speech.stopSpeak()
      this.setData({ speaking: false })
      return
    }
    const steps = this.data.steps || []
    const text = '前往' + (this.data.activeLabel || d.name) + '。' + (this.data.floorTip ? this.data.floorTip + '。' : '') + steps.join('，')
    this.setData({ speaking: true })
    // ⚠️ 首次合成要等后端预热（20~30s），必须给可见反馈，否则用户以为"点了没反应"
    wx.showToast({ title: '正在合成语音…', icon: 'none', duration: 2000 })
    speech.speak(text, {
      onEnd: () => this.setData({ speaking: false }),
      onError: (msg) => {
        this.setData({ speaking: false })
        wx.showToast({ title: msg || '语音播报不可用，请按文字指引前往', icon: 'none', duration: 2500 })
      },
      onDegraded: () => wx.showToast({ title: '当前为占位音质，可在设置中换音色', icon: 'none', duration: 2000 })
    })
  }
})
