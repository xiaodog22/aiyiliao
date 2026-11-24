/**
 * pages/profile/health-records —— 健康档案（我的 → 健康档案）
 *
 * 数据源：后端契约 GET /api/v1/health-records（HealthRecordData[]）
 *   字段：id / familyMemberId / category / title / summary / recordedAt / attachments?
 * 版式（对齐设计稿 05）：顶部横向分类筛选 + 左侧时间轴 + 右侧记录卡（类别徽章/标题/摘要/时间）。
 *   - 筛选 chip 由**实际出现的类别**动态生成，不硬编码后端未返回的类别；
 *   - 时间轴按后端返回顺序（契约已按时间倒序），不自行排序、不插占位节点。
 * 降级（与挂号记录页同一口径）：
 *   - 加载中：骨架屏（skeleton list）
 *   - 开发档（MOCK_FALLBACK=true）后端不可用 → 演示数据兜底
 *   - 上线档（MOCK_FALLBACK=false）后端不可用 → 错误态 + 重新加载（不混入演示数据）
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
// 只保留降级包装；接口一律走 services/user.js（页面不得直发接口）
const { withFallback } = require('../../../services/request.js')
const userService = require('../../../services/user.js')
const resourceService = require('../../../services/resource.js')
const { errText } = require('../../../utils/err-text.js')
const { fmtDate } = require('../../../utils/datetime.js')

/* ==================== 纯函数（映射/筛选）==================== */

/** 契约 category 枚举（VITALS/ALLERGY/MEDICATION/HISTORY/EXAM/OTHER）→ 分区标题；未知值原样透传 */
const CATEGORY_TEXT = {
  VITALS: '体征记录',
  ALLERGY: '过敏史',
  MEDICATION: '用药记录',
  HISTORY: '既往病史',
  EXAM: '检查检验',
  OTHER: '其他'
}

/**
 * 类别 → 徽章底色 + 字形（纯视觉映射）；未命中回退灰底 + 文件图标。
 * 颜色纪律：底板只用五色 pastel 装饰色，不挪用红/橙语义色（D-01④）。
 */
const CAT_VISUAL = {
  体征记录: { tint: 'tile-blue', icon: icons.activity },
  用药记录: { tint: 'tile-mint', icon: icons.pill },
  过敏史: { tint: 'tile-amber', icon: icons.alert },
  既往病史: { tint: 'tile-purple', icon: icons.clipboardList },
  检查检验: { tint: 'tile-blue', icon: icons.flask },
  就诊记录: { tint: 'tile-mint', icon: icons.stethoscope },
  检验检查报告: { tint: 'tile-blue', icon: icons.fileText }
}

/* 报告出具状态（2026-10-19 契约新增）→ 中文 + 徽章色
   ⚠️ null / 未知值一律**不渲染徽章**，不得默认成"已出结果"。 */
const REPORT_STATUS_TEXT = {
  READY: '已出结果',
  PENDING: '待出具',
  REVIEWING: '待审核'
}

const ALL_KEY = 'ALL'

/** 字节数 → 可读大小（B/KB/MB；契约附件 size 为字节） */
function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + 'B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB'
  return (n / 1024 / 1024).toFixed(1) + 'MB'
}

