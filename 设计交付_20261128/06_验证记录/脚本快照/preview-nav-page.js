/**
 * preview-nav-page.js —— 院内导航页「真实排版」离线预览（改导航页样式后必看）
 *
 * 为什么要有它：导航页的排版问题（详情区溢出压住按钮、底部按钮点不动、平板上 rpx 巨大化导致地图被挤没）
 * 都只在真机上才暴露，而命令行跑不了小程序。
 * 做法：把 app.wxss 的 Token + nav.wxss 按目标宽度把 rpx 换算成 px，
 * 拼成一份浏览器能渲染的 HTML（view/text 用同名自定义标签，盒模型与 flex 规则和真机一致），
 * 再用无头 Chrome 截图 —— 足以验证：**有没有重叠 / 按钮是否在最上层 / 平板布局是否合理**。
 *
 * ⚠️ 它是"同一套盒模型"的等价预览，不是真机渲染的 100% 复刻：
 *    字体度量、小程序原生组件（canvas）、安全区等仍以真机为准。
 *
 * 用法：node tools/preview-nav-page.js [dept] [--keep]
 *   dept 默认「消化内科」；传「皮肤科」可看换层提示条的排版。
 * 产出：tools/_nav_page_tablet.png（1200×1696 平板竖屏）/ tools/_nav_page_phone.png（375×812 手机）
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const NAV = path.join(MP, 'packageNav', 'pages', 'nav')

const DEPT = process.argv[2] && process.argv[2].indexOf('--') !== 0 ? process.argv[2] : '消化内科'
// --empty：模拟"未选目的地"（真机上详情面板是 wx:if，此时渲染平板空状态）。
// 空状态是新增 UI，必须实测它在平板占位、在手机不占位，不能只靠读 CSS。
const SHOW_EMPTY = process.argv.indexOf('--empty') >= 0

const VIEWPORTS = [
  { name: 'tablet', w: 1200, h: 1696, dsf: 1, note: '平板竖屏（OPPO Pad 5 Pro ≈1200pt 宽）' },
  // 横屏平板：宽 ≥900 且高 ≥700 → 同样命中平板断点，但可用高度只有 1200 → 地图/详情会重新分配高度，
  // 必须单独量（这是"平板"与"横屏手机"唯一会混淆的尺寸，用高度把它和 926×428 区分开）
  { name: 'padLandscape', w: 1696, h: 1200, dsf: 1, note: '平板横屏（同一台机器转 90°）' },
  // ⚠️ Chrome 窗口有最小宽度（约 500px），直接 --window-size=375 会得到 512 宽的视口 →
  //    截图就成了"左边 375px 的裁切"，看起来像按钮被切掉（假象）。
  //    正解：窗口给 2 倍尺寸 + --force-device-scale-factor=2 → CSS 视口才是 375×812。
  { name: 'phone', w: 375, h: 812, dsf: 2, note: '手机（iPhone X 档，回归对照）' }
]

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].filter((p) => fs.existsSync(p))[0]

// 窄视口截图会多出"Chrome 最小窗口宽度"的右侧白边 → 有 Pillow 就裁掉（没有也不影响结论）
const PY = ['D:/anaconda3.0/python.exe'].filter((p) => fs.existsSync(p))[0]
function cropPng(file, w, h) {
  if (!PY) return
  try {
    execFileSync(PY, ['-c',
      'from PIL import Image;' +
      'p=r"' + file + '";' +
      'im=Image.open(p);' +
      'im.crop((0,0,' + w + ',' + h + ')).save(p)'
    ], { stdio: 'ignore' })
  } catch (e) { /* 裁不掉就保留白边 */ }
}

/** rpx → px：1rpx = 视口宽 / 750（与小程序规则一致） */
function rpx2px(css, vw) {
  const k = vw / 750
  return String(css).replace(/(\d+(?:\.\d+)?)rpx/g, (m, n) => {
    const v = parseFloat(n) * k
    return (Math.round(v * 100) / 100) + 'px'
  })
}

