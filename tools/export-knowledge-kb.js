/**
 * export-knowledge-kb.js —— 科普内容单一事实源导出（2026-11-21 治理合并）
 *
 * 背景：backend/ai-service/scripts/ingest_knowledge_kb.py 曾手抄前端科普内容，
 * 标题/正文已漂移（sleep-quality、bp-daily、diabetes-diet 等 9/10 条不一致）。
 * 本脚本以 miniprogram/utils/knowledge-kb.js（③，科普主数据源）为唯一源，
 * 导出 backend/ai-service/data/knowledge-articles.json，供 ⑪ 入库脚本读取。
 *
 * 用法（仓库根）：
 *   node tools/export-knowledge-kb.js          # 写出 JSON
 *   node tools/export-knowledge-kb.js --check  # 只比对，漂移则退出码 1（门禁用）
 *
 * 禁止手改导出文件；改科普只改 ③ 后重跑本脚本。
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..')
const KB = require(path.join(REPO, 'miniprogram', 'utils', 'knowledge-kb.js'))
const OUT = path.join(REPO, 'backend', 'ai-service', 'data', 'knowledge-articles.json')

const articles = KB.ARTICLES.map(a => ({
  id: a.id,
  title: a.title,
  category: a.category,
  source: a.source,
  publishedAt: a.publishedAt,
  // ③ 的 sections 是 { h, p: string[] }；入库切片按「标题+整段正文」拼接
  sections: a.sections.map(s => ({ h: s.h, p: s.p.join('') }))
}))

const videos = KB.VIDEOS.map(v => ({
  id: v.id,
  title: v.title,
  category: v.category,
  source: '院内宣传科', // ③ 视频条目无 source 字段，入库口径沿用原 ⑪ 值
  publishedAt: v.publishedAt || null,
  tips: v.tips
}))

const doc = {
  _generated: '由 tools/export-knowledge-kb.js 从 miniprogram/utils/knowledge-kb.js 生成，禁止手改',
  sourceFile: 'miniprogram/utils/knowledge-kb.js',
  counts: { articles: articles.length, videos: videos.length },
  articles,
  videos
}

const serialized = JSON.stringify(doc, null, 2) + '\n'

if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT)) {
    console.error('[export-knowledge-kb] 导出文件不存在，请先运行 node tools/export-knowledge-kb.js')
    process.exit(1)
  }
  const cur = fs.readFileSync(OUT, 'utf8')
  if (cur !== serialized) {
    console.error('[export-knowledge-kb] FAIL：导出文件与 ③ 不一致（有人手改了导出文件或改了 ③ 未重跑）')
    process.exit(1)
  }
  console.log('[export-knowledge-kb] OK：导出文件与 knowledge-kb.js 一致')
  process.exit(0)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, serialized, 'utf8')
console.log(`[export-knowledge-kb] 已导出 ${articles.length} 图文 + ${videos.length} 视频 → backend/ai-service/data/knowledge-articles.json`)
