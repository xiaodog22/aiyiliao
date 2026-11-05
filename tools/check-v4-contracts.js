#!/usr/bin/env node
'use strict'
/**
 * check-v4-contracts.js —— OpenAPI 契约一致性门禁
 *
 * 为什么需要：两份契约描述的是**目标态**，最容易出的不是语法错，而是三类"看着没事"的问题——
 *   ① 契约内部自相矛盾：$ref 指向不存在的定义、operationId 重名、写操作没声明幂等键。
 *      这类错误 OpenAPI 工具未必当场报，等生成代码时才炸。
 *   ② 两份契约职责重叠：同一路径同时属于 Spring Boot 与 FastAPI，路由归属就不可预测。
 *   ③ 契约与仓库脱节：api.js 里注册的路径在契约里查无此人（或反过来），
 *      于是"契约"变成一份没人照着实现的文档。
 *
 * 解析用 PyYAML（Node 侧无 YAML 模块）。PyYAML 默认**静默接受重复键**，
 * 所以这里挂了一个自检构造器，重复键直接报错——契约里重复的 paths 键会让先写的那段
 * 被后写的悄悄覆盖，是最难发现的一类问题。
 *
 * 运行：node tools/check-v4-contracts.js   （有问题退出码 1）
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const CONTRACTS = path.join(ROOT, 'backend', 'contracts')
const BUSINESS = path.join(CONTRACTS, 'business-openapi.yaml')
const AI = path.join(CONTRACTS, 'ai-openapi.yaml')
const APIJS = path.join(ROOT, 'miniprogram', 'config', 'api.js')

const errors = []
const warnings = []
const fail = (m) => errors.push(m)
const warn = (m) => warnings.push(m)
function read (p) {
  try { return fs.readFileSync(p, 'utf8') } catch (e) { fail(`无法读取 ${path.relative(ROOT, p)}: ${e.message}`); return null }
}

// ---------------------------------------------------------------- YAML → JS

const PY_SRC = [
  'import sys, json, yaml',
  // Windows 上 Python 的 stdout 默认是 GBK，契约里有 ⚠️ 之类的字符会直接抛 UnicodeEncodeError。
  "sys.stdout.reconfigure(encoding='utf-8')",
  'class Strict(yaml.SafeLoader):',
  '    pass',
  'def _map(loader, node, deep=False):',
  '    seen = []',
  '    for k, _ in node.value:',
  '        key = loader.construct_object(k, deep=deep)',
  '        if key in seen:',
  '            raise yaml.constructor.ConstructorError(None, None,',
  "                'duplicate key: %r' % (key,), k.start_mark)",
  '        seen.append(key)',
  '    return yaml.SafeLoader.construct_mapping(loader, node, deep)',
  'Strict.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _map)',
  "data = yaml.load(open(sys.argv[1], encoding='utf-8'), Loader=Strict)",
  'json.dump(data, sys.stdout, ensure_ascii=False)',
].join('\n')

function findPython () {
  for (const exe of ['python', 'py', 'python3']) {
    try {
      execFileSync(exe, ['-I', '-c', 'import yaml'], { stdio: 'ignore', timeout: 30000 })
      return exe
    } catch (e) { /* 试下一个 */ }
  }
  return null
}

const python = findPython()
if (!python) {
  console.error('CONTRACT_FAIL 未找到可用的 Python + PyYAML。')
  console.error(' 契约校验需要 PyYAML 做 YAML→JSON 转换（Node 无内置 YAML 模块）。')
  console.error(' 安装：pip install pyyaml')
  process.exit(2)
}

function loadYaml (file) {
  let out
  try {
    out = execFileSync(python, ['-I', '-c', PY_SRC, file], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().trim()
    fail(`${path.relative(ROOT, file)} 解析失败：\n     ${msg.split('\n').slice(0, 8).join('\n     ')}`)
    return null
  }
  try { return JSON.parse(out) } catch (e) { fail(`${path.relative(ROOT, file)} 转 JSON 失败: ${e.message}`); return null }
}

// ---------------------------------------------------------------- 通用工具

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']
/** 归一化路径：把 {id}/{doctorId} 之类的参数名抹平，只保留结构。 */
const norm = (p) => p.replace(/\{[^}]*\}/g, '{}')
/** 把 "POST /api/v1/x" 或 "/api/v1/x" 拆成 {method, path}；method 为大写或 null。 */
function splitOp (s) {
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/.exec(String(s).trim())
  return m ? { method: m[1].toLowerCase(), path: m[2] } : { method: null, path: String(s).trim() }
}

