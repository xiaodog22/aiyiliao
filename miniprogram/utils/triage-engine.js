/**
 * triage-engine.js —— 导诊推理引擎（纯函数，零 wx 依赖，可 node 离线单测）
 *
 * 职责（对应需求四项功能）：
 *   1. 症状采集与自然语言理解：extractSlots() —— 抽取 部位/时长/程度/伴随/人群 槽位，含否定识别
 *   2. 基于知识库的科室匹配与分级建议：scoreDepartments() + decideLevel()
 *   3. 急诊与危重识别与预警：matchRedFlags()（安全底线，优先于一切）
 *   4. 清晰反馈：analyze() 一次返回结构化结果，供页面/结果页渲染
 *
 * ⚠️ 交互口径（2026-09-13 调整）：**说完症状直接推荐科室**。
 *   多轮追问只保留"完全识别不出症状归属"时的单次补问（见 analyze 的 stopAsk 门槛），
 *   信息够用就给结论，不把用户困在问答里。
 *
 * ⚠️ 准确性设计（为什么是"多信号加权 + 可解释"而不是单一关键词命中）：
 *   - 主诉强化：出现在句子前段的症状权重更高（"胃痛反酸"比陈述末句提到的更关键）
 *   - 否定识别：命中词前 5 字窗口出现"没有/无/不/否认"→ 不计分（避免「没有发热」被判成发热）
 *   - 人群优先：儿童 → 儿科诊区直接加权，同时压低其它科室（儿童疾病谱不同）
 *   - 红旗优先：任一红旗命中即 emergency，不再用分数"稀释"风险
 *   - 可解释：返回 hits（命中了哪些词、加了多少分），页面向用户展示"为什么推荐它"
 *   - 失败可降级：不依赖后端，纯本地也能给出分级与科室（联网只是提升，不是前提）
 */
const KB = require('./triage-kb.js')

const {
  RED_FLAGS, SYMPTOM_KB, PART_PRIMARY, DEPARTMENT_INFO, SLOT_DICT, NEGATIONS,
  FOLLOWUPS, MAX_FOLLOWUP, LEVELS, URGENT_HINTS
} = KB

const FALLBACK_DEPT = '全科医学科'

// ==================== 文本归一化 / 命中判定 ====================
/** 归一化：去空白、全角→半角标点、统一小写（中文无大小写，但对英文症状词有用） */
function normalize(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:（）()【】\[\]“”"'’‘]/g, '')
    .toLowerCase()
}

/**
 * 症状匹配专用归一化：在 normalize 基础上再折叠「程度副词」。
 *
 * 背景（2026-09-15 用户反馈"什么问题都回答全科"）：口语常说「头有点疼 / 头很疼 / 头好疼」，
 * 而症状库登记的是连续词「头疼」——中间夹字就抓不到任何症状词 → 落到兜底科室「全科医学科」。
 *
 * ⚠️ **只用于症状词匹配（scoreDepartments）**，绝不可用于槽位/红旗：
 *   - SLOT_DICT 的 severity 正是用「有点 / 稍微 / 一点点 / 不太 / 很痛 / 非常痛」当关键词；
 *   - 红旗词里也有「按下去很疼」「非常痛」。
 *   若全局删副词，会把「很痛」的**急诊级别删没**（属安全回归）。所以这里单独开一条宽松通道。
 */
const FILLER_RE = /(有点儿|有点|有一点|一点点|一点|一些|有些|稍微|比较|特别|非常|很|好|挺)/g
function normalizeLoose(text) {
  return normalize(text).replace(FILLER_RE, '')
}

/** 命中位置前 5 字窗口内是否出现否定词（否定识别，防误判） */
function isNegated(text, idx) {
  const from = Math.max(0, idx - 5)
  const window = text.slice(from, idx)
  for (let i = 0; i < NEGATIONS.length; i++) {
    if (window.indexOf(NEGATIONS[i]) >= 0) return true
  }
  return false
}

