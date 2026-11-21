/**
 * gen-hospital-knowledge.js —— 院内知识库 ⑦ 生成式片段构建器（2026-11-21 治理合并）
 *
 * 单一事实源链路（禁止手抄）：
 *   ⑧ triage-departments.json  →  ⑦ triage「本院科室」片段（16 科室全量）
 *   ① triage-kb.js SYMPTOM_KB  →  ⑦ triage「常见症状科室映射」片段（15 科室，按权重排序）
 *   config/medical-redlines.json → ⑦ chat「禁忌与红线」片段（红线主清单唯一源）
 *
 * 同时校验：① DEPARTMENT_INFO 去掉非临床科室（放射科/检验科/药房）后必须与 ⑧ 的 16 科室一致。
 *
 * 用法（仓库根）：
 *   node tools/gen-hospital-knowledge.js          # 写回 ⑦
 *   node tools/gen-hospital-knowledge.js --check  # 只比对（门禁），漂移退出码 1
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..')
const TRIAGE_KB = require(path.join(REPO, 'miniprogram', 'utils', 'triage-kb.js'))
const WHITELIST = JSON.parse(fs.readFileSync(path.join(REPO, 'backend/ai-service/config/triage-departments.json'), 'utf8'))
const REDLINES = JSON.parse(fs.readFileSync(path.join(REPO, 'backend/ai-service/config/medical-redlines.json'), 'utf8'))
const KB_PATH = path.join(REPO, 'backend/ai-service/config/hospital-knowledge.json')

// ① 中仅供导航/位置展示、不得作为分诊推荐目标的非临床科室（2026-11-21 处置决策：标记不可推荐，不删除）
const NON_RECOMMENDABLE = ['放射科', '检验科', '药房']

// —— 校验一：① 临床科室集合 == ⑧ 白名单 ——
const kbDepts = Object.keys(TRIAGE_KB.DEPARTMENT_INFO)
const clinicalFrom1 = kbDepts.filter(d => !NON_RECOMMENDABLE.includes(d))
const names8 = WHITELIST.departments.map(d => d.name)
const missingIn8 = clinicalFrom1.filter(d => !names8.includes(d))
const missingIn1 = names8.filter(d => !clinicalFrom1.includes(d))
if (missingIn8.length || missingIn1.length) {
  console.error(`[gen] FAIL：①临床科室与⑧白名单不一致 ①独有=${missingIn8} ⑧独有=${missingIn1}`)
  process.exit(1)
}
// 非临床 3 科必须显式标 recommendable:false（防止被当推荐目标）；其余科室不得带该标记
for (const [dept, info] of Object.entries(TRIAGE_KB.DEPARTMENT_INFO)) {
  const shouldNotRecommend = NON_RECOMMENDABLE.includes(dept)
  if (shouldNotRecommend && info.recommendable !== false) {
    console.error(`[gen] FAIL：非临床科室「${dept}」未标 recommendable:false`)
    process.exit(1)
  }
  if (!shouldNotRecommend && info.recommendable === false) {
    console.error(`[gen] FAIL：临床科室「${dept}」被误标 recommendable:false`)
    process.exit(1)
  }
}

// —— 生成：triage「本院科室」（来源=⑧，全量 16 科室）——
const deptFragment = {
  topic: '本院科室',
  content: `本院开设科室：${names8.join('、')}。`,
  priority: 10,
  departments: names8,
  source: `generated: config/triage-departments.json v${WHITELIST.version}（${names8.length} 科室，tools/gen-hospital-knowledge.js）`,
  status: 'verified'
}

// —— 生成：triage「常见症状科室映射」（来源=① SYMPTOM_KB，按最高权重降序）——
// 保留权重口径：科室间按各自最高 w 降序；科室内取最高权重组的前 2 个关键词。
const mapped = TRIAGE_KB.SYMPTOM_KB.map(s => {
  const maxW = Math.max(...s.keys.map(k => k.w))
  const topKeys = s.keys.filter(k => k.w === maxW).flatMap(k => k.k).slice(0, 2)
  return { dept: s.dept, maxW, topKeys }
}).sort((a, b) => b.maxW - a.maxW)
const unknownDept = mapped.filter(m => !names8.includes(m.dept))
if (unknownDept.length) {
  console.error(`[gen] FAIL：SYMPTOM_KB 出现白名单外科室 ${unknownDept.map(m => m.dept)}`)
  process.exit(1)
}
const symptomFragment = {
  topic: '常见症状科室映射',
  content: `症状→科室（按主诉权重排序）：${mapped.map(m => `${m.topKeys.join('/')}→${m.dept}`).join('；')}。`,
  priority: 8,
  departments: mapped.map(m => m.dept),
  source: 'generated: miniprogram/utils/triage-kb.js SYMPTOM_KB（tools/gen-hospital-knowledge.js）',
  status: 'verified'
}

// —— 生成：chat「禁忌与红线」（来源=红线主清单）——
const redlineFragment = {
  topic: '禁忌与红线',
  content: REDLINES.consumers.chatFragmentContent,
  priority: 9,
  source: 'generated: config/medical-redlines.json consumers.chatFragmentContent',
  status: 'verified'
}

const EXPECTED = { triage: [deptFragment, symptomFragment], chat: [redlineFragment] }

// —— 预算核对（与 ⑨/⑬ 同口径：len×1.5，全片段总和 ≤ budgetTokens）——
const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'))
function applyFragments (data) {
  for (const [scenario, fragments] of Object.entries(EXPECTED)) {
    const items = data.scenarios[scenario].knowledge
    for (const frag of fragments) {
      const idx = items.findIndex(i => i.topic === frag.topic)
      if (idx < 0) items.push(JSON.parse(JSON.stringify(frag)))
      else items[idx] = JSON.parse(JSON.stringify(frag))
    }
  }
  return data
}
function budgetReport (data) {
  const lines = []
  for (const [name, block] of Object.entries(data.scenarios)) {
    const used = block.knowledge.reduce((s, i) => s + Math.floor(String(i.content).length * 1.5), 0)
    lines.push(`${name}: ${used}/${block.budgetTokens}${used > block.budgetTokens ? '  OVER!' : ''}`)
  }
  return lines
}

const generated = applyFragments(JSON.parse(JSON.stringify(kb)))
const over = budgetReport(generated).filter(l => l.includes('OVER'))
if (over.length) {
  console.error(`[gen] FAIL：生成后超预算 ${over.join(' | ')}（请调整 budgetTokens 或片段长度）`)
  process.exit(1)
}

const serialized = JSON.stringify(generated, null, 2) + '\n'
const current = fs.readFileSync(KB_PATH, 'utf8')

if (process.argv.includes('--check')) {
  if (current !== serialized) {
    const diffLines = []
    for (const [scenario, fragments] of Object.entries(EXPECTED)) {
      for (const frag of fragments) {
        const cur = kb.scenarios[scenario].knowledge.find(i => i.topic === frag.topic)
        if (!cur || cur.content !== frag.content || JSON.stringify(cur.departments || null) !== JSON.stringify(frag.departments || null) || cur.source !== frag.source) {
          diffLines.push(`${scenario}/${frag.topic}`)
        }
      }
    }
    console.error(`[gen] FAIL：⑦ 生成式片段与源不一致（禁止手改，请重跑 node tools/gen-hospital-knowledge.js）：${diffLines.join(', ') || '其他字段漂移'}`)
    process.exit(1)
  }
  console.log(`[gen] OK：①⑧科室一致（16）；⑦ 生成片段与源一致 | ${budgetReport(generated).join(' | ')}`)
  process.exit(0)
}

fs.writeFileSync(KB_PATH, serialized, 'utf8')
console.log(`[gen] 已写回 ⑦：本院科室 ${names8.length} 科、症状映射 ${mapped.length} 条、红线片段同源 | ${budgetReport(generated).join(' | ')}`)
