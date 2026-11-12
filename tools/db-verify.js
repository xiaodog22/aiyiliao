#!/usr/bin/env node
'use strict'
/**
 * db-verify.js —— MySQL 数据库功能验证（wechar_dev）
 *
 * 为什么要有这个脚本：
 *   `mvnw test` 跑的是 H2/测试档内存库，**验证不了 MySQL 的真实行为**：
 *   唯一键冲突码、外键级联、CHECK 约束、DATETIME 口径、Flyway 迁移状态、索引命中，
 *   这些都只有在真库上才成立。本脚本连真库跑一遍，把"数据库这一层到底还成立吗"变成可复跑的断言。
 *
 * 安全边界（重要）：
 *   ① 所有**写操作**都包在 `START TRANSACTION … ROLLBACK` 里，连接断开即回滚，不留痕；
 *   ② 唯一例外是显式 `--reseed-slots`（重建未来号源），不加该参数绝不写库；
 *   ③ 不执行任何 DDL；不打印密码；不走 `DROP`/`TRUNCATE`。
 *
 * 用法：
 *   node tools/db-verify.js                    # 全量校验（只读 + 事务内回滚）
 *   node tools/db-verify.js --verbose          # 额外打印每条断言的实测值
 *   node tools/db-verify.js --json             # 机器可读输出（CI 用）
 *   node tools/db-verify.js --reseed-slots     # 【会写库】按 V9008 同款逻辑重建未来 14 天号源
 *
 * 前置条件：
 *   1. MySQL 8.0 已启动，且 `backend/deploy/env.local` 里有 MYSQL_URL / MYSQL_USER / MYSQL_PASSWORD
 *      （也可用同名环境变量覆盖）；
 *   2. 本机可执行 `mysql` 客户端：PATH 里有，或设置 MYSQL_CLI 指向可执行文件；
 *   3. 账号对 wechar_dev 有读写权限（写测试全部回滚，但仍然需要 INSERT/UPDATE/DELETE 权限）。
 *
 * 退出码：0 = 无 FAIL；1 = 有 FAIL；2 = 环境不可用（连不上 / 找不到客户端）。
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const ARGV = process.argv.slice(2)
const VERBOSE = ARGV.includes('--verbose')
const JSON_OUT = ARGV.includes('--json')
const RESEED = ARGV.includes('--reseed-slots')

// ---------------------------------------------------------------- 配置

/** 读 env.local（不打印任何值）；同名环境变量优先。 */
function loadEnvLocal() {
  const out = {}
  const p = path.join(ROOT, 'backend', 'deploy', 'env.local')
  if (!fs.existsSync(p)) return out
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function resolveConfig() {
  const env = loadEnvLocal()
  const jdbc = process.env.MYSQL_URL || env.MYSQL_URL || ''
  const m = /^jdbc:mysql:\/\/([^:/?]+)(?::(\d+))?\/([^?]+)/.exec(jdbc)
  return {
    host: process.env.MYSQL_HOST || (m ? m[1] : '127.0.0.1'),
    port: process.env.MYSQL_PORT || (m && m[2] ? m[2] : '3306'),
    database: process.env.MYSQL_DATABASE || (m ? m[3] : 'wechar_dev'),
    user: process.env.MYSQL_USER || env.MYSQL_USER || '',
    password: process.env.MYSQL_PASSWORD || env.MYSQL_PASSWORD || ''
  }
}

/** 找 mysql 客户端：MYSQL_CLI > PATH > Windows 常见安装位置。 */
function findMysqlCli() {
  const candidates = [
    process.env.MYSQL_CLI,
    'mysql',
    'D:/mysql/MySQL Server 8.0/bin/mysql.exe',
    'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe',
    '/c/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe'
  ].filter(Boolean)
  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 })
    if (r.status === 0) return bin
  }
  return null
}

const CFG = resolveConfig()
const MYSQL = findMysqlCli()

/** 统一会话口径：应用连接串强制 UTC（connectionTimeZone=UTC），CLI 默认跟随系统时区，
 *  不显式对齐就会把"时区差 8 小时"误判成数据错误。 */
const PRELUDE = "SET time_zone = '+00:00';"

function run(sql, opts) {
  const args = [
    '-h', CFG.host, '-P', CFG.port, '-u', CFG.user,
    '--default-character-set=utf8mb4', '--batch', '--raw', '-N',
    '-D', CFG.database, '-e', PRELUDE + sql
  ]
  const r = spawnSync(MYSQL, args, {
    encoding: 'utf8',
    timeout: 60000,
    env: Object.assign({}, process.env, { MYSQL_PWD: CFG.password }),
    maxBuffer: 32 * 1024 * 1024
  })
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }
}

/** 读查询：返回二维数组（行 × 列，按 \t 切分）。 */
function q(sql) {
  const r = run(sql)
  if (r.status !== 0) throw new Error('查询失败: ' + firstLine(r.stderr) + ' | ' + sql.slice(0, 120))
  if (!r.stdout) return []
  return r.stdout.split(/\r?\n/).map((line) => line.split('\t'))
}

/** 单值查询。 */
function scalar(sql) {
  const rows = q(sql)
  return rows.length ? rows[0][0] : null
}

function firstLine(s) {
  return String(s || '').split(/\r?\n/)[0]
}

// ---------------------------------------------------------------- 断言收集

const results = []

function record(id, group, title, status, detail) {
  results.push({ id, group, title, status, detail: detail == null ? '' : String(detail) })
  if (JSON_OUT) return
  const tag = status === 'PASS' ? '  PASS' : status === 'FAIL' ? '  FAIL' : status === 'WARN' ? '  WARN' : '  INFO'
  let line = tag + '  ' + id + '  ' + title
  if (status === 'FAIL' && detail) line += '\n        实测：' + detail
  else if (VERBOSE && detail) line += '\n        实测：' + detail
  console.log(line)
}

