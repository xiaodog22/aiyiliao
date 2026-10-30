/**
 * pages/home —— 患者端首页（V1.16 版式对齐设计参考图）
 * 登录守卫：未登录强制回登录页；医生角色不允许进入患者首页
 */
const app = getApp()
const icons = require('../../utils/icons.js')
// 科普内容库在主包（utils/），视频本体在分包 packageContent（避免撑爆 2MB 主包）
const KB = require('../../utils/knowledge-kb.js')
// 预约日期徽章解析（VF-11）：纯函数放 utils/ 才能被 tools/test-apt-date.js 单测
const { parseAptDate } = require('../../utils/apt-date.js')
// 预约状态枚举 → 中文（契约英文枚举，历史页面写死中文已失效）
const { aptStatusText } = require('../../utils/apt-status.js')
// 时间展示：契约 ISO Instant → 设备本地日期/时间
const { fmtLocalDateTime } = require('../../utils/datetime.js')
// 首页汇总走后端契约（GET /api/v1/home/summary）；禁止再恒定展示 app.MOCK.HOME
const homeService = require('../../services/home.js')
// 远端素材清单（服务端「清单下发绝对 HTTPS URL」→ 页面远端优先、包内兜底）
const resource = require('../../services/resource.js')
const ENV = require('../../config/env.js')

/* ============================================================
   首页配置 —— 改首页内容只动这里，不用碰 WXML。
   ⚠️ 改动结构后请同步 tools/preview-pad-pages.js 的首页静态骨架（预览/实测靠它）。
   · tint：图标底色调 blue/green/amber/purple/red（样式见 home.wxss 的 .hm-tile-*）
   · key ：点击去向，统一由 _route() 解析 —— 页面路径不散落在 WXML 里
   ============================================================ */

/* 设计交付素材（tools/build-home-assets.py 从交付图裁切/抠圆生成）：
   · doctor  小安 3D 头像（圆形透明底）        · banner 智能导诊 banner 的医院插画
   · svc-*   常用服务 8 个图标（自带浅蓝圆底）
   ⚠️ 全部必须在**主包** assets/home/ 下：首页在主包，引用分包资源会在分包未下载时裂图。 */
const A = {
  doctor: '/assets/home/ai-doctor.png',
  banner: '/assets/home/banner-hospital.jpg',
  svc: '/assets/home/svc-'
}

/* 四宫格与设计效果图 01-首页.png 一致：
   AI 智能导诊 / 预约挂号 / 在线问诊(薄荷底) / 报告查询 */
const QUAD = [
  { key: 'triage', icon: 'stethoscope', tint: 'blue', title: 'AI 智能导诊', desc: '智能推荐科室医生' },
  { key: 'appoint', icon: 'calendar', tint: 'blue', title: '预约挂号', desc: '预约专家门诊' },
  { key: 'consult', icon: 'chat', tint: 'mint', title: '在线问诊', desc: '图文电话咨询' },
  { key: 'reports', icon: 'fileText', tint: 'blue', title: '报告查询', desc: '检验检查结果' }
]

/* 常用服务（4 列 × 2 行）—— 图标走素材，命名约定 svc-<key>.png（改 key 就要改文件名） */
const SERVICES = [
  { key: 'triage', name: '智能导诊' },
  { key: 'doctor', name: '找医生' },
  { key: 'dept', name: '找科室' },
  { key: 'archive', name: '健康档案' },
  { key: 'checkup', name: '体检服务' },
  { key: 'care', name: '居家护理' },
  { key: 'advice', name: '健康咨询' },
  { key: 'more', name: '更多服务' }
].map((it) => Object.assign(it, { img: A.svc + it.key + '.png' }))

/* 一句话症状快选词（与参考图一致）：
   点了直接进导诊页并自动出结论 —— triage 页支持 ?text= 预填，见 _route('triage', text)。 */
const QUICK_SYMPTOMS = ['咳嗽', '头晕', '睡眠不好']

/* 大字档副问候语（设计稿 08-适老化首页）：固定页面文案，不伪造后端问候 */
const SUB_GREETING_LARGE = '今天感觉怎么样？'

/* 「更多服务」/「全部服务」共用的动作面板。
   项目里没有"服务大全"页，与其编造跳转目标，不如把真实入口列出来给用户选。 */
const MORE_MENU = ['智能导诊', '预约挂号', '院内导航', '健康科普', 'AI 问诊', 'AI 养生']
const MORE_ROUTE = ['triage', 'appoint', 'nav', 'knowledge', 'consult', 'health']

