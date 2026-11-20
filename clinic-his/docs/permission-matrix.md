# 权限矩阵与越权审计整改记录（clinic-his）

> 审计日期：2026-11-20 ｜ 审计方式：接口实测（脚本 `perm_audit.py` / `perm_retest.py`，直连运行中的 :8310 服务）+ 代码审查
> 结论：**发现并修复 3 处缺陷（S1 自开自执行、S2 自收自退、医生无叫号权限），复测全部通过**；其余 17 项越权/脱敏用例修复前即符合预期。

---

## 1. 权限模型实现方式（代码依据）

| 层 | 实现 | 位置 |
| --- | --- | --- |
| 权限定义 | `ROLE_PERMS` 常量（9 角色 × 36 权限码），**不落库**，实时由常量计算，改代码+重启即生效 | [security.py L41-81](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/app/security.py#L41-L81) |
| 接口中间件 | Router 注册时声明 `perm=`，请求进入即 `require_perm` 校验（后端鉴权为主） | `app/api/*.py` 各路由 |
| 数据范围 | `_owner_check(visit, user)`：无 `visit.read.all` 的医师只能读写本人接诊的就诊 | [clinical.py L12](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/app/api/clinical.py#L12)（10 处调用） |
| 脱敏 | `mask_name/mask_phone/mask_id_card`，按角色（`clinical.read`/`patient.read.all`）决定明文/脱敏口径 | security.py 脱敏节 |
| 前端路由守卫 | `VIEWS[].perm` + `route()` 校验，无权限视图不渲染入口 | [app.js L267-282](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/app/web/app.js#L267-L282) |
| 前端按钮控制 | `can(perm)` / `hasPerm()` 控制按钮显隐（仅作辅助，后端为准） | [app.js L286-288](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/app/web/app.js#L286-L288) |

角色映射（`ROLE_NAMES`）：ADMIN 系统管理员、DIRECTOR 院长、MEDICAL_AFFAIRS 医务科、DOCTOR 医师、NURSE 护士、PUBLIC_HEALTH 公共卫生、PHARMACIST 药师、CASHIER 收费员、TECHNICIAN 医技技师。

---

## 2. 角色 × 权限码矩阵（应有 = 实际，均已固化为代码）

✅=拥有，—=不拥有。ADMIN 按整改要求**不授予 clinical.read**（病历文本对管理员仍脱敏）。

| 权限码 | ADMIN | 院长 | 医务 | 医师 | 护士 | 公卫 | 药师 | 收费 | 技师 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| patient.read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| patient.read.all | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| patient.write | ✅ | — | — | ✅ | — | — | — | ✅ | — |
| clinical.read | — | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| reg.read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| reg.write | ✅ | — | — | — | — | — | — | ✅ | — |
| reg.checkin | ✅ | — | — | — | ✅ | — | — | ✅ | — |
| queue.read | ✅ | ✅ | — | ✅ | ✅ | ✅ | — | — | — |
| queue.call | ✅ | — | — | ✅* | ✅ | — | — | — | — |
| visit.read | ✅ | — | — | ✅ | ✅ | — | — | — | — |
| visit.read.all | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| visit.write | ✅ | — | — | ✅ | — | — | — | — | — |
| rx.read | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | — | — |
| rx.write | ✅ | — | — | ✅ | — | — | — | — | — |
| rx.review | ✅ | — | — | — | — | — | ✅ | — | — |
| rx.dispense | ✅ | — | — | — | — | — | ✅ | — | — |
| drug.read | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | — | — |
| drug.stock | ✅ | — | — | — | — | — | ✅ | — | — |
| charge.read | ✅ | ✅ | ✅ | — | — | — | — | ✅ | — |
| charge.pay | ✅ | — | — | — | — | — | — | ✅ | — |
| charge.void | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| charge.refund | ✅ | ✅ | — | — | — | — | — | ✅ | — |
| lab.read | ✅ | ✅ | ✅ | ✅ | — | — | — | — | ✅ |
| lab.order | ✅ | — | — | ✅ | — | — | — | — | — |
| lab.report | ✅ | — | — | — | — | — | — | — | ✅ |
| ph.read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| ph.complete | ✅ | — | — | — | — | ✅ | — | — | — |
| bed.read | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| bed.write | ✅ | — | — | ✅ | ✅ | — | — | — | — |
| nursing.read | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| nursing.write | ✅ | — | — | — | ✅ | — | — | — | — |
| staff.read | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| schedule.write | ✅ | — | ✅ | — | — | — | — | — | — |
| report.view | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | — | — |
| audit.view | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| system.admin | ✅ | — | — | — | — | — | — | — | — |

\* `queue.call` 医师项为本次整改新增（见第 5 节 S4）。

职责分离设计口径：
- 医师 `rx.write` 与药师 `rx.review/rx.dispense` 天然分离（医师无 review/dispense 权限）。
- 收费员持 `charge.refund` 但受**收退分离**运行时校验（见修复 2）。
- 护士持 `nursing.write`（开立）+ `nursing.write` 执行，受**开执分离**运行时校验（见修复 1）。

---

## 3. 角色 × 页面 × 按钮矩阵

页面列取自 `VIEWS[].perm`（app.js L267-282）；按钮列为该页面内 `can()` 控制的关键操作。

| 页面（路由守卫 perm） | 可见角色 | 关键按钮（按钮级 perm） |
| --- | --- | --- |
| 工作台 | 全部 | — |
| 挂号登记（reg.read） | 管理员/院长/医务/医师/护士/公卫/收费 | 新建患者、挂号、签到（reg.write / reg.checkin → 仅收费员，签到收费员+护士） |
| 分诊叫号（queue.read） | 管理员/院长/医师/护士/公卫 | 叫下一位、过号（queue.call → 医师*、护士） |
| 医生工作站（visit.write） | 管理员、医师 | 接诊、保存病历、诊断、处方、检查申请（visit.write / rx.write / lab.order） |
| 留观床位（bed.read） | 管理员/院长/医务/医师/护士 | 入科/出科、开立留观医嘱（bed.write / nursing.write → 医师、护士） |
| 护理执行（nursing.read） | 管理员/院长/医务/医师/护士 | 执行、取消（nursing.write → 护士；执行受开执分离校验） |
| 药房管理（rx.read） | 管理员/院长/医务/医师/药师 | 审核、驳回、发药（rx.review / rx.dispense → 仅药师）、库存调整（drug.stock） |
| 收费管理（charge.read） | 管理员/院长/医务/收费 | 收费（charge.pay → 仅收费员）、退费（charge.refund → 收费员+院长，受收退分离）、作废（charge.void） |
| 患者档案（patient.read） | 全部 | 建档/编辑（patient.write → 管理员/医师/收费员）；列表/详情按角色脱敏 |
| 医技检查（lab.read） | 管理员/院长/医务/医师/技师 | 采样、出报告（lab.report → 仅技师） |
| 公共卫生（ph.read） | 管理员/院长/医务/医师/护士/公卫 | 完成随访（ph.complete → 仅公卫） |
| 统计报表（report.view） | 管理员/院长/医务/医师/公卫 | — |
| 人员与排班（staff.read） | 管理员/院长/医务 | 排班维护（schedule.write → 管理员/医务） |
| 系统管理（audit.view） | 管理员/院长/医务 | 密钥轮换、合规检查（system.admin → 仅管理员） |

> 前端隐藏仅为体验辅助；**全部接口在后端 Router `perm=` 层独立鉴权**，第 4 节实测可证。

---

## 4. 数据范围与脱敏规则

| 规则 | 实现 | 实测证据 |
| --- | --- | --- |
| 医师只能读写本人接诊的就诊（水平越权防线） | `_owner_check`：非本人且无 `visit.read.all` → 403 VISIT_FORBIDDEN | H1/H2/H3（下） |
| 医师只能接诊本人号源的挂号 | start_visit 校验 registration.doctor_id → 409 NOT_YOUR_PATIENT | H4 |
| 患者姓名/电话脱敏 | 无 `patient.read.all` 且非诊疗岗位 → `mask_name`/`mask_phone` | D1/D2 |
| 住址仅诊疗/管理岗可见 | 无 `patient.read.all` 时详情不返回 address 字段 | D3 |
| 病历全文（EMR 文本） | 无 `clinical.read` → 按脱敏口径返回（管理员亦无 clinical.read） | 代码 security.py L41 注释 + V 系列 |
| 审计日志 detail 不落患者明文 | `audit()` docstring 约束 | 代码审查 |

---

## 5. 越权测试记录（修复前实测，perm_audit.py）

### 5.1 垂直越权（低权 token 直连高权接口）——10/10 拦截 ✅

| 用例 | 请求 | 结果 |
| --- | --- | --- |
| V1 收费员查审计日志 | GET /api/v1/audit-logs | 403 FORBIDDEN |
| V2 医生查系统合规 | GET /api/v1/system/compliance | 403 FORBIDDEN |
| V3 护士新建人员 | POST /api/v1/staff | 403 FORBIDDEN |
| V4 医生审核处方 | POST /api/v1/prescriptions/1/review | 403 FORBIDDEN |
| V5 技师收费 | POST /api/v1/charges/pay | 403 PERM_DENIED |
| V6 收费员查药品字典 | GET /api/v1/drugs | 403 FORBIDDEN |
| V7 收费员查留观 | GET /api/v1/bed-stays | 403 FORBIDDEN |
| V8 医生轮换对外密钥 | POST /api/v1/system/openapi-key/rotate | 403 FORBIDDEN |
| V9 收费员开始就诊 | POST /api/v1/visits | 403 FORBIDDEN |
| V10 护士看统计报表 | GET /api/v1/reports/daily | 403 FORBIDDEN |

### 5.2 水平越权（医生01 篡改 URL 访问医生04 的数据）——4/4 拒绝 ✅

| 用例 | 请求 | 结果 |
| --- | --- | --- |
| H1 读他人就诊 | GET /api/v1/visits/{vid} | 403 VISIT_FORBIDDEN |
| H2 改他人病历 | PATCH /api/v1/visits/{vid} | 403 VISIT_FORBIDDEN |
| H3 给他人患者加诊断 | POST /api/v1/visits/{vid}/diagnoses | 403 |
| H4 抢接诊他人号源 | POST /api/v1/visits（registration 属医生04） | 409 NOT_YOUR_PATIENT（拒绝，错误码语义为状态冲突） |

### 5.3 脱敏——4/4 通过 ✅

| 用例 | 结果 |
| --- | --- |
| D1 收费员患者列表姓名含 `*` | 通过 |
| D2 收费员患者详情姓名脱敏 | 通过 |
| D3 收费员患者详情无 address 字段 | 通过 |
| D4 院长患者详情显示全名 | 通过 |

### 5.4 职责分离——发现 2 缺陷 + 1 权限缺失 + 1 通过

| 用例 | 修复前结果 | 判定 |
| --- | --- | --- |
| S1 护士自开自执行留观医嘱 | **200 成功** | ❌ 缺陷：自开自执行未拦截 |
| S2 收费员退本人收取的账单 | **200 成功** | ❌ 缺陷：自收自退未拦截 |
| S3 收费员申请病历打印链接 | 403（grant 路由无 perm 声明，依赖内部 authorize） | ✅ 通过（内部校验有效） |
| S4 医生叫号 | 403 FORBIDDEN（DOCTOR 无 queue.call） | ❌ 不合理：真实 HIS 医生站必须叫号 |

---

## 6. 修复记录（3 处，后端为主）

### 修复 1：留观医嘱开执分离（S1）
[ward.py L294-296](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/app/api/ward.py#L294-L296) `execute_nursing_order`：

```python
me = ctx.user.get("staff_id") or ctx.user["id"]
if str(order["ordered_by"]) == str(me):
    raise ApiError(403, "SEPARATION_OF_DUTIES", "开立者不能执行本人开立的医嘱，请由其他护士执行（职责分离）")
```

### 修复 2：收费退费分离（S2）
[charge.py L141-145](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/app/api/charge.py#L141-L145) `refund_charge`：

```python
me = ctx.user.get("staff_id") or ctx.user["id"]
if row["cashier_id"] and str(row["cashier_id"]) == str(me) \
        and not security.has_perm(ctx.user, "charge.void"):
    raise ApiError(403, "SEPARATION_OF_DUTIES",
                   "收费员不能退收本人收取的账单，请由其他收费员或主管办理（收退分离）")
```

持 `charge.void` 的主管（院长/医务/管理员）可复核退费，符合"主管例外"惯例。

### 修复 3：医师授予叫号权限（S4）
[security.py L64](file:///d:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar/clinic-his/app/security.py#L64) DOCTOR 权限集新增 `"queue.call"`。

> 权限矩阵即代码：以上修复全部固化在 `ROLE_PERMS` 常量与接口运行时校验中，无数据库权限表依赖。

---

## 7. 复测结果（perm_retest.py，修复重启后）

| 用例 | 期望 | 实测 | 判定 |
| --- | --- | --- | --- |
| R1 护士01 自开自执行 | 403 | 403 SEPARATION_OF_DUTIES | ✅ |
| R1b 护士02 执行同一医嘱 | 200 | 200 | ✅ |
| R2 收费员退本人收的账 | 403 | 403 SEPARATION_OF_DUTIES | ✅ |
| R2b 院长（charge.void）复核退费 | 200 | 200 | ✅ |
| R3 医生查队列 | 200 | 200 | ✅ |
| R3b 医生叫下一位 | 200/409 | 通过（无候诊时 409 属正常业务态） | ✅ |

回归：隔离数据目录冒烟测试 `python scripts\smoke_test.py` **99/99 通过**（含叫号 force 参数适配，见 smoke_test.py 注释）。

---

## 8. 遗留与建议（P2）

1. **权限不落库的取舍**：当前 ROLE_PERMS 常量 + 重启生效，适合本项目规模；若需运行时自助配权，应引入 role_perms 表 + 缓存失效机制，并保留本文件矩阵作为验收基线。
2. **H4 错误码语义**：抢接诊返回 409 NOT_YOUR_PATIENT 而非 403，拒绝有效但建议统一为 403 语义（低优先级）。
3. **documents grant 路由**：S3 依赖内部 authorize 而非 Router `perm=` 声明，建议补 `perm="visit.read"` 使防线显式化（当前实测已 403，无实际暴露）。
4. **会话 30 分钟空闲过期**（security.py `IDLE_MINUTES`）符合等保要求，无需修改。
