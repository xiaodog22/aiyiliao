/**
 * gen-triage-flags.js —— 急症红旗单一事实源的生成/校验工具（2026-11-22 L1/L12 整改）
 *
 * 唯一手写源：
 *   shared/triage-redflags.json（15 类规则 + 金标准样本 + 负样本）
 * 生成物（禁止手改）：
 *   miniprogram/utils/triage-red-flags.js     前端数据模块（triage-kb.js 再导出）
 *   backend/business-service/.../triage/RedFlagRules.java   服务端常量类
 * 校验物：
 *   tools/data/triage-golden.json 的 redFlagCases 必须与源里 cases 逐条一致
 *
 * 用法：
 *   node tools/gen-triage-flags.js            # 生成两个产物；golden 不一致则失败
 *   node tools/gen-triage-flags.js --check    # 只校验三处一致（CI 门禁）
 *
 * 退出码：0 一致/已生成；1 漂移或源数据非法。
 *
 * 为什么 Java 用常量类而不是运行时读 JSON：
 *   打包后的 classpath/工作目录在多环境不一致，读文件失败会让「急症词表为空」变成
 *   静默 fail-open（最危险的降级）；常量类在编译期固化，缺数据直接编译失败。
 * 为什么前端生成 JS 而不是 require JSON：
 *   微信小程序对 require JSON 的支持依基础库而异，生成 .js 可保证所有基础库可用。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SOURCE = path.join(ROOT, 'shared', 'triage-redflags.json')
const JS_TARGET = path.join(ROOT, 'miniprogram', 'utils', 'triage-red-flags.js')
const JAVA_TARGET = path.join(ROOT, 'backend', 'business-service', 'src', 'main', 'java',
  'com', 'wechar', 'biz', 'triage', 'RedFlagRules.java')
const GOLDEN = path.join(ROOT, 'tools', 'data', 'triage-golden.json')
const PARITY = path.join(ROOT, 'tools', 'data', 'triage-parity.json')
const ENGINE = path.join(ROOT, 'miniprogram', 'utils', 'triage-engine.js')
const KB = path.join(ROOT, 'miniprogram', 'utils', 'triage-kb.js')

const RULE_ID_RE = /^[a-z][a-z0-9_]{2,39}$/

function loadSource() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error('缺少唯一事实源：' + path.relative(ROOT, SOURCE))
  }
  const data = JSON.parse(fs.readFileSync(SOURCE, 'utf-8'))
  const rules = data.rules
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('shared/triage-redflags.json 的 rules 必须是非空数组')
  }
  const ids = new Set()
  rules.forEach((rule) => {
    if (!RULE_ID_RE.test(rule.id || '')) {
      throw new Error('非法规则 id: ' + JSON.stringify(rule.id) + '（须为小写字母/数字/下划线，3~40 字符）')
    }
    if (ids.has(rule.id)) throw new Error('规则 id 重复: ' + rule.id)
    ids.add(rule.id)
    if (!Array.isArray(rule.any) || rule.any.length === 0) {
      throw new Error('规则 ' + rule.id + ' 缺少 any 关键词')
    }
    ;['any', 'all', 'none'].forEach((field) => {
      const list = rule[field]
      if (list === undefined) return
      if (!Array.isArray(list) || list.some((k) => typeof k !== 'string' || !k.trim())) {
        throw new Error('规则 ' + rule.id + ' 的 ' + field + ' 必须是非空字符串数组')
      }
    })
    if (typeof rule.label !== 'string' || !rule.label.trim()) {
      throw new Error('规则 ' + rule.id + ' 缺少 label')
    }
    if (!Number.isInteger(rule.weight) || rule.weight <= 0) {
      throw new Error('规则 ' + rule.id + ' 的 weight 必须是正整数')
    }
    if (typeof rule.advice !== 'string' || !rule.advice.trim()) {
      throw new Error('规则 ' + rule.id + ' 缺少 advice')
    }
  })

  const cases = data.cases
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('shared/triage-redflags.json 的 cases 必须是非空数组')
  }
  const caseIds = new Set()
  const covered = new Set()
  cases.forEach((c) => {
    if (!c.id || caseIds.has(c.id)) throw new Error('金标准样本 id 缺失或重复: ' + c.id)
    caseIds.add(c.id)
    if (!c.text || !c.text.trim()) throw new Error('样本 ' + c.id + ' 缺少 text')
    if (!ids.has(c.redFlag)) throw new Error('样本 ' + c.id + ' 的 redFlag 不是已知规则: ' + c.redFlag)
    covered.add(c.redFlag)
  })
  const unseen = [...ids].filter((id) => !covered.has(id))
  if (unseen.length) throw new Error('以下规则没有任何金标准样本（评测盲区）: ' + unseen.join(', '))

  const negatives = data.negativeCases || []
  if (!Array.isArray(negatives) || negatives.length === 0) {
    throw new Error('negativeCases 必须是非空数组（防误报基线不得为空）')
  }
  negatives.forEach((c) => {
    if (!c.id || !c.text) throw new Error('负样本缺少 id/text')
  })

  // 否定语义（B1）：前后端必须消费同一份规格，禁止各写一套词表。
  const negation = data.negation
  if (!negation || typeof negation !== 'object') {
    throw new Error('缺少 negation 否定语义规格')
  }
  if (!Number.isInteger(negation.window) || negation.window < 1
      || !Number.isInteger(negation.maxGap) || negation.maxGap < 0) {
    throw new Error('negation.window / maxGap 必须是合法整数')
  }
  ;['negations', 'contrasts', 'triggerNouns'].forEach((field) => {
    const list = negation[field]
    if (!Array.isArray(list) || list.length === 0
        || list.some((k) => typeof k !== 'string' || !k.trim())) {
      throw new Error('negation.' + field + ' 必须是非空字符串数组')
    }
  })
  const weak = negation.weak || {}
  if (typeof weak.char !== 'string' || !weak.char
      || typeof weak.modifiers !== 'string'
      || !Number.isInteger(weak.maxModifiers) || weak.maxModifiers < 0) {
    throw new Error('negation.weak 规格非法（需 char / modifiers / maxModifiers）')
  }

  // 否定语料：redFlag=null 表示期望不命中任何红旗。
  const negationCases = data.negationCases || []
  if (!Array.isArray(negationCases) || negationCases.length === 0) {
    throw new Error('negationCases 必须是非空数组（否定语义不得无回归样本）')
  }
  negationCases.forEach((c) => {
    if (!c.id || caseIds.has(c.id)) throw new Error('否定语料 id 缺失或重复: ' + c.id)
    caseIds.add(c.id)
    if (!c.text || !c.text.trim()) throw new Error('否定语料 ' + c.id + ' 缺少 text')
    if (c.redFlag !== null && !ids.has(c.redFlag)) {
      throw new Error('否定语料 ' + c.id + ' 的 redFlag 不是已知规则: ' + c.redFlag)
    }
  })

  return { data, rules, cases, negatives, negation, negationCases }
}

function jsString(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'"
}

function jsList(items) {
  return '[' + (items || []).map(jsString).join(', ') + ']'
}

function buildJs(rules, negation) {
  const body = rules.map((rule) => {
    const lines = []
    if (rule.note) lines.push('    // ' + String(rule.note).replace(/\r?\n/g, ' '))
    lines.push('    id: ' + jsString(rule.id) + ', label: ' + jsString(rule.label) +
      ', weight: ' + rule.weight + ',')
    lines.push('    any: ' + jsList(rule.any) + ',')
    lines.push('    all: ' + jsList(rule.all || []) + ',')
    lines.push('    none: ' + jsList(rule.none || []) + ',')
    lines.push('    advice: ' + jsString(rule.advice))
    return '  {\n' + lines.join('\n') + '\n  }'
  }).join(',\n')

  const neg = '{\n' +
    '  window: ' + negation.window + ',\n' +
    '  maxGap: ' + negation.maxGap + ',\n' +
    '  negations: ' + jsList(negation.negations) + ',\n' +
    '  contrasts: ' + jsList(negation.contrasts) + ',\n' +
    '  triggerNouns: ' + jsList(negation.triggerNouns) + ',\n' +
    '  weak: { char: ' + jsString(negation.weak.char) +
    ', modifiers: ' + jsString(negation.weak.modifiers) +
    ', maxModifiers: ' + negation.weak.maxModifiers + ' }\n' +
    '}'

  return `/**
 * triage-red-flags.js —— 急症红旗数据模块（AUTO-GENERATED，禁止手改）
 *
 * 源：shared/triage-redflags.json（唯一手写事实源）
 * 生成器：tools/gen-triage-flags.js
 * 门禁：node tools/gen-triage-flags.js --check（CI frontend job）
 *
 * 为什么生成 .js 而不是 require JSON：微信小程序对 JSON require 的兼容性依基础库而异，
 * 生成普通 JS 模块可保证所有基础库可用；语义与前端 triage-engine.js / 服务端
 * TriageRuleEngine 同构：any 任一命中；all 非空时至少命中一个；none 出现即排除。
 *
 * ⚠️ 改词表只改 shared/triage-redflags.json，然后跑 node tools/gen-triage-flags.js。
 * ⚠️ 合规红线：只做分诊建议，不做诊断；红旗命中一律引导线下急救，绝不建议观察。
 */
