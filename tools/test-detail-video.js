/**
 * tools/test-detail-video.js —— 科普详情页「远端视频优先 + 回退」逻辑测试
 *
 * 为什么需要：`<video>` 的签名链切换、过期换新、回落基准源全靠 detail.js 的状态机，
 * 这些分支在真机上难以逐一复现（尤其"签名过期 403"要等 2 小时）。
 * 这里打桩 wx / getApp / Page，真实 require 页面文件，把三条路径钉死：
 *   ① videoSrc 解析：undefined / 站内相对 / 绝对 URL
 *   ② onVideoError：首次重试 → 相同 URL 回落基准源 → 基准源仍失败只出文案
 *   ③ videoDurationSec 为 null 时不渲染 "null"
 * 基准源 = 资源端点直拼（F2 Phase B：包内 mp4 已出包，见 services/resource.js#staticResourceUrl）。
 *
 * ⚠️ 单测**不能替代真机**：<video> 能否真解码、拖动是否 206、过期是否 403
 *    必须在开发版真机 + 调试模式下验证（见 docs/阶段3_前端远端应用与回退_20261020.md §5）。
 *
 * 运行：node tools/test-detail-video.js
 */
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')
let PASS = 0
let FAIL = 0
const fails = []

function check(name, ok, extra) {
  if (ok) { PASS++; process.stdout.write('.') ; return }
  FAIL++
  fails.push(name + (extra ? '  ← ' + extra : ''))
  process.stdout.write('F')
}

// ==================== wx 打桩 ====================
// 每次请求由 MODE 决定返回什么；页面用例通过改 MODE 模拟不同服务端行为
let MODE = 'ok'          // ok | notfound | same | new
let ARTICLE_CALLS = 0
const REMOTE_OLD = '/api/v1/attachments/dddddddddddddddddddddddddddddddd.mp4?expires=1000&sig=aaa'
const REMOTE_NEW = '/api/v1/attachments/dddddddddddddddddddddddddddddddd.mp4?expires=9999&sig=bbb'

const baseWx = {
  getStorageSync() { return '' },
  setStorageSync() {},
  removeStorageSync() {},
  clearStorageSync() {},
  showToast() {},
  showModal() {},
  showLoading() {},
  hideLoading() {},
  navigateTo() {},
  redirectTo() {},
  reLaunch() {},
  previewImage() {},
  openDocument() {},
  setNavigationBarTitle() {},
  stopPullDownRefresh() {},
  getSystemInfoSync() {
    return { platform: 'devtools', windowWidth: 375, windowHeight: 667, statusBarHeight: 20, SDKVersion: '3.0.0' }
  },
  getNetworkType() {},
  onNetworkStatusChange() {},
  request(o) {
    const url = String(o.url || '')
    setTimeout(() => {
      if (url.indexOf('/api/v1/health-articles/') >= 0) {
        ARTICLE_CALLS++
        if (MODE === 'notfound') {
          o.success({ statusCode: 404, data: { code: 'ARTICLE_NOT_FOUND', message: '不存在' } })
          return
        }
        const videoUrl = MODE === 'new' ? REMOTE_NEW : REMOTE_OLD
        o.success({
          statusCode: 200,
          data: { code: 'OK', data: { id: 'wash-hands', title: '正确洗手七步法', type: 'video', videoUrl } }
        })
        return
      }
      o.success({ statusCode: 200, data: { code: 'OK', data: {} } })
    }, 0)
  }
}

global.wx = new Proxy(baseWx, {
  get(t, k) { return k in t ? t[k] : function () {} }
})
global.getApp = () => ({ globalData: { theme: 'standard', role: 'patient', user: { name: '测试' } }, MOCK: {} })

const ENV = require(path.join(ROOT, 'config', 'env.js'))
const userService = require(path.join(ROOT, 'services', 'user.js'))
const KB = require(path.join(ROOT, 'utils', 'knowledge-kb.js'))

/** require 页面文件并取出 Page 配置 */
function loadPage(rel) {
  let cfg = null
  global.Page = (c) => { cfg = c }
  const abs = path.join(ROOT, rel)
  delete require.cache[require.resolve(abs)]
  require(abs)
  if (!cfg) throw new Error('未捕获到 Page 配置：' + rel)
  return cfg
}

/** Page 配置 → 可调用实例（setData 支持 a.b / a[n] 路径） */
function instantiate(cfg) {
  const inst = Object.assign({}, cfg)
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}))
  inst.setData = (patch) => {
    Object.keys(patch).forEach((k) => {
      const mm = /^([\w$]+)\.([\w$]+)$/.exec(k)
      if (mm) { inst.data[mm[1]] = inst.data[mm[1]] || {}; inst.data[mm[1]][mm[2]] = patch[k] }
      else inst.data[k] = patch[k]
    })
  }
  return inst
}

function waitFor(pred, ms) {
  const limit = ms || 500
  const t0 = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      if (pred()) return resolve(true)
      if (Date.now() - t0 > limit) return resolve(false)
      setTimeout(tick, 5)
    }
    tick()
  })
}

const BASE_VIDEO = ENV.gateway + '/api/v1/resources/video.wash-hands'
// 封面已网络化（F2 · 2026-11-05）：包内 jpg 已删，poster 走资源清单；
// 本测试的 wx 打桩无 manifest（getStorageSync 恒空）→ 解析结果就是空串。
const NO_MANIFEST_COVER = ''