/** 在文本中查找关键词，返回首个未被否定的命中位置（-1 = 未命中） */
function findKey(text, key) {
  let from = 0
  for (;;) {
    const idx = text.indexOf(key, from)
    if (idx < 0) return -1
    if (!isNegated(text, idx)) return idx
    from = idx + key.length
  }
}

/** 关键词组 → 是否命中（任一关键词命中即算） */
function anyHit(text, keys) {
  if (!keys || !keys.length) return false
  for (let i = 0; i < keys.length; i++) {
    if (findKey(text, keys[i]) >= 0) return true
  }
  return false
}

// ==================== ① 症状采集与 NLU ====================
/**
 * 抽取结构化槽位
 * @returns {{duration:string, severity:string, population:string, part:string[], associated:string[], urgent:boolean, raw:string}}
 */
function extractSlots(text) {
  const t = normalize(text)
  const out = { duration: '', severity: '', population: '', part: [], associated: [], urgent: false, raw: String(text || '') }

  const pick = (field) => {
    const list = SLOT_DICT[field] || []
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      if (anyHit(t, item.k)) {
        if (item.urgent) out.urgent = true
        return item.v
      }
    }
    return ''
  }
  out.duration = pick('duration')
  out.severity = pick('severity')
  out.population = pick('population')

  ;['part', 'associated'].forEach((field) => {
    const list = SLOT_DICT[field] || []
    list.forEach((item) => {
      if (anyHit(t, item.k)) out[field].push(item.v)
    })
  })
  return out
}

function slotFilled(slots, field) {
  if (field === 'part') return slots.part.length > 0
  if (field === 'associated') return slots.associated.length > 0
  if (field === 'duration') return !!slots.duration
  if (field === 'severity') return !!slots.severity
  return false
}

// ==================== ② 红旗识别 ====================
/**
 * 红旗症状匹配（急诊/危重）
 * @returns {Array} 命中的红旗（按 weight 降序），每项含 {id,label,advice,weight,hits}
 */
function matchRedFlags(text) {
  const t = normalize(text)
  const hit = []
  RED_FLAGS.forEach((flag) => {
    const main = (flag.any || []).filter((k) => findKey(t, k) >= 0)
    if (!main.length) return
    // all：除主词外还需命中其中至少一个（如"全身皮疹 + 呼吸困难"）
    if (flag.all && flag.all.length && !anyHit(t, flag.all)) return
    // none：明确否认则排除（如"没有胸痛"）
    if (flag.none && flag.none.length) {
      const denied = flag.none.filter((k) => t.indexOf(normalize(k)) >= 0)
      if (denied.length) return
    }
    hit.push({ id: flag.id, label: flag.label, advice: flag.advice, weight: flag.weight || 5, hits: main })
  })
  return hit.sort((a, b) => b.weight - a.weight)
}

/** 红旗 → 建议动作（分诊建议，不做诊断） */
function redFlagAction(flags) {
  if (!flags.length) return ''
  const top = flags[0]
  const extra = flags.length > 1 ? '（同时存在 ' + flags.length + ' 项危险信号）' : ''
  return '检测到' + top.label + extra + '：' + top.advice
}

// ==================== ③ 科室匹配（加权 + 可解释）====================
/**
 * 科室打分
 * @returns {Array<{dept,score,hits,reasons,confidence,info}>} 按分数降序
 */
