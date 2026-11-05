#!/usr/bin/env node
/**
 * 性能回归门禁（2026-11-01）。
 *
 * 定位：把性能从"一次性报告"变成"持续防线"。
 * 报告只在被测那天有效；代码继续改，性能会悄悄退化，而契约测试/单元测试都拦不住
 * —— PERF-09（/doctors N+1）就是这么溜了两个月的：功能全对、响应结构全对，只是 SQL 从 3 次变 41 次。
 *
 * 用法：
 *   node tools/perf-gate.js                        # 跑门禁：25VU/20s 单轮，与基线比对，退化则 exit 1
 *   node tools/perf-gate.js --rounds=3             # 三轮取中位数（CI 推荐；单轮易被抖动误杀）
 *   node tools/perf-gate.js --update-baseline      # 用本次结果覆盖基线（只在确认性能变好时用）
 *   node tools/perf-gate.js --workers=4            # 声明当前部署的 worker 数（写进基线，用于配置一致性检查）
 *
 * ── 判定口径（budget 可在基线文件里调）────────────────────────────────────────
 *   - RPS 相对基线下降 > 10%      → 失败（吞吐退化）
 *   - P95 相对基线上升 > 20%      → 失败（延迟退化）
 *   - 错误率 > 0.5%               → 失败（稳定性退化）
 *   - 无基线文件                  → 自动建立基线并退出 0（首次接入不该红）
 *   - 部署/硬件配置与基线不一致    → SKIP 并退出 0（配置变更不是代码退化，见下）
 *
 * ── 噪声基线与阈值余量（改阈值前必读）──────────────────────────────────────
 * 同口径复跑（同代码、同配置、同机器）实测波动约 **RPS ±2% / P95 ±3%**（n=3~4 轮）。
 * 取 10% / 20% 的预算，是给噪声留 **3~7 倍余量**，用来吸收 GC 时点、OS 调度、
 * 施压端自身抖动、后台进程抢占等不可控因素。
 *
 * ⚠️ **不要把预算收紧到 5% 一类的量级**：那低于实测噪声，门禁会变成随机红，
 *    团队两周内就会给它加 `|| true`——一个被绕过的门禁比没有门禁更糟。
 *    如果确实需要更灵敏的信号，正确做法是加大 --rounds 取中位数（降噪），而不是压预算。
 *
 * ── 为什么绑定部署配置 ────────────────────────────────────────────────────
 * 基线是"某个代码版本 × 某个部署配置 × 某台机器"的快照。配置变了，数字就不该直接比：
 *   - 1 worker → 4 workers：性能正常提升，不更新基线也不该判"退化"，但数字已不可比；
 *   - 4 workers → 1 worker：数字暴跌 60%，这不是代码退化，是配置回退——判 FAIL 会误导排障；
 *   - 换机器 / 换 CPU：整组数字平移，同理。
 * 所以基线里记录 workerCount / hardware / codeVersion，比对前先校一致性；
 * 不一致 → 打印差异后 SKIP（exit 0），要求显式 `--update-baseline` 建立新基线。
 *
 * 为什么不直接内联压测逻辑：复用 tools/perf-runner.js 的闭合环、分位统计、业务码校验、
 * 主机采样，避免两套口径漂移。门禁只做"跑 N 轮 → 取中位数 → 比对"。
 */

'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BASELINE_PATH = path.join(ROOT, 'artifacts', 'perf', 'baseline.json')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const VU = Number(arg('vu', 25))
const DURATION = Number(arg('duration', 20))
const BASE = arg('base', 'http://127.0.0.1:8080')
const UPDATE = flag('update-baseline')
const TAG = arg('tag', 'gate')
/** 轮数：单轮最快但易抖动；CI 建议 3 轮取中位数。 */
const ROUNDS = Math.max(1, Number(arg('rounds', 1)))
/** 当前部署的 worker 数；单 worker 是默认。仅用于基线一致性判定，不影响施压。 */
const WORKERS = Number(arg('workers', 1))
const DATA_VERSION = arg('data-version', 'unspecified')

/** 默认预算：吞吐掉 10%、P95 涨 20%、错误率 0.5% 即判失败。 */
const DEFAULT_BUDGET = { rpsDropPct: 10, p95RisePct: 20, maxErrorRatePct: 0.5 }

/** 与基线绑定、但不参与数值比较的环境指纹。 */
function readEnvMeta() {
  const cpus = os.cpus()
  return {
    // 压测口径（VU/时长）也进指纹：不同口径的数字不可直接相比
    vu: VU,
    duration: DURATION,
    workerCount: WORKERS,
    hardware: {
      cpu: String(cpus[0]?.model || 'unknown').trim(),
      cores: cpus.length,
      memGB: Math.round((os.totalmem() / 1073741824) * 10) / 10,
    },
    codeVersion: gitShortHash(),
    dataVersion: DATA_VERSION,
  }
}

