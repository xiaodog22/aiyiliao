# 文档索引

本仓库文档按「设计 → 架构 → 实现 → 测试 → 交付」分层，避免重复阅读。
每份文档只在其所属层生效，冲突时以代码与实测为准。

---

## 1. 入口级（先读这三份）

| 文档 | 作用 | 体积 |
|---|---|---|
| [`README.md`](../README.md) | 项目定位、界面、功能、架构、目录、快速开始、已知限制 | 中 |
| [`AGENTS.md`](../AGENTS.md) | AI/新人协作入口：目录地图 + 省 Token 操作规定 | 小 |
| [`WORKBODY_AGENT_RULES.md`](../WORKBODY_AGENT_RULES.md) | 完整工程规范（任务分级 L1~L3、红线、验证门禁） | 16 KB |

> `DEV_LOG.md`、`AI_CONTEXT.md` 为本地开发日志与上下文索引，含内部联调信息，**不随仓库发布**。

**产品规格**（2026-11-10，草稿 / 设想阶段，三份相互关联）：

| 文档 | 阶段 | 状态 |
| --- | --- | --- |
| [`PRD-提交完成态操作入口.md`](产品规格/PRD-提交完成态操作入口.md) | 当前功能规格 | 前端能力已实现，业务接线未定 |
| [`FeatureBrief-项目评定流程.md`](产品规格/FeatureBrief-项目评定流程.md) | 未来功能设想 | 未立项 |
| [`决策点清单-提交完成态与评定.md`](产品规格/决策点清单-提交完成态与评定.md) | 评审用决策清单 | 待评审 · v0.3（5 组决策 / 2 组真前置；含 §1.1 全局边界、§7 D1 = C 收尾、§9 技术评审记录） |

三份文档中所有未由项目事实确认的信息统一标注「待确认」，不含推测的业务数据；决策点清单只摆选项与建议默认，不代业务方下结论。
决策清单把 15 条 B 项收敛为 5 组，**评审会只需拍 D1「有没有提交对象」与 D5「做不做」两件事**；两份规格的待确认表已加「决策组 / 顺序」列，避免 12 个问题并排无优先级。

---

## 2. 设计与体验规范

| 文档 | 内容 |
|---|---|
| [`1.md`](历史设计规范/1.md) | UI / UX / 无障碍 / 交互 / 技术开发总规范 |
| [`2.md`](历史设计规范/2.md) | V1.2 逐页面 UI 设计规格 |
| [`3.md`](历史设计规范/3.md) | V1.3 视觉设计稿级规范 |
| [`4.md`](历史设计规范/4.md) | V1.3 同版副本（与 `3.md` 内容重复，保留供比对） |
| [`5.md`](历史设计规范/5.md) | V1.4 组件级规范的讨论记录 |
| [`LAYOUT_PLAN.md`](历史设计规范/LAYOUT_PLAN.md) | 布局与断点方案 |
| [`医疗_AI_智能健康小程序_UIUX_原型设计与界面说明书_V4.md`](../design-output/医疗_AI_智能健康小程序_UIUX_原型设计与界面说明书_V4.md) | 界面说明书（最新版，由 `tools/check-v4-docs.js` 校验） |
| [`页面复刻文档_DeepSeek版.md`](历史设计规范/页面复刻/页面复刻文档_DeepSeek版.md) | 设计稿 → 原生小程序的复刻方法 |
| [`页面复刻遗留问题清单.md`](历史设计规范/页面复刻/页面复刻遗留问题清单.md) | 复刻过程中未闭环项 |

---

## 3. 架构与契约

| 文档 | 内容 |
|---|---|
| [`docs/v4/03-Spring-Boot业务后端开发指南.md`](v4/03-Spring-Boot业务后端开发指南.md) | 业务后端职责边界与实现约定 |
| [`docs/v4/04-FastAPI-AI后端开发指南.md`](v4/04-FastAPI-AI后端开发指南.md) | AI 服务接口面与降级策略 |
| [`docs/v4/02-页面数据与交互契约.md`](v4/02-页面数据与交互契约.md) | 页面 ↔ 接口字段映射 |
| [`backend/contracts/business-openapi.yaml`](../backend/contracts/business-openapi.yaml) | 业务后端契约（唯一事实源） |
| [`backend/contracts/ai-openapi.yaml`](../backend/contracts/ai-openapi.yaml) | AI 服务契约 |
| [`项目结构与代码规范_DeepSeek版.md`](交付文档/项目结构与代码规范_DeepSeek版.md) | 目录职责与命名规则 |

---

## 4. 数据库