function pass(id, group, title, detail) { record(id, group, title, 'PASS', detail) }
function warn(id, group, title, detail) { record(id, group, title, 'WARN', detail) }
function info(id, group, title, detail) { record(id, group, title, 'INFO', detail) }
function fail(id, group, title, detail) { record(id, group, title, 'FAIL', detail) }

/**
 * 通用断言执行器：单条检查抛错只影响自己，不中断整轮（回归脚本要一次看全）。
 */
function check(id, group, title, fn) {
  try {
    fn()
  } catch (e) {
    fail(id, group, title, e && e.message ? firstLine(e.message) : String(e))
  }
}

/** 事务内写操作：连接结束未 COMMIT → 自动回滚；异常也不会残留。 */
function inTx(statements) {
  return run('START TRANSACTION;' + statements + 'ROLLBACK;')
}

/** 期望一个错误码（负向用例）；写语句同样包在事务里，万一"意外成功"也不会落库。 */
function expectErrno(id, group, title, statements, errno) {
  const r = run('START TRANSACTION;' + statements)
  const m = /ERROR (\d+)/.exec(r.stderr)
  if (!m) {
    fail(id, group, title, '期望 MySQL 错误 ' + errno + '，实际：' + (r.status === 0 ? '语句成功执行（约束缺失）' : firstLine(r.stderr)))
    return
  }
  if (Number(m[1]) === errno) pass(id, group, title, 'ERROR ' + m[1])
  else fail(id, group, title, '期望错误 ' + errno + '，实际 ' + m[1] + '：' + firstLine(r.stderr))
}

function section(name) {
  if (!JSON_OUT) console.log('\n—— ' + name + ' ' + '—'.repeat(Math.max(0, 62 - name.length * 2)))
}

// ---------------------------------------------------------------- 启动

if (!MYSQL) {
  console.error('✗ 找不到 mysql 客户端：请把 mysql 加入 PATH，或设置 MYSQL_CLI 指向可执行文件')
  process.exit(2)
}
if (!CFG.user) {
  console.error('✗ 缺少数据库账号：backend/deploy/env.local 里没有 MYSQL_USER，也没有同名环境变量')
  process.exit(2)
}

const conn = run('SELECT 1')
if (conn.status !== 0) {
  console.error('✗ 连接失败 ' + CFG.host + ':' + CFG.port + '/' + CFG.database + ' —— ' + firstLine(conn.stderr))
  process.exit(2)
}

if (!JSON_OUT) {
  console.log('='.repeat(72))
  console.log('数据库验证 · ' + CFG.database + ' @ ' + CFG.host + ':' + CFG.port + ' · user=' + CFG.user)
  console.log('mysql = ' + MYSQL)
  console.log('时间口径：会话 time_zone 已对齐 +00:00（与应用连接串 connectionTimeZone=UTC 一致）')
  console.log('='.repeat(72))
}

// ---------------------------------------------------------------- 零、可选：重建号源（先执行，再校验）

if (RESEED) {
  section('零、重建未来号源（--reseed-slots，会写库；先执行再校验）')
  const sql =
    "INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status) " +
    "SELECT CONCAT('slot-', d.id, '-', DATE_FORMAT(day.d, '%Y%m%d'), '-am'), d.id, " +
    "TIMESTAMP(day.d, '09:00:00'), TIMESTAMP(day.d, '09:30:00'), 20, 20, 25.00, 'CNY', 'OPEN' " +
    "FROM doctors d, (SELECT CURDATE() + INTERVAL n DAY AS d FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 " +
    "UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13) nums) day " +
    "ON DUPLICATE KEY UPDATE capacity = 20, remaining = 20, status = 'OPEN', updated_at = CURRENT_TIMESTAMP(3);" +
    "INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status) " +
    "SELECT CONCAT('slot-', d.id, '-', DATE_FORMAT(day.d, '%Y%m%d'), '-pm'), d.id, " +
    "TIMESTAMP(day.d, '14:00:00'), TIMESTAMP(day.d, '14:30:00'), 20, 20, 25.00, 'CNY', 'OPEN' " +
    "FROM doctors d, (SELECT CURDATE() + INTERVAL n DAY AS d FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 " +
    "UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13) nums) day " +
    "ON DUPLICATE KEY UPDATE capacity = 20, remaining = 20, status = 'OPEN', updated_at = CURRENT_TIMESTAMP(3);" +
    // 重建必须紧跟一次「归一」（与 V9012 第 ① 段同一条 SQL）：
    // V9008 的种子把「北京时间 09:00 / 14:00」直接写成 TIMESTAMP 字面量，而应用会话时区是 UTC，
    // 于是落库变成 09:00Z / 14:00Z（= 北京 17:00 / 22:00）。只插不归一会把 DEF-02 的时区问题重新种回来
    // （本脚本的 TZ-04 就是这么抓到第一版的）。这条 UPDATE 只命中 9/14 点，归一次后不再命中，可重复执行。
    "UPDATE doctor_slots SET start_time = start_time - INTERVAL 8 HOUR, end_time = end_time - INTERVAL 8 HOUR, updated_at = CURRENT_TIMESTAMP(3) " +
    "WHERE id LIKE 'slot-%' AND MINUTE(start_time) = 0 AND (HOUR(start_time) = 9 OR HOUR(start_time) = 14);" +
    "UPDATE doctor_slots SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP(3) WHERE status = 'OPEN' AND start_time < UTC_TIMESTAMP();" +
    "SELECT 'FUTURE', COUNT(*) FROM doctor_slots WHERE status = 'OPEN' AND start_time > UTC_TIMESTAMP();"
  const r = run(sql)
  if (r.status !== 0) {
    fail('SEED-01', '重建号源', '重建未来 14 天号源', firstLine(r.stderr))
  } else {
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('FUTURE\t'))
    const n = line ? Number(line.split('\t')[1]) : -1
    pass('SEED-01', '重建号源', '重建未来 14 天号源', '未来可约 ' + n + ' 条')
  }
}