/* 后端/页面都还没有的服务 → 给中文说明，不做假跳转（内容红线：不许伪造） */
const NOT_READY = { checkup: '体检服务', care: '居家护理' }

/** 把配置里的图标键解析成真实 PNG 路径（WXML 里不能写 icons[item.icon]） */
function withIcon(list) {
  return list.map((it) => Object.assign({}, it, { iconPath: icons[it.icon] || icons.info }))
}

Page({
  data: {
    theme: 'standard',
    patient: { name: '' },
    // 主问候语（姓名 + 您好）：姓名缺失时退化为「您好！」，不出现「，您好！」这种破句
    greetText: '您好！',
    // 副问候语：标准档=后端 greeting；大字档=设计稿 08 固定文案
    subText: '',
    home: { greeting: '', appointment: {} },
    // 是否展示预约动态卡（数据源=后端 NEXT_APPOINTMENT 块；无数据/未返回时不伪造）
    hasApt: false,
    // 汇总加载/失败态：没有它，生产档弱网下"没挂号"和"加载失败"长得一模一样（审查 P2-07）
    aptLoading: true,
    aptError: '',
    // 预约日期徽章（VF-11）：解析成功 = {mon,day,week}；失败 = null → WXML 回退整行文本
    aptDate: null,
    quad: withIcon(QUAD),
    services: SERVICES,
    quickSymptoms: QUICK_SYMPTOMS,
    tip: null,
    kbVideos: [],
    icons,
    A
  },

  onShow() {
    // 登录守卫
    const role = app.globalData.role
    if (!role) {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    if (role === 'doctor') {
      wx.reLaunch({ url: '/pages/doctor/workbench/workbench' })
      return
    }
    const theme = app.globalData.theme || 'standard'
    // 适老/超大字档：问候与副问候按设计稿 08（「您好」+「今天感觉怎么样？」）
    const isLarge = theme === 'large' || theme === 'xlarge'
    // 自绘 TabBar 高亮当前项（自动适配标准4项/适老3项）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().selectByPath('/pages/home/home')
    }
    // 患者信息只信登录下发的全局态；演示兜底仅在 MOCK_FALLBACK 档（生产档不留固定前端数据）
    const patient = Object.assign({}, app.globalData.user || (ENV.MOCK_FALLBACK ? app.MOCK.PATIENT : { name: '' }))
    // 头像兜底：登录态用户对象可能缺 avatarText，取姓名首字，避免空圆
    if (!patient.avatarText) patient.avatarText = (patient.name || '我').slice(0, 1)
    this.setData({
      theme,
      patient,
      // 主问候语：参考图为一句大号问候（「您好，今天感觉怎么样？」），
      // 本项目把「姓名 + 您好」作为主句、后端 greeting（早上好/下午好…）作为副句，
      // 名字缺失时退化为「您好！」，避免出现「，您好！」。
      greetText: isLarge ? '您好' : (patient.name ? patient.name + '，您好！' : '您好！'),
      subText: isLarge ? SUB_GREETING_LARGE : '',
      // ⚠️ 首页属于主包，**不能引用分包 packageContent 内的封面图**（分包未下载时会裂图），
      // 所以这里只取图标 + 文字；封面与视频本体在详情/列表页（同包）里用。
      kbVideos: KB.VIDEOS.map((v) => ({
        id: v.id,
        title: v.title,
        durationSec: v.durationSec,
        iconPath: icons[v.icon] || icons.video
      }))
    })
    // 小贴士只在首次进入时定一条；用户点过"换一条"后再回到首页不重置（否则白点）
    if (!this.data.tip) this._tipAt(0)
    // 首页汇总（问候语 + 预约动态）每次 onShow 刷新：新预约提交后回首页立即能看到
    this._loadSummary()
    // 远端素材每次 onShow 重新解析：清单由 app.js 冷启动时异步刷新，
    // 首次进入时可能还没到（此时仍是包内路径），回到本页即自动切到远端。
    this._applyRemoteAssets()
  },

  /* ==================== 远端素材（清单远端优先 → 包内兜底）==================== */
  /**
   * 把 A.banner / A.doctor 换成清单下发的绝对 HTTPS（若已就绪）。
   *
   * 为什么不做成"一次性初始化"：`app.js` 的 `resource.refreshManifest()` 是异步且静默的，
   * 冷启动首屏几乎一定拿不到清单。用 onShow 重试是最省事的收敛方式——
   * 拿到就切远端，拿不到继续用包内图，**任何时刻都不会裂图**。
   * 兜底值取自常量 A（包内路径），不是 `this.data.A`（可能已被远端覆盖）。
   */
  _applyRemoteAssets() {
    const remote = {
      banner: resource.resolveResource('home.banner-hospital', A.banner),
      doctor: resource.resolveResource('home.ai-doctor', A.doctor)
    }
    const cur = this.data.A || {}
    if (cur.banner === remote.banner && cur.doctor === remote.doctor) return
    this.setData({ A: Object.assign({}, cur, remote) })
  },

  /**
   * 远端图加载失败 → 回退包内素材（不显示灰块）。
   * `<image>` 没有"自动重试"能力，binderror 是唯一可观测的失败信号。
   */
  onBannerError() {
    if (this.data.A && this.data.A.banner !== A.banner) {
      this.setData({ 'A.banner': A.banner })
    }
  },

  /* ==================== 首页汇总（契约 GET /api/v1/home/summary）==================== */
  /**
   * 问候语与预约动态全部来自后端；失败时：
   *   - 开发档（MOCK_FALLBACK=true）→ 演示数据兜底，演示流程不中断；
   *   - 生产档 → 空态（"暂无待就诊预约"），绝不展示伪造数据。
   */
  _loadSummary() {
    // 每次进入都先回到"加载中"：预约卡不再从上一屏数据直接闪成空态
    if (!this.data.aptLoading) this.setData({ aptLoading: true, aptError: '' })
    homeService.getSummary()
      .then((s) => this._applySummary(s))
      .catch(() => this._applySummaryFailed())
  },

  /** 失败态的重试入口（生产档空态上那颗「点击重试」按钮） */
  onRetrySummary() {
    this._loadSummary()
  },

  /** 后端响应成功 → 以响应为准（无 NEXT_APPOINTMENT 块 = 无待就诊预约 → 空态，不塞演示数据） */
  _applySummary(summary) {
    const blk = summary && homeService.blockOf(summary, 'NEXT_APPOINTMENT')
    const a = (blk && blk.status !== 'unavailable' && blk.nextAppointment) || null
    let apt = null
    if (a) {
      const when = fmtLocalDateTime(a.startTime)
      apt = {
        dept: a.departmentName || '',
        doctor: a.doctorName || '',
        date: when.date,
        time: when.time,
        place: a.location || '',
        status: aptStatusText(a.status)
      }
    }
    const greeting = (summary && summary.greeting) || ''
    this.setData({
      home: { greeting, appointment: apt || {} },
      subText: this._subTextOf(greeting),
      hasApt: !!apt,
      aptLoading: false,
      aptError: '',
      aptDate: apt ? parseAptDate(apt.date) : null
    })
  },

  /** 副问候语取值：大字档固定设计稿文案；标准档用后端 greeting（空串 = 不占位） */
  _subTextOf(greeting) {
    const t = this.data.theme
    return (t === 'large' || t === 'xlarge') ? SUB_GREETING_LARGE : (greeting || '')
  },

  /** 请求失败 → 开发档演示兜底 / 生产档错误态（可重试，不假装"没挂号"） */
  _applySummaryFailed() {
    if (ENV.MOCK_FALLBACK) {
      this.setData({
        home: app.MOCK.HOME,
        subText: this._subTextOf(app.MOCK.HOME.greeting),
        hasApt: true,
        aptLoading: false,
        aptError: '',
        aptDate: parseAptDate((app.MOCK.HOME.appointment || {}).date)
      })
    } else {
      this.setData({
        home: { greeting: '', appointment: {} },
        subText: this._subTextOf(''),
        hasApt: false,
        aptLoading: false,
        // 中文说明走页面常量，不回显 err.message（RULE #13）
        aptError: '就医安排加载失败，请点击重试',
        aptDate: null
      })
    }
  },

  /* ==================== 入口路由（所有 key 的唯一定义处）==================== */
  _route(key, text) {
    switch (key) {
      case 'triage':
        // 带 text 时导诊页会自动分析出结论（首页快选词/搜索条走这条）
        wx.navigateTo({ url: '/pages/triage/triage' + (text ? '?text=' + encodeURIComponent(text) : '') })
        break
      case 'appoint':
      case 'doctor':
        // appointment 是 tabBar 页（app.json tabBar 第 3 项）：navigateTo 会被微信静默拒绝，
        // 必须 switchTab（曾实测"点了没反应"）。switchTab 不带参：预选科室走 wb_appoint_dept 缓存。
        wx.switchTab({ url: '/pages/appointment/appointment' })
        break
      case 'dept':
        wx.navigateTo({ url: '/pages/triage/triage' })
        break
      case 'health':
        // health 已不在 tabBar（现 tab = home/问诊/挂号/我的）→ 只能 navigateTo，switchTab 会失败
        wx.navigateTo({ url: '/pages/health/health' })
        break
      case 'consult':
      case 'advice':
        // 在线咨询 = 先选医生，再进入医患图文会话（picker → consult?doctorId=…）
        wx.navigateTo({ url: '/pages/consult/picker/picker' })
        break
      case 'reports':
        wx.navigateTo({ url: '/pages/profile/health-records/health-records' })
        break
      case 'archive':
        // 与同屏的「报告查询」保持一致：直达健康档案页。
        // 原来 switchTab 到「我的」Tab，要用户再点一次才到档案（审查 P2-04）。
        wx.navigateTo({ url: '/pages/profile/health-records/health-records' })
        break
      case 'checkup':
      case 'care':
        // 后端与页面都还没有这两项服务 → 给中文说明，不做假跳转。
        // ⚠️ NOT_READY 此前定义了却零引用，两个入口落进 default 静默无反应（审查 P1-03）。
        wx.showModal({
          title: NOT_READY[key],
          content: '该服务正在筹备中，敬请期待。如需体检或居家护理咨询，可先到「健康咨询」留言。',
          showCancel: false,
          confirmText: '知道了'
        })
        break
      case 'nav':
        wx.navigateTo({ url: '/packageNav/pages/nav/nav' })
        break
      case 'knowledge':
        wx.navigateTo({ url: '/packageContent/pages/knowledge/knowledge' })
        break
      case 'more':
        this.onMore()
        break
      default:
        break
    }
  },

  // 四宫格 / 常用服务（同一个 handler，靠 data-key 区分）
  onRoute(e) {
    this._route(e.currentTarget.dataset.key)
  },

  // 更多服务 / 全部服务：列出真实入口
  onMore() {
    wx.showActionSheet({
      itemList: MORE_MENU,
      success: (res) => this._route(MORE_ROUTE[res.tapIndex]),
      // 用户自己取消，不提示（不是错误）
      fail: () => {}
    })
  },

  /* ==================== 导诊入口 ==================== */
  // 搜索条 / 小安头像 / banner：进导诊页
  goTriage() {
    this._route('triage')
  },

  // 症状快选词：带文本进导诊页，进去就出结论
  onQuickChip(e) {
    this._route('triage', e.currentTarget.dataset.text)
  },

  /* ==================== 健康小贴士 ==================== */
  /** 取第 (当前 + step) 条文章做贴士；用内容库真实文章，不编造健康建议 */
  _tipAt(step) {
    const list = KB.ARTICLES || []
    if (!list.length) {
      this.setData({ tip: null })
      return
    }
    const n = list.length
    const next = (((this._tipIndex || 0) + step) % n + n) % n
    this._tipIndex = next
    const a = list[next]
    this.setData({
      tip: {
        id: a.id,
        title: a.title,
        summary: a.summary,
        // 参考图科普卡第二行为「呼吸内科 · 约3分钟阅读」——科室取内容库的 source 字段
        source: a.source || '',
        readMin: a.readMin,
        iconPath: icons[a.icon] || icons.shield
      }
    })
  },

  onTipRefresh() { this._tipAt(1) },

  onTipTap() {
    if (!this.data.tip) return
    // 详情页在分包 packageContent；首页已配 preloadRule 预下载，首屏点击通常无需等待
    wx.navigateTo({ url: '/packageContent/pages/detail/detail?id=' + this.data.tip.id })
  },

  /* ==================== 侧栏（预约动态 / 短视频 / 导航 / 科普）==================== */
  goRecords() {
    wx.navigateTo({ url: '/pages/profile/records/records' })
  },

  goNav() {
    this._route('nav')
  },

  goKnowledge() {
    this._route('knowledge')
  },

  goVideo(e) {
    wx.navigateTo({ url: '/packageContent/pages/detail/detail?id=' + e.currentTarget.dataset.id })
  }
})
