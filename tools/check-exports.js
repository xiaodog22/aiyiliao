/**
 * tools/check-exports.js —— 静态检查「导入形状」与「导出名」是否对得上
 *
 * 为什么需要：node --check 只查语法，tools/check-require.js 只查路径能否解析，
 * 两者都**查不出**下面这类错误 —— 而它刚刚真实上线过：
 *     // utils/paginate.js: module.exports = { PAGE_SIZE, paginate }
 *     const paginate = require('../../../utils/paginate.js')  // ← 拿到整个模块对象
 *     paginate(all, 1)                                       // ← 运行时才炸：not a function
 * 页面表现为整屏「加载失败：paginate is not a function」。
 *
 * 本工具做两件事：
 *   ① 默认导入（const X = require(...)）而目标模块导出的是**对象**，且 X 被当函数调用 → 报错；
 *   ② 具名解构（const { a } = require(...)）里的键，在目标模块导出对象里不存在 → 报错。
 *
 * 退出码：有问题 = 1（可接进提交前钩子 / CI）。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'miniprogram')

function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

/** 把 require 的相对路径解析成绝对文件路径（省略 .js / 目录 index.js 都试一遍） */
function resolveReq(fromFile, req) {
  if (!/^\.\.?[\\/]/.test(req)) return null      // 只处理相对路径（包名不管）
  const base = path.resolve(path.dirname(fromFile), req)
  const cands = [base, base + '.js', path.join(base, 'index.js')]
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  return null
}

/**
 * 去掉注释：否则文档里写的用法示例（如 paginate.js 顶部的
 * `const { paginate } = require(...)`）会被当成真实代码扫描，误报。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * 取出目标模块 `module.exports = { ... }` 的键名。
 * 用花括号配平扫描，避免对象里嵌套对象时提前截断。
 * 支持三种键写法：`get: fn` / `get(a) {…}`（方法简写）/ `'info': v`。
 * @returns {string[]|null} null = 该模块不是「对象字面量导出」（可能是函数/变量），不做校验
 */
function objectExportKeys(src) {
  const m = /module\.exports\s*=\s*\{/.exec(src)
  if (!m) return null
  let i = m.index + m[0].length - 1        // 指向 '{'
  let depth = 0
  let end = -1
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = j; break } }
  }
  if (end < 0) return null
  const body = src.slice(i + 1, end)
  // 按顶层逗号切分，再取每段的键
  const keys = []
  let buf = ''
  let d = 0
  const push = (seg) => {
    const s = seg.trim()
    if (!s) return
    const mStr = /^(['"])([^'"]*)\1\s*:?/.exec(s)          // 'info': v  /  'info'
    const mId = /^([A-Za-z_$][\w$]*)\s*[:(]/.exec(s)       // get: v  /  get(spec) {…}
    const mBare = /^([A-Za-z_$][\w$]*)$/.exec(s)           // get  （简写导出，最常见）
    const k = mStr ? mStr[2] : (mId ? mId[1] : (mBare ? mBare[1] : ''))
    if (/^[A-Za-z_$][\w$]*$/.test(k)) keys.push(k)
  }
  for (const ch of body) {
    if ('{[('.includes(ch)) d++
    else if ('}])'.includes(ch)) d--
    if (ch === ',' && d === 0) { push(buf); buf = '' } else buf += ch
  }
  push(buf)
  return keys
}

const errors = []
const files = walk(ROOT, [])

for (const file of files) {
  const src = stripComments(fs.readFileSync(file, 'utf8'))
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/')

  // ① 具名解构
  const namedRe = /const\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = namedRe.exec(src))) {
    const target = resolveReq(file, m[2])
    if (!target) continue
    const keys = objectExportKeys(stripComments(fs.readFileSync(target, 'utf8')))
    if (!keys) continue                        // 目标不是对象导出 → 不判（可能是函数）
    const wanted = m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean)
    for (const w of wanted) {
      if (!keys.includes(w)) {
        errors.push(rel + '  ⛔ 解构出的 `' + w + '` 在 ' + path.basename(target) +
          ' 里不存在（实际导出：' + keys.join(', ') + '）')
      }
    }
  }

  // ② 默认导入后当函数调用（本次翻车的形态）
  const defRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = defRe.exec(src))) {
    const id = m[1]
    const target = resolveReq(file, m[2])
    if (!target) continue
    const keys = objectExportKeys(stripComments(fs.readFileSync(target, 'utf8')))
    if (!keys || !keys.length) continue        // 非对象导出 → 合法
    if (keys.length === 1 && keys[0] === id) continue
    // 该标识符是否被当函数调用？（排除它只是被用作 `X.成员` 的情况）
    const called = new RegExp('(?:^|[^\\w$.])' + id + '\\s*\\(').test(src)
    if (called) {
      errors.push(rel + '  ⛔ `' + id + '` 用默认导入方式引了 ' + path.basename(target) +
        '，但该模块导出的是对象 { ' + keys.join(', ') + ' }，直接调用会报 "' + id + ' is not a function"')
    }
  }

  // ③ 相对路径解析不到（check-require.js 已覆盖，这里兜底提示打错的路径）
  const anyRe = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g
  while ((m = anyRe.exec(src))) {
    if (!resolveReq(file, m[1])) errors.push(rel + '  ⛔ require 路径解析不到：' + m[1])
  }
}

console.log('== check-exports：扫描 ' + files.length + ' 个 js ==')
if (errors.length) {
  errors.forEach((e) => console.log(e))
  console.log('\n❌ 发现 ' + errors.length + ' 处导入/导出不一致')
  process.exit(1)
}
console.log('✅ 导入形状与导出名全部对得上')
