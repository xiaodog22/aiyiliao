#!/usr/bin/env node
'use strict'
/**
 * check-v4-prototypes.js —— 网页原型与截图一致性门禁
 *
 * 校验：24 路由三处一致（app.json / 清单 / HTML）、无外部资源依赖、
 * CSS 括号与可访问性基线、标准/平板/变体三类截图齐全且尺寸正确、
 * 变体触发机制（prototype.js applyQuery + tokens.css 类名）真实存在。
 */
const fs=require('fs'),path=require('path'),vm=require('vm')
const ROOT=path.resolve(__dirname,'..'),WEB=path.join(ROOT,'prototype-web'),APP=path.join(ROOT,'miniprogram','app.json'),MF=path.join(WEB,'pages.manifest.json'),SS=path.join(WEB,'screenshots')
const errors=[],warn=[];const fail=x=>errors.push(x)
function read(p){try{return fs.readFileSync(p,'utf8')}catch(e){fail('缺少文件 '+path.relative(ROOT,p));return''}}
function pngSize(p){try{const b=fs.readFileSync(p);if(b.length<24||b.toString('ascii',1,4)!=='PNG')throw 0;return [b.readUInt32BE(16),b.readUInt32BE(20)]}catch(e){fail('截图无效 '+path.relative(ROOT,p));return[0,0]}}
/** 校验一张截图存在且尺寸与期望视口一致 */
function checkShot(rel,vp,label){
  const f=path.join(SS,rel)
  if(!fs.existsSync(f)){fail('缺少'+label+' '+path.relative(ROOT,f));return}
  const [w,h]=pngSize(f)
  if(w!==vp.width||h!==vp.height)fail(`${rel} 尺寸 ${w}x${h}，期望 ${vp.width}x${vp.height}`)
}
let manifest,app;try{manifest=JSON.parse(read(MF));app=JSON.parse(read(APP))}catch(e){fail('JSON 语法错误: '+e.message);manifest={pages:[]};app={pages:[],subPackages:[]}}
const routes=[...(app.pages||[]),...(app.subPackages||[]).flatMap(sp=>(sp.pages||[]).map(p=>sp.root+'/'+p))]
if(routes.length!==24)fail(`app.json 路由数应为24，实际${routes.length}`)
const mr=manifest.pages.map(x=>x.route);for(const r of routes)if(!mr.includes(r))fail('清单遗漏路由 '+r);for(const r of mr)if(!routes.includes(r))fail('清单存在未知路由 '+r)
if(new Set(mr).size!==mr.length)fail('清单存在重复路由');if(new Set(manifest.pages.map(x=>x.file)).size!==manifest.pages.length)fail('清单存在重复 HTML 文件')
const required=[path.join(WEB,'index.html'),path.join(WEB,'shared','tokens.css'),path.join(WEB,'shared','components.css'),path.join(WEB,'shared','prototype.js')]
for(const p of required)if(!fs.existsSync(p))fail('缺少文件 '+path.relative(ROOT,p))
const extRe=/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//ig
const VIEWPORTS=manifest.variantViewports||{},QUERIES=manifest.variantQueries||{}
let variantTotal=0
for(const p of manifest.pages){
  const f=path.join(WEB,p.file),html=read(f)
  if(!/<!doctype html>/i.test(html))fail(p.file+' 缺少doctype')
  if(!/<html[^>]*lang="zh-CN"/i.test(html))fail(p.file+' 缺少lang=zh-CN')
  if(!/name="viewport"/i.test(html))fail(p.file+' 缺少viewport')
  if(!/data-page=/i.test(html))fail(p.file+' 缺少页面配置')
  if(extRe.test(html))fail(p.file+' 引用了外部资源');extRe.lastIndex=0
  checkShot(p.id+'.png',manifest.standardViewport,'标准截图')
  if(p.tablet)checkShot(p.id+'--tablet.png',manifest.tabletViewport,'平板截图')
  for(const name of p.variants||[]){
    const vp=VIEWPORTS[name],q=QUERIES[name]
    if(!vp&&!q)fail(`${p.id} 声明了未登记变体 ${name}（既不在 variantViewports 也不在 variantQueries）`)
    checkShot(`${p.id}--${name}.png`,vp||manifest.standardViewport,'变体截图')
    variantTotal++
  }
}
// 变体触发机制必须真实存在，否则截图只是"改名后的默认态"，属于伪证据
const pjs=read(path.join(WEB,'shared','prototype.js'))
if(Object.keys(QUERIES).length){
  if(!/function applyQuery/.test(pjs))fail('prototype.js 缺少 applyQuery，URL 无法驱动状态/大字/高对比')
  if(!/classList\.add\('demo-capture'\)/.test(pjs))fail('prototype.js 未在取证态加 demo-capture')
  // 查询串覆盖的页面状态必须是 stateDescriptions 里真实存在的键
  const descBody=(([...pjs.matchAll(/stateDescriptions\s*=\s*\{([\s\S]*?)\n\s*\}/g)][0])||[])[1]||''
  const keys=new Set([...descBody.matchAll(/([A-Za-z]+)\s*:/g)].map(m=>m[1]))
  for(const [name,q] of Object.entries(QUERIES)){
    const m=/^state=(\w+)$/.exec(q)
    if(m){if(!keys.has(m[1]))fail(`变体 ${name} 引用了不存在的页面状态「${m[1]}」`);if(!/stateView\(st\)/.test(pjs))fail('prototype.js 的 applyQuery 未调用 stateView')}
    else if(q==='contrast=1'){if(!/contrast/.test(pjs))fail('prototype.js 未处理 contrast 参数')}
    else if(q==='font=large'){if(!/font-large/.test(pjs))fail('prototype.js 未处理 font 参数')}
    else fail(`变体 ${name} 的查询串「${q}」无法被 applyQuery 识别`)
  }
  const tcss=read(path.join(WEB,'shared','tokens.css'))
  if(!/html\.high-contrast/.test(tcss))fail('tokens.css 缺少 .high-contrast 样式')
  if(!/html\.font-large/.test(tcss))fail('tokens.css 缺少 .font-large 样式')
  if(!/html\.demo-capture/.test(tcss))fail('tokens.css 缺少 .demo-capture 样式')
}
for(const p of [path.join(WEB,'shared','prototype.js'),path.join(ROOT,'tools','render-v4-prototypes.js'),__filename]){const code=read(p);try{new vm.Script(code,{filename:p})}catch(e){fail('JS 基本语法错误 '+path.relative(ROOT,p)+': '+e.message)}if(extRe.test(code))fail(path.relative(ROOT,p)+' 包含外部资源 URL');extRe.lastIndex=0}
for(const css of [path.join(WEB,'shared','tokens.css'),path.join(WEB,'shared','components.css')]){const s=read(css);let n=0;for(const c of s){if(c==='{')n++;if(c==='}')n--;if(n<0)break}if(n!==0)fail(path.relative(ROOT,css)+' 花括号不平衡');if(/@import\s+url|https?:\/\//i.test(s))fail(path.relative(ROOT,css)+' 引用了外部资源')}
const index=read(path.join(WEB,'index.html'))
const indexLoadsManifest=/fetch\(['"]pages\.manifest\.json['"]\)/.test(index)
if(!indexLoadsManifest){for(const p of manifest.pages)if(!index.includes(p.file))fail('index 未链接 '+p.file)}
if(!/prefers-reduced-motion/.test(read(path.join(WEB,'shared','tokens.css'))))fail('缺少减少动画支持');if(!/:focus-visible/.test(read(path.join(WEB,'shared','tokens.css'))))fail('缺少可见焦点');if(!/prototypeImageFallback/.test(index))warn.push('总览页未提供图像失败回退（当前原型无业务图片依赖）')
if(errors.length){console.error('CHECK_FAIL '+errors.length);errors.forEach(x=>console.error(' - '+x));if(warn.length)warn.forEach(x=>console.warn(' WARN '+x));process.exit(1)}
console.log(`CHECK_OK routes=${routes.length} html=${manifest.pages.length} standardScreenshots=${manifest.pages.length} tabletScreenshots=${manifest.pages.filter(x=>x.tablet).length} variantScreenshots=${variantTotal} totalScreenshots=${manifest.pages.length+manifest.pages.filter(x=>x.tablet).length+variantTotal} warnings=${warn.length}`);warn.forEach(x=>console.warn('WARN '+x))
