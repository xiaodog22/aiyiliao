/**
 * packageContent/pages/detail —— 科普详情（设计稿 18 图文 / 19 视频）
 *
 * 一个页面承载两种类型，避免两个高度相似的页面各自维护一套样式：
 *   type === 'video'   → 通栏播放器 + 白卡（标题/元信息/摘要）+ 观看提示 + 相关推荐
 *   type === 'article' → 标题/元信息 + 通栏封面 + 分节正文 + 小贴士 + 相关推荐
 *
 * ⚠️ navigationStyle = custom：导航栏自绘（设计稿 18 右侧是「收藏 + 分享」，原生导航栏放不进去），
 *   因此这里要算 statusBarHeight 并把 navH（状态栏 + 44pt）内联给页面根节点做 padding-top。
 * ⚠️ 视频源是**分包内的本地 mp4**（/packageContent/videos/*.mp4），不依赖外网 CDN；
 *   播放失败时降级为文字提示，不留白屏。
 * ⚠️ 点赞 / 收藏**没有后端接口**，走本地 Storage（按 id 存两个数组）——不伪造服务端计数。
 */
const app = getApp()
const KB = require('../../../utils/knowledge-kb.js')
const icons = require('../../../utils/icons.js')
// 远端视频源：服务端详情下发签名 videoUrl（V19）；拉不到就继续用包内 mp4
const contentService = require('../../services/content.js')
// 复用现有解析函数（不新造 resolveRemote）：站内相对路径拼 ENV.gateway，空值返回 ''
const userService = require('../../../services/user.js')

const STAR_KEY = 'kb_star_ids'   // 收藏的科普 id 数组
const LIKE_KEY = 'kb_like_ids'   // 点赞的科普 id 数组

