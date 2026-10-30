# COMPAT · legacy 兼容层活跃表（edge-gateway）

> 来源：`backend/contracts/business-openapi.yaml` 的 `x-migration` + `miniprogram/config/api.js` 实际调用。
> 原则（docs/v4/08 §6）：**单一实现**——旧路径只在网关这一层承接，服务内部不出现 legacy；
> 每条标注 deprecated 与移除条件（前端迁移完成即删）；不能等价转发的返回明确错误，不造假数据。

状态取值：`active`（已生效）｜`pending`（未完成迁移：501 + 说明）｜`dropped`（废弃：410）｜`same-path`（同路径直通，无需翻译）

| # | 旧路径（legacy） | 新路径（replacement） | 状态 | 里程碑 | 备注 / 移除条件 |
|---|---|---|---|---|---|
| 1 | `GET /health` | `GET /api/gw/health` | active | M0 | 探针收敛到网关；前端迁移后移除 |
| 2 | `POST /api/v1/consultation/emergency/check` | `POST /api/v1/triage/emergency-checks` | active | M0/M1 | 旧前端 text 在 query → 已翻译为 body；**响应适配（M1）**：补遗留字段（`is_emergency`/`risk_level`（紧急→"high"）/`emergency_message`/`matched_keywords`/`safe`）+ 信封 `code:200` |
| 3 | `POST /api/v1/case/recommend-department` | `POST /api/v1/triage/recommendations` | active | M0/M1 | `{text}`→`{symptoms}`；**响应适配（M1）**：`clinic`/`department`/`dept`/`reason` 补自 `recommendedDepartments[0]`（空则回退本地规则）+ 信封 `code:200` |
| 4 | `POST /api/v1/voice/tts/edge` | `POST /api/v1/voice/tts` | active | M0 | 兼容别名；引擎由服务端配置决定（O-10） |
| 5 | `POST /api/v1/voice/voices/save` | `POST /api/v1/voice/voices` | active | M0 | 资源化：POST 到集合表示保存偏好 |
| 6 | `GET /api/v1/voice/models` | 同路径 | same-path | M0 | 语义改由业务侧返回能力状态 |
| 7 | `DELETE /api/v1/voice/voices/{id}` | `DELETE /api/v1/voice/voices/{voiceId}` | same-path | M0 | 路径形状相同；参数名统一由业务侧承接 |
| 8 | `POST /api/v1/voice/voices/preview` | `POST /api/v1/voice/voices/{voiceId}/previews` | pending | M2 | 固定示例文本，避免任意合成通道 |
| 9 | `POST /api/v1/voice/voices/reload` | （无 replacement） | dropped | M0 | 运维动作不再下发客户端；改由管理面/进程信号触发 → 410 |
| 10 | `POST /api/v1/consultation/start` | `POST /api/v1/consultations` | pending | M2 | 会话语义收敛（返回会话 + 任务两个对象） |
| 11 | `POST /api/v1/consultation/continue` | `POST /api/v1/consultations/{consultationId}/messages` | pending | M2 | 用户消息先落库再触发生成 |
| 12 | `POST /api/v1/consultation/confirm` | `POST /api/v1/consultations/{consultationId}/confirmations` | pending | M2 | 转写确认独立成资源 |
| 13 | `GET /api/v1/consultation/status/{id}` | `GET /api/v1/ai/tasks/{taskId}` | pending | M2 | 任务状态统一到 ai-task |
| 14 | `POST /api/v1/case/health/care-plan` | `POST /api/v1/care-plans` | pending | M2 | 输出为生活方式建议，不构成处方 |
| 15 | `GET /api/v1/doctor/list` | `GET /api/v1/doctors`（实际转发；契约迁移口径为 `GET /api/v1/departments/{departmentId}/doctors`） | active | M1 | 实际转发用全局列表端点承接；**响应适配**：补 `department`/`expertise`（specialties 连接）/`status`（可预约/约满/空）+ 信封 `code:200`；前端迁移后移除 |
| 16 | `GET /api/v1/doctor/by-department` | 同上 | active | M1 | legacy 参数为**科室名**（`dept=`）或科室 ID；本层在网关按 `departmentName`/`departmentId` 过滤真实数据（不伪造） |
| 17 | `POST /api/appoint/updateStatus` | `POST /api/v1/doctor/appointments/{appointmentId}/status` | pending | **M3** | ⚠️ **不可等价转发**（保持 501 + 逐条原因）：目标要求 `expectedVersion`（乐观锁，required）与 `Idempotency-Key` 头，legacy 均未提供；且状态文案（待就诊/就诊中/已完成）与契约 `AppointmentStatus` 枚举**不可双射**（契约无「就诊中」态）。**不代填版本** → 前端须迁移 |
| 18 | `PUT`（前端实际）/ `POST`（x-migration 声明） `/api/v1/bed/update/{id}` | `POST /api/v1/beds/{bedId}/assignment` | pending | **M3** | ⚠️ **不可等价转发**（保持 501 + 逐条原因）：目标要求 `action` 枚举 + `expectedVersion`；且 `patientRef` 必须为**内部患者 ID**（契约明令不接受姓名/手机号），legacy 仅传 `patientName`——透传将违反隐私约定。⚠️ **方法差异**：前端 `doctor.js#updateBed` 实际用 **PUT**，x-migration 记 POST；两种方法均已注册（避免落到上游 404），差异待 M 侧统一 |
| 19 | `POST /api/user/login` | `POST /api/v1/auth/wechat/login` | active（**devOnly**） | M1 | **dev 联调替身**：`{phone}`→dev 档微信登录换取（`code=legacy-compat-<phone>`、`phoneCode=dev-phone-<phone>`，**不做密码校验**）+ 注入 `X-Client-Version`/`X-Platform`（`X-Platform` 必须为契约 const `wechat-miniprogram`——2026-10-15 修正，原 `miniprogram-legacy` 被 M 侧 const 校验拒绝 → 422）；响应还原旧端扁平对象 `{code:200,msg,name,userId}`（无 data 字段，**刻意不下发令牌**）；**生产构建不得使用**（x-migration）。2026-10-16：条目挂 `devOnly` 标记，由 `compat.legacyLoginEnabled`（`deploy/config.json`）/ `GW_LEGACY_LOGIN_ENABLED` 控制，**安全默认关闭（未显式开启即 404）**；小程序已迁移到契约 `/api/v1/auth/**`，本条目仅留旧客户端联调 |