/** 读取样式：app.wxss 的 page{} Token 落到 .page 上；元素选择器 view/text 直接可用 */
function buildCss(vw) {
  const app = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8')
  const nav = fs.readFileSync(path.join(NAV, 'nav.wxss'), 'utf8')
  const css = rpx2px(app + '\n' + nav, vw).replace(/(^|\n)\s*page\s*\{/g, '$1.page {')
  return css + `
  /* 小程序基础元素语义（浏览器里 view/text 默认 inline，会给错盒模型） */
  view { display: block; box-sizing: border-box; }
  text { display: inline; }
  image, img { display: inline-block; }
  /* scroll-view 在小程序里自带 overflow:hidden（横向卡片条就靠它滚）；
     浏览器不认识这个标签 → 不裁切的话会把 body 撑宽，整页布局跟着跑偏 */
  scroll-view { display: block; overflow: hidden; }
  /* 画布区：真机是 <canvas>（无固有尺寸），mock 用 div+svg 代替 ——
     svg 有 viewBox 固有比例，若不脱离文档流会把整页的 min-content 撑宽（假溢出） */
  .nv-map, .nv-canvas { min-width: 0; }
  .nv-canvas > svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
  .nv-canvas { position: relative; }
  body { margin: 0; overflow-x: hidden; }
  `
}

function buildBody() {
  const MAP = require(path.join(MP, 'packageNav', 'data', 'indoor-map.js'))
  const icons = require(path.join(MP, 'utils', 'icons.js'))
  const dest = MAP.DESTINATIONS.filter((d) => d.name === DEPT)[0] || MAP.DESTINATIONS[0]
  const floorTip = /2F|3F|4F/.test(DEPT) ? '' : ''   // 1F 科室无换层提示；传「皮肤科」时下面单独补
  const isUpper = ['皮肤科', '神经内科', '妇产科', '内分泌科', '眼科', '口腔科'].indexOf(DEPT) >= 0
  const steps = dest.steps

  const cat = MAP.CATEGORIES
  const chips = ['全部'].concat(cat).map((c, i) =>
    `<view class="nv-chip ${i === 0 ? 'nv-chip-on' : ''}">${c}</view>`).join('')

  const cards = MAP.DESTINATIONS.map((d) =>
    `<view class="nv-card ${d.id === dest.id ? 'nv-card-on' : ''}">
       <view class="nv-card-top"><img class="ic-sm" src="${icons[d.icon] || icons.mapPin}" /><view class="nv-card-cat">${d.category}</view></view>
       <view class="nv-card-n">${d.name}</view>
       <view class="nv-card-d">${d.distanceM} 米</view>
     </view>`).join('') + '<view class="nv-strip-pad"></view>'

  const stepItems = steps.map((s, i) => `<view class="nv-step">
      <view class="nv-step-n">${i + 1}</view><view class="nv-step-t">${s}</view></view>`).join('')

  const route = dest.path.map((p, i) => (i ? 'L' : 'M') + (p[0] * 14.4).toFixed(1) + ' ' + (p[1] * 8.6).toFixed(1)).join(' ')

  // page-shell：与真机根节点保持一致（平板用满 1180px，plan 才能贴合画布比例）
  return `<view class="page page-shell theme-standard consult-page nvpage">
  <view class="nv-head">
    <view class="nv-head-main">
      <view class="nv-title"><img class="ic-sm" src="${icons.mapPin}" /> 院内导航</view>
      <view class="nv-sub">${MAP.FLOOR.name} · ${MAP.FLOOR.scaleNote} · 起点 ${MAP.ORIGIN.name}</view>
    </view>
    <view class="nv-zoom">缩放 62%</view>
  </view>

  <view class="nv-map">
    <view class="nv-canvas" style="background-image:url('file:///${MP.replace(/\\/g, '/')}/packageNav/assets/floor1.png');background-size:contain;background-position:center;background-repeat:no-repeat;">
      <svg viewBox="0 0 1440 860" style="width:100%;height:100%">
        <path d="${route}" fill="none" stroke="rgba(22,93,255,.16)" stroke-width="18" stroke-linejoin="round" />
        <path d="${route}" fill="none" stroke="#165DFF" stroke-width="8" stroke-linejoin="round" />
      </svg>
    </view>
    <view class="nv-tools nv-tools-up"><!-- 真机：{{active ? 'nv-tools-up' : ''}}；mock 里详情恒展开，故恒上移 -->
      <view class="nv-tool">缩小</view><view class="nv-tool">放大</view>
      <view class="nv-tool">复位</view><view class="nv-tool nv-tool-main">重播路线</view>
    </view>
  </view>

  <view class="nv-hint"><img class="ic-xs" src="${icons.info}" />路线从医院大门开始 · 拖动查看平面图 · 双指或按钮缩放 · 点圆点（或下方卡片）选目的地</view>

  <view class="nv-filter">${chips}</view>

  <scroll-view class="nv-strip">${cards}</scroll-view>

  <view class="nv-sheet"${SHOW_EMPTY ? ' style="display:none"' : ''}>
    <view class="nv-sheet-h">
      <view class="nv-sheet-t"><img class="ic-sm" src="${icons[dest.icon] || icons.mapPin}" />前往：${dest.name}</view>
      <view class="nv-sheet-x pressable">关闭</view>
    </view>
    <view class="nv-sheet-meta">全程约 ${dest.distanceM} 米 · 共 ${steps.length} 步<text> · ${dest.desc}</text></view>
    ${isUpper ? `<view class="nv-tip nv-tip-floor"><img class="ic-xs" src="${icons.arrowUpRight}" /><text>「${DEPT}」在门诊楼 2F：请先在「挂号 / 缴费」窗口取号，再按下方路线到「电梯厅」，乘电梯上 2 楼后按楼层指示牌找到诊室</text></view>` : ''}
    ${floorTip}
    ${dest.category === '门诊' ? `<view class="nv-tip"><img class="ic-xs" src="${icons.clipboardList}" /><text>到院第一步：先在「挂号 / 缴费」窗口取号，再按下方路线去诊室</text></view>` : ''}
    <scroll-view class="nv-steps">${stepItems}
      <view class="nv-step-end"><img class="ic-sm" src="${icons.checkCircle}" /> 按指引沿蓝色路线行走即可到达</view>
    </scroll-view>
    <view class="nv-sheet-ops">
      <view class="btn btn-outline nv-op"><img class="ic-sm" src="${icons.refresh}" />返回大门</view>
      <view class="btn btn-primary nv-op"><img class="ic-sm" src="${icons.volumeWhite}" />语音播报</view>
    </view>
    <view class="ai-note">院内导航为示意路线，如遇施工或管制请以现场指引为准</view>
  </view>

  ${SHOW_EMPTY ? `<view class="nv-side-empty">
    <img class="ic-lg" src="${icons.mapPin}" />
    <view class="nv-side-empty-t">还没有选择目的地</view>
    <view class="nv-side-empty-d">先从下面的分类挑一类，再点目的地卡片；也可以直接点地图上的圆点。选好后这里会显示全程距离、步数与分步指引。</view>
  </view>` : ''}
</view>`
}

/**
 * ⚠️ 为什么要套一层 iframe：
 * Chrome 命令行窗口有最小宽度（约 512px），`--window-size=375` 实际得到 512 宽的视口 ——
 * 手机档就只能截到"左边 375px 的裁切"，看着像按钮被切掉（假象），媒体查询也会按 512 生效。
 * 所以把页面放进**指定尺寸的 iframe**：iframe 内的视口与媒体查询就是真实目标尺寸。
 * 测量数据由 iframe 通过 postMessage 回传（跨 frame，不受 file:// 同源限制）。
 */
function frameHtml(vp, innerHref) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #FFFFFF; }
  iframe { border: 0; display: block; width: ${vp.w}px; height: ${vp.h}px; }
  #measure { position: absolute; left: -9999px; white-space: pre; font: 12px monospace; }
  </style></head><body>
  <iframe id="vp" src="${innerHref}"></iframe>
  <pre id="measure"></pre>
  <script>
    window.addEventListener('message', function (e) {
      if (typeof e.data === 'string' && e.data.indexOf('MEASURE|') === 0) {
        document.getElementById('measure').textContent = e.data
      }
    })
  </script></body></html>`
}

const BLOCKING = [
  '❗空状态占位不对（平板应≥120 高 / 手机应完全不占位）',
  '❗指引行与按钮行重叠',
  '❗步骤区溢出到按钮行',
  '❗按钮超出视口右边界',
  '❗详情区压住缩放工具',
  '❗缩放工具栏压住平面图',
  '❗地图空白超过 25%（平面图没贴合画布）'
]
// 刻意不纳入终判的两条：手机上详情区是**底部半屏浮层**，压住分类 chips / 目的地条是设计行为
// （面板自带"关闭"按钮），并非缺陷。平板端它们是 static 占位面板，实测恒 false。

function main() {
  if (!CHROME) {
    console.log('未找到 Chrome/Edge，跳过渲染（仅生成 HTML）')
  }
  const outHtml = path.join(__dirname, '_nav_page_preview.html')
  const outFrame = path.join(__dirname, '_nav_frame.html')
  const measure = process.argv.indexOf('--measure') >= 0
  const results = []
  const failures = []
  VIEWPORTS.forEach((vp) => {
    const inner = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=${vp.w}">
<style>${buildCss(vp.w)}</style></head><body>${buildBody()}${MEASURE_SCRIPT}</body></html>`
    fs.writeFileSync(outHtml, inner, 'utf8')
    fs.writeFileSync(outFrame, frameHtml(vp, '_nav_page_preview.html'), 'utf8')
    const outPng = path.join(__dirname, '_nav_page_' + vp.name + '.png')
    // 窗口给 Chrome 的最小值兜底；iframe 内的视口仍是目标尺寸（多出来的白边不影响结论）
    const winW = Math.max(vp.w, 520)
    const winH = Math.max(vp.h, 400)
    if (CHROME && !measure) {
      execFileSync(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
        '--force-device-scale-factor=1',
        '--window-size=' + winW + ',' + winH,
        '--screenshot=' + outPng.replace(/\\/g, '/'),
        'file:///' + outFrame.replace(/\\/g, '/')
      ], { stdio: 'ignore' })
      if (winW > vp.w) cropPng(outPng, vp.w, Math.min(winH, vp.h))
    }
    if (CHROME && measure) {
      const dom = execFileSync(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox',
        '--window-size=' + winW + ',' + winH,
        '--virtual-time-budget=1500',
        '--dump-dom',
        'file:///' + outFrame.replace(/\\/g, '/')
      ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      const m = dom.match(/<pre id="measure">([\s\S]*?)<\/pre>/)
      console.log('\n【' + vp.name + ' ' + vp.w + '×' + vp.h + '】')
      const raw = m ? m[1].replace(/MEASURE\||\|END/g, '') : ''
      console.log(m ? raw.replace(/\|/g, '\n') : '(未取到测量结果)')
      // 终判：阻断项为 true 即失败（此前只打印不判定 → 竖屏掉回 720px 时空白 42% 没人发现）
      raw.split('|').forEach((line) => {
        const key = BLOCKING.filter((k) => line.indexOf(k + ' = ') === 0)[0]
        if (key && /^\s*true\s*$/.test(line.slice((key + ' = ').length))) {
          failures.push('  ✗ ' + vp.name + '：' + key)
        }
      })
    }
    results.push('  ' + vp.name + ' ' + vp.w + '×' + vp.h + '（' + vp.note + '）→ ' + path.relative(ROOT, outPng) + (CHROME ? '' : '（未渲染）'))
  })
  console.log('科室：' + DEPT + (DEPT.indexOf('皮肤') >= 0 ? '（换层提示）' : '（1F 直达）'))
  console.log(results.join('\n'))
  console.log('  HTML → ' + path.relative(ROOT, outHtml) + ' / ' + path.relative(ROOT, outFrame))
  if (measure && CHROME) {
    console.log('============================================================')
    if (failures.length) {
      console.log('实测 ' + VIEWPORTS.length + ' 档，失败 ' + failures.length + ' 项：')
      console.log(failures.join('\n'))
      console.log('RESULT: NAV_PREVIEW_FAIL')
      process.exitCode = 1
    } else {
      console.log('实测 ' + VIEWPORTS.length + ' 档，全部通过')
      console.log('RESULT: NAV_PREVIEW_OK')
    }
  }
}