function scoreDepartments(text, slots) {
  const t = normalizeLoose(text)              // ⚠️ 宽松归一化：忽略「有点/很/好」等程度副词（见 normalizeLoose 注释）
  const head = t.slice(0, 12)                 // 主诉区（句首权重更高）
  const isChild = slots.population === '儿童'
  const ranked = []

  SYMPTOM_KB.forEach((entry) => {
    let score = 0
    const hits = []
    entry.keys.forEach((group) => {
      group.k.forEach((k) => {
        const idx = findKey(t, k)
        if (idx < 0) return
        let w = group.w
        if (idx < 12 || head.indexOf(k) >= 0) w = Math.round(w * 1.3)   // 主诉强化 +30%
        score += w
        hits.push({ k: k, w: w, pos: idx })
      })
    })
    if (!score) return

    // 人群修正：儿童 → 儿科诊区加分，其它科室减半（儿童疾病谱与成人不同）
    if (isChild) {
      if (entry.dept === '儿科诊区') score += 6
      else if (entry.dept !== '全科医学科') score = Math.round(score * 0.5)
    }
    // 老年人：内科系轻微加权（多病共存、症状不典型，避免直接给"居家观察"）
    if (slots.population === '老年人' && ['心血管内科', '呼吸内科', '消化内科'].indexOf(entry.dept) >= 0) {
      score += 1
    }

    ranked.push({
      dept: entry.dept,
      system: entry.system,
      score: score,
      hits: hits.sort((a, b) => b.w - a.w).slice(0, 5),
      reason: entry.reason
    })
  })

  ranked.sort((a, b) => b.score - a.score)
  applyPartPrimary(ranked, slots, t)
  const top = ranked.slice(0, 3)
  top.forEach((item, i) => {
    item.confidence = confidenceOf(item.score, i)
    item.info = DEPARTMENT_INFO[item.dept] || null
    item.reasons = buildReasons(item, slots)
  })
  return top
}

/**
 * 部位兜底校正（2026-09-14）
 *
 * 场景：「肚子不舒服」「眼睛不舒服」「牙不舒服」这类 **"部位 + 不舒服/难受"** 的口语说法，
 *   症状词只命中一个**未分化**的「不舒服」→ 结果落到兜底科室「全科医学科」。
 *   但句子里已经有明确部位，科室信息其实够用 —— 这是"未分化"被误判，不是真的无从判断。
 *   （实测：「我的肚子不舒服」原来答全科医学科，正确答案是消化内科。）
 *
 * 做法：**只在最高分是兜底科室时生效** → 按 KB 的「部位 → 首选科室」表把对应科室拉上来。
 *   ⚠️ 前置条件就是"否则会落到全科"，所以**不会影响任何已经能判出专科的输入**（零回归面）。
 *   ⚠️ 分数取「原最高分 + 1」并封顶 11：部位只是兜底校正，不该对外宣称"匹配度较高"。
 *
 * @param {Array} ranked 打分结果（原地修改并重新排序）
 * @param {Object} slots 槽位（用 part 判断部位）
 * @param {string} t 归一化原文（用于取用户实际说过的部位词，做可解释文案）
 */
function applyPartPrimary(ranked, slots, t) {
  // 触发条件：**没有任何科室命中**，或最高分就是兜底科室「全科医学科」——
  // 两种都意味着"要落到全科了"，此时若句中有明确部位，就用部位把科室拉正。
  const empty = !ranked.length
  if (!empty && ranked[0].dept !== FALLBACK_DEPT) return
  const parts = (slots && slots.part) || []
  if (!parts.length) return
  const base = empty ? 0 : ranked[0].score
  for (let i = 0; i < (PART_PRIMARY || []).length; i++) {
    const rule = PART_PRIMARY[i]
    if (parts.indexOf(rule.part) < 0) continue
    // ⚠️ ranked 里只放"分数 > 0"的科室，逐条打分时该科室可能压根没进榜（如「肚子不舒服」
    //    里消化内科没有任何症状词命中）→ 找不到就按知识库补一条空条目，再填分。
    let target = ranked.filter((x) => x.dept === rule.dept)[0]
    if (!target) {
      const kb = SYMPTOM_KB.filter((x) => x.dept === rule.dept)[0]
      target = {
        dept: rule.dept,
        system: (kb && kb.system) || '',
        score: 0,
        hits: [],
        reason: (kb && kb.reason) || ''
      }
      ranked.push(target)
    }
    const word = (rule.k || []).filter((k) => String(t).indexOf(k) >= 0)[0] || rule.part
    const score = Math.min(Math.max(base + 1, 7), 11)
    target.score = score
    // 把部位词当成一次"命中"塞进去 → 结果卡会显示「您提到了「肚子」，属于消化系统表现」
    target.hits = [{ k: word, w: score, pos: 0 }].concat(target.hits).slice(0, 5)
    if (rule.reason) target.reason = rule.reason
    ranked.sort((a, b) => b.score - a.score)
    return
  }
}

