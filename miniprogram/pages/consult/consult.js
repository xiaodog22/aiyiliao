/**
 * pages/consult/consult —— 在线问诊（医患图文会话）
 *
 * 版式（对齐 design-output/患者端/04-在线问诊.png，1391×3014）：
 *   ① 自绘导航（返回 + 居中标题；右侧胶囊由微信自绘）
 *   ② 医生信息卡（头像 / 姓名 + 职称胶囊 / 科室 · 互联网医院 / ● 接诊中 / 分隔线 / 等待提示）
 *   ③ 对话流（日期分隔 · 系统胶囊 · 右蓝气泡 + 已发送 · 左白气泡 · 文件卡 · 结构化回复卡 · 正在输入）
 *   ④ 本次问诊摘要（就诊事项 / 已传资料 / 剩余时间）
 *   ⑤ 底部输入栏（＋ / 输入框 / 语音 / 发送）
 *
 * 数据源（契约 · backend/contracts/business-openapi.yaml）：
 *   GET  /api/v1/consultations/{id}            会话详情 + 消息（getConsultation；医生卡字段在此）
 *   GET  /api/v1/consultations                  会话列表（仅元数据 + 摘要）
 *   GET  /api/v1/consultations/{id}/messages    消息正文（详情不可用时的回退通道）
 *   POST /api/v1/consultations/{id}/messages    发送消息（Idempotency-Key 必填）
 *   POST /api/v1/attachments                    上传检查资料（multipart，part 名 file）
 *
 * ⚠️ 不伪造：
 *    · 医生姓名/职称/科室/接诊态一律取服务端字段，缺失 → 「接诊医生」「互联网医院」「待接诊」；
 *      绝不把「未知」写成「接诊中」（会让用户以为医生在线等待）。
 *    · 历史消息接口不可用 → 消息区给可见降级提示，不用本地假数据冒充医生回复。
 *    · 「医生正在输入…」只在**确实有生成任务在跑**时出现（发送成功后轮询到回复为止）。
 *    · 处方/检查建议卡只在服务端下发 message.structured 时渲染，不做关键词猜测。
 */
const app = getApp()
const icons = require('../../utils/icons.js')
const userService = require('../../services/user.js')
const speechService = require('../../services/speech.js')

/**
 * 安全解码 query / objectKey 片段：畸形 % 序列（如 `?dept=%E4%B8`）会让
 * decodeURIComponent 抛 URIError —— 在 onLoad 里抛出即整页白屏（D-B-P2-02）。
 * 解码失败一律退回原文，绝不因为用户手改/转义残缺的链接而白页。
 */
function safeDecode(v) {
  try { return decodeURIComponent(v || '').trim() } catch (e) { return String(v || '').trim() }
}
const { errText } = require('../../utils/err-text.js')
// 时间展示统一走 utils/datetime.js（ISO Instant → 设备本地 'YYYY-MM-DD' / 'HH:mm'）
const { fmtLocalDateTime, dayLabel } = require('../../utils/datetime.js')

const POLL_INTERVAL = 4000   // 等待医生/AI 回复的轮询间隔
const POLL_MAX = 12          // 最多 12 次（≈48s），超时不再打扰服务端
const IMG_RE = /\.(png|jpe?g|webp)(\?|$)/i

