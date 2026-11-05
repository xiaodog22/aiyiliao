/**
 * test-nav-page.js —— 院内导航「带路闭环」离线单测（改动导航页/navigable/结果卡后必跑）
 *
 * 为什么要有它：带路这件事已经在真机上翻过两次车 ——
 *   第一次结果卡后根本不弹追问；第二次追问弹了、点「要，带我去」也跳了，
 *   但导航页在平板上排版崩了、底部按钮点不动、播报没声音。
 * 这些问题的共同点是**页面接线**（onReady 拿 ?dept= → 选目的地 → 补 floorTip；结果卡 → 追问 → 跳转），
 * `tools/test-triage.js` 只覆盖引擎与服务层，够不到。所以这里用最小桩把页面对象取出来真跑。
 *
 * 三段：
 *  ① 导航页：1F 直达 / 2F~4F 换层 / 带「门诊」后缀 / 切换返回大门
 *  ② 带路闭环：问诊页说症状 → 结果卡 → 追问 → 点「要，带我去」跳到 nav?dept=… → 导航页认得这个科室
 *  ③ 样式守则：nav.wxss 的关键规则不许被改回去（详情区确定高度 / 步骤区可收缩 / 平板就地占位面板 /
 *     操作区不透明独立层级 / 根节点挂 page-shell / 空状态手机不占位 / 横屏平板有独立档位）
 *     —— 前三条正是"文字穿模 + 按钮点不动"的根因；后三条是"平面图在平板卡片里留大片空白"的根因
 *
 * 用法：node tools/test-nav-page.js
 *       node tools/preview-nav-page.js [科室] [--empty] [--measure]   ← 排版实测（含地图空白率）
 */
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..', 'miniprogram')

// ==================== 全局桩 ====================
let navUrl = ''
const APP = { globalData: { theme: 'standard', user: { name: '张三', phone: '13800138001' } }, logout() {} }
global.getApp = () => APP

global.wx = {
  getWindowInfo: () => ({ statusBarHeight: 20, pixelRatio: 2 }),
  getStorageSync: () => '',
  setStorageSync() {},
  removeStorageSync() {},
  showToast() {},
  showModal: (o) => { if (o && o.success) o.success({ confirm: true }) },
  navigateTo: (o) => { navUrl = o.url },
  switchTab() {},
  navigateBack() {},
  makePhoneCall() {},
  base64ToArrayBuffer: () => new ArrayBuffer(0),
  getFileSystemManager: () => ({ writeFile: (o) => { if (o.fail) o.fail({}) } }),
  env: { USER_DATA_PATH: '/tmp' },
  getRecorderManager: () => ({ onStart() {}, onStop() {}, onError() {}, start() {}, stop() {} }),
  createInnerAudioContext: () => ({
    onEnd() {}, onError() {}, onCanplay() {}, onPlay() {}, play() {}, stop() {}, pause() {}, destroy() {}
  })
}

// canvas 节点桩：ctx 用 Proxy 全兜底（本测试只关心页面状态，不关心像素）
const ctxStub = new Proxy({}, {
  get(t, k) {
    if (k === 'measureText') return () => ({ width: 30 })
    if (k in t) return t[k]
    return () => {}
  },
  set(t, k, v) { t[k] = v; return true }
})
global.wx.createSelectorQuery = () => ({
  in: () => ({
    select: () => ({
      fields: () => ({
        exec: (cb) => cb([{
          width: 375, height: 420,
          node: {
            width: 0, height: 0,
            getContext: () => ctxStub,
            createImage: () => ({ set src(v) { if (this.onload) this.onload() } }),
            requestAnimationFrame: (fn) => setTimeout(fn, 16)
          }
        }])
      })
    })
  })
})

let captured = null
global.Page = (o) => { captured = o }

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('OK   ' + name); return }
  fail++
  console.log('FAIL ' + name + (extra ? '  →  ' + extra : ''))
}

