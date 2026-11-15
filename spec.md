# Spec — 健康科普文案真人化 + 后端列表接口接入（服务端优先、本地 KB 降级）

日期：2026-11-15 ｜ 状态：待批准

## 1. 背景与目标

用户指令：「接着优化健康科普的文字的文本，更合理真人化，并留下与后端链接的接口，便于以后将健康科普的内容读取转为后端」。

两个子目标：

1. **文案真人化**：改写 `miniprogram/utils/knowledge-kb.js` 中 7 篇图文 + 3 条视频的标题、摘要、keyPoints、sections、tip/tips，使其读起来像真人（院内宣教老师/医生）写的，而非模板生成腔；**结构字段与条数一律不动**。
2. **留下后端接口**：在前端补齐 N12 科普列表接口的连接层（api 常量 + service 函数 + 页面接线），实现「服务端列表优先、空/失败降级本地 KB 并显式提示」的双源逻辑，使以后内容读取可平滑切换为后端。

## 2. 关键事实（已核实，不再复查）

- 契约 `backend/contracts/business-openapi.yaml` N12 `GET /api/v1/health-articles`（参数 category/type/kw/cursor/limit，返回 `OkArticleList{list,nextCursor,hasMore}`）与 N13 详情**均已存在**，后端 Controller/Service/Repository 已实现；`health_articles` 表当前 0 行。
- 契约描述明文要求：「本地 KB 仍是离线降级，列表为空或不可用时前端降级到本地内容并显式提示，不伪造服务端数据」——本 spec 的双源逻辑即按此口径。
- `request.js` 的 `ANONYMOUS` 白名单已含 `GET /api/v1/health-articles` 与 `GET /api/v1/health-articles/*`，无需改 request.js。
- 后端 `Article` 字段仅 `{id, title, summary, coverUrl, category, type, readMin, publishedAt}`，**无** sections/keyPoints/tip/related/icon/coverKey/durationSec → 详情正文仍只能来自本地 KB；列表页需要 iconPath/cover，由前端从字段映射补齐。
- `resolveAttachmentUrl`（services/user.js L239-245）：绝对 http(s) 原样返回，`/` 开头拼 `ENV.gateway`。
- 测试钉死约束（不可破坏）：
  - `tools/test-knowledge-filter.js`：wx stub **无 request**；`inst.onLoad()` 同步后 `data.list.length === KB.FEED.length`；`onCat('睡眠')`/`onType` 同步断言 3 视频 / 7 图文 / 睡眠×视频=0。
  - `tools/test-pkg-deep-audit.js`：spy `KB.filterFeed` 实参；video=3、article=7、睡眠×视频=0。
  - `tools/test-detail-video.js`：wash-hands 条目、metaLine 含 durationSec、远端 videoUrl 覆盖/回落。
- 引用方影响：`pages/home/home.js` 用 `KB.ARTICLES[0..3]` 的 title/summary 做首页小贴士 → 文案改写会同步影响首页（可接受，属同一文案体系）。
- 条目 id 与结构字段（id/type/category/icon/coverKey/heroKey/videoKey/durationSec/readMin/publishedAt/source/related/segments 数量）全部保持不变；`wash-hands` 的 category 保持 `'健康饮食'`（不在 chips 内，测试未断言但属现状，不动）。

## 3. 变更清单（精确到文件/函数）

### 3.1 文案改写 — `miniprogram/utils/knowledge-kb.js`（仅改文本字段）

- 覆盖 3 条视频的 `title/summary/tips`，7 篇图文的 `title/summary/keyPoints/sections[].{h,p[]}/tip`。
- 真人化标准：
  - 去掉「医生给出这5个建议」「看这4点就够了」这类标题党/模板句式，改为口语化但专业的表达（保留信息量，不注水）；
  - 段落像医生当面交代：短句、有场景、有具体数字，避免排比堆砌与「首先其次最后」八股；
  - 不新增医疗结论、不编造新数据：**只重写表达，不改变原意与原有事实/数字**（如 5 克盐、30 秒三步曲、48 小时抗病毒等保持不变）；
  - 保持中老年可读：单句不绕、避免生僻词。
- **不改**：`CATEGORIES`、`DISCLAIMER`、`FEED/byId/filterFeed` 逻辑、任何结构字段、条数与顺序。
- 已知测试耦合：`tools/test-detail-video.js` 断言 `item.title === '正确洗手七步法'` —— 经查该断言对象是**详情页 metaLine 用的远端/别名数据**而非 KB `wash-hands.title`（KB 现值为「七步洗手法」）；执行时若跑红需回读该测试确认断言对象，**若断言指向 KB.title 则该条标题不得改动**（保底策略：执行阶段先跑测试拿到基线，再动笔）。

