/**
 * pages/triage —— AI 智能导诊（V1.8 优化版）
 *
 * 五件事（对应需求）：
 *  ① 症状采集与自然语言理解：本地引擎逐轮抽取 部位/时长/程度/伴随/人群 槽位，
 *     每轮立刻回执「我理解到了什么」（可纠错）。
 *  ② **说完直接推荐科室**（2026-09-13 口径）：只要识别出症状归属就立刻出科室结论，
 *     不再逐轮追问；只有完全识别不出归属时才补问一个问题。
 *  ③ 基于知识库的科室匹配与分级建议：本地加权匹配 + 后端 AI（recommend-department）融合，
 *     输出主推荐/备选 + 可解释理由 + 五级分级（紧急/较急/一般/常规/居家观察）。
 *  ④ 急诊与危重识别与预警：红旗规则本地判定，**不等后端**立即红色预警 + 一键拨打 120，
 *     主推荐直接切「急诊科」，绝不建议在家观察。
 *  ⑤ 结果清晰反馈 + **路线询问**：结果卡（分级徽标 + 科室 + 理由 + 下一步）→ 立刻追问
 *     「需要我告诉您怎么去该科室吗？」→ 回答「要」直接弹到院内导诊页出路线（从医院大门开始）。
 *
 * 合规与隐私（写在页面上，不藏在文档里）：
 *  - 首次进入弹隐私告知：症状文字会发送到院内导诊服务，不上传身份信息，记录仅存本机；
 *  - 页面常驻 AI 免责小字；结果页另有完整免责声明；
 *  - 只做分诊建议，不做诊断、不给药物剂量。
 */
const app = getApp()
const icons = require('../../utils/icons.js')
const speechService = require('../../services/speech.js')
const userService = require('../../services/user.js')
const triageService = require('../../services/triage.js')
const req = require('../../services/request.js')
const { aptStatusText } = require('../../utils/apt-status.js')

const REPORT_KEY = 'wb_triage_report'

/**
 * 对话消息上限（与 consultation.js 同一口径）。
 * 超过则整体裁剪到最新 MSG_CAP 条：避免一次渲染几百条旧消息，
 * 也避免 setData 载荷随对话长度无限增长。
 */
const MSG_CAP = 60

/** 动作面板项 → 各自动作（「更多服务」用，见 onServices） */
const SERVICE_MENU = ['预约挂号', '报告查询', '来院导航', '全部服务']