function mount(page) {
  const ctx = Object.assign({}, page)
  ctx.data = JSON.parse(JSON.stringify(page.data))
  ctx.setData = function (patch, cb) {
    Object.keys(patch).forEach((k) => {
      // 数据路径赋值：支持 messages[3]（整条追加/替换）与 messages[3].content（改字段）
      // —— 微信 setData 两种都支持，问诊页用「整条追加」做增量更新（不再全量 concat）
      const m = /^messages\[(\d+)\](?:\.(.+))?$/.exec(k)
      if (m) {
        const i = Number(m[1])
        if (m[2]) ctx.data.messages[i][m[2]] = patch[k]
        else ctx.data.messages[i] = patch[k]
        return
      }
      ctx.data[k] = patch[k]
    })
    if (cb) cb()
  }
  return ctx
}

// ==================== ① 导航页 ====================
console.log('\n— ① 导航页：?dept= 解析 —')
require(path.join(ROOT, 'packageNav', 'pages', 'nav', 'nav.js'))
const navPage = captured
const MAP = require(path.join(ROOT, 'packageNav', 'data', 'indoor-map.js'))

function runNav(dept, expectId, expectTip) {
  const ctx = mount(navPage)
  ctx.onLoad({ dept: encodeURIComponent(dept) })
  ctx.onReady()
  check('[?dept=' + dept + '] 选中目的地 = ' + expectId,
    !!(ctx.data.active && ctx.data.active.id === expectId), ctx.data.active ? ctx.data.active.id : 'null')
  check('[?dept=' + dept + '] 「到」显示科室全名',
    ctx.data.activeLabel === dept, ctx.data.activeLabel || '(空)')
  check('[?dept=' + dept + '] 有分步指引（≥3 步）', ctx.data.steps.length >= 3, 'steps=' + ctx.data.steps.length)
  if (expectTip) {
    check('[?dept=' + dept + '] 换层提示：' + expectTip,
      !!(ctx.data.floorTip && ctx.data.floorTip.indexOf(expectTip) >= 0), ctx.data.floorTip || '(空)')
  } else {
    check('[?dept=' + dept + '] 1F 直达不给换层提示', ctx.data.floorTip === '', ctx.data.floorTip)
  }
  // 纯函数契约（tools/test-triage.js 也直接调它守"点了就一定有条路"）
  const pure = navPage._resolveDept.call(ctx, dept)
  check('[?dept=' + dept + '] _resolveDept 纯函数结论一致',
    !!(pure && pure.dest && pure.dest.id === expectId), pure ? pure.dest.id : 'null')
  return ctx
}

check('数据含全科医学科目的地', MAP.DESTINATIONS.some((d) => d.id === 'gp'))
runNav('全科医学科', 'gp', '')
runNav('消化内科', 'gi', '')
runNav('呼吸内科', 'resp', '')
runNav('骨科', 'ortho', '')
runNav('皮肤科', 'elevator', '2 楼')
runNav('神经内科', 'elevator', '3 楼')
runNav('妇产科', 'elevator', '4 楼')
runNav('内分泌科门诊', 'elevator', '3 楼')
runNav('消化内科门诊', 'gi', '')

