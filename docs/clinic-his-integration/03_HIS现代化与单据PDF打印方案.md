# HIS 现代化与单据 PDF 打印方案

> 目标：把“能用但难用”的 clinic-his 管理端升级为医生可高频使用的临床工作台；把病历、检查单、缴费单、取药单做成可预览、可打印、可归档的 A4 单据。
> 本文同时给出已落地的后端实现与前端接入方案。

---

## 1. 当前 HIS 的问题（医生视角）

| 问题 | 表现 | 影响 |
| --- | --- | --- |
| 信息密度高、层级弱 | 表格 + 表单平铺，患者上下文分散 | 医生找不到“过敏/慢病/上次就诊” |
| 工作流割裂 | 挂号、队列、病历、处方、收费、药房各自一页 | 接诊要来回跳转 |
| 缺少快捷操作 | 无键盘快捷键、无模板、无常用药 | 单次接诊时间长 |
| 状态语义弱 | 只有小徽标，缺乏颜色/优先级 | 待审、待收费、异常报告不醒目 |
| 打印缺失 | 病历/处方/检查/收费无正式单据 | 患者拿不到纸质凭证，诊所无法留档 |
| 适老化不足 | 字号小、对比度低、点击目标小 | 中老年医生/护士费力 |

---

## 2. 现代化设计目标

### 2.1 设计原则

1. **患者为中心**：任何页面都能看到当前患者的过敏、慢病、最近就诊、当前用药。
2. **一次接诊一条线**：队列 → 接诊 → 病历 → 诊断 → 处方/检查 → 完成 → 打印，不跳页。
3. **状态可扫读**：颜色 + 文字 + 图标三重编码；异常/待办优先。
4. **键盘优先**：常用动作有快捷键；医生可不用鼠标完成一次开方。
5. **打印即交付**：任何单据 1 次点击预览、1 次点击打印/PDF。
6. **适老化**：正文 ≥14px，关键按钮 ≥44px，高对比，支持 125%/150% 缩放。

### 2.2 设计令牌（建议）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--brand` | `#0B6EF8` | 主蓝（与主项目医疗蓝一致） |
| `--brand-dark` | `#084FB3` | 按下/深色 |
| `--bg` | `#F4F7FB` | 页面底色 |
| `--panel` | `#FFFFFF` | 卡片 |
| `--ink` | `#1B2A3A` | 主文字 |
| `--muted` | `#6B7C8F` | 次要文字 |
| `--line` | `#E3EAF2` | 分割线 |
| `--ok` | `#1E8449` | 完成/正常 |
| `--warn` | `#B26A00` | 待办/预警 |
| `--danger` | `#C0392B` | 异常/驳回 |
| `--radius` | `12px` | 卡片圆角 |
| `--shadow` | `0 2px 8px rgba(16,34,46,.06)` | 卡片阴影 |

### 2.3 信息架构（目标）

```
工作台（今日）
├─ 待接诊队列（按科室/医生）
├─ 待审处方 / 待收费 / 异常报告
├─ 今日完成 / 收入 / 库存预警
├─ 快捷入口：接诊、开方、打印
医生工作站
├─ 左：患者摘要（过敏/慢病/最近就诊/当前用药）
├─ 中：病历编辑器（主诉/现病史/既往史/查体/诊断/处理）
├─ 右：医嘱面板（处方/检查/打印）
└─ 底：时间线（挂号→接诊→开方→收费→发药→报告）
打印中心
├─ 单据包预览（病历+处方+检查+缴费+取药）
├─ 单张打印 / 批量打印 / 下载 PDF
└─ 打印记录（谁、何时、哪张单）
```

---

## 3. 页面改造清单

| 页面 | 改造 | 优先级 |
| --- | --- | --- |
| 登录 | 品牌区 + 演示账号分组；记住上次账号；错误文案统一 | P0 |
| 工作台 | 从“指标卡”改为“待办优先”：待接诊/待审/待收费/异常报告 | P0 |
| 医生工作站 | 三栏布局；患者摘要固定；病历编辑器支持模板/自动保存 | P0 |
| 处方 | 药品搜索、常用药、库存/抗菌分级提示、合计实时 | P0 |
| 检查 | 项目多选、价格合计、报告状态 | P1 |
| 收费 | 批量收费、票据打印、作废留痕 | P1 |
| 药房 | 待审/待发药分栏、扫码发药（预留） | P1 |
| 打印中心 | 单据包预览、打印记录 | P0 |
| 系统管理 | 审计链校验、合规检查、密钥轮换 | P1 |

### 3.1 医生工作站布局（CSS 级）

