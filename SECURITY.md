# 安全策略

## 支持范围

本项目为技术演示项目，只维护 `main` 分支的最新提交。

| 版本 | 是否接收安全报告 |
|---|---|
| `main`（最新） | ✅ |
| 历史提交 / 归档分支 | ❌ |

## 如何报告漏洞

**请不要在公开 Issue、讨论区或 PR 中披露未修复的安全问题。**

优先使用 GitHub 的私密渠道：
`Security` 标签页 → `Report a vulnerability`（GitHub Security Advisory）。

如果该入口不可用，请在 Issue 中只写「希望私下报告安全问题」并留下联系方式，维护者会主动联系。
报告中请包含：影响范围、复现步骤、涉及文件或接口、可能的修复方向。
我们会在确认后修复并（经你同意）在致谢中署名。

## 已知的安全设计

| 机制 | 位置 | 说明 |
|---|---|---|
| dev 登录双闸门 | `DevWechatSessionProvider` + `DevLoginGuard` | dev 派生 code 必须同时满足：配置开启 + 请求头 `X-Dev-Login-Key` 恒定时间比对；生产 profile 不装配该实现 |
| 手输登录白名单 | `app.auth.dev-login-phones` / `dev-login.identity-map` | 手机号必须显式登记，置空即全拒绝（fail-closed）；未登记一律 401，不区分「账号不存在」与「密码错误」 |
| 会话鉴权 | `AuthService` / `AuthSessionStore` | 生产与 dev 同为 strict：只认 Bearer 会话，不接受 `X-User-Id` 自报身份 |
| 越权隔离 | 各 Repository 的 `user_id` 条件 | 所有读路径强制带当前用户；越权一律 404，不泄露资源是否存在 |
| 报告状态门禁 | `HealthReportService.isUnpublishedReport` | 未出具（PENDING/REVIEWING）报告不返回明细、结论与附件，前端隐藏不作为隔离手段 |
| 附件访问 | `AttachmentStorage` | 短期签名 URL（HMAC + TTL），数据库不存二进制 |
| 手机号存储 | `phone_cipher` / `phone_hash` | AES 加密 + SHA-256 哈希双列，密钥来自 `PHONE_KEY_BASE64` |
| 写接口幂等 | `Idempotency-Key` | 缺失 400；同键不同体 409 |
| 服务间调用 | `AI_SERVICE_TOKEN` | business → ai 的内部令牌，缺失即启动失败 |

## 部署方必须做的事

1. 用环境变量覆盖全部密钥，不要复用仓库里的 dev 占位值（`MDEyMzQ1...` 只能用于本地）；
2. `APP_AUTH_DEV_LOGIN_ENABLED` 在生产必须为 `false`，`APP_AUTH_DEV_LOGIN_PHONES` 置空；
3. 生产 profile 下 `dev-login.identity-map` 不存在（该键只在 dev 档配置），请勿手工补；
4. 关闭 8088 / 8001 的公网直连，只暴露网关；
5. 上传目录需要持久化存储，容器重启会丢文件（见 `backend/deploy/CLOUD.md`）；
6. 医疗数据合规（保留周期、脱敏、审计）由部署方按当地法规落实，仓库内 `DATA_GOVERNANCE.md` 只是开发口径。

## 不在范围内

- 需要物理接触设备或已获取管理员权限的攻击场景；
- 依赖的第三方组件（Spring Boot / FastAPI / MySQL / Ollama / 微信基础库）自身漏洞，请上报给对应上游；
- 演示数据本身的可推测性（`DEMO-*` 编号、`dev-*` 账号均为公开的模拟数据）。
