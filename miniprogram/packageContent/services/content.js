/* 分包内科普内容服务，避免该模块进入主包。 */
const API = require('../../config/api.js')
const { get } = require('../../services/request.js')
const icons = require('../../utils/icons.js')
const { resolveAttachmentUrl } = require('../../services/user.js')

/** 科普详情。id 为本地 KB / 服务端共用的文章 id。 */
function getArticle(id) {
  return get(API.HEALTH_ARTICLE_DETAIL, null, { params: { id: String(id || '') } })
}

/**
 * 科普列表（契约 N12：GET /api/v1/health-articles，匿名只读）。
 * @param {Object} [params] { category, type, kw, cursor, limit } —— 空值不携带
 * @returns {Promise<{list: Array, nextCursor: string|null, hasMore: boolean}>} unwrap 后的 OkArticleList
 */
function listArticles(params) {
  const q = {}
  Object.keys(params || {}).forEach((k) => {
    const v = params[k]
    if (v !== '' && v != null) q[k] = v
  })
  // get() 的 data 对 GET 即 query 参数；limit 上限 50（契约），一次拉全量
  if (q.limit == null) q.limit = 50
  return get(API.HEALTH_ARTICLE_LIST, q)
}

/**
 * 服务端 Article → 列表页可渲染对象（字段归一，页面拿到即可直接渲染）。
 * 服务端 Article 只有 { id,title,summary,coverUrl,category,type,readMin,publishedAt }，
 * icon 由 type 推默认键（复用 utils/icons.js 既有键，不新增素材）。
 */
function normalizeArticle(raw) {
  if (!raw || raw.id == null) return null
  const isVideo = raw.type === 'video'
  return {
    id: String(raw.id),
    type: isVideo ? 'video' : 'article',
    title: raw.title || '',
    summary: raw.summary || '',
    category: raw.category || '',
    readMin: raw.readMin || 0,
    publishedAt: raw.publishedAt || '',
    cover: resolveAttachmentUrl(raw.coverUrl || ''),
    iconPath: isVideo ? icons.video : icons.fileText,
    fromServer: true
  }
}

module.exports = { getArticle, listArticles, normalizeArticle }
