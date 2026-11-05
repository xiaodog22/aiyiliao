# 08F · M 侧转交任务书（R1 补缺 + R2 登记）

> 签发：Agent-D（DeepSeek-V4.1-Flash），2026-10-15（M1 收口轮）。
> 依据：08D §6 R1/R2、08D 判据 9 项、08B 任务书（服务端分诊对齐 `triage-kb.js`）。
> 性质：**M1 最小补缺**，不是 M2 开发。禁止顺手重构、禁止扩展到 M2/M3/M4 范围。
>
> **转交生效（2026-10-15 17:31，用户批准）**：M1 门已签署 Approved（08D §7），R1/R2 处置=A（返工），本任务书正式转交 M 侧执行；并新增 T3（N-2 裁定=保留纳管）。
> **定义优先级**：T1/T2/T3 的技术定义**以本任务书原文为准**（用户复核引言为业务侧简述：T1≈"口语化表述统一规范术语"、T2≈"台账与实际落地一致"，均指向下文精确条款）。

---

## T1（对应 08D R1）：分诊引擎补口语归一化

### 现状（Agent-D 2026-10-15 核实）
- `TriageRuleEngine.java`（mtime 10-15 00:55）**未做口语归一化**：
  - `POST /api/v1/triage {"symptoms":"肚子疼"}` → `recommendedDepartments: []`（空推荐，08D 缺口-1 实测复现于 `m1-gate-2026-10-15/19-E2E2-triage-dzt.body.json`）；
  - 书面词「胃疼」「胃胀反酸」正常命中消化内科 —— 缺的是口语→标准词的归一层。
- 参照实现：前端 `miniprogram/utils/triage-engine.js` 的 `normalizeLoose()`（折叠 有点/很/挺/比较/特别/非常 等）+ 口语变体词表（「肚子疼→腹痛」等）。

### 修复要求
1. 在 business-service 分诊引擎**统一入口**补口语归一化（先归一、再进现有规则匹配）：
   - 不在前端新增兜底掩盖服务端问题；
   - **不为「肚子疼」单独硬编码科室**——必须走通用「口语词→标准症状词」映射，映射表可参照 `triage-kb.js` 已确认词表，不自行编造医学规则；
2. 归一只作用于症状匹配，**不得削弱红旗/急诊级别判定**（参照前端教训：`normalizeLoose` 只给 score 用，禁入槽位/红旗路径）。
3. **新增回归用例**（JUnit，进现有测试体系），至少覆盖：
   - a) 标准表达与口语表达同上下文一致处理（如「腹痛」vs「肚子疼」→ 同科室）；
   - b) 完整口语句子（如「这两天肚子疼得厉害还拉肚子」）；
   - c) 否定表达不误判（如「没有肚子疼」「不发烧」不命中相应症状）；
   - d) 已有高优先级/紧急规则不被新增映射覆盖（如「胸痛」仍触发急诊级）。

### 验收标准
- business-service **直连** `POST /api/v1/triage`：「肚子疼」返回消化内科（或与 triage-kb 一致的目标科室），`recommendedDepartments` 非空；
- **经网关** `http://127.0.0.1:8000/api/v1/triage` 同样验证（走 legacy 适配层不回归）；
- 证据不得引用前端本地推荐；全量 `mvnw test` 通过、新旧用例分别统计；
- 证据落 `backend/deploy/run/` 新建目录，含请求/响应快照与退出码。

### 约束
- 只改 business-service 分诊相关代码与测试；不动契约、网关、ai-service、deploy；
- 归一层放 `TriageRuleEngine` 入口或独立 util 类均可，但必须可单测、无 I/O；
- 完成后按 08B 惯例更新 business-service README 进度表 + DEV_LOG（即完成 T2）。

## T2（对应 08D R2）：补 M1 交付登记

### 现状（Agent-D 2026-10-15 核实）
- `backend/business-service/README.md`（mtime 10-15 04:13）进度表 M1 仍未勾；
- DEV_LOG 无 M1 交付 `[M]` 条目（实现本身已就绪：auth/catalog/appointment/triage + 37/37 单测）。

### 要求
- 不重复实现，只补登记：README 进度表勾 M1 并附证据关联（单测统计、M1IntegrationTest 路径）；DEV_LOG 追加 `[M]` 条目（改动摘要 + 测试证据）。
- 完成后在 08D §6 R2 行标注处置结果，交 Agent-D 复核。