| 文档 | 内容 |
|---|---|
| [`数据库表结构总览_20261022.md`](交付文档/数据库表结构总览_20261022.md) | 表清单与用途速查 |
| [`backend/deploy/DATA_GOVERNANCE.md`](../backend/deploy/DATA_GOVERNANCE.md) | 数据治理口径：三档处置、预演、备份、回滚 |
| [`backend/deploy/DB_AUDIT_20261105.md`](../backend/deploy/DB_AUDIT_20261105.md) | 2026-11-05 结构审计与风险清单 |
| [`backend/deploy/DB_SCHEMA_DESIGN_20261105.md`](../backend/deploy/DB_SCHEMA_DESIGN_20261105.md) | 检查报告体系结构定稿 |
| [`backend/deploy/REPORT_DELIVERY_20261105.md`](../backend/deploy/REPORT_DELIVERY_20261105.md) | 检查报告体系交付报告（15 项 + 未解决问题） |
| [`docs/v4/07-隐私数据流与保留策略.md`](v4/07-隐私数据流与保留策略.md) | 隐私字段流转与保留口径 |

> 迁移脚本本身即结构事实源：`backend/business-service/src/main/resources/db/migration/`，
> 开发种子在 `db/dev/`。文档与迁移冲突时以迁移为准。

---

## 5. 测试与验收

| 文档 | 内容 |
|---|---|
| [`docs/v4/06-测试矩阵与发布检查表.md`](v4/06-测试矩阵与发布检查表.md) | 测试矩阵与发布门 |
| [`docs/v4/08C-M0集成门验收单.md`](v4/08C-M0集成门验收单.md) / [`08D-M1`](v4/08D-M1集成门验收单.md) | 集成门验收记录 |
| [`后端功能测试设计与功能文档.md`](交付文档/后端功能测试设计与功能文档.md) | 后端用例设计 |
| [`docs/前端测试报告_20261020.md`](前端测试报告_20261020.md) / [`docs/后端测试报告_20261020.md`](后端测试报告_20261020.md) | 阶段性测试报告 |
| [`docs/发版与真机复测清单_20261029.md`](发版与真机复测清单_20261029.md) | 真机复测项 |

自动化门禁（真实来源，优先于任何文档）：

```bash
node tools/check-project.js       # 六项静态门禁
node tools/test-fe.js             # 前端单测
backend/business-service/mvnw -o test
backend/edge-gateway/.venv/Scripts/python.exe -m pytest backend/edge-gateway/tests -q
```

---

## 6. 部署与运维

| 文档 | 内容 |
|---|---|
| [`backend/deploy/README.md`](../backend/deploy/README.md) | 本地编排脚本、环境变量、启动顺序 |
| [`docs/v4/05-部署运维与低配优化.md`](v4/05-部署运维与低配优化.md) | 低配部署与性能取舍 |
| [`backend/deploy/CLOUD.md`](../backend/deploy/CLOUD.md) | 云托管兼容性评估与边界（**已暂停**，留档） |

---

## 7. 目录约定

| 目录 | 内容 | 是否入库 |
|---|---|---|
| `docs/v4/` | 契约与实施总纲（01~08D） | ✅ |
| `docs/交付文档/` | 对外交付：后端功能测试设计、数据库表结构总览、代码规范 | ✅ |
| `docs/产品规格/` | 当前功能 PRD + 未来功能 Feature Brief + 评审用决策点清单（三份相互关联，未明确项标「待确认」） | ✅ |
| `docs/手册/` | 操作手册 DOCX（含待转 PDF 稿） | ❌ 含真实身份信息，忽略 |
| `docs/评审与复盘/` | 优化总结、待优化清单、测试用例调整建议 | ❌ 本地复盘，忽略 |
| `docs/历史设计规范/` | 1.md~5.md、LAYOUT_PLAN.md、页面复刻方法（只读档案） | ⚠️ 仅 LAYOUT_PLAN.md 入库 |
| `docs/screenshots/` | 界面截图（用于 README 与验收） | ✅ |
| `docs/_backup/`、`docs/shots/`、`docs/patches/` | 中间备份、被取代版本、批量截图、联调补丁 | ❌ 忽略 |
| `docs/preview-qr*.png`、`preview-info*.json` | 小程序预览二维码与参数（含 appid） | ❌ 忽略 |
| `artifacts/`、`archive/`、`.trash/` | 数据采集证据、已退出活动链的本地归档、数据库备份 | ❌ 忽略 |

根目录只保留仓库身份与入口文件（`README.md` / `AGENTS.md` / `AI_CONTEXT.md` / `DEV_LOG.md` /
`WORKBODY_AGENT_RULES.md` / `CONTRIBUTING.md` / `SECURITY.md` / `LICENSE` 与 `.git*`），
其余文档按上表进入 `docs/`，退出活动链的材料进入 `archive/`。

完整的忽略规则见 [`.gitignore`](../.gitignore)，每条都带理由注释。
