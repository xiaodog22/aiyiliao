/**
 * pages/triage/result —— 智能导诊报告（V1.8）
 *
 * 由导诊页「完整报告」进入；报告数据来自本机 storage `wb_triage_report`
 * （由 utils/triage-engine.toReport 统一产出，页面只做渲染，不重复拼装）。
 *
 * 展示顺序即"用户此刻最需要知道的顺序"：
 *   ① 分级 → 我能等吗？  ② 红旗/急救指引（若有）  ③ 去哪科 + 为什么
 *   ④ 我到底说了什么（可核对）  ⑤ 下一步动作  ⑥ 合规与隐私说明
 */
const app = getApp()
const icons = require('../../../utils/icons.js')
const speech = require('../../../services/speech.js')
const triageService = require('../../../services/triage.js')

const REPORT_KEY = 'wb_triage_report'

Page({
  data: {
    icons,
    theme: 'standard',
    r: null,
    empty: false,
    speaking: false
  },

  onLoad() {
    let report = null
    try { report = wx.getStorageSync(REPORT_KEY) || null } catch (e) { report = null }
    this.setData({ theme: app.globalData.theme || 'standard' })
    if (!report || !report.dept) {
      this.setData({ empty: true })
      return
    }
    this.setData({ r: report })
  },

  onHide() { speech.stopSpeak() },
  onUnload() { speech.stopSpeak() },

  // 播报建议（复用统一 TTS；失败只提示不阻断）
  onSpeak() {
    const r = this.data.r
    if (!r) return
    if (this.data.speaking) {
      speech.stopSpeak()
      this.setData({ speaking: false })
      return
    }
    const text = (r.levelText || '') + '。建议就诊科室：' + (r.dept || '')
      + '。' + (r.levelAdvice || '') + '。' + (r.disclaimer || '')
    this.setData({ speaking: true })
    speech.speak(text, {
      onEnd: () => this.setData({ speaking: false }),
      onError: () => {
        this.setData({ speaking: false })
        wx.showToast({ title: '语音暂不可用，请阅读文字', icon: 'none' })
      },
      onDegraded: () => wx.showToast({ title: '当前为占位音质', icon: 'none' })
    })
  },

  onCall120() {
    wx.makePhoneCall({
      phoneNumber: '120',
      fail: () => wx.showToast({ title: '请手动拨打 120', icon: 'none' })
    })
  },

  onDeptBook() {
    const dept = this.data.r ? this.data.r.dept : ''
    if (dept) wx.setStorageSync('wb_appoint_dept', dept)
    wx.switchTab({ url: '/pages/appointment/appointment' })
  },

  onNav() {
    const dept = this.data.r ? this.data.r.dept : ''
    wx.navigateTo({ url: '/packageNav/pages/nav/nav' + (dept ? ('?dept=' + encodeURIComponent(dept)) : '') })
  },

  // 回到导诊页继续补充症状
  // 返回重试；本页是栈首（直接编译打开本页）时 navigateBack 会失败 → 兜底重开导诊页
  onRetry() { wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/triage/triage' }) }) },

  // 隐私：报告只是本机缓存，用户可一键删除
  onClear() {
    const r = this.data.r
    wx.showModal({
      title: '删除本机导诊记录',
      content: '将清除本机保存的全部导诊记录与统计（不影响挂号信息），确定吗？',
      success: (res) => {
        if (!res.confirm) return
        triageService.clearAll()
        try { wx.removeStorageSync(REPORT_KEY) } catch (e) {}
        wx.showToast({ title: '已清除', icon: 'success' })
        // 清除后仍可阅读当前报告，只是不再留存
        this.setData({ r: r })
      }
    })
  },

  onPolicy() {
    wx.showModal({
      title: '隐私说明',
      content: triageService.PRIVACY_NOTICE,
      showCancel: false,
      confirmText: '知道了'
    })
  }
})
