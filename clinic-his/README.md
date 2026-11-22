# 康诊云社区诊所信息系统（Clinic HIS）

一套**可独立运行、零第三方依赖**的社区诊所业务系统，用于演示与验证主项目预留的医院 HIS 对接接口
（`backend/business-service/.../appointment/his/HisClient`）在真实院方系统下的表现。

- 技术栈：Python 3.10+ 标准库（ThreadingHTTPServer + sqlite3 + hashlib/hmac）+ 原生 HTML/CSS/JS
- 端口：默认 `8310`（环境变量 `CLINIC_PORT` 可改），不占用主项目 8000/8001/8088
- 数据：`data/clinic.db`（SQLite，WAL），首次启动自动建库并写入演示数据
- 边界：**演示系统**。所有人员、患者、药品、诊疗数据均为虚构，不得用于真实诊疗

---

## 一、参考依据与开源对标

| 类别 | 参照 |
| --- | --- |
| 等保 | GB/T 22239-2019（等保 2.0 二级控制点） |
| 健康数据 | GB/T 39725-2020 健康医疗数据安全指南、GB/T 35273-2020 个人信息安全规范 |
| 法律 | 《个人信息保护法》《数据安全法》《网络安全法》 |
| 病历 | 《电子病历应用管理规范（试行）》（国卫医发〔2017〕8 号）、《医疗机构病历管理规定》 |
| 处方 | 《处方管理办法》（卫生部令第 53 号）、《抗菌药物临床应用管理办法》 |
| 公卫 | 《传染病防治法》（24 小时上报）、《国家基本公共卫生服务规范》（慢病随访） |
| 标准 | WS 445-2014 电子病历基本数据集、WS 375.9-2012、ICD-10 疾病编码 |
| 开源 | OpenHIS 诊所版（五核心模块：预约登记 / 就诊 / 收费发药 / 报表 / 库存）、OpenMRS、OpenEMR、GNU Health、Marley；HL7 FHIR R4 资源命名 |

合规逐条落地见 [docs/03-合规对照表.md](docs/03-合规对照表.md)。

---

## 二、人员编制

| 类别 | 人数 | 说明 |
| --- | --- | --- |
| 医师 | 8 | 全科 3、内科 2、儿科 1、中医 1、口腔 1；职称覆盖主任/副主任/主治/住院 |
| 护士 | 14 | 其中 3 名为公共卫生岗（N010~N012），承担传染病上报与慢病随访 |
| 行政后勤 | 6 | 院长、医务科、药师、收费 2、信息科 |
| 医技 | 2 | 检验、放射（业务支撑岗，不计入上述三类编制） |

共 13 个科室、30 个账号、10 名演示患者、22 种药品、37 条 ICD-10、9 个检查项目。

初始口令不再写死：首次初始化时若设置了 `CLINIC_SEED_PASSWORD` 则使用该值，否则随机生成并**仅在启动日志打印一次**；所有种子账号 `must_change=1`，改密前除 `/auth/me`、`/auth/password`、`/auth/logout` 外一律 403。

| 账号 | 人员 | 角色 | 主要权限 |
| --- | --- | --- | --- |
| doctor01 | 陈志远 主任医师（全科） | DOCTOR | 接诊、病历全文、诊断、处方、检查 |
| nurse01 | 分诊护士 | NURSE | 签到、叫号、患者建档、病历全文 |
| nurse10 | 苏玉兰（公卫） | PUBLIC_HEALTH | 传染病上报、慢病随访、报表 |
| admin03 | 潘丽君 主管药师 | PHARMACIST | 审方、发药、药品入库 |
| admin04 | 苏晓红 收费员 | CASHIER | 挂号、收费、退费、作废 |
| tech01 | 何建平 检验技师 | TECHNICIAN | 采样、录入报告 |
| admin01 | 马建华 院长 | DIRECTOR | 全院只读（含跨医生病历）+ 报表 + 退费 |
| admin06 | 吴敏 信息科 | ADMIN | 人员、排班、审计、合规自检、对接密钥（不含 clinical.read） |