/** 契约记录数组 → 页面字段（未返回字段留空，wxml 侧不显示） */
function normalize(list) {
  const arr = Array.isArray(list) ? list : []
  return arr.map((it) => {
    const rawCategory = String(it.category || '').toUpperCase()
    const category = CATEGORY_TEXT[rawCategory] || (it.category || '其他')
    const v = CAT_VISUAL[category] || { tint: 'tile-gray', icon: icons.fileText }
    // 检查资料附件（V9）：短期签名 url 需拼网关前缀；pdf 走 openDocument 而非 previewImage
    // bundle=true 表示演示/内置资源（包内 /assets/ 路径），不做网关拼接
    // resourceKey（2026-11-15）：系统推送报告改由后端资源库下发，前端只按 key 拼匿名端点地址
    // 唯一性（2026-11-15）：同一记录内按内容摘要（sha256 / md5）去重，同一份报告只展示一次
    const seen = {}
    const attachments = (Array.isArray(it.attachments) ? it.attachments : [])
      .filter((a) => {
        const mark = a.sha256 || a.md5 || a.objectKey || a.id || ''
        if (!mark) return true
        if (seen[mark]) return false
        seen[mark] = true
        return true
      })
      .map((a) => {
        const remote = a.resourceKey ? resourceService.staticResourceUrl(a.resourceKey) : ''
        return {
          id: a.id || '',
          objectKey: a.objectKey || '',
          url: remote || (a.bundle ? String(a.url || '') : userService.resolveAttachmentUrl(a.url)),
          bundle: remote ? false : !!a.bundle,
          fileName: a.fileName || '',
          mime: a.mime || '',
          /* 内容摘要：展示层不渲染，保留给去重与「同一文件不重复」的排查 */
          hash: a.sha256 || a.md5 || '',
          sizeText: fmtSize(a.size),
          isPdf: /pdf/i.test(String(a.mime || ''))
        }
      })
    return {
      id: it.id || '',
      category,
      tint: v.tint,
      icon: v.icon,
      title: it.title || '',
      summary: it.summary || '',
      dateText: fmtDate(it.recordedAt),
      /* 报告状态徽章：后端未下发 → hasReport=false，wxml 不渲染 */
      hasReport: !!it.reportStatus,
      reportStatusText: REPORT_STATUS_TEXT[String(it.reportStatus || '').toUpperCase()] || '',
      reportStatusCls:
        String(it.reportStatus || '').toUpperCase() === 'READY' ? 'badge-mint' : 'badge-amber',
      /* 操作按钮是否置灰（设计稿 05：胸部X光片「待审核」两按钮均为灰态）。
         ⚠️ 只在**明确知道报告未就绪**时锁；后端没下发 reportStatus 时不禁用
            —— 就诊记录这类非报告条目本来就没有报告状态。 */
      locked: !!it.reportStatus && String(it.reportStatus).toUpperCase() !== 'READY',
      /* 可查看报告：检查检验类记录（EXAM）→ V27 结构化报告单；
         其它类别（体征/过敏/用药/病史）本身没有报告，不渲染「查看报告」按钮 */
      reportable: rawCategory === 'EXAM',
      attachments
    }
  })
}

/** 依据实际类别生成筛选条（全部 + 出现过的类别，保持后端顺序；附图标走宫格视觉） */
function buildFilters(items) {
  const seen = {}
  const out = [{ key: ALL_KEY, label: '全部', icon: icons.layoutGrid }]
  items.forEach((it) => {
    if (!seen[it.category]) {
      seen[it.category] = true
      const v = CAT_VISUAL[it.category] || { icon: icons.fileText }
      out.push({ key: it.category, label: it.category, icon: v.icon })
    }
  })
  return out
}

/** 演示兜底：mock-data 的 {basic, visits, reports} → 契约同形的记录数组（仅开发档可达） */
function mockRecords() {
  const m = (app && app.MOCK && app.MOCK.HEALTH_RECORDS) || {}
  const out = []
  ;(m.visits || []).forEach((v, i) => out.push({
    id: 'mv' + i,
    category: '就诊记录',
    title: (v.dept || '') + (v.doctor ? ' · ' + v.doctor : ''),
    summary: [v.diagnosis ? '诊断：' + v.diagnosis : '', v.prescription ? '医嘱：' + v.prescription : '']
      .filter(Boolean).join('；'),
    recordedAt: v.date || '',
    // 就诊记录同样带报告文件（系统推送的门诊病历/检查单），保证「查看报告」不再空态
    attachments: Array.isArray(v.attachments) ? v.attachments : []
  }))
  ;(m.reports || []).forEach((r, i) => out.push({
    id: 'mr' + i,
    category: '检验检查报告',
    title: r.name || '',
    summary: [r.org || '', r.status || ''].filter(Boolean).join(' · '),
    recordedAt: r.date || '',
    // 系统推送资料（2026-11-15）：图片由后端资源库下发（resourceKey），包内不再内置大图
    attachments: Array.isArray(r.attachments) ? r.attachments : []
  }))
  return out
}

/* ==================== 页面 ==================== */