/** 解析 #/a/b/c 形式的本地 $ref，返回目标对象；不存在返回 undefined。 */
function resolvePointer (root, ref) {
  if (!ref.startsWith('#')) return undefined
  return ref.slice(1).split('/').slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((acc, k) => (acc == null ? undefined : acc[k]), root)
}

/** 递归收集文档中所有 $ref 字符串。 */
function collectRefs (node, out) {
  if (Array.isArray(node)) { node.forEach((n) => collectRefs(n, out)); return out }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v)
      else collectRefs(v, out)
    }
  }
  return out
}

// ---------------------------------------------------------------- 装载

const docs = []
for (const [label, file] of [['business', BUSINESS], ['ai', AI]]) {
  const raw = read(file)
  if (!raw) continue
  const json = loadYaml(file)
  if (!json) continue
  const text = raw
  docs.push({ label, file, rel: path.relative(ROOT, file), doc: json, text })
}
if (errors.length) { report(); process.exit(1) }

const byLabel = (l) => docs.find((d) => d.label === l)

// ---------------------------------------------------------------- ① 文档级

for (const d of docs) {
  const o = d.doc
  if (!/^3\.(0|1)\.\d+$/.test(String(o.openapi || ''))) fail(`${d.rel}: openapi 版本缺失或不受支持（${o.openapi}）`)
  for (const k of ['title', 'version', 'description']) {
    if (!o.info || !o.info[k]) fail(`${d.rel}: info.${k} 缺失`)
  }
  if (!o.paths || !Object.keys(o.paths).length) fail(`${d.rel}: paths 为空`)
  for (const p of Object.keys(o.paths || {})) {
    if (!p.startsWith('/')) fail(`${d.rel}: 路径必须以 / 开头：${p}`)
  }
  // $ref 必须能在本文件内解析；跨文件引用会让两份契约互相耦合，禁止。
  const refs = [...new Set(collectRefs(o, []))]
  for (const r of refs) {
    if (!r.startsWith('#')) { fail(`${d.rel}: 不允许外部 $ref（${r}）——两份契约必须各自自洽`); continue }
    if (resolvePointer(o, r) === undefined) fail(`${d.rel}: $ref 无法解析：${r}`)
  }
}

// ---------------------------------------------------------------- ② 操作级

const operations = []
for (const d of docs) {
  const declaredTags = new Set((d.doc.tags || []).map((t) => t.name))
  for (const [pathKey, item] of Object.entries(d.doc.paths || {})) {
    const sharedParams = item.parameters || []
    for (const method of METHODS) {
      const op = item[method]
      if (!op || typeof op !== 'object') continue
      operations.push({ d, pathKey, method, op })
      const where = `${d.rel} ${method.toUpperCase()} ${pathKey}`
      if (!op.operationId) fail(`${where}: 缺 operationId`)
      if (!op.summary) fail(`${where}: 缺 summary`)
      if (!Array.isArray(op.tags) || !op.tags.length) fail(`${where}: 缺 tags`)
      for (const t of op.tags || []) {
        if (!declaredTags.has(t)) fail(`${where}: tag "${t}" 未在文档 tags 中声明`)
      }
      const codes = Object.keys(op.responses || {})
      if (!codes.length) fail(`${where}: 未声明任何响应`)
      if (!codes.some((c) => /^2\d\d$/.test(c))) fail(`${where}: 没有 2xx 成功响应`)
      // 错误响应必须走统一信封，避免每个端点各造一种错误结构。
      // 注意：命名可复用的 response（BadRequest/NotFound…）是期望做法，要看它**指向**的
      // schema 是不是统一信封，而不是看 response 组件本身叫什么名字。
      for (const c of codes.filter((c) => /^[45]\d\d$/.test(c))) {
        // 探针类端点例外：就绪探针 503 的响应体**本身就是**状态报告（ReadinessResult），
        // 不是错误信封。这类操作显式声明 x-error-envelope: none 才放行。
        if (op['x-error-envelope'] === 'none') continue
        const r = op.responses[c]
        const target = r && r.$ref ? resolvePointer(d.doc, r.$ref) : r
        if (!target) { fail(`${where} ${c}: 响应无法解析`); continue }
        const json = target.content && target.content['application/json']
        const schemaRef = json && json.schema && json.schema.$ref
        const name = schemaRef ? schemaRef.split('/').pop() : null
        if (!name) {
          fail(`${where} ${c}: 错误响应未指向统一错误信封（缺 application/json schema）`)
        } else if (!['ApiError', 'ErrorResponse'].includes(name)) {
          fail(`${where} ${c}: 错误响应 schema 应为 ApiError/ErrorResponse，实际为 ${name}`)
        }
      }
      // 写操作必须交代幂等：要么带 Idempotency-Key，要么显式声明不需要
      if (['post', 'put', 'patch', 'delete'].includes(method)) {
        const params = [...sharedParams, ...(op.parameters || [])]
        const hasKey = params.some((p) => {
          if (p && p.$ref) {
            const t = resolvePointer(d.doc, p.$ref)
            return t && t.name === 'Idempotency-Key'
          }
          return p && p.name === 'Idempotency-Key'
        })
        if (!hasKey && op['x-idempotency'] !== 'not-required') {
          fail(`${where}: 写操作必须声明 Idempotency-Key，或显式标注 x-idempotency: not-required`)
        }
      }
      // 认证边界：要么显式 security（含空数组=匿名），要么有文档级默认
      const hasOpSecurity = Object.prototype.hasOwnProperty.call(op, 'security')
      if (!hasOpSecurity && !d.doc.security) fail(`${where}: 既无文档级 security 也无操作级 security，认证边界不明`)
      if (hasOpSecurity && op.security.length) {
        for (const s of op.security) {
          for (const scheme of Object.keys(s)) {
            if (!d.doc.components || !d.doc.components.securitySchemes || !d.doc.components.securitySchemes[scheme]) {
              fail(`${where}: security 引用了未定义的 scheme "${scheme}"`)
            }
          }
        }
      }
    }
  }
}