```
.workspace {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr) 340px;
  gap: 16px;
}
@media (max-width: 1280px) {
  .workspace { grid-template-columns: 260px minmax(0, 1fr); }
  .orders-panel { grid-column: 1 / -1; }
}
```

- 左栏 `patient-summary`：过敏红色条、慢病标签、最近 3 次就诊、当前用药。
- 中栏 `emr-editor`：分段折叠；自动保存草稿（localStorage）；版本冲突提示。
- 右栏 `orders-panel`：Tabs（处方/检查/打印）；底部合计与提交。
- 顶部 `patient-bar`：姓名、性别、年龄、MRN、队列号、状态、计时。

### 3.2 适老化

- 正文 14px，表格 13px；关键按钮 44×44px。
- 对比度 ≥ 4.5:1；状态不只靠颜色，必须有文字。
- 支持 `Ctrl + 滚轮` 缩放；不强制小屏横向滚动。
- 表单标签在输入框上方，避免 placeholder 代替标签。

---

## 4. 单据 PDF 已落地实现

### 4.1 能力清单

| 单据 | 路由 kind | 内容 | 权限 |
| --- | --- | --- | --- |
| 门诊病历 | `visit` | 患者信息、生命体征、主诉/现病史/既往史/查体、诊断、处理意见、处方/检查摘要、更正留痕、医师签名 | `visit.read` + 医生归属/护士/管理 |
| 就诊单据包 | `packet` | 病历 + 每张处方/取药单 + 每张检查单 + 每张缴费单，分页 | `visit.read`；子单据按权限裁剪 |
| 处方/取药单 | `prescription` | 处方号、患者、医师、药品明细、合计、审方/发药 | `rx.read` + 医生归属 |
| 缴费单 | `charge` | 账单号、患者、类别、项目、金额、收费员、时间 | `charge.read` 或本人接诊医生 |
| 检查申请/报告单 | `lab` | 申请号、患者、医师、项目、价格、所见、结论、异常、报告人 | `lab.read` + 医生归属 |