## 维护规则

1. 新增/修改兼容条目 = 同时改三处：`app/compat.py`、本表、`x-migration`（如涉契约口径需报用户）。
2. 条目转 `active` 前必须有：翻译函数 + 单测（`tests/test_compat.py`）+ 联调验证记录（DEV_LOG）。
3. 前端完成某条迁移后，把条目从 `compat.py` 删除并在本表标记 `已移除（日期）`——**只删不加**。
4. `pending` 条目被调用时返回 `501 COMPAT_PENDING`（含里程碑与说明），**不得返回伪造数据**。
   当某条**不可等价转发**时，条目可声明 `blockers: [原因…]`：网关随错误 `details` 逐条返回
   （`code: COMPAT_BLOCKER`），便于联调方定位「为何不能自动翻译」。**一律不代填缺失字段**
   （乐观锁版本、枚举、幂等键等）——代填等价于伪造语义。
5. 条目自洽性（adapter/translator 名称可解析、translate 必有 target）由 `test_all_entries_reference_existing_handlers` 守住。
6. **`headerOverrides` 是覆盖、不是追加**（2026-10-17 修）：出站头一律小写归一后写入 dict，同名头只保留一条。
   否则客户端自带 `X-Platform` 时会向上游发两条，Spring 逗号拼接后 const 校验失败 → **422**（不带该头则 200，大小写均可复现）。
   回归用例 `tests/test_proxy_headers.py`（大写/小写/错误值/Authorization 透传 4 例）。

## 响应适配机制（M1 起）

`compat.py` 的 `RESPONSE_ADAPTERS` 注册具名适配函数；条目通过 `"responseAdapter"` 引用；
条目可 `"translator": null`（纯响应适配，如 #15/#16），请求 query 用 `"dropQuery": true` 拦截不外传。

- 仅作用于 **2xx + application/json**；非 JSON / 非 2xx **原样透传**（错误路径不改编，避免双重包装）。
- **加字段式**：保留新契约字段，仅补旧端消费的字段；信封降级 `code:"OK"` → 数字 `200`
  （旧前端 `request.js` unwrap 只认 `code===200/'200'/0`，不降级则全部落到 BIZ_ERROR）。
- 请求侧补充上游必需头用条目 `"headerOverrides"`（如 #19 → `X-Client-Version` / `X-Platform`）。
- 适配失败（结构不符/解析失败）→ 原样透传 + warning：**不中断用户链路，不吞错**。