/** 注入的测量脚本：把关键盒子的几何与"是否重叠"写进 DOM，用 --dump-dom 读出来 */
const MEASURE_SCRIPT = `<script>
(function () {
  var q = function (s) { return document.querySelector(s) }
  var r = function (el) { if (!el) return null; var b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom), r: Math.round(b.right) } }
  var ops = [].slice.call(document.querySelectorAll('.nv-op'))
  var overlap = function (a, b) {
    if (!a || !b) return false
    return !(a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y)
  }
  var end = r(q('.nv-step-end')); var opsRow = r(q('.nv-sheet-ops'))
  var mapBox = r(q('.nv-map'))
  var canvasBox = r(q('.nv-canvas')) || mapBox   // 画布才是平面图真正的可用区（地图卡可能留了工具栏内边距）
  // 地图空白率：平面图是 1440×860（横向），nav.js 的 _fitView() 按 min(vw/baseW, vh/baseH) 缩放并
  // 夹在 [0.45, 1] —— 容器比例不对就会在卡片里留大片空白（平板旧版实测 48%，看着像"地图加载失败"）。
  var letterbox = 'n/a'
  var lbPct = -1
  if (canvasBox) {
    var fit = Math.min(canvasBox.w / 1440, canvasBox.h / 860)
    var scale = Math.max(0.45, Math.min(1, fit))
    var drawn = (1440 * scale) * (860 * scale)
    lbPct = Math.round((1 - drawn / (canvasBox.w * canvasBox.h)) * 100)
    letterbox = lbPct + '%（平面图实绘 ' + Math.round(1440 * scale) + '×' + Math.round(860 * scale) + '）'
  }
  var emp = r(q('.nv-side-empty'))
  var isPad = window.innerWidth >= 900 && window.innerHeight >= 700
  var m = {
    'body scrollWidth / innerWidth': document.body.scrollWidth + ' / ' + window.innerWidth,
    'nvpage': r(q('.nvpage')),
    'nv-map': mapBox,
    'nv-canvas(平面图可用区)': canvasBox,
    '地图空白率': letterbox,
    'nv-side-empty(空状态)': emp,
    '❗空状态占位不对（平板应≥120 高 / 手机应完全不占位）': emp
      ? (isPad ? emp.h < 120 : (emp.h !== 0 || emp.w !== 0))
      : false,
    'nv-tools': r(q('.nv-tools')),
    'nv-filter': r(q('.nv-filter')),
    'nv-strip': r(q('.nv-strip')),
    'nv-sheet': r(q('.nv-sheet')),
    'nv-steps': r(q('.nv-steps')),
    'nv-step-end(指引行)': end,
    'nv-sheet-ops(按钮行)': opsRow,
    'btn1': r(ops[0]), 'btn2': r(ops[1]),
    '❗指引行与按钮行重叠': overlap(end, opsRow),
    '❗步骤区溢出到按钮行': !!(end && opsRow && end.b > opsRow.y),
    '❗按钮超出视口右边界': !!(ops[1] && ops[1].r > window.innerWidth - 1),
    '❗详情区压住分类chips': overlap(r(q('.nv-sheet')), r(q('.nv-filter'))),
    '❗详情区压住目的地条': overlap(r(q('.nv-sheet')), r(q('.nv-strip'))),
    '❗详情区压住缩放工具': overlap(r(q('.nv-sheet')), r(q('.nv-tools'))),
    // 平面图铺满画布后，底部工具栏会压住图下沿的标注（实测"医院大门"被盖掉一半）。
    // 手机端平面图被 0.45 下限放大后是"裁切"显示、图不铺到底，工具栏本来就压在空白上 → 只在平板判定。
    '❗缩放工具栏压住平面图': isPad && overlap(canvasBox, r(q('.nv-tools'))),
    // 平板专属：平面图必须贴合画布（阈值 25%）。手机档 scale 被 0.45 下限抬到"铺满"，
    // 空白率是负数、不适用，所以只在平板档判定。
    '❗地图空白超过 25%（平面图没贴合画布）': lbPct > 25 && window.innerWidth >= 900 && window.innerHeight >= 700
  }
  var out = []
  for (var k in m) out.push(k + ' = ' + JSON.stringify(m[k]))
  var msg = 'MEASURE|' + out.join('|') + '|END'
  var pre = document.createElement('pre')
  pre.id = 'measure'
  pre.textContent = msg
  document.body.appendChild(pre)
  try { parent.postMessage(msg, '*') } catch (e) {}
})()
</script>`;

main()