### 演示彩蛋角色（2026-11-22）

| 身份 | 人员 | 账号／标识 | 入口 |
| --- | --- | --- | --- |
| 医生 | 林建平 主任医师 · 消化内科（XH） | HIS 工号 `D009`，账号 `13900139001` | HIS 管理端；小程序医生端 `dev-doctor-doc-gastro-1` |
| 医生 | 马义童 主治医师 · 急诊科（JZ） | HIS 工号 `D010`，账号 `13900139000` | HIS 管理端；小程序医生端 `dev-doctor-doc-emergency-1` |
| 患者 | 陈楷楠 女 · 20 岁 · 广州市天河区 · 在校大学生 | 档案 `P000099`，手机 `138****8000` | 小程序患者端 `dev-user-1-manual-13800138000` |

- 口令不写死在种子里：`data\rotated_credentials_*.txt` 是最近一次轮换结果；HIS 全部账号首登强制改密。
- clinic-his **没有患者登录**：患者只有 MRN + 姓名 + 手机掩码，`13800138000` 只作为档案手机号（掩码 `138****8000`），患者身份在小程序侧走平台 dev 登录码。
- 急诊科 `dep-emergency` 在小程序侧是 `INACTIVE`：急诊绿色通道不参与门诊预约，因此马义童在**医生端可见、可接诊**，但患者端挂号目录里不会出现急诊科（要放开需业务确认后单独改状态）。
- 两条主数据（XH/D009、JZ/D010、陈楷楠）都已并入 `app/seed.py` 并对存量库幂等补齐，重建演示库不会再丢。

### 管理端菜单结构（`app/web/app.js` 的 `VIEWS`）

左侧导航按 4 个分组折叠，菜单可见性由登录账号的权限位决定（无权限的菜单不渲染）：

| 分组 | 菜单 | key | 所需权限 |
| --- | --- | --- | --- |
| 门诊业务 | 工作台 | `dashboard` | 无（登录即可） |
| 门诊业务 | 挂号登记 | `registration` | `reg.read` |
| 门诊业务 | 分诊叫号 | `queue` | `queue.read` |
| 门诊业务 | 医生工作站 | `doctor` | `visit.write` |
| 门诊业务 | 收费管理 | `charge` | `charge.read` |
| 住院留观 | 留观床位 | `beds` | `bed.read` |
| 住院留观 | 护理执行 | `nursing` | `nursing.read` |
| 药事管理 | 处方审方 | `pharmacy` | `rx.read` |
| 药事管理 | 药品库存 | `drugs` | `drug.read` |
| 医技与公卫 | 患者档案 | `patients` | `patient.read` |
| 医技与公卫 | 医技检查 | `lab` | `lab.read` |
| 医技与公卫 | 公共卫生 | `ph` | `ph.read` |
| 运营与系统 | 统计报表 | `reports` | `report.view` |
| 运营与系统 | 人员与排班 | `staff` | `staff.read` |
| 运营与系统 | 系统管理 | `system` | `audit.view` |

导航折叠状态记在 `localStorage`：`clinic.nav.collapsed`（分组收起）、`clinic.nav.hidden`（整栏隐藏）。

---

## 三、快速开始

**一键启动（Windows）**：双击 `start.bat`，自动检查 Python、启动服务并打开浏览器。

- 端口已在运行：直接打开浏览器，不会重复起进程；
- 端口被其他程序占用：提示改用 `set CLINIC_PORT=8311`；
- 首次启动会把打印签名密钥固定到 `data\.doc_secret`，重启后旧打印链接仍有效；
- `start.bat` / `scripts\run.ps1` 会把患者哈希盐固定到 `data\.patient_hash_salt`（已 gitignore）；生产不走该文件，必须由密钥管理注入 `CLINIC_PATIENT_HASH_SALT`。

其它方式：

```powershell
# 在 clinic-his 目录
$env:CLINIC_PATIENT_HASH_SALT = '<32+ 字符随机盐>'   # 直接 python -m app.main 时必须显式注入
python -m app.main          # 或使用脚本：scripts\run.ps1
```

