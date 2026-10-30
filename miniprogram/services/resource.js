/*
 * resource.js —— 非关键远端资源清单与本地回退
 *
 * 页面应先使用随包关键图标、骨架和文字启动。本模块仅在后台刷新可选图片/视频 URL；
 * 清单或单个资源失败时返回内置回退路径，绝不阻断登录和业务接口。
 * 字段形状以 backend/contracts/business-openapi.yaml ResourceManifest 为唯一事实源
 *   （key/level/mime/size/sha256 必填；url/version/expiresAt/fallbackKey 可选）。
 * TODO(接入下载链路时)：按契约实现 sha256 下载后校验（校验失败回退内置或上一有效版本）。
 */
const { get, url, withPath, API } = require('./request.js')

const MANIFEST_KEY = 'wb_resource_manifest_v2'

// 契约 ResourceItem required：key/level/mime/size/sha256（business-openapi.yaml）
const REQUIRED_FIELDS = ['key', 'level', 'mime', 'size', 'sha256']

function readCachedManifest() {
  try {
    const data = wx.getStorageSync(MANIFEST_KEY)
    return data && Array.isArray(data.items) ? data : null
  } catch (e) {
    return null
  }
}

function saveManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.items)) return false
  try {
    wx.setStorageSync(MANIFEST_KEY, {
      manifestVersion: manifest.manifestVersion || manifest.version || '',
      etag: manifest.etag || '',
      generatedAt: manifest.generatedAt || '',
      items: manifest.items.map((item) => {
        // 缺字段仅告警不抛错（模块"绝不阻断"原则）
        for (const f of REQUIRED_FIELDS) {
          if (item[f] === undefined || item[f] === null) {
            console.warn(`[resource] manifest item 缺字段: ${f}（key=${item.key}）`)
          }
        }
        return {
          key: item.key,
          level: item.level || '',
          mime: item.mime || '',
          size: Number(item.size || 0),
          sha256: item.sha256 || '',
          url: item.url || '',
          version: item.version || '',
          expiresAt: item.expiresAt || '',
          fallbackKey: item.fallbackKey || ''
        }
      })
    })
    // 清理旧字段形状缓存（v1 使用 fallback/bytes/critical，与契约不符）
    wx.removeStorageSync('wb_resource_manifest_v1')
    return true
  } catch (e) {
    return false
  }
}

// 单飞：app.js 启动时刷新 + 登录页 onShow 再刷新，两处并发会打两条一样的请求。
// 这里合成一条（与 request.js 的 GET 单飞同思路），resolve 后释放以便下轮重新获取。
let inflight = null

function refreshManifest() {
  if (!API.RESOURCE_MANIFEST) return Promise.resolve(readCachedManifest())
  if (inflight) return inflight
  inflight = get(API.RESOURCE_MANIFEST)
    .then((manifest) => {
      saveManifest(manifest)
      inflight = null
      return readCachedManifest()
    })
    .catch(() => {
      inflight = null
      return readCachedManifest()
    })
  return inflight
}

function resolveResource(key, builtinFallback) {
  const manifest = readCachedManifest()
  const item = manifest && manifest.items.find((it) => it.key === key)
  if (!item || !item.url) return builtinFallback || (item && item.fallbackKey) || ''
  return item.url
}

/**
 * 远端 URL（比 resolveResource 更积极）：清单声明了该 key 就一定有可用地址。
 *
 * 两种情形：
 *  1. 服务端配了 app.resources.public-base-url → 清单 url 就是绝对地址，直接用；
 *  2. 未配基址 → 清单 url 为 null，但端点本身是**匿名可读**的，按本地网关拼
 *     `{gateway}/api/v1/resources/{key}`（这条路 2026-10-21 起是登录页主视觉的实际通道）。
 *
 * 末尾带 `?v={sha256 前 12 位}`：微信端按 URL 缓存图片，改版后旧图最长会残留 7 天
 * （服务端 Cache-Control max-age=604800）；带内容指纹即可让新版本立刻生效，
 * 服务端忽略未知 query，不影响 ETag/304。
 */
function resourceUrl(key, builtinFallback) {
  const manifest = readCachedManifest()
  const item = manifest && manifest.items.find((it) => it.key === key)
  if (!item) return builtinFallback || ''
  if (item.url) return item.url
  const base = url(withPath(API.RESOURCE_ITEM, { key }))
  if (!base) return builtinFallback || ''
  const stamp = String(item.sha256 || '').slice(0, 12)
  return stamp ? base + '?v=' + stamp : base
}

function fallbackFor(key, builtinFallback) {
  const manifest = readCachedManifest()
  const item = manifest && manifest.items.find((it) => it.key === key)
  return (item && item.fallbackKey) || builtinFallback || ''
}

module.exports = {
  readCachedManifest,
  saveManifest,
  refreshManifest,
  resolveResource,
  resourceUrl,
  fallbackFor
}