Page({
  data: {
    theme: 'standard',
    statusBarHeight: 20,
    navH: 64,                    // statusBarHeight + 44（导航栏 88rpx = 44pt）
    item: null,
    missing: false,
    tipList: [],
    related: [],
    starred: false,
    liked: false,
    videoErr: false,
    // 远端视频状态：videoUrl 为服务端原始签名路径；videoSrc 为解析后的可播地址
    videoUrl: '',
    videoRetried: false,
    localVideo: '',
    localCover: '',
    disclaimer: KB.DISCLAIMER,
    icons
  },

  onLoad(q) {
    const theme = app.globalData.theme || 'standard'
    let sbh = 20
    try { sbh = (wx.getWindowInfo() || {}).statusBarHeight || 20 } catch (e) {}

    const it = KB.byId(q && q.id)
    if (!it) {
      this.setData({ theme, statusBarHeight: sbh, navH: sbh + 44, missing: true })
      return
    }

    const isVideo = it.type === 'video'
    const related = KB.FEED
      .filter((x) => x.id !== it.id && x.category === it.category)
      .slice(0, 4)
      .map((x) => ({
        id: x.id,
        title: x.title,
        cover: x.cover || '',
        iconPath: icons[x.icon] || icons.info
      }))

    // 包内兜底源：远端拿不到（或播放失败）时回落，保证任何时刻都有可播地址
    const localVideo = it.video || ''
    const localCover = it.cover || ''

    this.setData({
      theme,
      statusBarHeight: sbh,
      navH: sbh + 44,
      item: Object.assign({}, it, {
        // 图文 meta 完全对齐设计稿 18：「科室 · 约N分钟阅读 · 日期」
        // 视频设计稿 19 是「科室 · 5分30秒 · 日期」，但 video 条目没有 source/publishedAt 字段，
        // 按「不伪造数据」只拼真实字段（分类已在 chip 里，故此处只放时长，避免"饮食 · 饮食"重复）
        metaLine: isVideo
          ? ('视频时长 ' + this._durText(it.durationSec))
          : ((it.source || '院内宣传科') + ' · 约' + it.readMin + '分钟阅读 · ' + it.publishedAt),
        // 首屏先给包内源（秒开）；_fetchRemoteVideo 成功后覆盖成远端
        videoSrc: localVideo,
        posterSrc: localCover
      }),
      localVideo,
      localCover,
      // 视频用 tips 做「观看提示」；图文的 keyPoints 与 sections 内容重复，不再单独展示
      tipList: isVideo ? (it.tips || []) : [],
      related,
      videoErr: false,
      videoRetried: false,
      videoUrl: ''
    })

    this._syncFlags()
    // 异步拉服务端详情：有 videoUrl 就切远端；404/网络错误静默保持本地（不阻断播放）
    if (isVideo) this._fetchRemoteVideo(it.id, false)
  },

  /** 从其他页面返回时收藏态可能已变（如后续在列表页取消收藏），每次显示都同步一次 */
  onShow() {
    this._syncFlags()
  },

  /** 时长文案：设计稿写「5分30秒」，故 >60s 走分秒，否则纯秒 */
  _durText(sec) {
    const s = Number(sec) || 0
    if (s < 60) return s + ' 秒'
    return Math.floor(s / 60) + ' 分' + (s % 60 ? (s % 60) + ' 秒' : '')
  },

  // ==================== 点赞 / 收藏（本地存储，无后端接口）====================

  /** Storage 读取加保护：脏数据/被清空都退回空数组，不让详情页因存储异常白屏 */
  _readIds(key) {
    try {
      const v = wx.getStorageSync(key)
      return Array.isArray(v) ? v : []
    } catch (e) {
      return []
    }
  },

  /** 写入失败（配额满/被禁）只影响"记住状态"，不阻断当前交互，故只回落内存态 */
  _writeIds(key, ids) {
    try {
      wx.setStorageSync(key, ids)
      return true
    } catch (e) {
      return false
    }
  },

  _syncFlags() {
    const it = this.data.item
    if (!it) return
    this.setData({
      starred: this._readIds(STAR_KEY).indexOf(it.id) >= 0,
      liked: this._readIds(LIKE_KEY).indexOf(it.id) >= 0
    })
  },

  /** 顶部星标与底部「收藏」共用同一个存储键，改任一处两处同时变色 */
  onToggleStar() {
    const it = this.data.item
    if (!it) return
    const ids = this._readIds(STAR_KEY)
    const i = ids.indexOf(it.id)
    if (i >= 0) ids.splice(i, 1)
    else ids.push(it.id)
    this._writeIds(STAR_KEY, ids)
    this.setData({ starred: i < 0 })
    wx.showToast({ title: i < 0 ? '已收藏' : '已取消收藏', icon: 'none' })
  },

  onToggleLike() {
    const it = this.data.item
    if (!it) return
    const ids = this._readIds(LIKE_KEY)
    const i = ids.indexOf(it.id)
    if (i >= 0) ids.splice(i, 1)
    else ids.push(it.id)
    this._writeIds(LIKE_KEY, ids)
    this.setData({ liked: i < 0 })
  },

  // ==================== 导航 ====================

  /** 分享进入（页面栈只有 1 层）时 navigateBack 会失败 → 回列表页 */
  onBack() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.redirectTo({ url: '/packageContent/pages/knowledge/knowledge' })
  },

  onShareAppMessage() {
    const it = this.data.item
    return {
      title: it ? it.title : '健康科普',
      path: '/packageContent/pages/detail/detail?id=' + (it ? it.id : '')
    }
  },

  // ==================== 视频远端源 ====================

  /**
   * 拉服务端详情并切换远端视频源。
   * @param {string} id 文章 id（本地 KB 与服务端共用）
   * @param {boolean} isRetry 是否由 onVideoError 触发的重试
   */
  _fetchRemoteVideo(id, isRetry) {
    contentService.getArticle(id)
      .then((a) => {
        const raw = a && a.videoUrl
        if (!raw) return                        // 服务端未配视频 → 保持本地
        const src = userService.resolveAttachmentUrl(raw)
        if (!src) return                        // 解析不出绝对地址（空/异常）→ 保持本地
        // 重试拿到的还是**同一个原始 URL**（服务端没换新：expires/sig 都相同）→ 再试也没意义，回退包内。
        // ⚠️ 必须拿 raw 比 raw：src 是拼过网关的绝对地址，与 this.data.videoUrl（原始相对路径）
        //    永远不相等，用 src 比会导致这条回退分支从不生效（单测抓到过）。
        if (isRetry && raw === this.data.videoUrl) {
          this._fallbackLocal()
          return
        }
        this.setData({
          videoUrl: raw,
          'item.videoSrc': src,
          'item.posterSrc': this._posterOf(a) || this.data.localCover,
          videoErr: false
        })
      })
      .catch(() => {                            // 404/网络错误：不打断本地播放
        if (isRetry) this._fallbackLocal()
      })
  },

  /** 封面同样是"远端优先、本地兜底"：后端给签名 coverUrl 才用，否则保留包内封面 */
  _posterOf(a) {
    const raw = a && a.coverUrl
    return raw ? userService.resolveAttachmentUrl(raw) : ''
  },

  /**
   * 播放失败（binderror）处理，**最多重试一次**：
   *   ① 首次失败且有远端 URL：置 videoRetried 后重新拉详情换新 URL（处理签名过期 / 拖到一半 403）；
   *   ② 重试拿到的 URL 与旧相同、或重试仍失败 → 回退包内 mp4；
   *   ③ 已是包内源仍失败 → 只显示文案，**不再改 src**（否则会反复触发 error 形成死循环）。
   */
  onVideoError() {
    if (!this.data.videoRetried && this.data.videoUrl) {
      this.setData({ videoRetried: true })
      this._fetchRemoteVideo(this.data.item.id, true)
      return
    }
    this._fallbackLocal()
  },

  _fallbackLocal() {
    const local = this.data.localVideo || ''
    const cur = (this.data.item && this.data.item.videoSrc) || ''
    if (!local || cur === local) {
      this.setData({ videoErr: true })          // 本地也播不了：给文案，不再换源
      return
    }
    this.setData({ 'item.videoSrc': local, 'item.posterSrc': this.data.localCover || '' })
  },

  /** 相关推荐：用 redirectTo 就地替换，避免详情页在页面栈里越堆越深 */
  goRelated(e) {
    wx.redirectTo({ url: '/packageContent/pages/detail/detail?id=' + e.currentTarget.dataset.id })
  }
})
