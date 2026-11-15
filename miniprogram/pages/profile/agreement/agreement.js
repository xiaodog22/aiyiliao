/**
 * pages/profile/agreement —— 用户协议（真实页面；profile「协议」组入口）
 * 正文在 agreement.wxml；运营主体采用泛称「我们/运营方」（无公司名占位），
 * 联系渠道只引用真实存在的院内服务台，不引用未落地的「意见反馈」等入口。
 */
const app = getApp()

Page({
  data: {
    theme: 'standard',
    updatedAt: '2026-11-15'
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'standard' })
  }
})
