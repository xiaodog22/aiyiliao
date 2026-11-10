# 微信云托管接入说明（2026-11-04）

> 适用：把 `edge-gateway` / `business-service` / `ai-service` 三个容器部署到微信云托管。
> 镜像定义见 `backend/deploy/docker/*.Dockerfile`，本地等价拓扑见 `backend/docker-compose.yml`。
> 本文只写**会卡住上线**的事实，不复述云托管通用教程。

---

## 1. 先回答一个问题：能不能不用域名？

**接口可以，图片和上传不行。** 三条硬限制必须同时满足才算"免域名"：

| 限制 | 值 | 影响 |
|---|---|---|
| `wx.cloud.callContainer` 单次超时 | **≤ 15s**（官方硬限，无法调大） | `careplan`（180s）、`interpret`(45s)、长轮询类全部不可用 |
| `callContainer` 请求体 | **≤ 100K** | 头像、健康档案附件、ASR 音频（几十 KB～50MB）全部不可用 |
| `<image src>` | **只能吃 URL**，不能走 `callContainer` | 所有网络图片仍需要一个可访问的 HTTPS 地址 |

所以"完全免域名"不是配一个开关，而是一次改造：

| 改造项 | 内容 | 量级 |
|---|---|---|
| 接口层 | `services/request.js` 增加 `callContainer` 分支 + `wx.cloud.init({env})` | 1 天 |
| 长任务 | `careplan` 改「提交任务 → 轮询」（现有 180s 同步等必须拆掉） | 2–3 天 |
| 上传 | `wx.uploadFile` → `wx.cloud.uploadFile`（云存储），后端契约从 objectKey 改 fileID | 2–3 天 |
| 图片 | 登录页 `resourceUrl` 改 `resolveResource` 或直接包内；`resource.js` 在云模式下永不拼 gateway | 0.5 天 |
| 回归 | `test-fe` / 契约快照 / 真机全流程 | 1 天 |

**总 6–8 天，且改的是主链路。** 相比之下，绑一个已备案自定义域名是 0 行代码。

> 结论：**如果目标只是"尽快能提审"**，走自定义域名；**如果目标是不买域名、不备案**，
> 按上表做完整改造，别只改接口层 —— 那样 careplan 和上传会在提审演示时必炸。

---

## 2. 服务拓扑与公网开关

```
小程序 ──HTTPS──> gateway（唯一公网入口）
                     ├─> business-service（内网，关闭公网）
                     └─> ai-service（内网，关闭公网）
business ──内网 HTTP + Bearer──> ai-service
business ──> MySQL（独立 CDB，平台不支持容器内跑有状态服务）
```

- **只有 gateway 开公网**。business / ai 一旦开公网，等于绕过网关限流、匿名白名单与鉴权边界。
- 云托管**不支持一个服务监听多端口**，每个服务只暴露一个端口，按下表在「服务设置」里改：

| 服务 | 容器端口 | 健康检查路径 | 备注 |
|---|---|---|---|
| gateway | **8080**（平台默认 80，必须改） | `/api/gw/health`（接受 200/503） | 单 worker，限流器是进程内状态 |
| business-service | **8088**（必须改） | `/actuator/health` 含 `"UP"` | 依赖 MySQL，连不上启动失败 |
| ai-service | **8001**（必须改） | `/internal/health/live` | 单副本，任务表在容器磁盘 |

内网地址用服务名，端口与上表一致：
`GW_BUSINESS_URL=http://business-service:8088`、`GW_AI_URL=http://ai-service:8001`、
`AI_SERVICE_URL=http://ai-service:8001`。
（若控制台里端口被平台改写，以控制台实际值为准，不要照抄本文。）

---

## 3. 必填环境变量（缺了不是降级，是启动失败）

### business-service

