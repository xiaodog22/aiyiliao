# GitHub 上传前检查清单

> 适用于本仓库当前状态（实测于 2026-11-05 18:5x，`main` @ `cde4ee1`）。
> 命令均可在仓库根目录直接执行（Windows Git Bash / PowerShell 均可）。

---

## 0. 当前仓库快照（实测）

| 项 | 值 |
|---|---|
| 当前分支 | `main` |
| HEAD | 本地领先 `origin/main` **6 个提交**（尚未推送；具体 hash 见 `git log --oneline -6`） |
| remote | `https://github.com/xiaodog22/aiyiliao.git`（公开仓库，GitHub Pages: `xiaodog22.github.io/aiyiliao`） |
| 提交历史 | 原 3 个 + 本轮 5 个（assets / report / fix / docs / test） |
| 已跟踪文件 | 975 |
| 工作区差异 | 0（clean） |
| `.git` 体积 | 4.6 MB |
| 已跟踪最大文件 | `site/index.html` 0.36 MB |
| 待推送变更 | 635 files changed（含本文），约 +66,400 / −786 |
| 许可证 | MIT（`Copyright (c) 2026 xiaodog22`） |

**本轮提交**（由旧到新）

```
chore(assets): 资源网络化与包体瘦身
feat(report): 电子检查报告体系（V27 + 报告接口 + 小程序两页）
fix: 联调链路修复与云托管配置
docs: 补齐文档体系与开源仓库配置
test(fe): 补附件上传与 AI 分诊用例，附图片压缩脚本与官网优化
docs: 上传检查清单更新为执行后状态
```

**结论**：仓库体积健康，无 GitHub 100 MB 单文件与 1 GB 仓库限制风险。
`backend.rar`(463 MB)、`docs/patches/workspace-full.patch`(17.9 MB)、`docs/验收与评估_*/assets`(32 MB)、
`.workbuddy/backup`(356 MB) 均为本地大件，已被 `.gitignore` 覆盖，不入库。

---

## 1. P0 · 敏感信息与合规（必须先决策）

### 1.1 dev 登录密钥明文在仓库里（已进入 Initial commit）

> **2026-11-05 已按方案 A 处置**：`env.js` 与 `env.local` 的 key 同时换成新随机值，
> 旧值视为「已公开的历史值」不再使用；未改写 Git 历史，未 force push。
> 复现核对：`git grep -n "wb-devlogin" HEAD` 只会命中轮换后的新值。

```bash
git grep -n "wb-devlogin" HEAD        # 命中 miniprogram/config/env.js 的 DEV_LOGIN_KEY
```

- 事实：`const DEV_LOGIN_KEY = 'wb-devlogin-…'` 是明文值，与 `backend/deploy/env.local` 中的 `APP_AUTH_DEV_LOGIN_KEY` 相同。
- 影响面：仅 dev profile。`DevWechatSessionProvider` 只在 `dev`/`itest` 装配，生产 profile 不装配该 provider，
  因此**不能**用它换到生产会话。但任何人拿到仓库都能在 dev 部署上绕过这道闸门。
- 三个选项与最终选择：

| 方案 | 动作 | 状态 |
|---|---|---|
| **A 只轮换** | 本地把 `env.js` 与 `env.local` 的 key 同时换成新随机值；旧值在历史中视为已公开的废弃值 | ✅ **已执行** |
| B 换成可配置 | `env.js` 默认空字符串（fail-closed），本地用时临时填、不提交 | 未采用（小程序不支持可选 `require`，仍可能误提交明文） |
| C 改写历史 | `git filter-repo` 删除该行历史 + `push --force` | 未采用（改写全部 commit hash，协作方需重克隆） |

### 1.2 已排除的敏感项（确认不会入库）

```bash
git check-ignore -v 软件著作权申请资料 软著旧V1.0材料备份_20260914 backend/deploy/env.local .trash artifacts output
```

应全部命中 `.gitignore`。软著材料含真实姓名/身份证号，**永远不要**取消忽略。

### 1.3 公开前的合规判断

