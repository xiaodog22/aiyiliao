# 阶段 02 结构设计定稿（检查报告体系 V27 / V9010）

> 2026-11-05 · 依据阶段 01 审计 `backend/deploy/DB_AUDIT_20261105.md` + 真实代码 / 契约 / EXPLAIN。
> 本文件只定稿设计；**未改业务库**。所有「待确认」项按任务书的默认约束处理，处置口径见 §4。

## 1. 只读预演结果（本轮实测）

| 预演项 | SQL / 方法 | 结果 |
|---|---|---|
| 前置唯一索引是否存在 | `information_schema.STATISTICS` 查 `uq_health_records_id_user` / `uq_family_members_user_id` | **均不存在（0）** → V27 必须先补 |
| 孤儿家属档案 | `health_records r LEFT JOIN family_members f ON r.family_member_id=f.id AND r.user_id=f.user_id WHERE ... f.id IS NULL` | **0**（7 条档案 `family_member_id` 全 NULL） |
| 附件跨用户归属 | `attachments a JOIN health_records r ON a.record_id=r.id WHERE a.user_id<>r.user_id` | **0**（附件表 0 行） |
| 真实列表 SQL（本人）EXPLAIN | `HealthRecordRepository.list`：`WHERE user_id=? AND family_member_id IS NULL ORDER BY recorded_at DESC, id DESC` | `ref` 走 `uq_health_records_idem(user_id 前缀)`，**`Using filesort`** |
| 真实列表 SQL（家属）EXPLAIN | `WHERE user_id=? AND family_member_id=? ORDER BY ...` | 同上，**`Using filesort`** |
| 任务书假设 SQL EXPLAIN | `WHERE user_id=? AND category='EXAM' ORDER BY recorded_at DESC` | 同样走 `uq_health_records_idem` + filesort；**该 SQL 不在代码中** |

**结论**：加 `idx_hr_user_family_time (user_id, family_member_id, recorded_at, id)` 消除真实查询的 filesort；任务书建议的 `(user_id, category, recorded_at)` **不采用**（真实列表无 category 条件）。迁移后重跑 EXPLAIN 验证。

## 2. 新表定稿（去重后）

| 表 | 新增/扩展 | 关键字段与取舍 | 不重复的理由 |
|---|---|---|---|
| `medical_institutions` | 新增 | `id, institution_code, institution_name, institution_type, hospital_level, address, telephone, status, is_demo, created_at, updated_at` | 独立机构主数据；**不改** `departments.hospital_name` / `health_records.hospital`，与 `departments.hospital_id` 双轨，映射待确认 |
| `health_report_details` | 新增 | 与 `health_records` 1:1：`record_id, user_id, report_no, report_type, institution_id, department_id, department_name_snapshot, patient_*_snapshot, outpatient_no, inpatient_no, clinical_diagnosis, applicant_doctor, specimen_*, collection_at/received_at/tested_at/reported_at, operator_name, reviewer_name, inspection_method, instrument_model, findings_text, impression_text, conclusion_text, recommendation_text, data_origin, external_report_id, is_demo, version, created_at, updated_at` | **不复制** `category/title/summary/recorded_at/hospital/report_status/doctor_name/abnormal`（留在主表）；不设冗余 `report_status`，列表按 JOIN 主表筛选 |
| `health_report_sections` | 新增 | `id, report_detail_id, user_id, section_code, section_name, sort_order, created_at` | 分组只承载展示顺序，不承载结果 |
| `health_report_items` | 新增 | `id, report_detail_id, section_id, user_id, item_code, item_name, result_value DECIMAL(18,4), result_text VARCHAR(1000), unit, reference_low/high DECIMAL(18,4), reference_text, abnormal_flag, inspection_method, remark, sort_order, created_at` | 数值/定性/描述三型并存；参考区间为**报告快照**，不建全局标准表 |
| `health_record_attachments` | 扩展列 | `attachment_type, display_name, sort_order, preview_object_key` | 二进制仍不入库；沿用 `AttachmentStorage.exists()` + size/MIME/SHA-256 校验 |

**新增枚举**（仓库现无权威定义，需在阶段 05 补进 OpenAPI）：
`abnormal_flag` = `NORMAL/HIGH/LOW/POSITIVE/NEGATIVE/ABNORMAL/NOT_APPLICABLE`；
`report_type` = `LAB/IMAGING/CHECKUP/PATHOLOGY/ECG`；`data_origin` = `DEMO/EXTERNAL/MANUAL`。
以上为**本轮新定义**，未冒充既有契约。

## 3. 完整性约束与索引

