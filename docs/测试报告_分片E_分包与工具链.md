# 分片 E 测试报告 —— 分包 3 页审查（只读）

> 日期：2026-10-29 ｜ 范围：packageNav/pages/nav、packageContent/pages/knowledge、packageContent/pages/detail + 主包引用红线 + app.json 分包配置
> 形态：逐文件静态审查（每项带 文件:行号 证据）；渲染级结论以 tools/preview-nav-page.js --measure（NAV_PREVIEW_OK）与 build-floorplan.py --check 实测为准。
> 约束声明：未修改任何页面/服务/样式/数据源码；indoor-map.js / knowledge-kb.js 为自动生成/随包内容，仅审查。

---

## 1. 页面核对表

### 页面 packageNav/pages/nav（院内导航）

| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 起点 = 医院大门 (720,770) | F | ✅ | indoor-map.js:20-26（ORIGIN x=50.0/y=89.53 = 720/1440、770/860 百分比）；nav.js:110/546/776-777 全部路线以 MAP.ORIGIN 为锚 | 底图 1440×860，百分比坐标同源 |
| 14 目的地（9 个 1F 房间 + 挂号/电梯/楼梯/输液/卫生间） | F | ✅ | indoor-map.js:30-565：14 条（gi/resp/cardio/ortho/radiology/lab/pharmacy/reg/pediatric/gp/elevator/stairs/infusion/toilet）；每条 path 首点均为 (50.0,89.53) | 9 房间=消化/呼吸/心血管/骨/放射/检验/药房/儿科/全科；设施=挂号缴费/电梯厅/楼梯间/输液室/卫生间 |
| 带路两级：1F 房间直达 | F | ✅ | nav.js:381 判定 floor==='1F' 走 `_matchDept` 直达房间；triage-kb.js:116-125 登记 9 个 1F 房间 navigable:true | 后端 4 真实科室（消化/呼吸/心血管/骨）均有独立房间 |
| 带路两级：2F~4F 先出电梯厅 1F 段 + 换层提示条 | F | ✅ | nav.js:381-390（非 1F → dest=elevator 电梯厅 + floorTip「乘电梯上 N 楼」）；换层条渲染 nav.wxml:118-121；非 1F 楼层说明层 nav.wxml:77-83 | 楼上科室：神内/内分泌 3F、皮肤/眼科/耳鼻喉/口腔 2F、妇产/精神 4F（triage-kb.js:126-134） |
| 楼层单一真源 = triage-kb.floor（不在 nav 页另抄楼层表） | F/S | ✅ | nav.js:29-31 require triage-kb；nav.js:434-443 `_deptInfo()` 查 KB.DEPARTMENT_INFO；`_buildFloors()` 后端缺失时回退 KB（nav.js:242-247） | 注释 nav.js:29 明确「楼层只有一处真源」 |
| 急诊科绿色通道（不引导排队） | F/S | ✅ | nav.js:408-411 命中 /急诊\|抢救\|120/ → toast「急诊走大门旁绿色通道，不在本层平面图内」；triage-kb.js:136 急诊科 navigable:false | 注：实现走正则兜底而非读 navigable 字段，等价正确 |
| ?dept= 深链解析 | F | ✅ | nav.js:152 取参 decodeURIComponent；nav.js:158-164 onReady 后 `_applyDeepLink` | |
| 科室匹配三级：DEPT_MAP→DEPT_RULES→名称包含 | F | ✅ | nav.js:421（DEPT_MAP 精确）→ nav.js:425-430（DEPT_RULES 关键字）→ nav.js:431（名称互相包含） | DEPT_MAP nav.js:67-79；DEPT_RULES nav.js:82-98 |
| canvas 同层渲染：底图+路线+标记一张画布 | F/U | ✅ | nav.wxml:48-56 `type="2d" id="nvmap"`；nav.js:446-479 createSelectorQuery 取 node；nav.js:695 drawImage 底图、697-705 路线/终点/起点同层画 | 规避原生 canvas 不同步位移（KNOWN_ISSUES #8） |
| 自研 pan/pinch（不引 movable-view） | F | ✅ | nav.js:562-626 onTouchStart/Move/End：单指拖动 + 双指捏合缩放 + 位移<8px 视为点按命中 | 缩放区间 0.4~2.2（nav.js:48-50） |
| 语音播报 | F | ✅ | nav.wxml:133-136 播报按钮；nav.js:940-964 拼「前往 X…换层提示…步骤」经 speech.speak；带合成中 toast / 降级占位音质提示 | onHide/onUnload stopSpeak（nav.js:174-176） |
| 搜索 + 楼层 tab | F | ✅ | 目的地弹层 nav.wxml:149-161（搜索框+按钮+常用词+分类 chip+结果列表）；楼层胶囊 nav.wxml:59-74；别名俗称 ALIAS nav.js:55-64 | 单结果自动选中 nav.js:308-312 |
| ≥600px 单列 375px 居中 | U | ✅ | nav.wxss:705-710 `@media(min-width:600px){.nvpage{max-width:375px;margin:0 auto}}`；整文件无其他宽度档 | 弹层同步 375px 居中 nav.wxss:954-960 |
| ~~nav.wxss 自声明 max-width:1180px（不分朝向 900px 断点）~~ | U | ⚠️ 口径已迭代 | nav.wxss 全文无 1180px、无 900px 档；test-nav-page.js 实测守卫「宽屏单列 375px 居中」「不再挂 page-shell」 | **任务书该条为旧口径**：2026-10-21 三卡版式重做后改为单列 375px（AI_CONTEXT NEXT_STEP ⑧ 同载），脚本与代码一致，见 §4-B1 |
| ~~地图卡 padding-bottom:62px 防工具栏压图~~ | U | ⚠️ 已不适用 | nav.wxss:101-105 `.nvm` padding 20rpx（≥600px 10px，743-746）；工具栏/胶囊均在 .nvm-stage 内绝对定位（nav.wxss:124-135、244-250） | 旧版满宽布局的修法；新版舞台固定高 656rpx/328px（nav.wxss:107-113、748-750），preview-nav --measure 6 项重叠断言全 false，见 §4-B2 |
| 路线指引卡 meta 行 | U | ❌ | nav.wxml:106 渲染 `{{activeFloorText}}`，但 nav.js data 只有 `activeFloor`（nav.js:123/353/403），全文无 `activeFloorText` | meta 行楼层文案恒空、前缀「·」悬空，见 §4-P2-1 |

