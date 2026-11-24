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
const doctorService = require('../../services/doctor.js')
const speechService = require('../../services/speech.js')
const resourceService = require('../../services/resource.js')

/**
 * 安全解码 query / objectKey 片段：畸形 % 序列（如 `?dept=%E4%B8`）会让
 * decodeURIComponent 抛 URIError —— 在 onLoad 里抛出即整页白屏（D-B-P2-02）。
 * 解码失败一律退回原文，绝不因为用户手改/转义残缺的链接而白页。
 */
function safeDecode(v) {
  try { return decodeURIComponent(v || '').trim() } catch (e) { return String(v || '').trim() }
}
const { errText } = require('../../utils/err-text.js')
const { hasContent } = require('../../utils/input-guard.js')
const { withFallback } = require('../../services/request.js')
// 时间展示统一走 utils/datetime.js（ISO Instant → 设备本地 'YYYY-MM-DD' / 'HH:mm'）
const { fmtLocalDateTime, dayLabel } = require('../../utils/datetime.js')

/**
 * 输入字数上限（DEF-08）：微信 `<input>` 默认 maxlength=140，不写就静默截断；
 * 后端问诊消息上限 2000。到顶时提示一次，不做"静默吞字"。
 */
const INPUT_MAX = 2000
const INPUT_MAX_TIP = '已达字数上限，可先发送再补充'

const POLL_INTERVAL = 2000   // 等待医生/AI 回复的轮询间隔（2026-11-15：4s→2s，同步更快）
const POLL_FIRST_DELAY = 400 // 首轮不等满一个间隔：发送/进页后尽快拿到新消息与接诊态
const POLL_MAX = 24          // 最多 24 次（≈48s），超时不再打扰服务端

/**
 * 轮询错误退避（审计 F2-3）：连续失败 1~2 次保持 2s；第 3 次起 8s→12s→15s 封顶。
 * 患者端常驻同步在弱网/服务端抖动时不能每 2s 空转放大故障。
 */
