#!/usr/bin/env node
/**
 * 前端逻辑层测试汇总器（2026-11-01）。
 *
 * 定位：小程序 `services/` 层是**纯逻辑**（单飞、重试、缓存、字段映射），不依赖 DOM、不依赖真机，
 * 完全可以在 Node 里跑。这一层 bug 密度最高（401 刷新风暴、缓存击穿、令牌复活），但此前 0 覆盖。
 *
 * 为什么不是 jest：项目无 package.json、无 node_modules，`npm install` 在这个仓库不可用
 * （miniprogram/ 是嵌套独立仓库、无 lock 文件）。Node 22 自带 `node:test` + `node:assert`，
 * 零依赖、零安装，正好匹配"只测纯逻辑"的定位。
 *
 * 用法：
 *   node tools/test-fe.js        # 跑全部 miniprogram/tests/*.test.js
 *
 * ⚠️ 为什么不用 `node --test <目录>`：Node 22 在 Windows 上把目录参数当模块加载，
 *    报 MODULE_NOT_FOUND（实测）。必须显式传文件列表。
 */

'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const TEST_DIR = path.join(ROOT, 'miniprogram', 'tests')

if (!fs.existsSync(TEST_DIR)) {
  console.error(`[test-fe] 测试目录不存在：${TEST_DIR}`)
  process.exit(2)
}

// 只收 *.test.js，排除 support/ 下的辅助模块
const files = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(TEST_DIR, f))

if (!files.length) {
  console.error('[test-fe] 没找到任何 *.test.js')
  process.exit(2)
}

console.log(`[test-fe] 运行 ${files.length} 个测试文件`)
const proc = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' })
process.exit(proc.status === null ? 2 : proc.status)
