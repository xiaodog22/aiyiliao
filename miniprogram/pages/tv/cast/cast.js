/**
 * pages/tv/cast —— 智能电视投屏（V3.1 页面4，大屏投屏参考）
 * 纯前端演示：设备连接本地模拟 + 功能切换 + 大屏渲染预览
 */
const app = getApp()
const icons = require('../../../utils/icons.js')

Page({
  data: {
    icons,
    theme: 'standard',
    devices: [],
    emptyNetwork: '/assets/img/empty-network.png',
    preview: null,
    previewMode: 'queue',
    previewModeText: '叫号显示',
    /* short = 图标底板下的短标签（参考图 12：叫号显示 / 就诊信息 / 科普内容 三项） */
    functions: [
      { icon: 'megaphone', name: '叫号与排队进度大屏展示', short: '叫号显示', mode: 'queue' },
      { icon: 'clipboardList', name: '就诊信息大屏展示', short: '就诊信息', mode: 'patient' },
      { icon: 'phone', name: '科普内容大屏展示', short: '科普内容', mode: 'knowledge' }
    ]
  },

  onLoad() {
    const MOCK = app.MOCK
    // ⚠️ 后端「设备发现/配对」接口未接入（见报告缺失 API），初始即空态「尚未发现设备」，
    //    不再把本地 MOCK.TV_DEVICES 渲染成"已搜到设备"（那是假数据）。
    // 已连接状态从本地缓存读出后**必须回显**：否则连过也会显示"尚未发现设备"，
    // 而且 devices 恒空 → onConnect 永远没有可点的行，断开也做不到（审查 P2-06）。
    const saved = wx.getStorageSync('wb_tv') || null
    const devices = saved && saved.name && saved.ip
      ? [{ name: saved.name, ip: saved.ip, connected: true }]
      : []
    this.setData({
      icons,
      theme: app.globalData.theme || 'standard',
      devices,
      preview: Object.assign({}, MOCK.TV_PREVIEW, {
        waitingText: (MOCK.TV_PREVIEW.waiting || []).join(' · ')
      }),
      previewModeText: '叫号显示'
    })
  },

  /**
   * 「搜索设备」：⚠️ 演示版没有接入真实的局域网/DLNA 发现协议，
   * 所以这里只如实告知，**不伪造"搜到了新设备"**（设备列表来自 app.MOCK，固定不变）。
   */
  onRescan() {
    wx.showToast({ title: '演示版：设备列表为本地模拟，未接入真实发现协议', icon: 'none', duration: 2400 })
  },

  // 连接/断开设备
  onConnect(e) {
    const index = Number(e.currentTarget.dataset.index)
    const devices = this.data.devices.map((d, i) => {
      if (i === index) {
        d.connected = !d.connected
      } else if (d.connected) {
        d.connected = false
      }
      return d
    })
    const active = devices.find(d => d.connected)
    if (active) {
      wx.setStorageSync('wb_tv', { name: active.name, ip: active.ip })
      // 提示带「演示版」前缀：这是本地模拟连接，不能让人误以为真的连上了电视
      wx.showToast({ title: '演示版：已模拟连接 ' + active.name, icon: 'none' })
    } else {
      wx.removeStorageSync('wb_tv')
      wx.showToast({ title: '演示版：已断开模拟连接', icon: 'none' })
    }
    this.setData({ devices })
  },

  // 切换投屏功能
  switchFunc(e) {
    const mode = e.currentTarget.dataset.mode
    const fn = this.data.functions.find(f => f.mode === mode)
    if (!fn || mode === this.data.previewMode) return
    this.setData({ previewMode: mode, previewModeText: fn.short })
  }
})