const opIds = new Map()
for (const o of operations) {
  if (!o.op.operationId) continue
  if (opIds.has(o.op.operationId)) {
    fail(`operationId 重复：${o.op.operationId}（${opIds.get(o.op.operationId)} 与 ${o.d.rel} ${o.method.toUpperCase()} ${o.pathKey}）`)
  } else {
    opIds.set(o.op.operationId, `${o.d.rel} ${o.method.toUpperCase()} ${o.pathKey}`)
  }
}

// ---------------------------------------------------------------- ③ 双契约边界

const business = byLabel('business')
const ai = byLabel('ai')
if (business && ai) {
  const aiPaths = Object.keys(ai.doc.paths || {})
  const bizNorm = new Set(Object.keys(business.doc.paths || {}).map(norm))
  for (const p of aiPaths) {
    if (bizNorm.has(norm(p))) fail(`路径同时属于两份契约，路由归属不可预测：${p}`)
  }
  // FastAPI 只在内网：它的路径不得落在对外前缀下
  for (const p of aiPaths) {
    if (!p.startsWith('/internal/')) {
      fail(`${ai.rel}: 内部服务路径必须以 /internal/ 开头，实际为 ${p}（网关会把它暴露给客户端）`)
    }
  }
  // O-02 定稿前不得声明回调端点
  for (const p of aiPaths) {
    if (/callback/i.test(p)) fail(`${ai.rel}: O-02 未定稿前不得声明回调端点：${p}`)
  }
}

// ---------------------------------------------------------------- ④ 契约里的声明性事实

/** 契约的价值一半在结构，一半在这些"必须说清楚"的话。缺了就是漏了承诺。 */
function requireText (d, re, label) {
  if (!d) return
  if (!re.test(d.text)) fail(`${d.rel}: 缺少必需表述 —— ${label}`)
}
if (business) {
  requireText(business, /目标态/, '声明这是目标态契约而非已实现现状')
  requireText(business, /不得绕过\s*Spring Boot/, '声明客户端不得绕过 Spring Boot')
  requireText(business, /O-02/, '标注 O-02（回调未定稿）')
  requireText(business, /轮询/, '声明轮询是 O-02 定稿前的唯一权威路径')
  requireText(business, /404[^\n]*不用于区分/, '声明 404 不区分"不存在"与"无权限"')
  requireText(business, /严禁捕获异常后返回/, '声明禁止异常吞掉后返回 200 + 空对象')
  requireText(business, /Azure/, '说明 TTS 不是 Azure 正式商业 API')
  requireText(business, /O-01/, '标注 O-01（对象存储上传方式未定）')
}
if (ai) {
  requireText(ai, /仅内网可达|只在服务内网可达/, '声明仅内网可达')
  requireText(ai, /O-02/, '标注 O-02（回调未定稿）')
  requireText(ai, /轮询/, '声明轮询是 O-02 定稿前的唯一权威路径')
  requireText(ai, /不直接写业务库/, '声明权威记录不在本服务')
}
// provisional 条目必须被显式标记，不能混在已定稿内容里
{
  const cb = business && business.doc.paths && business.doc.paths['/internal/v1/callbacks/task-events']
  if (cb && cb.post && cb.post['x-status'] !== 'provisional') {
    fail(`${business.rel}: /internal/v1/callbacks/task-events 必须标注 x-status: provisional（O-02 未定稿）`)
  }
}

