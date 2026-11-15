# Tasks — 健康科普文案真人化 + 后端列表接口接入

依据：spec.md（2026-11-15）。批准后按序执行，全部完成后按 `完成 → 修改 → 验证 → 日志 → 下一步` 汇报。

- [x] T0 基线：先跑 `node tools/test-knowledge-filter.js`、`node tools/test-detail-video.js`、`node tools/test-pkg-deep-audit.js` 拿基线；确认 `test-detail-video.js` 中 `'正确洗手七步法'` 断言的对象是否为 KB.title（若是 → wash-hands 标题锁定不改）。
- [x] T1 文案改写：`miniprogram/utils/knowledge-kb.js` —— 3 视频 title/summary/tips + 7 图文 title/summary/keyPoints/sections/tip 全部真人化；只改文本，结构字段/条数/id/CATEGORIES/DISCLAIMER/filterFeed 不动。
- [x] T2 `miniprogram/config/api.js` — 追加 `HEALTH_ARTICLE_LIST: { base: 'java', path: '/api/v1/health-articles' }`。
- [x] T3 `miniprogram/packageContent/services/content.js` — 追加 `listArticles(params)`（先读 request.js 的 get() 确定 query 传参方式），空值参数不携带；返回 unwrap 后的 OkArticleList。
- [x] T4 `miniprogram/packageContent/pages/knowledge/knowledge.js` — 双源接线：同步本地链路保持（onLoad 后 list 由 KB 填充）；`_fetchRemote()` 带 `.catch(()=>null)`；成功非空→服务端优先，空/失败→本地 KB + `sourceTip='当前展示本地科普库内容'`；onCat/onType/onSearch 联动重取；更新头注释。
- [x] T5 `knowledge.wxml` — 追加 `wx:if="{{sourceTip}}"` 轻提示行（样式在本页 wxss，用现有 muted 色令牌）。
- [x] T6 验证：`node --check` 全部改动 JS → `node tools/check-project.js` → `test-knowledge-filter.js` → `test-detail-video.js` → `test-pkg-deep-audit.js`（+ `test-fe-all.js` 若存在）。任一红灯先修再进下一任务。
- [x] T7 记录：追加 `DEV_LOG.md` 尾部条目；汇报 `完成 → 修改 → 验证 → 日志 → 下一步`。