const RED_FLAGS = [
${body}
]

/** 否定语义（B1）：前端 isNegated 与服务端 TriageRuleEngine.denied 共用同一规格。 */
const NEGATION = ${neg}

module.exports = { RED_FLAGS, NEGATION }
`
}

function javaString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function javaList(items) {
  if (!items || items.length === 0) return 'List.of()'
  return 'List.of(\n                    ' + items.map(javaString).join(', ') + ')'
}

function buildJava(rules, negation) {
  const body = rules.map((rule) => [
    '            new Rule(' + javaString(rule.id) + ', ' + javaString(rule.label) + ',',
    '                    ' + javaString(rule.advice) + ',',
    '                    ' + javaList(rule.any) + ',',
    '                    ' + javaList(rule.all || []) + ',',
    '                    ' + javaList(rule.none || []) + ')'
  ].join('\n')).join(',\n')

  const weakRegex = negation.weak.char + '[' + negation.weak.modifiers +
    ']{0,' + negation.weak.maxModifiers + '}$'

  return `package com.wechar.biz.triage;

import java.util.List;

/**
 * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * <p>源：shared/triage-redflags.json（急症红旗唯一手写事实源）
 * <br>生成器：tools/gen-triage-flags.js
 * <br>门禁：node tools/gen-triage-flags.js --check（CI frontend job）
 *
 * <p>为什么生成 Java 常量而不是运行时读 JSON：读文件失败会让急症词表为空，
 * 属静默 fail-open；常量类在编译期固化，缺数据直接编译失败。
 *
 * <p>语义（与前端 triage-engine.js matchRedFlags 同构）：
 * any 任一命中；all 非空时还需至少命中一个；none 出现即排除。
 */
