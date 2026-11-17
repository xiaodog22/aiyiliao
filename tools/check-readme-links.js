/**
 * check-readme-links.js —— README 对外可见性门禁（2026-11-17）
 *
 * 为什么要有它：
 *   README 面向公众，但历史上把 `.gitignore` 内的路径（design-output/、artifacts/、
 *   DEV_LOG.md、AI_CONTEXT.md、docs/历史设计规范/1.md~5.md、WORKBODY_AGENT_RULES.md）
 *   写成了 Markdown 链接。本机看着全绿，**干净 clone 里点开全是 404**，
 *   而其中一条还自称"界面规范唯一真源"，会直接误导新贡献者。
 *
 * 判据（两层，缺一不可）：
 *   ① 文件必须存在；
 *   ② 文件必须被 git 跟踪（`git ls-files --error-unmatch`）——
 *      存在但被 .gitignore 排除，等价于克隆后不存在。
 *
 * 约定：只想提"本地有这份材料"的，用反引号文字，不要写成链接。
 *
 * 用法：node tools/check-readme-links.js [--file README.md]
 * 退出码：0 = 全部可点；1 = 存在死链/未入库引用；非 git 仓库只做存在性检查（WARN）。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const args = process.argv.slice(2)
const fileArg = args.indexOf('--file')
const TARGET = path.resolve(ROOT, fileArg >= 0 && args[fileArg + 1] ? args[fileArg + 1] : 'README.md')

function isGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch (e) {
    return false
  }
}

function isTracked(rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch (e) {
    return false
  }
}

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error('README_LINKS_FAIL 目标文件不存在：' + TARGET)
    process.exit(1)
  }
  const text = fs.readFileSync(TARGET, 'utf-8')
  // 只取 Markdown 行内链接；跳过 http(s)/锚点/mailto
  const links = []
  const re = /\]\(([^)\s]+)\)/g
  let m
  while ((m = re.exec(text)) !== null) links.push(m[1])

  const gitOk = isGitRepo()
  const dead = []
  const untracked = []
  const skipped = []
  const checked = new Set()

  links.forEach((raw) => {
    if (/^(https?:|#|mailto:)/i.test(raw)) return
    let target = raw.split('#')[0]
    if (!target) return
    try { target = decodeURIComponent(target) } catch (e) { /* 保留原串 */ }
    if (checked.has(target)) return
    checked.add(target)

    if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('\\\\')) {
      skipped.push(target + '（绝对路径，不适合公开 README）')
      return
    }
    const abs = path.resolve(path.dirname(TARGET), target)
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/')
    if (rel.startsWith('..')) {
      dead.push(target + '（越出仓库根目录）')
      return
    }
    if (!fs.existsSync(abs)) {
      dead.push(target + '（文件不存在）')
      return
    }
    if (gitOk && !isTracked(rel)) untracked.push(target + '（被 .gitignore 排除，克隆后不存在）')
  })

  const fail = dead.length + untracked.length
  console.log('README_LINKS 检查文件：' + path.relative(ROOT, TARGET).replace(/\\/g, '/'))
  console.log('  相对链接 ' + checked.size + ' 条 | 死链 ' + dead.length + ' | 未入库 ' + untracked.length +
    (skipped.length ? ' | 跳过 ' + skipped.length : ''))
  dead.forEach((x) => console.log('  ✗ 死链    ' + x))
  untracked.forEach((x) => console.log('  ✗ 未入库  ' + x))
  skipped.forEach((x) => console.log('  ! 跳过    ' + x))

  if (!gitOk) {
    console.log('  ⚠ 非 git 仓库：只做了存在性检查，未校验"克隆后是否存在"')
  }

  if (fail) {
    console.log('README_LINKS_FAIL 共 ' + fail + ' 条：请改为反引号文字（标注"仅本地/不入库"），或把文件正式入库')
    process.exit(1)
  }
  console.log('README_LINKS_OK')
}

main()