function pollDelay(base, fails) {
  if (!fails || fails < 3) return base
  return Math.min(15000, 8000 + (fails - 3) * 4000)
}
const IMG_RE = /\.(png|jpe?g|webp)(\?|$)/i
// 图片消息白名单（2026-11-15 上传合规）：与后端 validateImageContent 同口径
const IMAGE_MAX_BYTES = 10 * 1024 * 1024

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
    inputMax: INPUT_MAX,
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
    // 同步医生端「线上问诊设置」：指定医生但当前不在线 → 只提示不阻断
    //（预约制：提交后由医生上线接单；请求失败/字段缺失按未知处理，不打扰患者）
    if (pendingDoctorId) this._noticeDoctorOffline(pendingDoctorId)
    this.fetch().then(() => this._startLive(true))
  },

  /** 医生不在线时的非阻断提示（availability 是增强信息，失败静默） */
  _noticeDoctorOffline(doctorId) {
    doctorService.getAvailability(doctorId).then((a) => {
      if (a && a.online === false) {
        wx.showToast({ title: '该医生当前不在线，提交后待其上线接诊', icon: 'none', duration: 2600 })
      }
    }).catch(() => {})
  },

  onUnload() {
    this._gone = true
    this._stopPolling()
    this._stopLive()
    speechService.stopSpeak()
  },

  /** 回到页面：恢复常驻同步（医生接诊 / 回复能实时出现在对话里，与微信聊天一致） */
  onShow() {
    // D-10：设置页改完高对比 / 字号后回到本页要立刻生效（本页是 TabBar 页，onLoad 只走一次）
    const theme = app.globalData.theme || 'standard'
    const hc = !!app.globalData.highContrast
    if (theme !== this.data.theme || hc !== this.data.hc) this.setData({ theme, hc })
    if (this.data.activeId) {
      // 回到页面立即同步一次，不等首个定时器（2026-11-15 同步提速）
      this._stopLive()
      this._liveTick()
    }
  },

  /** 离开页面：停常驻同步，避免后台空转 */
  onHide() {
    this._stopLive()
    speechService.stopSpeak()
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
    // 「不指定医生」/ 直接进入：不能回退到列表里的第一个 ACTIVE 会话——
    // 那会把历史 AI 问诊当成新在线问诊打开（2026-11-17 用户反馈）。
    // 这里保持真正的空态，由 picker 随机匹配在线医生后再带 doctorId 进入。
    if (!id) {
      this.setData({
        loading: false,
        error: '',
        activeId: '',
        hasDoctor: false,
        doctorName: '接诊医生',
        doctorTitle: '',
        docSub: '互联网医院',
        accepting: false,
        status: 'ACTIVE',
        closed: false,
        tipText: '请选择医生发起在线问诊',
        messages: [],
        attachCount: 0,
        activeTitle: '',
        remainingText: ''
      })
      return Promise.resolve()
    }
    const first = this._fetchDetail(id)

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
      // 只认当前会话 id；不再用「第一个 ACTIVE」兜底——否则详情暂时失败时
      // 可能把另一个历史会话（含旧 AI 问诊）顶替到当前页面。
      const hit = arr.find((c) => c.id === this.data.activeId)

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
        this._lastLoadOk = true
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
        // 兜底：会话已有**医生侧**消息（role=doctor / 「已接诊」系统提示）→ 必然已接诊。
        // 详情接口偶发失败或元信息轮询未到时，不能让状态停在「待接诊」误导患者。
        // ⚠️ 不能按渲染 kind 判：AI 助手回复（role=assistant）也渲染成 doc 气泡，
        //    会把「AI 先答一句」误判成医生接单，绕过预约制（D6，2026-11-15）。
        const hasDoctorSide = raw.some((m) => String(m.role || '') === 'doctor'
          || (String(m.role || '') === 'system_notice' && /接诊/.test(String(m.content || ''))))
        if (hasDoctorSide && !this.data.accepting) {
          patch.accepting = true
          patch.tipText = '医生正在查看您的描述，请稍候…'
        }
        this.setData(patch)
        // 只在消息数变化时滚到底：轮询期间用户可能正在翻历史，不能每次都把他拽回来
        if (items.length !== prevCount) this._scrollToBottom()
      })
      .catch((err) => {
        this._lastLoadOk = false
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
      const name = m.attachmentName || meta.name || (base ? safeDecode(base) : '检查资料')
      const size = Number(m.attachmentSize || meta.size || 0)
      const rawUrl = m.attachmentUrl || meta.url || ''
      return {
        id,
        kind: 'file',
        // 服务端按 objectKey 反查健康档案附件下发签名 URL（同 objectKey → 同 URL）；
        // 仅在本轮刚发出、尚未刷新到服务端字段时用 meta.url 兜底。
        url: rawUrl ? userService.resolveAttachmentUrl(rawUrl) : '',
        isImage: IMG_RE.test(name),
        isPdf: /\.pdf(\?|$)/i.test(name),
        fileName: name,
        fileSub: size ? '已上传 · ' + this._sizeText(size) : '已上传'
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
    const v = (e && e.detail && e.detail.value) || ''
    // 到上限才提示一次（DEF-08）：到顶后键盘输入不再进框，不说明会像"键盘坏了"
    if (v.length >= INPUT_MAX && !this._maxTipShown) {
      this._maxTipShown = true
      wx.showToast({ title: INPUT_MAX_TIP, icon: 'none' })
    }
    if (v.length < INPUT_MAX) this._maxTipShown = false
    // 用户改了内容 = 这是一条新消息，幂等键不能沿用上一条失败的（否则服务端按旧摘要判重）
    this._clearSendKey()
    this.setData({ input: v })
  },

  onSend() {
    if (this.data.sending) return
    if (this.data.closed) {
      wx.showToast({ title: '本次问诊已结束', icon: 'none' })
      return
    }
    const text = (this.data.input || '').trim()
    if (!text) return   // 空输入静默返回：设计稿发送键常亮，不弹提示打扰
    // 纯标点/空白不算一条消息（DEF-09 同类面）：医生端不该收到"。。。"（发送键常亮易误触）
    if (!hasContent(text)) {
      wx.showToast({ title: '请输入消息内容', icon: 'none' })
      return
    }
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
    // 2026-11-15 修正：不再拦截「接单前的后续消息」—— 患者可随时补充病情/检查资料，
    // 医生端在工作台能看到完整描述；接诊态只影响顶部提示，不影响输入。
    this.setData({ sending: true, input: '' })
    // 乐观上屏（2026-11-15 响应提速）：不等 POST 返回就显示自己这条；
    // 成功后用服务端权威列表整表替换，失败则移除并恢复原文。
    const localId = 'local-' + Date.now()
    this._appendLocalMessage({ id: localId, kind: 'user', text, timeText: nowTime() })
    const idemKey = this._sendKey()
    return userService
      .sendConsultationMessage(id, { content: text, inputMode: 'TEXT' }, { idempotencyKey: idemKey })
      .then(() => {
        this._clearSendKey()
        return this._loadMessages()
      })
      .then(() => {
        // 以「自己这条已落库之后」的条数为基准：再涨一条 = 医生/AI 回复到达
        this._startPolling(this.data.messages.length)
      })
      .catch((err) => {
        this._removeLocalMessage(localId)
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
    this._pollFails = 0
    this.setData({ typing: true })

    const tick = () => {
      if (this._gone) return
      tries += 1
      this._loadMessages().then(() => {
        if (this._gone) return
        this._pollFails = this._lastLoadOk ? 0 : Math.min((this._pollFails || 0) + 1, 6)
        const grew = this.data.messages.length > before
        if (grew || tries >= POLL_MAX) {
          // ⚠️ 必须置 null：常驻同步（_liveTick）以 _pollTimer 是否为空判断"短轮询是否在进行"，
          //    只 return 不清空会让它永远让位，医生回复就再也拉不到（2026-10-24）
          this._pollTimer = null
          this.setData({ typing: false })
          return
        }
        this._pollTimer = setTimeout(tick, pollDelay(POLL_INTERVAL, this._pollFails || 0))
      })
    }
    this._pollTimer = setTimeout(tick, POLL_FIRST_DELAY)
  },

  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  },

  // ============ 常驻同步（2026-10-24：医生接诊/回复实时可见） ============
  /**
   * 会话内常驻轮询：每 2s 拉消息；每 2 轮（≈4s）拉一次会话详情，同步「正在接诊」等元信息。
   * 发送后的短轮询（_startPolling）进行中时让位，避免两套定时器重复请求。
   */
  _startLive(immediate) {
    this._stopLive()
    if (this._gone || !this.data.activeId || this.data.closed) return
    if (this._liveActiveId !== this.data.activeId) {
      this._liveActiveId = this.data.activeId
      this._liveFails = 0
    }
    // 首次进页/回到页面走 POLL_FIRST_DELAY，之后按当前退避周期（成功即回到 2s）
    const delay = immediate ? POLL_FIRST_DELAY : pollDelay(POLL_INTERVAL, this._liveFails || 0)
    this._liveTimer = setTimeout(() => this._liveTick(), delay)
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
    if (round % 2 === 0) jobs.push(this._syncMeta())
    Promise.all(jobs)
      .then(() => {
        // 拉到新回复即收起「正在输入」
        if (this.data.messages.length !== before && this.data.typing) this.setData({ typing: false })
      })
      .catch(() => { /* 轮询失败静默，下一轮重试 */ })
      .then(() => {
        this._liveFails = this._lastLoadOk ? 0 : Math.min((this._liveFails || 0) + 1, 6)
        this._startLive()
      })
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
  /**
   * ＋：**只允许从健康档案选择已有检查资料**（2026-11-15 上传合规收紧）。
   * ⚠️ 不再提供拍照 / 相册 / 微信文件入口：患者端上传权限仅限健康档案，
   *    防止任意图片/文件进入医患会话；服务端另有 objectKey 归属白名单兜底。
   */
  onPickAttach() {
    if (this.data.uploading) return
    if (!this.data.activeId) {
      wx.showToast({ title: this.data.pendingDoctorId ? '请先发送首条消息创建会话' : '请先选择医生发起问诊', icon: 'none' })
      return
    }
    // 2026-11-15 修正：接单前也允许补充检查资料（与文本消息同一口径）
    this._pickFromHealthRecords()
  },

  /**
   * 从健康档案选择已有检查图片（唯一上传入口，2026-11-15）：
   * 不重复上传，直接把档案附件的 objectKey 或系统推送报告的 resourceKey 作为 IMAGE 消息发出。
   * 前置校验（与后端 validateImageContent 同口径）：
   *   · 仅 image/jpeg、image/png、image/webp；
   *   · 0 < size ≤ 10MB；
   *   · objectKey 属于本人档案附件；系统推送报告只认 resource_asset 的 health.* key。
   * 降级与健康档案页一致（仅开发档）：后端读失败时用演示档案，其中报告图带真实 resourceKey。
   */
  _pickFromHealthRecords() {
    if (this.data.uploading) return
    withFallback(userService.listHealthRecords(), () => this._demoHealthRecords())
      .then((list) => {
        const opts = []
        ;(Array.isArray(list) ? list : []).forEach((rec) => {
          ;(rec.attachments || []).forEach((a) => {
            const name = String(a.fileName || a.name || '检查资料')
            const objectKey = a.objectKey || a.object_key || ''
            const resourceKey = String(a.resourceKey || '')
            // 系统推送报告（resource_asset）只认 health.*，防止拿 banner 等资源冒充检查资料
            const key = objectKey || (/^health\./.test(resourceKey) ? resourceKey : '')
            const mime = this._imageMime(a.mime, name)
            const size = Number(a.size) || 0
            if (!key || !mime || size > IMAGE_MAX_BYTES) return
            opts.push({
              key, name, mime, size,
              // 资源库报告走匿名静态端点；档案附件走短期签名 URL
              url: objectKey
                ? userService.resolveAttachmentUrl(a.url || '')
                : resourceService.staticResourceUrl(resourceKey),
              recordId: rec.id || '',
              attachmentId: a.id || '',
              record: rec.title || rec.recordType || ''
            })
          })
        })
        if (!opts.length) {
          wx.showToast({ title: '健康档案里还没有可发送的合规图片', icon: 'none' })
          return
        }
        const picked = opts.slice(0, 6)
        wx.showActionSheet({
          itemList: picked.map((o) => o.name + (o.record ? ' · ' + o.record : '')),
          success: (res) => {
            const o = picked[res.tapIndex]
            if (o) this._sendRecordAttachment(o)
          },
          fail: () => {}
        })
      })
      .catch((err) => {
        wx.showToast({ title: errText(err, '健康档案加载失败'), icon: 'none' })
      })
  },

  /** 演示档案（仅开发档降级用）：与健康档案页同源，就诊记录与报告都可作为可选资料 */
  _demoHealthRecords() {
    const m = (app && app.MOCK && app.MOCK.HEALTH_RECORDS) || {}
    const out = []
    ;(m.visits || []).forEach((v, i) => out.push({
      id: 'mv' + i,
      title: (v.dept || '') + (v.doctor ? ' · ' + v.doctor : ''),
      attachments: Array.isArray(v.attachments) ? v.attachments : []
    }))
    ;(m.reports || []).forEach((r, i) => out.push({
      id: 'mr' + i,
      title: r.name || '',
      attachments: Array.isArray(r.attachments) ? r.attachments : []
    }))
    return out
  },

  /** MIME 白名单归一：仅 jpeg/png/webp；无 mime 时按扩展名判定，不合规返回空串 */
  _imageMime(mime, fileName) {
    const m = String(mime || '').trim().toLowerCase()
    if (m === 'image/jpeg' || m === 'image/jpg') return 'image/jpeg'
    if (m === 'image/png' || m === 'image/webp') return m
    const ext = String(fileName || '').split('.').pop().toLowerCase()
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'png') return 'image/png'
    if (ext === 'webp') return 'image/webp'
    return ''
  },

  /**
   * 发送健康档案里已有的图片（不重新上传，直接复用 objectKey）。
   * 乐观插入气泡 + 失败回滚；超时重试复用同一幂等键，避免医生收到重复图片。
   */
  _sendRecordAttachment(o) {
    const id = this.data.activeId
    if (!id || !o || !o.key || !o.mime) return
    if (o.size > IMAGE_MAX_BYTES) {
      wx.showToast({ title: '图片超过 10MB，请压缩后再发送', icon: 'none' })
      return
    }
    if (this.data.uploading) return
    this._fileMeta[o.key] = { name: o.name || '检查资料', size: o.size || 0, url: o.url || '' }
    const localId = 'local-' + Date.now()
    this._appendLocalMessage({
      id: localId,
      kind: 'file',
      url: o.url || '',
      isImage: true,
      isPdf: false,
      fileName: o.name || '检查资料',
      fileSub: '已发送 · ' + this._sizeText(o.size || 0)
    })
    this.setData({ uploading: true })
    // 图片幂等键按 objectKey 绑定：同一张图超时重试复用同一键（不重复落库）；
    // 换一张图则换新键（避免"同键异体"被后端 409 拒绝）。
    const idemKey = this._imgSendKey(o.key)
    return userService.sendConsultationMessage(id, { content: o.key, inputMode: 'IMAGE' }, { idempotencyKey: idemKey })
      .then(() => {
        this._clearImgSendKey()
        return this._loadMessages()
      })
      .catch((err) => {
        this._removeLocalMessage(localId)
        wx.showToast({ title: errText(err, '发送失败，请重试'), icon: 'none' })
      })
      .then(() => this.setData({ uploading: false }))
  },

  /** 乐观消息：本地先上屏（发送/图片共用），成功后由服务端列表整表替换 */
  _appendLocalMessage(msg) {
    const idx = this.data.messages.length
    this.setData({ ['messages[' + idx + ']']: msg })
    this._scrollToBottom()
  },

  /** 失败回滚：按本地 id 移除乐观消息（不碰服务端已落库的任何一条） */
  _removeLocalMessage(localId) {
    const msgs = this.data.messages.filter((m) => m.id !== localId)
    this.setData({ messages: msgs })
  },

  /** 幂等键：同一句话/同一张图失败重试必须复用，成功或改文后清空 */
  _sendKey() {
    if (!this._lastSendKey) {
      this._lastSendKey = 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    }
    return this._lastSendKey
  },

  _clearSendKey() {
    this._lastSendKey = ''
  },

  /** 图片消息幂等键：同一 objectKey/resourceKey 复用，换图换新键 */
  _imgSendKey(key) {
    const cur = this._lastImgSend
    if (cur && cur.key === key) return cur.idem
    const idem = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    this._lastImgSend = { key, idem }
    return idem
  },

  _clearImgSendKey() {
    this._lastImgSend = null
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
