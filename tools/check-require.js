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
      if (!resolve(f, target)) bad.push(`${path.relative(ROOT, f)}:${ln + 1}  →  ${target}`)
    }
  })
}

console.log(`扫描 ${files.length} 个 js，相对 require ${checked} 处`)
if (bad.length) {
  console.log('解析失败：')
  bad.forEach((b) => console.log('  ✗ ' + b))
  console.log('RESULT: REQUIRE_FAIL')
  process.exit(1)
}
console.log('RESULT: REQUIRE_OK')
