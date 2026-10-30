/**
 * pages/consultation —— AI 问诊（TabBar · 多轮真实后端 AI 问诊）
 *
 * ⚠️ 现行交互口径（2026-10-24 重写，取代旧的「V1.9 一句话直推导诊」）：
 *   进门固定一句话 → 用户回一句 → **第 2 轮起**带上下文调后端 TRIAGE；
 *   只在置信度 ≥ 0.7 且科室不在兜底科室（全科医学科）时才出结论卡，否则继续追问。
 *   实现：`services/ai.js` + `services/triage.js`（本地引擎 0ms 先出，后端
 *   recommend-department / emergency/check 融合，任一失败降级为本地规则结论）。
 *   一句话直出科室的能力仍在**导诊页**（pages/triage），不在本页。
 *
 * 结构（对照参考图）：
 *   1. 顶部导航：品牌 + 「对话/我的」tab + 清空
 *   2. 用户信息条：头像 + 姓名脱敏 + ID 脱敏 + 切换
 *   3. 就医进度卡：四步进度（预约→待取号→待就诊→就诊）
 *   4. 对话区：首屏 4 个可点症状示例 + 导诊结果卡（分级/科室/依据/备选/挂号）+ 赞踩 + TTS 重播
 *   5. 快捷服务行：预约挂号 / 报告查询 / 来院导航 / 全部服务
 *   6. 底部输入条：语音 + 输入 + 蓝色圆形发送
 */
const app = getApp()
const speechService = require('../../services/speech.js')
const userService = require('../../services/user.js')
const triageService = require('../../services/triage.js')
const aiService = require('../../services/ai.js')
const req = require('../../services/request.js')
const { aptStatusText } = require('../../utils/apt-status.js')
const { fmtDate } = require('../../utils/datetime.js')
const { errText } = require('../../utils/err-text.js')
const icons = require('../../utils/icons.js')

/** 问诊会话状态 → 文案（契约 ConsultationData.status，未知值原样透传） */
const CONSULT_STATUS_TEXT = { ACTIVE: '进行中', CLOSED: '已结束', ARCHIVED: '已归档' }

/**
 * AI 分诊「信息达标」阈值（2026-10-24）：
 * 远端 TRIAGE 结果置信度 < 该值、或科室落在兜底科室时**不出结论**，让对话继续追问。
 * 0.7 是本院试点口径：再低模型自己对科室也没把握，宁可多问一句，不能拿患者试错。
 */
const TRIAGE_MIN_CONFIDENCE = 0.7
const TRIAGE_FALLBACK_DEPT = '全科医学科'

