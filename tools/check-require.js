/**
 * require 相对路径解析校验
 * 背景：小程序静态语法检查查不出相对路径写错（如 pages/a/b/c.js 引 services/ 少一层 ../），
 * 只有真机运行时才暴露。故每次改动后必须跑本脚本。
 * 运行：node tools/check-require.js [根目录，默认 miniprogram]
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(process.argv[2] || 'miniprogram')
const RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * 允许缺失的「本地覆盖」文件（.gitignore 内，干净 clone 必然不存在）。
 *
 * 唯一允许项：miniprogram/config/env.local.js —— 档位 / 隧道域名 / 联调密钥的唯一来源，
 * 按审计 H8/H9 设计**不得入库**；config/env.js 已用 try/catch 可选加载（缺失即落 production）。
 * 若不豁免，干净 clone 上本脚本必红（2026-11-22 CI 实测：REQUIRE_FAIL）。
 *
 * 豁免必须限定到确切路径，不能用文件名通配 —— 否则别处写错同名路径也会被放过。
 */
const OPTIONAL_MISSING = [path.join(ROOT, 'config', 'env.local.js')]
const optionalHits = []

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

const resolve = (fromFile, target) => {
  if (!target.startsWith('.')) return null // 只校验相对路径
  const base = path.resolve(path.dirname(fromFile), target)
  return [base, base + '.js', path.join(base, 'index.js')].find((c) => {
    try { return fs.statSync(c).isFile() } catch (e) { return false }
  }) || null
}

const files = walk(ROOT)
let checked = 0
const bad = []
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
  lines.forEach((line, ln) => {
    // 跳过注释行：文档注释里的示例路径（如 ` * require('../../lib/x.js')`）不参与解析
    const t = line.trim()
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return
    let m
    const re = new RegExp(RE.source, 'g')
    while ((m = re.exec(line))) {
      const target = m[1]
      if (!target.startsWith('.')) continue
      checked++
      if (resolve(f, target)) continue
      // 可选本地覆盖：目标缺失且命中确切路径白名单 → 记提示，不算失败
      const abs = path.resolve(path.dirname(f), target)
      const absJs = abs.endsWith('.js') ? abs : abs + '.js'
      if (OPTIONAL_MISSING.indexOf(abs) >= 0 || OPTIONAL_MISSING.indexOf(absJs) >= 0) {
        optionalHits.push(`${path.relative(ROOT, f)}:${ln + 1}  →  ${target}`)
        continue
      }
      bad.push(`${path.relative(ROOT, f)}:${ln + 1}  →  ${target}`)
    }
  })
}

console.log(`扫描 ${files.length} 个 js，相对 require ${checked} 处`)
if (optionalHits.length) {
  console.log(`  可选本地覆盖（.gitignore 内，缺失属预期）：${optionalHits.length} 处`)
  optionalHits.forEach((o) => console.log('  · ' + o))
}
if (bad.length) {
  console.log('解析失败：')
  bad.forEach((b) => console.log('  ✗ ' + b))
  console.log('RESULT: REQUIRE_FAIL')
  process.exit(1)
}
console.log('RESULT: REQUIRE_OK')