public final class RedFlagRules {

    /** 单条急症规则；none 当前为空，保留字段以兼容前端语义。 */
    public record Rule(String id, String label, String advice,
                       List<String> any, List<String> all, List<String> none) {
    }

    public static final List<Rule> ALL = List.of(
${body}
    );

    /**
     * 否定语义（B1）：与前端 triage-engine.isNegated 共用 shared 规格。
     *
     * <p>「无/没/没有 + 诱因|原因」修饰的是诱因（无明确诱因的胸痛），
     * 不是否认胸痛；TRIGGER_NOUNS 命中时不得把急症关键词吞掉。
     */
    public static final class Negation {
        public static final int WINDOW = ${negation.window};
        public static final int MAX_GAP = ${negation.maxGap};
        public static final List<String> WORDS = ${javaList(negation.negations)};
        public static final List<String> CONTRASTS = ${javaList(negation.contrasts)};
        public static final List<String> TRIGGER_NOUNS = ${javaList(negation.triggerNouns)};
        /** 弱否定「不」：只认紧邻或隔一个程度词（不舒服3天 不吞 3天）。 */
        public static final String WEAK_TAIL_REGEX = ${javaString(weakRegex)};
        /** 弱否定回看跨度：否定字 + 最多程度词数 + 1 个缓冲字。 */
        public static final int WEAK_SPAN = ${negation.weak.char.length + negation.weak.maxModifiers + 1};

        private Negation() {
        }
    }

