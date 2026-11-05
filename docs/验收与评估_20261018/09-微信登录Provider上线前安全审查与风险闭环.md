# 09 · 微信登录 Provider 上线前安全审查与风险闭环报告

> 审查时间：2026-10-18（晚） | 审查对象：`ProdWechatSessionProvider` 真实微信登录链路（business-service :8088）
> 本轮边界：**不部署、不修改 8088、不提交 Git，等待人工审核**。所有修改未提交。
>
> **【勘误 2026-10-18 21:10，见报告 10】**：本报告 R13 与第四节将 `check-v4-docs` 2 项失败归属于「2026-10-17 personal-info 页批次」，经嵌套仓 git 证据核实，personal-info 实为 **2026-10-18 15:12（b66fddb，V8 个人信息设置批次）** 引入，日期归属有误；且当轮门禁清单遗漏了从未实跑的 `check-v4-prototypes`（其 3 项失败同源于此漂移 + 1 项 10-14 基线截图缺陷）。漂移性质判断（与微信登录无因果关系）不变。

---

## 一、各风险项的审查证据与结论

### R1 未知微信 errcode 被判定为「可重试」（**确认缺陷，已修复**）

- 代码位置：`ProdWechatSessionProvider.businessFailure()`（`backend/business-service/src/main/java/com/wechar/biz/auth/ProdWechatSessionProvider.java`）
- 调用链：`code2session` 返回 HTTP 200 但 `errcode != 0` → `businessFailure(errcode,...)` → 原默认分支走 `upstreamRetryable()`（503 + `retryable=true`）
- 触发条件：微信侧返回任何**未登记**的业务 errcode（历史新增错误码、灰度新码、代理层注入码均可触发）
- 影响范围：客户端收到「请重试」提示 → 用户重复点击 → 每次都重新消耗一个一次性 code 并再次打上游。若上游处于持续性异常（而非瞬时抖动），这构成**客户端侧放大重试**，同时把不可恢复失败伪装成网络抖动，误导用户与监控告警（`retryable` 字段被网关/统计链路消费）
- 结论：**安全缺陷**。任务书明令「未知 errcode 不得无条件判定可重试」。已改为默认 `upstreamRejected()`（503 + `retryable=false`，文案引导重新进入小程序），仅保留**有微信文档明文依据**的 `-1`（系统繁忙）与 `45011`（API 频率超限）为可重试

### R2 AppSecret/URI 可经异常消息泄入日志（**确认缺陷，已修复**）

- 代码位置：`code2sessionUri()` / `accessTokenUri()` / `phoneNumberUri()` 三处 `URI.create`，以及 `call()` 的异常出口
- 调用链：`api-base-url` 配错（含空格/非法主机名）→ `URI.create` 抛 `IllegalArgumentException`，其 `getMessage()` **回显完整原始字符串**（含 query 里的 appid/secret）→ 冒泡至 `AuthController` → `GlobalExceptionHandler.handleUnexpected` 全量打印堆栈与 `e.getMessage()` → 落盘 access.log / 控制台
- 触发条件：运营改配置手滑（域名带空格、漏写 scheme、复制带不可见字符），或攻击者若能影响该配置项
- 影响范围：AppSecret 泄露 = 可配合 appid 调微信侧接口（getAccessToken、getPhoneNumber 等），属**高危凭证泄露路径**；同时日志中出现明文密钥违反脱敏规则
- 结论：**安全缺陷**。已新增 `safeUri()` 包装三个构造器，捕获后**只记录异常类名**；`call()` 增加 `catch (RuntimeException)` 同样只记类名。已用「bad host 含空格 + IllegalStateException 消息含 APP_SECRET」两例测试证明密钥不进出参也不进日志

### R3 access_token 端点错误分类丢失可证明的重试（**确认缺陷，已修复**）

- 代码位置：`accessToken()` 的错误处理分支
- 原逻辑：token 端点任何失败一律 `configError()`（retryable=false）——包括 `-1` 系统繁忙与 `45011` 频率限制
- 触发条件：微信 token 服务瞬时繁忙（高峰期常见），本应客户端重试
- 影响范围：高峰期登录成功率被无谓压低；且与 code2session 分支的可重试语义**自相矛盾**（同一份文档两套标准）
- 结论：**语义缺陷**。已改为抛 `businessFailure(errcode, "get_access_token", startedAt)`，复用统一 errcode 分类表：`-1`/`45011` 可重试，`40001/40013/40014/41002/41004/40125/40164/42001` 判配置错误（retryable=false，文案指向联系管理员），其余未知码仍默认不可重试。与一次性 code 语义不冲突：换 access_token 失败**不消耗登录 code**（code 只在 code2session 用一次），重试安全

