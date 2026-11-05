#!/usr/bin/env node
/**
 * 无依赖文件扫描（对齐开发者工具「代码质量 · 无使用或无依赖文件 · 代码文件」）。
 *
 * 与 check-require.js 互补：
 *   check-require.js       —— 正向：所有 require/相对引用都能解析到真实文件；
 *   check-orphan-files.js  —— 反向：从入口（app.json / app.js / custom-tab-bar）做
 *                             可达性遍历，未被任何入口覆盖的 .js/.json/.wxml/.wxss/.wxs
 *                             即为「无依赖文件」。
 *
 * 入口种子：
 *   - app.js / app.wxss / app.json（pages、subPackages、tabBar、usingComponents）
 *   - custom-tab-bar/index.*（框架隐式入口）
 *   - 每个页面路径的四件套（.js/.json/.wxml/.wxss）
 *
 * 边：
 *   .js   -> require('...') / import ... from '...' / import('...')
 *   .json -> usingComponents 的组件路径（取四件套）
 *   .wxml -> <import src> / <include src> / <wxs src>
 *   .wxss -> @import "..."
 *
 * 用法：node tools/check-orphan-files.js [--json]
 * 退出码：0 = 无孤儿；1 = 存在孤儿（或解析异常）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram');
const CODE_EXT = ['.js', '.json', '.wxml', '.wxss', '.wxs'];
const AS_JSON = new Set(['.js', '.json', '.wxml', '.wxss']); // 组件四件套

// 框架/工具自身的入口性文件：即便无显式依赖也算「被使用」
const IMPLICIT_OK = new Set(['app.js', 'app.json', 'app.wxss', 'sitemap.json', 'project.config.json', 'project.private.config.json']);

function listAll(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__pycache__') continue;
      listAll(p, out);
    } else out.push(p);
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function normalize(baseFile, spec) {
  // spec: './x' | '../x' | '/x' | 'x/y'
  let target;
  if (spec.startsWith('.')) target = path.resolve(path.dirname(baseFile), spec);
  else if (spec.startsWith('/')) target = path.join(ROOT, spec.slice(1));
  else target = path.resolve(path.dirname(baseFile), spec); // 裸相对（少见）
  return target;
}

/** 把「文件/无后缀/带某后缀」统一解析到实际存在的文件集合 */
function expand(baseFile, spec) {
  const target = normalize(baseFile, spec);
  const results = [];
  const ext = path.extname(target).toLowerCase();
  if (ext && CODE_EXT.includes(ext)) {
    if (fs.existsSync(target)) results.push(target);
    return results;
  }
  // 无后缀：按四件套/四件套+常见后缀补齐
  for (const e of CODE_EXT) {
    const cand = target + e;
    if (fs.existsSync(cand)) results.push(cand);
  }
  const dir = target;
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const e of CODE_EXT) {
      const cand = path.join(dir, 'index' + e);
      if (fs.existsSync(cand)) results.push(cand);
    }
  }
  return results;
}

function addComponentFiles(p, queue) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.json' || ext === '.js' || ext === '.wxml' || ext === '.wxss') {
    const base = p.slice(0, -ext.length);
    for (const e of ['.js', '.json', '.wxml', '.wxss']) {
      const cand = base + e;
      if (fs.existsSync(cand)) enqueue(cand, queue);
    }
  } else if (ext === '.wxs') {
    enqueue(p, queue);
  }
}

const seen = new Set();
function enqueue(p, queue) {
  const key = rel(p);
  if (seen.has(key)) return;
  seen.add(key);
  queue.push(p);
}

function seeds(queue) {
  for (const f of ['app.js', 'app.json', 'app.wxss']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) enqueue(p, queue);
  }
  // custom-tab-bar 隐式入口
  const ctb = path.join(ROOT, 'custom-tab-bar');
  if (fs.existsSync(ctb)) {
    for (const e of CODE_EXT) {
      const p = path.join(ctb, 'index' + e);
      if (fs.existsSync(p)) enqueue(p, queue);
    }
  }
  // app.json 的页面与组件
  const appJsonPath = path.join(ROOT, 'app.json');
  if (!fs.existsSync(appJsonPath)) {
    console.error('FATAL: 缺少 app.json');
    process.exit(1);
  }
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const pagePaths = [
    ...(appJson.pages || []),
    ...((appJson.subPackages || appJson.subpackages || []).flatMap((s) =>
      (s.pages || []).map((pg) => (s.root || '').replace(/\/$/, '') + '/' + pg)
    )),
    ...(((appJson.tabBar || {}).list) || []).map((i) => i.pagePath),
  ];
  for (const pg of pagePaths) {
    const base = path.join(ROOT, pg);
    for (const e of ['.js', '.json', '.wxml', '.wxss']) {
      const p = base + e;
      if (fs.existsSync(p)) enqueue(p, queue);
    }
  }
}

function edgesOf(file, queue) {
  const ext = path.extname(file).toLowerCase();
  if (!CODE_EXT.includes(ext)) return;
  const text = fs.readFileSync(file, 'utf8');

  if (ext === '.js' || ext === '.json') {
    if (ext === '.js') {
      // require("x") / require('x') / import ... from "x" / import("x")
      const pats = [
        /require\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bimport\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
        /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
      ];
      for (const re of pats) {
        let m;
        while ((m = re.exec(text))) {
          const spec = m[1];
          if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // npm 包
          for (const cand of expand(file, spec)) addComponentFiles(cand, queue);
        }
      }
    }
    if (ext === '.json') {
      let obj = null;
      try { obj = JSON.parse(text); } catch { return; }
      const stack = [obj];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        if (cur.usingComponents && typeof cur.usingComponents === 'object') {
          for (const spec of Object.values(cur.usingComponents)) {
            if (typeof spec !== 'string') continue;
            if (spec.includes('plugin://')) continue;
            for (const cand of expand(file, spec)) addComponentFiles(cand, queue);
          }
        }
        for (const v of Object.values(cur)) {
          if (v && typeof v === 'object') stack.push(v);
        }
      }
    }
  } else if (ext === '.wxml') {
    for (const re of [/<(?:import|include)\s[^>]*?src\s*=\s*["']([^"']+)["']/g, /<wxs\s[^>]*?src\s*=\s*["']([^"']+)["']/g]) {
      let m;
      while ((m = re.exec(text))) {
        for (const cand of expand(file, m[1])) enqueue(cand, queue);
      }
    }
  } else if (ext === '.wxss') {
    const re = /@import\s+(?:url\()?["']([^"']+)["']\)?\s*;/g;
    let m;
    while ((m = re.exec(text))) {
      for (const cand of expand(file, m[1])) enqueue(cand, queue);
    }
  }
}

function main() {
  const queue = [];
  seeds(queue);
  while (queue.length) {
    const f = queue.shift();
    edgesOf(f, queue);
  }

  const all = listAll(ROOT).filter((p) => CODE_EXT.includes(path.extname(p).toLowerCase()));
  const orphans = all.filter((p) => {
    const r = rel(p);
    if (IMPLICIT_OK.has(r)) return false;
    if (r.startsWith('tests/')) return false; // packOptions.ignore 已排除
    if (r.startsWith('tools/')) return false;
    return !seen.has(r);
  });

  const reachable = seen.size;
  console.log(`入口可达 ${reachable} 个代码文件；项目代码文件 ${all.length} 个`);
  if (orphans.length) {
    console.log(`ORPHAN_FILES: ${orphans.length}`);
    for (const p of orphans.sort()) console.log('  - ' + rel(p));
    process.exit(1);
  }
  console.log('RESULT: ORPHAN_OK');
}

main();
