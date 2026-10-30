package com.wechar.biz.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.common.ApiException;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.ConnectException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 生产档微信会话适配器：真实调用微信开放接口。
 *
 * <p><b>登录（本次实现的核心）</b>——小程序登录凭证校验
 * {@code GET https://api.weixin.qq.com/sns/jscode2session?appid=&secret=&js_code=&grant_type=authorization_code}，
 * 成功响应字段 {@code openid} / {@code session_key} / {@code unionid}(可选)，业务失败以
 * {@code errcode}/{@code errmsg} 表达（{@code errcode=0} 表示成功）。</p>
 *
 * <p><b>手机号</b>——{@code GET /cgi-bin/token?grant_type=client_credential&appid=&secret=} 取
 * {@code access_token}（进程内缓存，提前 5 分钟过期），再
 * {@code POST /wxa/business/getuserphonenumber?access_token=} 换取 {@code phone_info}。</p>
 *
 * <p><b>安全红线</b>：</p>
 * <ul>
 *   <li>AppID / AppSecret 只从 {@link WechatMiniProgramProperties} 读取，不硬编码；缺失 → 503 显式失败。</li>
 *   <li>{@code session_key} 只在内存里传到 {@link WechatSessionInfo}，<b>绝不</b>回给小程序、绝不落库、绝不入日志。</li>
 *   <li>登录 code、手机号 code、AppSecret、完整响应正文<b>一律不写日志</b>；日志只留操作名、
 *       errcode、错误类别与耗时。</li>
 *   <li>不重试登录请求（code 一次性）；唯一的重试是 access_token 失效后换票重试一次。</li>
 *   <li><b>未知 errcode 一律按不可重试处理</b>（安全默认）：无法证明"重试会改善"，而登录/手机号
 *       code 均一次性，客户端按 retryable=true 重发同一 code 只会拿到 40163；
 *       可重试仅限于<b>可证明</b>的语义：网络异常/超时/上游 5xx/{@code -1}/45011。</li>
 * </ul>
 *
 * <p><b>失败语义</b>（对外稳定、不泄露凭证）：</p>
 * <table border="1">
 *   <tr><th>情形</th><th>HTTP</th><th>code</th><th>retryable</th></tr>
 *   <tr><td>凭证未配置</td><td>503</td><td>WECHAT_PROVIDER_UNAVAILABLE</td><td>false</td></tr>
 *   <tr><td>code 无效/过期/已使用（40029/40163）</td><td>422</td><td>WECHAT_CODE_INVALID</td><td>false</td></tr>
 *   <tr><td>AppID/AppSecret/IP 白名单等配置错误（40001/40013/40014/41002/41004/40125/40164/42001）</td><td>503</td>
 *       <td>WECHAT_PROVIDER_UNAVAILABLE</td><td>false</td></tr>
 *   <tr><td>系统繁忙 / 频率限制（-1/45011）</td><td>503</td><td>WECHAT_UPSTREAM_UNAVAILABLE</td><td>true</td></tr>
 *   <tr><td>网络异常、建连超时、读取超时、上游 5xx</td><td>503</td><td>WECHAT_UPSTREAM_UNAVAILABLE</td><td>true</td></tr>
 *   <tr><td>上游返回无法分类的业务错误（未知 errcode）</td><td>503</td><td>WECHAT_UPSTREAM_REJECTED</td><td>false</td></tr>
 *   <tr><td>响应非 JSON / 缺 openid / 结构异常 / 调用出现未预期异常</td><td>503</td><td>WECHAT_RESPONSE_INVALID</td><td>false</td></tr>
 * </table>
 */
@Component
@Profile("!dev & !itest") // dev/itest 用开发档；其余档位（生产）走本实现
public class ProdWechatSessionProvider implements WechatSessionProvider {

    private static final Logger log = LoggerFactory.getLogger(ProdWechatSessionProvider.class);

    /** 稳定对外错误码：配置缺失（客户端/监控据此区分"未配置"与"内部错误"）。 */
    public static final String CODE_NOT_CONFIGURED = "WECHAT_PROVIDER_UNAVAILABLE";
    /** 稳定对外错误码：微信 code 无效/过期/已被使用。 */
    public static final String CODE_CODE_INVALID = "WECHAT_CODE_INVALID";
    /** 稳定对外错误码：上游网络/服务不可用（可重试）。 */
    public static final String CODE_UPSTREAM = "WECHAT_UPSTREAM_UNAVAILABLE";
    /** 稳定对外错误码：上游返回无法分类的业务错误（未知 errcode；安全默认不可重试）。 */
    public static final String CODE_UPSTREAM_REJECTED = "WECHAT_UPSTREAM_REJECTED";
    /** 稳定对外错误码：上游响应结构异常。 */
    public static final String CODE_RESPONSE_INVALID = "WECHAT_RESPONSE_INVALID";

    /** 文案只说明"不可用"，不含 AppSecret/接口地址等部署细节。 */
    private static final String MESSAGE_NOT_CONFIGURED = "微信登录服务尚未配置，暂时无法登录，请联系管理员";
    private static final String MESSAGE_CODE_INVALID = "微信登录凭证无效或已过期，请重新进入小程序后重试";
    private static final String MESSAGE_UPSTREAM = "微信登录服务暂时不可用，请稍后重试";
    private static final String MESSAGE_UPSTREAM_REJECTED = "微信登录服务暂时无法处理该请求，请重新进入小程序后重试";
    private static final String MESSAGE_RESPONSE_INVALID = "微信登录服务响应异常，请重新进入小程序后重试";

    /** access_token 缓存的安全余量：到期前 5 分钟即视为过期。 */
    private static final long TOKEN_SAFETY_MARGIN_MILLIS = 5 * 60 * 1000L;

    /** access_token 失效类 errcode（换票重试一次即止）。 */
    private static final java.util.Set<Integer> TOKEN_INVALID_ERRCODES =
            java.util.Set.of(40001, 40014, 42001);

    /** code 无效/过期/重复使用：属于客户端侧问题 → 422。 */
    private static final java.util.Set<Integer> CODE_INVALID_ERRCODES =
            java.util.Set.of(40029, 40163);

    /**
     * 凭证或网络配置错误：部署/运维问题，重试不会自愈 → 503 不可重试。
     * 40001/40014/42001 出现在<b>新取</b> access_token 的响应里 = AppID/AppSecret 凭证问题
     * （手机号流程里的"旧票失效"由 {@link #TOKEN_INVALID_ERRCODES} 先行换票处理，不落入本集合）。
     */
    private static final java.util.Set<Integer> CONFIG_ERROR_ERRCODES =
            java.util.Set.of(40001, 40013, 40014, 41002, 41004, 40125, 40164, 42001);

    private final WechatMiniProgramProperties properties;
    private final WechatHttpTransport transport;
    private final ObjectMapper json = new ObjectMapper();

    private final Object tokenLock = new Object();
    private String cachedAccessToken;
    private long accessTokenExpiresAtMillis;

    /** 生产构造：Spring 注入配置；HTTP 传输层按配置的超时构建（测试用另一个包内构造）。 */
    @org.springframework.beans.factory.annotation.Autowired
    public ProdWechatSessionProvider(WechatMiniProgramProperties properties) {
        this(properties, new WechatHttpTransport.Jdk(
                properties.effectiveConnectTimeoutMs(), properties.effectiveReadTimeoutMs()));
    }

    /** 供测试注入受控传输层（不改变生产构造路径）。 */
    ProdWechatSessionProvider(WechatMiniProgramProperties properties, WechatHttpTransport transport) {
        this.properties = properties;
        this.transport = transport;
    }

    // ================================================================== 登录

    @Override
    public WechatSessionInfo getSessionByCode(String code) {
        requireConfigured("code2session");
        if (code == null || code.isBlank()) {
            // 空 code 不必打上游（省一次失败请求），语义等同无效 code。
            log.warn("微信登录失败 operation=code2session reason=empty_code");
            throw codeInvalid();
        }

        long startedAt = System.nanoTime();
        WechatHttpTransport.Response response = call("GET", code2SessionUri(code), null, "code2session", startedAt);

        JsonNode root = readObject(response, "code2session");
        int errcode = root.path("errcode").asInt(0);
        if (errcode != 0) {
            throw businessFailure(errcode, "code2session", startedAt);
        }

        String openid = text(root, "openid");
        if (openid == null || openid.isBlank()) {
            log.error("微信登录响应缺少 openid operation=code2session errcode={} elapsedMs={}",
                    errcode, elapsedMillis(startedAt));
            throw responseInvalid();
        }

        // session_key 仅进程内传递：不落库、不序列化给客户端、不入日志（此处不打印其值）。
        String sessionKey = text(root, "session_key");
        log.info("微信登录成功 operation=code2session elapsedMs={}", elapsedMillis(startedAt));
        return new WechatSessionInfo(openid, null, sessionKey);
    }

    // ================================================================== 手机号

    @Override
    public String getPhoneNumberByCode(String phoneCode) {
        requireConfigured("getuserphonenumber");
        if (phoneCode == null || phoneCode.isBlank()) {
            return null; // 令牌缺失 → 调用层 422 PHONE_CODE_INVALID
        }

        long startedAt = System.nanoTime();
        String token = accessToken(startedAt);
        JsonNode root = postJson(phoneNumberUri(token), "{\"code\":\"" + escapeJson(phoneCode) + "\"}",
                "getuserphonenumber", startedAt);
        int errcode = root.path("errcode").asInt(0);

        if (TOKEN_INVALID_ERRCODES.contains(errcode)) {
            // 失效票换一次：这是唯一允许的重试，且只针对 access_token，不是重放登录 code。
            log.warn("微信 access_token 失效，换票后重试一次 operation=getuserphonenumber errcode={}", errcode);
            invalidateAccessToken();
            String refreshed = accessToken(startedAt);
            root = postJson(phoneNumberUri(refreshed), "{\"code\":\"" + escapeJson(phoneCode) + "\"}",
                    "getuserphonenumber", startedAt);
            errcode = root.path("errcode").asInt(0);
            if (TOKEN_INVALID_ERRCODES.contains(errcode)) {
                log.error("微信 access_token 换票后仍失效 operation=getuserphonenumber errcode={}", errcode);
                throw configError();
            }
        }

        if (errcode != 0) {
            if (CODE_INVALID_ERRCODES.contains(errcode)) {
                // 契约：返回 null = 令牌无效/未授权，由调用层转 422 PHONE_CODE_INVALID
                log.warn("微信手机号令牌无效 operation=getuserphonenumber errcode={} elapsedMs={}",
                        errcode, elapsedMillis(startedAt));
                return null;
            }
            throw businessFailure(errcode, "getuserphonenumber", startedAt);
        }

        JsonNode info = root.path("phone_info");
        String phone = text(info, "purePhoneNumber");
        if (phone == null || phone.isBlank()) {
            phone = text(info, "phoneNumber");
        }
        if (phone == null || phone.isBlank()) {
            log.error("微信手机号响应缺少号码字段 operation=getuserphonenumber elapsedMs={}",
                    elapsedMillis(startedAt));
            throw responseInvalid();
        }
        log.info("微信手机号获取成功 operation=getuserphonenumber elapsedMs={}", elapsedMillis(startedAt));
        return phone.trim();
    }

    // ============================================================ access_token

    /** 取 access_token（进程内缓存；并发下只放一个请求出去取票）。 */
    private String accessToken(long startedAt) {
        synchronized (tokenLock) {
            if (cachedAccessToken != null && System.currentTimeMillis() < accessTokenExpiresAtMillis) {
                return cachedAccessToken;
            }
            JsonNode root = getJson(accessTokenUri(), "get_access_token", startedAt);
            int errcode = root.path("errcode").asInt(0);
            if (errcode != 0) {
                // 与登录/手机号同一套错误分类：凭证类→不可重试 503；-1/45011 繁忙→可重试；
                // 未知 errcode→不可重试（安全默认），不再一律按"配置错误"丢掉可证明的重试机会。
                throw businessFailure(errcode, "get_access_token", startedAt);
            }
            String token = text(root, "access_token");
            if (token == null || token.isBlank()) {
                log.error("微信 access_token 响应缺少 access_token 字段");
                throw responseInvalid();
            }
            long expiresInSeconds = root.path("expires_in").asLong(7200L);
            long ttlMillis = Math.max(60_000L, expiresInSeconds * 1000L - TOKEN_SAFETY_MARGIN_MILLIS);
            cachedAccessToken = token;
            accessTokenExpiresAtMillis = System.currentTimeMillis() + ttlMillis;
            return token;
        }
    }

    private void invalidateAccessToken() {
        synchronized (tokenLock) {
            cachedAccessToken = null;
            accessTokenExpiresAtMillis = 0L;
        }
    }

    // ============================================================== HTTP 调用

    /**
     * 统一的单次请求入口（<b>不重试</b>）：把传输层异常归类成稳定错误码。
     * 仅"access_token 失效"由调用方换票重试一次，且只针对 access_token，不是重放登录 code。
     */
    private WechatHttpTransport.Response call(String method, URI uri, String body,
                                              String operation, long startedAt) {
        try {
            return transport.exchange(method, uri, body);
        } catch (HttpConnectTimeoutException e) {
            throw upstreamFailure(operation, "connect_timeout", startedAt, e);
        } catch (HttpTimeoutException e) {
            throw upstreamFailure(operation, "read_timeout", startedAt, e);
        } catch (InterruptedIOException e) {
            // 部分客户端把读取超时暴露为 SocketTimeoutException
            throw upstreamFailure(operation, "read_timeout", startedAt, e);
        } catch (ConnectException e) {
            throw upstreamFailure(operation, "connect_failed", startedAt, e);
        } catch (IOException e) {
            throw upstreamFailure(operation, "io_error", startedAt, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw upstreamFailure(operation, "interrupted", startedAt, e);
        } catch (RuntimeException e) {
            // 未受检异常（本地缺陷或传输层内部错误）：只记类名——异常消息可能含密钥 URI；
            // 无法证明已完成一次有效交换（code 是否被消费未知）→ 不可重试，绝不签发会话。
            log.warn("微信接口调用出现未预期异常 operation={} category=unchecked_error cause={} elapsedMs={}",
                    operation, e.getClass().getSimpleName(), elapsedMillis(startedAt));
            throw responseInvalid();
        }
    }

    private JsonNode getJson(URI uri, String operation, long startedAt) {
        return readObject(call("GET", uri, null, operation, startedAt), operation);
    }

    private JsonNode postJson(URI uri, String body, String operation, long startedAt) {
        return readObject(call("POST", uri, body, operation, startedAt), operation);
    }

    /** 状态码与 JSON 结构校验：非 200 / 非 JSON / 非对象 → 上游不可用（绝不猜测成功）。 */
    private JsonNode readObject(WechatHttpTransport.Response response, String operation) {
        if (response == null) {
            log.error("微信接口无响应 operation={}", operation);
            throw upstreamRetryable();
        }
        if (response.status() != 200) {
            log.error("微信接口 HTTP 状态异常 operation={} status={}", operation, response.status());
            throw upstreamRetryable();
        }
        String body = response.body();
        if (body == null || body.isBlank()) {
            log.error("微信接口响应为空 operation={}", operation);
            throw responseInvalid();
        }
        JsonNode root;
        try {
            root = json.readTree(body);
        } catch (IOException e) {
            // 正文不打印：可能含 session_key / access_token
            log.error("微信接口响应不是合法 JSON operation={}", operation);
            throw responseInvalid();
        }
        if (root == null || !root.isObject()) {
            log.error("微信接口响应结构异常（非 JSON 对象） operation={}", operation);
            throw responseInvalid();
        }
        return root;
    }

    // ============================================================== 错误分类

    /** 微信业务错误分类（errcode 非 0）。 */
    private ApiException businessFailure(int errcode, String operation, long startedAt) {
        String category;
        ApiException exception;
        if (CODE_INVALID_ERRCODES.contains(errcode)) {
            category = "code_invalid";
            exception = codeInvalid();
        } else if (CONFIG_ERROR_ERRCODES.contains(errcode)) {
            category = "config_invalid";
            exception = configError();
        } else if (errcode == -1 || errcode == 45011) {
            category = "upstream_busy";
            exception = upstreamRetryable();
        } else {
            // 未知 errcode：无法证明重试安全（登录/手机号 code 均一次性，重发只会 40163）
            // → 安全默认 = 不可重试；errcode 已入日志，运维可据此补充分类表。
            category = "upstream_rejected";
            exception = upstreamRejected();
        }
        log.warn("微信接口业务错误 operation={} errcode={} category={} elapsedMs={}",
                operation, errcode, category, elapsedMillis(startedAt));
        return exception;
    }

    /** 上游故障：记录类别与耗时，绝不记录 URL（含 secret）与正文。 */
    private ApiException upstreamFailure(String operation, String category, long startedAt, Throwable cause) {
        log.warn("微信接口调用失败 operation={} category={} elapsedMs={} cause={}",
                operation, category, elapsedMillis(startedAt), cause.getClass().getSimpleName());
        return upstreamRetryable();
    }

    private static long elapsedMillis(long startedAtNanos) {
        return (System.nanoTime() - startedAtNanos) / 1_000_000L;
    }

    // ================================================================ URI 构造

    private URI code2SessionUri(String code) {
        return safeUri(properties.effectiveApiBaseUrl() + "/sns/jscode2session"
                + "?appid=" + encode(properties.getAppId())
                + "&secret=" + encode(properties.getAppSecret())
                + "&js_code=" + encode(code)
                + "&grant_type=authorization_code", "code2session");
    }

    private URI accessTokenUri() {
        return safeUri(properties.effectiveApiBaseUrl() + "/cgi-bin/token"
                + "?grant_type=client_credential"
                + "&appid=" + encode(properties.getAppId())
                + "&secret=" + encode(properties.getAppSecret()), "get_access_token");
    }

    private URI phoneNumberUri(String accessToken) {
        return safeUri(properties.effectiveApiBaseUrl() + "/wxa/business/getuserphonenumber"
                + "?access_token=" + encode(accessToken), "getuserphonenumber");
    }

    /**
     * URI 构造兜底：配置非法（如 api-base-url 含空格/中文）时 {@link URI#create} 抛
     * {@code IllegalArgumentException}，其消息**含完整 URI（内有 AppSecret）**，
     * 一旦冒泡到全局异常处理就会把密钥写进错误日志。此处只记类名并转 503（配置问题，不可重试）。
     */
    private static URI safeUri(String raw, String operation) {
        try {
            return URI.create(raw);
        } catch (RuntimeException e) {
            log.error("微信接口 URI 构造失败 operation={} cause={}（配置非法，未发起请求，密钥未入日志）",
                    operation, e.getClass().getSimpleName());
            throw configError();
        }
    }

    private static String encode(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }

    // ============================================================== 异常构造

    private void requireConfigured(String operation) {
        if (properties.isConfigured()) {
            return;
        }
        log.error("微信登录未配置 operation={} missing={}（显式失败，未伪造 session）",
                operation, properties.missingKeys());
        throw notConfigured();
    }

    /**
     * 503 而非 500：语义是"依赖未就绪"。
     * retryable=false —— 重试不会自愈，需部署侧补齐凭证；避免客户端做无意义的指数退避。
     */
    private static ApiException notConfigured() {
        return new ApiException(CODE_NOT_CONFIGURED, HttpStatus.SERVICE_UNAVAILABLE,
                MESSAGE_NOT_CONFIGURED, false, null);
    }

    /** 注意对外仍用 CODE_NOT_CONFIGURED（AppID/AppSecret 错误对客户端等价于"服务未就绪"），
     *  避免把"我们配错了密钥"这种运维信息暴露给小程序。 */
    private static ApiException configError() {
        return new ApiException(CODE_NOT_CONFIGURED, HttpStatus.SERVICE_UNAVAILABLE,
                MESSAGE_NOT_CONFIGURED, false, null);
    }

    private static ApiException codeInvalid() {
        return new ApiException(CODE_CODE_INVALID, HttpStatus.UNPROCESSABLE_ENTITY,
                MESSAGE_CODE_INVALID, false, null);
    }

    private static ApiException upstreamRetryable() {
        return new ApiException(CODE_UPSTREAM, HttpStatus.SERVICE_UNAVAILABLE,
                MESSAGE_UPSTREAM, true, null);
    }

    /**
     * 上游返回无法分类的业务错误（未知 errcode）：503 + 不可重试。
     * 安全默认——未知 errcode 无法证明"重试会改善"，而登录/手机号 code 均一次性，
     * 客户端按 retryable=true 重发只会拿到 40163；让用户重新进入小程序换取新 code 才是正解。
     */
    private static ApiException upstreamRejected() {
        return new ApiException(CODE_UPSTREAM_REJECTED, HttpStatus.SERVICE_UNAVAILABLE,
                MESSAGE_UPSTREAM_REJECTED, false, null);
    }

    private static ApiException responseInvalid() {
        return new ApiException(CODE_RESPONSE_INVALID, HttpStatus.SERVICE_UNAVAILABLE,
                MESSAGE_RESPONSE_INVALID, false, null);
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }

    private static String escapeJson(String raw) {
        StringBuilder sb = new StringBuilder(raw.length() + 8);
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.toString();
    }
}