> **L7 患者哈希盐（fail-closed）**：`CLINIC_PATIENT_HASH_SALT` 缺失时服务拒绝启动（所有环境）。
> 迁移旧库不要直接换盐：新盐写入 `CLINIC_PATIENT_HASH_SALT`，旧盐放
> `CLINIC_PATIENT_HASH_SALT_LEGACY`，`patient_hash_matches()` 双读兼容旧 `id_hash` / `phone_hash`；
> 新写入一律用新盐。等旧行按原始证件/手机号完成重算后再移除 legacy 变量。
> 非生产临时排障可显式 `CLINIC_ALLOW_LEGACY_PATIENT_HASH_SALT=true` 使用内置 v1 兼容盐，会打印高危警告；
> 生产设置该开关也不会生效。

打开 <http://127.0.0.1:8310>，用上表账号登录。首次启动会自动：

1. 建库建表（20+ 张表）并写入科室/人员/药品/ICD/检查/患者/号源；
2. 生成对外接口密钥，写入 `data/openapi-credentials.txt`（仅本机，勿提交）。

端到端验证（自动拉起隔离临时数据目录的服务，99 项断言，覆盖全部业务、病历增强、留观护理、工作台/患者全视图/合理用药/质控、病历可见范围、过敏硬阻断、账号恢复、退费闭环、对外接口与危急值闭环）：

```powershell
python scripts/smoke_test.py
```

在线备份（服务运行中可执行，自动校验完整性并清理旧备份）：

```powershell
python scripts/backup.py --keep 30
```

---

## 四、业务闭环

```
挂号登记 → 收费处缴挂号费 → 分诊签到取号 → 护士叫号
   → 医生接诊（病历 / ICD-10 诊断 / 处方 / 检查申请）→ 完成就诊
   → 药师审方 → 收费处缴药费与检查费 → 药房发药
   → 医技采样与出报告 → 公卫任务（传染病 24h 上报 / 慢病 7d 随访）
```

关键业务规则（服务端强制）：

- 号源原子扣减（`UPDATE ... WHERE booked < capacity`），满号/停诊不可挂；
- 未缴挂号费不得签到；未缴药费不得发药；未审方不得发药；
- 处方药品命中患者过敏标签 → 400 `ALLERGY_CONFLICT`，整单拒绝（不落库、不扣库存），前端不提供「仍要提交」；
- 管制药品普通门诊直接拦截；限制级抗菌药需主治及以上；特殊级拦截；
- 退费（`POST /charges/{id}/refund`）仅限已收费账单，须填原因（≥4 字）：挂号费退费联动取消挂号并回号源，药费退费已发药则药品回库、处方置 `REFUNDED`，检查费已出报告不可退；取消已缴费挂号自动按同一逻辑退款；
- 病历完成后不可修改，只能「更正」并留痕（`emr_amendments`）；
- 传染病诊断自动生成 24 小时上报任务，慢病自动生成 7 天随访任务；
- 发药原子扣库存，库存低于预警线在工作台高亮；
- 留观：开立留观占用床位，转床 / 出区 / 保洁构成床位状态机（FREE → OCCUPIED → CLEANING → FREE），护士执行医嘱并记录生命体征；
- 就诊完成前必须通过质控 HIGH 项（主诉、诊断、开方须有诊断），否则 400 `EMR_INCOMPLETE` 并列出缺项；就诊未完成时药师审方/发药被拒（400 `VISIT_NOT_FINISHED`）；
- 危急值：检查项目可配 `critical_low/critical_high`，报告录入数值超阈值 → `critical=1`，写审计并触发工作台「危急值报告 N 项」告警（医生/护士/医技/管理可见）；医生站顶部红条提示，辅助检查区可「引用结论」把报告结论回写病历（`auxiliaryExam`）。

### 4.1 功能视图与可见范围