// ==================== ② 带路闭环（问诊页 → 追问 → 导航页）====================
console.log('\n— ② 带路闭环：问诊页结果卡 → 追问 → 跳导航 → 页面认得 —')
const reqPath = require.resolve(path.join(ROOT, 'services', 'request.js'))
const API = require(path.join(ROOT, 'config', 'api.js'))
const RECOMMEND = { '我的肚子不舒服': '全科医学科', '胃疼反酸一周了': '消化内科门诊', '皮肤上起了很多红疹很痒': '皮肤科' }
require.cache[reqPath] = {
  id: reqPath, filename: reqPath, loaded: true,
  exports: {
    API,
    post(spec, data) {
      const p = String(spec.path)
      if (p.indexOf('emergency') >= 0) return Promise.resolve({ is_emergency: false, risk_level: 'low' })
      if (p.indexOf('recommend-department') >= 0) return Promise.resolve({ clinic: RECOMMEND[data && data.text] || '' })
      return Promise.resolve({})
    },
    get() { return Promise.resolve([]) },
    postForm() { return Promise.resolve({}) },
    getBinary() { return Promise.resolve(null) },
    url() { return '' },
    withPath: (s) => s,
    uploadFile() { return Promise.resolve({}) },
    withFallback(p) { return p },
    ENV: { MOCK_FALLBACK: true },
    encodeUTF8: () => new Uint8Array(),
    decodeUTF8: () => '',
    isArrayBuffer: () => false,
    headerOf: () => '',
    // ⚠️ 2026-10-16 认证改造新增：页面（triage/consultation）会先调会话就绪守卫。
    // 桩里直接放行（测试不覆盖鉴权链路，鉴权专项见 miniprogram/tools/test-auth-request.js）。
    ensureSessionReady: () => Promise.resolve(true),
    ensureAccessToken: () => Promise.resolve(true),
    // 2026-10-24：AI 问诊页改走真实会话后，页面会自己生成幂等键（超时重试复用同一键）
    newIdempotencyKey: () => 'test-idem-' + Date.now()
  }
}
delete require.cache[require.resolve(path.join(ROOT, 'services', 'triage.js'))]
require(path.join(ROOT, 'pages', 'consultation', 'consultation.js'))
const consultPage = captured

const CASES = [
  ['我的肚子不舒服', '全科医学科', 'gp'],
  ['胃疼反酸一周了', '消化内科', 'gi'],
  ['皮肤上起了很多红疹很痒', '皮肤科', 'elevator']
]
let ci = 0
function nextCase() {
  if (ci >= CASES.length) return styleChecks()
  const [text, dept, expectDest] = CASES[ci++]
  navUrl = ''
  const ctx = mount(consultPage)
  ctx.onLoad()
  // 2026-10-24：AI 问诊页已改为「真实会话 + 多轮 AI 追问 + TRIAGE 分诊」，
  // 不再有「说一句话立刻出科室卡」的本地引擎路径；本段只验证页面接线
  // （结果卡渲染 → 自动弹「要不要带路」→ 跳导航 → 导航页认得科室），
  // 因此直接把一张分诊卡喂给渲染函数，不经过模型。
  ctx._pushDeptCard({
    primary: { dept: dept, confidence: { text: '80%' }, reasons: ['离线测试用依据'] },
    alternates: [],
    levelText: 'AI 分诊建议',
    levelCls: 'badge-blue',
    levelWindow: '',
    levelAdvice: '建议前往' + dept + '就诊',
    departmentInfo: {},
    navigable: true
  })
  setTimeout(() => {
    const deptCard = ctx.data.messages.filter((m) => m.type === 'dept')[0]
    const navask = ctx.data.messages.filter((m) => m.type === 'navask')[0]
    // 现行结果卡契约：deptName（主推荐）+ alts（备选）——2026-10-20 由 depts[] 数组形态
    // 重构为单主推荐字段（WXML 渲染 item.deptName / item.alts），此处同步更新期望。
    check('[' + text + '] 结果卡推荐 ' + dept,
      !!(deptCard && deptCard.deptName === dept), deptCard ? deptCard.deptName : '无结果卡')
    check('[' + text + '] 结果卡后弹出「要不要带路」追问',
      !!(navask && navask.dept === dept), navask ? navask.dept : '没有 navask')
    if (navask) {
      ctx.onNavaskYes({ currentTarget: { dataset: { dept: navask.dept } } })
      check('[' + text + '] 点「要，带我去」跳院内导航',
        navUrl.indexOf('/packageNav/pages/nav/nav?dept=') >= 0, navUrl)
      // 闭环最后一环：导航页必须认得这个科室（否则点进来是"未找到"）
      const navCtx = mount(navPage)
      navCtx.onLoad({ dept: decodeURIComponent(navUrl.split('dept=')[1]) })
      navCtx.onReady()
      check('[' + text + '] 导航页认得该科室 → ' + expectDest,
        !!(navCtx.data.active && navCtx.data.active.id === expectDest),
        navCtx.data.active ? navCtx.data.active.id : 'null')
    }
    nextCase()
  }, 60)
}