    private RedFlagRules() {
    }
}
`
}

/** golden 红旗样本必须与源里 cases 逐条一致（防止 eval 用的样本与词表分叉）。 */
function goldenDrift(cases) {
  if (!fs.existsSync(GOLDEN)) return ['缺少 ' + path.relative(ROOT, GOLDEN)]
  let golden
  try {
    golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf-8'))
  } catch (e) {
    return ['golden 不是合法 JSON：' + e.message]
  }
  const got = golden.redFlagCases || []
  const problems = []
  if (got.length !== cases.length) {
    problems.push('golden 红旗样本数 ' + got.length + ' ≠ 源 ' + cases.length)
  }
  const n = Math.min(got.length, cases.length)
  for (let i = 0; i < n; i++) {
    const a = got[i]
    const b = cases[i]
    ;['id', 'text', 'redFlag'].forEach((k) => {
      if (a[k] !== b[k]) {
        problems.push('第 ' + (i + 1) + ' 条 ' + k + ' 不一致：golden=' + JSON.stringify(a[k]) +
          ' 源=' + JSON.stringify(b[k]))
      }
    })
  }
  return problems
}

/**
 * 生成前后端差分基线：用**前端引擎**对全部语料跑一遍，把 HIT/MISS 落盘。
 * 服务端 TriageRedFlagParityTest 逐条对齐该文件 → 同一输入前后端结果必须一致。
 *
 * 在临时目录内用「本次将要生成的」triage-red-flags.js 计算，避免 --check
 * 模式读到磁盘上的旧生成物而产生假一致。
 */
function buildParity(data, jsSource) {
  const os = require('os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-parity-'))
  try {
    fs.writeFileSync(path.join(tmp, 'triage-red-flags.js'), jsSource, 'utf-8')
    fs.copyFileSync(ENGINE, path.join(tmp, 'triage-engine.js'))
    fs.copyFileSync(KB, path.join(tmp, 'triage-kb.js'))
    // eslint-disable-next-line global-require
    const engine = require(path.join(tmp, 'triage-engine.js'))
    const corpus = [...data.cases, ...(data.negationCases || []), ...(data.negativeCases || [])]
    const seen = new Set()
    const entries = []
    corpus.forEach((c) => {
      if (seen.has(c.text)) return
      seen.add(c.text)
      const flags = engine.matchRedFlags(c.text) || []
      entries.push({
        id: c.id,
        text: c.text,
        emergency: flags.length > 0,
        rules: flags.map((f) => f.id).sort()
      })
    })
    return JSON.stringify({
      version: 'triage-parity-v1',
      note: 'AUTO-GENERATED 差分基线：前端 matchRedFlags 的计算结果，服务端 scanText 必须逐条一致。',
      source: 'shared/triage-redflags.json',
      generator: 'tools/gen-triage-flags.js',
      entries
    }, null, 2) + '\n'
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function main() {
  const { data, rules, cases, negation, negationCases, negatives } = loadSource()
  const js = buildJs(rules, negation)
  const java = buildJava(rules, negation)
  const parity = buildParity(data, js)
  const check = process.argv.includes('--check')
  const drift = goldenDrift(cases)

  if (check) {
    let failed = false
    ;[[JS_TARGET, js, '前端数据模块'], [JAVA_TARGET, java, '服务端词表'],
      [PARITY, parity, '前后端差分基线']].forEach(([file, want, name]) => {
      if (!fs.existsSync(file)) {
        console.error('TRIAGE_FLAGS_CHECK_FAIL ' + name + '不存在：' + path.relative(ROOT, file))
        failed = true
        return
      }
      const current = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n')
      if (current !== want.replace(/\r\n/g, '\n')) {
        console.error('TRIAGE_FLAGS_CHECK_FAIL ' + name + '与 shared/triage-redflags.json 不一致。')
        failed = true
      }
    })
    if (drift.length) {
      console.error('TRIAGE_FLAGS_CHECK_FAIL tools/data/triage-golden.json 红旗样本与源不一致：')
      drift.forEach((d) => console.error('  · ' + d))
      failed = true
    }
    if (failed) {
      console.error('修复：node tools/gen-triage-flags.js（并按提示同步 golden 红旗样本）后提交。')
      process.exit(1)
    }
    console.log('TRIAGE_FLAGS_CHECK_OK ' + rules.length + ' 类 / ' + cases.length +
      ' 红旗样本 / ' + negationCases.length + ' 否定语料 / ' + negatives.length + ' 负样本')
    return
  }

  fs.writeFileSync(JS_TARGET, js, 'utf-8')
  fs.writeFileSync(JAVA_TARGET, java, 'utf-8')
  fs.writeFileSync(PARITY, parity, 'utf-8')
  console.log('TRIAGE_FLAGS_GENERATED ' + path.relative(ROOT, JS_TARGET) + ' + ' +
    path.relative(ROOT, JAVA_TARGET) + ' + ' + path.relative(ROOT, PARITY) + ' | ' +
    rules.length + ' 类')
  if (drift.length) {
    console.error('TRIAGE_FLAGS_GOLDEN_DRIFT tools/data/triage-golden.json 需同步：')
    drift.forEach((d) => console.error('  · ' + d))
    process.exit(1)
  }
  console.log('TRIAGE_FLAGS_GOLDEN_OK ' + cases.length + ' 红旗样本一致')
}

try {
  main()
} catch (e) {
  console.error('TRIAGE_FLAGS_FAIL ' + (e && e.message ? e.message : e))
  process.exit(1)
}
