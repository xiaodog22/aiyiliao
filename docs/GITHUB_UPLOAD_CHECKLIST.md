# GitHub 上传前检查清单

> 适用于本仓库当前状态（实测于 2026-11-05 18:5x，`main` @ `cde4ee1`）。
> 命令均可在仓库根目录直接执行（Windows Git Bash / PowerShell 均可）。

---

## 0. 当前仓库快照（实测）

| 项 | 值 |
|---|---|
| 当前分支 | `main` |
| HEAD | `cde4ee1`（与 `origin/main` 完全一致） |
| remote | `https://github.com/xiaodog22/aiyiliao.git` |
| 提交历史 | 3 个提交，**历史上未出现** `env.local` / 软著材料 / `*.rar` / 预览二维码 |
| 已跟踪文件 | 928 |
| 工作区差异 | `D` 206（`miniprogram/assets` 图标与封面历史清理）、`M` 181、`??` 157 |
| `.git` 体积 | 4.0 MB |
| 已跟踪最大文件 | `site/index.html` 0.35 MB |
| 许可证 | MIT（`Copyright (c) 2026 xiaodog22`） |

**结论**：仓库体积健康，无 GitHub 100 MB 单文件与 1 GB 仓库限制风险。
`backend.rar`(463 MB)、`.workbuddy/backup`(356 MB) 均为**未忽略但未跟踪**的本地大件，已被新一轮 `.gitignore` 覆盖。

---

## 1. P0 · 敏感信息与合规（必须先决策）

### 1.1 dev 登录密钥明文在仓库里（已进入 Initial commit）

```bash
git grep -n "wb-devlogin" HEAD        # 命中 miniprogram/config/env.js:83
```

- 事实：`const DEV_LOGIN_KEY = 'wb-devlogin-…'` 是明文真实值，与 `backend/deploy/env.local` 中的 `APP_AUTH_DEV_LOGIN_KEY` 相同。
- 影响面：仅 dev profile。`DevWechatSessionProvider` 只在 `dev`/`itest` 装配，生产 profile 不装配该 provider，
  因此**不能**用它换到生产会话。但任何人拿到仓库都能在 dev 部署上绕过这道闸门。
- 三个选项（**需你选择，我不擅自改**）：

| 方案 | 动作 | 代价 |
|---|---|---|
| A 只轮换（推荐） | 本地把 `env.js` 与 `env.local` 的 key 同时换成新随机值；旧值在历史中视为已公开的废弃值 | 需同步改两处，联调环境要重启 |
| B 换成可配置 | `env.js` 默认空字符串（fail-closed），本地用时临时填、不提交 | 小程序不支持可选 `require`，仍可能误提交明文 |
| C 改写历史 | `git filter-repo` 删除该行历史 + `push --force` | **改写所有 commit hash**，协作方需重新克隆，不可逆 |

> 建议 A。真正的边界在后端：`APP_AUTH_DEV_LOGIN_ENABLED` + 手机号白名单 + 生产不装配 dev provider。

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

### 2.2 206 个 `D` 的正确处置（**易踩坑**）

这 206 个删除全部是 `miniprogram/assets` 图标与 `packageContent` 封面的历史清理，工作区确实已删除，
当前代码是自洽的（`node tools/check-project.js` 图标引用 185 处全部有效）。

```bash
git add -A miniprogram        # 让删除进入暂存区，随下次提交一起提交
```

> ⚠️ **绝对不要**用 `git checkout -- miniprogram/assets` 去「恢复」它们。
> 该目录历史上删过一批图标，checkout 会把已废弃图标全部恢复（曾导致主包 +370 KB 并裂图）。
> 需要核对时用 `git diff --stat --diff-filter=D` 看清单，不要动文件。

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
| `AGENTS.md` | ⚠️ 未跟踪 | 建议入库（协作入口），已在文件清单中列为待提交 |

---

## 4. P1 · 可运行性门禁（提交前必跑）

```bash
node tools/check-project.js
node tools/test-fe.js
backend/business-service/mvnw -o test
backend/edge-gateway/.venv/Scripts/python.exe -m pytest backend/edge-gateway/tests -q
```

当前基线（2026-11-05 实测）：门禁六项全通过、前端 14/14、后端 319/319、网关 132/132。
仓库**无 CI**，以上是唯一门禁来源，PR/提交说明里请贴实际输出。

---

## 5. P1 · Git 操作注意事项

| 项 | 说明 |
|---|---|
| `core.autocrlf` | 本机为 `true`；新增 `.gitattributes` 后以 `eol=lf` 为准。**不要**执行 `git add --renormalize .`，会炸出全仓 diff |
| 暂存策略 | 建议分 3 个提交：① 报告体系功能（V24~V28 + 报告代码 + 两个页面）② 文档与仓库配置 ③ 图标/封面删除。便于回溯与回滚 |
| 不要提交 | `.trash/`、`artifacts/`、`output/`、`env.local`、`project.private.config.json`、`backend.rar` |
| 不要改动 | `flyway_schema_history`、已应用的 `V1~V26`/`V9000~V9009` 迁移文件 |
| 提交信息 | `<type>: <简述>`，`type ∈ feat/fix/docs/refactor/test/chore/perf` |

---

## 6. 推送路径二选一

### 路径 A · 增量提交到现有仓库（推荐，保留 3 个历史提交）

```bash
git add -A
git status --short | head -40          # 再目检一次
git commit -m "feat: 电子检查报告体系（V27/V9010/V9011）+ 开源仓库整理"
git push origin main
```

适用于：仓库已是你要用的那个，历史无需清洗。

### 路径 B · 重建干净仓库（仅当必须清除历史中的 dev key）

```bash
# ⚠️ 不可逆：会删除全部本地历史，务必先整目录备份
mv .git ../wechar-git-backup-20261105
git init -b main
git add -A && git commit -m "chore: initial import (sanitized)"
git remote add origin https://github.com/xiaodog22/aiyiliao.git
git push --force origin main
```

适用于：方案 C（改写历史）。执行前必须确认远端没有其他人的分支/PR。

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
| 1 | dev 登录密钥在提交历史中 | 见 §1.1，等你在 A/B/C 中选定 |
| 2 | 171 个 `M` 与 157 个 `??` 混杂了多轮会话改动，尚未按主题拆分 | 建议按 §5 分 3 个提交，不要一把梭 |
| 3 | 仓库无 CI，门禁全靠本地 | 后续可加 `.github/workflows/verify.yml` 跑 4 条命令 |
| 4 | `docs/preview-qr*.png`、`docs/preview-info*.json` 含 appid | 已忽略；若曾跟踪需 `git rm --cached` 后确认 |
| 5 | 演示数据与真实机构同名风险 | 数据侧已用「（模拟）」后缀与 `DEMO-*` 编号，公开前再扫一遍 `backend/business-service/src/main/resources/db/dev/` |