Page({
  data: {
    icons,
    theme: 'standard',
    /* 就诊人（效果图 05 顶部卡）：取登录态真实用户，姓名为空则整卡不渲染 */
    patient: { name: '', avatarUrl: '' },
    items: [],
    filters: [],
    activeKey: ALL_KEY,
    view: [],
    loading: true,
    error: '',
    /* 系统推送图片全屏查看（包内 /assets/ 路径不能用 wx.previewImage） */
    viewerUrl: '',
    /* AI 解读：interpreting 存「正在解读的 recordId」（空串=空闲），
       用 id 而非 boolean，才能只让当前卡片的按钮进 loading 态 */
    interpreting: '',
    interpretation: null,
    interpretFail: ''
  },

  onLoad() {
    const u = app.globalData.user || {}
    this.setData({
      icons,
      theme: app.globalData.theme || 'standard',
      // 头像站内相对路径须解析成网关绝对地址（与 profile/personal/doctor 一致），
      // 否则 <image> 会把 /api/v1/avatars/... 当成本地包路径导致加载失败
      patient: { name: u.displayName || u.name || '', avatarUrl: userService.resolveAvatar(u.avatarUrl) || '' }
    })
    this.fetch()
  },

  fetch() {
    this.setData({ loading: true, error: '' })
    // 走服务层：契约 GET /api/v1/health-records（HealthRecordData[]），页面不再直连 API 规格
    return withFallback(userService.listHealthRecords(), mockRecords)
      .then((list) => {
        const items = normalize(list)
        const filters = buildFilters(items)
        this.setData({
          items,
          filters,
          activeKey: ALL_KEY,
          view: items,
          loading: false
        })
      })
      .catch((err) => {
        this.setData({
          items: [],
          filters: [],
          view: [],
          loading: false,
          error: errText(err, '健康档案加载失败，请重试')
        })
      })
  },

  /** 分类筛选（纯本地过滤，不重新请求） */
  onFilter(e) {
    const key = (e.currentTarget.dataset || {}).key || ALL_KEY
    if (key === this.data.activeKey) return
    const items = this.data.items
    const view = key === ALL_KEY ? items : items.filter((it) => it.category === key)
    this.setData({ activeKey: key, view })
  },

  /** 个人信息卡 → 个人信息页（改头像/姓名/手机号） */
  onOpenProfile() {
    wx.navigateTo({ url: '/pages/profile/personal-info/personal-info' })
  },

  /**
   * 「查看报告」（设计稿 05 的左按钮）：
   *   1) 有文件附件 → 打开附件（图片/PDF）；
   *   2) 无附件但属于检查检验记录 → 打开 V27 结构化报告单（report-detail）；
   *   3) 两者都没有 → 明确空态提示，不打开空页面、不伪造报告内容。
   * 真实后端档案多数是结构化报告（health_report_details）而无图片附件，
   * 只认附件会让「查看报告」永远停在「暂无报告文件」。
   */
  onViewReport(e) {
    const id = (e.currentTarget.dataset || {}).id || ''
    const it = this.data.items.filter((x) => x.id === id)[0]
    if (!it) return
    if (it.locked) {
      wx.showToast({ title: '报告尚未出具，请稍后再看', icon: 'none' })
      return
    }
    const atts = it.attachments || []
    if (atts.length) {
      this._openAttachment(atts[0].url, atts[0].isPdf, atts[0].bundle)
      return
    }
    if (!it.reportable) {
      wx.showToast({ title: '该记录暂无报告文件', icon: 'none' })
      return
    }
    this._openStructuredReport(id)
  },

  /**
   * 打开结构化报告单：先确认报告存在，避免跳进详情页再看到「报告不存在」。
   * 404（REPORT_DETAIL_NOT_FOUND / HEALTH_RECORD_NOT_FOUND）→ 保留原空态提示。
   */
  _openStructuredReport(id) {
    wx.showLoading({ title: '加载报告', mask: true })
    userService.getReport(id)
      .then(() => {
        wx.hideLoading()
        wx.navigateTo({
          url: '/pages/profile/report-detail/report-detail?recordId=' + encodeURIComponent(id)
        })
      })
      .catch((err) => {
        wx.hideLoading()
        const missing = err && (err.status === 404 || /NOT_FOUND/.test(String(err.code || '')))
        wx.showToast({
          title: missing ? '该记录暂无报告文件' : errText(err, '报告加载失败，请稍后重试'),
          icon: 'none'
        })
      })
  },

  /**
   * AI 解读（POST /api/v1/health-records/{recordId}/interpret）。
   * ⚠️ 后端未实现时返回 501 → 必须给出可见的中文降级提示，
   *    绝不能用本地假文本冒充解读结果（违反「禁止伪造业务数据」红线）。
   */
  onInterpret(e) {
    const id = (e.currentTarget.dataset || {}).id || ''
    // 连点保护：已有解读在途就忽略（interpreting 非空即为忙）
    if (!id || this.data.interpreting) return
    // 报告未就绪时不发请求：解读没有正文可读，直接给中文提示
    const it = this.data.items.filter((x) => x.id === id)[0]
    if (it && it.locked) {
      wx.showToast({ title: '报告尚未出具，暂不能解读', icon: 'none' })
      return
    }
    this.setData({ interpreting: id, interpretFail: '', interpretation: null })
    userService.interpretRecord(id)
      .then((res) => {
        this.setData({
          interpreting: '',
          interpretation: Object.assign({ recordId: id }, res || {})
        })
      })
      .catch((err) => {
        const notReady = err && (err.code === 501 || err.status === 501)
        this.setData({
          interpreting: '',
          interpretFail: notReady
            ? 'AI 解读功能尚未开放（服务端返回 501），请以医生解读为准。'
            : errText(err, 'AI 解读失败，请稍后重试')
        })
      })
  },

  /**
   * 转人工复核（审计 F4-2）：报告解读是辅助性自动化决策，患者有权要求医生人工判断。
   * 直达在线问诊医生选择页；不可用时给院内导诊台兜底提示，不假装已转接。
   */
  onInterpretReview() {
    wx.showModal({
      title: '转人工复核',
      content: 'AI 解读仅供理解报告参考，不构成诊断。您可以转到在线问诊，由医生结合原始报告判断。',
      confirmText: '在线问诊',
      cancelText: '暂不需要',
      success: (res) => {
        if (!res.confirm) return
        wx.navigateTo({
          url: '/pages/consult/picker/picker',
          fail: () => wx.showToast({ title: '在线问诊暂不可用，请到院咨询导诊台', icon: 'none' })
        })
      }
    })
  },

  /** 查看附件：包内图片走全屏浮层；远端图片走 previewImage；pdf 走「downloadFile → openDocument」 */
  onPreviewAttachment(e) {
    const ds = e.currentTarget.dataset || {}
    this._openAttachment(ds.url || '', !!ds.pdf, !!ds.bundle)
  },

  _openAttachment(url, isPdf, bundle) {
    if (!url) return
    if (isPdf) {
      this._openPdf(url)
      return
    }
    // 包内 /assets/ 路径 wx.previewImage 不认，用页面浮层展示
    if (bundle) {
      this.setData({ viewerUrl: url })
      return
    }
    wx.previewImage({
      urls: [url],
      current: url,
      fail: () => wx.showToast({ title: '图片打不开，链接可能已过期', icon: 'none' })
    })
  },

  /** 关闭全屏查看浮层 */
  onCloseViewer() {
    this.setData({ viewerUrl: '' })
  },

  /**
   * PDF 预览必须**先下载再打开**：
   * `wx.openDocument` 的 `filePath` 只接受本地文件路径，直接传 https 地址在真机一定失败
   * （开发者工具偶发"能打开"是它做了容错，不能作为真机可用依据）。
   *
   * 状态码语义：
   *  - 200 → 打开 tempFilePath；
   *  - 410 → 签名链接过期，提示「重新打开档案获取新链接」（不要笼统报"打开失败"）；
   *  - 其它 → 展示状态码，便于现场定位。
   * 注意：`wx.downloadFile` 对 4xx/5xx **也走 success**（只有网络层错误才走 fail），
   * 所以必须在 success 里判 statusCode，不能只写 fail。
   */
  _openPdf(url) {
    wx.showLoading({ title: '正在打开', mask: true })
    wx.downloadFile({
      url,
      success: (res) => {
        wx.hideLoading()
        if (res.statusCode === 410) {
          wx.showToast({ title: '链接已过期，请重新打开档案', icon: 'none' })
          return
        }
        if (res.statusCode !== 200 || !res.tempFilePath) {
          wx.showToast({ title: '文件下载失败（' + res.statusCode + '）', icon: 'none' })
          return
        }
        wx.openDocument({
          filePath: res.tempFilePath,
          fileType: 'pdf',
          showMenu: true,
          fail: () => wx.showToast({ title: '文件打开失败', icon: 'none' })
        })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '下载失败，请检查网络', icon: 'none' })
      }
    })
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh())
  }
})