function confidenceOf(score, rank) {
  let label = '偏低'
  if (score >= 12) label = '较高'
  else if (score >= 7) label = '中等'
  else if (score >= 3) label = '偏低'
  else label = '较低'
  // 与第二名差距过小 → 降一档（避免"两个科室分数接近却说得斩钉截铁"）
  return { score: score, text: label, rank: rank || 0 }
}

/** 生成"为什么推荐它"的人话解释（对应需求"结果以清晰易懂方式反馈"） */
function buildReasons(item, slots) {
  const list = []
  const words = item.hits.map((h) => h.k).slice(0, 4)
  if (words.length) list.push('您提到了「' + words.join('、') + '」，属于' + (item.system || '相关系统') + '表现')
  if (slots.duration) list.push('症状持续' + slots.duration)
  if (slots.severity) list.push('程度：' + slots.severity)
  if (slots.associated.length) list.push('伴随' + slots.associated.slice(0, 3).join('、'))
  if (slots.population) list.push('就诊对象为' + slots.population + '，科室选择已据此调整')
  return list
}

// ==================== 分级 ====================
function decideLevel(redFlags, slots, ranked, text) {
  if (redFlags.length) return LEVELS.emergency

  const t = normalize(text)
  let level = null
  URGENT_HINTS.forEach((hint) => {
    if (!anyHit(t, hint.k)) return
    const cand = LEVELS[hint.level]
    if (!level || cand.order < level.order) level = cand
  })

  const topScore = ranked.length ? ranked[0].score : 0
  const acute = slots.urgent || slots.severity === '程度重' || slots.severity === '进行性加重'
  if (acute && (!level || level.order > LEVELS.semi.order)) level = LEVELS.semi
  if (topScore >= 10 && (!level || level.order > LEVELS.semi.order)) level = LEVELS.semi

  if (!level) {
    if (topScore >= 3) level = LEVELS.routine
    else if (topScore > 0) level = LEVELS.routine
    else level = LEVELS.selfcare     // 完全没抓到有效症状 → 先把话说清楚，附带追问
  }
  return level
}

// ==================== 多轮追问 ====================
/**
 * 选一个最该补问的槽位（一次只问一个，避免"问卷感"）
 * @param {Object} slots 已抽取槽位
 * @param {Array<string>} asked 已经问过的槽位
 * @param {number} rounds 已追问轮数
 */
function nextQuestion(slots, asked, rounds) {
  if ((rounds || 0) >= MAX_FOLLOWUP) return null
  const order = ['duration', 'severity', 'part', 'associated']
  const askedList = asked || []
  for (let i = 0; i < order.length; i++) {
    const slot = order[i]
    if (askedList.indexOf(slot) >= 0) continue
    if (slotFilled(slots, slot)) continue
    return Object.assign({ slot: slot }, FOLLOWUPS[slot])
  }
  return null
}

// ==================== 总入口 ====================
/**
 * 本地导诊分析（不依赖网络，任何输入都能给出结论 + 建议动作）
 * @param {string} text 本次输入
 * @param {Object} [opts] { history:[...], asked:[...], rounds:number }
 * @returns {Object} 结构化导诊结果
 */
