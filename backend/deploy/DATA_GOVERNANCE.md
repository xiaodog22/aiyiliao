# 数据治理清单（2026-11-05）

> 原则：**有据即改、无据则备、先隔离后清理**。本清单是决策材料，不代表业务已拍板。
> 全库体检与已执行的 389 行修正见 `DEV_LOG.md` 2026-11-05 节；可回滚备份
> `.trash/db-backup-20261105/affected-tables.sql`（11 张表）。
> 文中保存年限均引自本轮讨论口径（过程记录 ≥3 年 / 病历 ≥15 年 / 审计 ≥6 个月），**以法务最终确认版本为准**。

## 一、三档推进表

| 档 | 项 | 状态 | 处置 |
|---|---|---|---|
| 第一档 有据即改 | 6 无效 video_key | **已执行** | 清空字段，保留文章行，不删主记录 |
| 第一档 有据即改 | 1 家庭关系重复 | **已执行（批次 A/B）** | 5 条重复已删、默认家属已补，见 §六 |
| 第二档 按业务口径落地 | 2 预约展示过滤 / queue_number 回填 | **已执行（批次 C/D）** | 过滤走 Repository、数据不删；历史排队号按 slot 分组回填 |
| 第二档 仍待确认 | 3 医院主体 / 7 过期邀请 | **保持原样** | 决策选项 + 最小代码方案已备，见 §三 |
| 第三档 外部口径 | 4 档案医生名 / 5 稀疏主数据 / 8a~8d | **明确不做** | 所需信息清单 + 数据就绪度说明 |

## 二、第一档：已执行

### 2.1 无效媒体引用清空（第 6 项）

- `health_articles` 的 `dev-video-test`、`wash-hands` 两行 `video_key = 'dddddddddddddddddddddddddddddddd.mp4'` → `NULL`，**文章行保留**（`status=PUBLISHED` 不变）。
- 依据：该值不是 `AttachmentStorage` 体系下的合法对象键，指向文件不存在；旧接口一旦被调用必然返回注定 404 的 `videoUrl`。前端 `packageContent/pages/detail` 在拿不到远端视频时已有包内 mp4 兜底，不会白屏。`AttachmentVideoTest` 中的同名字符串是测试自造输入，与库内数据无关。
- 未解决、也不在数据侧解决：真实视频 objectKey 由哪套上传流程产生。是否下线整个 `health_articles` 旧接口数据，取决于旧接口是否仍被前端调用（当前 `miniprogram/config/api.js:81` 定义了详情常量，主内容源是 `contents` 13 条 APPROVED）。
- 回滚（该表未纳入上轮备份，原值已完整记录）：
  ```sql
  UPDATE health_articles SET video_key='dddddddddddddddddddddddddddddddd.mp4'
  WHERE id IN ('dev-video-test','wash-hands');
  ```

### 2.2 重复家庭关系隔离清单（第 1 项：只标记，不删除）

表结构无隔离标记字段，按约定用清单替代；**不新增字段、不删行**。

- 依据：`SPOUSE` 4 条全为「老王」、`PARENT` 3 条全为「老李」，均为 `smoke-fm*` 幂等键；同一自然人不可能同时是同一用户的 4 个配偶。每组保留 `created_at` 最早一条。
- **保留（3 条）**

| id | relation | name | created_at | 备注 |
|---|---|---|---|---|
| `fm-4ae21abf-61b9-4e15-ac75-17300fda8a7c` | MOTHER | 母亲 | 2026-10-14 20:27:34 | `m1c-fm-0001`，正常演示数据 |
| `fm-bdf47126-93cf-423a-b9a0-0d796c26a13f` | PARENT | 老李 | 2026-10-14 19:42:47 | 组内最早 |
| `fm-2c5ed25e-629b-4dfe-89e7-02db373c0a6e` | SPOUSE | 老王 | 2026-10-14 19:42:47 | 组内最早 |

