/**
 * test-triage.js —— 导诊引擎离线单测（准确性证据，改动后必跑）
 *
 * 为什么要有它：导诊是医疗场景，规则改动不能靠"看起来对"。
 * 这里把安全底线（红旗全覆盖、否定不误判）、科室匹配、分级、追问、AI 融合
 * 全部写成断言，跑一遍就知道有没有回归。
 *
 * 用法：node tools/test-triage.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..', 'miniprogram')
const E = require(path.join(ROOT, 'utils', 'triage-engine.js'))

let pass = 0
let fail = 0
const failures = []

function check(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  failures.push(name + (extra ? '  →  ' + extra : ''))
}

function section(title) { console.log('\n— ' + title + ' —') }

// ==================== ① 红旗症状：一个都不能漏（安全底线）====================
section('红旗症状（急诊识别）全覆盖')
const RED_CASES = [
  ['胸口压榨一样疼，还出汗', 'chest_pain'],
  ['早上起来口角歪斜，说话不清', 'stroke'],
  ['喘不上气，坐着都憋得慌', 'dyspnea'],
  ['突然晕倒，叫不醒', 'consciousness'],
  ['呕血两次，黑便', 'bleeding'],
  ['突然剧烈头痛，脖子发硬', 'severe_headache'],
  ['吃了海鲜全身皮疹，喉咙发紧呼吸困难', 'anaphylaxis'],
  ['误服了农药', 'poisoning'],
  ['车祸外伤，骨头都露出来了', 'trauma'],
  ['肚子硬得像木板，一按就剧痛', 'acute_abdomen'],
  ['三个月婴儿发热38度', 'infant_fever'],
  ['怀孕7个月，阴道出血伴肚子痛', 'pregnancy_emergency'],
  ['不想活了，想死', 'self_harm'],
  ['大面积烧伤，脸也烧到了', 'severe_burn'],
  ['发烧39度还抽搐', 'high_fever_convulsion']
]
RED_CASES.forEach(([text, id]) => {
  const r = E.analyze(text)
  const ids = r.redFlags.map((f) => f.id)
  check('红旗-命中 ' + id, r.emergency && ids.indexOf(id) >= 0,
    'level=' + r.level + ' flags=[' + ids.join(',') + ']')
  check('红旗-必为 emergency ' + id, r.level === 'emergency' && r.levelCls === 'badge-red')
  check('红旗-必给行动建议 ' + id, !!r.redFlagAction, r.redFlagAction)
})

// ==================== ② 否定识别：不能把"没有"判成"有" ====================
section('否定识别（防误判）')
const NEG_CASES = [
  ['没有胸痛，就是胃疼反酸', 'chest_pain'],
  ['不发烧，就是一直咳嗽有痰', 'infant_fever'],
  ['没有呕血，只是胃胀', 'bleeding'],
  ['无呼吸困难，咳嗽三天', 'dyspnea']
]
NEG_CASES.forEach(([text, id]) => {
  const r = E.analyze(text)
  const ids = r.redFlags.map((f) => f.id)
  check('否定-不报 ' + id, ids.indexOf(id) < 0, '误报 flags=[' + ids.join(',') + ']')
  check('否定-不升级为紧急', r.level !== 'emergency', 'level=' + r.level)
})
check('否定-槽位不误抽发热', E.extractSlots('不发烧，就是咳嗽').associated.indexOf('发热') < 0)
check('肯定-正常抽出发热', E.extractSlots('发烧两天了').associated.indexOf('发热') >= 0)

// ==================== ③ 科室匹配 ====================
section('科室匹配（加权 + 人群修正）')
const DEPT_CASES = [
  ['胃疼反酸烧心一周了', '消化内科'],
  ['咳嗽咳痰，嗓子疼，有点发热', '呼吸内科'],
  ['心慌胸闷，血压有点高', '心血管内科'],
  ['腰痛，膝盖也痛，走路费劲', '骨科'],
  ['孩子发烧咳嗽两天了', '儿科诊区'],
  ['牙疼得厉害，牙龈肿了', '口腔科'],
  ['尿频尿急尿痛', '泌尿外科'],
  ['失眠焦虑，压力很大睡不着', '精神心理科'],
  ['头晕，手脚发麻', '神经内科'],
  ['多饮多尿，血糖高', '内分泌科'],
  ['身上起皮疹特别痒', '皮肤科'],
  ['眼睛红，流泪看不清', '眼科'],
  ['耳痛耳鸣，还鼻出血', '耳鼻喉科'],
  ['月经不调，痛经严重', '妇产科']
]
DEPT_CASES.forEach(([text, dept]) => {
  const r = E.analyze(text)
  check('科室-' + dept, r.primary.dept === dept, '实得=' + r.primary.dept + '(score=' + r.primary.score + ')')
  check('科室-有理由 ' + dept, (r.primary.reasons || []).length > 0)
  check('科室-有置信度 ' + dept, !!(r.primary.confidence && r.primary.confidence.text))
})
check('兜底-无法识别时用全科', E.analyze('就是有点不舒服').primary.dept === E.FALLBACK_DEPT)
check('儿童-压低成人科室', (() => {
  const kid = E.analyze('孩子胃疼拉肚子')
  return kid.primary.dept === '儿科诊区'
})(), '实得=' + E.analyze('孩子胃疼拉肚子').primary.dept)

// ==================== ③b 口语变体 + 部位兜底校正 ====================
// 背景（2026-09-14 用户真机反馈）：说「肚子疼」得到全科医学科。
// 实测两个缺陷：① 消化内科只登记了「肚子疼」，漏了「肚子痛/肚痛/肚子胀」等同义口语；
// ② 「部位 + 不舒服」被"未分化"劫持 —— 症状词只命中一个「不舒服」，于是落到全科医学科，
//    可句子里的部位其实已经给了足够信息（「我的肚子不舒服」正确科室是消化内科）。
section('口语变体与部位兜底校正（肚子疼不该答全科医学科）')

// ① 腹痛类口语一个都不能漏（漏了会连分级都掉到"居家观察"，有安全风险）
const ABDO_CASES = ['肚子疼', '肚子痛', '肚痛', '肚疼', '腹痛', '腹部痛', '肚子胀', '肚胀']
ABDO_CASES.forEach((t) => {
  const r = E.analyze(t)
  check('腹痛口语-' + t + ' → 消化内科', r.primary.dept === '消化内科',
    '实得=' + r.primary.dept + '(score=' + r.primary.score + ')')
  check('腹痛口语-' + t + ' 不许掉到居家观察', r.level !== 'selfcare', 'level=' + r.level)
})

// ② 「部位 + 不舒服/不适」→ 按部位定科（不再一律送全科医学科）
const PART_CASES = [
  ['我的肚子不舒服', '消化内科'],
  ['肚子有点不舒服', '消化内科'],
  ['胃不舒服', '消化内科'],
  ['腹部不适', '消化内科'],
  ['肚子不好受', '消化内科'],
  ['眼睛不舒服', '眼科'],
  ['牙不舒服', '口腔科'],
  ['腰不舒服', '骨科'],
  ['膝盖不舒服', '骨科'],
  ['鼻子不舒服', '耳鼻喉科'],
  ['耳朵不舒服', '耳鼻喉科'],
  ['皮肤不舒服', '皮肤科'],
  ['嗓子不舒服', '呼吸内科']
]
PART_CASES.forEach(([text, dept]) => {
  const r = E.analyze(text)
  check('部位校正-' + text + ' → ' + dept, r.primary.dept === dept,
    '实得=' + r.primary.dept + '(score=' + r.primary.score + ')')
  check('部位校正-' + text + ' 有可解释理由', !!(r.primary.reasons && r.primary.reasons.length))
})

// ③ 边界：**没有部位**时仍应老实走全科医学科（校正不能把真的"未分化"也改成专科）
;['就是有点不舒服', '全身不舒服', '身上不舒服', '乏力没力气', '说不清哪里难受'].forEach((t) => {
  check('部位校正-无部位仍走全科「' + t + '」',
    E.analyze(t).primary.dept === E.FALLBACK_DEPT, '实得=' + E.analyze(t).primary.dept)
})

// ④ 边界：**已经能判出专科**的输入不得被部位校正改动（校正只在"要落到全科"时生效）
;[
  ['胃疼反酸一周了', '消化内科'],
  ['咳嗽有痰三天', '呼吸内科'],
  ['头晕手脚发麻', '神经内科'],
  ['失眠焦虑睡不着', '精神心理科'],
  ['月经不调痛经严重', '妇产科']
].forEach(([text, dept]) => {
  check('部位校正-不越界「' + text + '」', E.analyze(text).primary.dept === dept,
    '实得=' + E.analyze(text).primary.dept)
})

// ⑤ 分级不许因为"无处可判"被压低（「肚子疼」原来 score=0 → 居家观察）
check('部位校正-「肚子疼」分级为门诊而非居家', E.analyze('肚子疼').level === 'routine',
  'level=' + E.analyze('肚子疼').level)

// ⑥ 口语「疼」变体 + 颈肩兜底（2026-09-15 用户反馈"什么问题都回答全科"）
//    根因：症状库按**书面「痛」**写词，口语说「头疼 / 脖子疼」抓不到任何症状词 →
//    既没命中专科、部位兜底表也没登记「颈肩/头」→ 一律落到兜底科室「全科医学科」。
//    这里把「疼/痛 / 颈肩 / 四肢」口语说法全部钉死，防止再漏。
const TENG_CASES = [
  ['头疼', '神经内科'], ['头痛', '神经内科'], ['偏头痛', '神经内科'], ['脑袋疼', '神经内科'],
  ['脖子疼', '骨科'], ['脖子痛', '骨科'], ['脖子不舒服', '骨科'], ['颈椎疼', '骨科'],
  ['肩膀疼', '骨科'], ['膝盖疼', '骨科'], ['关节疼', '骨科'], ['手疼', '骨科'], ['胳膊疼', '骨科']
]
TENG_CASES.forEach(([text, dept]) => {
  const r = E.analyze(text)
  check('口语疼-' + text + ' → ' + dept, r.primary.dept === dept,
    '实得=' + r.primary.dept + '(score=' + r.primary.score + ')')
})
// 边界：这些是真的"未分化"，仍应老实走全科医学科（别为了好看乱塞专科）
;['难受', '乏力', '全身没劲'].forEach((t) => {
  check('口语疼-真未分化仍走全科「' + t + '」', E.analyze(t).primary.dept === E.FALLBACK_DEPT,
    '实得=' + E.analyze(t).primary.dept)
})

// ⑦ 程度副词夹在句中（口语「头有点疼 / 头很疼 / 头好疼」）—— 症状匹配必须忽略副词。
//    实现：scoreDepartments 用 normalizeLoose（只对症状词生效，红旗/分级文本不受影响）。
const FILLER_CASES = [
  ['头有点疼', '神经内科'], ['头很疼', '神经内科'], ['头好疼', '神经内科'], ['最近头很疼', '神经内科'],
  ['脖子有点疼', '骨科'], ['肩膀很疼', '骨科'], ['手很疼', '骨科'], ['肚子有点疼', '消化内科']
]
FILLER_CASES.forEach(([text, dept]) => {
  check('夹副词-' + text + ' → ' + dept, E.analyze(text).primary.dept === dept,
    '实得=' + E.analyze(text).primary.dept)
})

// ⑧ 安全护栏：删副词只准作用于症状词，**红旗与分级文本不许被削**（否则会把急诊降级）
check('安全-含「很」的红旗仍触发（肚子按下去很疼）', E.analyze('肚子按下去很疼').emergency === true)
check('安全-「非常痛」仍判为 urgent 程度重', !!(E.analyze('非常痛').slots && E.analyze('非常痛').slots.urgent))
check('安全-「疼得受不了」仍判为 urgent 程度重', !!(E.analyze('疼得受不了').slots && E.analyze('疼得受不了').slots.urgent))
check('安全-「就是有点疼」仍判为程度轻（不是重）', !!(E.analyze('就是有点疼').slots && !E.analyze('就是有点疼').slots.urgent))

// ==================== ④ 分级建议 ====================
section('分级建议')
const LEVEL_CASES = [
  ['突然剧烈腹痛，越来越重', ['emergency', 'urgent', 'semi']],
  ['胃疼反酸一周了', ['semi', 'routine']],
  ['轻微鼻塞一天', ['routine', 'selfcare']],
  ['咳嗽三天，有点低烧', ['semi', 'routine']],
  ['发烧39度两天不退', ['urgent', 'semi']],
  ['老人胸闷气短，走两步就喘', ['emergency', 'urgent', 'semi']]
]
LEVEL_CASES.forEach(([text, allow]) => {
  const r = E.analyze(text)
  check('分级-' + text, allow.indexOf(r.level) >= 0, '实得=' + r.level)
  check('分级-有时限文案 ' + text, !!r.levelWindow)
  check('分级-有建议文案 ' + text, !!r.levelAdvice)
})

// ==================== ⑤ 直接推荐 + 兜底补问 ====================
// 2026-09-13 口径：说完症状**直接推荐科室**；只有完全识别不出归属（兜底科室）才补问一次
section('直接推荐科室（不做逐轮追问）')
const DIRECT_CASES = [
  ['胃疼反酸一周了', '消化内科'],
  ['有点牙疼', '口腔科'],
  ['有点头晕', '神经内科'],
  ['膝盖痛，走路费劲', '骨科']
]
DIRECT_CASES.forEach(([text, dept]) => {
  const r = E.analyze(text)
  check('直推-' + text + '→' + dept, r.primary.dept === dept, '实得=' + r.primary.dept)
  check('直推-不再追问 ' + text, r.question === null, JSON.stringify(r.question))
  check('直推-一次就有结论 ' + text, r.needMoreInfo === false || r.level !== 'selfcare')
})

// 兜底补问：完全识别不出归属时才问，且一次只问一个
const vague = E.analyze('就是有点不舒服')
check('兜底-识别不出归属才补问', vague.primary.dept === E.FALLBACK_DEPT && !!vague.question,
  'dept=' + vague.primary.dept + ' question=' + JSON.stringify(vague.question))
check('追问-优先问时长', vague.question && vague.question.slot === 'duration')
check('追问-带快捷选项', vague.question && vague.question.options.length >= 3)
check('追问-有问就不算有把握', vague.needMoreInfo === true)

const r1 = E.analyze('就是有点不舒服', { asked: ['duration'] })
check('追问-问过的不重复', !r1.question || r1.question.slot !== 'duration', JSON.stringify(r1.question))
const r2 = E.analyze('就是有点不舒服', { asked: ['duration', 'severity'], rounds: 2 })
check('追问-达到上限后不再问', r2.question === null, JSON.stringify(r2.question))
const urgent = E.analyze('胸口压榨样疼痛')
check('追问-红旗时不再追问', urgent.question === null)

// ==================== ⑥ 多轮上下文累积 ====================
section('多轮上下文（症状累积理解）')
const turn2 = E.analyze('还有反酸和烧心', { history: ['胃那块不舒服'] })
check('上下文-合并历史后命中消化内科', turn2.primary.dept === '消化内科', '实得=' + turn2.primary.dept)
check('上下文-槽位来自历史', !!turn2.slots.duration || !!turn2.slots.part.length)
const red2 = E.analyze('现在胸口很闷，喘不上气', { history: ['咳嗽三天'] })
check('上下文-第二轮出现红旗立即升级', red2.emergency && red2.level === 'emergency',
  'level=' + red2.level)

// ==================== ⑦ 与后端 AI 结果融合 ====================
section('AI 结果融合（后端优先但不吞安全信号）')
const localOK = E.analyze('胃疼反酸一周')
const mergedSame = E.mergeRemote(localOK, { clinic: '消化内科门诊', reason: '上消化道症状' })
check('融合-科室取后端', mergedSame.primary.dept === '消化内科')
check('融合-一致时标注', mergedSame.aiMatched === true)
check('融合-可导航（1F 有房间）', mergedSame.navigable === true)

const mergedDiff = E.mergeRemote(localOK, { clinic: '心血管内科' })
check('融合-不一致时保留本地为备选',
  (mergedDiff.alternates || []).some((a) => a.dept === '消化内科'),
  JSON.stringify((mergedDiff.alternates || []).map((a) => a.dept)))

const localMild = E.analyze('有点咳嗽')
check('融合-本地无红旗', localMild.emergency === false)
const mergedEmergency = E.mergeRemote(localMild, { clinic: '呼吸内科', emergency: { is_emergency: true, text: '建议立即就医' } })
check('融合-后端报急立即升级为 emergency', mergedEmergency.emergency && mergedEmergency.level === 'emergency')
check('融合-升级后给行动建议', !!mergedEmergency.redFlagAction)
check('融合-升级后不再追问', mergedEmergency.question === null)

const mergedUnknown = E.mergeRemote(localOK, { clinic: '肿瘤科' })
check('融合-未知科室不可导航', mergedUnknown.navigable === false)
check('融合-未知科室仍显示', mergedUnknown.primary.dept === '肿瘤科')

// ==================== ⑧ 结果页报告 ====================
section('结果页报告结构')
const report = E.toReport(E.analyze('胃疼反酸一周，想挂号'))
const needKeys = ['level', 'levelText', 'levelCls', 'levelAdvice', 'dept', 'navigable', 'reasons', 'slotsText', 'symptomText', 'disclaimer']
needKeys.forEach((k) => check('报告-含字段 ' + k, report[k] !== undefined, 'missing'))
check('报告-免责声明非空', String(report.disclaimer).length > 10)
const redReport = E.toReport(E.analyze('胸口压榨样疼'))
check('报告-急诊带红旗标签', redReport.emergency && redReport.redFlagLabels.length > 0)

// ==================== ⑨ 服务层集成（stub 后端，验证安全与可用底线）====================
section('服务层集成（stub 后端）')

const reqPath = require.resolve(path.join(ROOT, 'services', 'request.js'))
const apiPath = require.resolve(path.join(ROOT, 'config', 'api.js'))
const API = require(apiPath)
const calls = []

function stubRequest(postImpl) {
  require.cache[reqPath] = {
    id: reqPath,
    filename: reqPath,
    loaded: true,
    exports: {
      API: API,
      post(spec, data, opts) {
        calls.push(String(spec.path).split('?')[0])
        return postImpl(spec, data, opts)
      },
      get() { return Promise.resolve({}) }
    }
  }
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'triage.js'))]
  return require(path.join(ROOT, 'services', 'triage.js'))
}

// wx 最小桩（服务层只用到本地存储与震动）
global.wx = {
  getStorageSync() { return '' },
  setStorageSync() {},
  removeStorageSync() {},
  vibrateShort() {}
}

// ==================== ⑪ 院内导航「带路」可达性（1F 直达 / 2F~4F 换层）====================
// 这一节守的是产品承诺：结果卡后面只要问了「要不要带您过去」，点「要」就**一定**有路可走。
// 做法：用最小桩把 nav.js 的页面对象取出来，直接调它的 _deptInfo / _resolveDept（纯逻辑，不碰 canvas）。
section('院内导航带路（1F 直达 / 2F~4F 换层 / 急诊不带路）')

const KB = require(path.join(ROOT, 'utils', 'triage-kb.js'))
const NMAP = require(path.join(ROOT, 'packageNav', 'data', 'indoor-map.js'))

global.getApp = () => ({ globalData: {} })
let navPage = null
global.Page = (o) => { navPage = o }
require(path.join(ROOT, 'packageNav', 'pages', 'nav', 'nav.js'))

const navCtx = Object.assign({}, navPage, {
  _all: NMAP.DESTINATIONS.map((d) => Object.assign({}, d))
})
const resolve = (name) => navPage._resolveDept.call(navCtx, name)

// ① 是否给带路：除急诊外全部可带路（急诊走独立绿色通道，不给"带路"避免引导排队）
check('导航-全科医学科可带路', KB.DEPARTMENT_INFO['全科医学科'].navigable === true)
check('导航-2F 科室（皮肤科）可带路', KB.DEPARTMENT_INFO['皮肤科'].navigable === true)
check('导航-3F 科室（神经内科）可带路', KB.DEPARTMENT_INFO['神经内科'].navigable === true)
check('导航-4F 科室（口腔科）可带路', KB.DEPARTMENT_INFO['口腔科'].navigable === true)
check('导航-急诊科不给带路（绿色通道）', KB.DEPARTMENT_INFO['急诊科'].navigable === false)

// ② 1F 直达：目的地 id 必须与知识库 id 一致，且不出现换层提示
const ONE_FLOOR = ['消化内科', '呼吸内科', '心血管内科', '骨科', '儿科诊区', '放射科', '检验科', '药房', '全科医学科']
ONE_FLOOR.forEach((d) => {
  const hit = resolve(d)
  check('导航-1F 直达 ' + d,
    !!(hit && hit.dest && hit.dest.id === KB.DEPARTMENT_INFO[d].id && !hit.floorTip),
    hit ? hit.dest.id + ' / tip=' + hit.floorTip : 'null')
})

// ③ 2F/3F/4F：先带到「电梯厅」，并且必须写清"上 N 楼"（不能让人站在电梯口猜）
;['皮肤科', '神经内科', '妇产科', '内分泌科', '眼科'].forEach((d) => {
  const info = KB.DEPARTMENT_INFO[d]
  const n = /([2-9])F/.exec(info.floor)[1]
  const hit = resolve(d)
  check('导航-换层 ' + d + ' 走电梯厅', !!(hit && hit.dest && hit.dest.id === 'elevator'),
    hit ? hit.dest.id : 'null')
  check('导航-换层 ' + d + ' 写明上 ' + n + ' 楼',
    !!(hit && hit.floorTip && hit.floorTip.indexOf(n + ' 楼') >= 0), hit ? hit.floorTip : 'null')
})

// ④ 接口口径：导诊/问诊传过来的是「消化内科门诊」这类带后缀的名字，也要认
check('导航-带「门诊」后缀仍命中', (resolve('消化内科门诊') || {}).dest.id === 'gi')
check('导航-全科别名命中', (resolve('全科门诊') || {}).dest.id === 'gp')
check('导航-急诊科不给方向', resolve('急诊科') === null)

// ⑤ 关键不变式：知识库里每一个"可带路"的科室，导航都必须解析得出目的地（一个都不许落空）
const holes = Object.keys(KB.DEPARTMENT_INFO).filter((d) => {
  if (!KB.DEPARTMENT_INFO[d].navigable) return false
  const hit = resolve(d)
  return !hit || !hit.dest
})
check('导航-可带路科室无落空（共 ' + Object.keys(KB.DEPARTMENT_INFO).length + ' 个科室）',
  holes.length === 0, '落空=' + holes.join(','))

// ⑥ 数据完整性：每个目的地都要有坐标 + 至少 3 步文案（自动生成链路没断）
NMAP.DESTINATIONS.forEach((d) => {
  check('导航-数据完整 ' + d.id,
    !!(d.steps && d.steps.length >= 3 && typeof d.x === 'number' && typeof d.y === 'number' && d.path.length >= 2))
})
check('导航-全科医学科已上图（1F 门诊大厅内）', NMAP.DESTINATIONS.some((d) => d.id === 'gp'))

// 场景 1：正常后端（急诊判定 false + 科室推荐命中）
stubRequest((spec) => {
  const p = String(spec.path)
  if (p.indexOf('emergency') >= 0) return Promise.resolve({ is_emergency: false })
  if (p.indexOf('recommend-department') >= 0) return Promise.resolve({ clinic: '消化内科门诊', reason: '上消化道症状' })
  return Promise.resolve({})
})
const S1 = require(path.join(ROOT, 'services', 'triage.js'))

// ==================== ⑩ 路线询问应答词（问诊页/导诊页共用）====================
section('路线询问应答词（打字答"要/不用"也能识别）')
const YES_CASES = ['要', '是的', '好', '好的', '可以', '需要', '带我去', '嗯', '要的', '麻烦你']
const NO_CASES = ['不用', '不用了', '不要', '不了', '算了', '暂时不', '不去了', '先不']
const NONE_CASES = ['胃疼反酸一周了', '我最近老咳嗽', '']
YES_CASES.forEach((t) => check('应答-yes ' + t, S1.answerNav(t) === 'yes', '实得=' + S1.answerNav(t)))
NO_CASES.forEach((t) => check('应答-no ' + t, S1.answerNav(t) === 'no', '实得=' + S1.answerNav(t)))
NONE_CASES.forEach((t) => check('应答-非应答「' + t + '」', S1.answerNav(t) === '', '实得=' + S1.answerNav(t)))
// ⚠️ 关键回归：先判否定再判肯定（"不要" 里含 "要"，顺序反了会把人误送进导航）
check('应答-「不要」不能判成 yes', S1.answerNav('不要') === 'no')
check('应答-「不用了」不能判成 yes', S1.answerNav('不用了') === 'no')
check('应答-长句不当应答', S1.answerNav('我不想去了，我明天再看吧') === '')

// 场景 2：红旗输入 → 应"不等后端"
calls.length = 0
S1.analyze('胸口压榨样疼')
  .then((r) => {
    check('服务-红旗命中，且未调用后端（抢时间）', r.emergency && calls.length === 0, 'calls=' + calls.join(','))
    calls.length = 0
    // 场景 2b：普通症状（不强制出结果）→ 也不再追问，直接走后端并给出科室
    return S1.analyze('胃疼反酸烧心一周了')
  })
  .then((r) => {
    check('服务-普通症状直接出结论（不追问）', !r.question, 'question=' + JSON.stringify(r.question))
    check('服务-调用了急诊判定与科室推荐两个接口', calls.length === 2, calls.join(','))
    check('服务-融合后端科室结果', r.primary.dept === '消化内科', r.primary.dept)
    check('服务-标注 AI 已使用', r.aiUsed === true && r.aiFallback === false)
    check('服务-融合后可导航（1F 有房间）', r.navigable === true)
    // 场景 3：后端全挂 → 本地兜底，绝不能卡住用户
    const S2 = stubRequest(() => Promise.reject(new Error('network down')))
    return S2.analyze('腰痛膝盖痛', { forceResult: true })
  })
  .then((r) => {
    check('服务-后端全挂仍给本地结论', !!(r.primary && r.primary.dept === '骨科'), 'dept=' + (r.primary && r.primary.dept))
    check('服务-标记为 AI 降级', r.aiFallback === true)
    // 场景 3b：隐私开关「仅本地分析」→ 一个字都不发后端（隐私告知里点了"仅本地分析"）
    calls.length = 0
    const S2b = stubRequest(() => Promise.resolve({ clinic: '呼吸内科' }))
    return S2b.analyze('胃疼反酸一周了', { forceResult: true, useRemote: false })
  })
  .then((r) => {
    check('服务-仅本地分析时零后端调用', calls.length === 0, 'calls=' + calls.join(','))
    check('服务-仅本地分析仍出科室结论', r.primary.dept === '消化内科', r.primary.dept)
    check('服务-仅本地分析标注 AI 降级', r.aiFallback === true)
    // 场景 4：后端报急 → 升级为 emergency
    const S3 = stubRequest((spec) => {
      if (String(spec.path).indexOf('emergency') >= 0) return Promise.resolve({ is_emergency: true, text: '建议立即就医' })
      return Promise.resolve({ clinic: '呼吸内科' })
    })
    return S3.analyze('咳嗽有点胸闷', { forceResult: true })
  })
  .then((r) => {
    check('服务-后端报急即升级 emergency', r.emergency && r.level === 'emergency', 'level=' + r.level)
    check('服务-升级后主推荐仍为急诊科', r.primary.dept === '急诊科', r.primary.dept)
    summary()
  })
  .catch((e) => {
    fail++
    failures.push('服务层集成异常：' + (e && e.message))
    summary()
  })

// ==================== 汇总 ====================
function summary() {
  console.log('\n========================================')
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) {
    console.log('\n失败明细：')
    failures.forEach((f) => console.log('  ✗ ' + f))
    process.exit(1)
  }
  console.log('RESULT: TRIAGE_OK')
}
