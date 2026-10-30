/**
 * pages/health —— AI 智能养生（对话式 · 方案卡内联在对话流末尾）
 * 流程：与 AI 选项化对话收集体质/年龄/诉求 → 后端 care-plan 生成 → 对话流末尾插入三天方案卡
 * 状态机：CHAT（提问流）→ GENERATING（阶段式提示）→ RESULT（方案卡内联展示）
 * 后端：POST /api/v1/care-plans（config/api.js#CARE_PLAN_CREATE，business-service 同步返回
 *       suggestions[]；旧路径 /api/v1/case/health/care-plan 已 501 COMPAT_PENDING 不再使用）
 *       ⚠️ 生成耗时不定 → services/careplan.js 用 ENV.carePlanTimeout(180s) + 幂等键
 */
const app = getApp()
const careplanService = require('../../services/careplan.js')
const speechService = require('../../services/speech.js')
const icons = require('../../utils/icons.js')
const { errText } = require('../../utils/err-text.js')

// 对话问题流（适老化：能选不输入）
const QUESTIONS = [
  {
    key: 'age',
    q: '请问您的年龄段是？',
    options: ['40 岁以下', '40 - 55 岁', '56 - 65 岁', '66 岁以上'],
    value: { '40 岁以下': 35, '40 - 55 岁': 48, '56 - 65 岁': 60, '66 岁以上': 72 }
  },
  {
    key: 'constitution',
    q: '您平时的体质偏向？',
    options: ['容易疲劳、易感冒（气虚）', '怕冷、手脚冰凉（阳虚）', '口干、易上火（阴虚）', '身体沉重、易困倦（痰湿）', '状态良好（平和）', '不太清楚']
  },
  {
    key: 'focus',
    q: '您最想改善的是？',
    options: ['睡眠质量', '脾胃消化', '精力体力', '免疫力', '体重管理']
  },
  {
    key: 'exercise',
    q: '您目前的运动情况是？',
    options: ['几乎不运动', '偶尔散步', '每周 2-3 次', '每天都运动']
  }
]