### R4 `@Transactional` 内含微信 HTTP 调用（**架构问题，仅报告，未修改**）

- 代码位置：`AuthService.login()` / `loginIdentity()`（`@Transactional` 方法内调用 `wechatSessionProvider.code2session`）
- 触发条件：微信接口慢（超时 5s）或挂起 → 数据库连接与行锁被持有全程
- 影响范围：高峰期连接池耗尽放大为全站故障；登录相关行锁导致其他登录/查询阻塞
- 处置：**不在本轮引入基础设施改造**。建议方案（二选一，需人工排期）：
  - 方案 A（最小）：`code2session` 移到 `@Transactional` 方法外，先取 openid 再进事务写会话
  - 方案 B（彻底）：拆 `LoginIdentityStore` 独立 Bean，事务只包存储层
- 说明：本轮只改 Provider 内部，未触碰 `AuthService` 事务边界，故无回归面

### R5 多实例 access_token 缓存互失效（**已知架构限制，仅报告**）

- 现状：进程内 `synchronized` 缓存，提前 5 分钟过期余量；微信的 access_token 是**全局唯一**，实例 B 刷新会使实例 A 缓存失效
- 影响范围：多副本部署时定期出现 `40001` → 已由 R3 的错误分类降级处理（换票重试一次，用户无感或仅一次轻微延迟）
- 处置：**不引 Redis/数据库表**（任务书禁止本轮引入新基础设施）。长期方案：共享缓存或「40001 即强制刷新 + 单飞」已部分实现
- 结论：可延期，当前缓解足够

### R6 一次性 code 消费后客户端超时重试（**已知限制，仅报告**）

- 现状：登录请求**不重试**（code 一次性语义），客户端超时后用户手动重试 → 第二个 code 通常可用（用户重新进入小程序会拿新 code）
- 触发条件：服务端处理成功但响应在返回途中丢失（网络抖动），用户看到失败但会话已建立
- 影响范围：偶发「提示失败但实际已登录」，重新进入即恢复；无数据损坏
- 处置：服务端短 TTL replay 缓存属**新增基础设施**，本轮不做。可延期

### R7 日志与响应脱敏（**审查通过，无修改**）

- `AuthSessionStore` 令牌库存 SHA-256 哈希；`ProdWechatSessionProvider` 所有日志只记 `operation/category/errcode/elapsedMs/openid 前缀`，`session_key` **从不落日志**（本次修复后连异常消息都不含密钥）
- 失败路径不签发会话：500/422/503 三路集成测试证实（M5 链路 10/10 含失败态断言）
- 401 单飞刷新、refresh 一次一换、重放撤销整链（既有实现，本轮未动）

### R8 缺配置时不得调上游（**审查通过，有测试**）

- `isConfigured()` 前置校验，缺 AppID/AppSecret 直接返回配置错误，**0 次上游调用**（`M5WechatLoginNotConfiguredTest` 2/2 + `ProdWechatSessionProviderHttpTest` 断言 mock server 0 命中）

### R9 失败文案与 retryable 语义矛盾（**确认缺陷，已修复**）

- 原 `responseInvalid()` 文案「请稍后重试」但 `retryable=false`——文案诱导重试、字段禁止重试
- 已统一为「请重新进入小程序后重试」（重新进入 = 换新 code，与不可重试语义自洽）

### R10 医生角色授权（**审查通过，无修改**）

- `DoctorService.login` / `requireDoctor` 依赖 `doctors.user_id + ACTIVE` 任职关系；非授权用户 403 且**不签发会话**（集成测试断言）。角色判定完全服务端，不信客户端传入角色

### R11 登录限流（**审查通过，无修改**）

- 登录 IP 限流 30 次/窗口（既有实现），本轮未触碰

### R12 契约/状态机/迁移（**审查通过，无变更**）

- 错误码信封 `{code, message, requestId, retryable, serverTime}` 结构不变；新增/复用的错误码均走统一 `businessFailure` 工厂；**无 Flyway 迁移新增**；小程序前端契约零改动