## T3（对应 08D §8.2 N-2 裁定=保留纳管，用户 2026-10-15 17:31 批准）

### 背景
M 侧提前实现的 M2.1（`ConsultationController` + Flyway V3/V4）**保留不回滚**，直接纳管；但其打挂了骨架测试 `EnvelopeAndNotImplementedTest.未实现路径返回NOT_IMPLEMENTED而非空200`（`GET /api/v1/consultations` 期望 501 实得 200），当前 M 侧单测 41/42。

### 要求
1. 更新 `EnvelopeAndNotImplementedTest` 测试基线：consultations 已实现，改用**当前仍未实现的路径**（如 M2+ 其他域）验证 501 契约不被破坏；`requestId 回显` 等关联用例同步修正；
2. 为 M2.1 补充单元/集成测试用例（consultations 域覆盖：创建幂等、列表游标、详情、消息、确认；急症优先不阻塞为必测点）；
3. 修复后 `mvnw test` 全绿（含新增用例），统计新旧数量并在回执说明；
4. 更新 business-service README 进度表（M2.1 已实现）与 DEV_LOG 条目（可与 T2 合并一条）。

### 约束
- 只动测试与登记，**不继续扩展 M2.2/M2.3 功能**（后续里程碑开工待用户另批）；
- 不修改已实现业务逻辑（除测试暴露的真实缺陷——如有，在回执中单独说明）。

## 交付回执
完成 T1/T2/T3 后在本文件末尾追加回执（执行时间、改动文件、测试统计、证据路径），由 Agent-D 复验（真机复跑「肚子疼」双链路 + 回归用例审查 + 范围外扫描）。

> **M 侧回执状态（2026-10-15 复验时点）**：**未按本约定追加回执**（M 侧以 `DEV_LOG [M] M2 四域构建验证收口` 条目替代登记）。属流程偏差，已在 `08D §9` 登记。

---

## Agent-D 复验记录（2026-10-15）

复验对象：本任务书 T1/T2/T3 落盘情况（静态核验 + 双方测试实测）。

| 项 | 结论 | 要点 |
|---|---|---|
| T1 分诊口语归一化 | ❌ **未落盘** | `TriageRuleEngine` 无归一层、无口语→标准词映射、无 a/b/c/d 回归用例；全仓无 `肚子疼` 业务实现 |
| T2 补 M1 登记 | ✅ **已落盘** | business README M1 行 ✅；DEV_LOG 有 `[M] Agent-M M1…` 条目 |
| T3 N-2 纳管 | ✅ **已落盘**（超出范围） | 骨架测试改用 `GET /api/v1/beds` 验 501；新增 `M2IntegrationTest` 14 例；M 侧 56/56。**偏差**：T3 约束「不扩展 M2.2/M2.3」，M 侧却实装 M2 四域（已在 08D §9.3 登记） |

- 实测：ai-service 48 passed / edge-gateway 32 passed / business 56/56（surefire）/ 四门禁 warnings=0。
- **⑨（E2E-2「肚子疼」）不做真机复跑**：前置的 T1 未落盘，复跑必然仍空推荐，不产生新信息（不空跑、不伪造证据）。
- **结论**：⑦ 闭环（T2 完成）；**⑨ 仍 OPEN**（待 M 侧 T1 完成后由 Agent-D 复跑双链路补记）。明细见 `08D §9`。

**复验人**：Agent-D（DeepSeek-V4.1-Flash）　**日期**：2026-10-15

## 附注（Agent-D 2026-10-15 16:40 复验发现，随本任务书一并转交）
- **N-2**：M 侧已在 M1 门未签署前实现 M2.1（consultations + Flyway V3/V4），且打挂其骨架测试 `EnvelopeAndNotImplementedTest`（consultations 期望 501 实得 200）。执行本任务书时**不得继续扩展 M2 功能**；N-2 的处置（回滚或更新测试基线）需用户裁定，M 侧应在回执中一并说明。
- 本任务书执行期间若涉及 `auth` 域：网关 #19 兼容条目的 `X-Platform` 已修正为契约 const `wechat-miniprogram`（见 08D §8.2 N-1），勿在 M 侧再放宽校验。

---

## T1 落地规格（Agent-D 2026-10-15 补充，diff-ready）