/** 取当前 git 短哈希；仓库不可用/未初始化时返回 'unknown'，不阻断门禁。 */
function gitShortHash() {
  try {
    const p = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
    if (p.status === 0) return String(p.stdout).trim()
  } catch (e) {
    /* 忽略：门禁不因版本信息缺失而失败 */
  }
  return 'unknown'
}

/** 比较基线与当前的环境指纹，返回人类可读的差异列表（空数组 = 一致）。 */
function diffEnv(before, now) {
  if (!before) return ['基线未记录环境指纹（旧版基线），无法确认可比性']
  const diffs = []
  // 压测口径本身也要一致：VU/时长不同，数字没有可比性（50VU 的 P95 天然高于 25VU）
  if (Number(before.vu) !== Number(now.vu)) diffs.push(`并发 ${before.vu} → ${now.vu} VU`)
  if (Number(before.duration) !== Number(now.duration)) diffs.push(`时长 ${before.duration}s → ${now.duration}s`)
  if (Number(before.workerCount) !== Number(now.workerCount)) {
    diffs.push(`workerCount ${before.workerCount} → ${now.workerCount}`)
  }
  const bh = before.hardware || {}
  if (String(bh.cpu || '') !== now.hardware.cpu) diffs.push(`CPU "${bh.cpu}" → "${now.hardware.cpu}"`)
  if (Number(bh.cores) !== now.hardware.cores) diffs.push(`核数 ${bh.cores} → ${now.hardware.cores}`)
  // 内存允许 10% 误差（同一台机器上 Windows 可用内存报告会浮动）
  const bm = Number(bh.memGB || 0)
  if (bm > 0 && Math.abs(bm - now.hardware.memGB) / bm > 0.1) {
    diffs.push(`内存 ${bm}GB → ${now.hardware.memGB}GB`)
  }
  if (String(before.dataVersion || '') !== String(now.dataVersion || '')) {
    // 数据版本只在两边都显式声明时才当差异（unspecified 视为"未声明"，不阻断）
    if (String(before.dataVersion || '') !== 'unspecified' && String(now.dataVersion || '') !== 'unspecified') {
      diffs.push(`dataVersion ${before.dataVersion} → ${now.dataVersion}`)
    }
  }
  return diffs
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  } catch (e) {
    console.error(`[gate] 基线文件损坏，忽略并按"无基线"处理：${e.message}`)
    return null
  }
}