function analyze(text, opts) {
  const o = opts || {}
  const history = o.history || []
  const merged = history.concat([text]).join('。')
  const single = normalize(text)

  const slots = extractSlots(merged)
  const redFlags = matchRedFlags(merged)
  // 本次输入含红旗但历史没有 → 也算了（merged 已覆盖）；但红旗只看合并文本以防漏
  const ranked = scoreDepartments(merged, slots)
  const level = decideLevel(redFlags, slots, ranked, merged)

  let primary = ranked[0] || null
  let needMoreInfo = false
  if (!primary) {
    primary = {
      dept: FALLBACK_DEPT,
      system: '未分化症状',
      score: 0,
      hits: [],
      reason: '暂未从描述中识别出明确的系统归属',
      confidence: { score: 0, text: '较低' },
      info: DEPARTMENT_INFO[FALLBACK_DEPT] || null,
      reasons: ['暂未能识别到明确的症状关键词']
    }
  } else if (primary.score < 4) {
    needMoreInfo = true      // 分低说明信息不足 → 允许追问
  }

  // 红旗命中 → 主推荐直接切到「急诊科」（安全优先：不让用户拿着专科门诊号去排队）
  if (redFlags.length) {
    const emInfo = DEPARTMENT_INFO['急诊科'] || null
    const matched = ranked.slice(0, 2)
    primary = {
      dept: '急诊科',
      system: '急危重症',
      score: 10,
      hits: [],
      reason: '检测到危险信号，应走急诊绿色通道',
      confidence: { score: 10, text: '明确' },
      info: emInfo,
      reasons: redFlags.map((f) => '危险信号：' + f.label).concat(
        matched.length ? ['可能涉及的专科：' + matched.map((m) => m.dept).join(' / ') + '（由急诊分诊）'] : []
      )
    }
    // 急诊场景下 alternate 改成"可能涉及的专科"，供医生参考
    var _alternatesOverride = matched
  }

  // 追问门槛（2026-09-13 产品口径调整）：
  //   **只要匹配到任何科室（非兜底科室）就直接出结论** —— 用户说完不适立刻拿到推荐科室，
  //   不再逐轮追问；只有"完全没识别出症状归属"这一种情况才补问一个关键问题，
  //   避免把"答非所问"的科室卡推给用户。
  const matched = primary.dept !== FALLBACK_DEPT && primary.score > 0
  const stopAsk = level.key === 'emergency' || level.key === 'urgent' || matched
  const question = stopAsk ? null : nextQuestion(slots, o.asked, o.rounds)

  const info = DEPARTMENT_INFO[primary.dept] || null
  return {
    level: level.key,
    levelText: level.text,
    levelCls: level.cls,
    levelWindow: level.window,
    levelAdvice: level.advice,
    redFlags: redFlags,
    redFlagAction: redFlagAction(redFlags),
    emergency: redFlags.length > 0,
    primary: primary,
    alternates: (typeof _alternatesOverride !== 'undefined' && _alternatesOverride) ? _alternatesOverride : ranked.slice(1, 3),
    slots: slots,
    slotsText: describeSlots(slots),
    question: question,
    // 只要还在追问，就说明信息不足（供页面显示"我想再了解一点"）
    needMoreInfo: !!(question || needMoreInfo),
    navigable: !!(info && info.navigable),
    departmentInfo: info,
    // 合规口径统一在这里产出，页面照抄即可
    disclaimer: '本结果为 AI 分诊建议，仅供参考，不能替代医生面诊与检查；急危重症请直接拨打 120。'
  }
}

/** 槽位 → 一句人话（用于"我理解到的信息"回执） */
function describeSlots(slots) {
  const parts = []
  if (slots.part.length) parts.push('部位：' + slots.part.join('、'))
  if (slots.duration) parts.push('时长：' + slots.duration)
  if (slots.severity) parts.push('程度：' + slots.severity)
  if (slots.associated.length) parts.push('伴随：' + slots.associated.join('、'))
  if (slots.population) parts.push('人群：' + slots.population)
  return parts.join(' · ')
}