> 背景：`08D` 判定 **T1 未落盘**（无归一层、无口语→标准词映射、无 a/b/c/d 回归用例）→ 导致 **⑨（E2E-2「肚子疼」）仍 OPEN**。本规格为 Agent-D 产出的**可直接照做的实现口径**，供 M 侧落地；完成后由 Agent-D 复跑双链路闭环。

### 1. 目标与位置
- **目标**：分诊服务端在**规则匹配之前**补一层「口语 → 标准医学词」归一化，使口语症状（如「肚子疼」）能命中与书面词（「腹痛」）一致的科室。
- **位置**：推荐新增独立纯函数类 `com.wechar.biz.triage.TriageNormalizer`（便于单测、无框架依赖），由 `TriageRuleEngine` / `TriageService` 在**匹配前**调用；**不改**规则权重与科室目录。

### 2. 映射表（最小可用集；同义词一律映射到**已存在于 `DEPARTMENT_KEYWORDS` 的标准词**）
| 口语/变体 | 标准词（须已在关键词表中） | 备注 |
|---|---|---|
| 肚子疼 / 肚子痛 / 肚子难过 | 腹痛 | ⑨ 的验收输入就是「肚子疼」 |
| 拉肚子 / 拉稀 / 拉水 | 腹泻 | |
| 胃疼 / 胃痛 / 胃不舒服 | 胃痛 | |
| 想吐 / 要吐 / 反胃 | 恶心 / 呕吐 | |
| 烧心 / 心口烧 | 反酸 / 烧心 | |
| 头疼 / 脑袋疼 | 头痛 | |
| 胸口闷 / 胸闷 / 心口疼 | 胸闷 / 胸痛 | ⚠️ 与红旗相关，见 §3 |
| 喘不上气 / 气短 / 喘 | 呼吸困难 | ⚠️ 红旗相关 |
| 拉不出 / 大便干 | 便秘 | |
| 发烧 / 低烧 / 高烧 | 发热 | |

### 3. 硬约束（违反即判不通过）
1. **先归一、后匹配**：归一化必须发生在关键词匹配与**红旗判定之前**；归一化**只做同义词替换**，**不得**删除任何红旗词或程度词。
2. **红旗不可被削**：如「肚子疼得厉害 + 便血」→ 归一为「腹痛 + 便血」，红旗仍须触发、主推荐仍须切**急诊科**（与 `docs/v4/03` 前端「红旗优先于后端」口径一致，服务端亦不得漏判）。
3. **不做程度折叠**：**禁止**把「有点/很/非常/挺/比较」等程度副词折叠掉（前端 `normalizeLoose()` 只用于打分、绝不用于槽位/红旗；服务端同样**只做同义词、不做程度归并**，避免把不同严重度合并）。
4. **幂等**：标准词输入再经归一化不得发生变化（`normalize(normalize(x)) == normalize(x)`）。
5. **不改契约**：`/api/v1/triage` 与 legacy 推荐路径的请求/响应形状不变；仅提升命中率。

### 4. 回归用例（≥4 例，a/b/c/d 四类各 ≥1）
| 类 | 用例 | 期望 |
|---|---|---|
| a | 纯口语命中 | 输入「肚子疼」→ 推荐含 **消化内科**（非空） |
| b | 口语 + 红旗 | 输入「肚子疼得厉害，还便血」→ **红旗触发**，主推荐=**急诊科** |
| c | 变体等价 | `normalize("肚子疼") == normalize("腹痛")`；两输入推荐科室**一致** |
| d | 幂等/兜底 | `normalize(normalize("肚子疼"))` 稳定；「不舒服」仍走**全科兜底**，部位词命中时按 `PART_PRIMARY` 拉正 |

### 5. 验收口径（Agent-D 复验时执行）
- 静态：确认归一层存在且在匹配前调用；映射表覆盖 §2 最小集；无程度折叠代码。
- 单测：`mvnw test` 全绿（含新增 ≥4 例），在回执中给出新旧用例数。
- **真机复跑（关 ⑨ 的唯一依据）**：经网关复跑**双链路**——① `POST /api/v1/triage`、② legacy 推荐路径——输入「肚子疼」，**须返回非空推荐且科室正确**；证据留存至 `backend/deploy/run/`。
- 回执：按本文件「交付回执」约定在**末尾追加**（上轮未追加，属流程偏差，本轮务必补齐）。

---

## T1 交付回执（M 侧，2026-10-15）