// ---------------------------------------------------------------- 一、连接与会话

section('一、连接与会话')

check('CONN-01', '连接与会话', '可建立连接并执行查询', () => {
  const v = scalar("SELECT CONCAT('ok-', 1 + 1)")
  if (v !== 'ok-2') throw new Error('返回异常: ' + v)
  pass('CONN-01', '连接与会话', '可建立连接并执行查询', v)
})

check('CONN-02', '连接与会话', '会话时区可对齐 UTC（应用连接串的强制口径）', () => {
  const tz = scalar('SELECT @@session.time_zone')
  if (tz !== '+00:00') throw new Error('session.time_zone=' + tz)
  pass('CONN-02', '连接与会话', '会话时区可对齐 UTC', tz)
})

check('CONN-03', '连接与会话', '连接字符集为 utf8mb4', () => {
  const cs = scalar('SELECT @@character_set_connection')
  if (cs !== 'utf8mb4') throw new Error('character_set_connection=' + cs)
  pass('CONN-03', '连接与会话', '连接字符集为 utf8mb4', cs)
})

check('CONN-04', '连接与会话', '4 字节字符（emoji / 生僻字）可往返', () => {
  const src = '潮汕话·康诊云😀𠮷'
  const back = scalar("SELECT '" + src + "'")
  if (back !== src) throw new Error('回读不一致: ' + back)
  pass('CONN-04', '连接与会话', '4 字节字符可往返', back)
})

check('CONN-05', '连接与会话', '事务隔离级别（记录基线）', () => {
  const iso = scalar('SELECT @@transaction_isolation')
  info('CONN-05', '连接与会话', '事务隔离级别', iso)
})

// ---------------------------------------------------------------- 二、Schema 结构

section('二、Schema 结构')

const CORE_TABLES = [
  'users', 'doctors', 'departments', 'doctor_slots', 'appointments',
  'health_records', 'health_report_details', 'health_record_attachments',
  'family_members', 'family_invitations', 'consultations', 'consultation_messages',
  'messages', 'flyway_schema_history', 'user_extended'
]

check('SCH-01', 'Schema', '核心表齐全（' + CORE_TABLES.length + ' 张）', () => {
  const rows = q("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()")
  const have = new Set(rows.map((r) => r[0]))
  const missing = CORE_TABLES.filter((t) => !have.has(t))
  if (missing.length) throw new Error('缺失: ' + missing.join(', '))
  pass('SCH-01', 'Schema', '核心表齐全', have.size + ' 张表，核心 ' + CORE_TABLES.length + ' 张全在')
})

check('SCH-02', 'Schema', '核心表引擎为 InnoDB（事务/外键前提）', () => {
  const rows = q("SELECT table_name, engine FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('" + CORE_TABLES.join("','") + "') AND engine <> 'InnoDB'")
  if (rows.length) throw new Error('非 InnoDB: ' + rows.map((r) => r[0] + '=' + r[1]).join(', '))
  pass('SCH-02', 'Schema', '核心表引擎为 InnoDB', '全部 InnoDB')
})

check('SCH-03', 'Schema', '核心表字符集为 utf8mb4（中文/emoji 不截断）', () => {
  const rows = q("SELECT table_name, table_collation FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('" + CORE_TABLES.join("','") + "') AND table_collation NOT LIKE 'utf8mb4%'")
  if (rows.length) throw new Error('非 utf8mb4: ' + rows.map((r) => r[0] + '=' + r[1]).join(', '))
  pass('SCH-03', 'Schema', '核心表字符集为 utf8mb4', '全部 utf8mb4')
})

const REQUIRED_UNIQUE = [
  ['health_records', 'uq_health_records_idem', 'user_id,idempotency_key'],
  ['health_report_details', 'uq_hrd_record', 'record_id'],
  ['health_report_details', 'uq_hrd_report_no', 'report_no'],
  ['family_invitations', 'uq_family_invitations_token', 'token_hash'],
  ['appointments', 'uk_appointments_idem', 'user_id,idempotency_key'],
  ['users', 'uk_users_openid', 'wechat_openid']
]

check('SCH-04', 'Schema', '关键唯一键齐备（幂等/令牌/报告号）', () => {
  const rows = q("SELECT table_name, index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema = DATABASE() AND non_unique = 0 GROUP BY table_name, index_name")
  const map = new Map(rows.map((r) => [r[0] + '.' + r[1], r[2]]))
  const bad = REQUIRED_UNIQUE.filter(([t, i, cols]) => map.get(t + '.' + i) !== cols)
  if (bad.length) throw new Error('缺失或列不符: ' + bad.map((b) => b[0] + '.' + b[1]).join(', '))
  pass('SCH-04', 'Schema', '关键唯一键齐备', REQUIRED_UNIQUE.length + ' 个')
})

const REQUIRED_FK = [
  ['appointments', 'fk_appointments_user', 'users'],
  ['appointments', 'fk_appointments_slot', 'doctor_slots'],
  ['appointments', 'fk_appointments_doctor', 'doctors'],
  ['appointments', 'fk_appointments_department', 'departments'],
  ['health_records', 'fk_health_records_user', 'users'],
  ['health_report_details', 'fk_hrd_record_user', 'health_records'],
  ['health_record_attachments', 'fk_hr_attach_record', 'health_records']
]

check('SCH-05', 'Schema', '关键外键齐备（预约/档案/报告）', () => {
  const rows = q("SELECT table_name, constraint_name, referenced_table_name, delete_rule FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE()")
  const map = new Map(rows.map((r) => [r[0] + '.' + r[1], r[2] + '|' + r[3]]))
  const bad = REQUIRED_FK.filter(([t, c, ref]) => {
    const v = map.get(t + '.' + c)
    return !v || v.split('|')[0] !== ref
  })
  if (bad.length) throw new Error('缺失: ' + bad.map((b) => b[0] + '.' + b[1]).join(', '))
  pass('SCH-05', 'Schema', '关键外键齐备', REQUIRED_FK.length + ' 个')
})