- **pending_cleanup 候选（5 条）**

| id | relation | name | created_at |
|---|---|---|---|
| `fm-eefa34d0-662d-42d6-a664-251dc63f5366` | PARENT | 老李 | 2026-10-14 19:51:23 |
| `fm-035a8869-8305-4f2a-a0d8-b01596f9e93d` | PARENT | 老李 | 2026-10-14 20:01:46 |
| `fm-cb1ce8d1-1dfb-44c1-ba6b-8939a9c22f15` | SPOUSE | 老王 | 2026-10-14 19:44:31 |
| `fm-6fe9271f-3d21-452e-90ca-6ee19b8c747b` | SPOUSE | 老王 | 2026-10-14 20:01:46 |
| `fm-dfeccea0-f208-4e38-be2a-a2d4ee23cb6c` | SPOUSE | 老王 | 2026-10-14 20:04:36 |

- 待确认口径：「同一关系是否允许多个成员」。若确认**允许多个父母但不应重复同一人**，按 `(user_id, relation, display_name)` 去重即可，上表正是该规则的结果。
- 建议 SQL（**已于 2026-11-05 批次 A 执行**，见 §六；5 行无外键引用，执行时额外带
  `idempotency_key LIKE 'smoke-fm%'` 守卫，确保只删冒烟残留）：
  ```sql
  -- DELETE FROM family_members WHERE id IN (
  --   'fm-eefa34d0-662d-42d6-a664-251dc63f5366',
  --   'fm-035a8869-8305-4f2a-a0d8-b01596f9e93d',
  --   'fm-cb1ce8d1-1dfb-44c1-ba6b-8939a9c22f15',
  --   'fm-6fe9271f-3d21-452e-90ca-6ee19b8c747b',
  --   'fm-dfeccea0-f208-4e38-be2a-a2d4ee23cb6c');
  ```
- 回滚：上轮备份 `affected-tables.sql` 含 `family_members` 全表。

## 三、第二档：决策选项清单（材料已备，未执行）

### 3.1 历史预约（第 2 项）

- **结论：不删除主表。** 预约是诊疗过程链的一环，且 `appointment_status_events` 有外键；删除会破坏历史可追溯性，风险高于收益。压测数据的危害是污染展示/统计，不是占空间。
- 压测识别依据（上一轮真实化后 `patient_name` 已不能区分，但 `idempotency_key` 可用）：

| 规则 | 命中 | 含义 |
|---|---|---|
| `idempotency_key REGEXP '^(m1-smoke|smoke-|gate-m1|m1c-)'` | **16** | 冒烟/门禁/验收残留 |
| `^ik-` | 4 | 运行期前端幂等键 |
| 其余 UUID | 3 | 2026-11-04 端到端联调 |

- 选项：

| 选项 | 做法 | 代价 | 回滚 |
|---|---|---|---|
| A 过滤展示（推荐，若确需统计干净） | 列表/统计 SQL 加 `NOT REGEXP '^(m1-smoke|smoke-|gate-m1|m1c-)'` | 改 Java Repository + 重打包 + 回归 | 去掉条件 |
| B 配置白名单 | 新增 `test_data_registry` 配置按主键过滤 | 新增配置文件与读取代码 | 删配置 |
| C 保持原样（当前） | 演示时说明历史数据 | 0 | - |

- `queue_number` 全 NULL：需确认「挂号时生成」还是「签到时生成」。**保持 NULL，不回填**；确认是挂号时生成再按 `日期 + slot` 顺序补，确认是签到时生成则 NULL 本就是正确状态。

### 3.2 医院主体（第 3 项）