// ==================== 与后端 AI 结果融合 ====================
/**
 * 本地规则与后端 AI 结果融合（后端优先但不吞掉安全信号）
 * @param {Object} local analyze() 的结果
 * @param {Object} remote { dept, clinic, reason, emergency:{is_emergency,level,text} }
 * @returns {Object} 融合后的结果（结构同 analyze）
 */
function mergeRemote(local, remote) {
  const r = remote || {}
  const out = Object.assign({}, local)

  // ① 急诊信号取并集（任一来源报警即预警 —— 安全优先，绝不因为"本地没中"就降级）
  const remoteEmergency = !!(r.emergency && (r.emergency.is_emergency || r.emergency.level === 'high'))
  if (remoteEmergency && !out.emergency) {
    out.emergency = true
    out.level = 'emergency'
    out.levelText = LEVELS.emergency.text
    out.levelCls = LEVELS.emergency.cls
    out.levelWindow = LEVELS.emergency.window
    out.levelAdvice = LEVELS.emergency.advice
    out.redFlagAction = (r.emergency && r.emergency.text) || 'AI 判断存在紧急风险，请立即就医或拨打 120。'
    out.redFlags = (out.redFlags || []).concat([{ id: 'remote', label: 'AI 判定紧急', advice: out.redFlagAction, weight: 10, hits: [] }])

    // ⚠️ 分级升级为急诊时，主推荐科室必须同步切「急诊科」——
    //    否则用户会看到"立即就医"却拿着专科门诊号去排队（真实安全问题）
    const prev = out.primary
    const emInfo = DEPARTMENT_INFO['急诊科'] || null
    out.primary = {
      dept: '急诊科',
      system: '急危重症',
      score: 10,
      hits: prev ? prev.hits : [],
      reason: out.redFlagAction,
      confidence: { score: 10, text: '明确' },
      info: emInfo,
      reasons: ['AI 判定存在紧急风险'].concat(
        prev && prev.dept !== '急诊科' ? ['可能涉及的专科：' + prev.dept + '（由急诊分诊）'] : []
      )
    }
    out.navigable = false
    out.departmentInfo = emInfo
    if (prev && prev.dept !== '急诊科') {
      out.alternates = [prev].concat(out.alternates || []).slice(0, 3)
    }
  }

  // ② 科室：AI 结果优先，但保留本地推荐作为备选，并标注是否一致
  //    ⚠️ 本地已判定急危重症时不覆盖主推荐（保持"急诊科"），AI 科室只作为参考专科
  const remoteDept = normalizeDept(r.clinic || r.department || r.dept)
  if (remoteDept && out.emergency) {
    out.alternates = [{ dept: remoteDept, score: 0, confidence: { text: 'AI 分析参考' }, info: DEPARTMENT_INFO[remoteDept] || null, reasons: [] }]
      .concat(out.alternates || [])
      .filter((x) => x && x.dept && x.dept !== out.primary.dept)
      .slice(0, 3)
  } else if (remoteDept) {
    const localTop = out.primary ? out.primary.dept : ''
    const same = remoteDept === localTop
    const info = DEPARTMENT_INFO[remoteDept] || null
    const aiPrimary = {
      dept: remoteDept,
      system: (info && info.tag) || '',
      score: same ? Math.max(out.primary.score, 10) : 8,
      hits: out.primary ? out.primary.hits : [],
      reason: r.reason || (info ? info.intro : 'AI 根据整体描述给出的建议科室'),
      confidence: { score: 8, text: same ? '较高（AI 与规则一致）' : '中等（AI 建议）' },
      info: info,
      reasons: [].concat(out.primary ? out.primary.reasons : [], r.reason ? ['AI 分析：' + r.reason] : [])
    }
    out.primary = aiPrimary
    out.navigable = !!(info && info.navigable)
    out.departmentInfo = info
    out.alternates = [].concat(
      same ? [] : [{ dept: localTop, score: out.primary ? 0 : 0, confidence: { text: '本地规则建议' }, info: DEPARTMENT_INFO[localTop] || null, reasons: [] }],
      out.alternates || []
    ).filter((x) => x && x.dept && x.dept !== remoteDept).slice(0, 3)
    out.aiMatched = same
  }

  // ③ 已有明确结论就不再追问
  if (out.emergency || (out.primary && out.primary.score >= 7)) out.question = null
  return out
}

