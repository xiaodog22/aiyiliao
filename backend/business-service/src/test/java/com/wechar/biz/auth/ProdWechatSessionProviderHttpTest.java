package com.wechar.biz.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.wechar.biz.common.ApiException;
import java.net.ServerSocket;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/**
 * 生产微信适配器的<b>真实 HTTP</b> 测试：请求经 JDK HttpClient 打到本地 loopback 上的
 * {@link MockWechatServer}，覆盖真实连接、真实读取超时、真实状态码与正文解析。
 *
 * <p><b>这仍然不是真实微信联调</b>：上游是我们自己起的 mock，没有使用真实 AppID/AppSecret，
 * 也不能证明微信侧的接口行为。真实联调见报告"阻塞项"。</p>
 */
class ProdWechatSessionProviderHttpTest {

    private static final String APP_ID = "wx-http-test-app-id";
    private static final String APP_SECRET = "http-test-secret-value-not-real";

    private MockWechatServer mock;

    @BeforeEach
    void startMock() throws Exception {
        mock = new MockWechatServer();
    }

    @AfterEach
    void stopMock() {
        mock.close();
    }

    // ------------------------------------------------------------------ 登录

    @Test
    void 真实HTTP_正常响应_解析openid() {
        mock.route("/sns/jscode2session", req -> MockWechatServer.Resp.ok(
                "{\"openid\":\"openid-http-1\",\"session_key\":\"sk-http-1\"}"));
        ProdWechatSessionProvider provider = provider(mock.baseUrl(), 1000, 1000);

        WechatSessionInfo info = provider.getSessionByCode("code-http-1");

        assertEquals("openid-http-1", info.openid());
        assertEquals("sk-http-1", info.sessionKey());
        MockWechatServer.Captured captured = mock.last("/sns/jscode2session");
        assertEquals("GET", captured.method());
        assertTrue(captured.query().contains("appid=" + APP_ID));
        assertTrue(captured.query().contains("grant_type=authorization_code"));
        assertTrue(captured.query().contains("js_code=code-http-1"));
        assertEquals(1, mock.hits("/sns/jscode2session"), "登录 code 只消费一次，不重试");
    }