- 项目定位须写清「技术演示，非医疗器械，不用于真实诊疗」——README 已含「已知限制」节，建议再加一句免责声明；
- 仓库内不得出现真实医院公章、医生签名、可扫码的官方报告二维码 —— 演示报告使用 `DEMO-*` 编号与「演示数据」水印；
- `LICENSE` 已是 MIT。医疗类项目用 MIT 意味着**完全免责**，若你希望保留「禁止临床使用」的额外约束，
  需改成自定义许可或 MIT + NOTICE（会失去 GitHub 的 License 识别徽章）。

---

## 2. P1 · 忽略规则与工作区清理

### 2.1 核对忽略是否生效

```bash
git status --porcelain | grep '^??' | wc -l          # 期望显著下降
git status --porcelain | grep '^??' | head -30       # 逐条确认剩下的都该入库
git status --ignored --porcelain | grep '^!!' | head -20   # 抽查被忽略项
```

新增忽略（本轮）：`.trash/`、`output/`、`artifacts/`、`prototype-web/`、`software-certificate-skill/`、
`project.private.config.json`、`docs/preview-qr*.png`、`docs/preview-info*.json`、
两个 0 字节误建文件、`_V16_from_jar.sql`、`work.txt`、4 份内部复盘文档。

### 2.2 206 个 `D` 的正确处置（**易踩坑**）→ 已执行

这 206 个删除全部是 `miniprogram/assets` 图标与 `packageContent` 封面的历史清理，工作区确实已删除，
当前代码是自洽的（`node tools/check-project.js` 图标引用全部有效，主包图片+音频 184.5KB）。

已随 `d444cba chore(assets): 资源网络化与包体瘦身` 一起提交（205 个 `D`，含 2 个 `.dsh-ops-update` 锁文件）。

> ⚠️ **绝对不要**用 `git checkout -- miniprogram/assets` 去「恢复」它们。
> 该目录历史上删过一批图标，checkout 会把已废弃图标全部恢复（曾导致主包 +370 KB 并裂图）。
> 需要核对时用 `git diff --stat --diff-filter=D HEAD~5` 看清单，不要动文件。

### 2.3 嵌套仓库

```bash
ls -d */software-certificate-skill/.git 2>/dev/null
```

`software-certificate-skill/.git` 是独立仓库，直接入库会变成无法解析的 submodule 引用。
已加入 `.gitignore`。若你确实想发布这份技能包，应单独建仓并在此处用 submodule 显式声明。

---

## 3. P1 · 文档完备性

| 文件 | 状态 | 说明 |
|---|---|---|
| `README.md` | ✅ 已有 | 15 章，含界面/功能/架构/目录/快速开始/适老化/已知限制/测试/许可 |
| `LICENSE` | ✅ 已有 | MIT |
| `CONTRIBUTING.md` | ✅ 本轮新增 | 环境、启动、9 条红线、迁移规则、验证命令、提交规范 |
| `SECURITY.md` | ✅ 本轮新增 | 报告渠道、安全机制清单、部署方义务、范围外事项 |
| `docs/INDEX.md` | ✅ 本轮新增 | 文档分层索引（设计/架构/数据库/测试/部署） |
| `.gitignore` | ✅ 已扩充 | 每条带理由注释 |
| `.gitattributes` | ✅ 本轮新增 | 统一 LF，二进制判定 |
| `AGENTS.md` | ✅ 已入库 | AI/协作入口：项目速览 + 目录地图 + 省 Token 操作规定 |
| `docs/GITHUB_UPLOAD_CHECKLIST.md` | ✅ 本轮新增 | 本文；上传前检查与推送记录 |

---

## 4. P1 · 可运行性门禁（提交前必跑）

```bash
node tools/check-project.js
node tools/test-fe.js
backend/business-service/mvnw -o test
backend/edge-gateway/.venv/Scripts/python.exe -m pytest backend/edge-gateway/tests -q
```

当前基线（2026-11-05 提交后实测）：`check-project` 全部通过（主包图片+音频 184.5KB、无 >100KB 单图）、
`test-fe` 14/14、`mvnw -o test` 319/319、`pytest` 132/132。
仓库**无 CI**，以上是唯一门禁来源，PR/提交说明里请贴实际输出。

---

## 5. P1 · Git 操作注意事项