// ==================== ① resolveAttachmentUrl 解析 ====================
;(function testResolve() {
  check('undefined → 空串', userService.resolveAttachmentUrl(undefined) === '')
  check('null → 空串', userService.resolveAttachmentUrl(null) === '')
  check('空串 → 空串', userService.resolveAttachmentUrl('') === '')
  check('不会拼出 /undefined', !/undefined/.test(userService.resolveAttachmentUrl(undefined)))

  const rel = userService.resolveAttachmentUrl(REMOTE_OLD)
  check('站内相对 → 拼网关', rel === ENV.gateway + REMOTE_OLD, '实得 ' + rel)
  check('拼出的地址是绝对 http(s)', /^https?:\/\//i.test(rel), '实得 ' + rel)

  const abs = 'https://cdn.example.com/a.mp4'
  check('绝对 URL → 原样', userService.resolveAttachmentUrl(abs) === abs)
})()

// ==================== ② onLoad：远端优先 / 404 回退 ====================
;(async function testOnLoad() {
  const cfg = loadPage('packageContent/pages/detail/detail.js')

  // 正常：服务端有 videoUrl → 覆盖基准源
  MODE = 'ok'; ARTICLE_CALLS = 0
  let inst = instantiate(cfg)
  inst.onLoad({ id: 'wash-hands' })
  check('onLoad 首屏先用资源端点基准源', inst.data.item.videoSrc === BASE_VIDEO,
    '实得 ' + inst.data.item.videoSrc)
  check('onLoad 封面走清单（打桩无 manifest → 空串）', inst.data.item.posterSrc === NO_MANIFEST_COVER,
    '实得 ' + JSON.stringify(inst.data.item.posterSrc))
  await waitFor(() => inst.data.item.videoSrc !== BASE_VIDEO)
  check('拿到 videoUrl 后切远端', inst.data.item.videoSrc === ENV.gateway + REMOTE_OLD,
    '实得 ' + inst.data.item.videoSrc)
  check('远端无 coverUrl 时 poster 保持清单值', inst.data.item.posterSrc === NO_MANIFEST_COVER,
    '实得 ' + JSON.stringify(inst.data.item.posterSrc))
  check('记录原始 videoUrl 供重试比对', inst.data.videoUrl === REMOTE_OLD)

  // 404：保持基准源，不报错、不空白
  MODE = 'notfound'
  inst = instantiate(cfg)
  inst.onLoad({ id: 'wash-hands' })
  await waitFor(() => ARTICLE_CALLS > 0)
  check('接口 404 时仍用基准源', inst.data.item.videoSrc === BASE_VIDEO)
  check('接口 404 不置错误态', inst.data.videoErr === false)

  // ==================== ③ onVideoError 三条分支 ====================
  // 分支 A：首次失败 → 重拉拿到**相同** URL → 直接回落基准源
  MODE = 'same'; ARTICLE_CALLS = 0
  inst = instantiate(cfg)
  inst.onLoad({ id: 'wash-hands' })
  await waitFor(() => inst.data.videoUrl === REMOTE_OLD)
  check('前置：已是远端源', inst.data.item.videoSrc === ENV.gateway + REMOTE_OLD)
  inst.onVideoError()
  check('首次失败置 videoRetried', inst.data.videoRetried === true)
  await waitFor(() => inst.data.item.videoSrc === BASE_VIDEO)
  check('重试拿到相同 URL → 回落基准源', inst.data.item.videoSrc === BASE_VIDEO,
    '实得 ' + inst.data.item.videoSrc)

  // 分支 B：重拉拿到**新** URL → 用新 URL（不立即回退）
  MODE = 'new'; ARTICLE_CALLS = 0
  inst = instantiate(cfg)
  inst.onLoad({ id: 'wash-hands' })
  await waitFor(() => inst.data.videoUrl === REMOTE_OLD)
  inst.onVideoError()
  await waitFor(() => inst.data.item.videoSrc === ENV.gateway + REMOTE_NEW)
  check('重试拿到新 URL → 切新地址', inst.data.item.videoSrc === ENV.gateway + REMOTE_NEW,
    '实得 ' + inst.data.item.videoSrc)
  check('新 URL 写入 videoUrl', inst.data.videoUrl === REMOTE_NEW)

  // 分支 C：已是基准源仍失败 → 只出文案，不再改 src（防死循环）
  inst = instantiate(cfg)
  inst.onLoad({ id: 'wash-hands' })
  inst.setData({ 'item.videoSrc': BASE_VIDEO, videoUrl: '', videoRetried: true })
  inst.onVideoError()
  check('基准源仍失败 → videoErr=true', inst.data.videoErr === true)
  check('基准源仍失败 → 不改 src（防死循环）', inst.data.item.videoSrc === BASE_VIDEO)

  // ==================== ④ videoDurationSec 为 null 不渲染 ====================
  const it = KB.byId('wash-hands')
  check('本地 KB 有 durationSec 兜底', typeof it.durationSec === 'number', '实得 ' + it.durationSec)
  MODE = 'ok'
  inst = instantiate(cfg)
  inst.onLoad({ id: 'wash-hands' })
  await waitFor(() => inst.data.videoUrl === REMOTE_OLD)
  check('metaLine 不含 null（远端 videoDurationSec 恒 null 时用本地兜底）',
    !/null/i.test(String(inst.data.item.metaLine)), '实得 ' + inst.data.item.metaLine)
  check('metaLine 含本地时长',
    String(inst.data.item.metaLine).indexOf(String(it.durationSec)) >= 0, '实得 ' + inst.data.item.metaLine)

  // ==================== 输出 ====================
  console.log('\n== test-detail-video ==')
  if (fails.length) { fails.forEach((f) => console.log('  FAIL ' + f)) }
  console.log('通过 ' + PASS + ' / 共 ' + (PASS + FAIL))
  process.exit(FAIL ? 1 : 0)
})()