function writeBaseline(agg, budget, env) {
  const payload = {
    updatedAt: new Date().toISOString().slice(0, 10),
    note:
      '性能回归门禁基线；--update-baseline 覆盖。口径：闭合环无思考时间、施压端与被压端同机。'
      + ' 同口径复跑噪声实测 RPS ±2% / P95 ±3%（n=3~4），预算取 10%/20% 留 3~7 倍余量。',
    budget,
    env,
    baseline: {
      vu: agg.vu,
      duration: agg.durationSec,
      rps: agg.rps,
      p50: agg.latency.p50,
      p95: agg.latency.p95,
      p99: agg.latency.p99,
      errorRatePct: agg.errorRatePct ?? 0,
      scenario: agg.scenario,
      rounds: agg.rounds,
    },
  }
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

/** 跑一轮施压，返回解析后的结果。tag 每轮唯一，避免覆盖同名结果文件。 */
function runPerfRunner(tag) {
  const args = [
    path.join(__dirname, 'perf-runner.js'),
    '--scenario=read',
    `--vu=${VU}`,
    `--duration=${DURATION}`,
    `--base=${BASE}`,
    `--tag=${tag}`,
  ]
  const token = arg('token', null)
  if (token) args.push(`--token=${token}`)

  console.log(`[gate] 施压 ${VU} VU / ${DURATION}s → ${BASE}（${tag}）`)
  const proc = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  if (proc.status !== 0) {
    console.error('[gate] 施压进程异常退出，无法判定（先修环境，别把环境问题当性能退化）')
    process.exit(2)
  }
  const resultPath = path.join(ROOT, 'artifacts', 'perf', `result-${tag}.json`)
  if (!fs.existsSync(resultPath)) {
    console.error(`[gate] 找不到结果文件 ${resultPath}`)
    process.exit(2)
  }
  return JSON.parse(fs.readFileSync(resultPath, 'utf8'))
}

/** 中位数（偶数个取中间两值均值）。空数组返回 0。 */
function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * 多轮聚合成单一判定值：数值指标取**中位数**，错误率取**最大值**。
 * 为什么不用"取最好值"：最好值会系统性掩盖退化（抖动一次就能骗过门禁）；
 * 中位数对单轮离群既不敏感也不偏乐观。错误率取最大是保守侧——偶发错误不该被平均掉。
 */
function aggregate(results) {
  const rps = median(results.map((r) => r.rps))
  const errMax = Math.max(...results.map((r) => r.errorRatePct ?? 0))
  const last = results[results.length - 1]
  return {
    vu: last.vu,
    durationSec: last.durationSec,
    scenario: last.scenario,
    rounds: results.length,
    rps: Math.round(rps * 10) / 10,
    latency: {
      p50: Math.round(median(results.map((r) => r.latency.p50)) * 10) / 10,
      p95: Math.round(median(results.map((r) => r.latency.p95)) * 10) / 10,
      p99: Math.round(median(results.map((r) => r.latency.p99)) * 10) / 10,
    },
    errorRatePct: errMax,
  }
}

function pct(now, before) {
  if (!before) return 0
  return ((now - before) / before) * 100
}

function main() {
  const env = readEnvMeta()
  const existing = readBaseline()

  // ── 配置一致性闸门放在施压**之前**：口径/配置不一致时跑一轮纯属浪费，
  //    而且会把"配置变更"的脏数据写进 result-*.json，干扰后续对比。
  if (existing && !UPDATE) {
    const envDiffs = diffEnv(existing.env, env)
    if (envDiffs.length) {
      console.warn('\n[gate] ⚠️ 部署/硬件/口径与基线不一致，未施压即跳过判定：')
      for (const d of envDiffs) console.warn(`  · ${d}`)
      console.warn('[gate] 结论：SKIP（配置变更不是代码退化，直接比数字会误判）')
      console.warn('[gate] 处置：确认新配置为常态后执行 --update-baseline 建立新基线；'
        + '若只是临时对比，请显式记录本次数值而不要改基线。')
      process.exit(0)
    }
  }

  const results = []
  for (let i = 1; i <= ROUNDS; i++) {
    results.push(runPerfRunner(ROUNDS === 1 ? TAG : `${TAG}-r${i}`))
  }
  const agg = aggregate(results)

  console.log(
    `\n[gate] 本次结果（${ROUNDS} 轮取中位数）：`
    + `RPS ${agg.rps} | P50 ${agg.latency.p50}ms | P95 ${agg.latency.p95}ms`
    + ` | 错误率 ${agg.errorRatePct.toFixed(3)}%`
  )
  if (ROUNDS > 1) {
    console.log(`[gate] 各轮 RPS：${results.map((r) => r.rps).join(' / ')}`)
    console.log(`[gate] 各轮 P95：${results.map((r) => `${r.latency.p95}ms`).join(' / ')}`)
  }

  if (!existing || UPDATE) {
    const budget = existing?.budget ?? DEFAULT_BUDGET
    const saved = writeBaseline(agg, budget, env)
    console.log(`[gate] ${existing ? '已更新' : '未找到基线，已自动建立'}基线：${BASELINE_PATH}`)
    console.log(`[gate] 基线值：RPS ${saved.baseline.rps} | P95 ${saved.baseline.p95}ms`
      + ` | ${env.workerCount} worker | ${env.hardware.cores} 核`)
    console.log('[gate] 结论：PASS（基线建立）')
    process.exit(0)
  }

  // 配置一致性已在施压前校验过，此处必然一致（保留断言式注释，避免将来挪动代码时漏掉）
  const b = existing.baseline
  const budget = { ...DEFAULT_BUDGET, ...(existing.budget ?? {}) }
  const rpsDelta = pct(agg.rps, b.rps)
  const p95Delta = pct(agg.latency.p95, b.p95)

  const failures = []
  if (rpsDelta < -budget.rpsDropPct) {
    failures.push(`吞吐下降 ${Math.abs(rpsDelta).toFixed(1)}% > 预算 ${budget.rpsDropPct}%（${b.rps} → ${agg.rps} RPS）`)
  }
  if (p95Delta > budget.p95RisePct) {
    failures.push(`P95 上升 ${p95Delta.toFixed(1)}% > 预算 ${budget.p95RisePct}%（${b.p95} → ${agg.latency.p95}ms）`)
  }
  if (agg.errorRatePct > budget.maxErrorRatePct) {
    failures.push(`错误率 ${agg.errorRatePct.toFixed(3)}% > 预算 ${budget.maxErrorRatePct}%`)
  }

  console.log(
    `[gate] 对比基线（${existing.updatedAt} / ${b.vu} VU / ${b.duration}s / ${existing.env?.workerCount ?? '?'} worker）：`
    + `RPS ${rpsDelta >= 0 ? '+' : ''}${rpsDelta.toFixed(1)}% | P95 ${p95Delta >= 0 ? '+' : ''}${p95Delta.toFixed(1)}%`
  )

  if (failures.length) {
    console.error('\n[gate] 结论：FAIL')
    for (const f of failures) console.error(`  ✗ ${f}`)
    console.error('\n处置顺序（别跳步骤）：')
    console.error('  1) 先确认机器是否被别的进程占着（构建、杀毒、视频会议都会拉高 P95）——这类假阳性重跑即可')
    console.error('  2) 再确认是本次改动引入的退化（git diff 对照），是则回滚')
    console.error('  3) 若确认性能变好且属预期，用 --update-baseline 提基线')
    process.exit(1)
  }

  console.log('\n[gate] 结论：PASS（在预算内）')
  process.exit(0)
}

main()