function nowTime() {
  const d = new Date()
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function maskName(name) {
  const n = String(name || '').trim()
  if (!n) return '用户'
  if (n.length <= 1) return n + '*'
  return n.charAt(0) + '*'.repeat(n.length - 1)
}

function maskPhone(p) {
  const s = String(p || '')
  return s.length >= 7 ? s.slice(0, 3) + '********' + s.slice(-4) : '————————'
}

Page({
  data: {
    theme: 'standard',
    icons,
    statusBarHeight: 20,
    // 自定义导航栏右侧预留的微信胶囊安全宽（px；onLoad 用 getMenuButtonBoundingClientRect 算，见 _navSafeRight）
    navSafeRight: 0,
    user: { maskName: '用户', gender: '', maskId: '' },
    progress: {
      title: 'AI 助手陪您全流程就医',
      subtitle: '暂无进行中的就医流程，咨询 AI 为您推荐科室',
      step: 1,
      hasFlow: false
    },
    messages: [],
    status: 'IDLE',
    thinkingText: '正在为您分诊…',
    input: '',
    // 本次 AI 问诊会话（POST /api/v1/consultations）；空 = 下一条消息时创建
    activeId: '',
    // AI 已追问但信息还不够出结论（第 2 轮起才会尝试分诊）
    triagePending: false,
    // 首屏快捷症状：点一下就等于"回一句话"，长者不必打字（与导诊页同款示例）
    showQuick: true,
    quickList: ['胃疼反酸一周了', '咳嗽有痰三天', '胸闷心慌', '腰疼膝盖疼'],
    msgId: 0,
    emergency: '',
    recording: false,
    voiceHint: '',
    autoSpeak: true,
    // 平板右栏的"最近一次分诊结论"（手机端不显示，见 .side-only）
    latest: null,
    // 历史问诊（GET /api/v1/consultations 的最新一条）：标题区一行恢复入口 + 平板右栏占位
    lastConsult: null,
    // 「查看科室」半模态
    showDept: false,
    deptInfo: { name: '', intro: '', floor: '' }
  },

  onLoad() {
    const win = this._initWide()
    // 对话区最多保留 60 条（首屏只渲染最近若干条，见 _appendMsg）
    this._MSG_CAP = 60
    // 页面存活标记：AI 任务轮询是异步长链路，卸载后回调不得再 setData
    this._gone = false
    this._turns = 0
    this._idemKey = ''
    this._taskId = ''
    this.setData({
      theme: app.globalData.theme || 'standard',
      statusBarHeight: win.statusBarHeight || 20,
      navSafeRight: this._navSafeRight(win)
    })
    this._initUser()
    this._loadProgress()
    this._loadLastConsult()
    this._greet()
    this._privacyCheck()
  },

  /**
   * 自定义导航栏右侧安全宽（03 报告 F-2 真机阻断项闭环）。
   * 问题：navigationStyle=custom 时右上角「清空」压在微信胶囊按钮下 —— 看不见也点不到。
   * 依据：胶囊按钮恒贴屏幕右边，故安全宽 = 屏宽 − 胶囊左边界 + 8px 呼吸位
   *       （≈103px，与屏宽无关：胶囊尺寸固定，只是屏越宽它离左边越远）。
   * 降级：取不到胶囊信息（旧基础库 / 异常）时返回 0 → 完全退回旧行为，不新增崩溃面。
   */
  _navSafeRight(win) {
    try {
      const mb = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null
      if (mb && mb.width) return (win.windowWidth || 375) - mb.left + 8
    } catch (e) {}
    return 0
  },

  /**
   * 平板布局判定（与 wxss 断点 900×700 保持同一口径）。
   * 平板上面板常驻右栏、手机上只显示主栏，JS 侧需要知道当前档位。
   */
  _initWide() {
    let win = {}
    try { win = wx.getWindowInfo() } catch (e) {}
    this._wide = (win.windowWidth || 375) >= 900 && (win.windowHeight || 667) >= 700
    return win
  },

  onShow() {
    // 主题跟随：TabBar 页 onLoad 只走一次，设置页切换字号档后需在 onShow 同步刷新，
    // 否则 theme 类残留旧值（页面停留在旧的大字/标准态）
    const theme = app.globalData.theme || 'standard'
    if (theme !== this.data.theme) this.setData({ theme })
    // 自绘 TabBar 高亮
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().selectByPath('/pages/consultation/consultation')
    }
    // 自动朗读开关跟随设置页（storage wb_voice_read，默认开）
    const auto = speechService.voiceReadEnabled()
    if (auto !== this.data.autoSpeak) this.setData({ autoSpeak: auto })
    this._initWide()   // 旋转屏幕 / 从平板切到小窗后重新判定
    this._loadProgress()
  },

  onUnload() {
    // ⚠️ 必须清打字机：句柄不清，页面销毁后仍每 30ms setData 一次（"setData on unloaded page"）。
    //    这里只清句柄、不碰界面 —— 页面已卸载，再写数据既无意义也会告警。
    this._gone = true
    this._clearTypeTimer()
    speechService.stopRecord()
    speechService.stopSpeak()
  },

  onHide() {
    // 切 Tab / 进后台：停表 + 把这句补全 + 状态复位。
    // 只清表不清状态的话，回来时 status 仍是 TYPING → 输入框 disabled、发送按钮置灰，用户无法再说话。
    this._stopTyping()
    speechService.stopSpeak()
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

  // 最新预约 → 四步进度
  // 会话就绪前置（A6）：冷启动时 access 只在内存、refresh 在本地，先单飞刷新换回 access
  // 再发受保护请求；未登录（无 refresh）直接跳过，不再反复触发 401。
  _loadProgress() {
    req.ensureSessionReady().then((ready) => {
      if (!ready) return
      const u = app.globalData.user || {}
      userService.listMyAppointments(u.phone)
        .then((list) => {
          if (!list || !list.length) return
          const latest = list[list.length - 1]
          // ⚠️ 分支必须按**契约英文枚举**，不能按 aptStatusText 的中文文案：
          //    文案一改（如「待就诊」→「已确认」）分支就静默全落空（D-B-P2-03）。
          const raw = String(latest.status || '').trim().toUpperCase()
          const dept = latest.departmentName || latest.deptName || ''
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
          } else if (raw) {
            // 其余契约态（PENDING/CANCELLED/EXPIRED/NO_SHOW）→ 如实说明，不留空白卡
            step = 1
            subtitle = prefix + '当前预约状态：' + aptStatusText(raw)
          }
          this.setData({
            progress: { title: 'AI 助手陪您全流程就医', subtitle, step, hasFlow: true }
          })
        })
        .catch(() => {})
    })
  },

  /**
   * 历史问诊（GET /api/v1/consultations，经 services/user.js#listMyConsultations）。
   *
   * 用途：① 标题区下方一行「上次问诊：… ›」（有历史才出现，点击去列表页）；
   *      ② 平板右栏在没有本次会话结论时，用最新一条占位（避免右栏空白）。
   * 契约：ConsultationData = { id, title, status(ACTIVE|CLOSED|ARCHIVED), summary?,
   *       messageCount?, lastMessageAt?, createdAt? }。
   * ⚠️ 未登录 / 接口失败**一律静默跳过**：历史只是增强项，不能挡住问诊主流程，
   *    也绝不能本地编造一条"上次问诊"（违反禁止伪造业务数据红线）。
   */
  _loadLastConsult() {
    req.ensureSessionReady().then((ready) => {
      if (!ready) return
      userService.listMyConsultations()
        .then((list) => {
          const arr = Array.isArray(list) ? list.filter((c) => c && (c.id || c.title)) : []
          if (!arr.length) return
          // 会话可能不按时间排序 → 显式按 lastMessageAt || createdAt 取最新（字符串日期可直接比较）
          const stamp = (c) => String(c.lastMessageAt || c.createdAt || '')
          const c = arr.slice().sort((a, b) => (stamp(a) < stamp(b) ? 1 : (stamp(a) > stamp(b) ? -1 : 0)))[0]
          const statusKey = String(c.status || '').toUpperCase()
          // fmtDate 对非法日期会原样返回（"not-a-date"）→ 只在拿到合法日期时展示
          const d = fmtDate(c.lastMessageAt || c.createdAt)
          this.setData({
            lastConsult: {
              id: c.id || '',
              title: c.title || '',
              statusText: CONSULT_STATUS_TEXT[statusKey] || String(c.status || ''),
              dateText: /^\d{4}-\d{2}-\d{2}/.test(d) ? d : '',
              brief: c.summary || (c.messageCount ? '共 ' + c.messageCount + ' 条对话' : '')
            }
          })
        })
        .catch(() => {})
    })
  },

  // 隐私告知（首次进入弹一次；与导诊页共用同一开关 wb_triage_notice_v1）
  // ⚠️ 2026-10-24：本地关键词引擎下线后「仅本地分析」已无对应能力，
  //    取消即不发请求；下次发言会再次征求同意（见 send 的隐私闸门）。
  _privacyCheck() {
    if (triageService.hasSeenNotice()) { this._remoteAllowed = true; return }
    this._remoteAllowed = false
    wx.showModal({
      title: '隐私与数据使用说明',
      content: triageService.PRIVACY_NOTICE,
      confirmText: '同意并继续',
      cancelText: '暂不使用',
      success: (res) => {
        if (res.confirm) {
          triageService.markNoticeSeen()
          this._remoteAllowed = true
        } else {
          this._remoteAllowed = false
          wx.showToast({ title: '未同意，AI 问诊暂不可用', icon: 'none' })
        }
      }
    })
  },

  /**
   * 进门问候：**明确告诉用户这是多轮问诊**（先了解情况，信息够了再给科室建议）。
   * 同时重置会话态 —— 清空对话 = 新会话（旧 activeId 继续追发会把新主诉接到旧病史里）。
   */
  _greet() {
    // 清空/重置对话前先停表：否则旧定时器会继续往「新数组的最后一条」写半句
    this._clearTypeTimer()
    const msgId = this.data.msgId + 1
    this.setData({
      msgId,
      status: 'IDLE',
      showQuick: true,
      emergency: '',
      latest: null,
      input: '',
      showDept: false,
      activeId: '',
      triagePending: false,
      messages: [{
        id: msgId, role: 'ai', type: 'text', time: nowTime(),
        content: '您好，我是 AI 导诊助手。请先说说哪里不舒服、多久了，我会再问几个关键问题，信息够了给您推荐就诊科室。'
      }]
    })
    this._emergencyShown = false
    this._pendingNavDept = ''
    this._turns = 0
    this._idemKey = ''
    this._taskId = ''
  },

  /**
   * 追加一条消息（**增量** setData）。
   *
   * ⚠️ 性能红线：不要再写 `messages: this.data.messages.concat(...)` ——
   *   那会把**整个数组**重新序列化并传到视图层，对话越长每轮开销越大（O(n) 全量重渲染）。
   *   这里改用「路径赋值」只把新增这一条推过去（O(1)），已有消息不重传。
   *
   * ⚠️ 超过 _MSG_CAP 条时做一次整体裁剪（均摊成本极低），避免一次渲染几百条旧消息；
   *   裁剪后索引基线会变，所以裁剪必须整数组 setData（与增量追加不能混着按老索引算）。
   */
  _appendMsg(msg) {
    const list = this.data.messages
    const i = list.length
    if (i >= this._MSG_CAP) {
      this.setData({ messages: list.slice(i - this._MSG_CAP + 1).concat(msg), msgId: msg.id })
      return
    }
    const patch = { msgId: msg.id }
    patch['messages[' + i + ']'] = msg
    this.setData(patch)
  },

  onQuick(e) { this.send(e.currentTarget.dataset.text) },
  onInput(e) { this.setData({ input: e.detail.value }) },

  onSend() {
    const text = (this.data.input || '').trim()
    if (!text) return
    this.setData({ input: '' })
    this.send(text)
  },

  /** 追加一条用户消息（不发请求，用于把"要 / 不用"这类应答也显示出来） */
  _pushUser(content) {
    const id = this.data.msgId + 1
    this.setData({ input: '' })
    this._appendMsg({ id, role: 'user', type: 'text', content: content, time: nowTime() })
  },

  /**
   * 发送 → **真实后端 AI 问诊**（2026-10-24 重写）
   *
   * 旧实现（已废弃）：services/triage.js 本地关键词引擎，一句话直接出科室 ——
   * 既没有调后端 AI，也没有「先收集信息再判断」的过程，结论本质是关键词匹配。
   *
   * 新链路（每一步都是服务端真实数据，前端不造结论）：
   *   ① 首条消息 → POST /api/v1/consultations（建会话 + CHAT 任务，inputInline 已是多轮上下文）
   *      后续消息 → POST /api/v1/consultations/{id}/messages
   *   ② 轮询 GET /api/v1/ai/tasks/{taskId} → SUCCEEDED 取 result.text 打字机输出（AI 追问）
   *   ③ 第 2 轮起发 POST /consultations/{id}/triage（TRIAGE 任务）
   *   ④ 置信度 ≥ TRIAGE_MIN_CONFIDENCE 且非兜底科室 → 出分诊卡（科室 + 置信度 + 依据）；
   *      否则不出结论，AI 继续问 —— 信息不够就下结论等于瞎猜。
   *   ⑤ 急症：用服务端 safety（本地红旗规则在业务侧先跑）立即提示，不等模型。
   *
   * ⚠️ 任一环节失败都如实提示并可重试，绝不用本地规则结论冒充 AI 输出。
   */
  send(text) {
    const t = String(text || '').trim()
    if (!t || this.data.status !== 'IDLE') return

    // ⓪-1 隐私闸门：2026-10-24 起 AI 问诊真的会把症状送到服务端模型分析，
    //      拒绝过告知（仅本地分析）的用户必须先重新同意 —— 旧版"仅本地分析"已不存在。
    if (this._remoteAllowed === false) {
      wx.showModal({
        title: '需要联网分析',
        content: 'AI 问诊会把您描述的症状发送到服务端分析，用于给出就诊科室建议。是否继续？',
        confirmText: '继续',
        cancelText: '取消',
        success: (r) => {
          if (!r.confirm) return
          this._remoteAllowed = true
          triageService.markNoticeSeen()
          this.send(text)
        }
      })
      return
    }

    // ⓪ 若上一条回复在问「要不要告诉您怎么走」→ 先当应答处理（点按钮 / 直接打字「要」都算）
    const asked = this._pendingNavDept
    if (asked) {
      const ans = triageService.answerNav(t)
      if (ans) {
        this._pushUser(t)
        if (ans === 'yes') this._goNav(asked)
        else this._declineNav()
        return
      }
      this._pendingNavDept = ''   // 用户又说了一句症状 → 丢弃待答态，当新一轮输入
    }

    this._pushUser(t)
    this.setData({ status: 'THINKING', thinkingText: 'AI 正在思考…', showQuick: false })
    this._askAi(t)
  },

  // ============ 真实 AI 问诊（会话 + 任务轮询） ============

  /**
   * 发送一条患者消息，并在拿到 AI 回复后继续链路。
   * 幂等键按「本次输入」缓存：超时重试复用同一键，避免服务端把重试算成两条消息。
   */
  _askAi(text) {
    const key = this._idemKey || (this._idemKey = req.newIdempotencyKey())
    const id = this.data.activeId
    // ⚠️ 必须走 large 档（qwen2.5:7b）：0.5b 实测会把「患者：A 患者：B」当成一整句话复述，
    //    并直接给一个错误科室（2026-10-24 实测 0.5b 把「嗓子疼」答成消化内科）。
    //    代价是每轮约 15~25s（CPU），前端用「AI 正在思考」承接，并以任务轮询而非同步等待。
    const payload = { requestedProfile: 'large-upgrade' }
    const p = id
      ? userService.sendConsultationMessage(id, Object.assign({ content: text }, payload), { idempotencyKey: key })
      : userService.createConsultation(Object.assign({ initialMessage: text }, payload), { idempotencyKey: key })

    return p
      .then((res) => {
        if (this._gone) return null
        this._idemKey = ''
        // 急症：服务端本地红旗先跑，命中就立刻提示（不等模型生成）
        const safety = res && res.safety
        if (safety && safety.emergency) {
          this._onEmergency(safety)
          return null
        }
        const created = res && res.consultation
        if (created && created.id) this.setData({ activeId: created.id })
        const task = res && res.task
        if (!task || !task.taskId) {
          throw { code: 'NO_TASK', message: '服务端没有返回 AI 任务' }
        }
        return this._awaitChat(task.taskId)
      })
      .catch((err) => { this._onAiFail(err) })
  },

  /** 轮询 CHAT 任务直到终态，成功后打字机输出 */
  _awaitChat(taskId) {
    this._taskId = taskId
    return aiService.waitTask(taskId, { interval: 1500, timeout: 120000 }).then((task) => {
      if (this._gone) return null
      this._taskId = ''
      if (!task || task.status !== 'SUCCEEDED') {
        const e = (task && task.error) || {}
        throw {
          code: e.code || (task && task.status) || 'AI_TASK_FAILED',
          message: e.message || 'AI 暂时无法回答'
        }
      }
      const reply = String((task.result && task.result.text) || '').trim()
      if (!reply) throw { code: 'EMPTY_RESULT', message: 'AI 没有返回内容' }
      this._typeAi(reply)
      return this._afterReply()
    })
  },

  /**
   * 一轮对话结束后判定是否该给分诊结论。
   * 第 1 轮只收集主诉；从第 2 轮起才请求 TRIAGE —— 否则等于拿一句话猜科室。
   */
  _afterReply() {
    const turns = (this._turns = (this._turns || 0) + 1)
    if (turns < 2) return Promise.resolve()
    const id = this.data.activeId
    if (!id || this._gone) return Promise.resolve()
    return aiService.requestConsultationTriage(id)
      .then((task) => {
        if (!task || !task.taskId || this._gone) return null
        return aiService.waitTask(task.taskId, { interval: 1500, timeout: 180000 })
      })
      .then((task) => { this._renderTriage(task) })
      .catch(() => { /* 分诊失败不打断问诊：下一轮会再试，期间 AI 继续追问 */ })
  },

  /** TRIAGE 结果 → 达标出卡 / 不达标继续问 */
  _renderTriage(task) {
    if (this._gone || !task || task.status !== 'SUCCEEDED') return
    const parsed = aiService.parseTriage(task)
    if (!parsed) return
    const top = parsed.departments[0]
    const conf = Number(top.confidence) || 0
    const isFallback = top.name === TRIAGE_FALLBACK_DEPT
    const turns = this._turns || 0
    // 信息还不够：不给结论，让对话继续（卡片不为"有输出"而硬给）
    if (conf < TRIAGE_MIN_CONFIDENCE || isFallback) {
      // 但也不能无限问下去：问到第 3 轮仍是兜底科室，就明确告诉患者"先到全科"，
      // 这与线下导诊台的处理一致（分不出科 → 全科首诊），比一直追问体验好。
      if (isFallback && turns >= 3) {
        this._pushDeptCard({
          primary: { dept: TRIAGE_FALLBACK_DEPT, confidence: { text: Math.round(conf * 100) + '%' }, reasons: [] },
          alternates: [],
          levelText: 'AI 分诊建议',
          levelCls: 'badge-blue',
          levelWindow: '',
          levelAdvice: '症状描述还不足以精确分科，建议先到全科医学科，由医生面诊后转诊。',
          departmentInfo: {},
          navigable: false
        })
        return
      }
      this.setData({ triagePending: true })
      return
    }
    this._pushDeptCard({
      primary: {
        dept: top.name,
        confidence: { text: Math.round(conf * 100) + '%' },
        reasons: [top.reason].filter(Boolean)
      },
      alternates: parsed.departments.slice(1).map((d) => ({ dept: d.name })),
      levelText: 'AI 分诊建议',
      levelCls: 'badge-blue',
      levelWindow: '',      // 无时间窗：不编造
      levelAdvice: '建议前往' + top.name + '就诊；具体以线下医师判断为准。',
      departmentInfo: {},   // TRIAGE 不返回楼层/简介，留空（查看科室会提示暂无介绍）
      navigable: false
    })
  },

  // ============ 急症 / 失败 ============
  /** 服务端 safety.emergency=true：直接走急救提示，不引导挂号 */
  _onEmergency(safety) {
    const advice = (safety && safety.message) || '请立即拨打 120 或前往最近医院急诊科。'
    this.setData({
      status: 'IDLE',
      emergency: advice,
      latest: { dept: '急诊科', levelText: '紧急', levelCls: 'badge-red', confidence: '', advice }
    })
    this._typeAi('已识别到危险信号，请立即就医。' + advice, () => this._emergencyModal())
  },

  /** AI 链路失败：如实说明 + 保留重试能力，不伪造结论 */
  _onAiFail(err) {
    if (this._gone) return
    this._idemKey = ''
    // ⚠️ 只走 err-text.js：原实现把 err.message/err.code 直接拼进气泡，用户会看到
    //    「（NETWORK_ERROR）」这类英文码/HTTP 码，违反 RULE #13/#27（审查 P1-04）。
    const m = errText(err, '网络异常')
    this.setData({ status: 'IDLE', showQuick: true })
    this._appendMsg({
      id: this.data.msgId + 1, role: 'ai', type: 'text', time: nowTime(),
      content: 'AI 助手暂时没能回答（' + m + '）。您可以再发一次，或先用下方「预约挂号」按科室挂号。'
    })
  },

  _emergencyModal() {
    if (this._emergencyShown) return
    this._emergencyShown = true
    wx.showModal({
      title: '⚠ 检测到紧急情况',
      content: this.data.emergency,
      confirmText: '拨打 120',
      cancelText: '我知道了',
      success: (res) => { if (res.confirm) this.onCall120() }
    })
  },

  onCall120() {
    wx.makePhoneCall({
      phoneNumber: '120',
      fail: () => wx.showToast({ title: '请手动拨打 120', icon: 'none' })
    })
  },

  /**
   * 分诊结果卡（设计 04 版式：标题 + 分级 badge / 「推荐科室」「判断理由」标签行 / 双按钮 / 居中免责）
   *
   * 字段全部来自 services/triage.js 的真实结果，不在这里造结论：
   *   p.dept / p.reasons / p.confidence / result.alternates / result.levelWindow /
   *   result.levelAdvice / result.departmentInfo{intro,floor} / result.navigable
   */
  _pushDeptCard(result) {
    const p = result.primary || {}
    const info = result.departmentInfo || {}

    // 备选科室：去掉与主推荐重复的、最多 2 个（设计稿没有这一行，属本页补充的信息，不额外渲染按钮）
    const alts = (result.alternates || [])
      .filter((a) => a && a.dept && a.dept !== p.dept)
      .slice(0, 2)
      .map((a) => ({ name: a.dept }))

    // badge 文案：**置信度优先**（真实 TRIAGE 结果）。
    // 设计稿的「建议24小时内就诊」是分级口径，而 TRIAGE 不返回时间窗 ——
    // 没有时间窗时硬凑一个就是编造，所以有 confidence 就显示「置信度 82%」。
    const confText = (p.confidence && p.confidence.text) || ''
    const win = String(result.levelWindow || '').replace(/\s/g, '')
    const badgeText = confText
      ? ('置信度 ' + confText)
      : (win ? ('建议' + win + '就诊') : (result.levelText || ''))

    // 判断理由：引擎给的是短句数组（["您提到了「咳嗽」，属于呼吸系统表现", "症状持续数天", …]），
    // 设计稿是一句话 → 最多取 2 句用「；」连；仍然过长就只留第一句，避免卡片里堆成三行小字。
    const raw = (p.reasons || []).filter(Boolean).slice(0, 2)
    let reasonText = raw.join('；')
    if (!reasonText) reasonText = '根据您描述的症状匹配'
    else if (reasonText.length > 34) reasonText = raw[0]

    const id = this.data.msgId + 1
    this.setData({
      status: 'IDLE',
      showQuick: true,
      triagePending: false,   // 已出结论：清掉「信息不够」态
      // 平板右栏常驻的"最近一次分诊结论"（手机端 .side-only 隐藏）
      latest: {
        dept: p.dept || '',
        levelText: result.levelText || '',
        levelCls: result.levelCls || 'badge-blue',
        confidence: (p.confidence && p.confidence.text) || '',
        advice: result.levelAdvice || ''
      }
    })
    this._appendMsg({
      id, role: 'ai', type: 'dept', time: nowTime(),
      deptName: p.dept || '',
      alts: alts,
      reasonText: reasonText,
      badgeText: badgeText,
      levelText: result.levelText || '',
      levelCls: result.levelCls || 'badge-blue',
      advice: result.levelAdvice || '',
      aiFallback: !!result.aiFallback,
      // 「查看科室」半模态要展示的科室信息（引擎已返回；没有就留空，不编造）
      deptFloor: info.floor || '',
      deptIntro: info.intro || ''
    })

    // 结果卡之后紧接着问「要不要告诉您怎么走」——
    // 只在 1F 平面图有独立房间的科室才问（否则会把人导到不存在的地方）；
    // 记下待答科室：用户点按钮或直接打字「要」都算应答（见 send 的 ⓪ 分支）。
    if (result.navigable && p.dept) {
      this._pendingNavDept = p.dept
      this._appendMsg({
        id: this.data.msgId + 1, role: 'ai', type: 'navask', time: nowTime(),
        dept: p.dept,
        content: '需要我告诉您去「' + p.dept + '」怎么走吗？'
      })
    }
    this._speakDept(result)
  },

  // ============ 「查看科室」半模态 ============
  /**
   * 设计稿的「查看科室」只有一个按钮入口，本页落地为**科室介绍半模态**：
   * 展示引擎已返回的楼层/简介，并给一个直达挂号的按钮。
   * ⚠️ 只展示后端真实下发字段；没有就提示"暂无更多介绍"，不编造门诊时间/医生名单。
   */
  onDeptView(e) {
    const ds = e.currentTarget.dataset || {}
    const dept = ds.dept || ''
    if (!dept) return
    // 科室信息挂在消息上（每条结论可能不同）→ 按消息 id 回查，而不是读全局最后一次
    const msg = (this.data.messages || []).filter((m) => String(m.id) === String(ds.msg))[0] || {}
    const sameDept = msg.deptName === dept
    this.setData({
      showDept: true,
      deptInfo: {
        name: dept,
        floor: sameDept ? (msg.deptFloor || '') : '',
        intro: sameDept ? (msg.deptIntro || '') : ''
      }
    })
  },

  onDeptClose() {
    this.setData({ showDept: false })
  },

  onDeptBookFromSheet(e) {
    const dept = e.currentTarget.dataset.dept || this.data.deptInfo.name
    this.setData({ showDept: false })
    // appointment 是 tabBar 页：switchTab 不带参，预选科室走缓存（appointment 页 onShow 消费）
    if (dept) {
      wx.setStorageSync('wb_appoint_dept', dept)
      this._goto('/pages/appointment/appointment', true)
    }
  },

  // ============ 路线询问（要不要告诉您怎么走）============
  /** 答「要，带我去」→ 弹到院内导诊页，带科室参数（进页即选中并生长路线） */
  onNavaskYes(e) {
    const dept = e.currentTarget.dataset.dept || this._pendingNavDept
    if (!dept) return
    this._pushUser('要，带我去')
    this._goNav(dept)
  },

  /** 答「不用了」→ 回一句兜底去处，不打断对话 */
  onNavaskNo() {
    this._pushUser('不用了')
    this._declineNav()
  },

  _goNav(dept) {
    this._pendingNavDept = ''
    this._goto('/packageNav/pages/nav/nav' + (dept ? ('?dept=' + encodeURIComponent(dept)) : ''))
  },

  _declineNav() {
    this._pendingNavDept = ''
    this.setData({ status: 'IDLE' })
    this._appendMsg({
      id: this.data.msgId + 1, role: 'ai', type: 'text', time: nowTime(),
      content: '好的。需要路线时，可以点下方「来院导航」，或从首页「院内导航」进入（路线从医院大门开始）。'
    })
  },

  /** 平板右栏「院内导航」按钮：带最近一次推荐科室直接出路线 */
  onHelperNav(e) {
    const dept = e.currentTarget.dataset.dept
    if (!dept) return
    this._goNav(dept)
  },

  /** 结果播报：分级 + 科室 + 建议（走 storage wb_voice_read 开关） */
  _speakDept(result) {
    if (!this.data.autoSpeak) return
    const p = result.primary || {}
    this._speak((result.levelText || '') + '。建议就诊科室：' + (p.dept || '') + '。' + (result.levelAdvice || ''))
  },
  /**
   * 打字机输出（done：输出结束后回调，用于紧接着插入科室卡）
   *
   * ⚠️ 句柄必须挂在 this 上：原实现用局部 `const timer`，onUnload/onHide 拿不到，
   *    退出或切 Tab 后仍每 30ms setData（"setData on unloaded page"），且 status 永久停在
   *    TYPING —— 回到页面输入框 disabled、发送按钮变灰，用户以为"卡死了"。
   */
  _typeAi(content, done) {
    const text = String(content || '')
    this._clearTypeTimer()   // 上一句还没打完就先停，避免两条定时器同时改"最后一条消息"
    this.setData({ status: 'TYPING' })
    this._appendMsg({ id: this.data.msgId + 1, role: 'ai', type: 'text', content: '', time: nowTime() })
    this._typeState = { text, index: 0 }
    let i = 0
    // 逐字改写只会命中「最后一条消息的 content 字段」，不重传整个数组
    this._typeTimer = setInterval(() => {
      i += 3
      this._typeState.index = i
      this.setData({ ['messages[' + (this.data.messages.length - 1) + '].content']: text.slice(0, i) })
      if (i >= text.length) {
        this._clearTypeTimer()
        this.setData({ status: 'IDLE' })
        if (this.data.autoSpeak) this._speak(text)
        if (typeof done === 'function') done()
      }
    }, 30)
  },

  /** 只清定时器句柄，不碰界面。页面卸载 / 重置对话前调用（可在已卸载页面上安全调用） */
  _clearTypeTimer() {
    if (this._typeTimer) {
      clearInterval(this._typeTimer)
      this._typeTimer = null
    }
    this._typeState = null
  },

  /**
   * 停止打字并收尾（onHide / 切 Tab 用）：把当前这句补全，状态复位 IDLE。
   * 不补全的话用户回来只看到半句；不复位 IDLE 则输入区一直不可用。
   */
  _stopTyping() {
    const st = this._typeState
    const running = !!this._typeTimer
    this._clearTypeTimer()
    if (!running) return
    const idx = this.data.messages.length - 1
    if (idx >= 0 && st) this.setData({ ['messages[' + idx + '].content']: st.text })
    this.setData({ status: 'IDLE' })
  },

  /**
   * 统一跳转（600ms 锁）：连点「挂号 / 报告 / 导航」不会叠出两层同页。
   * 原实现每次 bindtap 直接 navigateTo，快速双击会出现两个预约页，返回要连按两次。
   */
  _goto(url, isTab) {
    const now = Date.now()
    if (this._navAt && now - this._navAt < 600) return
    this._navAt = now
    if (isTab) wx.switchTab({ url })
    else wx.navigateTo({ url })
  },

  // ============ TTS ============
  _speak(text) {
    if (!text) return
    // 朗读是锦上添花，失败绝不能打断问诊流程。
    // speak() 已保证不 reject，这里再兜一层 catch 与日志，便于定位后端是否缺接口。
    const self = this
    speechService.speak(text, {
      onEnd: () => {},
      onError: (msg) => { console.warn('[consultation] 朗读已跳过：' + msg) },
      // 后端 engine=placeholder / degraded=true（模型未就绪）→ 只提示一次，不打断
      onDegraded: () => {
        if (self._degradedHinted) return
        self._degradedHinted = true
        wx.showToast({ title: '当前为占位音质，可在设置中换音色', icon: 'none' })
      }
    }).catch(() => {})
  },

  onReplay(e) {
    const text = e.currentTarget.dataset.text
    if (text) this._speak(text)
  },

  onDeptBook(e) {
    const dept = e.currentTarget.dataset.dept
    if (dept) wx.setStorageSync('wb_appoint_dept', dept)
    this._goto('/pages/appointment/appointment', true)
  },

  onFeedback(e) {
    const t = e.currentTarget.dataset.type
    wx.showToast({ title: t === 'up' ? '感谢您的认可' : '感谢您的反馈，我们会继续改进', icon: 'none' })
  },

  // ============ 快捷服务行 ============
  onQuickBook() { this._goto('/pages/appointment/appointment', true) },
  onQuickReport() { this._goto('/pages/profile/records/records') },
  onQuickNav() { this._goto('/packageNav/pages/nav/nav') },   // 院内导航（起点医院大门）
  onAllServices() { this._goto('/pages/home/home', true) },

  // 对话滚动时不再收起进度卡：设计稿把就医进度卡放在**对话流内**（第 ④ 块），
  // 随对话一起滚动，因此原先"固定区 + 滚动自动收起为极简条"的机制随之删除。

  // ============ 顶部 ============
  onTabMine() { this._goto('/pages/profile/consultations/consultations') },
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
  onFlowDetail() { this._goto('/pages/profile/records/records') },
  onClear() {
    if (this.data.messages.length <= 1) return
    wx.showModal({
      title: '清空对话',
      content: '清空后当前问诊记录将无法恢复，确定继续吗？',
      success: (res) => {
        if (res.confirm) {
          speechService.stopSpeak()
          this.setData({ emergency: '' })
          this._pendingNavDept = ''
          this._greet()
        }
      }
    })
  },

  // ============ 语音输入 ============
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