| 视图 | 入口权限 | 可见角色（要点） |
| --- | --- | --- |
| 工作台 | 登录即可 | 全部角色；按岗位展示待办卡片（待接诊 / 待审方 / 待收费…）与异常报告、库存告警 |
| 挂号登记 / 分诊叫号 | reg.read / queue.read | 收费、护士、医生、管理岗 |
| 医生工作站 | visit.write | 医生（admin06 超级管理员） |
| 留观床位 | bed.read | 医生、护士、院长、医务科、admin06；开立/转床/出区/保洁需 bed.write（医生、护士） |
| 护理执行 | nursing.read | 医生、护士、院长、医务科、admin06；执行医嘱与记录体征需 nursing.write（仅护士），取消医嘱需 bed.write |
| 处方审方 / 药品库存 / 收费管理 | rx.read / drug.read / charge.read | 药师、收费、管理岗 |
| 患者档案 / 医技检查 / 公共卫生 | patient.read / lab.read / ph.read | 相应岗位 + 管理岗 |
| 统计报表 / 人员与排班 / 系统管理 | report.view / staff.read / audit.view | 院长、医务科、admin06 |

病历可见范围（`clinical.read` / `patient.read.all`）：

- 医生、护士具备 `clinical.read`；院长、医务科另有 `patient.read.all`（跨医生读取）；
- 收费、技师、药师、公卫与信息科管理员不具备 `clinical.read`：患者详情姓名脱敏且无住址，就诊历史仅给概要（无主诉/现病史/处理意见/处方明细），全视图中报告仅给有无异常与日期；
- 医生无 `patient.read.all` 时只能读本人接诊患者的 EMR 文本，读他人病历返回 403 `FORBIDDEN`。

布局说明：改为顶部导航（2026-11-21）——页面纵向排列，顶部固定一条深色头部：第一行「品牌 + 当前位置面包屑 + 全局患者搜索 / 角色 / 修改口令 / 退出 / 收起导航」，
第二行为导航条：按 5 个业务域分组，宽屏（≥1280px）显示分组标题做分隔、链接为方形块，窄屏隐藏分组标题、链接收成胶囊并自动换行（约 2 行）；
原来左侧栏的分组折叠记忆在窄屏下忽略，避免整组菜单被折叠后无法展开。页面内指标卡在 ≤860px 改为两列、末张通栏，避免 3+2 留洞。

信息架构（2026-11-21 密度治理）：处方审方与公卫任务改为「列表只留关键字段 + 点行开右侧抽屉处理」的二级结构。
审方抽屉给患者过敏/慢病标签、处方明细（规格、用法用量、天数）、常用审方意见与通过/驳回/发药；公卫抽屉按
传染病 / 慢病分别给结构化表单（报卡类别、发病日期、症状、网络直报；随访方式、血压、血糖、依从性、下次随访），
提交时序列化为任务处理记录（`note`，≤500 字）。药品库存从药房页拆出为独立视图「药事管理 / 药品库存」。

第二轮密度治理（同日）：工作台指标卡 8→6（库存预警/今日完成/就诊中改单行常注），使用提示收进折叠面板，
待办卡改为单行胶囊；医生工作站左栏「待接诊 / 今日就诊」合并为一个面板内分段切换，检查报告与
「留观 / 单据 / 质控」收进折叠面板；挂号登记表单改三步卡片（就诊日期+患者 → 科室+号源 → 提交），
挂号记录表 9 列压到 6 列；EMR 文本框修成通栏宽度；窗口 ≤980px 时侧栏改为顶部胶囊式横向导航（约 2 行高）。

第三轮密度治理（同日）：收费管理改「状态分段 + 类别 chips + 账单行（患者/账单号/类别/金额/状态）+ 行内收费 + 账单抽屉」
（作废/退费在抽屉内），默认 20 条 + 显示更多，保留勾选批量收费与已选合计；医技检查由 8 列表格改「进度分段 +
申请行（项目/申请号/危急值标记/结论摘要）+ 检查抽屉（所见、结论、采样/录入报告）」，默认 20 条 + 显示更多；
分诊叫号把「叫号时间 / 完成时间」合成一列（HH:MM / HH:MM），7 列压到 6 列；患者主索引把「性别 + 出生日期」
合成「性别 · 年龄」一列，7 列压到 5 列。