check('SCH-06', 'Schema', '号源数值受 CHECK 约束保护（remaining 0..capacity）', () => {
  const rows = q("SELECT tc.table_name, cc.constraint_name FROM information_schema.table_constraints tc JOIN information_schema.check_constraints cc ON cc.constraint_schema = tc.constraint_schema AND cc.constraint_name = tc.constraint_name WHERE tc.constraint_schema = DATABASE() AND tc.constraint_type = 'CHECK' AND tc.table_name = 'doctor_slots'")
  const names = rows.map((r) => r[1])
  if (!names.includes('chk_slots_remaining')) throw new Error('缺少 chk_slots_remaining，实际: ' + names.join(', '))
  pass('SCH-06', 'Schema', '号源 CHECK 约束存在', names.join(', '))
})

check('SCH-07', 'Schema', '已知缺口：无「同用户同号源在办」唯一约束（DEF-03 遗留）', () => {
  const rows = q("SELECT index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'appointments' AND non_unique = 0 GROUP BY index_name")
  const hit = rows.some((r) => r[1] === 'user_id,slot_id')
  if (hit) {
    warn('SCH-07', 'Schema', '已存在 (user_id, slot_id) 唯一约束', '与代码注释不一致，请复核')
    return
  }
  info('SCH-07', 'Schema', '无 (user_id, slot_id) 在办唯一约束（应用层查重，并发仍可能双建单）',
    '唯一键: ' + rows.map((r) => r[1]).join(' / '))
})

// ---------------------------------------------------------------- 三、约束行为

section('三、约束与完整性（事务内回滚）')

let FX = null
try {
  const u = q('SELECT id FROM users ORDER BY id LIMIT 1')
  const s = q('SELECT s.id, s.doctor_id, s.capacity, s.remaining, d.department_id FROM doctor_slots s JOIN doctors d ON d.id = s.doctor_id WHERE s.status = \'CLOSED\' ORDER BY s.id LIMIT 1')
  const rec = q('SELECT r.id, r.user_id FROM health_records r JOIN health_report_details d ON d.record_id = r.id LIMIT 1')
  if (u.length && s.length) {
    FX = {
      userId: u[0][0],
      slotId: s[0][0],
      doctorId: s[0][1],
      capacity: Number(s[0][2]),
      remaining: Number(s[0][3]),
      deptId: s[0][4],
      recordId: rec.length ? rec[0][0] : null
    }
  }
} catch (e) {
  FX = null
}

if (!FX) {
  fail('FIX-00', '约束与完整性', '测试夹具（用户/号源）可用', '未取到用户或号源，后续写测试跳过')
} else {
  check('CON-01', '约束与完整性', '幂等键唯一：同用户同键重复插入被拒（1062）', () => {
    const sql =
      "INSERT INTO health_records (id, user_id, category, recorded_at, idempotency_key) VALUES " +
      "('dbt_hr_1','" + FX.userId + "','VITALS','2026-01-01 00:00:00','dbt-key-1')," +
      "('dbt_hr_2','" + FX.userId + "','VITALS','2026-01-01 00:00:00','dbt-key-1');"
    expectErrno('CON-01', '约束与完整性', '幂等键唯一（1062）', sql, 1062)
  })

  check('CON-02', '约束与完整性', '幂等键为 NULL 时可多条共存（历史数据不带键）', () => {
    const r = inTx(
      "INSERT INTO health_records (id, user_id, category, recorded_at, idempotency_key) VALUES " +
      "('dbt_hr_n1','" + FX.userId + "','VITALS','2026-01-01 00:00:00',NULL)," +
      "('dbt_hr_n2','" + FX.userId + "','VITALS','2026-01-01 00:00:00',NULL);" +
      "SELECT 'N', COUNT(*) FROM health_records WHERE id IN ('dbt_hr_n1','dbt_hr_n2');"
    )
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('N\t'))
    if (r.status !== 0 || !line) throw new Error(firstLine(r.stderr) || '未返回计数')
    const n = Number(line.split('\t')[1])
    if (n !== 2) throw new Error('插入条数=' + n)
    pass('CON-02', '约束与完整性', 'NULL 幂等键可多条共存', '插入 2 条')
  })

  check('CON-03', '约束与完整性', '外键拒绝：预约指向不存在的用户（1452）', () => {
    const sql =
      "INSERT INTO appointments (id, user_id, slot_id, doctor_id, department_id, patient_name, idempotency_key, request_digest) " +
      "VALUES ('dbt_ap_bad','no-such-user','" + FX.slotId + "','" + FX.doctorId + "','" + FX.deptId + "','测试','dbt-key-bad',REPEAT('a',64));"
    expectErrno('CON-03', '约束与完整性', '外键拒绝无效用户（1452）', sql, 1452)
  })

  check('CON-04', '约束与完整性', 'NOT NULL 拒绝空记录时间（1048）', () => {
    const sql =
      "INSERT INTO health_records (id, user_id, category, recorded_at) VALUES ('dbt_hr_nn','" + FX.userId + "','VITALS',NULL);"
    expectErrno('CON-04', '约束与完整性', 'NOT NULL 拒绝空时间（1048）', sql, 1048)
  })

  check('CON-05', '约束与完整性', '级联删除：删档案主记录带走报告明细/项目/小节', () => {
    if (!FX.recordId) throw new Error('没有带明细的报告记录，跳过')
    // 子表外键列名是 report_detail_id（不是 detail_id），这里的 SQL 与 db/migration 的 DDL 同源
    const countItems = "(SELECT COUNT(*) FROM health_report_items i JOIN health_report_details d ON d.id = i.report_detail_id WHERE d.record_id = '" + FX.recordId + "')"
    const countSections = "(SELECT COUNT(*) FROM health_report_sections s JOIN health_report_details d ON d.id = s.report_detail_id WHERE d.record_id = '" + FX.recordId + "')"
    const countDetails = "(SELECT COUNT(*) FROM health_report_details WHERE record_id = '" + FX.recordId + "')"
    const r = inTx(
      "SELECT 'BEFORE', " + countDetails + ", " + countItems + ", " + countSections + ";" +
      "DELETE FROM health_records WHERE id = '" + FX.recordId + "';" +
      "SELECT 'AFTER', " + countDetails + ", " + countItems + ", " + countSections + ";"
    )
    const lines = r.stdout.split(/\r?\n/)
    const before = lines.find((l) => l.startsWith('BEFORE\t'))
    const after = lines.find((l) => l.startsWith('AFTER\t'))
    if (r.status !== 0 || !before || !after) throw new Error(firstLine(r.stderr) || '未返回计数')
    const b = before.split('\t').slice(1).map(Number)
    const a = after.split('\t').slice(1).map(Number)
    if (b[0] < 1) throw new Error('该报告未生成明细，无法验证级联')
    if (a.some((v) => v !== 0)) throw new Error('删除后仍有残留: ' + a.join('/'))
    pass('CON-05', '约束与完整性', '级联删除生效', '明细 ' + b[0] + ' → 0，项目 ' + b[1] + ' → 0，小节 ' + b[2] + ' → 0')
  })

  check('CON-06', '约束与完整性', 'CHECK 拒绝 remaining > capacity（3819）', () => {
    const sql = "UPDATE doctor_slots SET remaining = capacity + 1 WHERE id = '" + FX.slotId + "';"
    expectErrno('CON-06', '约束与完整性', 'CHECK 拒绝超售（3819）', sql, 3819)
  })

  check('CON-07', '约束与完整性', 'CHECK 拒绝 remaining < 0（3819）', () => {
    const sql = "UPDATE doctor_slots SET remaining = -1 WHERE id = '" + FX.slotId + "';"
    expectErrno('CON-07', '约束与完整性', 'CHECK 拒绝负库存（3819）', sql, 3819)
  })
}