// ==================== ③ 样式守则（防"穿模 + 按钮点不动"回归）====================
/**
 * 去掉 CSS 注释。
 * 为什么必须去掉：本文件用"选择器字样 + [^{]*{"定位规则块，而注释里**可以合法出现**选择器
 * 字样（nav.wxss 顶部就写着「选中目的地后路线弹层（.nv-sheet，占 56vh 下半屏）会盖住…」）。
 * 注释里没有 `{`，正则便会一路吃到后面第一条规则 —— 实测把 `.nv-tools-up` 当成 `.nv-sheet`，
 * 于是"详情区有确定高度 / 裁掉溢出"两条断言拿错块而误报（样式本身是正确的）。
 */
function stripCssComments(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, '')
}

function cssBlock(css, selector) {
  // 注释先剥掉：注释内容不得被当成选择器（见上方说明）
  const src = stripCssComments(css)
  const isAtRule = selector.trim().charAt(0) === '@'
  const pat = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 类/ID 选择器补右边界：`.nv-sheet` 不得命中 `.nv-sheet-h` / `.nv-sheet-ops`
  // @media 例外 —— 条件串（and (min-height:…)）允许出现在选择器与 { 之间
  const re = new RegExp(isAtRule ? pat + '[^{]*\\{' : pat + '(?![\\w-])[^{]*\\{', 'g')
  const m = re.exec(src)
  if (!m) return ''
  let i = m.index + m[0].length
  let depth = 1
  const start = i
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(start, i - 1)
}

/** 解析器自测：注释里的选择器字样不得被当成真实规则（回归用，不依赖 nav.wxss 现状） */
function parserSelfTest() {
  console.log('\n— ③a 解析器自测（注释 ≠ 选择器）—')
  const fake = [
    '/* 选中目的地后路线弹层（.nv-sheet，占 56vh 下半屏）会盖住按钮 */',
    '.nv-tools-up { top: 16rpx; transform: none; }',
    '.nv-sheet-h { display: flex; }',
    '.nv-sheet { height: 56vh; overflow: hidden; }'
  ].join('\n')
  const got = cssBlock(fake, '.nv-sheet')
  check('解析-注释中的 ".nv-sheet" 不被当成规则起点',
    /height\s*:\s*56vh/.test(got) && !/top\s*:\s*16rpx/.test(got),
    got.replace(/\s+/g, ' ').slice(0, 80))
  check('解析-".nv-sheet" 不命中 ".nv-sheet-h"（右边界）',
    !/display\s*:\s*flex/.test(got), got.replace(/\s+/g, ' ').slice(0, 80))
  check('解析-块内容不残留注释',
    got.indexOf('/*') < 0 && got.indexOf('*/') < 0)
}

