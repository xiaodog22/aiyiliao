/**
 * packageContent/pages/knowledge —— 健康科普列表（图文 + 提示视频）
 *
 * 数据来源（双源，契约 N12 口径）：服务端 GET /api/v1/health-articles 优先；
 * 列表为空或请求失败 → 降级到 utils/knowledge-kb.js（随包院内宣教材料），
 * 并显式提示来源，不伪造服务端数据。本地 KB 同时兜底离线/首启场景。
 * ⚠️ 全部分包内页面，视频素材同包，避免撑爆主包（主包已 1.33MB / 上限 2MB）。
 */
const app = getApp()
const KB = require('../../../utils/knowledge-kb.js')
const icons = require('../../../utils/icons.js')
// 封面已网络化（F2 · 2026-11-05）：KB 只存资源清单 key，展示时解析成远端 URL
const resource = require('../../../services/resource.js')
const contentService = require('../../services/content.js')

// 降级来源提示（放 JS 模块常量，不散写在 WXML；仅描述数据来源，非错误文案）
const LOCAL_SOURCE_TIP = '当前展示本地科普库内容'

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
    sourceTip: '',
    disclaimer: KB.DISCLAIMER,
    icons
  },

  onLoad() {
    this._buildAll()
    this.setData({ theme: app.globalData.theme || 'standard' })
    // 同步链路：先用本地 KB 填列表（首启/离线也有内容），再异步拉服务端覆盖
    this._apply()
    this._fetchRemote()
  },

  /** 清单由 app.js 冷启动异步刷新，首启进入本页时可能还没到 → 回到本页再补一次（与 home._applyRemoteAssets 同思路） */
  onShow() {
    if (!this._all) return
    this._buildAll()
    this._apply()
  },

  /**
   * 预转好展示字段：图标路径 + 解析后的封面 URL（模板里不做逻辑，保持 WXML 干净）。
   * 封面走 resourceUrl(key, '')：清单已就绪 → 远端地址；未就绪（首启/离线）→ ''，
   * 模板 `wx:if="{{item.cover}}"` 自动隐藏封面区，不会裂图。
   */
  _buildAll() {
    this._all = KB.FEED.map((it) => Object.assign({}, it, {
      iconPath: icons[it.icon] || icons.info,
      cover: it.coverKey ? resource.resourceUrl(it.coverKey, '') : ''
    }))
  },

  /**
   * 拉服务端列表（N12，匿名只读）：成功且非空 → 覆盖为服务端数据；
   * 空/失败 → 回落本地 KB 并显式提示来源。永远 .catch 兜底（离线、stub 环境均不抛）。
   * seq 防乱序：快速切分类/关键词时，只认最后一次请求的结果。
   */
  _fetchRemote() {
    const cat = this.data.cat
    const type = this.data.type
    const kw = String(this.data.keyword || '').trim()
    const params = {}
    if (cat && cat !== '全部') params.category = cat
    if (type && type !== 'all') params.type = type
    if (kw) params.kw = kw
    const seq = (this._fetchSeq = (this._fetchSeq || 0) + 1)
    contentService.listArticles(params)
      .then((res) => {
        if (seq !== this._fetchSeq) return
        const rows = res && Array.isArray(res.list) ? res.list : []
        const mapped = rows.map(contentService.normalizeArticle).filter((x) => !!x)
        this._remote = mapped.length ? mapped : null
        this.setData({ sourceTip: mapped.length ? '' : LOCAL_SOURCE_TIP })
        this._apply()
      })
      .catch(() => {
        if (seq !== this._fetchSeq) return
        this._remote = null
        this.setData({ sourceTip: LOCAL_SOURCE_TIP })
        this._apply()
      })
  },

  /**
   * 分类 × 类型 × 关键词三重筛选（本地过滤，条数少无需分页；标题/摘要/分类命中即保留）。
   * 数据池：服务端结果可用时用服务端（同一套口径再滤一遍，防参数时序差），否则本地 KB。
   */
  _apply() {
    const cat = this.data.cat
    const type = this.data.type
    const kw = String(this.data.keyword || '').trim()
    // 本地源先走 KB 的既定筛选口径（spy/回归依赖此调用，勿移除）
    const base = KB.filterFeed(cat, type)
    const allow = {}
    base.forEach((x) => { allow[x.id] = 1 })
    const remote = this._remote && this._remote.length ? this._remote : null
    const pool = remote || this._all
    this.setData({
      list: pool.filter((x) => {
        if (remote) {
          // 服务端条目：同一三维口径复滤（服务端已按参数过滤，此处兜底）
          if (cat && cat !== '全部' && x.category !== cat) return false
          if (type && type !== 'all' && x.type !== type) return false
        } else if (!allow[x.id]) return false
        if (!kw) return true
        const blob = (x.title || '') + (x.summary || '') + (x.category || '')
        return blob.indexOf(kw) >= 0
      })
    })
  },

  onCat(e) {
    this.setData({ cat: e.currentTarget.dataset.cat })
    this._apply()
    this._fetchRemote()
  },

  onType(e) {
    const type = e.currentTarget.dataset.type || 'all'
    if (type === this.data.type) return
    this.setData({ type })
    this._apply()
    this._fetchRemote()
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this._apply()
    this._fetchRemote()
  },

  onClearSearch() {
    this.setData({ keyword: '' })
    this._apply()
    this._fetchRemote()
  },

  goDetail(e) {
    wx.navigateTo({ url: '/packageContent/pages/detail/detail?id=' + e.currentTarget.dataset.id })
  }
})
