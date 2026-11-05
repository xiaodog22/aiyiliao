/**
 * tools/preview-pad-pages.js —— 平板双栏页面的**真实排版离线预览 + 盒模型实测**
 *
 * 为什么要有它：这轮把「首页 / AI 问诊 / 预约挂号 / 医生工作台」从手机单列改成了
 * ≥900px 的双栏（.page-shell / .shell-cols / .shell-main / .shell-side 见 app.wxss）。
 * 双栏最容易踩的三个坑，肉眼在编辑器里看不出来，必须用真实排版量：
 *   ① 没并排（flex 链断了 / align-items 拖成上下两行）；
 *   ② 主栏不肯收缩（min-width:0 忘了写）→ 侧栏被挤出视口 → body 横向溢出；
 *   ③ 手机端回归（.side-only 没隐藏 / 容器被误改成 flex）→ 手机上多出一块空面板。
 *
 * 做法（与 tools/preview-nav-page.js 同源）：
 *   把 app.wxss + 该页 wxss 按目标宽度把 rpx 换算成 px（1rpx = 视口宽/750，与小程序一致），
 *   用等价的 HTML 骨架承载真实 class 结构，塞进**指定尺寸的 iframe**
 *   （⚠️ Chrome 命令行窗口有最小宽度约 512px，直接 --window-size=1200 之外的窄档会得到假视口，
 *    媒体查询也会按错误宽度生效），再用 Chrome 无头 --dump-dom 把盒模型读回来。
 *
 * 用法：
 *   node tools/preview-pad-pages.js            生成 HTML + 三个视口截图
 *   node tools/preview-pad-pages.js --measure  只做盒模型实测（不截图）
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')

// Chrome 路径探测（与 preview-nav-page.js 保持一致）
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter((p) => fs.existsSync(p))[0]

// 目标视口（OPPO Pad 5 Pro 13.2" 横/竖各一档 + 手机回归 + 横屏手机）
// ⚠️ 双栏是**横屏专属**：竖屏平板必须单列，否则内容只占上半屏、下半屏大片留白。
const VIEWPORTS = [
  { name: 'padLandscape', w: 1696, h: 1200, note: '13.2 寸平板横屏（宽>高）→ 应双栏' },
  { name: 'padPortrait', w: 1200, h: 1696, note: '同机竖屏（高>宽）→ 应单列（双栏为横屏专属）' },
  { name: 'phone', w: 375, h: 812, note: '手机 → 应单列、侧栏不占位' },
  { name: 'landscapePhone', w: 926, h: 428, note: '横屏手机（宽 ≥900 但高 <700）→ 应单列' }
]

/** 页面清单：wxss 路径 + HTML 骨架 + 只在该页需要的额外断言 */
const PAGES = [
  {
    id: 'home',
    label: '首页 Dashboard',
    wxss: ['pages/home/home.wxss'],
    body: homeBody,
    side: '.shell-side',
    // 首页侧栏（我的预约 / 院内导航）是真实内容：手机端要排到主内容之后，必须可见
    sideOnPhone: true
  },
  {
    id: 'consultation',
    label: 'AI 问诊（左对话 / 右就医助手）',
    wxss: ['pages/consultation/consultation.wxss'],
    body: consultationBody,
    side: '.consult-side',
    // 问诊页侧栏装的是"就医进度卡"：手机端它必须排在最前（在对话上方），必须可见
    sideOnPhone: true
  },
  {
    id: 'appointment',
    label: '预约挂号（左选择 / 右摘要）',
    wxss: ['pages/appointment/appointment.wxss'],
    body: appointmentBody,
    side: '.shell-side',
    // 摘要卡是平板的"额外信息"：手机端单列已能看全，用 .side-only 隐藏（不占位）
    sideOnPhone: false
  },
  {
    id: 'workbench',
    label: '医生工作台 Dashboard',
    wxss: ['pages/doctor/workbench/workbench.wxss'],
    body: workbenchBody,
    side: '.shell-side',
    // 手机端这三个动作由右下角 FAB 承担，侧栏隐藏
    sideOnPhone: false
  }
]

/** rpx → px：1rpx = 视口宽 / 750（与小程序规则一致） */
function rpx2px(css, vw) {
  const k = vw / 750
  return String(css).replace(/(\d+(?:\.\d+)?)rpx/g, (m, n) => {
    const v = parseFloat(n) * k
    return (Math.round(v * 100) / 100) + 'px'
  })
}