| 变量 | 缺失后果 |
|---|---|
| `MYSQL_URL` / `MYSQL_USER` / `MYSQL_PASSWORD` | Flyway 启动即连，连不上直接退出 |
| `PHONE_KEY_BASE64` | `PhoneCrypto` 构造器抛 `IllegalStateException` → **启动失败** |
| `APP_ATTACHMENT_SIGN_SECRET` | `AttachmentStorage` 抛异常 → **启动失败**（多副本必须同值） |
| `AI_SERVICE_TOKEN` | 调 ai 不带 `Authorization` → ai 侧 401（与 ai 必须同值） |
| `WECHAT_MINIPROGRAM_APP_ID` / `_SECRET` | 不阻断启动，登录返回 503 |
| `APP_ATTACHMENT_SIGN_SECRET` 之外的可选项 | `APP_RESOURCES_PUBLIC_BASE_URL`（资源清单绝对 URL）、`APP_UPLOAD_DIR` |

### ai-service

| 变量 | 缺失后果 |
|---|---|
| `AI_SERVICE_TOKEN`（≥32 字符） | `AI_AUTH_MODE=static` 默认，空值 → **启动失败** |
| `AI_DEEPSEEK_API_KEY` | 不阻断；第二级直接跳过，云上（连不到 Ollama）AI 只剩 business 规则兜底 |
| `AI_TTS_PUBLIC_BASE` / `AI_TTS_PUBLIC_PATH` | 不阻断，但返回 `http://127.0.0.1:8001/...` → **TTS 100% 播不出** |
| `AI_ASR_AUDIO_DIR` | 必须与 business 同路径，但两容器不同盘 → **云上 ASR 确定不可用** |

`AI_TTS_PUBLIC_BASE` 正确取值示例（按实际域名替换）：
`https://<网关域名>/api/gw`，配合 `AI_TTS_PUBLIC_PATH=/tts/audio`。

### gateway

| 变量 | 说明 |
|---|---|
| `GW_BUSINESS_URL` / `GW_AI_URL` | 内网服务名 |
| `GW_PROXY_TIMEOUT_SECONDS` | **保持 220，不得下调**（careplan 预算 60s + business 等待 75s + 余量） |
| `GW_RATE_LIMIT_ENABLED` | 单副本阶段可开；多副本前必须先迁共享存储（阈值是进程内的） |
| `GW_ASSETS_DIR` | 默认 `/app/assets`（镜像已 COPY） |

---

## 4. 存储：容器磁盘不持久

云托管官方口径：**容器不支持持久化存储，扩缩容/重启自愈时写入的文件会被还原。**

| 路径 | 谁写 | 重启后 | 结论 |
|---|---|---|---|
| `/app/run/uploads/avatars` | business 头像 | **丢** | 用户头像 404 |
| `/app/run/uploads/attachments` | business 健康档案附件 | **丢** | 检查报告 404（签名 URL 有效但文件没了） |
| `/app/runtime/tasks.json` | ai 任务表 | **丢** | 单副本可接受；多副本必须外置 |
| `/app/runtime/tts` | ai TTS 产物 | **丢** | 前端重播需重新合成 |
| `/app/resources`、`/app/assets` | 镜像内置 | 保留 | 只读，正常 |

**上线前必须决策**：头像/附件要不要迁对象存储（COS）。
不迁 = 接受"每次发布清空用户上传文件"，这在医疗类目里不可接受。

---

## 5. 图片链路：三条通道的实际行为

```
① 资源库主通道  /api/v1/resources/{key}   → business → DB file_path → /app/resources  ✅ 支持子目录
② 旧素材通道    /api/gw/assets/{path}     → gateway → /app/assets                   ⚠️ 前端未调用
③ 头像/附件     /api/v1/avatars|attachments → business → /app/run/uploads           ⚠️ 重启丢
```

两个容易误判的点：

