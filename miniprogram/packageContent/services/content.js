/* 分包内科普内容服务，避免该模块进入主包。 */
const API = require('../../config/api.js')
const { get } = require('../../services/request.js')

/** 科普详情。id 为本地 KB / 服务端共用的文章 id。 */
function getArticle(id) {
  return get(API.HEALTH_ARTICLE_DETAIL, null, { params: { id: String(id || '') } })
}

module.exports = { getArticle }
