/**
 * tools/test-apt-date.js —— 预约日期徽章解析守卫（VF-11）
 *
 * 为什么需要：徽章是"解析成功才渲染、失败就回退"的两态结构，
 * 解析里的越界/空值分支最容易写漏 —— 一旦漏了，`apt-date-day` 会渲染出 NaN
 * 或空白徽章，属**不报错但肉眼才看得出来**的破版。
 * 这里把"正常 / 变体格式 / 越界 / 空值"四类输入钉死，含真实星期值锚点。
 *
 * 运行：node tools/test-apt-date.js
 */
const path = require('path')
const { parseAptDate } = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'apt-date.js'))

let PASS = 0
let FAIL = 0
const fails = []

function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) { PASS++; return }
  FAIL++
  fails.push(name + '  ← got ' + g + ' / want ' + w)
}

// ==================== ① 正常形态（后端 / mock 的原始字段）====================
// '2026-08-30' 的真实星期锚点：2026-01-01 是周四（已独立核验），
// 2026 非闰年 → 8/30 为周日。硬编码为期望值，防解析逻辑悄悄漂移。
eq('正常：2026-08-30（明天）', parseAptDate('2026-08-30（明天）'), { mon: '08月', day: '30', week: '周日' })
eq('正常：2026-01-01', parseAptDate('2026-01-01'), { mon: '01月', day: '01', week: '周四' })

// ==================== ② 变体格式（分隔符 / 不补零 / 带后缀）====================
eq('变体：斜杠分隔 2026/8/3', parseAptDate('2026/8/3'), { mon: '08月', day: '03', week: '周一' })
eq('变体：点分隔 + 后缀 2026.8.3 上午', parseAptDate('2026.8.3 上午'), { mon: '08月', day: '03', week: '周一' })
eq('变体：不补零 2026-1-1', parseAptDate('2026-1-1'), { mon: '01月', day: '01', week: '周四' })

// ==================== ③ 越界 / 非法日期 → 必须 null（走回退分支）====================
eq('越界：月份 13', parseAptDate('2026-13-01'), null)
eq('越界：月份 0', parseAptDate('2026-0-10'), null)
eq('越界：2 月 30 日', parseAptDate('2026-02-30'), null)
eq('越界：4 月 31 日', parseAptDate('2026-04-31'), null)
eq('越界：日 32', parseAptDate('2026-05-32'), null)

// ==================== ④ 空值 / 格式不认识 → 必须 null（不能抛异常）====================
eq('空值：空串', parseAptDate(''), null)
eq('空值：null', parseAptDate(null), null)
eq('空值：undefined', parseAptDate(undefined), null)
eq('空值：纯中文', parseAptDate('明天上午'), null)
eq('空值：只有年月', parseAptDate('2026-08'), null)
eq('空值：数字', parseAptDate(20260830), null)
eq('空值：对象', parseAptDate({}), null)

// ==================== 汇总 ====================
console.log('== test-apt-date ==')
if (fails.length) {
  console.log('❌ 失败 ' + FAIL + ' 项：')
  fails.forEach((f) => console.log('   · ' + f))
}
console.log('通过 ' + PASS + ' / 共 ' + (PASS + FAIL))
process.exit(FAIL ? 1 : 0)