### 页面 packageContent/pages/knowledge（健康科普列表）

| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 分类筛选（5 类） | F | ✅ | knowledge-kb.js:19 CATEGORIES=['全部','睡眠','慢病管理','用药安全','老年照护','日常防护','就医指导']；knowledge.js:14/45-48 onCat 过滤 | |
| 类型筛选（全部/图文/提示视频） | F | ❌ | KB 已提供 `filterFeed(category,type)`（knowledge-kb.js:282-288），但 knowledge.js:32-43 只做 cat+keyword 本地过滤，knowledge.wxml 无类型 tab（仅 34-40 分类 chip + 19-30 搜索） | 双维度筛选缺「类型」一维，见 §4-P1-1 |
| 6 图文 + 3 视频元数据 | F | ⚠️ | 实测 FEED = 3 视频（wash-hands/measure-bp/stand-up，knowledge-kb.js:25/42/59）+ **7 图文**（sleep-quality/bp-daily/diabetes-diet/cold-vs-flu/fall-prevent/drug-safety/report-read，:80/109/135/160/185/212/238）= **10 条** | 比 AI_CONTEXT「6 图文+3 视频=9 条」多 1 篇 report-read（体检报告解读），见 §4-P2-2 |
| 本地过滤无分页（9 条） | F | ✅ | knowledge.js:32-43 内存 filter，无分页器 | 实际 10 条仍无需分页 |
| 横屏平板布局 | U | ⚠️ | knowledge.wxss:173-177 手机 2 列；:362-366 横屏平板(≥900×700 横屏) **3 列**、主栏 720px | 任务书写「两列」，实做 3 列（更宽屏信息密度），见 §4-P2-3 |
| 竖屏平板 375px 居中 | U | ✅ | knowledge.wxss:357-359 `@media(600~899px){.kb-page{max-width:375px;margin:0 auto}}`；≥600px 全量 rpx→px（:313-354） | |
| 空态/兜底 | R | ✅ | knowledge.wxml:67-72 无命中空态；无 cover 时图标底板（:51-53）；视频角标 CSS 三角（:55，禁 emoji） | |
| 跳详情 | F | ✅ | knowledge.js:60-62 navigateTo detail?id= | |

### 页面 packageContent/pages/detail（科普详情）

| 功能点（设计要求） | 维度 | 实测 | 证据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| 图文分节正文 | F | ✅ | detail.wxml:69-72 wx:for sections（h + p 段）；tip 小贴士 :76-79 | |
| video 播放 | F | ✅ | detail.wxml:34-37 `<video src poster object-fit=contain>`；源=分包本地 mp4（detail.js:69）+ 远端签名 URL 优先（detail.js:192-216） | |
| video binderror 可见失败说明（不静默不留白屏） | R | ✅ | detail.js:230-247：先换远端 URL 重试一次 → 相同 URL 或仍败 → 回退包内 mp4 → 包内也败才 `videoErr:true`；detail.wxml:39-41 渲染「视频加载失败，请稍后重试；需要现场指导可到护士站咨询」 | 死循环防护：已是本地源不再换 src（detail.js:242-244） |
| 相关科普跳转 redirectTo 不堆页面栈 | F | ✅ | detail.js:250-252 `wx.redirectTo`；相关推荐=同分类前 4 条（detail.js:58-66） | |
| 封面/hero 处理 | R | ✅ | detail.wxml:65-67 cover 缺省整块不渲染（不留空框）；detail.js:209/246 poster 远端优先本地兜底 | |
| 不存在内容兜底 | R | ✅ | detail.js:51-55 byId 无 → missing 态；detail.wxml:26「内容不存在或已下架」 | |
| navigationStyle=custom 自绘导航 | U | ✅ | detail.json:2；detail.wxml:5-24 padding-top=navH 让位；分享 open-type=share | |