1. **不配 `APP_RESOURCES_PUBLIC_BASE_URL` ≠ 图片全走包内。**
   首页 `resolveResource()` 会回包内；但**登录页 `resourceUrl()` 会用 `ENV.gateway` 自拼
   `/api/v1/resources/{key}?v=...` 走网络**。所以登录页首屏图仍然要求
   `request` + `downloadFile` 两个合法域名同时可用，否则第一屏就是裂图。
2. **`<image>` 加载网络图走 `downloadFile` 合法域名**（业界一致行为）。
   只配 `request` 不配 `downloadFile`，接口全通、图片全裂。

---

## 6. 域名白名单（走自定义域名方案时）

小程序后台「开发 → 开发设置 → 服务器域名」需要同时填：

| 类型 | 填什么 | 谁用 |
|---|---|---|
| request 合法域名 | 网关域名 | 全部接口、资源清单 |
| uploadFile 合法域名 | 网关域名 | 头像、ASR 音频、附件上传 |
| downloadFile 合法域名 | 网关域名（+ 资源/CDN 域名） | `<image>` 网络图、`wx.downloadFile` |

硬性要求：HTTPS、已 ICP 备案、不能带端口、证书链完整（iOS 对 ATS/TLS 1.2 更严）。

> **微信云托管的"默认公网域名"不能填进小程序后台**（官方明确：仅支持接口测试，请勿用于正式生产）。
> 必须绑自定义域名。

---

## 7. CORS 不是小程序的问题

`wx.request` / `<image>` 不走浏览器同源策略，服务端 `cors.enabled=false` 对小程序零影响。
CORS 只在 WebView / H5 调试台里才生效（`GW_CORS_ALLOW_ORIGINS` 显式列出来源，不回落 `*`）。
排查"图片加载失败"时不要往 CORS 上找，先看 HTTPS、域名白名单、404。

---

## 8. 上线前检查清单

- [ ] 三份镜像构建成功（business 的 `mvn dependency:go-offline` 不再被 `|| true` 吞错）
- [ ] 控制台端口改为 8080 / 8088 / 8001
- [ ] business / ai 关闭公网访问
- [ ] 第 3 节所有「启动失败」类变量已注入，ai 与 business 的 `AI_SERVICE_TOKEN` 同值
- [ ] `GW_PROXY_TIMEOUT_SECONDS=220` 已**显式**注入（勿依赖 `config.py` 默认值）；`AI_TTS_PUBLIC_BASE` 已指向对外 HTTPS 域名而非 127.0.0.1；前端 `production` 档三档超时为 90/120/180s
- [ ] 容器从最小副本 1 起步（最小副本 0 会在半小时无请求后缩容，冷启动直接打登录）
- [ ] 真机传一张 3MB 照片 + 一个 30MB 视频（验证 multipart 已放开）
- [ ] 真机打开登录页，小安机器人图正常显示（验证 downloadFile 域名）
- [ ] 重启 business 容器后，之前的头像/附件仍可访问 —— **不过说明还没迁对象存储**
- [ ] 触发一次 TTS，确认 `audioUrl` 是 `https://<域名>/api/gw/tts/audio/...` 而非 127.0.0.1
- [ ] `GET /api/gw/health` 与 `/actuator/health` 均为 UP

---

## 9. 已知会"静默降级"的行为（不是 bug，别当故障查）

| 现象 | 原因 |
|---|---|
| ASR 一律 `CAPABILITY_UNAVAILABLE` | 镜像未装 `requirements-asr.txt`，权重未打包，且音频目录跨容器不通 |
| AI 只出规则结果 | `AI_DEEPSEEK_API_KEY` 未配 + 云上连不到 Ollama |
| 资源清单 `url` 为 null | `APP_RESOURCES_PUBLIC_BASE_URL` 未配（前端行为见第 5 节，不等于全走包内） |
| 上传 1MB 以上报错 | `spring.servlet.multipart` 已在本仓库放宽到 50MB/55MB；若仍失败，检查控制台是否覆盖了 `MULTIPART_*` |