> 补齐上轮缺失的回执约定（本文件「交付回执」段 + §5 第 4 条）。范围仅 T1（口语归一化）；T2/T3 已在前轮经 DEV_LOG 登记（Agent-D 复验 ✅），不重复。

### 执行时间
2026-10-15（T1 落地轮）。

### 改动文件
| 文件 | 性质 | 说明 |
|---|---|---|
| `backend/business-service/src/main/java/com/wechar/biz/triage/TriageNormalizer.java` | 新建 | §1 指定的纯函数归一层（无框架依赖、无 I/O）；§2 最小映射集全量落地；按口语词长度降序替换；「气喘/哮喘/喘息/喘鸣」sentinel 保护，防裸「喘」破坏医学词 |
| `backend/business-service/src/main/java/com/wechar/biz/triage/TriageRuleEngine.java` | 修改 | `scanText` / `recommendDepartments` 入口先 `normalize` 再匹配（§3.1 先归一后匹配，evaluate 复用 scanText 天然走归一层）；红旗表 `severe_bleeding` 补 `便血/黑便`；呼吸内科补关键词 `呼吸困难` |
| `backend/business-service/src/main/java/com/wechar/biz/triage/TriageService.java` | 修改 | 红旗触发时主推荐切急诊科合成条目（§4b，id=`emergency` 对齐前端导航字典） |
| `backend/business-service/src/test/java/com/wechar/biz/triage/TriageNormalizerTest.java` | 新建 | 7 例：§2 全表逐行断言、幂等、程度不折叠、红旗词不删、医学词保护、null/空串安全 |
| `backend/business-service/src/test/java/com/wechar/biz/triage/TriageRuleEngineTest.java` | 修改 | 6→12 例，新增 §4 a/b/c/d 四类 + 全表红旗不削 + 程度不折叠 |
| `backend/business-service/src/test/java/com/wechar/biz/M1IntegrationTest.java` | 修改 | 26→28 例，新增口语归一集成 2 例（`/api/v1/triage/recommendations`） |

### 测试统计（新旧用例分别统计）
- 全量 `.\mvnw.cmd test`：**71/71 全绿**（旧 56 → 新 71；新增 15 = 归一 7 + 引擎回归 6 + 集成 2）。
- 四门禁：`CONTRACT_CHECK_OK business=48 warnings=0` / `DOC_CHECK_OK warnings=0` / `REQUIRE_OK` / exports 全对。

### 证据路径
`backend/deploy/run/t1-triage-normalizer-20261015/`（4 份 JSON）：
- `1-triage-new-path`：网关 `POST /api/v1/triage`「肚子疼」→ 非空推荐，消化内科；
- `2-triage-legacy-path`：legacy 推荐路径「肚子疼」→ `clinic:"消化内科"`（修复前为 `""`）；
- `3-redflag-b-class`：§4b「肚子疼得厉害+便血」→ `emergency=true`，主推荐 `急诊科`；
- `4-fallback-d-class`：§4d「不舒服」→ 空推荐（INFO），交前端全科兜底。
- 注：经网关复跑曾出现 `recommendedDepartments: []` 假失败，根因是 PowerShell `Invoke-WebRequest` 中文请求体非 UTF-8 编码，改用 `curl.exe --data-binary "@file"`（UTF-8）后双链路全部正确——**非服务端缺陷**，复跑请使用 UTF-8 请求体。

### §3 硬约束核验
1. 先归一后匹配 ✅（入口统一调用，evaluate/scanText/recommendDepartments 均覆盖）；
2. 红旗不可被削 ✅（归一仅同义替换且「心口疼→胸痛」保 chest_pain；补 `便血/黑便` 红旗表缺口属真实缺陷修复，与前端 `triage-kb.js` 对齐）；
3. 不做程度折叠 ✅（无「有点/很/非常」等折叠代码，测试断言程度词原样保留）；
4. 幂等 ✅（输出词集与源词集互不相交，`normalize(normalize(x))==normalize(x)` 有断言）；
5. 不改契约 ✅（请求/响应形状未变，仅命中率提升；门禁 CONTRACT warnings=0）。