### 主包引用红线 + 分包配置

| 检查点 | 维度 | 实测 | 证据 | 说明 |
| --- | --- | --- | --- | --- |
| 主包页面禁止引用分包静态资源（KNOWN_ISSUES #25） | S/R | ✅ | 全量 Grep `/packageContent/(assets\|videos)`、`/packageNav/assets`：主包 pages/ 仅命中 navigateTo 跳转与注释；home.js:133-138 kbVideos 只取 id/title/durationSec/主包图标（注释 :131-132 明示红线） | 主包对分包的引用全部是页面路由跳转（合法，触发分包下载） |
| knowledge-kb.js 内含分包资源路径，主包不渲染其 cover/video | S | ✅ | require 方仅 3 处：knowledge.js:8 / detail.js:15（分包内）/ home.js:8（主包）；home 仅用 VIDEOS 元文字 + ARTICLES 贴士，不渲染 cover/src | |
| app.json subPackages 注册 | F | ✅ | app.json:35-51：packageNav(nav) + packageContent(knowledge/detail) | 主包 31 页 |
| preloadRule 预下载分包 | F/R | ✅ | app.json:52-60：pages/home/home → network all → 预下载 **packageContent + packageNav**（比任务书多预下载 packageNav，更优） | |

---

## 2. 用例清单（PKG-xxx）

| ID | 维度 | 前置 | 步骤/审查路径 | 预期 | 实测 | 证据 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PKG-01 | F | 打开 nav 页 | 查 ORIGIN 与所有 path 首点 | 起点=医院大门(720,770)，14 目的地路径首点同起点 | ✅ | indoor-map.js:20-26/30-565 | P1 |
| PKG-02 | F | 深链 nav?dept=神经内科 | _resolveDept | 先到电梯厅 1F 段 + 「乘电梯上 3 楼」换层条 | ✅（代码+单测 test-triage 322 项含带路可达） | nav.js:381-390；test-triage.js TRIAGE_OK | P1 |
| PKG-03 | F | 深链 nav?dept=呼吸内科 | _resolveDept | 直达 1F 呼吸内科房间 | ✅ | nav.js:421-430；triage-kb.js:117 | P1 |
| PKG-04 | S/F | 深链 nav?dept=急诊科 | _applyDeepLink | 绿色通道提示，不进排队动线 | ✅ | nav.js:408-411 | P1 |
| PKG-05 | F | 深链 nav?dept=不存在科室 | _matchDept 三级 | DEPT_MAP→规则→名称包含；全不中给「未找到」toast | ✅ | nav.js:416-432/413 | P1 |
| PKG-06 | U | nav 页宽屏排版 | preview-nav-page --measure | 无压图/重叠、单列居中 | ✅ RESULT: NAV_PREVIEW_OK | preview-nav-page.js 输出（本报告 §TCH-18） | P1 |
| PKG-07 | R | knowledge 搜索/分类无命中 | _apply | 空态可见，不伪造内容 | ✅ | knowledge.wxml:67-72 | P2 |
| PKG-08 | F | knowledge 类型筛选（全部/图文/视频） | 页面 UI | 三档类型 tab 可切 | ❌ UI 缺失，仅 KB.filterFeed 未接入 | knowledge.js:32-43 vs knowledge-kb.js:282-288 | P1 |
| PKG-09 | R | detail 视频播放失败 | binderror | 重试一次→包内 mp4→可见中文失败条，不留白屏 | ✅ | detail.js:230-247；detail.wxml:39-41 | P1 |
| PKG-10 | F | detail 点相关推荐 | goRelated | redirectTo 替换页面栈，不累积 | ✅ | detail.js:250-252 | P2 |
| PKG-11 | U | nav meta 行楼层显示 | nvr-head | 显示当前楼层/换层信息 | ❌ `activeFloorText` 字段未定义恒空 | nav.wxml:106 vs nav.js（仅 activeFloor） | P2 |
| PKG-12 | U | 门诊类目的地「先取号」提示 | 目的地行/选中态 | 门诊目的地附先取号提示 | ⚠️ needRegister 算了未渲染 | nav.js:148；WXML 无引用 | P2 |
| PKG-13 | S | 主包引用分包资源 | Grep + home.js | 主包零静态引用分包图片/视频 | ✅ | 见 §主包红线表 | P1 |