- 出现位置：`departments.hospital_name` 16 行、`appointments.hospital_name` 23 行为「示例互联网医院」；`health_records.hospital` 7 行为「市第一人民医院」。
- 结构事实：两张表**都没有**独立的 `platform_name` / `tenant_name` 字段，`hospital_name` 是唯一机构名列 —— 若「示例互联网医院」是平台展示名，它当前确实被放在了应当放实体机构名的列里。但**方向不能由数据侧猜**。
- 需确认：① `health_records.hospital` 是出具记录的实体机构还是平台名；② 科室/预约的 `hospital_name` 是平台层还是实体机构层；③ 若需并存，是否允许新增 `platform_name` 列（**属结构变更，本轮不做**）。
- 选项：A 统一到实体机构名（只 UPDATE 机构名列，不碰自由文本）；B 保留双名 + 新增平台字段（结构变更）；C 展示层组合为「平台·实体机构」。决策前**不执行任何 UPDATE**。

### 3.3 过期邀请（第 7 项）

- 现状：4 条 `PENDING` 且 `expires_at < NOW()`；`FamilyRepository.consumeInvitation` 带 `expires_at > now`，**功能上安全**，只是列表展示不真实。
- 核查结论：`GET /api/v1/family-members/invitations` **前端未接入**（`miniprogram/config/api.js:74` 仅定义常量，全仓无调用）。改 Java 需重新打包并回归 319 项，展示收益为零 → 按「不该动的明确说不」本轮不执行；4 条数据在任何方案下都**不改**。
- 备好的最小方案 A（待该页面启用时执行）：`PatientService.listInvitations`（L459-463）把 `i.status()` 换成派生值：
  ```java
  "PENDING".equals(i.status()) && i.expiresAt() != null && i.expiresAt().isBefore(clock.instant())
      ? "EXPIRED" : i.status()
  ```
  前置确认：`clock` 是否已注入、契约测试是否允许新增状态值。**顺序不能反**：先改代码识别，再考虑状态数据；本方案根本不需要改数据。

## 四、第三档：所需信息清单 + 明确不做

| 项 | 现状 | 所需信息（提供方） | 数据侧动作 |
|---|---|---|---|
| 4 档案医生名 | 王慧敏 / 陈立 / 李国华 不在 30 位医生目录 | 是否要求报告医师必须在目录注册（临床管理/病案） | **不补登记**；按自由文本处理，强行补人会反向污染医生目录 |
| 5 稀疏主数据 | 排班 1/30、在线 1/30、头像 0/30、房号 0/30 | 排班是否对接 HIS、默认在线口径、人事/院感主数据来源 | **不批量插入**；见下方就绪度；演示需要时仅设 `online=false`，不编造 `true` |
| 8a 养护计划拒答 | 8/10 `REFUSED`，关联 `ai_tasks.model_profile='small-default'`（8 条全部） | 是否重跑历史计划（临床判断，非数据清理） | **可追溯性已存在**（`task_id → ai_tasks.model_profile`），无需新增 `model_version` 字段、不批量状态回滚；`care_plan_requests` 本身也没有该字段 |
| 8b 聊天颜文字 | `Σ(ﾟДﾟ) ⚡` 等 | 法务确认聊天是否归入必须保存的过程记录 | **保留原文，不修饰、不删除** |
| 8c 号源容量 | 20 人/时段、1200 号/天 | 医生接诊能力、线上问诊时长 | 转为**配置项说明**，不改任何号源数据 |
| 8d 审计/注销 | `audit_events` 5420 条；注销申请保留期限写「待法务确认」 | 法务给出保留周期 | **一条都不删**；日志的问题不是太多，而是留存不够或不可追溯 |

**数据就绪度说明（依赖外部主数据，非数据缺陷）**

| 字段 | 覆盖 | 依赖方 |
|---|---|---|
| `doctor_schedules` | 1/30 医生（6 行） | HIS 线下排班 / 医生自设线上排班 |
| `doctor_online_status` | 1/30 | 在线状态默认值口径 |
| `doctors.avatar_key` | 0/30 | 人事照片主数据 |
| `departments.room_no` | 0/16 | 院感 / 房号主数据 |