// ---------------------------------------------------------------- 四、并发与原子性语义

section('四、原子性与并发语义（事务内回滚）')

if (!FX) {
  fail('CONC-00', '原子性与并发', '并发语义测试', '缺少夹具，跳过')
} else {
  check('CONC-01', '原子性与并发', '原子扣号：remaining>0 时减 1（1 行受影响）', () => {
    const r = inTx(
      "UPDATE doctor_slots SET remaining = 2 WHERE id = '" + FX.slotId + "';" +
      "UPDATE doctor_slots SET remaining = remaining - 1 WHERE id = '" + FX.slotId + "' AND remaining > 0;" +
      "SELECT 'R', ROW_COUNT(), (SELECT remaining FROM doctor_slots WHERE id = '" + FX.slotId + "');"
    )
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('R\t'))
    if (!line) throw new Error(firstLine(r.stderr) || '未返回')
    const [, affected, remain] = line.split('\t')
    if (Number(affected) !== 1 || Number(remain) !== 1) throw new Error('affected=' + affected + ' remaining=' + remain)
    pass('CONC-01', '原子性与并发', '原子扣号生效', 'affected=1 remaining=1')
  })

  check('CONC-02', '原子性与并发', '号源为 0 时扣号 0 行（不扣成负数）', () => {
    const r = inTx(
      "UPDATE doctor_slots SET remaining = 0 WHERE id = '" + FX.slotId + "';" +
      "UPDATE doctor_slots SET remaining = remaining - 1 WHERE id = '" + FX.slotId + "' AND remaining > 0;" +
      "SELECT 'R', ROW_COUNT(), (SELECT remaining FROM doctor_slots WHERE id = '" + FX.slotId + "');"
    )
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('R\t'))
    if (!line) throw new Error(firstLine(r.stderr) || '未返回')
    const [, affected, remain] = line.split('\t')
    if (Number(affected) !== 0 || Number(remain) !== 0) throw new Error('affected=' + affected + ' remaining=' + remain)
    pass('CONC-02', '原子性与并发', '满号不越界', 'affected=0 remaining=0')
  })

  check('CONC-03', '原子性与并发', '取消回补封顶在 capacity（LEAST 语义）', () => {
    const r = inTx(
      "UPDATE doctor_slots SET remaining = capacity WHERE id = '" + FX.slotId + "';" +
      "UPDATE doctor_slots SET remaining = LEAST(remaining + 1, capacity) WHERE id = '" + FX.slotId + "';" +
      "SELECT 'R', (SELECT remaining FROM doctor_slots WHERE id = '" + FX.slotId + "'), (SELECT capacity FROM doctor_slots WHERE id = '" + FX.slotId + "');"
    )
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('R\t'))
    if (!line) throw new Error(firstLine(r.stderr) || '未返回')
    const [, remain, cap] = line.split('\t')
    if (Number(remain) !== Number(cap)) throw new Error('remaining=' + remain + ' capacity=' + cap)
    pass('CONC-03', '原子性与并发', '回补不超售', 'remaining=capacity=' + cap)
  })

  check('CONC-04', '原子性与并发', '乐观锁：version 不匹配 0 行、匹配 1 行', () => {
    const r = inTx(
      "INSERT INTO appointments (id, user_id, slot_id, doctor_id, department_id, patient_name, idempotency_key, request_digest, version) " +
      "VALUES ('dbt_ap_lk','" + FX.userId + "','" + FX.slotId + "','" + FX.doctorId + "','" + FX.deptId + "','测试','dbt-key-lk',REPEAT('a',64),1);" +
      "UPDATE appointments SET version = version + 1 WHERE id = 'dbt_ap_lk' AND version = 99;" +
      "SELECT 'MISS', ROW_COUNT();" +
      "UPDATE appointments SET version = version + 1 WHERE id = 'dbt_ap_lk' AND version = 1;" +
      "SELECT 'HIT', ROW_COUNT();"
    )
    const miss = r.stdout.split(/\r?\n/).find((l) => l.startsWith('MISS\t'))
    const hit = r.stdout.split(/\r?\n/).find((l) => l.startsWith('HIT\t'))
    if (!miss || !hit) throw new Error(firstLine(r.stderr) || '未返回')
    const m = Number(miss.split('\t')[1])
    const h = Number(hit.split('\t')[1])
    if (m !== 0 || h !== 1) throw new Error('version 不匹配=' + m + '（期望 0）/ 匹配=' + h + '（期望 1）')
    pass('CONC-04', '原子性与并发', '乐观锁语义正确', '不匹配 0 行 / 匹配 1 行')
  })

  check('CONC-05', '原子性与并发', '查重状态集合：仅在办态计入（与 hasActiveAppointment 同口径）', () => {
    const ins = (id, st) =>
      "INSERT INTO appointments (id, user_id, slot_id, doctor_id, department_id, patient_name, idempotency_key, request_digest, status) " +
      "VALUES ('" + id + "','" + FX.userId + "','" + FX.slotId + "','" + FX.doctorId + "','" + FX.deptId + "','测试','" + id + "',REPEAT('a',64),'" + st + "');"
    const r = inTx(
      ins('dbt_st_1', 'PENDING') + ins('dbt_st_2', 'CONFIRMED') + ins('dbt_st_3', 'CHECKED_IN') +
      ins('dbt_st_4', 'CANCELLED') + ins('dbt_st_5', 'COMPLETED') + ins('dbt_st_6', 'NO_SHOW') +
      "SELECT 'ACTIVE', COUNT(*) FROM appointments WHERE user_id = '" + FX.userId + "' AND slot_id = '" + FX.slotId + "' AND status IN ('PENDING','CONFIRMED','CHECKED_IN') AND id LIKE 'dbt_st_%';"
    )
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('ACTIVE\t'))
    if (!line) throw new Error(firstLine(r.stderr) || '未返回')
    const n = Number(line.split('\t')[1])
    if (n !== 3) throw new Error('在办态计数=' + n + '（期望 3）')
    pass('CONC-05', '原子性与并发', '查重只算在办态', '3 条在办 / 3 条终态不计')
  })
}