    @Test
    void 真实HTTP_业务错误40029_返回422() {
        mock.route("/sns/jscode2session", req -> MockWechatServer.Resp.ok(
                "{\"errcode\":40029,\"errmsg\":\"invalid code\"}"));
        ProdWechatSessionProvider provider = provider(mock.baseUrl(), 1000, 1000);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-http-2"));
        assertEquals(ProdWechatSessionProvider.CODE_CODE_INVALID, ex.getCode());
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, ex.getStatus());
        assertEquals(1, mock.hits("/sns/jscode2session"));
    }

    @Test
    void 真实HTTP_上游500_返回503可重试() {
        mock.route("/sns/jscode2session", req -> MockWechatServer.Resp.status(500, "{\"errcode\":-1}"));
        ProdWechatSessionProvider provider = provider(mock.baseUrl(), 1000, 1000);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-http-3"));
        assertEquals(ProdWechatSessionProvider.CODE_UPSTREAM, ex.getCode());
        assertTrue(ex.isRetryable());
    }

    @Test
    void 真实HTTP_读取超时_返回503可重试() {
        mock.route("/sns/jscode2session", req -> MockWechatServer.Resp.delayed(
                "{\"openid\":\"too-late\",\"session_key\":\"k\"}", 1200));
        // 读取超时 200ms < 上游 1200ms 延迟
        ProdWechatSessionProvider provider = provider(mock.baseUrl(), 500, 200);

        long startedAt = System.nanoTime();
        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-http-4"));
        long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000L;

        assertEquals(ProdWechatSessionProvider.CODE_UPSTREAM, ex.getCode());
        assertTrue(ex.isRetryable());
        assertTrue(elapsedMs < 1100, "读取超时必须生效（实际耗时 " + elapsedMs + "ms），不得无限等待");
    }

    @Test
    void 真实HTTP_连接被拒_返回503可重试() throws Exception {
        int closedPort;
        try (ServerSocket socket = new ServerSocket(0)) {
            closedPort = socket.getLocalPort();
        } // 关闭后该端口上无人监听
        ProdWechatSessionProvider provider = provider("http://127.0.0.1:" + closedPort, 300, 300);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-http-5"));
        assertEquals(ProdWechatSessionProvider.CODE_UPSTREAM, ex.getCode());
        assertTrue(ex.isRetryable());
    }

    @Test
    void 真实HTTP_建连超时_返回503可重试() {
        // 用极短建连超时 + 不可路由地址模拟建连超时；若环境直接返回不可达，
        // 同样应落到"上游不可用（可重试）"，断言只依赖该稳定语义。
        ProdWechatSessionProvider provider = provider("http://10.255.255.1:81", 50, 300);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-http-6"));
        assertEquals(ProdWechatSessionProvider.CODE_UPSTREAM, ex.getCode());
        assertTrue(ex.isRetryable());
    }

    // ------------------------------------------------------------------ 手机号

    @Test
    void 手机号_正常解密_且access_token被缓存复用() {
        mock.route("/cgi-bin/token", req -> MockWechatServer.Resp.ok(
                "{\"access_token\":\"token-1\",\"expires_in\":7200}"));
        mock.route("/wxa/business/getuserphonenumber", req -> MockWechatServer.Resp.ok(
                "{\"errcode\":0,\"errmsg\":\"ok\",\"phone_info\":{\"phoneNumber\":\"13800001111\","
                        + "\"purePhoneNumber\":\"13800001111\",\"countryCode\":\"86\"}}"));
        ProdWechatSessionProvider provider = provider(mock.baseUrl(), 1000, 1000);

        assertEquals("13800001111", provider.getPhoneNumberByCode("phone-code-1"));
        assertEquals("13800001111", provider.getPhoneNumberByCode("phone-code-2"));

        assertEquals(1, mock.hits("/cgi-bin/token"), "access_token 应缓存复用（同一 token 只取一次）");
        assertEquals(2, mock.hits("/wxa/business/getuserphonenumber"));
        MockWechatServer.Captured captured = mock.last("/wxa/business/getuserphonenumber");
        assertEquals("POST", captured.method());
        assertTrue(captured.query().contains("access_token=token-1"));
        assertTrue(captured.body().contains("phone-code-2"));
    }

    @Test
    void 手机号_令牌无效_返回null交由调用层422() {
        mock.route("/cgi-bin/token", req -> MockWechatServer.Resp.ok(
                "{\"access_token\":\"token-2\",\"expires_in\":7200}"));
        mock.route("/wxa/business/getuserphonenumber", req -> MockWechatServer.Resp.ok(
                "{\"errcode\":40163,\"errmsg\":\"code been used\"}"));
        ProdWechatSessionProvider provider = provider(mock.baseUrl(), 1000, 1000);

        assertNull(provider.getPhoneNumberByCode("phone-code-used"));
    }

    @Test
    void 手机号_access_token失效_换票后重试一次并成功() {
        AtomicInteger tokenCalls = new AtomicInteger();
        mock.route("/cgi-bin/token", req -> MockWechatServer.Resp.ok(
                "{\"access_token\":\"token-" + tokenCalls.incrementAndGet() + "\",\"expires_in\":7200}"));
        AtomicInteger phoneCalls = new AtomicInteger();
        mock.route("/wxa/business/getuserphonenumber", req -> {
            int call = phoneCalls.incrementAndGet();
            if (call == 1) {
                return MockWechatServer.Resp.ok("{\"errcode\":40001,\"errmsg\":\"invalid credential\"}");
            }
            return MockWechatServer.Resp.ok("{\"errcode\":0,\"phone_info\":{\"purePhoneNumber\":\"13900002222\"}}");
        });
        ProdWechatSessionProvider provider = provider(mock.baseUrl(), 1000, 1000);

        assertEquals("13900002222", provider.getPhoneNumberByCode("phone-code-retry"));
        assertEquals(2, phoneCalls.get(), "失效票只换一次并重试一次，不无限重试");
        assertEquals(2, mock.hits("/cgi-bin/token"), "换票应重新取 token");
    }

    @Test
    void 手机号_响应缺号码字段_返回503响应异常() {
        mock.route("/cgi-bin/token", req -> MockWechatServer.Resp.ok(
                "{\"access_token\":\"token-3\",\"expires_in\":7200}"));
        mock.route("/wxa/business/getuserphonenumber", req -> MockWechatServer.Resp.ok(
                "{\"errcode\":0,\"phone_info\":{}}"));
        ProdWechatSessionProvider provider = provider(mock.baseUrl(), 1000, 1000);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getPhoneNumberByCode("phone-code-x"));
        assertEquals(ProdWechatSessionProvider.CODE_RESPONSE_INVALID, ex.getCode());
        assertFalse(ex.isRetryable());
    }

    @Test
    void 手机号_token接口业务错误_返回503不可重试() {
        mock.route("/cgi-bin/token", req -> MockWechatServer.Resp.ok(
                "{\"errcode\":40125,\"errmsg\":\"invalid appsecret\"}"));
        ProdWechatSessionProvider provider = provider(mock.baseUrl(), 1000, 1000);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getPhoneNumberByCode("phone-code-y"));
        assertEquals(ProdWechatSessionProvider.CODE_NOT_CONFIGURED, ex.getCode());
        assertFalse(ex.isRetryable());
    }

    private static ProdWechatSessionProvider provider(String baseUrl, int connectTimeoutMs, int readTimeoutMs) {
        WechatMiniProgramProperties props = new WechatMiniProgramProperties();
        props.setAppId(APP_ID);
        props.setAppSecret(APP_SECRET);
        props.setApiBaseUrl(baseUrl);
        props.setConnectTimeoutMs(connectTimeoutMs);
        props.setReadTimeoutMs(readTimeoutMs);
        return new ProdWechatSessionProvider(props);
    }
}