| 项 | 说明 |
|---|---|
| `core.autocrlf` | 本机为 `true`；新增 `.gitattributes` 后以 `eol=lf` 为准。**不要**执行 `git add --renormalize .`，会炸出全仓 diff |
| 暂存策略 | 已按主题拆成 5 个提交：assets / report / fix / docs / test（见 §0）。后续改动继续保持一提交一主题 |
| 不要提交 | `.trash/`、`artifacts/`、`output/`、`env.local`、`project.private.config.json`、`backend.rar` |
| 不要改动 | `flyway_schema_history`、已应用的 `V1~V26`/`V9000~V9009` 迁移文件 |
| 提交信息 | `<type>: <简述>`，`type ∈ feat/fix/docs/refactor/test/chore/perf` |

---

## 6. 推送（本地已提交，待你执行）

### 6.1 当前状态

本地 `main` 已领先 `origin/main` **6 个提交**，工作区 `clean`。
**在本次整理所用的沙箱里 `git push` 不可用**：经本地代理报
`CONNECT tunnel failed, response 502`，绕开代理直连 `github.com:443` 超时
（同环境用 HTTP 抓取 GitHub 页面是通的，说明只是 git 出网被拦）。因此推送请在**你自己的终端**执行。

### 6.2 执行命令

```bash
cd D:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar
git log --oneline origin/main..HEAD      # 应看到 6 条
git status --short                       # 应为空
git push origin main
```

若本机也走了同一个代理，先确认 `git config --get http.proxy`；必要时临时绕开：

```bash
git -c http.proxy= -c https.proxy= push origin main
```

推失败排查顺序：① 凭据（`git-credential-manager` 是否已登录 GitHub）② 代理/网络
③ 远端保护分支规则 ④ 是否存在他人新提交（必要时 `git pull --rebase`）。

### 6.3 备选：重建干净仓库（**不需要**，仅当坚持清除历史里的旧 dev key）

```bash
# ⚠️ 不可逆：会删除全部本地历史，务必先整目录备份
mv .git ../wechar-git-backup-20261105
git init -b main
git add -A && git commit -m "chore: initial import (sanitized)"
git remote add origin https://github.com/xiaodog22/aiyiliao.git
git push --force origin main
```

本轮已按方案 A 轮换密钥，**不建议**再走这条路。

---

## 7. 推送后验证

- [ ] GitHub 仓库首页能正常渲染 `README.md`（图片、表格、代码块无裂图）
- [ ] 侧栏显示 `MIT license`
- [ ] 语言统计合理（JS/Java/Python/WXML 都有，不应被 PNG 淹没）
- [ ] `Settings → General → Danger Zone` 确认仓库可见性与预期一致（医疗演示项目建议先 **Private**，确认无敏感内容后再转 Public）
- [ ] 抽查 `backend/deploy/` 下**没有** `env.local`
- [ ] 抽查 `miniprogram/assets/icons/` 无裂图（删除的旧图标不应被任何 `icons.js` 键引用）
- [ ] 用无痕窗口 `git clone` 一次，按 `README` 的快速开始能否起得来（至少 `check-project` 能跑）

---

## 8. 剩余风险（如实列出）

| # | 风险 | 处置建议 |
|---|---|---|
| 1 | 旧 dev 登录密钥仍留在 Initial commit 的历史里（已被轮换、当前不可用） | 已按 §1.1 方案 A 处置；若要彻底清除需走 §6.3 重建 |
| 2 | 本轮 6 个提交尚未推送（沙箱 git 出网被拦） | 在本人终端执行 §6.2 |
| 3 | 仓库无 CI，门禁全靠本地 | 后续可加 `.github/workflows/verify.yml` 跑 4 条命令 |
| 4 | `docs/preview-qr*.png`、`docs/preview-info*.json` 含 appid | 已忽略，未入库 |
| 5 | 演示数据与真实机构同名风险 | 数据侧已用「（模拟）」后缀与 `DEMO-*` 编号；公开前再扫一遍 `backend/business-service/src/main/resources/db/dev/` |
| 6 | 首个 assets 提交单独检出时 `icons.js` 仍引用已删图标（该键表清理在 `52abb51`） | 只影响 `git bisect` 到中间点；整体推送后无影响 |
| 7 | `docs/` 只保留验收报告 `.md`，32 MB 截图未入库 | 需要复现时按报告内的文件名在本机 `docs/验收与评估_*/assets` 找 |