### 规格冲突处理说明（2 处，供 Agent-D 复验）
1. **§4b「主推荐=急诊科」/§4d「全科兜底」与 §1「不改科室目录」**：急诊科不在 departments 只读目录 → 按**合成条目**下发（id 与前端 `triage-kb.js` 导航字典 `emergency` 对齐；前端不消费服务端 `recommendedDepartments`，已 grep 确认 0 处引用，安全）。全科兜底判定为**前端职责**（§3.2 原文「与前端红旗优先口径一致」；legacy 网关适配层已定义「空推荐→回退本地规则」语义，见 `COMPAT.md` #3）——服务端职责是不漏判红旗 + 不产生虚假专科。
2. **§2 目标词落点**：`呼吸困难` 原不在 `DEPARTMENT_KEYWORDS` → 补进呼吸内科（否则该行映射落空）；`头痛` 服务端无神经内科 → 归一保留标准词、不硬塞错科室（测试注释已说明）。

### 范围外声明
- 未动契约、网关、ai-service、deploy、前端；未改规则权重与科室目录；未扩展 M2/M3 范围。
- N-2（M2 纳管）前轮已按用户裁定处理完毕，本轮无涉及。
- 证据与运行产物均在 `backend/deploy/run/`（已被 .gitignore 排除，不入库）。

**交付人**：Agent-M（MiMo-V2.6-Flash）　**日期**：2026-10-15　→ 交 Agent-D 复验（真机复跑双链路 + 回归用例审查 + 范围外扫描）。

---

## Agent-D 闭环复验记录（2026-10-15 22:22）

**复验对象**：M 侧 T1 交付回执（上）。**方式**：代码/用例审查 + M 侧单测实跑 + 运行态换装核验 + **经网关 8000 真机复跑双链路**。

### 逐项核验

| 项 | 结论 |
|---|---|
| T1 代码逐条符合规格 | ✅ `TriageNormalizer`（映射表 = 08F §2 最小集超集；长度降序；医学词 sentinel 保护；`normalize` 幂等；null 安全）；`TriageRuleEngine` 入口 `scanText`/`recommendDepartments` 均先归一 |
| a/b/c/d 回归用例 | ✅ 齐备（`TriageNormalizerTest` 7 例 + `TriageRuleEngineTest` 6→12：a/b/c/d + 映射表全量红旗不削 + 程度不折叠） |
| 规格冲突处理 2 处 | ✅ **接受**。①「急诊科合成条目」合理（急诊科不在只读目录，且前端不消费服务端 `recommendedDepartments`，已 grep 0 引用）；②「呼吸困难」补入呼吸内科关键词属**必要落点修复**（否则该映射空转）→ 均已由 Agent-D 实测确认链路生效 |
| **未授权改动审查** | ⚠️ **登记（不追责）**：`TriageRuleEngine` 红旗表补 `便血/黑便`、`TriageService` 红旗时主推荐切急诊科——超出 08F T1 字面范围，但属 §4b/§4d 用例可达的必要条件，且**与前端 `triage-kb.js` 口径一致**（红旗优先、主推荐切急诊）。记为「**必要连带改动**」，非越界 |
| M 侧单测实跑（Agent-D 代跑，非引用） | ✅ **71/71 · BUILD SUCCESS**（22:03，EXIT=0；3+3+4+28+14+7+12） |
| 范围外扫描 | ✅ 未动 `backend/contracts/**`、网关、ai-service、deploy、前端；四门禁 `warnings=0` |

### 真机复跑（判据 ⑨ 闭环依据）

经网关 8000 复跑「肚子疼」双链路，**9 项判定全 true / `closure_9 = true`**（`09-e2e2-dzt.json`）：
链路 1（`/api/v1/triage/recommendations`）与链路 2（legacy `/api/v1/case/recommend-department`）**均非空、首位=消化内科（`dep-gastro`，reason「症状关键词命中：腹痛」）**；c 变体等价 ✅；b「肚子疼得厉害+便血」→ EMERGENCY + 主推荐急诊科 ✅；「心口疼」→ chest_pain 仍触发 ✅；d「不舒服」不误判 ✅；幂等 ✅。

**注（M 侧证据坑的复现确认）**：M 回执称「经网关复跑曾假失败，根因是 PowerShell `Invoke-WebRequest` 中文请求体非 UTF-8」。Agent-D 本轮改用 **Python httpx（UTF-8）** 复跑，双链路一次通过——**旁证该坑确为客户端编码问题，非服务端缺陷**。

**结论**：T1 **通过**；**⑨ 由 OPEN 转为已闭环**（见 `08D` §7/§9.7）。

**复验人**：Agent-D（DeepSeek-V4.1-Flash）　**日期**：2026-10-15 22:22
