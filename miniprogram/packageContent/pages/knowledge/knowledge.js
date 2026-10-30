/**
 * packageContent/pages/knowledge —— 健康科普列表（图文 + 提示视频）
 *
 * 数据来源：utils/knowledge-kb.js（随包发布的院内宣教材料，非后端接口）。
 * ⚠️ 全部分包内页面，视频素材同包，避免撑爆主包（主包已 1.33MB / 上限 2MB）。
 */
const app = getApp()
const KB = require('../../../utils/knowledge-kb.js')
const icons = require('../../../utils/icons.js')

Page({
  data: {
    theme: 'standard',
    cats: KB.CATEGORIES,
    cat: '全部',
    // 类型维度（CORE_FLOWS「cat × type 双筛选」）：KB.filterFeed 早就支持，页面此前没接（审查 P1-07）
    types: [
      { key: 'all', name: '全部' },
      { key: 'article', name: '图文' },
      { key: 'video', name: '视频' }
    ],
    type: 'all',
    keyword: '',
    list: [],
    disclaimer: KB.DISCLAIMER,
    icons
  },

  onLoad() {
    // 预转好展示字段：图标路径（模板里不做逻辑，保持 WXML 干净）
    this._all = KB.FEED.map((it) => Object.assign({}, it, {
      iconPath: icons[it.icon] || icons.info
    }))
    this.setData({ theme: app.globalData.theme || 'standard' })
    this._apply()
  },

  /** 分类 × 类型 × 关键词三重筛选（本地过滤，条数少无需分页；标题/摘要/分类命中即保留） */
  _apply() {
    const cat = this.data.cat
    const type = this.data.type
    const kw = String(this.data.keyword || '').trim()
    // 先走 KB 的既定筛选口径（与服务端/内容库同源），再叠关键词
    const base = KB.filterFeed(cat, type)
    const allow = {}
    base.forEach((x) => { allow[x.id] = 1 })
    this.setData({
      list: this._all.filter((x) => {
        if (!allow[x.id]) return false
        if (!kw) return true
        const blob = (x.title || '') + (x.summary || '') + (x.category || '')
        return blob.indexOf(kw) >= 0
      })
    })
  },

  onCat(e) {
    this.setData({ cat: e.currentTarget.dataset.cat })
    this._apply()
  },

  onType(e) {
    const type = e.currentTarget.dataset.type || 'all'
    if (type === this.data.type) return
    this.setData({ type })
    this._apply()
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this._apply()
  },

  onClearSearch() {
    this.setData({ keyword: '' })
    this._apply()
  },

  goDetail(e) {
    wx.navigateTo({ url: '/packageContent/pages/detail/detail?id=' + e.currentTarget.dataset.id })
  }
})