账号同步（2026-11-21）：小程序端医生账号 **13900139001（林建平 / 主任医师 / 消化内科）** 已同步为本院职工——
新增科室「消化内科（XH）」，职工工号 `D009`、账号 `13900139001`、初始口令与种子口令同源（`CLINIC_SEED_PASSWORD` 或首次启动一次性打印）、权限角色 `DOCTOR`，
并生成未来 7 日 × 上下午共 14 个号源（`SL{日期}D009AM|PM`）；`his_master_data_map` 增 `dep-gastro→XH`、
`doc-gastro-1→D009` 两条 CONFIRMED 映射，小程序预约经 `HttpHisClient.book()` 即落到该医生。
医生工作站底部新增折叠区「我的资料与近 7 日排班」（默认收起，展开后显示工号/科室/职称/账号与本人 7 日号源余量），
对应小程序医生端的「个人中心 + 排班」能力。

**2026-11-22 补记**：上述 `XH` 科室与 `D009` 职工已并入 `app/seed.py`（`DEPARTMENTS` / `STAFF` + 幂等的
`ensure_demo_master_data()`），重建演示库会自动带出科室、职工、登录账号与 14 个号源，不再依赖附录 A 的手工 SQL。

新增能力（对应调研文档门诊闭环缺口）：

| 能力 | 说明 | 接口 |
| --- | --- | --- |
| 统一患者视图 | 全局 `openPatient()` 抽屉：基本资料 / 过敏红条 / 慢病标签 / 今日就诊 / 历次就诊 / 处方 / 检查报告（异常高亮）/ 留观记录，支持打印病历 | `GET /api/v1/patients/{id}/overview` |
| 角色工作台 | 按岗位返回待办与告警，点击直达对应视图，下方保留运营概览 | `GET /api/v1/workbench` |
| 合理用药提示 | 处方提交前校验：过敏冲突 HIGH / 同单重复 MEDIUM / 管制药品、抗菌分级 INFO | `POST /api/v1/rx-check` |
| 病历质控 | 主诉/现病史/体格检查/诊断/处理意见/开方须有诊断，返回缺项与完整率 | `GET /api/v1/visits/{id}/qc` |
| 危急值与报告回写 | 报告数值超阈值标记危急值，工作台告警 + 医生站红条，报告结论可引用回写辅助检查 | `GET /api/v1/visits/{id}/reports` |

---

## 五、目录结构

```
clinic-his/
├─ start.bat               一键启动（检查 Python → 起服务 → 打开浏览器）
├─ app/
│  ├─ main.py              HTTP 服务、路由、CSP/安全响应头、统一响应包
│  ├─ db.py                SQLite 连接、事务、表结构、编号序列
│  ├─ security.py          PBKDF2 口令、会话、RBAC、脱敏、审计哈希链、HMAC
│  ├─ seed.py              演示数据与对外接口密钥初始化
│  ├─ errors.py            统一 ApiError
│  ├─ api/                 auth / basic / registration / clinical / pharmacy /
│  │                       charge / lab / ph / admin / openapi
│  └─ web/                 管理端单页（index.html + style.css + app.js）
├─ scripts/
│  ├─ run.ps1              启动
│  ├─ smoke_test.py        端到端回归（63 项）
│  └─ backup.py            在线备份
├─ docs/
│  ├─ 01-设计方案.md        架构 / 模块 / 权限矩阵 / 状态机 / 数据模型
│  ├─ 02-接口契约.md        内部接口 + 对外接口 + 签名 + 错误码
│  └─ 03-合规对照表.md      法规条款 → 系统落地 → 验证方法
├─ data/                   运行期数据库与接口密钥（勿提交）
└─ backups/                备份产物（勿提交）
```

---

## 六、对外接口（模拟 HIS 受理）

