/**
 * pages/profile/report-detail —— 电子检查报告详情（V27）
 *
 * 数据源：GET /api/v1/reports/{recordId}（ReportDetailData）。
 * 后端状态门禁：REVIEWING / PENDING 返回脱敏结构（sections/attachments 空、结论为 null），
 *   页面只显示状态提示与元信息，**不缓存、不补造、不展示未审核结果**。
 * 排版顺序：机构标题 → 患者 → 申请/标本 → 分组项目 → 异常提示 → 所见/结论 →
 *   人员时间 → 附件 → 免责声明。演示报告显示固定水印。
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const userService = require('../../../services/user.js')
const { errText } = require('../../../utils/err-text.js')

const DEMO_NOTICE = '演示数据 · 非真实医疗报告 · 不构成诊断依据'

function fmt(v) {
  return v ? String(v).replace('T', ' ').slice(0, 16) : ''
}

/** 只把后端真实返回的非空值组装成信息行；缺值不渲染，不填「未知」假值。 */
function infoRows(pairs) {
  return pairs
    .filter((p) => p[1] !== null && p[1] !== undefined && String(p[1]).trim() !== '')
    .map((p) => ({ label: p[0], value: String(p[1]) }))
}

function normalizeItem(i) {
  const hasNum = i.resultValue !== null && i.resultValue !== undefined
  const value = hasNum ? String(i.resultValue) : (i.resultText || '—')
  let ref = i.referenceText || ''
  if (!ref && i.referenceLow !== null && i.referenceLow !== undefined
      && i.referenceHigh !== null && i.referenceHigh !== undefined) {
    ref = i.referenceLow + ' ~ ' + i.referenceHigh
  }
  const flag = i.abnormalFlag || 'NOT_APPLICABLE'
  return {
    id: i.id,
    itemName: i.itemName || '检查项目',
    valueText: value,
    unit: i.unit || '',
    refText: ref || '—',
    abnormalLabel: i.abnormalLabel || '未判定',
    isAbnormal: flag !== 'NORMAL' && flag !== 'NOT_APPLICABLE',
    remark: i.remark || ''
  }
}

function normalizeDetail(d) {
  const sections = (d.sections || []).map((s, idx) => ({
    id: s.id || ('sec-' + idx),
    sectionName: s.sectionName || '检查项目',
    open: true,
    items: (s.items || []).map(normalizeItem)
  }))
  const abnormalItems = []
  sections.forEach((s) => s.items.forEach((i) => { if (i.isAbnormal) abnormalItems.push(i) }))

  const attachments = (d.attachments || []).map((a) => ({
    id: a.id,
    fileName: a.fileName || a.objectKey || '检查附件',
    url: a.url ? userService.resolveAttachmentUrl(a.url) : '',
    isImage: /^image\//.test(a.mime || '')
  }))

  return {
    recordId: d.recordId,
    reportNo: d.reportNo || '',
    title: d.title || '检查报告',
    reportType: d.reportType || '',
    reportStatus: d.reportStatus || '',
    isDemo: !!d.isDemo,
    demoNotice: d.demoNotice || DEMO_NOTICE,
    statusNotice: d.statusNotice || '',
    ready: d.reportStatus === 'READY',
    institutionName: d.institutionName || '',
    institutionType: d.institutionType || '',
    departmentName: d.departmentName || '',
    patientRows: infoRows([
      ['患者姓名', d.patientName], ['性别', d.patientSex], ['年龄', d.patientAge],
      ['门诊号', d.outpatientNo], ['住院号', d.inpatientNo], ['临床诊断', d.clinicalDiagnosis],
      ['申请科室', d.departmentName], ['申请医生', d.applicantDoctor]
    ]),
    specimenRows: infoRows([
      ['标本类型', d.specimenType], ['标本编号', d.specimenNo],
      ['采样时间', fmt(d.collectionAt)], ['接收时间', fmt(d.receivedAt)],
      ['检测时间', fmt(d.testedAt)], ['检查方法', d.inspectionMethod], ['仪器', d.instrumentModel]
    ]),
    reportRows: infoRows([
      ['报告编号', d.reportNo], ['报告时间', fmt(d.reportedAt)],
      ['检验人员', d.operatorName], ['审核人员', d.reviewerName], ['出具机构', d.institutionName]
    ]),
    findingsText: d.findingsText || '',
    impressionText: d.impressionText || '',
    conclusionText: d.conclusionText || '',
    recommendationText: d.recommendationText || '',
    sections: sections,
    abnormalItems: abnormalItems,
    hasResultText: !!(d.findingsText || d.impressionText || d.conclusionText || d.recommendationText),
    attachments: attachments
  }
}

Page({
  data: {
    icons,
    theme: 'standard',
    recordId: '',
    report: null,
    loading: true,
    error: ''
  },

  onLoad(options) {
    const id = (options && options.recordId) ? decodeURIComponent(options.recordId) : ''
    this.setData({ theme: app.globalData.theme || 'standard', recordId: id })
    if (!id) {
      this.setData({ loading: false, error: '缺少报告编号，请从报告列表重新进入' })
      return
    }
    this.fetch()
  },

  fetch() {
    this.setData({ loading: true, error: '' })
    return userService.getReport(this.data.recordId)
      .then((d) => {
        this.setData({ report: normalizeDetail(d || {}), loading: false })
      })
      .catch((err) => {
        this.setData({ report: null, loading: false, error: errText(err) })
      })
  },

  /** 分组折叠：只切本地展示态，不重新请求、不改后端数据。 */
  onToggleSection(e) {
    const id = e.currentTarget.dataset.id
    const sections = this.data.report.sections.map((s) =>
      s.id === id ? Object.assign({}, s, { open: !s.open }) : s)
    this.setData({ 'report.sections': sections })
  },

  onPreview(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const images = this.data.report.attachments.filter((a) => a.isImage && a.url).map((a) => a.url)
    wx.previewImage({ current: url, urls: images.length ? images : [url] })
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh())
  }
})