---

## 3. Bug 条目

### [P2] nav 页路线指引卡楼层文案恒空（PKG-11）
- 位置：miniprogram/packageNav/pages/nav/nav.wxml:106
- 根因：WXML 引用 `{{activeFloorText}}`，但 nav.js 的 data（:121-134）与全部 setData 只定义 `activeFloor`（:353/:403），从未产生 `activeFloorText`。
- 复现：任意选中目的地 → 路线指引卡标题行右侧 meta 渲染为「 · 约 X 米」，楼层段恒空、分隔符悬空。
- 影响：适老化信息卡元信息缺一行；不阻断功能。
- 建议：WXML 改 `{{activeFloor}}`，或在 _pick/_applyDeepLink 里补 `activeFloorText`。
- 证据：nav.wxml:106 `<view ... nvr-meta>{{activeFloorText}} · 约 {{active.distanceM}} 米</view>`；Grep `activeFloorText` 全仓仅命中 wxml 一处。

### [P1] knowledge 列表缺「类型筛选」维度（PKG-08）
- 位置：miniprogram/packageContent/pages/knowledge/knowledge.js:32-43、knowledge.wxml:33-40
- 根因：KB 层已提供 `filterFeed(category, type)`（knowledge-kb.js:282-288，type=all/article/video），但页面只做了 分类+关键词 二维过滤，WXML 未渲染「全部/图文/提示视频」类型 tab。
- 复现：进列表页 → 只有分类横滑 chips，无法单独只看 3 个提示视频。
- 影响：与 AI_CONTEXT CORE_FLOWS「cat(全部/5 类) × type(all/article/video)」及导览承诺不符；主包首页横滑卡只放视频，用户进列表想回看视频要自行识别角标。
- 建议：在分类 chips 下补一排「全部/图文/视频」类型 tab，_apply 改为 `KB.filterFeed(cat, type)`。
- 证据：knowledge.js:36-41 过滤体仅 `category` + `keyword`；WXML 无 type 状态/事件。

### [P2] needRegister「先取号提示」算了未渲染（PKG-12）
- 位置：miniprogram/packageNav/pages/nav/nav.js:148
- 根因：`needRegister: d.category==='门诊' && d.id!=='reg'` 写入每条数据，但 WXML（目的地行 :200-203、信息卡）无任何 `needRegister` 条件块。
- 影响：CORE_FLOWS「门诊类目的地附先取号提示」在 UI 不可见。
- 建议：目的地行 sub 或选中后在步骤列表前加一行「请先到挂号/缴费窗口取号」。
- 证据：Grep `needRegister` 仅 nav.js:148 一处。

### [P2] 文档/口径漂移登记（非代码缺陷）
- FEED 实测 10 条（3 视频+7 图文），AI_CONTEXT 记 9 条（+report-read 为后加）；
- knowledge 横屏平板实做 3 列（knowledge.wxss:364），任务书写两列；
- nav 页 1180px/900px 自声明与 padding-bottom:62px 为 2026-10-21 改版前旧口径，现行 375px 单列且由 test-nav-page.js 80 项守死；
- 建议：测试主文档 §5.5 与 AI_CONTEXT ROUTES 按现码回填，避免后续 QA 按旧口径误报。

---

## 4. 与任务书口径的两条重要澄清

### B1「nav.wxss 自声明 1180px」——已被 2026-10-21 改版取代，现行为正确
任务书要求核对 nav.wxss 不分朝向 900px 档自声明 `max-width:1180px`。实测 nav.wxss 全文（1077 行）**没有 1180px、没有 900px 媒体查询**，唯一宽度约束是 ≥600px 档 `.nvpage{max-width:375px;margin:0 auto}`（nav.wxss:706-710）。离线守卫 test-nav-page.js 80/80 通过，其中明确断言「宽屏单列 375px 居中」「不再挂 page-shell」。结论：**代码与其守卫脚本一致，任务书该条引用的是改版前旧口径**（AI_CONTEXT NEXT_STEP ⑧：「2026-10-21 改版后不再用满 1180px，旧的满宽验收作废；平板单列 375px 居中」）。按现码，本项判 ✅ 符合现状，不判缺陷。

### B2「地图卡 padding-bottom:62px 防工具栏压图」——新版式已无该场景
旧版满宽布局的修法（KNOWN_ISSUES #19）。现行三卡版式下，缩放按钮组与楼层胶囊均绝对定位在固定高度的 `.nvm-stage` 内部（nav.wxss:124-135/244-250，舞台高 656rpx→328px），不再压卡 padding；preview-nav-page --measure 六项「工具栏/胶囊压图」断言全部 false。按现码判 ✅，不再要求 62px。