Page({
  data: {
    icons,
    theme: 'standard',
    statusBarHeight: 20,
    navH: 64,

    loading: true,
    error: '',
    consultError: '',

    // 医生卡
    doctorName: '接诊医生',
    doctorTitle: '',
    docSub: '互联网医院',
    accepting: false,
    tipText: '医生接诊后会第一时间回复，请稍候…',
    // 「指定医生」发起模式（picker 跳入）：创建会话前先展示所选医生
    pendingDoctorId: '',
    pendingDoctorName: '',
    pendingDoctorTitle: '',
    pendingDocSub: '互联网医院',
    hasDoctor: false,

    // 会话
    activeId: '',
    activeTitle: '',
    attachCount: 0,
    remainingText: '',

    // 消息（已归一化为渲染指令：day / sys / user / doc / file / rx）
    messages: [],
    typing: false,

    // 输入区
    input: '',
    sending: false,
    uploading: false,
    recording: false,

    // 会话终态（ACCEPTED/CLOSED）：CLOSED 时输入栏换成只读提示（医生已结束问诊）
    status: 'ACTIVE',
    closed: false,
    // 输入法高度（px）：只把底部输入栏顶起来，聊天内容与顶部导航原地不动
    kbHeight: 0
  },

  onLoad(options) {
    const q = options || {}
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}

    // 本会话内上传过的附件元信息（objectKey → {name,size}）：
    // 契约 Message 不含原始文件名/大小，重进会话后只能按 objectKey 末段展示。
    this._fileMeta = {}
    this._gone = false

    // 「指定医生」发起模式（picker 页跳入）：?doctorId=… 且无 consultationId
    // ⚠️ query 参数全部经 encodeURIComponent 传递，这里必须 decode（2026-10-24 修复：
    //    此前 doctorName/departmentName 未解码 → 医生卡显示 %E4%B8%BB%E4%BB%B8 乱码）
    const decode = safeDecode
    const doctorId = (q.doctorId || '').trim()
    const pendingDoctorId = doctorId
    const pendingDoctorName = decode(q.doctorName)
    const pendingDoctorTitle = decode(q.doctorTitle)
    const pendingDocSub = decode(q.departmentName)

    this.setData({
      icons,
      theme: app.globalData.theme || 'standard',
      statusBarHeight: sbh,
      navH: sbh + 44,
      activeId: q.consultationId ? decode(q.consultationId) : '',
      pendingDoctorId,
      pendingDoctorName,
      pendingDoctorTitle,
      pendingDocSub: pendingDocSub ? pendingDocSub + ' · 互联网医院' : '互联网医院',
      hasDoctor: !!pendingDoctorId
    })
    this.fetch().then(() => this._startLive())
  },

  onUnload() {
    this._gone = true
    this._stopPolling()
    this._stopLive()
  },

  /** 回到页面：恢复常驻同步（医生接诊 / 回复能实时出现在对话里，与微信聊天一致） */
  onShow() {
    if (this.data.activeId) this._startLive()
  },

  /** 离开页面：停常驻同步，避免后台空转 */
  onHide() {
    this._stopLive()
  },

  onBack() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  },

  /** 空态引导：去选择医生（picker 页） */
  onPickDoctor() {
    wx.navigateTo({ url: '/pages/consult/picker/picker' })
  },

  // ============ 拉取 ============
  /** 详情优先；详情不可用（网络/服务异常）回退「列表 + 消息」；404 直接报错（会话不存在） */
  fetch() {
    if (this._gone) return Promise.resolve()
    this._stopPolling()
    this.setData({ loading: true, error: '', consultError: '', typing: false })

    const id = this.data.activeId
    // 「指定医生」发起模式：无会话、已选医生 → 直接渲染医生卡等待输入，不拉列表
    if (!id && this.data.pendingDoctorId) {
      this.setData({
        loading: false,
        doctorName: this.data.pendingDoctorName || '接诊医生',
        doctorTitle: this.data.pendingDoctorTitle || '',
        docSub: this.data.pendingDocSub || '互联网医院',
        accepting: false,
        tipText: '医生接诊后会第一时间回复，请稍候…',
        messages: [],
        attachCount: 0,
        activeTitle: '',
        remainingText: ''
      })
      return Promise.resolve()
    }
    const first = id ? this._fetchDetail(id) : Promise.resolve(null)

    return first
      .then((detail) => {
        if (detail) {
          this._applyConsultation(detail)
          // 详情已带 messages（契约 OkConsultation）→ 不再多发一次请求
          return this._loadMessages(detail.messages)
        }
        return this._fetchList()
      })
      .catch((err) => {
        this.setData({ loading: false, error: errText(err, '问诊会话加载失败，请重试') })
      })
  },

  _fetchDetail(id) {
    return userService
      .getConsultation(id)
      .then((d) => (d && d.id ? d : null))
      .catch((err) => {
        // 404 = 会话不存在或越权：属于确定性错误，不能拿列表里的别的会话顶替
        if (err && (err.httpCode === 404 || err.statusCode === 404)) throw err
        return null
      })
  },

  _fetchList() {
    return userService.listMyConsultations().then((list) => {
      const arr = Array.isArray(list) ? list : []
      const hit =
        arr.find((c) => c.id === this.data.activeId) ||
        arr.find((c) => c.status === 'ACTIVE') ||
        arr[0]

      if (!hit) {
        this.setData({
          loading: false,
          activeId: '',
          messages: [],
          attachCount: 0,
          activeTitle: '',
          remainingText: ''
        })
        return
      }
      this._applyConsultation(hit)
      return this._loadMessages()
    })
  },

  /** 会话元数据 → 医生卡 + 摘要卡（字段缺失走中性占位，不猜） */
  _applyConsultation(c) {
    const accepting = c.accepting === true
    const status = c.status || 'ACTIVE'
    const closed = status === 'CLOSED'
    this.setData({
      loading: false,
      activeId: c.id || this.data.activeId,
      doctorName: c.doctorName || '接诊医生',
      doctorTitle: c.doctorTitle || '',
      docSub: c.departmentName ? c.departmentName + ' · 互联网医院' : '互联网医院',
      accepting,
      status,
      closed,
      tipText: closed
        ? '本次问诊已结束，如需再次咨询请重新发起'
        : (accepting
          ? '医生正在查看您的描述，请稍候…'
          : '医生接诊后会第一时间回复，请稍候…'),
      activeTitle: c.title || '',
      remainingText: closed ? '' : this._remainingText(c)
    })
  },

  /**
   * 剩余时间：只认服务端下发的 remainingMinutes / expiresAt。
   * 契约当前没有该字段 → 返回空串，摘要卡不渲染该行（不自己按 createdAt 推算倒计时）。
   */
  _remainingText(c) {
    const mins = Number(c && c.remainingMinutes)
    if (isFinite(mins) && mins > 0) return '问诊剩余' + Math.floor(mins) + '分钟'
    const exp = c && c.expiresAt
    if (exp) {
      const t = new Date(exp).getTime()
      if (!isNaN(t)) {
        const left = Math.floor((t - Date.now()) / 60000)
        if (left > 0) return '问诊剩余' + left + '分钟'
      }
    }
    return ''
  },

  // ============ 消息 ============
  /**
   * 拉取消息正文并归一化为渲染指令。
   * 接口失败时保留会话信息，只在消息区给可见提示（防御性降级，不伪造医生回复）。
   */
  _loadMessages(prefetched) {
    const id = this.data.activeId
    if (!id) return Promise.resolve()

    const p = Array.isArray(prefetched)
      ? Promise.resolve(prefetched)
      : userService.listConsultationMessages(id)

    return p
      .then((list) => {
        const raw = Array.isArray(list) ? list : []
        const prevCount = this.data.messages.length
        const items = []
        let lastDate = ''

        raw.forEach((m) => {
          const t = fmtLocalDateTime(m.createdAt)
          // 日期分隔：仅在跨天时插一条（设计稿「—— 今天 9:30 ——」）
          if (t.date && t.date !== lastDate) {
            lastDate = t.date
            items.push({
              id: 'day-' + t.date,
              kind: 'day',
              label: (dayLabel(m.createdAt) || t.date) + (t.time ? ' ' + t.time : '')
            })
          }
          const it = this._normMessage(m, t)
          if (it) items.push(it)
        })

        const patch = {
          messages: items,
          attachCount: items.filter((x) => x.kind === 'file').length,
          consultError: ''
        }
        // 兜底：会话已有医生侧消息（回复 / 接诊系统提示）→ 必然已接诊。
        // 详情接口偶发失败或元信息轮询未到时，不能让状态停在「待接诊」误导患者。
        const hasDoctorSide = items.some((x) => x.kind === 'doc' || x.kind === 'rx')
        if (hasDoctorSide && !this.data.accepting) {
          patch.accepting = true
          patch.tipText = '医生正在查看您的描述，请稍候…'
        }
        this.setData(patch)
        // 只在消息数变化时滚到底：轮询期间用户可能正在翻历史，不能每次都把他拽回来
        if (items.length !== prevCount) this._scrollToBottom()
      })
      .catch((err) => {
        this.setData({ messages: [], attachCount: 0, consultError: errText(err, '历史消息暂不可用') })
      })
  },

  /** 单条契约 Message → 渲染指令 */
  _normMessage(m, t) {
    const role = String(m.role || '')
    const ct = String(m.contentType || '')
    const id = m.id || role + '-' + (m.createdAt || Math.random())
    const timeText = (t && t.time) || ''

    // 系统 / 安全提示：居中胶囊（安全提示走橙色，必须比普通提示醒目）
    if (role === 'system_notice' || ct === 'SAFETY_NOTICE') {
      return { id, kind: 'sys', text: m.content || '', safety: ct === 'SAFETY_NOTICE' }
    }

    // 附件：图片走缩略图，其余走文件卡
    if (ct === 'IMAGE_NOTE') {
      const key = String(m.content || '')
      const meta = this._fileMeta[key] || {}
      const base = key.split('/').pop() || ''
      const name = meta.name || (base ? safeDecode(base) : '检查资料')
      return {
        id,
        kind: 'file',
        url: key ? userService.resolveAttachmentUrl(key) : '',
        isImage: IMG_RE.test(name),
        isPdf: /\.pdf(\?|$)/i.test(name),
        fileName: name,
        fileSub: meta.size ? '已上传 · ' + this._sizeText(meta.size) : '已上传'
      }
    }

    // 结构化回复（处方建议 / 检查建议）：服务端下发才渲染，否则回落普通气泡
    const rx = this._normStructured(m.structured)
    if (rx) return Object.assign({ id, kind: 'rx' }, rx)

    return { id, kind: role === 'user' ? 'user' : 'doc', text: m.content || '', timeText }
  },

  /**
   * message.structured → 卡片数据
   * 形如 { kind:'PRESCRIPTION'|'EXAM', title, items:[{name,dose}], note }
   * ⚠️ 契约 Message 暂无该字段（见 页面复刻文档 偏离项）；无有效条目 → 返回 null，不做半截卡片。
   */
  _normStructured(st) {
    if (!st || typeof st !== 'object') return null
    const kind = String(st.kind || '').toUpperCase()
    const items = Array.isArray(st.items) ? st.items : []
    const rows = items
      .map((it) => ({
        name: String((it && (it.name || it.title)) || ''),
        dose: String((it && (it.dose || it.detail)) || '')
      }))
      .filter((it) => it.name)
    if (!rows.length) return null

    const isExam = kind === 'EXAM' || kind === 'EXAM_ADVICE'
    return {
      rxIcon: isExam ? icons.flask : icons.pill,
      rxTitle: st.title || (isExam ? '检查建议' : '处方建议'),
      rxItems: rows,
      rxNote: st.note || ''
    }
  },

  _sizeText(bytes) {
    const n = Number(bytes) || 0
    if (n <= 0) return ''
    if (n < 1024) return n + 'B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB'
    return (n / 1024 / 1024).toFixed(1) + 'MB'
  },

  _scrollToBottom() {
    if (typeof wx.pageScrollTo !== 'function') return
    wx.pageScrollTo({ scrollTop: 99999, duration: 200 })
  },

  // ============ 输入 / 发送 ============
  onInput(e) {
    this.setData({ input: (e && e.detail && e.detail.value) || '' })
  },

  onSend() {
    if (this.data.sending) return
    if (this.data.closed) {
      wx.showToast({ title: '本次问诊已结束', icon: 'none' })
      return
    }
    const text = (this.data.input || '').trim()
    if (!text) return   // 空输入静默返回：设计稿发送键常亮，不弹提示打扰
    this.onSendText(text)
  },

  // ============ 输入法适配 ============
  /**
   * 输入法高度（bindfocus / bindkeyboardheightchange 共用）。
   * ⚠️ 关闭 adjust-position：否则微信会把整页（含吸顶导航与医生卡）一起顶上去。
   * 这里只把高度写进 data → 底部输入栏 translateY 上移 + 内容区补一段等高占位，
   * 顶部导航和聊天内容原地不动（微信对话的观感）。
   */
  onKbHeight(e) {
    const h = Math.max(0, Math.round(Number(((e && e.detail) || {}).height) || 0))
    if (h === this.data.kbHeight) return
    this.setData({ kbHeight: h }, () => { if (h > 0) this._scrollToBottom() })
  },

  onKbBlur() {
    if (this.data.kbHeight) this.setData({ kbHeight: 0 })
  },

  /**
   * 发送文本（契约 MessageCreate：content + inputMode=TEXT）
   * ⚠️ 幂等键：一次用户操作一个键；超时重试必须复用同一键（服务端按键去重）。
   * 无会话但有已选医生 → 先 POST /api/v1/consultations 创建（带 doctorId 直接分配）再发送；
   * 无会话且未选医生 → 引导去选医生。
   */
  onSendText(text) {
    const id = this.data.activeId
    if (!id) {
      if (!this.data.pendingDoctorId) {
        wx.showToast({ title: '请先选择医生，再发起问诊', icon: 'none' })
        return Promise.resolve()
      }
      return this._createThenSend(text)
    }
    this.setData({ sending: true, input: '' })
    return userService
      .sendConsultationMessage(id, { content: text, inputMode: 'TEXT' })
      .then(() => this._loadMessages())
      .then(() => {
        // 以「自己这条已落库之后」的条数为基准：再涨一条 = 医生/AI 回复到达
        this._startPolling(this.data.messages.length)
      })
      .catch((err) => {
        const code = (err && (err.httpCode || err.statusCode)) || 0
        if (code === 409) {
          // 医生已结束本次问诊：锁输入并显示终态，而不是让患者反复重试
          this._stopPolling()
          this._stopLive()
          this.setData({
            input: '',
            closed: true,
            status: 'CLOSED',
            tipText: '本次问诊已结束，如需再次咨询请重新发起',
            remainingText: ''
          })
          wx.showToast({ title: '本次问诊已结束', icon: 'none' })
          return
        }
        // 发送失败要把原文还给用户，不能让他重新敲一遍
        this.setData({ input: text })
        wx.showToast({ title: errText(err, '发送失败，请重试'), icon: 'none' })
      })
      .then(() => this.setData({ sending: false }))
  },

  /** 指定医生发起：创建会话（带 doctorId）→ 切入会话模式 → 发送首条消息 */
  _createThenSend(text) {
    this.setData({ sending: true, input: '' })
    const payload = {
      initialMessage: text,
      inputMode: 'TEXT',
      doctorId: this.data.pendingDoctorId
    }
    return userService
      .createConsultation(payload)
      .then((created) => {
        const c = (created && created.consultation) || created || {}
        if (!c.id) throw Object.assign(new Error('创建会话响应缺少会话编号'), { code: 'BIZ_ERROR' })
        this.setData({
          activeId: c.id,
          pendingDoctorId: '',
          hasDoctor: false,
          doctorName: c.doctorName || this.data.pendingDoctorName || '接诊医生',
          doctorTitle: c.doctorTitle || this.data.pendingDoctorTitle || '',
          docSub: c.departmentName
            ? c.departmentName + ' · 互联网医院'
            : this.data.pendingDocSub || '互联网医院',
          accepting: c.accepting === true,
          tipText: c.accepting === true
            ? '医生正在查看您的描述，请稍候…'
            : '医生接诊后会第一时间回复，请稍候…',
          activeTitle: c.title || '',
          remainingText: this._remainingText(c)
        })
        return this._loadMessages(c.messages)
      })
      .then(() => {
        // 创建成功：医生/AI 可能已回首条 → 从当前条数起轮询
        this._startPolling(this.data.messages.length)
      })
      .catch((err) => {
        this.setData({ input: text, sending: false })
        if (err && (err.code === 'DOCTOR_NOT_FOUND' || err.httpCode === 404)) {
          wx.showToast({ title: '该医生暂不可接诊，请重新选择', icon: 'none', duration: 2500 })
        } else {
          wx.showToast({ title: errText(err, '发起问诊失败，请重试'), icon: 'none', duration: 2500 })
        }
        return Promise.reject(err)
      })
      .then(() => this.setData({ sending: false }))
  },

  /** 发送后轮询消息，直到出现新回复 / 超时 / 离页 */
  _startPolling(before) {
    this._stopPolling()
    if (!this.data.activeId || this.data.consultError) return
    let tries = 0
    this.setData({ typing: true })

    const tick = () => {
      if (this._gone) return
      tries += 1
      this._loadMessages().then(() => {
        if (this._gone) return
        const grew = this.data.messages.length > before
        if (grew || tries >= POLL_MAX) {
          // ⚠️ 必须置 null：常驻同步（_liveTick）以 _pollTimer 是否为空判断"短轮询是否在进行"，
          //    只 return 不清空会让它永远让位，医生回复就再也拉不到（2026-10-24）
          this._pollTimer = null
          this.setData({ typing: false })
          return
        }
        this._pollTimer = setTimeout(tick, POLL_INTERVAL)
      })
    }
    this._pollTimer = setTimeout(tick, POLL_INTERVAL)
  },

  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  },

  // ============ 常驻同步（2026-10-24：医生接诊/回复实时可见） ============
  /**
   * 会话内常驻轮询：每 4s 拉消息；每 12s 拉一次会话详情，同步「正在接诊」等元信息。
   * 发送后的短轮询（_startPolling）进行中时让位，避免两套定时器重复请求。
   */
  _startLive() {
    this._stopLive()
    if (this._gone || !this.data.activeId || this.data.closed) return
    this._liveTimer = setTimeout(() => this._liveTick(), POLL_INTERVAL)
  },

  _stopLive() {
    if (this._liveTimer) {
      clearTimeout(this._liveTimer)
      this._liveTimer = null
    }
  },

  _liveTick() {
    if (this._gone || !this.data.activeId) return
    if (this._pollTimer) { this._startLive(); return }
    const round = (this._liveRound = (this._liveRound || 0) + 1)
    const before = this.data.messages.length
    const jobs = [this._loadMessages()]
    if (round % 3 === 0) jobs.push(this._syncMeta())
    Promise.all(jobs)
      .then(() => {
        // 拉到新回复即收起「正在输入」
        if (this.data.messages.length !== before && this.data.typing) this.setData({ typing: false })
      })
      .catch(() => { /* 轮询失败静默，下一轮重试 */ })
      .then(() => this._startLive())
  },

  /** 只同步会话元信息（接诊态 / 医生卡 / 剩余时间），不动消息列表 */
  _syncMeta() {
    const id = this.data.activeId
    if (!id) return Promise.resolve()
    return userService.getConsultation(id)
      .then((d) => { if (d && d.id) this._applyConsultation(d) })
      .catch(() => { /* 元信息失败不影响消息流 */ })
  },

  // ============ 附件 ============
  /** ＋：拍照 / 相册 / 聊天文件（检查报告多为图片或 PDF） */
  onPickAttach() {
    if (this.data.uploading) return
    if (!this.data.activeId) {
      wx.showToast({ title: this.data.pendingDoctorId ? '请先发送首条消息创建会话' : '请先选择医生发起问诊', icon: 'none' })
      return
    }
    const items = ['拍照上传', '从相册选择', '选择聊天文件']
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        if (res.tapIndex === 0) this._pickImage('camera')
        else if (res.tapIndex === 1) this._pickImage('album')
        else this._pickFile()
      },
      fail: () => {}   // 用户取消，不算错误
    })
  },

  _pickImage(sourceType) {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: [sourceType],
      sizeType: ['compressed'],
      success: (res) => {
        const f = (res.tempFiles || [])[0]
        if (!f) return
        const name = sourceType === 'camera' ? '照片.jpg' : (f.tempFilePath || '').split('/').pop() || '照片.jpg'
        this._uploadAndSend(f.tempFilePath, f.size, name)
      },
      fail: (e) => { console.warn('[consult] 选择图片被取消', e) }
    })
  },

  _pickFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
      success: (res) => {
        const f = (res.tempFiles || [])[0]
        if (!f) return
        this._uploadAndSend(f.path, f.size, f.name || '检查资料')
      },
      fail: (e) => { console.warn('[consult] 选择文件被取消', e) }
    })
  },

  /**
   * 上传 → 以 IMAGE_NOTE 消息发出。
   * ⚠️ 前端不构造任何 URL（objectKey 由服务端下发）；uploading 兼作防重复闸门。
   */
  _uploadAndSend(path, size, name) {
    if (!path) return
    if (size > 10 * 1024 * 1024) {
      wx.showToast({ title: '文件超过 10MB，请压缩后再试', icon: 'none' })
      return
    }
    const id = this.data.activeId
    this.setData({ uploading: true })
    userService
      .uploadAttachment(null, path)
      .then((att) => {
        const objectKey = (att && (att.objectKey || att.object_key)) || ''
        if (!objectKey) throw new Error('EMPTY_KEY')
        // 记下本次会话的真实文件名/大小：契约消息体不带这两项，重载后按 objectKey 末段展示
        this._fileMeta[objectKey] = { name, size }
        return userService.sendConsultationMessage(id, { content: objectKey, inputMode: 'IMAGE' })
      })
      .then(() => this._loadMessages())
      .catch((err) => {
        wx.showToast({ title: errText(err, '上传失败，请重试'), icon: 'none' })
      })
      .then(() => this.setData({ uploading: false }))
  },

  onPreviewAttach(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ urls: [url], current: url })
  },

  /** 文件卡：PDF 走 downloadFile → openDocument（openDocument 只吃本地路径） */
  onOpenFile(e) {
    const url = e.currentTarget.dataset.url
    const isPdf = e.currentTarget.dataset.pdf === true || e.currentTarget.dataset.pdf === 'true'
    if (!url) return
    if (!isPdf) {
      wx.previewImage({ urls: [url], current: url })
      return
    }
    wx.showLoading({ title: '正在打开', mask: true })
    wx.downloadFile({
      url,
      success: (res) => {
        // ⚠️ downloadFile 对 4xx/5xx 也走 success，必须自己判状态码
        if (res.statusCode !== 200) {
          wx.hideLoading()
          wx.showToast({ title: '文件暂时无法打开，请稍后重试', icon: 'none' })
          return
        }
        wx.openDocument({
          filePath: res.tempFilePath,
          showMenu: true,
          complete: () => wx.hideLoading(),
          fail: () => wx.showToast({ title: '暂不支持预览该格式', icon: 'none' })
        })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '文件下载失败，请检查网络', icon: 'none' })
      }
    })
  },

  // ============ 语音 ============
  /**
   * 语音输入：点按开始 → 再点结束（≤60s）→ ASR 转写回填输入框。
   * 与第 4 页（pages/consultation）同一套交互，转写不自动发送 —— 医疗描述允许先改再发。
   */
  onVoice() {
    if (this.data.recording) {
      speechService.stopRecord()
      return
    }
    if (this.data.sending) return
    this.setData({ recording: true })
    speechService.startRecord({
      onStart: () => { this.setData({ recording: true }) },
      onRecognizing: () => { this.setData({ recording: false }) },
      onResult: (text) => {
        const old = (this.data.input || '').trim()
        const next = old ? old + text : text
        this.setData({ recording: false, input: next })
        wx.showToast({ title: '已转成文字，可编辑后发送', icon: 'none' })
      },
      onError: (msg) => {
        this.setData({ recording: false })
        wx.showToast({ title: msg || '语音识别失败，请改用文字输入', icon: 'none' })
      },
      onEnd: () => { this.setData({ recording: false }) }
    })
  }
})