// ---------------------------------------------------------------- 五、时间与时区口径

section('五、时间与时区口径（DEF-02 数据侧）')

check('TZ-01', '时间口径', 'DATETIME 列不做时区隐式转换（写什么读什么）', () => {
  const r = inTx(
    "INSERT INTO health_records (id, user_id, category, recorded_at) VALUES ('dbt_hr_tz','" + (FX ? FX.userId : 'x') + "','VITALS','2026-03-04 05:06:07.000');" +
    "SELECT 'T', recorded_at FROM health_records WHERE id = 'dbt_hr_tz';"
  )
  if (r.status !== 0) throw new Error(firstLine(r.stderr))
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('T\t'))
  if (!line) throw new Error('未返回')
  const v = line.split('\t')[1]
  if (!/^2026-03-04 05:06:07/.test(v)) throw new Error('回读=' + v)
  pass('TZ-01', '时间口径', 'DATETIME 无隐式时区转换', v)
})

check('TZ-02', '时间口径', '未来可约号源存在（OPEN 且 start_time > NOW）', () => {
  const n = Number(scalar("SELECT COUNT(*) FROM doctor_slots WHERE status = 'OPEN' AND start_time > UTC_TIMESTAMP()"))
  if (n > 0) pass('TZ-02', '时间口径', '存在未来可约号源', n + ' 条')
  else fail('TZ-02', '时间口径', '存在未来可约号源', '0 条 —— 号源种子按执行日生成，已全部过期（见 --reseed-slots）')
})

check('TZ-03', '时间口径', '不存在「OPEN 但已过期」的僵尸号源', () => {
  const n = Number(scalar("SELECT COUNT(*) FROM doctor_slots WHERE status = 'OPEN' AND start_time < UTC_TIMESTAMP()"))
  if (n === 0) pass('TZ-03', '时间口径', '无过期 OPEN 号源', '0 条')
  else warn('TZ-03', '时间口径', '存在过期未关闭的 OPEN 号源', n + ' 条（V9012 ④ 或 V9008 收尾会关闭）')
})

check('TZ-04', '时间口径', 'V9012 种子时间归一是否已生效（9/14 点 → 1/6 点）', () => {
  const rows = q("SELECT HOUR(start_time) h, COUNT(*) c FROM doctor_slots WHERE id LIKE 'slot-%' GROUP BY h ORDER BY c DESC LIMIT 4")
  const dist = rows.map((r) => r[0] + '时×' + r[1]).join(' ')
  const applied = scalar("SELECT COUNT(*) FROM flyway_schema_history WHERE version = '9012' AND success = 1")
  if (Number(applied) > 0) {
    const legacy = rows.filter((r) => r[0] === '9' || r[0] === '14')
    if (legacy.length) throw new Error('V9012 已应用但仍有 9/14 点号源: ' + dist)
    pass('TZ-04', '时间口径', 'V9012 已生效（小时已归一到 UTC）', dist)
  } else {
    info('TZ-04', '时间口径', 'V9012 尚未应用（应用未重启，Flyway 未跑）', '当前分布: ' + dist)
  }
})

check('TZ-05', '时间口径', 'NOW() 与 UTC_TIMESTAMP() 差 = 会话时区偏移', () => {
  const r = q('SELECT TIMESTAMPDIFF(HOUR, UTC_TIMESTAMP(), NOW())')
  const diff = Number(r[0][0])
  if (diff === 0) pass('TZ-05', '时间口径', 'NOW() 与 UTC 一致', 'diff=0h')
  else fail('TZ-05', '时间口径', 'NOW() 与 UTC 不一致', 'diff=' + diff + 'h（会话未对齐 UTC）')
})