**明确不做清单**：删预约主表、批量改医院名、补登记 3 位医生、批量插排班/在线/头像/房号、给 `care_plan_requests` 加字段、改聊天原文、删日志、改号源容量、把 4 条邀请改成 `EXPIRED`。

## 五、回滚

- 上轮 389 行修正：用 `.trash/db-backup-20261105/affected-tables.sql` 整表恢复。
- 本轮全部批次（含 `family_members` / `appointments` / `health_articles`）：用
  `.trash/db-backup-20261105/full-before-batches.sql`（**全库** 1.7MB，批次前 `--single-transaction` 导出）整库恢复。
- 单项回滚 SQL 见 §六各批次；Java 过滤条件回滚 = 去掉 `EXCLUDE_TEST_APPTS` 拼接，无数据回滚。

## 六、落地批次执行记录（2026-11-05 上午）

> 对应业务方给的「1~5 落地批次」编号，与本文档 §一~§四 的「8 组」编号不同，勿混用。
> 原则执行：先全量备份 → SELECT 预演 → 单批事务 → 每批记录影响行数与回滚。

**前置环境**：MySQL80 服务隔夜为 `Stopped`，当前会话非管理员（`net start` 返回系统错误 5），
改由 `mysqld.exe --standalone` 直接拉起（端口 3306 就绪）。**该进程不随服务自启**，下次重启机器需重新拉起或由管理员启动服务。

**预演结果**（执行前 SELECT，全部留档）：
- 家庭重复分组：`PARENT 老李` 3 条、`SPOUSE 老王` 4 条；5 条候选在 `appointments.family_member_id`、
  `health_records.family_member_id` 引用均为 **0**，`family_members` 除主键外只有 `(user_id, idempotency_key)` 唯一索引。
- 过滤影响：预约 23 条 → 排除 **16**、保留 **7**。
- 排队号候选：4 个 slot 分组，每组 1 条，`max_no = 1 ≤ 20`（可直接执行）。

| 批次 | 动作 | 影响行数 | 回滚 SQL |
|---|---|---|---|
| A | `DELETE FROM family_members WHERE id IN (5 个候选) AND idempotency_key LIKE 'smoke-fm%'`（单事务） | **5**（8→3，重复组 0） | 全库备份恢复，或按 §2.2 保留表 + 已删 5 行原值重建 |
| B | 默认账号 `u-dev-user-1` 补 `FATHER 张国强` + `CHILD 张晓宇/张晓雯`，逐条 `NOT EXISTS` 守卫（单事务） | **3**（总数 6） | `DELETE FROM family_members WHERE user_id='u-dev-user-1' AND display_name IN ('张国强','张晓宇','张晓雯')` |
| C | 历史非测试预约 `queue_number` 回填：`UPDATE ... JOIN (ROW_NUMBER() OVER (PARTITION BY slot_id ...))`（单事务） | **4**（各为 1；16 条测试残留仍 NULL） | `UPDATE appointments SET queue_number=NULL WHERE id IN ('ap-8e4523cb-3a0b-419f-85cc-1f0322a90843','ap-574005f2-9f9d-4ac3-a90e-e0c266654347','ap-3866718b-549f-45db-a5d1-475183dd96b4','ap-77ba83c9-bbda-4063-b545-33b15b9290a7')` |
| D | `AppointmentRepository` 6 处列表/统计查询拼接 `EXCLUDE_TEST_APPTS`（Java，重打包） | 代码 6 处 | 去掉常量拼接即可 |

**与业务方模板的差异（均因实际表结构/语法，已按等价语义改写）**