function buildCss(vw, page) {
  const app = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8')
  const pageCss = page.wxss
    .map((p) => fs.readFileSync(path.join(MP, p), 'utf8'))
    .join('\n')
  const css = rpx2px(app + '\n' + pageCss, vw).replace(/(^|\n)\s*page\s*\{/g, '$1.page {')
  return css + `
  /* 小程序基础元素语义（浏览器里 view/text 默认 inline，会给错盒模型） */
  view { display: block; box-sizing: border-box; }
  text { display: inline; }
  image, img { display: inline-block; }
  scroll-view { display: block; overflow: hidden; }
  body { margin: 0; overflow-x: hidden; }
  /* 占位图标：真机是 PNG（有固有尺寸），这里用同尺寸灰块代替，避免 naturalWidth=0 影响布局 */
  img { background: #DDE3EC; }
  `
}

// ==================== 各页 HTML 骨架（真实 class，内容取演示值） ====================
function homeBody() {
  // 四宫格：图标是重着色 PNG（icons.js 的键 → assets/icons 文件名）
  const quads = [
    ['hm-tile-blue', 'chat.png', 'AI 智能问诊', '描述症状·智能分析'],
    ['hm-tile-green', 'calendar_green.png', '预约挂号', '科室医生·一键预约'],
    ['hm-tile-amber', 'leaf_amber.png', 'AI 养生', '个性方案·健康生活'],
    ['hm-tile-purple', 'fileText_purple.png', '报告查询', '检验检查·一键查看']
  ]
  // 常用服务 8 格：图标是素材图（自带浅蓝圆底）→ [文件名键, 文案]
  const svcs = [
    ['triage', '智能导诊'], ['doctor', '找医生'],
    ['dept', '找科室'], ['archive', '健康档案'],
    ['checkup', '体检服务'], ['care', '居家护理'],
    ['advice', '健康咨询'], ['more', '更多服务']
  ]
  return `
<view class="page theme-standard page-shell home">
  <view class="shell-cols">
    <view class="shell-main">
      <view class="hm-hero">
        <view class="hm-brand">
          <view class="hm-logo"><img class="hm-logo-ic" /></view>
          <view class="hm-brand-text">
            <view class="hm-brand-name">AI 健康助手</view>
            <view class="hm-brand-slogan">让就医更简单</view>
          </view>
        </view>
        <view class="hm-ai pressable">
          <view class="hm-ai-tag"><text>有问题</text><text>问小安</text></view>
          <img class="hm-ai-arrow" />
          <view class="hm-ai-face"><img class="hm-ai-face-img" src="../miniprogram/assets/home/ai-doctor.png" /></view>
        </view>
        <view class="hm-greet">张三，您好！</view>
        <view class="hm-sub">今天身体有什么不舒服吗？</view>
        <view class="hm-ask pressable">
          <view class="hm-ask-mic"><img class="hm-ask-mic-ic" /></view>
          <view class="hm-ask-ph">请用一句话描述您的症状...</view>
          <view class="hm-ask-send"><img class="hm-ask-send-ic" /></view>
        </view>
        <scroll-view class="hm-quick"><view class="hm-quick-in">
          <view class="hm-chip pressable">胃疼反酸一周了</view>
          <view class="hm-chip pressable">咳嗽有痰三天</view>
          <view class="hm-chip pressable">头晕乏力</view>
          <view class="hm-chip pressable">睡眠不好</view>
        </view></scroll-view>
      </view>

      <view class="hm-quad">
        ${quads.map(([tint, ic, title, desc]) => `<view class="hm-quad-card pressable"><view class="hm-tile ${tint}"><img class="hm-tile-ic" src="../miniprogram/assets/icons/${ic}" /></view><view class="hm-quad-title">${title}</view><view class="hm-quad-desc">${desc}</view></view>`).join('')}
      </view>

      <view class="hm-banner pressable">
        <img class="hm-banner-art" src="../miniprogram/assets/home/banner-hospital.jpg" style="object-fit:cover" />
        <view class="hm-banner-main">
          <view class="hm-banner-title">智能导诊 · 精准就医</view>
          <view class="hm-banner-desc">AI 帮您找到合适的科室和医生</view>
          <view class="hm-banner-btn"><text class="hm-banner-btn-t">立即体验</text><img class="hm-banner-btn-ic" /></view>
        </view>
        <view class="hm-banner-note"><text>更懂你的</text><text>健康助手</text><view class="hm-banner-note-arc"></view></view>
      </view>

      <view class="card hm-svc">
        <view class="hm-svc-head"><view class="hm-svc-title">常用服务</view><view class="hm-svc-more pressable"><text>全部服务</text><img class="hm-svc-more-ic" /></view></view>
        <view class="hm-svc-grid">
          ${svcs.map(([k, name]) => `<view class="hm-svc-item pressable"><img class="hm-svc-ic" src="../miniprogram/assets/home/svc-${k}.png" /><view class="hm-svc-name">${name}</view></view>`).join('')}
        </view>
      </view>

      <view class="card hm-tip">
        <view class="hm-tip-head"><view class="hm-tip-title">健康小贴士</view><view class="hm-tip-refresh pressable"><text>换一条</text><img class="hm-tip-refresh-ic" /></view></view>
        <view class="hm-tip-body pressable">
          <view class="hm-tile hm-tile-blue"><img class="hm-tile-ic" /></view>
          <view class="hm-tip-text">
            <view class="hm-tip-t">高血压患者的一天：这 5 个时间点要留意</view>
            <view class="hm-tip-s">血压不是一整天都一样的。管好起床、吃药、吃饭、运动、睡前这 5 个节点，比单纯加药更有效。</view>
          </view>
        </view>
      </view>
    </view>

    <view class="shell-side">
      <view class="section-header"><img class="ic-sm" /> 我的预约动态</view>
      <view class="card apt-card pressable">
        <view class="apt-row">
          <view class="apt-left">
            <view class="apt-dept">呼吸内科 · 张主任</view>
            <view class="apt-line2">2026-09-16 09:30</view>
            <view class="apt-line3">门诊楼（以医院通知为准）</view>
          </view>
          <view class="apt-right"><view class="info-capsule badge-green">待就诊</view><img class="apt-arrow" /></view>
        </view>
      </view>
      <view class="section-header"><img class="ic-sm" /> 健康提示（短视频）</view>
      <scroll-view class="kb-strip"><view class="kb-strip-in">
        <view class="kb-item pressable"><view class="kb-badge"><img class="kb-badge-ic" /><view class="kb-corner"><img class="kb-corner-ic" /></view></view><view class="kb-title">七步洗手法</view><view class="kb-dur">提示视频 · 11 秒</view></view>
        <view class="kb-item pressable"><view class="kb-badge"><img class="kb-badge-ic" /><view class="kb-corner"><img class="kb-corner-ic" /></view></view><view class="kb-title">在家量血压 4 个要点</view><view class="kb-dur">提示视频 · 11 秒</view></view>
        <view class="kb-item pressable"><view class="kb-badge"><img class="kb-badge-ic" /><view class="kb-corner"><img class="kb-corner-ic" /></view></view><view class="kb-title">起床三步曲（防跌倒）</view><view class="kb-dur">提示视频 · 11 秒</view></view>
      </view></scroll-view>
      <view class="card triage-card pressable">
        <view class="icon-badge icon-badge-teal triage-icon"><img class="ic-md" /></view>
        <view class="triage-body">
          <view class="triage-title">院内导航（电子平面图）</view>
          <view class="card-sub">从医院大门出发 · 路线指引 · 可语音播报</view>
        </view>
        <img class="triage-arrow" />
      </view>
      <view class="card triage-card pressable">
        <view class="icon-badge icon-badge-blue triage-icon"><img class="ic-md" /></view>
        <view class="triage-body">
          <view class="triage-title">全部健康科普</view>
          <view class="card-sub">慢病管理 · 用药安全 · 老年照护 · 就医指导</view>
        </view>
        <img class="triage-arrow" />
      </view>
    </view>
  </view>
</view>`
}

function consultationBody() {
  const bubbles = `
        <view class="msg msg-ai msg-in"><view class="msg-bubble bubble-ai"><text>您好，我是 AI 导诊助手。请用一句话描述您的不适（例如"胃疼反酸一周了"），我会直接为您推荐就诊科室。</text></view><view class="msg-time">14:20</view></view>
        <view class="msg msg-user msg-in"><view class="msg-bubble bubble-user"><text>胃疼反酸一周了</text></view><view class="msg-time">14:21</view></view>
        <view class="msg msg-ai msg-in">
          <view class="dept-card">
            <view class="dept-level-row"><view class="badge badge-amber">建议尽快就诊</view><text class="dept-window">2 天内</text></view>
            <view class="dept-intro">已根据您的描述完成分诊，推荐就诊科室如下：</view>
            <view class="dept-row">
              <view class="dept-icon"><img class="ic-md" /></view>
              <view class="dept-info"><view class="dept-name">消化内科</view><view class="dept-desc">匹配度：较高 · 1F · 诊治胃肠疾病</view></view>
              <view class="dept-book">挂号</view>
            </view>
            <view class="dept-basis"><view class="dept-basis-t">判断依据</view><view class="dept-basis-i">· 您提到了「胃」</view><view class="dept-basis-i">· 持续一周的胃疼反酸</view></view>
            <view class="dept-advice">建议 2 天内到消化内科就诊，必要时做胃镜。</view>
            <view class="ai-foot"><text class="ai-disclaimer">· 内容由AI大模型生成，仅供参考</text></view>
          </view>
          <view class="msg-time">14:21</view>
        </view>
        <view class="msg msg-ai msg-in">
          <view class="navask-card">
            <view class="navask-q"><img class="ic-sm" />需要我告诉您去「消化内科」怎么走吗？</view>
            <view class="navask-ops"><view class="navask-op navask-op-main">要，带我去</view><view class="navask-op">不用了</view></view>
          </view>
        </view>`
  return `
<view class="page theme-standard consult-page page-shell">
  <view class="nav-bar" style="padding-top: 28px;">
    <view class="nav-left"><text class="nav-brand">AI 问诊</text></view>
    <view class="nav-tabs"><view class="nav-tab nav-tab-on">对话</view><view class="nav-tab">我的</view></view>
    <view class="nav-right"><view class="nav-clear">清空</view></view>
  </view>
  <view class="shell-cols consult-cols">
    <view class="shell-side consult-side">
      <view class="flow-zone">
        <view class="flow-card">
          <view class="flow-main">
            <view class="flow-info"><view class="flow-title">AI 助手陪您全流程就医</view><view class="flow-sub">呼吸内科门诊 | 您好！您的预约已确认，请按时到院取号</view></view>
            <img class="flow-doc" />
          </view>
          <view class="flow-steps">
            <view class="flow-step"><view class="flow-dot flow-dot-on"><img class="flow-check" /></view><view class="flow-line flow-line-on"></view></view>
            <view class="flow-step"><view class="flow-dot flow-dot-on flow-dot-cur"><text class="flow-dot-num">2</text></view><view class="flow-line"></view></view>
            <view class="flow-step"><view class="flow-dot"><text class="flow-dot-num">3</text></view><view class="flow-line"></view></view>
            <view class="flow-step"><view class="flow-dot"><text class="flow-dot-num">4</text></view></view>
          </view>
          <view class="flow-labels"><text class="flow-label flow-label-on">预约</text><text class="flow-label flow-label-on">待取号</text><text class="flow-label">待就诊</text><text class="flow-label">就诊</text></view>
          <view class="flow-detail-btn">就医详情</view>
        </view>
      </view>
      <view class="side-only consult-helper">
        <view class="helper-head">最近一次分诊</view>
        <view class="helper-dept">消化内科</view>
        <view class="helper-tags"><view class="badge badge-amber">建议尽快就诊</view><view class="helper-conf">匹配度：较高</view></view>
        <view class="helper-advice">建议 2 天内到消化内科就诊，必要时做胃镜。</view>
        <view class="helper-ops"><view class="helper-op">预约挂号</view><view class="helper-op helper-op-ghost">院内导航</view></view>
      </view>
    </view>
    <view class="shell-main consult-main">
      <scroll-view class="body-scroll">
        <view class="user-strip">
          <view class="user-avatar"><img class="ic-sm" /></view>
          <view class="user-strip-info"><view class="user-strip-name">张*</view><view class="user-strip-id">ID: 138********0001</view></view>
          <view class="user-switch">切换 ›</view>
        </view>
        <view class="chat-list">${bubbles}<view id="bottom-anchor" class="anchor"></view></view>
      </scroll-view>
      <view class="ai-note">AI 建议仅供参考，不能替代线下医师诊断</view>
      <view class="quick-services">
        <view class="qs-item"><img class="ic-xs" /> 预约挂号</view>
        <view class="qs-item"><img class="ic-xs" /> 报告查询</view>
        <view class="qs-item"><img class="ic-xs" /> 来院导航</view>
        <view class="qs-item"><img class="ic-xs" /> 全部服务</view>
      </view>
      <view class="input-bar safe-bottom">
        <view class="voice-btn"><img class="ic-md" /></view>
        <input class="input-field" placeholder="请用一句话描述您的不适，我直接为您推荐科室" />
        <view class="send-fab"><img class="send-icon" /></view>
      </view>
    </view>
  </view>
</view>`
}

function appointmentBody() {
  // 2026-10-17 版式改版：步骤条改圆点+连线、科室改 2 列图标卡、医生改横向行卡
  return `
<view class="page theme-standard page-shell">
  <view class="steps">
    <view class="step step-done"><view class="step-dot"><text class="step-num">1</text></view><view class="step-label">选科室</view><view class="step-line step-line-on"></view></view>
    <view class="step step-on"><view class="step-dot"><text class="step-num">2</text></view><view class="step-label">选医生</view><view class="step-line"></view></view>
    <view class="step"><view class="step-dot"><text class="step-num">3</text></view><view class="step-label">选时段</view><view class="step-line"></view></view>
    <view class="step"><view class="step-dot"><text class="step-num">4</text></view><view class="step-label">确认</view></view>
  </view>
  <view class="shell-cols">
    <view class="shell-main">
      <view class="card-title">选择科室</view>
      <view class="pick-grid">
        <view class="dept-card dept-on"><view class="tile tile-blue"><img class="tile-ic" src="../miniprogram/assets/icons/stethoscope.png" /></view><view class="dept-name">呼吸内科</view><view class="dept-sub">2 位医生</view></view>
        <view class="dept-card"><view class="tile tile-pink"><img class="tile-ic" src="../miniprogram/assets/icons/heartbeat.png" /></view><view class="dept-name">心血管内科</view><view class="dept-sub">1 位医生</view></view>
        <view class="dept-card"><view class="tile tile-mint"><img class="tile-ic" src="../miniprogram/assets/icons/pill.png" /></view><view class="dept-name">消化内科</view><view class="dept-sub">1 位医生</view></view>
        <view class="dept-card"><view class="tile tile-amber"><img class="tile-ic" src="../miniprogram/assets/icons/activity.png" /></view><view class="dept-name">骨科</view><view class="dept-sub">1 位医生</view></view>
      </view>
      <view class="card-title">选择医生（消化内科）</view>
      <view class="doc-list">
        <view class="doc-card doc-on">
          <view class="tile tile-blue doc-face"><img class="tile-ic" src="../miniprogram/assets/icons/stethoscope.png" /></view>
          <view class="doc-main"><view class="doc-name">刘副主任医师<text class="doc-title">副主任医师</text></view><view class="doc-tag">胃肠疾病、肝病</view></view>
          <view class="doc-side"><img class="rating-star" src="../miniprogram/assets/icons/star.png" /><text class="doc-rating">4.7</text></view>
        </view>
        <view class="doc-card">
          <view class="tile tile-blue doc-face"><img class="tile-ic" src="../miniprogram/assets/icons/stethoscope.png" /></view>
          <view class="doc-main"><view class="doc-name">陈主任医师<text class="doc-title">主任医师</text></view><view class="doc-tag">消化道早癌筛查、内镜治疗</view></view>
          <view class="doc-side"><img class="rating-star" src="../miniprogram/assets/icons/star.png" /><text class="doc-rating">4.9</text></view>
        </view>
      </view>
      <view class="card-title">选择日期</view>
      <view class="date-row">
        <view class="date-item"><view class="date-label">今天</view><view class="date-value">2026-09-15</view></view>
        <view class="date-item date-on"><view class="date-label">明天</view><view class="date-value">2026-09-16</view></view>
        <view class="date-item"><view class="date-label">后天</view><view class="date-value">2026-09-17</view></view>
      </view>
      <view class="card-title">选择时间</view>
      <view class="slot-grid">
        <view class="slot">08:00</view><view class="slot slot-on">08:30</view><view class="slot">09:00</view><view class="slot">09:30</view>
        <view class="slot">10:00</view><view class="slot">10:30</view><view class="slot">14:00</view><view class="slot">14:30</view>
      </view>
      <view class="btn btn-primary act-btn">下一步：确认挂号</view>
    </view>
    <view class="shell-side side-only sum-card">
      <view class="sum-head">当前预约</view>
      <view class="sum-row"><text class="sum-k">科室</text><text class="sum-v">呼吸内科</text></view>
      <view class="sum-row"><text class="sum-k">医生</text><text class="sum-v">张主任</text></view>
      <view class="sum-row"><text class="sum-k">日期</text><text class="sum-v">2026-09-16</text></view>
      <view class="sum-row"><text class="sum-k">时间</text><text class="sum-v">08:30</text></view>
      <view class="sum-row"><text class="sum-k">就诊人</text><text class="sum-v">张三</text></view>
      <view class="btn btn-primary sum-btn">下一步：确认挂号</view>
    </view>
  </view>
</view>`
}

function workbenchBody() {
  return `
<view class="wb-page theme-standard page-shell">
  <view class="wb-hero grad-hero">
    <view class="wb-hero-title">医生工作台</view>
    <view class="wb-hero-doctor">王医生 · 呼吸内科 · 男</view>
  </view>
  <view class="shell-cols">
    <view class="shell-main">
      <view class="wb-overview">
        <view class="ov-item"><view class="ov-num ov-amber">78</view><view class="ov-label">待就诊</view></view>
        <view class="ov-item"><view class="ov-num ov-blue">9</view><view class="ov-label">就诊中</view></view>
        <view class="ov-item"><view class="ov-num ov-slate">4</view><view class="ov-label">已完成</view></view>
      </view>
      <view class="wb-section-title">功能面板</view>
      <view class="panel-grid">
        <view class="panel-item pressable"><view class="panel-icon icon-badge icon-badge-blue"><img class="ic-md" /></view><view class="panel-name">挂号管理</view><view class="panel-desc">预约列表 · 叫号处理</view></view>
        <view class="panel-item pressable"><view class="panel-icon icon-badge icon-badge-teal"><img class="ic-md" /></view><view class="panel-name">床位管理</view><view class="panel-desc">床位分配 · 占用总览</view></view>
        <view class="panel-item pressable"><view class="panel-icon icon-badge icon-badge-amber"><img class="ic-md" /></view><view class="panel-name">智能电视大屏</view><view class="panel-desc">病房概览 · 紧急呼叫</view></view>
        <view class="panel-item pressable"><view class="panel-icon icon-badge icon-badge-gray"><img class="ic-md" /></view><view class="panel-name">个人管理</view><view class="panel-desc">资料 · 排班 · 账号安全</view></view>
      </view>
      <view class="btn btn-ghost logout-btn pressable">退出登录</view>
    </view>
    <view class="shell-side side-only">
      <view class="wb-section-title">快捷操作</view>
      <view class="quick-card">
        <view class="quick-item pressable"><view class="quick-dot"></view>新建病历</view>
        <view class="quick-item pressable"><view class="quick-dot"></view>开检查单</view>
        <view class="quick-item pressable"><view class="quick-dot quick-dot-red"></view>紧急入院登记</view>
      </view>
      <view class="wb-side-hint">快捷操作当前为演示占位，接入后端后开放完整操作。</view>
    </view>
  </view>
</view>`
}

// ==================== 测量 ====================
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

const MEASURE_SCRIPT = (sideSel) => `<script>
(function () {
  var q = function (s) { return document.querySelector(s) }
  var r = function (el) { if (!el) return null; var b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom), r: Math.round(b.right) } }
  var overlap = function (a, b) {
    if (!a || !b) return false
    return !(a.r <= b.x || b.r <= a.x || a.b <= b.y || b.b <= a.y)
  }
  var main = q('.shell-main')
  var side = q('${sideSel}')
  var mainR = r(main)
  var sideR = r(side)
  var sideVisible = side ? (getComputedStyle(side).display !== 'none' && side.getBoundingClientRect().width > 0) : false
  var cols = q('.shell-cols')
  var m = {
    '视口': window.innerWidth + '×' + window.innerHeight,
    'body scrollWidth / innerWidth': document.body.scrollWidth + ' / ' + window.innerWidth,
    '.shell-cols display': cols ? getComputedStyle(cols).display : '(无)',
    '.shell-cols flex-direction': cols ? getComputedStyle(cols).flexDirection : '(无)',
    '主栏 .shell-main': mainR,
    '侧栏': sideR,
    '侧栏可见': sideVisible,
    '❗横向溢出': document.body.scrollWidth > window.innerWidth,
    // 底部留白：内容总高不足视口高时，多出来的那一截就是"空在那里"的留白。
    // 这是"平板适配留白太多"的直接量化口径（竖屏最容易命中：屏幕很高、内容只占上半屏）。
    '❗底部留白': (function () {
      var pad = Math.max(0, window.innerHeight - document.body.scrollHeight)
      return pad + 'px (' + Math.round(pad * 100 / window.innerHeight) + '%)'
    })(),
    // ⚠️ 必须传矩形对象（r(...)），传 DOM 元素会让所有比较变成 undefined<=undefined → 恒判"重叠"
    '❗主栏侧栏重叠': overlap(mainR, sideR),
    // 双栏在竖屏下的副作用量化：侧栏卡少、屏幕高 → 侧栏底边到视口底那一截纯空。
    '侧栏底到视口底': sideR ? Math.max(0, window.innerHeight - sideR.b) + 'px' : '(无侧栏)',
    '主栏宽度占比': mainR ? Math.round(mainR.w * 100 / window.innerWidth) + '%' : '(无)',
    '❗主栏内容被挤出右侧': !!(mainR && mainR.r > window.innerWidth + 1),
    // 首页专属断言（其它页返回「(非首页)」，不参与判定）：
    //   ① 四宫格 **2 行 × 2 列**（2026-10 改版口径；旧版是一行 4 个，见 DEV_LOG 2026-10-25）
    //      —— 判据取卡片 top 去重数，掉成 1 行或 3 行都算偏离；
    //   ② 常用服务必须一行 4 个 —— width:25% 不配 box-sizing:border-box 会挤成 3 个；
    //   ③ 问候语不能被右侧小安压住 —— 小安是绝对定位，靠 --h-ai-reserve 留位，漏了就会压字。
    '首页四宫格行数': (function () {
      var cards = document.querySelectorAll('.hm-quad-card')
      if (!cards.length) return '(非首页)'
      var tops = {}
      for (var i = 0; i < cards.length; i++) tops[Math.round(cards[i].getBoundingClientRect().top)] = 1
      return Object.keys(tops).length
    })(),
    '首页常用服务每行个数': (function () {
      var items = document.querySelectorAll('.hm-svc-item')
      if (!items.length) return '(非首页)'
      var top0 = Math.round(items[0].getBoundingClientRect().top)
      var n = 0
      for (var j = 0; j < items.length; j++) if (Math.round(items[j].getBoundingClientRect().top) === top0) n++
      return n
    })(),
    '❗问候语被小安压住': overlap(r(q('.hm-greet')), r(q('.hm-ai'))),
    //   ④ banner 构图（2026-10 改版基线，取代旧「贴右下角满高出血 ≥0.95」）：
    //      现版式 = 左侧文案区 + 右侧内嵌插画（浅蓝卡底），因此只保证三条不变量：
    //        · 插画高占卡片 0.50~0.90（低于 0.5 → 缩成缩略图；高于 0.9 → 变回出血版式）
    //        · 插画不得压住左侧文案区（这两块是并列的，压住即排版事故）
    //        · 插画不得溢出卡片右/下边
    '首页banner插画占卡片高比': (function () {
      var c = r(q('.hm-banner')), a = r(q('.hm-banner-art'))
      if (!c || !a || !c.h) return '(非首页)'
      return Math.round(a.h / c.h * 100) / 100
    })(),
    '❗banner插画压住文案': (function () {
      var m = r(q('.hm-banner-main')), a = r(q('.hm-banner-art'))
      if (!m || !a) return '(非首页)'
      return overlap(m, a)
    })(),
    '❗banner插画溢出卡片': (function () {
      var c = r(q('.hm-banner')), a = r(q('.hm-banner-art'))
      if (!c || !a) return '(非首页)'
      return (a.r > c.r + 1 || a.b > c.b + 1)
    })()
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
</script>`

function main() {
  const measure = process.argv.indexOf('--measure') >= 0
  if (!CHROME) console.log('未找到 Chrome/Edge，仅生成 HTML（不渲染、不测量）')
  const allReport = []

  PAGES.forEach((page) => {
    console.log('\n================ ' + page.label + ' ================')
    VIEWPORTS.forEach((vp) => {
      const innerHref = '_pad_' + page.id + '.html'
      const outHtml = path.join(__dirname, innerHref)
      const outFrame = path.join(__dirname, '_pad_' + page.id + '_frame.html')
      const inner = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=${vp.w}">
<style>${buildCss(vp.w, page)}</style></head><body>${page.body()}${MEASURE_SCRIPT(page.side)}</body></html>`
      fs.writeFileSync(outHtml, inner, 'utf8')
      fs.writeFileSync(outFrame, frameHtml(vp, innerHref), 'utf8')

      const winW = Math.max(vp.w, 520)
      const winH = Math.max(vp.h, 400)
      const outPng = path.join(__dirname, '_pad_' + page.id + '_' + vp.name + '.png')

      if (CHROME && !measure) {
        try {
          execFileSync(CHROME, [
            '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
            '--force-device-scale-factor=1',
            '--window-size=' + winW + ',' + winH,
            '--screenshot=' + outPng.replace(/\\/g, '/'),
            'file:///' + outFrame.replace(/\\/g, '/')
          ], { stdio: 'ignore' })
        } catch (e) { console.log('  截图失败：' + (e && e.message)) }
      }

      if (CHROME) {
        let dom = ''
        try {
          dom = execFileSync(CHROME, [
            '--headless=new', '--disable-gpu', '--no-sandbox',
            '--window-size=' + winW + ',' + winH,
            '--virtual-time-budget=1200',
            '--dump-dom',
            'file:///' + outFrame.replace(/\\/g, '/')
          ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        } catch (e) { /* 取不到就只报"未取到" */ }
        const mm = dom.match(/<pre id="measure">([\s\S]*?)<\/pre>/)
        const lines = mm ? mm[1].replace(/MEASURE\||\|END/g, '').split('|') : []
        console.log('\n【' + page.id + ' · ' + vp.name + ' ' + vp.w + '×' + vp.h + '（' + vp.note + '）】')
        if (!lines.length) { console.log('  (未取到测量结果)') } else {
          // ⚠️ 字符串值经 JSON.stringify 带引号（"row"），比对前必须剥掉
          const get = (k) => {
            const l = lines.filter((x) => x.indexOf(k + ' = ') === 0)[0] || ''
            return l.replace(k + ' = ', '').replace(/^"|"$/g, '')
          }
          // 双栏生效条件与 CSS 断点逐字对齐：宽 ≥900 且 高 ≥700 且 **横屏**
          const isPad = vp.w >= 900 && vp.h >= 700 && vp.w > vp.h
          const sideVisible = get('侧栏可见') === 'true'
          const flex = get('.shell-cols display') === 'flex'
          const row = flex && get('.shell-cols flex-direction') === 'row'
          const overflow = get('❗横向溢出') === 'true'
          const overlap = get('❗主栏侧栏重叠') === 'true'
          lines.forEach((l) => console.log('  ' + l))
          // 判定：平板 → 必须双栏（侧栏在右、并排、不溢出、不重叠）；
          //      非平板 → 必须单列；侧栏是否可见按页面契约（手机也有内容的页面为 true）
          const okPad = sideVisible && row && !overflow && !overlap
          const okPhone = !row && !overflow && sideVisible === page.sideOnPhone
          // 首页额外契约（2026-10 改版基线）：四宫格 2 行、常用服务一行 4 个、
          // 问候语不被小安压住、banner 插画高比 0.5~0.9 且不压文案、不溢出卡片。
          const quadRows = get('首页四宫格行数')
          const svcPerRow = get('首页常用服务每行个数')
          const greetHit = get('❗问候语被小安压住') === 'true'
          const banH = parseFloat(get('首页banner插画占卡片高比'))
          const banHitText = get('❗banner插画压住文案') === 'true'
          const banSpill = get('❗banner插画溢出卡片') === 'true'
          const banOk = page.id !== 'home'
            ? true
            : (banH >= 0.5 && banH <= 0.9 && !banHitText && !banSpill)
          const okHome = page.id !== 'home'
            ? true
            : (quadRows === '2' && svcPerRow === '4' && !greetHit && banOk)
          const ok = (isPad ? okPad : okPhone) && okHome
          const homeWhy = okHome ? '' : (' 首页契约：四宫格行数=' + quadRows + '(期望2) 常用服务每行=' +
            svcPerRow + '(期望4) 问候语被压=' + greetHit +
            ' banner插画高比=' + banH + '(期望0.5~0.9) 压文案=' + banHitText + ' 溢出=' + banSpill)
          const why = ok ? '通过' : (isPad
            ? ('期望双栏：侧栏可见=' + sideVisible + ' flex-row=' + row + ' 溢出=' + overflow + ' 重叠=' + overlap)
            : ('期望单列（' + vp.name + ' 非横屏平板）：侧栏可见=' + sideVisible +
               '(期望' + page.sideOnPhone + ') flex-row=' + row + ' 溢出=' + overflow)) + homeWhy
          allReport.push({ page: page.id, vp: vp.name, ok, why })
          console.log('  → ' + (ok ? '✅ 通过' : '❌ ' + why))
        }
      }
    })
  })

  const bad = allReport.filter((x) => !x.ok)
  console.log('\n============================================================')
  console.log('实测 ' + allReport.length + ' 组，通过 ' + (allReport.length - bad.length) + ' 组，失败 ' + bad.length + ' 组')
  bad.forEach((b) => console.log('  FAIL ' + b.page + ' / ' + b.vp + ' : ' + b.why))
  console.log('RESULT: ' + (bad.length ? 'PAD_LAYOUT_FAIL' : 'PAD_LAYOUT_OK'))
  console.log('产物：tools/_pad_<页面>.html（可直接用浏览器打开看真实排版）')
}

main()