与主项目 `HisClient` 语义一一对应：**只受理、可撤销，不假装查号源**。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/openapi/v1/ping` | 健康检查（免签名） |
| GET | `/openapi/v1/departments` | 科室字典 |
| GET | `/openapi/v1/doctors?departmentId=` | 医师列表 |
| POST | `/openapi/v1/appointments` | 受理预约，返回 `CLN{yyyyMMdd}-{seq}` 单号 |
| GET | `/openapi/v1/appointments/{hisOrderNo}` | 查询受理单 |
| POST | `/openapi/v1/appointments/{hisOrderNo}/cancel` | 撤销受理（幂等） |

签名串（与实现一致）：

```
HMAC-SHA256(secret,
  METHOD + "\n" + PATH + "\n" + appId + "\n" + timestamp + "\n" + nonce + "\n" + sha256hex(body))
```

- 请求头：`X-App-Id`、`X-Timestamp`（±300s）、`X-Nonce`（8~64 字符，10 分钟内不可复用）、`X-Signature`；
- 写接口必带 `Idempotency-Key`（8~128 字符），重放返回首次结果（`replayed=true`）；
- 撤销幂等：单号不存在/已撤销均返回 `CANCELLED`（`idempotent=true`）；
- 错误码：`INVALID_APP_ID` / `INVALID_TIMESTAMP` / `INVALID_SIGNATURE` / `REPLAY_DETECTED` /
  `MISSING_IDEMPOTENCY_KEY` / `VALIDATION_FAILED` / `NOT_FOUND`；失败绝不返回单号。

调用示例（Python 标准库）：

```python
import hashlib, hmac, json, secrets, time, urllib.request

app_id, secret = "wechar-mini", open("data/openapi-credentials.txt").read().split("=")[-1].strip()
path, body = "/openapi/v1/appointments", json.dumps({
    "appointmentId": "A20261119001", "slotId": "S001", "patientName": "张三",
    "doctorId": "D001", "departmentId": "QK"}, ensure_ascii=False).encode()
ts, nonce = str(int(time.time())), secrets.token_hex(8)
msg = "\n".join(["POST", path, app_id, ts, nonce, hashlib.sha256(body).hexdigest()])
sig = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
req = urllib.request.Request("http://127.0.0.1:8310" + path, data=body, method="POST", headers={
    "Content-Type": "application/json", "X-App-Id": app_id, "X-Timestamp": ts,
    "X-Nonce": nonce, "X-Signature": sig, "Idempotency-Key": "demo-key-0001"})
print(urllib.request.urlopen(req).read().decode())
```

---

## 七、安全与合规落地（摘要）

- **身份与会话**：PBKDF2-SHA256（120000 次）；Token 仅存哈希；8 小时绝对超时 + 30 分钟空闲超时；
  连续 5 次失败锁定 15 分钟；IP 级登录限速；改密后吊销其余会话。
- **授权**：9 类角色 RBAC，服务端逐接口校验，前端仅做菜单显隐。
- **审计**：所有登录、查看病历、开方、审方、收费、发药、接口受理/撤销写审计表；
  `prev_hash → entry_hash` SHA-256 哈希链，可在「系统管理」一键校验，篡改可定位断点。
- **去标识化**：不存明文身份证/手机号，仅存后 4 位 + 加盐哈希；队列/列表姓名掩码；对外接口不接收主诉。
- **传输与浏览器侧**：CSP `default-src 'self'`、禁止内联脚本；`X-Content-Type-Options`、
  `X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`；请求体上限 1MB。
- **可用性**：SQLite WAL；在线备份脚本；健康检查；统一错误响应不泄露堆栈。
- **合规自检**：`GET /api/v1/system/compliance` 返回 8 项控制点检查结果（哈希链、口令策略、会话、
  证件明文、接口密钥、备份、零依赖、病历完整性）。

---

## 八、与主项目的关系

- 主项目 V1.20 默认启用 `HisGateway` 的 mock 适配器；本系统作为「HIS 侧参照实现」，
  用于联调 `book / cancel` 的真实 HTTP 语义（成功单号、幂等、撤销、失败不落单）。
- 对接方式（已内置 `HttpHisClient`，无需改代码）：主项目侧设三个环境变量后以 http 档启动即可
  ——`APP_HIS_ENABLED=true`、`APP_HIS_MODE=http`、`APP_HIS_HTTP_APP_SECRET=<data/openapi-credentials.txt 里的 appSecret>`；
  其余（`APP_HIS_HTTP_BASE_URL` 默认 `http://127.0.0.1:8310`、appId 默认 `wechar-mini`）通常无需改。
  平台侧预约单号作为 `appointmentId` 传入，重试自动复用同一 `Idempotency-Key`。
