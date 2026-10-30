/**
 * pages/profile/privacy —— 隐私政策（真实页面；profile「协议」组入口）
 * ⚠️ 内容为演示版声明，正式上线前由法务/合规替换为正式文本。
 *    此处为静态声明页，不拉取、不上传任何真实个人健康数据。
 */
const app = getApp()

Page({
  data: {
    theme: 'standard',
    updatedAt: '2026-10-19'
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'standard' })
  }
})
