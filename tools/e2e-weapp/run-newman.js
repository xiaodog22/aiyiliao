/*
 * run-newman.js —— Postman / Newman 接口回归适配器
 *
 * 只探测本机已安装的 runner 与用户提供的 collection；不自动安装、不造 collection、
 * 不伪造结果。runner 或 collection 缺失即明确 SKIP。
 * 结果映射到统一 schema 的 stage=api 片段（Newman JSON reporter 可解析；
 * Postman CLI 的结构化 reporter 未在本机验证，取不到就如实标注）。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function detectRunner(cfg) {
  for (const bin of ['newman', 'postman']) {
    const r = spawnSync(bin, ['--version'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, shell: cfg.IS_WIN
    })
    if (r.status === 0) {
      return { bin, version: (String(r.stdout || '').trim().split(/\r?\n/)[0] || '未知版本').slice(0, 80) }
    }
  }
  return null
}

function runNewman(cfg, opts = {}) {
  const runner = detectRunner(cfg)
  if (!runner) {
    return {
      stage: 'api', tool: 'postman-cli/newman', status: 'SKIP',
      reason: 'PATH 中未找到 postman / newman（未自动安装依赖）',
      samples: 0, errors: 0, p95_ms: null, assertions: null, artifacts: []
    }
  }
  const collection = opts.collection || process.env.E2E_POSTMAN_COLLECTION
  if (!collection || !fs.existsSync(path.resolve(collection))) {
    return {
      stage: 'api', tool: runner.bin, version: runner.version, status: 'SKIP',
      reason: '未提供有效的 Postman Collection（用 --collection=<绝对路径.json> 或 E2E_POSTMAN_COLLECTION）',
      samples: 0, errors: 0, p95_ms: null, assertions: null, artifacts: []
    }
  }

  const outDir = path.join(cfg.ARTIFACTS, 'newman-' + Date.now())
  fs.mkdirSync(outDir, { recursive: true })
  const jsonOut = path.join(outDir, 'newman-result.json')
  const isNewman = runner.bin === 'newman'
  const args = isNewman
    ? ['run', path.resolve(collection), '-r', 'json', '--reporter-json-export', jsonOut]
    : ['collection', 'run', path.resolve(collection)]
  if (process.env.E2E_POSTMAN_ENV) args.push('-e', path.resolve(process.env.E2E_POSTMAN_ENV))

  const r = spawnSync(runner.bin, args, {
    cwd: cfg.ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true, shell: cfg.IS_WIN
  })
  const stdoutLog = path.join(outDir, 'runner-stdout.log')
  const stderrLog = path.join(outDir, 'runner-stderr.log')
  fs.writeFileSync(stdoutLog, String(r.stdout || ''))
  fs.writeFileSync(stderrLog, String(r.stderr || ''))

  let assertions = null, iterations = 0, failed = 0, parsed = true
  if (isNewman && fs.existsSync(jsonOut)) {
    try {
      const j = JSON.parse(fs.readFileSync(jsonOut, 'utf8'))
      const s = j.stats || {}
      assertions = { total: (s.assertions || {}).total || 0, failed: (s.assertions || {}).failed || 0 }
      iterations = (s.iterations || {}).total || 0
      failed = assertions.failed
    } catch (e) { parsed = false }
  } else if (!isNewman) {
    parsed = false
  }

  const notes = []
  if (r.error) notes.push('进程启动失败：' + r.error.message)
  if (r.status !== 0) notes.push('runner exit=' + r.status)
  if (!parsed) notes.push('结构化 JSON 报告不可用（Postman CLI reporter 未验证或 JSON 解析失败），仅记录原始输出')
  const status = (r.error || r.status !== 0 || failed > 0) ? 'FAIL' : 'PASS'

  return {
    stage: 'api', tool: runner.bin, version: runner.version, status,
    reason: notes.join('；'),
    samples: iterations, errors: failed, p95_ms: null,
    assertions, collection: path.resolve(collection), outDir,
    artifacts: [jsonOut, stdoutLog, stderrLog].filter(p => fs.existsSync(p))
  }
}

module.exports = { runNewman, detectRunner }

if (require.main === module) {
  const cfg = require('./config')
  const arg = process.argv.slice(2).find(a => a.startsWith('--collection='))
  const r = runNewman(cfg, { collection: arg ? arg.slice('--collection='.length) : undefined })
  console.log(JSON.stringify(r, null, 2))
  if (r.status.startsWith('FAIL')) process.exitCode = 1
}