- 主数据不同源：主项目科室/医生为 `dep-*` / `doc-*`，本系统为 `QK` / `D001`；诊所返回 NOT_FOUND 时
  适配器按 `APP_HIS_HTTP_FALLBACK_DOCTOR_ID` / `..._DEPARTMENT_ID`（默认 `D001` / `QK`）重试一次并留日志。
- `APP_HIS_HTTP_DEMO` 默认 `true`：回执来源为 `HIS_MOCK`、页面显示「演示预约」，不冒充实院受理；
  只有接真实院方并完成评审后才置 `false`（走 `HIS_LIVE`）。
- 主项目侧契约测试：`HttpHisClientTest`（签名逐字符对齐、映射重试、院方报错抛异常不伪造成功）。
- 本系统不替代医院真实 HIS，不包含医保结算、LIS/PACS 接口、电子签名 CA 等生产能力。

---

## 九、管理端体验与数据一致性整改（2026-11-22）

联调中发现并修复的四个缺陷，口径如下（后续改动请勿回退）：

| # | 缺陷 | 处置 | 关键代码 |
| --- | --- | --- | --- |
| 1 | 患者搜索输入关键词无候选、↑↓ 选不中 | 远程检索结果不再用「脱敏名（陈**）」二次打分；顶栏/患者列表/挂号页均可 ↑↓ 选择并回车采纳，Esc 关闭，无结果给出换词提示 | `app/web/autocomplete.js`（remote 分支）、`app/web/app.js` 的 `setupGlobalSearch()` / `#pt-q` 挂载 |
| 2 | 小程序挂号后 HIS 剩余号源不变、两边号源数字不同 | 受理时按「本院医生 + 就诊日期 + 午别（AM/PM）」匹配院内 `doctor_slots` 占号并回填 `slot_id`，撤销时释放；HIS 内部挂号/取消原本就会增减 `booked` | `app/api/openapi.py` 的 `_match_slot()` / `_ensure_registration()` / `_cancel_registration()` |
| 3 | 取号恒为 001 | 改「按就诊日全局流水」发号（跨科室共用），同日依次 001/002/003…；柜面签到补号同口径 | `app/api/openapi.py`、`app/api/registration.py`（`queue-day-<日期>`） |
| 4 | 可连续高强度挂号/取消 | 进程内滑动窗口限流：操作人 60s 内最多 8 单挂号、10 分钟内同一患者最多 3 单；取消为操作人 5 分钟 5 次、同一患者 10 分钟 3 次，超限返回 `429 RATE_LIMITED` 并带 `retryAfterSec` | `app/api/registration.py` 的 `_limit()` |

补充说明：

- 号源「显示数字不同」的另一层原因是**两边粒度不同**：HIS 是半日档（capacity 15/20），
  平台是 30 分钟档（capacity 5）。本次只保证「受理即占号、撤销即回补」，未强行统一粒度；
  若要求患者端直接展示 HIS 余量，需新增 HIS 号源查询接口并由平台改为读 HIS（属架构变更，另行评审）。
- 取号口径为「同一就诊日内连续」，跨日重新从 001 起；如需跨日全局递增，把序列键改为
  `queue-global` 即可（会影响叫号大屏按日筛选习惯，需产品确认）。
- 急诊彩蛋：`JZ 急诊科` / `D010 马义童`（HIS 账号 `13900139000`）、患者 `P000099 陈楷楠`；
  平台侧对应 `dep-emergency`（已 ACTIVE）与 `doc-emergency-1`，每日 08:00-20:00 放号，capacity=5。

---

## 十、声明

本系统为演示与接口验证用途：数据全部虚构，界面与报表不构成任何医疗建议；
不得录入真实患者信息，不得直接用于临床诊疗或对外提供医疗服务。