function styleChecks() {
  parserSelfTest()

  console.log('\n— ③ nav.wxss 样式守则（版式 / 单列口径 / 断点折算）—')
  // 统一在"无注释"文本上解析：避免注释里的选择器字样干扰（见 stripCssComments 说明）
  const css = stripCssComments(fs.readFileSync(path.join(ROOT, 'packageNav', 'pages', 'nav', 'nav.wxss'), 'utf8'))
  const wxml = fs.readFileSync(path.join(ROOT, 'packageNav', 'pages', 'nav', 'nav.wxml'), 'utf8')
  const media = cssBlock(css, '@media (min-width: 600px)')

  // —— 版式：三张卡（信息卡 / 平面图卡 / 路线卡），设计稿 1391×3014 实测 ——
  check('样式-信息卡内边距 30/44rpx（实测）', /padding\s*:\s*30rpx\s+44rpx/.test(cssBlock(css, '.nvi')))
  check('样式-「当前楼层」栏固定 216rpx（不三等分，否则 6 字科室名被省略号截断）',
    /width\s*:\s*216rpx/.test(cssBlock(css, '.nvi-c1')))
  check('样式-「从」栏固定 200rpx', /width\s*:\s*200rpx/.test(cssBlock(css, '.nvi-c2')))
  check('样式-画布舞台有确定高度（656rpx，实测卡高 696rpx）',
    /height\s*:\s*656rpx/.test(cssBlock(css, '.nvm-stage')))
  check('样式-舞台是绝对定位容器（楼层胶囊 / 按钮组才贴得住）',
    /position\s*:\s*relative/.test(cssBlock(css, '.nvm-stage')))
  check('样式-楼层胶囊绝对定位 + 50rpx 高',
    /position\s*:\s*absolute/.test(cssBlock(css, '.nvm-floor')) && /height\s*:\s*50rpx/.test(cssBlock(css, '.nvm-floor')))
  check('样式-浮动按钮组绝对定位 + 圆形 64rpx',
    /position\s*:\s*absolute/.test(cssBlock(css, '.nvm-tools')) && /width\s*:\s*64rpx/.test(cssBlock(css, '.nvm-btn')))
  check('样式-路线卡左右不留内边距（分割线要通栏）', /padding\s*:\s*32rpx\s+0\s+0/.test(cssBlock(css, '.nvr')))
  check('样式-步骤编号 38rpx 圆形', /width\s*:\s*38rpx/.test(cssBlock(css, '.nvr-n')))
  check('样式-语音行 101rpx', /height\s*:\s*101rpx/.test(cssBlock(css, '.nvr-voice')))

  // —— 单列口径：与前八页一致（≥600px 居中 375px 单列）——
  check('样式-宽屏单列 375px 居中（与前八页同口径）', /max-width\s*:\s*375px/.test(cssBlock(media, '.nvpage')),
    cssBlock(media, '.nvpage').replace(/\s+/g, ' ').slice(0, 100))
  check('样式-不再挂 page-shell（本页是单列，不是平板双栏）', !/page-shell/.test(wxml))

  // —— 断点折算：≥600px 段内不得残留 rpx（含 calc 内）——
  check('样式-断点段内无残留 rpx', !/(^|[^-\w])\d+(\.\d+)?rpx/.test(media),
    (media.match(/(^|[^-\w])\d+(\.\d+)?rpx/g) || []).slice(0, 5).join(' '))
  check('样式-calc 内的 rpx 也折成 px（.nvr-t）', /calc\(var\(--font-h2\) \+ 2rpx\)/.test(css) &&
    /calc\(var\(--font-h2\) \+ 1px\)/.test(media))

  // —— 弹层：宽屏下不得横贯整个窗口（.sheet 是 fixed left/right:0）——
  const nvp = cssBlock(media, '.nvp')
  check('样式-弹层宽屏受限宽（不全屏横贯）', /width\s*:\s*375px/.test(nvp) && /left\s*:\s*50%/.test(nvp),
    nvp.replace(/\s+/g, ' ').slice(0, 100))

  // —— 新结构存在性（防止回退到旧的半屏弹层）——
  check('结构-步骤列表与语音播报在路线卡内', /class="nvr-steps"/.test(wxml) && /class="nvr-voice/.test(wxml))
  check('结构-楼层胶囊可展开为 tab（.nvm-floors）', /class="nvm-floors"/.test(wxml))
  check('结构-目的地弹层含搜索框 + 搜索按钮', /class="nvp-search"/.test(wxml) && /class="nvp-search-btn/.test(wxml))
  check('结构-保留 page/theme 根节点', /class="page theme-\{\{theme\}\} nvpage"/.test(wxml))

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  console.log(fail ? 'RESULT: NAV_PAGE_FAIL' : 'RESULT: NAV_PAGE_OK')
  process.exit(fail ? 1 : 0)
}

nextCase()