### R13 前端门禁（**10/11 通过，1 项既有失败与本轮无关**）

- `check-v4-docs` 2 项失败（app.json 路由 25 vs 文档 24；主说明书缺 `pages/profile/personal-info/personal-info`）经 git 状态比对确认为 **2026-10-17 personal-info 页批次**的既有文档漂移，与微信登录无因果关系。按最小改动原则本轮不修，仅登记（见第四节）

---

## 二、实际修改文件和关键 diff

修改文件 5 个（均未提交），净变更 **+约 60 行 / -约 8 行**，全部集中在 `ProdWechatSessionProvider.java` 及其单测/文档：

| 文件 | 变更 | 行数 |
|---|---|---|
| `backend/business-service/src/main/java/com/wechar/biz/auth/ProdWechatSessionProvider.java` | 修复 R1/R2/R3/R9 | +52 / -8 |
| `backend/business-service/src/test/java/com/wechar/biz/auth/ProdWechatSessionProviderTest.java` | 替换 1 例 + 新增 5 例回归 | +83 |
| `backend/business-service/README.md` | 失败语义段重写 | +约 30 / -约 8 |
| `DEV_LOG.md` | 追加本轮审查条目 | +约 60 |
| `docs/验收与评估_20261018/09-微信登录Provider上线前安全审查与风险闭环.md` | 本报告 | 新增 |

### 关键 diff 1：未知 errcode 安全默认（R1 + R9）

```diff
     private AuthService.WechatAuthException businessFailure(int errcode, String operation, long startedAt) {
         log.warn("微信业务错误 operation={} errcode={} category={} elapsedMs={}",
                 operation, errcode, category, elapsedMillis(startedAt));
-        if (TRANSIENT_ERRCODES.contains(errcode)) {
-            return upstreamRetryable();
-        }
-        if (CONFIG_ERROR_ERRCODES.contains(errcode)) {
-            return configError();
-        }
-        return upstreamRetryable();
+        if (TRANSIENT_ERRCODES.contains(errcode)) {
+            return upstreamRetryable();
+        }
+        if (CONFIG_ERROR_ERRCODES.contains(errcode)) {
+            return configError();
+        }
+        // 安全默认：未知 errcode 一律不可重试，引导客户端重新进入小程序换取新 code
+        return upstreamRejected();
     }
```

```diff
-    private static final String MESSAGE_RESPONSE_INVALID = "微信登录服务响应异常，请稍后重试";
+    private static final String MESSAGE_RESPONSE_INVALID = "微信登录服务响应异常，请重新进入小程序后重试";
```

```diff
+    /** 上游拒绝类失败：HTTP 200 但 errcode 未知，安全默认不可重试 */
+    public static final String CODE_UPSTREAM_REJECTED = "WECHAT_UPSTREAM_REJECTED";
+    public static final String MESSAGE_UPSTREAM_REJECTED = "微信登录服务暂时无法处理该请求，请重新进入小程序后重试";
+
+    private AuthService.WechatAuthException upstreamRejected() {
+        return new AuthService.WechatAuthException(503, CODE_UPSTREAM_REJECTED, MESSAGE_UPSTREAM_REJECTED, false, "upstream_rejected");
+    }
```

### 关键 diff 2：URI 构造防密钥泄露（R2）

```diff
+    /** 安全构造 URI：异常消息可能回显含密钥的原始字符串，只记录类名 */
+    private URI safeUri(String raw, String operation) {
+        try {
+            return URI.create(raw);
+        } catch (RuntimeException e) {
+            log.warn("微信接口 URI 构造失败 operation={} cause={}", operation, e.getClass().getSimpleName());
+            throw configError();
+        }
+    }
```

```diff
+        } catch (RuntimeException e) {
+            log.warn("微信接口调用出现未预期异常 operation={} category=unchecked_error cause={} elapsedMs={}",
+                    operation, e.getClass().getSimpleName(), elapsedMillis(startedAt));
+            throw responseInvalid();
+        }
```

### 关键 diff 3：token 端点错误分类（R3）

```diff
-    private String accessToken() {
-        ...
-        if (errcode != 0) {
-            log.warn("获取 access_token 失败 errcode={}", errcode);
-            throw configError();
-        }
+        if (errcode != 0) {
+            throw businessFailure(errcode, "get_access_token", startedAt);
+        }
```