Page({
  data: {
    theme: 'standard',
    icons,
    stage: 'chat',      // chat | result（result = 对话流末尾内联的方案卡）
    messages: [],
    qIndex: 0,
    answers: {},
    msgId: 0,
    generating: false,
    genStep: '',
    plan: null,         // 排版后的方案
    currentPlan: null,  // 当前播报用的那一份（按天结构；朗读取它）
    summary: '',
    recording: false,
    voiceHint: '',
    input: '',          // 自由输入
    status: 'IDLE',     // IDLE | THINKING（生成时）
    speaking: false,    // TTS 播放中
    flowStarted: false  // 问答流是否已开始
  },

  onLoad() {
    // 对话最多保留 60 条（与 consultation 同口径），超出后整数组裁剪一次
    this._MSG_CAP = 60
    this.setData({ theme: app.globalData.theme || 'standard' })
    const msgId = this.data.msgId + 1
    // 仅显示欢迎语；问答流由用户点快捷提问 / 自由输入后才开始（避免欢迎卡被顶掉、Q1 重复）
    this.setData({
      msgId,
      flowStarted: false,
      messages: [{ id: msgId, role: 'ai', content: '您好，我是 AI 养生助手。为了给您定制合适的调理方案，我先了解一下您的情况。' }]
    })
  },

  onShow() {
    // 主题跟随：TabBar 页 onLoad 只走一次，设置页切换字号档后需在 onShow 同步刷新
    const theme = app.globalData.theme || 'standard'
    if (theme !== this.data.theme) this.setData({ theme })
    // 自绘 TabBar 高亮（适老模式下此页不在 tab 列表中，selectByPath 自动忽略）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().selectByPath('/pages/health/health')
    }
  },

  onUnload() {
    // ⚠️ care-plan 约 100s，阶段提示每 8s setData 一次：句柄不清，退出后仍会往已销毁页面写数据。
    //    同时清掉"下一题"延时器，避免 300~400ms 后向已卸载页面追加消息。
    this._clearStepTimer()
    if (this._askTimer) {
      clearTimeout(this._askTimer)
      this._askTimer = null
    }
    speechService.stopRecord()
    speechService.stopSpeak()
  },

  // 启动问答流（幂等：只启动一次）
  _startFlow() {
    if (this.data.flowStarted) return
    this.setData({ flowStarted: true })
    this._appendMsg({ id: this.data.msgId + 1, role: 'ai', content: '好的，我先了解几个基础情况～' })
    this._askSoon(400)
  },

  /**
   * 快捷提问（宫格）：**任何状态下点宫格 = 以该主题重开一轮**。
   * ⚠️ 设计稿 05 的宫格常驻在对话上方（不在问答流开始后收起），所以这里不能再
   *    「已开始就直接 return」—— 那样宫格会变成点了没反应的死块。
   *    重开动作 = 清 answers/qIndex/方案（保留历史消息，设计稿就是一条连续对话流），
   *    撤掉排队中的「下一题」与正在朗读的 TTS，再追加用户这句并启动问答流。
   */
  onQuickAsk(e) {
    const text = e.currentTarget.dataset.text
    if (!text || this.data.generating) return
    if (this._askTimer) {
      clearTimeout(this._askTimer)
      this._askTimer = null
    }
    speechService.stopSpeak()
    this.setData({
      answers: {}, qIndex: 0, plan: null, summary: '', currentPlan: null,
      stage: 'chat', flowStarted: false, speaking: false
    })
    this._appendMsg({ id: this.data.msgId + 1, role: 'user', content: text })
    this._startFlow()
  },

  // 问当前问题（qIndex 随消息下发：用于判定点击的选项是否属于"当前这道题"）
  _askCurrent() {
    const q = QUESTIONS[this.data.qIndex]
    if (!q) {
      this._generate()
      return
    }
    this._appendMsg({
      id: this.data.msgId + 1,
      role: 'ai',
      content: q.q,
      options: q.options,
      qIndex: this.data.qIndex
    })
  },

  // 选择答案
  onPick(e) {
    // ⚠️ 旧消息里的选项仍在屏幕上：不校验归属的话，点上一轮的 chip 会把上一题的文案
    //    记到当前题上；连点同一个 chip 还会连推两题（跳题）。两者都会污染 care-plan 入参。
    const qi = Number(e.currentTarget.dataset.qi)
    if (qi !== this.data.qIndex) return
    const text = e.currentTarget.dataset.text
    const q = QUESTIONS[this.data.qIndex]
    if (!q) return
    const answers = Object.assign({}, this.data.answers)
    answers[q.key] = q.value ? (q.value[text] || text) : text
    // 追加用户回答（文案用选项原文，数值用于后端）
    this.setData({ answers, qIndex: this.data.qIndex + 1 })
    this._appendMsg({ id: this.data.msgId + 1, role: 'user', content: text })
    this._askSoon(300)
  },

  /**
   * 生成养生方案：调后端 care-plan（长耗时，阶段式提示）
   */
  _generate() {
    const a = this.data.answers
    const age = Number(a.age) || 60
    const parts = [
      '年龄：' + age + '岁',
      '体质：' + (a.constitution || '未说明'),
      '健康诉求：' + (a.focus || '综合调理'),
      '运动情况：' + (a.exercise || '未说明')
    ]
    if (a.userNote) parts.push('补充说明：' + a.userNote)
    const userInfo = parts.join('；')

    this.setData({ generating: true, genStep: '正在分析您的体质与诉求…' })
    const steps = [
      '正在结合节气匹配调理思路…',
      '正在生成三天膳食与功法方案…（约需 1-2 分钟，请稍候）'
    ]
    let si = 0
    this._clearStepTimer()   // 幂等：重复生成时先停上一条，避免两个计时器同时改 genStep
    this._stepTimer = setInterval(() => {
      if (si < steps.length) {
        this.setData({ genStep: steps[si] })
        si++
      }
    }, 8000)

    // 降级口径统一收口到 services/careplan.js（开发档演示兜底 / 上线档原样失败，绝不伪造方案）
    // 幂等键：同一份输入（年龄+诉求）的重试复用同一个键 —— 超时重试会重放同一份落库结果，
    // 不会因为"用户又点了一次"而重复生成；生成成功后清空，用户主动再生成才会得到新方案。
    const sig = age + '|' + userInfo
    if (!this._cpKey || this._cpSig !== sig) {
      this._cpSig = sig
      this._cpKey = careplanService.newKey()
    }
    careplanService.generate({ userInfo: userInfo, age: age }, { idempotencyKey: this._cpKey })
      .then((data) => {
        this._clearStepTimer()
        const parsed = this._normalize(data)
        // 结构化拒答：不是"失败"，也不能当成功给空方案 —— 如实说明原因后停在当前阶段
        if (parsed.refused) {
          this._cpKey = null
          this._cpSig = null
          this.setData({ generating: false, genStep: '' })
          wx.showModal({
            title: '暂无法生成方案',
            content: parsed.refusalReason || '当前信息不足，暂时无法给出针对性建议。请补充描述后再试。',
            showCancel: false,
            confirmText: '知道了'
          })
          return
        }
        if (!parsed.days.length && !parsed.suggestions.length) {
          this.setData({ generating: false, genStep: '' })
          wx.showModal({
            title: '生成失败',
            content: 'AI 未返回可展示的养生建议，请稍后重试或调整描述。',
            showCancel: false,
            confirmText: '知道了'
          })
          return
        }
        this._cpKey = null
        this._cpSig = null
        this.setData({
          generating: false,
          genStep: '',
          stage: 'result',
          plan: parsed,
          summary: parsed.ageGroup || (age + '岁 · 定制调理'),
          currentPlan: parsed.days[0] || null
        })
      })
      .catch((err) => {
        this._clearStepTimer()
        this.setData({ generating: false, genStep: '' })
        const code = err && err.code
        let msg = errText(err, '生成失败，请重试')
        if (code === 'TIMEOUT') msg = 'AI 生成较慢已超时，请稍后重试'
        if (code === 'NETWORK_ERROR' || code === 'NO_BASE_URL') msg = 'AI 服务暂不可用，请稍后重试'
        wx.showModal({
          title: '生成失败',
          content: msg,
          showCancel: false,
          confirmText: '知道了'
        })
      })
  },

  /**
   * 健壮解析：两种响应结构都认
   *  ① 契约 /api/v1/care-plans：{ suggestions:[{title,detail}], limitations, refused, refusalReason }
   *  ② 旧结构 / 开发档演示：{ age_group?, day1..dayN | days[] | 扁平 }（演示数据走这条）
   * 缺失字段不展示、不编造；拒答单独标记，不混淆成"空方案"。
   */
  _normalize(data) {
    const d = data || {}
    const days = []
    const pick = (obj, keys) => {
      const out = []
      keys.forEach((k) => {
        const v = obj && obj[k]
        if (!v) return
        if (Array.isArray(v)) {
          out.push.apply(out, v)
        } else if (typeof v === 'string' && v.trim()) {
          // 后端返回整段文本（含 \n 换行），按行拆分逐条展示
          v.split('\n').forEach((line) => {
            const t = String(line).trim()
            if (t) out.push(t)
          })
        }
      })
      return out
    }
    // day1 ~ day7
    for (let i = 1; i <= 7; i++) {
      const key = 'day' + i
      if (d[key]) {
        const day = d[key]
        days.push({
          label: i === 1 ? '第 1 天（今天）' : i === 2 ? '第 2 天（明天）' : '第 ' + i + ' 天',
          diet: pick(day, ['diet', 'dietAdvice', 'meal']),
          exercise: pick(day, ['exercise', 'exerciseAdvice', 'sport']),
          sleep: pick(day, ['sleep', 'sleepAdvice', 'acupoint'])
        })
        continue
      }
    }
    // days 数组
    if (!days.length && Array.isArray(d.days)) {
      d.days.forEach((day, i) => {
        days.push({
          label: '第 ' + (i + 1) + ' 天',
          diet: pick(day, ['diet', 'dietAdvice', 'meal']),
          exercise: pick(day, ['exercise', 'exerciseAdvice', 'sport']),
          sleep: pick(day, ['sleep', 'sleepAdvice', 'acupoint'])
        })
      })
    }
    // 扁平结构（单天）
    if (!days.length) {
      const flat = {
        label: '今日方案',
        diet: pick(d, ['diet', 'dietAdvice']),
        exercise: pick(d, ['exercise', 'exerciseAdvice']),
        sleep: pick(d, ['sleep', 'sleepAdvice'])
      }
      if (flat.diet.length || flat.exercise.length || flat.sleep.length) days.push(flat)
    }
    // 契约结构：suggestions[]（title/detail 缺一不可，缺了就丢，不缝合）
    const suggestions = []
    if (Array.isArray(d.suggestions)) {
      d.suggestions.forEach((s) => {
        const title = s && String(s.title || '').trim()
        const detail = s && String(s.detail || '').trim()
        if (title && detail) suggestions.push({ title, detail })
      })
    }
    return {
      ageGroup: d.age_group || d.ageGroup || '',
      days,
      suggestions,
      limitations: String(d.limitations || ''),
      refused: !!d.refused,
      refusalReason: String(d.refusalReason || '')
    }
  },

  // ============ 通用小工具 ============

  /**
   * 追加一条消息（增量 setData，O(1)）。
   * ⚠️ 原实现 9 处都写 `messages: this.data.messages.concat(...)`：每轮把整个数组
   *    重新序列化传给视图层，对话越长越慢。这里只推新增这一条，
   *    超过 _MSG_CAP 才整数组裁剪一次（与 consultation 同口径）。
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

  /** 延时问下一题（同一时刻只保留一个，避免重复排队连问两题） */
  _askSoon(delay) {
    if (this._askTimer) clearTimeout(this._askTimer)
    this._askTimer = setTimeout(() => {
      this._askTimer = null
      this._askCurrent()
    }, delay)
  },

  /** 只清阶段提示定时器（生成结束与 onUnload 共用） */
  _clearStepTimer() {
    if (this._stepTimer) {
      clearInterval(this._stepTimer)
      this._stepTimer = null
    }
  },

  /** 跳转加 600ms 锁：连点不会叠出两个页面 */
  _goto(url) {
    const now = Date.now()
    if (this._navAt && now - this._navAt < 600) return
    this._navAt = now
    wx.navigateTo({ url })
  },

  // 自由输入（补充说明，可与选项并存）
  onInput(e) { this.setData({ input: e.detail.value }) },

  onSend() {
    const text = (this.data.input || '').trim()
    if (!text) return
    // ⚠️ 生成中（care-plan 1-2 分钟）输入条是**常驻置灰**的：这里再兜一层，
    //    否则这期间打的字会被写进 answers.userNote，污染正在生成的那份方案入参。
    if (this.data.generating) return
    this.setData({ input: '' })
    // 追加到消息流
    const id = this.data.msgId + 1
    const answers = Object.assign({}, this.data.answers)
    // ⚠️ 若问答流已开始且有当前问题：自由输入直接作为当前问题答案并推进流程，
    // 否则永远卡在第 1 题 → 永不触发 care-plan → 后端收不到养生请求（用户实测）。
    // 适老化原则「能打字就不点选项」，选项与输入两条路都必须能走完问卷。
    const q = QUESTIONS[this.data.qIndex]
    if (this.data.flowStarted && q) {
      answers[q.key] = text
      this.setData({ answers, qIndex: this.data.qIndex + 1 })
      this._appendMsg({ id, role: 'user', content: text })
      this._askSoon(300)
      return
    }
    answers.userNote = (answers.userNote ? answers.userNote + '；' : '') + text
    this.setData({ answers })
    this._appendMsg({ id, role: 'user', content: text })
    // 问答流未开始 → 首次自由输入直接启动
    if (!this.data.flowStarted) this._startFlow()
  },

  onRead() {
    if (this.data.speaking) {
      speechService.stopSpeak()
      this.setData({ speaking: false })
      return
    }
    const cp = this.data.currentPlan
    if (!cp) {
      wx.showToast({ title: '暂无可播报内容', icon: 'none' })
      return
    }
    const lines = []
    if (cp.label) lines.push(cp.label + '养生方案。')
    if (cp.diet && cp.diet.length) lines.push('膳食处方：' + cp.diet.join('，') + '。')
    if (cp.exercise && cp.exercise.length) lines.push('功法运动：' + cp.exercise.join('，') + '。')
    if (cp.sleep && cp.sleep.length) lines.push('穴位与睡眠：' + cp.sleep.join('，') + '。')
    const text = lines.join('')
    if (!text) return
    this.setData({ speaking: true })
    speechService.speak(text, {
      onStart: () => {},
      onEnd: () => { this.setData({ speaking: false }) },
      onError: (msg) => {
        this.setData({ speaking: false })
        wx.showToast({ title: msg || '语音播报失败', icon: 'none' })
      },
      // 后端 engine=placeholder / degraded=true → 有声音但音质为占位，仅提示
      onDegraded: () => { wx.showToast({ title: '当前为占位音质', icon: 'none' }) }
    })
  },

  onCast() {
    this._goto('/pages/tv/cast/cast')
  },

  // 语音输入（对话阶段可语音回答自由文本）
  onVoice() {
    const self = this
    if (this.data.recording) {
      speechService.stopRecord()
      return
    }
    speechService.startRecord({
      onStart() { self.setData({ recording: true, voiceHint: '正在聆听，请说话…' }) },
      onRecognizing() { self.setData({ voiceHint: '正在识别语音…' }) },
      onResult(text) {
        self.setData({ recording: false, voiceHint: '' })
        const answers = Object.assign({}, self.data.answers)
        answers.userNote = (answers.userNote ? answers.userNote + '；' : '') + text
        self.setData({ answers })
        self._appendMsg({ id: self.data.msgId + 1, role: 'user', content: text })
        // 问答流未开始 → 首次语音输入直接启动
        if (!self.data.flowStarted) self._startFlow()
      },
      onError(msg) {
        self.setData({ recording: false, voiceHint: '' })
        wx.showToast({ title: msg || '语音识别失败', icon: 'none' })
      },
      onEnd() { self.setData({ recording: false, voiceHint: '' }) }
    })
  }
})
