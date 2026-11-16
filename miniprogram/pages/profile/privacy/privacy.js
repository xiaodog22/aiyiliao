/**
 * pages/profile/privacy —— 隐私政策（真实页面；profile「协议」组入口）
 * 正文在 privacy.wxml；静态声明页，不拉取、不上传任何真实个人健康数据。
 * 收集范围与「六、您的权利」中引用的入口均对齐现状（个人信息 / 就诊人管理 /
 * 系统设置-撤回授权 / 缓存管理 / 院内服务台注销），不含未落地功能。
 */
const app = getApp()

Page({
  data: {
    theme: 'standard',
    updatedAt: '2026-11-16'
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'standard' })
  }
})