// ---------------------------------------------------------------- 六、迁移状态

section('六、Flyway 迁移状态')

check('MIG-01', '迁移', '无失败迁移（success=0）', () => {
  const n = Number(scalar('SELECT COUNT(*) FROM flyway_schema_history WHERE success = 0'))
  if (n === 0) pass('MIG-01', '迁移', '无失败迁移', '0 条')
  else throw new Error(n + ' 条失败迁移')
})

check('MIG-02', '迁移', '版本无重复（同一 version 只应有一条记录）', () => {
  const rows = q('SELECT version, COUNT(*) c FROM flyway_schema_history WHERE version IS NOT NULL GROUP BY version HAVING c > 1')
  if (!rows.length) pass('MIG-02', '迁移', '版本无重复', 'OK')
  else throw new Error('重复: ' + rows.map((r) => r[0] + '×' + r[1]).join(', '))
})

check('MIG-03', '迁移', '已应用数量与最大版本（记录基线）', () => {
  const applied = Number(scalar('SELECT COUNT(*) FROM flyway_schema_history'))
  const maxVer = scalar("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE version IS NOT NULL")
  info('MIG-03', '迁移', '已应用迁移', applied + ' 条，最大版本 V' + maxVer)
})

check('MIG-04', '迁移', '磁盘迁移文件与库内记录对齐（列出待应用）', () => {
  const dirs = ['db/migration', 'db/dev']
  const base = path.join(ROOT, 'backend', 'business-service', 'src', 'main', 'resources')
  const files = []
  for (const d of dirs) {
    const dir = path.join(base, d)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      const m = /^V(\d+)__(.+)\.sql$/.exec(f)
      if (m) files.push({ v: Number(m[1]), name: f, dir: d })
    }
  }
  const applied = new Set(q('SELECT version FROM flyway_schema_history WHERE version IS NOT NULL').map((r) => Number(r[0])))
  const pending = files.filter((f) => !applied.has(f.v)).sort((a, b) => a.v - b.v)
  const ghost = [...applied].filter((v) => !files.some((f) => f.v === v))
  if (pending.length === 0 && ghost.length === 0) {
    pass('MIG-04', '迁移', '文件与库内记录对齐', files.length + ' 个文件全部已应用')
    return
  }
  if (pending.length) {
    warn('MIG-04', '迁移', '存在未应用的迁移文件（下次启动会执行）',
      pending.map((p) => 'V' + p.v + '(' + p.dir + ')').join(', '))
  }
  if (ghost.length) {
    warn('MIG-04', '迁移', '库内存在无对应文件的版本（历史清理过文件？）', ghost.join(', '))
  }
})

// ---------------------------------------------------------------- 七、演示数据完整性

section('七、演示数据完整性')

check('DATA-01', '数据完整性', '表规模基线（users/doctors/slots/appointments/records）', () => {
  const rows = q(
    "SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'doctors', COUNT(*) FROM doctors " +
    "UNION ALL SELECT 'slots', COUNT(*) FROM doctor_slots UNION ALL SELECT 'appointments', COUNT(*) FROM appointments " +
    "UNION ALL SELECT 'records', COUNT(*) FROM health_records UNION ALL SELECT 'reports', COUNT(*) FROM health_report_details"
  )
  info('DATA-01', '数据完整性', '表规模', rows.map((r) => r[0] + '=' + r[1]).join(' '))
})

check('DATA-02', '数据完整性', '报告主记录与明细严格 1:1（uq_hrd_record）', () => {
  const multi = Number(scalar('SELECT COUNT(*) FROM (SELECT record_id FROM health_report_details GROUP BY record_id HAVING COUNT(*) > 1) t'))
  if (multi === 0) pass('DATA-02', '数据完整性', '报告主记录与明细 1:1', '0 条一对多')
  else throw new Error(multi + ' 条主记录有多份明细')
})

check('DATA-03', '数据完整性', '报告状态分布（READY/REVIEWING/PENDING）', () => {
  const rows = q("SELECT IFNULL(report_status, '(null)'), COUNT(*) FROM health_records WHERE category = 'EXAM' GROUP BY report_status ORDER BY 2 DESC")
  info('DATA-03', '数据完整性', '报告状态分布', rows.map((r) => r[0] + '=' + r[1]).join(' '))
})

check('DATA-04', '数据完整性', '每位医生都有号源记录', () => {
  const n = Number(scalar('SELECT COUNT(*) FROM doctors d WHERE NOT EXISTS (SELECT 1 FROM doctor_slots s WHERE s.doctor_id = d.id)'))
  if (n === 0) pass('DATA-04', '数据完整性', '每位医生都有号源', '0 位缺号源')
  else warn('DATA-04', '数据完整性', '有医生没有任何号源', n + ' 位')
})

check('DATA-05', '数据完整性', '家庭成员授权态分布（GRANTED/NONE）', () => {
  const rows = q('SELECT proxy_status, COUNT(*) FROM family_members GROUP BY proxy_status')
  info('DATA-05', '数据完整性', '授权态分布', rows.map((r) => r[0] + '=' + r[1]).join(' '))
})

check('DATA-06', '数据完整性', '邀请令牌只存哈希（无明文 token 列）', () => {
  const cols = q("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'family_invitations'")
  const names = cols.map((r) => r[0])
  if (names.includes('token')) throw new Error('存在明文 token 列: ' + names.join(','))
  pass('DATA-06', '数据完整性', '邀请令牌只存哈希', names.join(','))
})

