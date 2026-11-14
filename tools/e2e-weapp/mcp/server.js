#!/usr/bin/env node
/*
 * wechar-unified-test MCP server（stdio / JSON-RPC 2.0，零外部依赖）
 *
 * 把「微信开发者工具 UI + Postman/Newman 接口 + JMeter 5.4.1 压测」三条链路
 * 暴露成一组工具，让 DSH NEXT 等 MCP 客户端用一个 server 统一调用与取结果。
 *
 * 协议：每行一个 JSON 消息；stdout 只输出协议数据，日志一律走 stderr。
 * 不联网、不装依赖、不改环境变量；所有实际动作都委托给 tools/e2e-weapp/ 既有脚本。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { spawnSync } = require('child_process')

const SUITE = path.resolve(__dirname, '..')
const REPO = path.resolve(SUITE, '..', '..')
const ARTIFACTS = path.join(REPO, 'artifacts', 'e2e-weapp')

const TOOLS = [
  {
    name: 'wechar_preflight',
    description: '只读环境自检：Node、网关、微信开发者工具 CLI/服务端口、automator SDK、JMeter、JDK、Postman/Newman 是否就绪。不产生副作用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'wechar_run_all',
    description: '跑完整链路：自检 → 小程序 UI E2E → 接口回归 → JMeter 网关冒烟，生成 Markdown + JSON 统一报告。',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: '强制离线自检，不向后端发请求' },
        users: { type: 'integer', minimum: 1, maximum: 1000 },
        loops: { type: 'integer', minimum: 1, maximum: 1000 },
        skipE2E: { type: 'boolean' },
        skipJmeter: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'wechar_run_jmeter',
    description: '单独跑 JMeter 5.4.1 网关冒烟。默认离线自检（不发请求），只有显式传 dryRun:false 才真实压测。返回 JTL 统计与产物路径。',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean' },
        users: { type: 'integer', minimum: 1, maximum: 1000 },
        loops: { type: 'integer', minimum: 1, maximum: 1000 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'wechar_run_newman',
    description: '单独跑 Postman CLI / Newman 接口回归。未安装 runner 或未给 collection 时返回 SKIP，不伪造结果。',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Postman Collection 绝对路径（.json）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'wechar_report',
    description: '读取最近一次统一测试报告（Markdown 或结构化 JSON）。',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['md', 'json'], description: '默认 md' }
      },
      additionalProperties: false
    }
  }
]

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }) }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }
function text(payload, isError) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }], isError: !!isError }
}

function nodeScript(script, args, timeout) {
  const r = spawnSync(process.execPath, [path.join(SUITE, script), ...args], {
    cwd: REPO, encoding: 'utf8', timeout: timeout || 300000, windowsHide: true,
    env: Object.assign({}, process.env)
  })
  const out = [String(r.stdout || '').trim(), String(r.stderr || '').trim()].filter(Boolean).join('\n')
  return { code: r.status, out, error: r.error ? r.error.message : '' }
}

function boundedInt(v, def, max) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 && n <= max ? Math.floor(n) : def
}

function commonArgs(a) {
  const args = []
  if (a.dryRun) args.push('--dry-run')
  if (a.skipE2E) args.push('--skip-e2e')
  if (a.skipJmeter) args.push('--skip-jmeter')
  if (a.users !== undefined) args.push('--users=' + boundedInt(a.users, 1, 1000))
  if (a.loops !== undefined) args.push('--loops=' + boundedInt(a.loops, 1, 1000))
  return args
}

function callTool(params) {
  const name = params && params.name
  const a = (params && params.arguments) || {}
  switch (name) {
    case 'wechar_preflight': {
      const r = nodeScript('preflight.js', [], 60000)
      return text(r.out || r.error || '(无输出)', r.code !== 0)
    }
    case 'wechar_run_all': {
      const r = nodeScript('run-all.js', commonArgs(a), 300000)
      return text(r.out || r.error || '(无输出)', r.code !== 0)
    }
    case 'wechar_run_jmeter': {
      // 默认离线自检；只有显式 dryRun:false 才向后端发真实请求，避免误触发压测
      const args = []
      if (a.dryRun !== false) args.push('--dry-run')
      if (a.users !== undefined) args.push('--users=' + boundedInt(a.users, 1, 1000))
      if (a.loops !== undefined) args.push('--loops=' + boundedInt(a.loops, 1, 1000))
      const r = nodeScript('run-jmeter.js', args, 300000)
      return text(r.out || r.error || '(无输出)', r.code !== 0)
    }
    case 'wechar_run_newman': {
      const args = []
      if (a.collection) {
        const p = path.resolve(String(a.collection))
        if (!p.toLowerCase().endsWith('.json') || !fs.existsSync(p)) {
          return text('collection 必须是存在的 .json 绝对路径：' + p, true)
        }
        args.push('--collection=' + p)
      }
      const r = nodeScript('run-newman.js', args, 180000)
      return text(r.out || r.error || '(无输出)', r.code !== 0)
    }
    case 'wechar_report': {
      const file = path.join(ARTIFACTS, a.format === 'json' ? 'report-latest.json' : 'report-latest.md')
      if (!fs.existsSync(file)) return text('尚无报告，请先调用 wechar_run_all：' + file, true)
      return text(fs.readFileSync(file, 'utf8'))
    }
    default:
      return text('未知工具：' + name, true)
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch (_) { fail(null, -32700, 'Parse error'); return }
  // 通知类消息（无 id）不回复
  if (msg.id === undefined || msg.id === null) return
  try {
    switch (msg.method) {
      case 'initialize':
        ok(msg.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'wechar-unified-test', version: '1.0.0' }
        })
        break
      case 'ping': ok(msg.id, {}); break
      case 'tools/list': ok(msg.id, { tools: TOOLS }); break
      case 'tools/call': ok(msg.id, callTool(msg.params)); break
      case 'resources/list': ok(msg.id, { resources: [] }); break
      case 'prompts/list': ok(msg.id, { prompts: [] }); break
      default: fail(msg.id, -32601, 'Method not found: ' + msg.method)
    }
  } catch (e) {
    fail(msg.id, -32000, String(e && e.message || e))
  }
})
process.stderr.write('[wechar-unified-test] MCP stdio server ready\n')