| 对象 | 变更 | 前置条件 / 依据 |
|---|---|---|
| `health_records` | +`UNIQUE uq_health_records_id_user (id, user_id)` | 复合外键被引用键（当前缺失） |
| `health_records` | +`KEY idx_hr_user_family_time (user_id, family_member_id, recorded_at, id)` | EXPLAIN filesort 实测 |
| `health_records` | +`KEY idx_hr_user_status_time (user_id, report_status, recorded_at)` | 报告列表按状态筛选（任务书 §3.4） |
| `health_records` | +复合 FK `(user_id, family_member_id) → family_members(user_id, id)` | 需 `family_members` 先有 `uq_family_members_user_id (user_id, id)`；NULL 值由 MySQL MATCH SIMPLE 跳过检查，历史 7 条不受影响 |
| `family_members` | +`UNIQUE uq_family_members_user_id (user_id, id)` | 同上 |
| `health_record_attachments` | +复合 FK `(record_id, user_id) → health_records(id, user_id) ON DELETE CASCADE` | 保留原两个单列 FK；表当前 0 行，无冲突 |
| `health_report_details` | `UNIQUE(record_id)` + `UNIQUE(id, user_id)` + 复合 FK `(record_id,user_id) → health_records(id,user_id)` + `KEY(user_id, reported_at)` | 1:1 + 归属强约束 |
| `health_report_sections` | FK `report_detail_id → details(id)` + `UNIQUE(id,user_id)` + `KEY(report_detail_id, sort_order)` | 供 items 复合 FK 引用 |
| `health_report_items` | 复合 FK `(section_id,user_id) → sections(id,user_id)` + 单列 FK `report_detail_id → details(id)` + `KEY(section_id, sort_order)` + `KEY(report_detail_id, sort_order)` + `KEY(user_id, abnormal_flag)` | 避免双重复合级联；`section_id ↔ report_detail_id` 一致性由 Service 层保证（跨表 CHECK 不可表达） |

## 4. 阶段 01 的 8 项口径 —— 本轮按任务书默认处置（不擅自扩大改动）

| # | 口径 | 本轮处置 |
|---|---|---|
| 1 | 新增账号如何登录 | **阶段 05 已调整**：原定稿为「不改 provider、验收记未通过」，但任务书把「新用户能按实际开发登录方式访问」列为验收项，且页面验收必须能读到新报告。改为 dev-only `app.auth.dev-login.identity-map`（手机号→openid 显式登记）：仍受 `X-Dev-Login-Key` 与白名单双重约束，未命中映射时原 `dev-user-1/2` 行为**零改动**，生产/itest 档无此键（空映射）。openid 实际前缀为 `dev-v9010-*`。HTTP 实测 3 个新账号均 200 且落到正确 userId，未登记手机号仍 401 |
| 2 | `medical_institutions` 与 `departments.hospital_id` | 双轨并存，只插独立演示机构（名称含「模拟」），不批量替换任何现有医院名；映射关系 **待补充** |
| 3 | 平台名 / 实体机构名 | 数据侧保持原样（延续 11-05 上午治理），报告用机构目录快照 |
| 4 | 状态可见性 | 本轮只落数据；**后端门禁属阶段 05**，未实现前不得写「已通过」 |
| 5 | 冗余唯一索引 | 按任务书「优先采用复合唯一键和复合外键」执行，见 §3 |
| 6 | 演示附件真实文件 | 本轮**不生成附件行**（附件表保持 0 行），避免假文件/坏链；影像附件列为后续待办 |
| 7 | 历史 7 条非报告类 `READY` | **不改历史**；新增非报告类档案 `report_status=NULL` |
| 8 | V27 进 prod 建空表 | 按任务书「结构变更使用新增 V27」执行；prod 只建空表、不含演示种子（V9010 仅 dev），记录为已知影响 |

## 5. 迁移顺序与回滚

1. `V27`（`db/migration`，prod + dev 均加载）：前置唯一索引 → 组合索引 → 复合 FK → 附件扩展列 → 4 张新表。
2. `V9010`（`db/dev`，仅 dev）：演示机构 / 3 用户 / 档案 / 7 报告 / 分组 / 项目，全部 `ON DUPLICATE KEY UPDATE` no-op 幂等。
3. **DDL 隐式提交**：V27 单文件多语句失败会留下部分结构；回滚用 `.trash/db-backup-20261105/pre-report-audit-20261105.sql` 恢复点，或后续修复迁移，禁止事务式回滚。
4. 演练：在独立临时库 `wechar_drill_20261105` 从全库备份结构+数据复制后依次应用 V27 / V9010，验证外键、幂等、数据分布；**不触碰 `wechar_dev` 之外的库**。
5. 正式应用由 Flyway 在 business-service（dev profile）启动时完成；不手工写 `flyway_schema_history`，不动 checksum。

## 6. 本阶段产物

- 设计定稿：本文件。
- `V27__health_report_structure.sql`（阶段 03）。
- `V9010__health_report_demo_seed.sql` + 生成器 `tools/gen-report-demo-seed.py`（阶段 04）。
