/**
 * pages/doctor/consult/consult —— 医生端「在线问诊处理」
 *
 * 数据源（契约后端已实现）：
 *   GET  /api/v1/doctor/consultations                医生名下会话列表（cursor 分页）
 *   GET  /api/v1/doctor/consultations/{id}/messages  医生视角会话消息（旧→新升序）
 *   POST /api/v1/doctor/consultations/{id}/accept    认领未分配会话（接诊 → 写系统提示 + 患者端状态同步）
 *   POST /api/v1/consultations/{id}/doctor-reply     医生回复（Idempotency-Key 必填；写患者消息中心）
 *
 * 两种模式（单页承载，setData 切换）：
 *   LIST —— 待接诊 / 正在接诊会话列表；CHAT 轮询 4s、LIST 轮询 8s（患者新消息实时进列表）
 *   CHAT —— 与患者端一致的微信式对话：患者左 / 医生右 / 系统提示居中 / 日期分隔
 *
 * ⚠️ WXML 表达式不能调用方法（历史白屏根因：`{{input.trim()}}`）→ 用 data.canSend。
 * ⚠️ 修复（2026-10-24）：fmtLocalDateTime 返回 {date,time} 对象，此前直接塞进 time 字段
 *    → 气泡时间渲染成 [object Object]，现统一取 .time。
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const doctorService = require('../../../services/doctor.js')
const { errText } = require('../../../utils/err-text.js')
const { fmtLocalDateTime, dayLabel } = require('../../../utils/datetime.js')

const PAGE_SIZE = 50
const CHAT_POLL = 4000   // 会话内新消息（对齐患者端 4s）
const LIST_POLL = 8000   // 列表模式：患者新发起 / 新消息

Page({
  data: {
    icons,
    theme: 'standard',
    statusBarHeight: 20,
    navH: 64,

    mode: 'LIST',          // LIST | CHAT
    list: [],
    nextCursor: '',
    listLoading: true,
    listError: '',
    acceptingId: '',       // 正在接诊的会话 id（防重复点击，按行禁用而不是整页禁用）

    active: null,          // { id, patientName, initial, title, assigned, accepting, status }
    messages: [],          // 渲染指令：{ id, kind: day|sys|patient|doctor, content|label, time }
    msgLoading: true,
    msgError: '',
    msgErrorKind: '',      // noaccess（未接诊/非本人）| other
    scrollInto: '',

    input: '',
    canSend: false,
    sending: false,
    replyError: '',
    closing: false,        // 结束问诊请求进行中（防重复点）
    kbHeight: 0            // 输入法高度（px）：只用于把输入栏顶起来，页面整体不位移
  },

  onLoad(options) {
    // 角色拦截：其余 7 个医生端页面都在首行做同一判断，本页此前漏了（审查 P1-06）——
    // 患者已登录时用深链（二维码/调试器编译目标页）可直接进入医生聊天空壳。
    // 数据层有 404 兜底不泄露他人消息，但"客户端门"必须与其他页一致。
    if (app.globalData.role !== 'doctor') {
      wx.reLaunch({ url: '/pages/auth/login/login' })
      return
    }
    const q = options || {}
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}
    this._gone = false
    this.setData({
      icons,
      theme: app.globalData.theme || 'standard',
      statusBarHeight: sbh,
      navH: sbh + 44
    })

    const id = this._decode(q.id)
    if (id) {
      // 从消息中心直达某个会话：先渲染会话骨架，列表静默补齐患者名/接诊态
      this.setData({
        mode: 'CHAT',
        active: { id, patientName: '患者', initial: '者', title: '在线问诊', assigned: true, accepting: false, status: 'ACTIVE' },
        messages: [],
        msgLoading: true
      })
      this._lastSig = ''
      this.loadMessages(id)
      this._startPoll()
      this.loadList(true)
    } else {
      this.loadList()
    }
  },

  onShow() {
    // 从其它页返回：续轮询（LIST 刷新一次，CHAT 继续拉消息）
    if (this.data.mode === 'CHAT' && this.data.active) {
      this.loadMessages(this.data.active.id)
      this._startPoll()
    } else {
      this.loadList(true)
      this._startListPoll()
    }
  },

  onHide() {
    this._stopPoll()
    this._stopListPoll()
  },

  onUnload() {
    this._gone = true
    this._stopPoll()
    this._stopListPoll()
  },

  _decode(v) {
    const s = String(v == null ? '' : v)
    if (!s) return ''
    try { return decodeURIComponent(s).trim() } catch (e) { return s.trim() }
  },

  /** 姓名首字（患者头像占位；姓名缺失回落「患」） */
  _initial(name) {
    const s = String(name || '').trim()
    return s ? s.slice(0, 1) : '患'
  },

  /** 契约 DoctorConsultationData → 列表行 */
  _mapRow(it) {
    const name = it.patientName || '患者'
    const at = it.lastMessageAt || ''
    const t = at ? fmtLocalDateTime(at) : { date: '', time: '' }
    return {
      id: it.id,
      title: it.title || '在线问诊',
      patientName: name,
      initial: this._initial(name),
      lastTime: t.time || t.date || '',
      lastAt: at,
      summary: it.summary || '',
      messageCount: it.messageCount || 0,
      status: it.status || 'ACTIVE',
      // assignedDoctorId 非空 = 已归本人（可直接回复）；空 = 认领池（需先接诊）
      assigned: !!it.assignedDoctorId,
      // accepting = 会话内已有医生侧消息（后端 hasNonUserMessage），与患者端医生卡同源
      accepting: it.accepting === true
    }
  },

  // ==================== 列表模式 ====================

  /**
   * 拉会话列表。
   * @param {boolean} [silent] 静默刷新（轮询/从消息中心补齐）：不改 loading，不重置分页
   */
  loadList(silent) {
    const quiet = silent === true
    if (!quiet) this.setData({ listLoading: true, listError: '', list: [], nextCursor: '' })
    return doctorService.listConsultations({ cursor: quiet ? undefined : (this.data.nextCursor || undefined) })
      .then(({ items, nextCursor }) => {
        if (this._gone) return
        const rows = (Array.isArray(items) ? items : []).map((it) => this._mapRow(it))
        // 最新消息置顶（微信聊天惯例）；后端 listByDoctor 仍按 created_at ASC（未分配置前），前端纠正展示
        const list = rows.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '')
          || String(b.id).localeCompare(String(a.id)))
        // 静默刷新也整体替换为第一页 → cursor 必须跟着重置，否则「加载更多」会接在旧游标后面重复
        this.setData({ list, nextCursor: nextCursor || '', listLoading: false })

        // CHAT 模式静默补齐当前会话元信息（从消息中心直达时列表为空）
        const cur = this.data.active
        if (cur && cur.id) {
          const hit = list.find((it) => it.id === cur.id)
          if (hit) {
            this.setData({
              'active.patientName': hit.patientName,
              'active.initial': hit.initial,
              'active.title': hit.title,
              'active.assigned': hit.assigned,
              'active.accepting': hit.accepting || this.data.active.accepting
            })
          }
        }
      })
      .catch((e) => {
        if (this._gone) return
        this.setData({ listLoading: false, listError: errText(e) })
      })
  },

  reloadList() {
    this.loadList()
  },

  onLoadMore() {
    if (this.data.mode !== 'LIST' || this.data.listLoading || !this.data.nextCursor) return
    doctorService.listConsultations({ cursor: this.data.nextCursor })
      .then(({ items, nextCursor }) => {
        if (this._gone) return
        const more = (Array.isArray(items) ? items : []).map((it) => this._mapRow(it))
        const list = this.data.list.concat(more)
          .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '')
            || String(b.id).localeCompare(String(a.id)))
        this.setData({ list, nextCursor: nextCursor || '', listLoading: false })
      })
      .catch((e) => {
        if (this._gone) return
        this.setData({ listLoading: false, listError: errText(e) })
      })
  },

  _startListPoll() {
    this._stopListPoll()
    if (this._gone || this.data.mode !== 'LIST') return
    this._listTimer = setTimeout(() => {
      if (this._gone || this.data.mode !== 'LIST') return
      this.loadList(true).then(() => this._startListPoll())
    }, LIST_POLL)
  },

  _stopListPoll() {
    if (this._listTimer) {
      clearTimeout(this._listTimer)
      this._listTimer = null
    }
  },

  /** 列表行点击：已接诊 → 进会话；未接诊 → 接诊 */
  onItemTap(e) {
    const id = (e.currentTarget.dataset || {}).id || ''
    if (!id) return
    const hit = this.data.list.find((it) => it.id === id)
    if (hit && !hit.assigned) {
      this.onAccept(e)
      return
    }
    this.openChat(id)
  },

  /** 接诊：认领成功 → 直接进入会话（不必再点第二次），并置顶刷新列表 */
  onAccept(e) {
    const id = (e.currentTarget.dataset || {}).id || ''
    if (!id || this.data.acceptingId) return
    this.setData({ acceptingId: id })
    doctorService.acceptConsultation(id)
      .then(() => {
        if (this._gone) return
        const idx = this.data.list.findIndex((it) => it.id === id)
        if (idx >= 0) {
          this.setData({
            ['list[' + idx + '].assigned']: true,
            ['list[' + idx + '].accepting']: true
          })
        }
        this.setData({ acceptingId: '' })
        wx.showToast({ title: '已接诊，请回复患者', icon: 'success', duration: 1200 })
        this.openChat(id)
        this.loadList(true)
      })
      .catch((err) => {
        if (this._gone) return
        this.setData({ acceptingId: '' })
        wx.showToast({ title: errText(err, '接诊失败，请重试'), icon: 'none' })
        this.loadList(true)
      })
  },

  // ==================== 会话模式 ====================

  openChat(id) {
    if (!id) return
    const found = this.data.list.find((it) => it.id === id)
    if (found && !found.assigned) {
      wx.showToast({ title: '请先接诊后再回复', icon: 'none' })
      return
    }
    const name = (found && found.patientName) || '患者'
    this.setData({
      mode: 'CHAT',
      active: {
        id,
        patientName: name,
        initial: this._initial(name),
        title: (found && found.title) || '在线问诊',
        assigned: found ? found.assigned : true,
        accepting: found ? found.accepting : false,
        // 列表只返回 ACTIVE 会话 → 命中列表必为 ACTIVE；深链进来先乐观置 ACTIVE，
        // 真已结束时发送会被后端 409 拦下并即时切成「已结束」（见 sendReply）
        status: (found && found.status) || 'ACTIVE'
      },
      messages: [],
      msgLoading: true,
      msgError: '',
      msgErrorKind: '',
      input: '',
      canSend: false,
      replyError: '',
      kbHeight: 0
    })
    this._lastSig = ''
    this._stopListPoll()
    this.loadMessages(id)
    this._startPoll()
  },

  backToList() {
    this._stopPoll()
    this.setData({ mode: 'LIST', messages: [], active: null, input: '', canSend: false, replyError: '', kbHeight: 0 })
    this.loadList(true)
    this._startListPoll()
  },

  onBack() {
    if (this.data.mode === 'CHAT') {
      this.backToList()
      return
    }
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
      return
    }
    wx.navigateTo({ url: '/pages/doctor/workbench/workbench' })
  },

  // ==================== 消息 ====================

  /**
   * 契约 Message[] → 渲染指令（含日期分隔与系统提示）。
   * role: user（患者）| doctor / assistant（医生侧）| system_notice（居中提示）
   */
  _normMessages(items) {
    const out = []
    let lastDay = ''
    ;(Array.isArray(items) ? items : []).forEach((m) => {
      const role = String(m.role || '')
      const t = m.createdAt ? fmtLocalDateTime(m.createdAt) : { date: '', time: '' }
      const day = m.createdAt ? dayLabel(m.createdAt) : ''
      if (day && day !== lastDay) {
        out.push({ id: 'day-' + day + '-' + out.length, kind: 'day', label: day })
        lastDay = day
      }
      if (role === 'system_notice') {
        out.push({ id: m.id || ('sys-' + out.length), kind: 'sys', content: m.content || '' })
        return
      }
      out.push({
        id: m.id || (role + '-' + out.length),
        kind: role === 'user' ? 'patient' : 'doctor',
        content: m.content || '',
        time: t.time || t.date || ''
      })
    })
    return out
  },

  loadMessages(arg) {
    const evt = arg && arg.currentTarget
    const id = evt ? ((evt.dataset || {}).id || (this.data.active || {}).id) : (arg || (this.data.active || {}).id)
    if (!id || !this.data.active || this.data.active.id !== id) return Promise.resolve()
    this.setData({ msgLoading: true, msgError: '', msgErrorKind: '' })
    return doctorService.consultationMessages(id, { limit: PAGE_SIZE })
      .then(({ items }) => {
        if (this._gone || !this.data.active || this.data.active.id !== id) return
        const rendered = this._normMessages(items)
        const patch = { messages: rendered, msgLoading: false }
        // 服务端已有医生侧消息 → 必然已接诊（详情接口和列表接口同源判定）
        if (rendered.some((m) => m.kind === 'doctor' || m.kind === 'sys')) patch['active.accepting'] = true
        this.setData(patch)
        this._lastSig = rendered.map((m) => m.id).join(',')
        this._scrollBottom()
      })
      .catch((e) => {
        if (this._gone || !this.data.active || this.data.active.id !== id) return
        const code = (e && (e.httpCode || e.statusCode)) || 0
        const noAccess = code === 404
        this.setData({
          msgLoading: false,
          messages: [],
          msgError: noAccess ? '该会话尚未接诊或不属于您，请返回列表重新接诊' : errText(e),
          msgErrorKind: noAccess ? 'noaccess' : 'other',
          // 无权访问时锁住输入（否则医生输完才发现发不出去）
          'active.assigned': noAccess ? false : this.data.active.assigned
        })
      })
  },

  onRetryMessages(e) {
    const id = (e.currentTarget.dataset || {}).id || (this.data.active || {}).id
    if (id) this.loadMessages(id)
  },

  _scrollBottom() {
    // scroll-into-view 同值不会触发滚动：先清空再置，下一帧生效
    this.setData({ scrollInto: '' }, () => {
      if (this._gone) return
      wx.nextTick(() => this.setData({ scrollInto: 'msg-bottom' }))
    })
  },

  _startPoll() {
    this._stopPoll()
    if (this._gone || this.data.mode !== 'CHAT' || !this.data.active) return
    this._pollTimer = setTimeout(() => this._pollTick(), CHAT_POLL)
  },

  _stopPoll() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  },

  /** 轮询新消息：内容有变化才整页替换并滚底（条数相同但内容变也刷新，避免漏最后一条） */
  _pollTick() {
    const active = this.data.active
    if (this._gone || this.data.mode !== 'CHAT' || !active) return
    doctorService.consultationMessages(active.id, { limit: PAGE_SIZE })
      .then(({ items }) => {
        if (this._gone || this.data.mode !== 'CHAT' || !this.data.active
          || this.data.active.id !== active.id) return
        const rendered = this._normMessages(items)
        const sig = rendered.map((m) => m.id).join(',')
        if (sig !== this._lastSig) {
          this._lastSig = sig
          const patch = { messages: rendered, msgError: '', msgErrorKind: '' }
          if (rendered.some((m) => m.kind === 'doctor' || m.kind === 'sys')) patch['active.accepting'] = true
          this.setData(patch, () => this._scrollBottom())
        }
      })
      .catch(() => { /* 轮询失败静默：不打断医生输入，下一轮重试 */ })
      .then(() => this._startPoll())
  },

  // ==================== 键盘 / 结束问诊 ====================

  /**
   * 输入法高度（input 的 bindfocus / bindkeyboardheightchange 共用）。
   * ⚠️ 不用 adjust-position：那会把整页（含自绘导航、患者卡）一起顶上去。
   * 这里只把高度写进页面 padding-bottom → 输入栏上移、聊天区变矮，头部原地不动。
   */
  onKbHeight(e) {
    const h = Math.max(0, Math.round(Number(((e && e.detail) || {}).height) || 0))
    if (h === this.data.kbHeight) return
    this.setData({ kbHeight: h }, () => {
      if (h > 0) this._scrollBottom()   // 视野变矮后把最后一条消息重新贴到输入栏上方
    })
  },

  onKbBlur() {
    if (this.data.kbHeight) this.setData({ kbHeight: 0 })
  },

  /**
   * 结束本次问诊（仅归属医生；二次确认后调用）。
   * 成功：服务端 status=CLOSED + 写系统提示 + 通知患者 → 本地锁输入、停轮询、回列表刷新。
   * 409：说明已被结束（并发/重放）→ 按「已结束」处理，不报错。
   */
  onCloseConsult() {
    const active = this.data.active
    if (!active || !active.id || this.data.closing) return
    if (active.status === 'CLOSED') return
    wx.showModal({
      title: '结束本次问诊',
      content: '结束后双方都无法继续发送消息，患者会收到「问诊已结束」通知。确定结束吗？',
      confirmText: '确定结束',
      confirmColor: '#D93025',
      cancelText: '继续问诊',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ closing: true })
        doctorService.closeConsultation(active.id)
          .then(() => {
            if (this._gone) return
            this._stopPoll()
            this.setData({
              'active.status': 'CLOSED',
              closing: false,
              kbHeight: 0,
              input: '',
              canSend: false,
              replyError: ''
            })
            // 拉一次消息：把服务端写入的 system_notice（「已结束」）显示出来，而不是本地造一条
            this.loadMessages(active.id)
            wx.showToast({ title: '问诊已结束', icon: 'success', duration: 1200 })
            this.loadList(true)
          })
          .catch((err) => {
            if (this._gone) return
            const code = (err && (err.httpCode || err.statusCode)) || 0
            if (code === 409) {
              // 已被结束：终态一致，锁输入即可
              this._stopPoll()
              this.setData({ 'active.status': 'CLOSED', closing: false, kbHeight: 0, input: '', canSend: false })
              this.loadMessages(active.id)
              wx.showToast({ title: '该问诊已结束', icon: 'none' })
              this.loadList(true)
              return
            }
            if (code === 404) {
              // 非本人 / 尚未接诊：不能收口，也不该让医生以为点错了按钮
              this.setData({ closing: false })
              wx.showToast({ title: '该会话不属于您，请返回列表重新接诊', icon: 'none' })
              return
            }
            this.setData({ closing: false })
            wx.showToast({ title: errText(err, '结束失败，请重试'), icon: 'none' })
          })
      }
    })
  },

  // ==================== 回复 ====================

  onInput(e) {
    const v = (e.detail && e.detail.value) || ''
    this.setData({ input: v, canSend: !!String(v).trim(), replyError: '' })
  },

  /** 发送回复：服务端校验医生归属 + 会话 ACTIVE + 幂等键；失败保留输入 */
  sendReply() {
    const content = String(this.data.input || '').trim()
    const active = this.data.active
    if (!content || !active || this.data.sending) return
    if (!active.assigned) {
      wx.showToast({ title: '请先接诊后再回复', icon: 'none' })
      return
    }
    this.setData({ sending: true, replyError: '' })
    doctorService.doctorReply(active.id, content)
      .then((res) => {
        if (this._gone) return
        const m = (res && res.message) || {}
        const t = m.createdAt ? fmtLocalDateTime(m.createdAt) : { time: '' }
        this.setData({
          messages: this.data.messages.concat([{
            id: m.id || ('reply-' + Date.now()),
            kind: 'doctor',
            content: m.content || content,
            time: t.time || ''
          }]),
          'active.accepting': true,   // 回复即视为已接诊（与后端 hasNonUserMessage 同义）
          input: '',
          canSend: false,
          sending: false
        })
        this._scrollBottom()
        // 列表摘要/时间同步（返回列表时不必等轮询）
        this.loadList(true)
      })
      .catch((e) => {
        if (this._gone) return
        const code = (e && (e.httpCode || e.statusCode)) || 0
        if (code === 409) {
          // 会话已被结束（可能是别的入口/另一端结束的）：锁输入，别让医生反复重试
          this._stopPoll()
          this.setData({
            'active.status': 'CLOSED',
            sending: false,
            canSend: false,
            replyError: '该问诊已结束，无法继续回复'
          })
          return
        }
        this.setData({ sending: false, replyError: errText(e) })
      })
  }
})