### 4.2 API

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/documents/{kind}/{id}` | Bearer | HTML 预览（含打印按钮） |
| `GET` | `/api/v1/documents/{kind}/{id}/pdf` | Bearer | 直接下载/内联 PDF |
| `POST` | `/api/v1/documents/{kind}/{id}/grant` | Bearer | 返回 10 分钟签名链接 `{htmlUrl,pdfUrl,expiresIn}` |
| `GET` | `/api/v1/documents/render?t=...&format=html\|pdf` | 签名 | 浏览器/小程序可直接打开，无需 Bearer |

**签名链接**：`base64url(payload).hmac_sha256(secret, payload)`；payload 含 `kind/id/user_id/exp`；默认 600s，可用 `CLINIC_DOC_TOKEN_TTL` 调整；过期返回 `410 DOC_LINK_EXPIRED`。

### 4.3 PDF 生成

- 本机 Edge/Chrome 无头模式：
  ```
  msedge.exe --headless=new --disable-gpu --no-pdf-header-footer \
    --allow-file-access-from-files --virtual-time-budget=3000 \
    --print-to-pdf=out.pdf file:///.../doc.html
  ```
- 生成前把 `print.css` 内联进 HTML，移除打印按钮脚本；避免 CSP 与外链问题。
- 缓存：`clinic-his/data/print-cache/{sha256}.pdf`，7 天清理；相同内容秒开。
- 找不到浏览器：返回 `503 PDF_ENGINE_UNAVAILABLE`，提示用浏览器打印，绝不返回假 PDF。
- 环境变量：
  - `CLINIC_PDF_BROWSER`：自定义浏览器路径；
  - `CLINIC_DOC_SECRET`：签名密钥（生产必须设置，重启不失效）；
  - `CLINIC_DOC_TOKEN_TTL`：链接时效（秒）。

### 4.4 打印版式

- A4，页边距 14/12/16mm；正文 11.5pt，表格 9.5pt。
- 页眉：诊所名 + “Clinic HIS · 门诊单据”；页脚：单据号 + 打印时间。
- 水印：`演示系统 · 非正式医疗文书`，倾斜 28°，透明度 10%。
- 签名区：医师/收费员/报告人 + 日期。
- 分页：单据包每张单 `page-break-before: always`。

### 4.5 安全与合规

| 控制 | 实现 |
| --- | --- |
| 访问控制 | Bearer + 短期签名；链接绑定用户/单据/过期 |
| 对象归属 | 医生只能打印本人接诊病历/处方/检查；账单仅本人患者或收费角色 |
| 审计 | 每次打印写 `DOC_PRINT`（用户、单据、格式、IP） |
| 缓存 | `Cache-Control: no-store`；PDF 缓存 7 天；生产建议加密卷 |
| 水印 | 每页演示水印；生产替换为机构水印/二维码验真 |
| 数据最小化 | 单据不展示身份证号；电话仅掩码；地址仅病历需要时展示 |
| 链接泄露 | 10 分钟有效；生产建议 3~5 分钟 + 一次性 nonce + IP 绑定 |

### 4.6 已验证结果

在 `clinic.db` 副本上启动 8311 实例，实测：

| 用例 | 结果 |
| --- | --- |
| `GET /documents/visit/4` | 200 `text/html`，含“门诊病历” |
| `POST /documents/visit/4/grant` | 200，返回 htmlUrl/pdfUrl |
| 签名 htmlUrl 无 Authorization | 200 |
| `GET /documents/visit/4/pdf` | 200 `application/pdf`，88KB |
| `GET /documents/packet/4/pdf` | 200，88KB |
| `GET /documents/prescription/3/pdf` | 200，108KB |
| `GET /documents/lab/3/pdf` | 200，91KB |
| `GET /documents/charge/10/pdf` | 200，84KB |
| 医生 B 打印医生 A 病历 | 403 |
| 护士打印处方 | 403 |
| 药师读患者 visits/reports | 403 |

中文渲染已用 Chrome 无头模式验证，A4 页面可直接打印/另存为 PDF。

### 4.7 前端接入（HIS 管理端）

在 `app.js` 增加统一入口：

```js
async function openDoc(kind, id, fmt = 'html') {
  try {
    const data = await api('POST', `/api/v1/documents/${kind}/${id}/grant`, {});
    const url = fmt === 'pdf' ? data.pdfUrl : data.htmlUrl;
    const win = window.open(url, '_blank');
    if (!win) toast('浏览器拦截了新窗口，请允许弹窗', 'error');
  } catch (err) {
    toast(err.message, 'error');
  }
}
```

按钮位置：

- 医生工作站“病历操作”区：`打印病历`、`打印单据包`。
- 药房处方行：`打印取药单`。
- 收费行：`打印缴费单`。
- 医技行：`打印检查单`。
- 事件委托：`data-doc="visit|packet|prescription|charge|lab"`、`data-id`、`data-fmt="html|pdf"`。

```js
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-doc]');
  if (!btn) return;
  openDoc(btn.dataset.doc, btn.dataset.id, btn.dataset.fmt || 'html');
});
```

### 4.8 生产部署注意

- Windows：安装 Edge/Chrome；建议专用服务账号运行，限制 `print-cache` 权限。
- Linux：安装 `chromium` 或 `google-chrome`；设置 `CLINIC_PDF_BROWSER=/usr/bin/chromium`；容器需 `--no-sandbox`（仅容器内）。
- 并发：PDF 生成是 CPU/内存密集型；当前用全局锁串行化，单机演示足够；生产建议独立“打印服务”队列 + 限流。
- 字体：服务器需安装中文字体（`Noto Sans CJK SC` 或 `Microsoft YaHei`），否则中文可能方框。
- 归档：PDF 生成后可按 `visit_no` 归档到对象存储；数据库只存 URL/哈希，不存二进制。

---

## 5. 现代化分阶段实施

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0（1 周） | 设计令牌、登录页、工作台待办、医生工作站三栏、打印中心 | 医生一次接诊 ≤ 8 分钟；打印 ≤ 3 次点击 |
| P1（1~2 周） | 处方搜索/常用药、检查多选、收费票据、药房分栏 | 开方 ≤ 2 分钟；收费 ≤ 30 秒/人 |
| P2（2~3 周） | 模板/ICD 搜索、键盘快捷键、自动保存、异常提醒 | 常用动作可全键盘；冲突可恢复 |
| P3（可选） | 病区看板、运营报表、移动端护士站 | 护士审批 ≤ 2 次点击；报表 T+1 |

### 5.1 验收指标

- 医生完成一次接诊（病历+诊断+处方+打印）≤ 8 分钟（当前基线需实测）。
- 打印/PDF 成功率 ≥ 99%；生成时间 P95 ≤ 3s（缓存命中 ≤ 200ms）。
- 关键页面在 1366×768 与 1920×1080 无横向滚动。
- 适老化：正文 ≥14px，按钮 ≥44px，对比度 ≥4.5:1。
- 安全：所有单据访问有审计；越权 403/404；无 PHI 出现在 URL/日志。

---

## 6. 结论

- **HIS 现代化先从“工作台 + 医生工作站 + 打印中心”三处下手**，不要先换皮。
- **单据 PDF 已落地并验证**：5 类单据、A4 中文、短期签名、权限/审计/水印齐备。
- 下一步把前端按钮接入医生工作站/药房/收费/医技，并在主项目医生端小程序增加“单据打印”入口（经 business-service 代理签名链接）。
