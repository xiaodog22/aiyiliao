# 改进计划：页面与 UI 展示效果（V1.20）

- 日期：2026-11-13 · 状态：计划（未实施）
- 输入：AI_CONTEXT V1.19 / KNOWN_ISSUES / 2026-11-13 全量回归实态 / 离线排版终判（NAV_PREVIEW_OK、PAD_LAYOUT_OK 16/16）
- 每条口径：**现状 → 方案 → 涉及文件 → 验证门**。实施时按批次进 DEV_LOG。

---

## 1. 宽屏「图标类工具类」未覆盖完（KNOWN_ISSUES #26/#28 遗留）

- **现状**：app.wxss ≥600px 档已补 `.ic-* / .icon-badge / .section-header::before`，但登记在案的 `.img-arrow / .state-badge / .state-ic / .state-btn / .error-inline-ic / .error-inline-btn / .grad-hero::after` 仍用 rpx → 1696px 视口继续等比放大（rpx≈1.6px 倍率），状态卡与错误卡在平板宽屏视觉失衡。
- **方案**：同既有口径补 px 覆盖（图标/徽章类转 px，布局尺寸保持等比——见 #26 与 #21 的边界，别混）。逐类给出建议值：`.state-ic` 22~28px、`.state-badge` 44px、`.error-inline-ic` 22px、`.img-arrow` 16px、按钮最小触控 48px。
- **涉及**：`miniprogram/app.wxss`（仅 ≥600px 断点块，不动令牌块）。
- **验证**：`node tools/preview-pad-pages.js --measure`（现有 16 组契约全过）+ 真机清单 §4-⑨；改完在 preview-pad-pages 断言中固化新增尺寸契约（防回归）。

## 2. 页面复刻第 10~16 页推进（AI_CONTEXT NEXT_STEP 遗留）

- **现状**：第 1~9 页已按设计稿复刻（1391px=750rpx 实测口径）；第 10 页起未重做：
  10 健康科普列表（packageContent/knowledge）→ 11 科普详情（detail）→ 12 在线问诊（04）→ 13 健康档案（05）→ 14 医生端挂号管理（E-13）→ 15 适老化首页（08）。
- **方案**（顺序执行，单页一个批次）：
  1. 每页开工前先跑一次该页相关离线测试作为基线；
  2. 沿用共同口径：只用 app.wxss 令牌 + utils/icons.js（禁 emoji）、数据走 services/、≥600px px 断点、设计稿与复刻文档冲突以设计稿为准并写页面 wxml 顶部注释；
  3. 科普两页注意 rpx 大屏双档重写规则（KNOWN_ISSUES #18/#21）。
- **涉及**：`miniprogram/packageContent/pages/knowledge/*`、`pages/detail/*`、问诊/健康档案/医生端挂号管理/适老化首页对应页面四件套。
- **验证**：每页复刻后 `test-fe-all.js` + 若涉及 5 个核心页跑 `preview-pad-pages.js --measure`；科普页补 `test-knowledge-filter.js` / `test-detail-video.js`。

## 3. 首页 banner 出血插画（V1.19 新增的视觉契约，需真机闭环）

- **现状**：banner 已按容器比值 1.732 出图（660×381，楼占 69%）并接 `--h-banner-h` 同变量高度、右侧 padding 归零；但整套只在离线预览验证（banner 高比 ≥0.95 / 贴右下角两条判定过），**真机（含最大字号档 xlarge 52/42/38/30）未验**。
- **方案**：真机验证 xlarge 档下标题不被插画压住、楼底不被切；若超大档溢出，调 `--hero-title-boost` 与占位 max-width（按 #27 教训：占位按最大字号档取值）。
- **涉及**：`pages/home/home.wxml/wxss`（必要时仅调占位变量）。
- **验证**：`preview-pad-pages.js --measure` 既有五条首页契约 + 真机清单 §4-⑩。

## 4. 适老化专项补强

- **现状**：字号三档 + 高对比已全站铺开（test-a11y-touch 6 条过）；遗留两个点：
  1. `voice.js` CATALOG 首个音色 desc 是按体例补齐的占位文案（「设计未展示该音色描述」，登记在遗留清单第 23 页）——待设计确认后替换；
  2. 错误/空态触控目标已有 `.state` 实心按钮口径，但宽屏下 `.state-btn` 尺寸仍 rpx（并入本文件 §1 一批处理）。
- **验证**：`test-a11y-touch.js` + 对比度量化断言（profile-deep-audit 已内嵌 WCAG 检查，placeholder 1.91:1 属占位元素豁免口径，不改动）。

## 5. 排版离线预览工具债

- **现状**：`preview-pad-pages.js` 的**静态骨架**未同步第 8（医生工作台）/9（导航）页新版式（AI_CONTEXT 明确登记的工具债，页面本身无问题）。
- **方案**：同步骨架后再跑一遍 16 组终判，保证后续两页样式回归可被工具守住。
- **涉及**：`tools/preview-pad-pages.js`（仅工具，页面零改动）。
- **验证**：RESULT: PAD_LAYOUT_OK 保持。

## 6. UI 真机验证 9+2 项（流程性，非代码）

- 见《测试计划_下一阶段.md》§4 真机清单（①~⑨ + banner/音色两条新增）。V1.20 里程碑内完成一轮全量勾选并归档截图，作为 UI 批次的验收证据。

---

## 优先级与批次建议

| 批次 | 内容 | 依赖 |
|---|---|---|
| UI-1（先做） | §1 宽屏图标类 px 覆盖 + §5 预览工具债 | 无，改动小、守卫现成 |
| UI-2 | §2 页面复刻第 10~12 页（科普列表/详情/在线问诊） | UI-1 完成后 |
| UI-3 | §2 第 13~15 页 + §3 banner 真机闭环 + §4 适老化收尾 | UI-2；真机在手 |