check('DATA-07', '数据完整性', '号源账实相符：可约号源 remaining = capacity - 在办预约数', () => {
  // 只校验「OPEN 且未来」的号源：历史号源（已 CLOSED）是演示种子一次性写死 remaining=20 的产物，
  // 拿去当断言会天天报噪声；真正会导致超卖的是**还能约**的号源。
  const drift = q(
    "SELECT s.id, s.capacity, s.remaining, t.cnt FROM doctor_slots s " +
    "JOIN (SELECT slot_id, COUNT(*) cnt FROM appointments WHERE status IN ('PENDING','CONFIRMED','CHECKED_IN') GROUP BY slot_id) t ON t.slot_id = s.id " +
    "WHERE s.status = 'OPEN' AND s.start_time > UTC_TIMESTAMP() AND s.remaining <> s.capacity - t.cnt"
  )
  const hist = Number(scalar(
    "SELECT COUNT(*) FROM doctor_slots s " +
    "JOIN (SELECT slot_id, COUNT(*) cnt FROM appointments WHERE status IN ('PENDING','CONFIRMED','CHECKED_IN') GROUP BY slot_id) t ON t.slot_id = s.id " +
    "WHERE s.remaining <> s.capacity - t.cnt"
  ))
  if (drift.length) {
    warn('DATA-07', '数据完整性', '可约号源余量与在办预约不一致（可能超卖）',
      drift.slice(0, 5).map((r) => r[0] + ': rem=' + r[2] + ' cap=' + r[1] + ' active=' + r[3]).join('; '))
    return
  }
  pass('DATA-07', '数据完整性', '可约号源账实相符', 'OPEN+未来号源 0 条偏差' + (hist ? '（历史号源 ' + hist + ' 条偏差，已关闭，不影响）' : ''))
})

// ---------------------------------------------------------------- 八、查询计划

section('八、查询计划（索引是否被用上）')

function explain(label, sql, hintKey) {
  try {
    const rows = q('EXPLAIN ' + sql)
    if (!rows.length) {
      warn(label, '查询计划', 'EXPLAIN 无输出', sql.slice(0, 60))
      return
    }
    const r = rows[0]
    const type = r[4]
    const key = r[6]
    const scanned = Number(r[9])
    const detail = 'type=' + type + ' key=' + (key === 'NULL' ? '(无)' : key) + ' rows=' + scanned
    // 判定口径：**只要用上了索引**就算通过。优化器在行数极少时可能挑另一个索引
    // （如唯一键 ref），那同样是有效执行计划，不能当失败——预设索引只作提示。
    if (key !== 'NULL') {
      const hint = hintKey && key !== hintKey ? '（预设 ' + hintKey + '，优化器选了更省的 ' + key + '）' : ''
      pass(label, '查询计划', '命中索引 ' + key + hint, detail)
    } else if (type === 'ALL' && scanned > 1000) {
      fail(label, '查询计划', '全表扫描且表较大', detail)
    } else {
      warn(label, '查询计划', '未命中任何索引', detail + '（预设 ' + (hintKey || '任意索引') + '）')
    }
  } catch (e) {
    fail(label, '查询计划', 'EXPLAIN 失败', firstLine(e.message))
  }
}

explain('IDX-01', "SELECT id FROM doctor_slots WHERE doctor_id = 'x' AND start_time BETWEEN '2026-01-01' AND '2026-12-31'", 'idx_slots_doctor_time')
explain('IDX-02', "SELECT id FROM health_report_details WHERE user_id = 'x' ORDER BY reported_at DESC LIMIT 20", 'idx_hrd_user_time')
explain('IDX-03', "SELECT id FROM appointments WHERE user_id = 'x' AND status IN ('PENDING','CONFIRMED','CHECKED_IN')", 'idx_appointments_user_status_time')

// ---------------------------------------------------------------- 九、账号权限

section('九、账号权限')

check('SEC-01', '权限', '应用账号全局权限仅为 USAGE（库权限按需）', () => {
  const rows = q('SHOW GRANTS FOR CURRENT_USER()')
  const flat = rows.map((r) => r[0])
  const globalAll = flat.some((g) => /GRANT ALL PRIVILEGES ON \*\.\*/.test(g))
  const dbAll = flat.filter((g) => /GRANT ALL PRIVILEGES ON `/.test(g))
  if (globalAll) throw new Error('账号拥有全局 ALL PRIVILEGES')
  if (dbAll.length) {
    info('SEC-01', '权限', '全局仅 USAGE，库内为 ALL（含 DROP，生产建议拆分迁移账号）', dbAll.join(' ; ').slice(0, 120))
    return
  }
  pass('SEC-01', '权限', '全局仅 USAGE', flat.join(' ; ').slice(0, 120))
})

// ---------------------------------------------------------------- 汇总

const counts = results.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] || 0) + 1
  return acc
}, {})
const failed = results.filter((r) => r.status === 'FAIL')
const warned = results.filter((r) => r.status === 'WARN')

if (JSON_OUT) {
  console.log(JSON.stringify({
    database: CFG.database,
    host: CFG.host + ':' + CFG.port,
    at: new Date().toISOString(),
    counts,
    results
  }, null, 2))
} else {
  console.log('\n' + '='.repeat(72))
  console.log('汇总：PASS ' + (counts.PASS || 0) + ' · FAIL ' + (counts.FAIL || 0) +
    ' · WARN ' + (counts.WARN || 0) + ' · INFO ' + (counts.INFO || 0))
  if (warned.length) {
    console.log('\nWARN（需关注，不阻塞）：')
    warned.forEach((r) => console.log('  · ' + r.id + ' ' + r.title + (r.detail ? ' — ' + r.detail : '')))
  }
  if (failed.length) {
    console.log('\nFAIL（必须处理）：')
    failed.forEach((r) => console.log('  · ' + r.id + ' ' + r.title + (r.detail ? '\n      ' + r.detail : '')))
  }
  console.log('='.repeat(72))
}

process.exit(failed.length ? 1 : 0)