function nowTime() {
  const d = new Date()
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// 姓名脱敏：刘*斌
function maskName(name) {
  const n = String(name || '').trim()
  if (!n) return '用户'
  if (n.length <= 1) return n + '*'
  return n.charAt(0) + '*'.repeat(n.length - 1)
}

// 手机号脱敏：138********8001
function maskPhone(p) {
  const s = String(p || '')
  return s.length >= 7 ? s.slice(0, 3) + '********' + s.slice(-4) : '————————'
}

Page({
  data: {
    theme: 'standard',
    icons,
    statusBarHeight: 20,
    user: { maskName: '用户', gender: '', maskId: '' },
    // 就医进度
    progress: {
      title: 'AI 导诊陪您全流程就医',
      subtitle: '暂无进行中的就医流程，咨询 AI 为您推荐科室',
      step: 1,
      hasFlow: false
    },
    messages: [],
    status: 'IDLE',
    thinkingText: 'AI 正在分析…',
    input: '',
    msgId: 0,
    recording: false,
    voiceHint: '',
    // —— 导诊专有状态 ——
    emergency: null,       // {label, advice} 常驻红色预警条
    slotsText: '',         // 已采集到的信息（顶部看板）
    rounds: 0,             // 追问轮数
    canReport: false,      // 是否已有可生成报告的结论
    lastResult: null
  },

  onLoad(options) {
    let win = {}
    try { win = wx.getWindowInfo() } catch (e) {}
    this.setData({ theme: app.globalData.theme || 'standard', statusBarHeight: win.statusBarHeight || 20 })
    this._asked = []
    this._history = []
    this._pendingNavDept = ''
    this._initUser()
    this._loadProgress()
    this._greet()
    this._privacyCheck()

    // 首页「一句话症状」入口带文本进来（?text=）→ 直接分析，省掉一次输入。
    // ⚠️ 必须在 _privacyCheck() 之后：隐私未确认时 _remoteAllowed 还是 false，
    //    此时 send() 只走本地分析、不发后端，这是我们要的顺序（不先斩后奏）。
    const preset = options && options.text ? String(options.text).trim() : ''
    if (preset) this.send(preset)
  },

  onUnload() {
    speechService.stopRecord()
    speechService.stopSpeak()
  },

  onShow() {
    const theme = app.globalData.theme || 'standard'
    if (theme !== this.data.theme) this.setData({ theme })
  },

  // 隐私告知（首次进入，用户确认后才用；拒绝则只做本地分析、不发后端）
  _privacyCheck() {
    if (triageService.hasSeenNotice()) { this._remoteAllowed = true; return }
    this._remoteAllowed = false
    wx.showModal({
      title: '隐私与数据使用说明',
      content: triageService.PRIVACY_NOTICE,
      confirmText: '同意并继续',
      cancelText: '仅本地分析',
      success: (res) => {
        if (res.confirm) {
          triageService.markNoticeSeen()
          this._remoteAllowed = true
        } else {
          this._remoteAllowed = false
          wx.showToast({ title: '已切换为仅本地分析', icon: 'none' })
        }
      }
    })
  },

  _initUser() {
    const u = app.globalData.user || userService.getUser() || {}
    this.setData({
      user: {
        maskName: maskName(u.name),
        gender: u.sex || u.gender || '',
        maskId: 'ID: ' + maskPhone(u.phone)
      }
    })
  },

  // 会话就绪前置（A6）：冷启动先用持久化的 refresh 换回 access 再发受保护请求；
  // 未登录（无 refresh）直接跳过，不再反复触发 401。
  _loadProgress() {
    req.ensureSessionReady().then((ready) => {
      if (!ready) return
      // ⚠️ 契约 GET /api/v1/appointments/me 已按认证主体在服务端过滤，客户端不再传 phone
      userService.listMyAppointments()
        .then((list) => {
          if (!list || !list.length) return
          const latest = list[list.length - 1]
          // 契约 AppointmentStatus 是英文枚举，必须经 aptStatusText 转中文再判定
          // ⚠️ 分支按契约英文枚举，不按展示文案（文案微调即静默失效，D-B-P2-03）
          const raw = String(latest.status || '').trim().toUpperCase()
          // ⚠️ 契约 Appointment 的科室字段是 **departmentName**；历史写法 latest.deptName
          //    恒为 undefined → 副标题里的科室名一直是空的（此处修正）。
          const dept = latest.departmentName || ''
          const prefix = dept ? (dept + '门诊 | ') : ''
          let step = 2
          let subtitle = ''
          if (raw === 'CONFIRMED') {
            step = 2
            subtitle = prefix + '您好！您的预约已确认，请按时到院取号'
          } else if (raw === 'CHECKED_IN') {
            step = 3
            subtitle = prefix + '您已取号，请前往诊室候诊'
          } else if (raw === 'COMPLETED') {
            step = 4
            subtitle = prefix + '本次就诊已完成，祝您早日康复'
          } else {
            // 其余契约态（PENDING/CANCELLED/EXPIRED/NO_SHOW）→ 如实说明当前状态，
            // 原实现对这些态一律留空副标题，卡片呈现为「有流程但一片空白」。
            step = 1
            subtitle = prefix + '当前预约状态：' + aptStatusText(raw)
          }
          this.setData({ progress: { title: 'AI 导诊陪您全流程就医', subtitle, step, hasFlow: true } })
        })
        .catch(() => {})
    })
  },

  _greet() {
    const msgId = this.data.msgId + 1
    this.setData({
      msgId,
      messages: [{
        id: msgId, role: 'ai', type: 'text', time: nowTime(),
        // 文案以设计参考图 02 的首条消息为准（原为较长的「…逐轮帮您梳理…」说明句）
        content: '您好！我是AI健康助手。请简单描述您哪里不舒服，我来帮您初步判断就医方向。'
      }]
    })
  },

  onInput(e) { this.setData({ input: e.detail.value }) },

  onSend() {
    const text = (this.data.input || '').trim()
    if (!text) return
    this.setData({ input: '' })
    this.send(text)
  },

  _ctx(extra) {
    return Object.assign({
      history: this._history,
      asked: this._asked,
      rounds: this.data.rounds,
      useRemote: this._remoteAllowed !== false
    }, extra || {})
  },

  // ==================== 主流程 ====================
  send(text) {
    const t = String(text || '').trim()
    if (!t) return
    if (this.data.status === 'THINKING') return

    // ⓪ 上一条在问「要不要告诉您怎么走」→ 先把这一句当应答处理
    //    （点按钮 与 直接打字「要 / 是 / 好 / 不用」等价，长者不必找按钮）
    const asked = this._pendingNavDept
    if (asked) {
      const ans = triageService.answerNav(t)
      if (ans) {
        const msgId = this.data.msgId + 1
        this.setData({ input: '' })
        this._appendMsg({ id: msgId, role: 'user', type: 'text', content: t, time: nowTime() })
        if (ans === 'yes') this._goNav(asked)
        else this._declineNav()
        return
      }
      this._pendingNavDept = ''   // 用户又说症状了 → 丢弃待答态，按新的分诊输入处理
    }

    const msgId = this.data.msgId + 1
    this.setData({ input: '' })
    this._appendMsg({ id: msgId, role: 'user', type: 'text', content: t, time: nowTime() })

    // ① 本地即时理解（0ms 出结果）→ 回执"我理解到了什么"，让用户能纠错
    const local = triageService.parse(t, this._ctx())
    if (local.slotsText) {
      this.setData({ slotsText: local.slotsText })
      this._push({ type: 'slots', slotsText: local.slotsText })
    }

    // ② 红旗 → 立即预警（不等后端，抢时间）
    if (local.emergency) {
      this._raiseEmergency(local)
      this._finish(local, t)
      return
    }

    // ③ 信息不足 → 一次只补问一个问题（多轮对话的"度"）
    if (local.question) {
      this._ask(local.question)
      return
    }

    // ④ 走融合分析（本地 + 后端 AI）
    this._analyze(t)
  },

  _analyze(text, force) {
    this.setData({ status: 'THINKING', thinkingText: 'AI 正在分析…' })
    triageService.analyze(text, this._ctx({ forceResult: !!force }))
      .then((result) => {
        this.setData({ status: 'IDLE' })
        if (result.emergency) {
          this._raiseEmergency(result)
          this._finish(result, text)
          return
        }
        if (result.question && !force) {   // 后端也认同需要补问
          this._ask(result.question)
          return
        }
        this._pushResult(result)
        this._finish(result, text)
      })
      .catch(() => {
        // triageService 内部已兜底，这里只防极端情况
        this.setData({ status: 'IDLE' })
        wx.showToast({ title: '分析失败，请重新描述', icon: 'none' })
      })
  },

  _finish(result, text) {
    this._history.push(text)
    this.setData({ lastResult: result, canReport: true })
    triageService.saveSession(result, text)
    this._speakAdvice(result)
  },

  // ==================== 消息构造 ====================
  /**
   * 追加一条消息（**增量 setData + 上限裁剪**）。
   *
   * ⚠️ 性能红线：不要再写 `messages: this.data.messages.concat(...)` ——
   *   那会把整个数组重新序列化传到视图层，对话越长每轮开销越大（O(n) 全量重渲染）。
   *   这里用「路径赋值」只把新增这一条推过去（O(1)），已有消息不重传；
   *   超过 MSG_CAP 条时整体裁剪一次（均摊成本极低），避免渲染几百条旧消息。
   *   ⚠️ 裁剪后索引基线会变，所以裁剪必须整数组 setData（不能与增量混着按老索引算）。
   *   （与 consultation.js 的 _appendMsg 同一口径；本页此前 4 处 concat 均为全量写法。）
   */
  _appendMsg(msg) {
    const list = this.data.messages
    const i = list.length
    if (i >= MSG_CAP) {
      this.setData({ messages: list.slice(i - MSG_CAP + 1).concat(msg), msgId: msg.id })
      return
    }
    const patch = { msgId: msg.id }
    patch['messages[' + i + ']'] = msg
    this.setData(patch)
  },

  _push(msg) {
    const id = this.data.msgId + 1
    this._appendMsg(Object.assign({ id, role: 'ai', time: nowTime() }, msg))
    return id
  },

  /** 多轮补问（带快捷选项，长者可直接点） */
  _ask(q) {
    this._asked.push(q.slot)
    this.setData({ rounds: this.data.rounds + 1, status: 'IDLE' })
    this._push({
      type: 'ask',
      content: q.question,
      options: q.options || [],
      slot: q.slot
    })
  },

  onAskOption(e) {
    const v = e.currentTarget.dataset.v
    if (v) this.send(v)
  },

  /** 结构化导诊结果卡 */
  _pushResult(result) {
    const p = result.primary || {}
    this._push({
      type: 'triage',
      level: result.level,
      levelText: result.levelText,
      levelCls: result.levelCls,
      levelWindow: result.levelWindow,
      levelAdvice: result.levelAdvice,
      dept: p.dept,
      deptIntro: (result.departmentInfo && result.departmentInfo.intro) || '',
      deptFloor: (result.departmentInfo && result.departmentInfo.floor) || '',
      navigable: !!result.navigable,
      confidenceText: (p.confidence && p.confidence.text) || '',
      reasons: p.reasons || [],
      // 备选科室：原来直接传数组，WXML 里 {{arr}} 会渲染成英文逗号「A,B」；
      // 改为中文顿号连接，与页面其它文案一致。
      alternates: (result.alternates || []).map((a) => a.dept).filter(Boolean).join('、'),
      slotsText: result.slotsText || '',
      aiFallback: !!result.aiFallback
    })
    // 结果卡后紧跟一句「要不要带您过去」——回答「要」直接进院内导诊页出路线。
    // 只在 1F 平面图有独立房间的科室才问（否则会导到不存在的地方，反而添乱）。
    // 记下待答科室：点按钮、或直接打字「要 / 是」都算应答（见 send 的 ⓪ 分支）。
    if (result.navigable && p.dept) {
      this._pendingNavDept = p.dept
      this._push({
        type: 'navask',
        dept: p.dept,
        content: '需要我告诉您去「' + p.dept + '」怎么走吗？'
      })
    }
    this.setData({ status: 'IDLE' })
  },

  /** 急诊预警：常驻红条 + 弹窗 + 可一键拨打 120 */
  _raiseEmergency(result) {
    const top = (result.redFlags && result.redFlags[0]) || {}
    const info = {
      label: result.redFlagAction || ('检测到' + (top.label || '危险信号')),
      advice: result.levelAdvice || '请立即拨打 120 或前往最近医院急诊科。'
    }
    this.setData({ emergency: info, status: 'IDLE' })
    this._push({
      type: 'emergency',
      title: top.label || '紧急情况',
      advice: info.advice,
      action: result.redFlagAction || '',
      dept: (result.primary && result.primary.dept) || '急诊科',
      slotsText: result.slotsText || ''
    })
    try { wx.vibrateShort && wx.vibrateShort({ type: 'heavy', fail: () => {} }) } catch (e) {}
    if (!this._emergencyModalShown) {
      this._emergencyModalShown = true
      wx.showModal({
        title: '⚠ 检测到紧急情况',
        content: info.label + '\n\n' + info.advice,
        confirmText: '拨打 120',
        cancelText: '我知道了',
        success: (res) => { if (res.confirm) this.onCall120() }
      })
    }
  },

  onCall120() {
    wx.makePhoneCall({
      phoneNumber: '120',
      fail: () => wx.showToast({ title: '请手动拨打 120', icon: 'none' })
    })
  },

  // ==================== 结果卡操作 ====================
  onDeptBook(e) {
    const dept = e.currentTarget.dataset.dept
    // appointment 是 tabBar 页（navigateTo 会被微信静默拒绝）：switchTab + 缓存传预选科室
    if (dept) wx.setStorageSync('wb_appoint_dept', dept)
    wx.switchTab({ url: '/pages/appointment/appointment' })
  },

  /** 院内导航（本层有房间的科室才给，避免"导到不存在的地方"） */
  onNavDept(e) {
    const dept = e.currentTarget.dataset.dept
    wx.navigateTo({ url: '/packageNav/pages/nav/nav' + (dept ? ('?dept=' + encodeURIComponent(dept)) : '') })
  },

  // ==================== 路线询问（结果卡后的「要不要带您过去」）====================
  /** 回答「要」→ 弹到院内导诊页（带科室参数，进页即选中并生长路线） */
  onNavaskYes(e) {
    const dept = e.currentTarget.dataset.dept || this._pendingNavDept
    if (!dept) return
    this._pushUser('要，带我去')   // 把用户这句应答留在对话里
    this._goNav(dept)
  },

  /** 回答「不用」→ 给一句兜底去处，不打断对话 */
  onNavaskNo() {
    this._pushUser('不用了')
    this._declineNav()
  },

  _goNav(dept) {
    this._pendingNavDept = ''
    wx.navigateTo({ url: '/packageNav/pages/nav/nav' + (dept ? ('?dept=' + encodeURIComponent(dept)) : '') })
  },

  _declineNav() {
    this._pendingNavDept = ''
    this._push({
      type: 'text',
      content: '好的，祝您顺利。需要路线时可以点下方「来院导航」，或从首页「院内导航」进入（路线从医院大门开始）。'
    })
  },

  /** 追加一条"用户说的话"（用于把应答显示出来；不发请求） */
  _pushUser(content) {
    const id = this.data.msgId + 1
    this.setData({ input: '' })
    this._appendMsg({ id, role: 'user', type: 'text', content: content, time: nowTime() })
  },

  /** 生成完整导诊报告（结果页） */
  onReport() {
    const r = this.data.lastResult
    if (!r) {
      wx.showToast({ title: '先描述一下症状吧', icon: 'none' })
      return
    }
    try { wx.setStorageSync(REPORT_KEY, triageService.toReport(r)) } catch (e) {}
    wx.navigateTo({ url: '/pages/triage/result/result' })
  },

  /** 主动结束采集、直接出结果 */
  onForceResult() {
    const last = this._history.length ? this._history[this._history.length - 1] : ''
    if (!last) {
      wx.showToast({ title: '请先描述症状', icon: 'none' })
      return
    }
    this._analyze(last, true)
  },

  _speakAdvice(result) {
    if (!speechService.voiceReadEnabled()) return
    const p = result.primary || {}
    const text = (result.levelText || '') + '。建议就诊科室：' + (p.dept || '全科医学科') + '。' + (result.levelAdvice || '')
    // 朗读走受保护接口（/voice/tts）：先保会话就绪；未登录直接不发声，
    // 避免每次出结论都打一个注定 401 的请求（朗读只是锦上添花，不阻断主流程）。
    req.ensureSessionReady().then((ready) => {
      if (!ready) return
      speechService.speak(text, { onError: () => {} })
    })
  },

  onFeedback(e) {
    const t = e.currentTarget.dataset.type
    wx.showToast({ title: t === 'up' ? '感谢您的认可' : '感谢反馈，我们会持续优化', icon: 'none' })
  },

  // ==================== 固定区服务入口 ====================
  /**
   * 「更多服务」＝ 动作面板（同首页 onMore 的既有手法）。
   * 为什么收敛成 1 个入口：原来 4 个 pill 常驻固定在输入栏上方，
   *   ① 窄屏（320px）总宽约 716rpx 放不下，view 上的 overflow-x:auto 不产生滚动 → 第 4 项被裁；
   *   ② 固定区越厚，对话可视高度越小（UIUX §3.5）。
   * 4 个去向与原 handler 一个不少，只是改为从面板进入。
   */
  onServices() {
    wx.showActionSheet({
      itemList: SERVICE_MENU,
      success: (res) => {
        const fn = [this.onQuickBook, this.onQuickReport, this.onQuickNav, this.onAllServices][res.tapIndex]
        if (fn) fn.call(this)
      },
      fail: () => {}   // 用户自己取消，不提示（不是错误）
    })
  },

  onQuickBook() { wx.switchTab({ url: '/pages/appointment/appointment' }) },
  onQuickReport() { wx.navigateTo({ url: '/pages/profile/records/records' }) },
  onQuickNav() { wx.navigateTo({ url: '/packageNav/pages/nav/nav' }) },   // 院内导航已上线
  onAllServices() { wx.switchTab({ url: '/pages/home/home' }) },

  // ==================== 顶部导航 ====================
  // 返回上一页。⚠️ 若本页是栈首（如开发者工具「编译模式」直接打开本页）navigateBack 必失败，
  // 未接 fail 回调时框架会把错误对象原样打到控制台（表现为 [object Object]）→ 兜底回首页。
  onBack() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) }) },
  onTabMine() { wx.navigateTo({ url: '/pages/profile/consultations/consultations' }) },
  onSwitchUser() {
    wx.showModal({
      title: '切换账号',
      content: '将退出当前账号并返回登录页，确定吗？',
      success: (res) => {
        if (res.confirm) {
          app.logout()
          userService.logout()
          wx.reLaunch({ url: '/pages/auth/login/login' })
        }
      }
    })
  },
  onFlowDetail() { wx.navigateTo({ url: '/pages/profile/records/records' }) },

  // ==================== 语音输入 ====================
  onVoice() {
    if (this.data.recording) {
      speechService.stopRecord()
      return
    }
    speechService.startRecord({
      onStart: () => { this.setData({ recording: true, voiceHint: '正在聆听…' }) },
      onRecognizing: () => { this.setData({ voiceHint: '正在识别…' }) },
      onResult: (text) => {
        this.setData({ recording: false, voiceHint: '' })
        if (text) this.send(text)
      },
      onError: (msg) => {
        this.setData({ recording: false, voiceHint: '' })
        wx.showToast({ title: msg || '语音识别失败', icon: 'none' })
      },
      onEnd: () => { this.setData({ recording: false, voiceHint: '' }) }
    })
  }
})