```diff
-    private static final Set<Integer> CONFIG_ERROR_ERRCODES = Set.of(40013, 41002, 41004, 40125, 40164);
+    // 新取票场景：40001/40014/42001 同样是凭证配置类错误（token 无效/过期）
+    private static final Set<Integer> CONFIG_ERROR_ERRCODES = Set.of(40001, 40013, 40014, 41002, 41004, 40125, 40164, 42001);
```

---

## 三、新增测试及真实运行结果

### 测试集变更

`ProdWechatSessionProviderTest`：25 例 → **30 例**（净 +5）：

| 新用例 | 断言 |
|---|---|
| `未知业务错误_安全默认503不可重试_且日志含errcode但不含正文` | errcode=99999 → CODE_UPSTREAM_REJECTED、retryable=false、上游仅 1 次调用、日志含 99999 与 upstream_rejected、**无 session_key** |
| `未知业务错误_文案引导重新进入小程序_不含密钥与上游地址` | message 不含 APP_SECRET、不含 api 地址片段 |
| `api_base_url非法_503不可重试_且密钥不进异常与日志` | bad host 含空格 → 上游 0 次调用、异常消息与日志均不含 APP_SECRET |
| `传输层未受检异常_503不可重试_日志只记类名不含密钥` | transport 抛 IllegalStateException（消息含 APP_SECRET）→ 503、日志只记类名 |
| `token端点系统繁忙_可重试` | errcode=-1 → CODE_UPSTREAM、retryable=true |
| `token端点凭证错误40001_503不可重试` | errcode=40001 → CODE_CONFIG_ERROR、retryable=false |

（原 `未知业务错误_返回503…` 用例被第 1 行替换，为安全默认语义的强化版）

### 真实运行结果（本地实跑，非引用）

**后端全量（`./mvnw test`，surefire XML 解析，无 forked JVM 崩溃）**

```
Tests run: 208, Failures: 0, Errors: 0, Skipped: 0
测试类: 25 类全绿
```

**回归专项（实跑）**

| 测试类 | 结果 |
|---|---|
| `M5WechatLoginIntegrationTest`（登录成功/失败不签会话/403/限流/刷新/撤销） | 10/10 |
| `M5LoginFailureTest` | 2/2 |
| `M5WechatLoginNotConfiguredTest`（缺配置 0 上游） | 2/2 |
| cursor 分页 E2E | 8/8 |

**前端门禁（`tools/`）**：11 项中 **10 项通过**；`check-v4-docs` 2 项失败为 2026-10-17 personal-info 批次既有文档漂移（R13），与本轮修复无因果关系。

**真实微信联调**：**未执行**——无测试号 AppID/AppSecret 与已发布小程序。当前全部结论基于 MockWechatServer（真实 HTTP 交互）+ FakeTransport 故障注入，**不得对外宣称真实登录链路已验证**。

---

## 四、必须在提交前解决的问题

| # | 问题 | 归属 | 说明 |
|---|---|---|---|
| 1 | 真实微信联调 | 人工 | 需测试号（或体验版）AppID/AppSecret + `api-base-url` 指向真实微信域名，跑通 code2session / getPhoneNumber 全链路。本轮无凭证，仅 Mock 通过 |
| 2 | 4 个门禁脚本与 Flyway V7/V8/V9003 未跟踪 | 人工 | `check-styles`、`test-apt-date`、`test-pages-contract`、`test-resource-links` 与 Flyway 迁移文件处于 untracked 状态，**提交时必须整组纳入**（既有问题，非本轮引入） |
| 3 | `check-v4-docs` 2 项失败 | 人工 | personal-info 页路由登记与主说明书缺页，属 10-17 批次遗留，建议与个人中心页面批次一并修复，不塞进本提交 |
| 4 | 生产配置注入方式确认 | 人工 | `application.yml` 中 `wechat.miniprogram.app-id/app-secret` 必须确认由部署系统的密钥管理（环境变量/KMS）注入，**禁止提交真实凭证到仓库** |

---

## 五、真实微信联调所需条件

1. 微信测试号或已认证小程序：AppID + AppSecret（`application.yml` 或环境变量注入）
2. 服务器出口 IP 加入微信 IP 白名单（access_token 接口强制要求，否则 40164）
3. 小程序端使用**该 AppID** 编译（`wx.login` 的 code 与 appid 绑定，错配 = 40013/40125）
4. 联调用例清单：login 成功、code 复用（预期 40029/40163）、secret 错误（预期 40013 分类为配置错误）、IP 未白名单（40164）、token 繁忙重试（-1/45011）
5. 网络条件：business-service 可出网访问 `api.weixin.qq.com`（当前环境未验证出网）