// ---------------------------------------------------------------- ⑤ 与仓库注册表对齐

const apiSrc = read(APIJS)
if (apiSrc) {
  const entries = []
  const re = /\{\s*base:\s*'([^']+)'\s*,\s*path:\s*'([^']+)'\s*\}/g
  let m
  while ((m = re.exec(apiSrc))) entries.push({ base: m[1], path: m[2] })
  if (!entries.length) fail(`${path.relative(ROOT, APIJS)}: 未解析到任何 { base, path } 注册项，正则需要更新`)

  const uniq = new Map()
  for (const e of entries) if (!uniq.has(e.path)) uniq.set(e.path, e)

  const contractPaths = new Set()
  for (const d of docs) for (const p of Object.keys(d.doc.paths || {})) contractPaths.add(norm(p))

  const migration = (business && business.doc['x-migration'] && business.doc['x-migration'].entries) || []
  if (!migration.length) fail(`${business ? business.rel : 'business'}: x-migration.entries 缺失或为空`)
  const legacyPaths = new Set(migration.map((e) => norm(splitOp(e.legacy).path)))

  // 注册表里每条路径都要有归属：要么在契约里，要么在迁移表里
  for (const [p, e] of uniq) {
    if (contractPaths.has(norm(p)) || legacyPaths.has(norm(p))) continue
    fail(`api.js 注册了 ${p}（base=${e.base}），但两份契约与 x-migration 里都没有它`)
  }
  // 迁移表不能有僵尸条目：legacy 必须真的还在注册表里
  for (const e of migration) {
    const lp = splitOp(e.legacy).path
    if (!uniq.has(lp)) fail(`x-migration 里的 ${e.legacy} 已不在 api.js 注册表中，属僵尸条目，应删除`)
  }
  // 迁移目标必须真实存在，否则"迁移"没有落点
  for (const e of migration) {
    if (!e.replacement) continue
    const { method, path: rp } = splitOp(e.replacement)
    const found = operations.some((o) => norm(o.pathKey) === norm(rp) && (!method || o.method === method))
    if (!found) fail(`x-migration 里的 ${e.legacy} → ${e.replacement} 目标不存在于任何契约`)
  }
  // 客户端不得触及内部路径
  for (const p of uniq.keys()) {
    if (p.startsWith('/internal/')) fail(`api.js 注册了内部路径 ${p}，客户端不得访问内部服务`)
  }

  // V4 网关语义：/api/gw/** 网关自身；其余 /api/** 全量代理 business-service。
  // base 表达"该能力最终由哪个上游产出"，不再是路由分流依据（旧 JAVA_PREFIXES 白名单已废弃）。
  // 校验：base 取值合法；base=gateway 的路径必须以 /api/gw/ 开头且已在 business 契约登记。
  const BASE_ENUM = ['gateway', 'java', 'python']
  const bizPaths = new Set(
    Object.keys((business && business.doc && business.doc.paths) || {}).map(norm)
  )
  for (const [p, e] of uniq) {
    const where = `api.js ${p}（base=${e.base}）`
    if (!BASE_ENUM.includes(e.base)) {
      fail(`${where}: base 取值非法，仅允许 gateway/java/python`)
      continue
    }
    if (e.base === 'gateway') {
      if (!p.startsWith('/api/gw/')) fail(`${where}: base=gateway 但路径不属于 /api/gw/**`)
      else if (!bizPaths.has(norm(p))) fail(`${where}: base=gateway 但未在 business 契约登记`)
    }
  }
}

// ---------------------------------------------------------------- 输出

function report () {
  const counts = docs.map((d) => `${d.label}=${Object.keys(d.doc.paths || {}).length}`).join(' ')
  if (errors.length) {
    console.error(`CONTRACT_FAIL ${errors.length} 处问题`)
    errors.forEach((e) => console.error(' ✗ ' + e))
    if (warnings.length) warnings.forEach((w) => console.error(' ! ' + w))
    process.exit(1)
  }
  warnings.forEach((w) => console.log(' ! ' + w))
  console.log(`CONTRACT_CHECK_OK ${counts} ops=${operations.length} uniqueOperationIds=${opIds.size} warnings=${warnings.length}`)
}
report()