### 3.2 接口连接层（三处新增，均为增量）

1. `miniprogram/config/api.js` — 追加常量（与现有 `HEALTH_ARTICLE_DETAIL` 同风格）：
   ```js
   HEALTH_ARTICLE_LIST: { base: 'java', path: '/api/v1/health-articles' }
   ```
2. `miniprogram/packageContent/services/content.js` — 追加：
   ```js
   /** 科普列表（N12）。params: { category, type, kw, cursor, limit }（空值不携带） */
   function listArticles(params) {
     const q = {}
     Object.keys(params || {}).forEach((k) => { if (params[k] !== '' && params[k] != null) q[k] = params[k] })
     return get(API.HEALTH_ARTICLE_LIST, null, { params: undefined, ... }) // 实际用 query 传参
   }
   ```
   实现按 `request.js` 的 `get(spec, data, opts)` 真实签名落地（opts.params 是路径占位符替换；query 传参方式以 request.js 现状为准——执行时读 `get()` 对 data/opts 的处理：若 data 被当作 query 拼接则用 data 传参）。
   同时导出 `normalizeArticle(raw)`（内部函数，可不导出）：把服务端 Article 映射为列表页可渲染对象：
   `{ id, type, title, summary, category, readMin, publishedAt, cover: resolveAttachmentUrl(raw.coverUrl || ''), iconPath: icons[...] , fromServer: true }`；icon 由 category/type 推一个默认键（复用 icons.js 现有键，如 video→`play`/`sparkles`，图文按 type 默认 `info`/`fileText`——以 icons.js 实际键为准，执行时查）。
3. `miniprogram/packageContent/pages/knowledge/knowledge.js` — 双源接线：
   - 保持现有同步链路不变：`onLoad()` → `_buildAll()`（本地 KB）→ `_apply()`（本地筛选）→ **同步断言不被破坏**。
   - 追加异步 `_fetchRemote()`：在 `onLoad` 末尾（`_apply()` 之后）调用 `contentService.listArticles({ category: 规范化分类, type, kw })`，**必须 `.catch(() => null)` 兜底**（wx stub 无 request 时同步断言不受影响；真实环境网络失败静默降级）。
   - 成功且 `list.length > 0` → `this._remote = mapped`，`_apply()` 改为：`this._remote` 非空时用服务端集合作 allow 来源（保持本地 filterFeed 逻辑仅用于本地源），并置 `data.sourceTip = ''`。
   - 服务端返回空列表或失败 → `this._remote = null`，走本地 KB，置 `data.sourceTip = '当前展示本地科普库内容'`（显式提示，不伪造服务端数据）。
   - `onCat/onType/onSearch` 触发时：本地筛选立即生效；同时重新触发 `_fetchRemote()`（带 .catch），服务端结果回来后覆盖。
   - 分类/类型/关键词参数映射：cat `'全部'`→不传；type `'all'`→不传；kw 传 `keyword`。
   - WXML `knowledge.wxml`：在分类 chips 下方/列表上方追加一行 `wx:if="{{sourceTip}}"` 的轻提示（复用现有 `kb-note` 或新增同风格 class，样式放本页 wxss，颜色用现有 muted 令牌，**不改 app.wxss**）。
   - 更新文件头注释：数据来源改为「服务端优先 + 本地 KB 降级」。

### 3.3 明确不做（范围控制）

- 不改 `detail.js` 的服务端正文降级（后端 Article 无 sections，详情正文只能本地；详情页已有 videoUrl 远端增强）。
- 不改契约、不改后端、不改 request.js 白名单。
- 不新增分页（本地 10 条；服务端首期 0 行，limit 取 50 一次拉全）。
- 不动 `home.js`（其引用自动获得新文案）。

## 4. 验证步骤（缺一不可）

1. `node --check` 改动的全部 JS 文件。
2. `node tools/check-project.js`（全绿：js/json/图标/禁址/包体门禁）。
3. `node tools/test-knowledge-filter.js`
4. `node tools/test-detail-video.js`
5. `node tools/test-pkg-deep-audit.js`
6. （如存在）`node tools/test-fe-all.js`
7. 人工核对：条数 7 图文 + 3 视频不变、id 不变、`filterFeed` 三组断言不变。

## 5. 记录与汇报

- 追加 `DEV_LOG.md` 尾部一条（2026-11-15：健康科普文案真人化 + N12 列表接口接线）。
- 输出格式：`完成 → 修改 → 验证 → 日志 → 下一步`。

## 6. 待批准项

- [ ] 文案真人化风格（口语化、保留原意与数字）是否符合预期
- [ ] 降级提示文案「当前展示本地科普库内容」
- [ ] 服务端优先 + 本地降级的双源方案（含 onCat/onType/onSearch 联动重取）