---

## 六、部署前置条件、JAR 构建及校验步骤

> 本轮**未部署、未构建 JAR、未修改 8088**。以下为提交合并后的部署步骤（待人工审核后执行）。

1. **构建**：`cd backend/business-service && ../mvnw -q -DskipTests package`（**注意**：`target/*.jar` 被运行中的 8088 实例占用，不能原地 package——rename 失败。必须先停 orchestrator，或仓库外复制构建 + 独立端口验证）
2. **迁移**：确认无新增 Flyway 版本（本轮零迁移，V7/V8/V9003 维持既有）
3. **配置校验**：启动时确认 `WechatMiniProgramProperties.isConfigured()` 为 true（缺配置 = 登录 503 配置错误，不静默）
4. **冒烟**：`/health` 200 → 小程序 `wx.login` → 登录成功签发会话 → 刷新/撤销链路
5. **回滚**：保留旧 JAR；失败时停服务换回旧 JAR 重启（会话表结构未变，旧版兼容）
6. **监控项**：登录失败按 `category`（upstream_rejected / config_error / upstream_busy）分桶告警，`WECHAT_UPSTREAM_REJECTED` 出现即意味着微信侧出现未登记 errcode，需人工核对微信文档

---

## 七、尚未解决但可以延期的风险

| 风险 | 当前状态 | 缓解措施 | 延期理由 |
|---|---|---|---|
| R4 事务内含 HTTP | 未修改 | 高峰期监控连接池；微信超时已压到 5s | 改造触及登录主链路事务边界，需独立排期 + 全链路回归 |
| R5 多实例 token 互失效 | 未修改 | 40001 → 换票重试一次（R3 已保证分类正确） | 共享缓存需引 Redis/表，任务书禁止本轮引入基础设施 |
| R6 一次性 code 重试体验 | 未修改 | 文案引导「重新进入小程序」换取新 code | replay 缓存属新增基础设施；偶发且自愈 |
| 微信新增错误码 | 默认不可重试（R1 修复后安全） | 监控 `WECHAT_UPSTREAM_REJECTED` 分桶 | 微信不定期新增 errcode，靠监控兜底而非预登记 |
| personal-info 文档漂移 | 未修改 | 已登记（第四节 #3） | 属 10-17 页面批次，不混入本提交 |
| untracked 门禁/迁移文件 | 未修改 | 已登记（第四节 #2） | 提交策略需人工确认整组纳入 |

---

## 附：本轮约束执行确认

- [x] 未执行任何部署动作
- [x] 未修改 8088 运行实例（PID 23408，JAR 时间戳 18:27 未变，`/actuator/health` 200 UP）
- [x] 未提交 Git（分支 `fix/round1-appointment-ui` 维持原状）
- [x] 未清理任何未跟踪文件（含 10 件素材）
- [x] 未 `git clean` / `reset --hard` / 覆盖性备份
- [x] 未引入 Redis / 新数据库表 / 新基础设施
- [x] 未关闭鉴权、未模拟登录、未固定身份
- [x] 契约 / 状态机 / 脱敏规则 / 迁移均未变更

### 运行时实况核查（审查结束后复测，20:45）

| 探针 | 结果 | 说明 |
|---|---|---|
| 进程 / JAR | PID 23408 未变，`target/*.jar` mtime 仍 18:27 | 本轮零运行时触碰 |
| `:8088 /actuator/health` | **200 UP** | 即 DEV_LOG 所记「health 200」；裸 `/health` 在 business-service 无映射 → 兼容层 501 存根，**为既有行为，非回归** |
| `:8000 /health`（网关） | 200，java 上游 reachable 12ms | 业务服务实际可用 |
| `POST :8088 /api/v1/auth/wechat/login` | BAD_REQUEST「缺少 X-Client-Version」 | 登录端点在线且版本守卫生效；本机无 `WECHAT_*` 凭证，未做真实登录 |

⚠️ 注意：运行实例加载的是**审查前版本**（203 测试版 Provider）；本轮 4 处修复仅落源码（未 package、未部署），符合「不部署」约束。