function normalizeDept(name) {
  const s = String(name || '').trim().replace(/门诊$/, '')
  if (!s) return ''
  if (DEPARTMENT_INFO[s]) return s
  const keys = Object.keys(DEPARTMENT_INFO)
  for (let i = 0; i < keys.length; i++) {
    if (s.indexOf(keys[i]) >= 0 || keys[i].indexOf(s) >= 0) return keys[i]
  }
  return s
}

// ==================== 结果 → 结果页参数字符串 ====================
/** 结果页展示所需的精简结构（避免超长 URL；大文本走 storage） */
function toReport(result) {
  const r = result || {}
  const p = r.primary || {}
  return {
    level: r.level,
    levelText: r.levelText,
    levelCls: r.levelCls,
    levelWindow: r.levelWindow,
    levelAdvice: r.levelAdvice,
    emergency: !!r.emergency,
    redFlagAction: r.redFlagAction || '',
    redFlagLabels: (r.redFlags || []).map((f) => f.label),
    dept: p.dept || FALLBACK_DEPT,
    deptIntro: (r.departmentInfo && r.departmentInfo.intro) || '',
    deptFloor: (r.departmentInfo && r.departmentInfo.floor) || '',
    navigable: !!r.navigable,
    confidenceText: (p.confidence && p.confidence.text) || '',
    reasons: p.reasons || [],
    alternates: (r.alternates || []).map((a) => a.dept).filter(Boolean),
    slotsText: r.slotsText || '',
    symptomText: (r.slots && r.slots.raw) || '',
    nextSteps: buildNextSteps(r),
    disclaimer: r.disclaimer || ''
  }
}

/** 下一步动作清单（把"分级建议"落成可执行步骤，避免用户看完不知道该干什么） */
function buildNextSteps(r) {
  const dept = (r.primary && r.primary.dept) || FALLBACK_DEPT
  const nav = r.navigable
  switch (r.level) {
    case 'emergency':
      return [
        '立即拨打 120 或前往最近医院急诊科（不要等待门诊）',
        '胸痛/卒中/呼吸困难时不要自行驾车，保持安静等待救援',
        '带上既往病历、正在服用的药物或药盒，方便医生判断'
      ]
    case 'urgent':
      return [
        '今天尽快到医院就诊，必要时直接走急诊',
        '携带既往病历、检查报告与用药清单',
        '前往「' + dept + '」分诊/挂号（以医院现场分诊为准）'
      ]
    case 'semi':
      return [
        '近 1~3 天预约「' + dept + '」门诊',
        nav ? '到院后可用院内导航按蓝色路线前往' : '到院后咨询导诊台确定诊室位置',
        '若出现高热不退、剧烈疼痛、呼吸困难等变化，请及时急诊'
      ]
    case 'routine':
      return [
        '按门诊时间预约「' + dept + '」',
        nav ? '到院后可用院内导航前往该科室' : '到院后咨询导诊台确定诊室位置',
        '就诊时把症状变化、持续时间和用药情况告诉医生'
      ]
    default:
      return [
        '可先休息观察 2~3 天，规律作息、清淡饮食、适量饮水',
        '记录症状变化（时间、程度、诱因），便于就诊时描述',
        '症状加重或出现新症状，请及时就诊'
      ]
  }
}

module.exports = {
  normalize,
  isNegated,
  extractSlots,
  matchRedFlags,
  scoreDepartments,
  decideLevel,
  nextQuestion,
  analyze,
  describeSlots,
  mergeRemote,
  toReport,
  normalizeDept,
  FALLBACK_DEPT
}