| 模板写法 | 实际 | 处理 |
|---|---|---|
| `family_members.name` | 列名是 `display_name` | 用 `display_name` |
| `INSERT ... UUID()` | 项目 id 形如 `fm-<uuid>` | `CONCAT('fm-',UUID())`；`proxy_status` 用默认值 `NONE`，`idempotency_key` 留 NULL（避开唯一索引且不再生成 `smoke-fm*`） |
| `appointments.appointment_date` | 该列不存在，日期在 `doctor_slots.start_time` | 用 `DATE(s.start_time) < CURDATE()`；分组键用 `slot_id`（等价「日期 + 号源」） |
| `WITH ranked AS (...) UPDATE ...` | MySQL 8 不支持 `WITH` 前缀直接跟 `UPDATE` | 改为 `UPDATE ... JOIN (SELECT ... ROW_NUMBER() ...) r`，效果一致 |
| 正则过滤条件 | 表别名可省略 | 已核实 JOIN 的 `doctor_slots/doctors/departments/users` 均无 `idempotency_key` 列，不带别名不产生歧义 |

**批次 D 改动边界**：`listByUser`、`statsForUser`(3 个 COUNT)、`nextUpcomingForUser`、`listViewByUser`、
`nextUpcomingViewForUser`、`listViewByDoctor` 共 6 处列表/统计读取加了排除条件；
**`findById`、`findViewByIdempotencyKey`、以及所有 INSERT/UPDATE 一律未动** —— 幂等查重参与防重复提交，过滤会造成重复建单。

**验收数据**：家庭 `u-dev-user-1` 共 6 条、重复组 0；预约 `queue_number` 非 NULL 4 条、测试残留 16 条保持 NULL；
`check-project` 全通过、`test-fe` 14/14。

**仍需业务/代码侧确认（本轮未擅自处理）**

1. **PARENT/FATHER 语义重叠**：保留的 `PARENT 老李`（前端显示「父母」）与新补 `FATHER 张国强`
   在语义上都指向父亲。本轮按业务方第 5 条字面规则补种，未擅自改 relation。需确认是否把
   `PARENT` 归一为 `FATHER`/`MOTHER`，或保留 `PARENT` 作为宽松类型。
2. **queue_number 生成时机只落了一半**：历史 4 条已按「挂号时生成」回填，但代码当前 INSERT 仍传
   `null`，**新建预约仍不会有排队号**。需单独一期在 `AppointmentService` 建单时生成（同 slot 内递增），
   本轮为避免扩大改动面未动写入链路。
3. **医院名展示层组合暂无承载点**：按业务方口径「`示例互联网医院` = 平台展示名、
   `市第一人民医院` = 实体出具机构名」，**数据侧保持原样**（未 UPDATE 任何一行）。
   但两个名称不在同一条记录、也不由同一接口返回：平台名在 `departments/appointments.hospital_name`，
   实体名只在 `health_records.hospital`。要展示「平台 · 实体机构」需先指定页面与接口由谁提供实体名，
   当前无承载点，故列为待办而非硬造文案。
4. **`^ik-` 4 条与 3 条 11-04 联调数据**：按业务方意见保留、不纳入过滤；若日后要过滤需再给口径。

## 七、默认家属规则（种子说明，见业务方第 5 条）

- 同一 `(user_id, relation, display_name)` 唯一，**允许同一关系类型有多个不同成员**（如父/母各 1、子女 2~3）。
- 默认账号（`u-dev-user-1`）：`FATHER` 1、`MOTHER` 1、`CHILD` 2~3；`SPOUSE` 最多 1 且**不默认批量插**；
  其他亲属由用户自行添加；单用户总数建议 **≤6**。
- 补种**只对明确的演示/默认账号**，不按全库用户批量插；逐条 `NOT EXISTS` 防重复；
  **禁止再生成 `smoke-fm*` 家属数据**。
- 当前 `u-dev-user-1` 实际分布（6 条）：`FATHER 张国强`、`MOTHER 母亲`、`PARENT 老李`、
  `SPOUSE 老王`、`CHILD 张晓宇`、`CHILD 张晓雯`（`MOTHER/PARENT/SPOUSE` 为原有保留行）。

