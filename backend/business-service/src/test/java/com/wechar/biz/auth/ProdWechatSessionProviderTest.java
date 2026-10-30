package com.wechar.biz.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.wechar.biz.common.ApiException;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.URI;
import java.net.http.HttpConnectTimeoutException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;

/**
 * 生产微信适配器的<b>单元</b>测试（不起 Spring 上下文、不触网）：
 * 用可编程的 {@link FakeTransport} 驱动错误分类、响应校验、日志脱敏与"失败不伪造会话"。
 *
 * <p>真实 HTTP 语义（真实连接、真实读取超时、真实状态码）另由
 * {@link ProdWechatSessionProviderHttpTest} 覆盖；两者都不是真实微信联调。</p>
 */
class ProdWechatSessionProviderTest {

    private static final String APP_ID = "wx-test-app-id";
    /** 测试专用假值：不是真实密钥，仅用于验证"日志里不能出现它"。 */
    private static final String APP_SECRET = "unit-test-secret-value-not-real";
    private static final String SESSION_KEY = "unit-test-session-key-not-real";
    private static final String OPENID = "unit-test-openid";

    private final ListAppender<ILoggingEvent> logs = new ListAppender<>();
    private Logger providerLogger;

    @AfterEach
    void detachLogger() {
        if (providerLogger != null) {
            providerLogger.detachAppender(logs);
            providerLogger = null;
        }
    }

    // ------------------------------------------------------------------ 配置

    @Test
    void 凭证缺失_登录返回503_且显式失败不伪造身份() {
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(new WechatMiniProgramProperties());

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("any-code"));
        assertEquals(ProdWechatSessionProvider.CODE_NOT_CONFIGURED, ex.getCode());
        assertEquals("WECHAT_PROVIDER_UNAVAILABLE", ex.getCode(), "错误码须稳定，供客户端/监控识别");
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatus(), "依赖未就绪应为 503，而非 500");
        assertFalse(ex.isRetryable(), "配置缺失重试不会自愈，不应标记可重试");
        assertTrue(ex.getMessage() != null && !ex.getMessage().isBlank(), "必须给出可读文案");
    }

    @Test
    void 只配了AppId缺AppSecret_同样503_并记录缺失键名() {
        FakeTransport transport = new FakeTransport();
        WechatMiniProgramProperties props = props();
        props.setAppSecret("");
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props, transport);
        attachLogCapture();

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-1"));
        assertEquals(ProdWechatSessionProvider.CODE_NOT_CONFIGURED, ex.getCode());
        assertEquals(0, transport.calls(), "配置缺失时不得发起任何上游请求");
        assertTrue(logText().contains("app-secret"), "服务端日志应写明缺失的配置键名（便于运维定位）");
        assertFalse(logText().contains(APP_SECRET), "日志不得包含密钥值");
    }

    @Test
    void 凭证缺失_解手机号返回503_且不返回伪造号码() {
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(new WechatMiniProgramProperties());
        ApiException ex = assertThrows(ApiException.class, () -> provider.getPhoneNumberByCode("any-phone-code"));
        assertEquals(ProdWechatSessionProvider.CODE_NOT_CONFIGURED, ex.getCode());
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatus());
        assertFalse(ex.isRetryable());
    }

    @Test
    void 对外文案不包含密钥或凭证细节() {
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(new WechatMiniProgramProperties());
        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("secret-ish-code"));
        String msg = ex.getMessage();
        assertNotNull(msg);
        assertFalse(msg.toLowerCase().contains("appsecret"), "文案不得出现 AppSecret");
        assertFalse(msg.toLowerCase().contains("secret"), "文案不得出现 secret 字样");
        assertFalse(msg.contains("api.weixin.qq.com"), "文案不得暴露上游地址");
        assertFalse(msg.contains("secret-ish-code"), "文案不得回显输入的 code");
    }

    // ------------------------------------------------------------------ 正常路径

    @Test
    void 正常响应_返回openid与sessionKey_不伪造昵称() {
        FakeTransport transport = new FakeTransport().then(ok(
                "{\"openid\":\"" + OPENID + "\",\"session_key\":\"" + SESSION_KEY + "\"}"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        WechatSessionInfo info = provider.getSessionByCode("code-ok-1");

        assertEquals(OPENID, info.openid());
        assertEquals(SESSION_KEY, info.sessionKey(), "session_key 仅进程内传递，供服务端使用");
        assertNull(info.nickname(), "code2session 不再返回昵称，不得编造");
        assertEquals(1, transport.calls());
        String uri = transport.uri(0).toString();
        assertTrue(uri.startsWith("https://api.weixin.qq.com/sns/jscode2session?"), "须为官方 code2session 端点");
        assertTrue(uri.contains("js_code=code-ok-1"), "须携带 wx.login 的 code");
        assertTrue(uri.contains("grant_type=authorization_code"), "须为 authorization_code 授权类型");
        assertTrue(uri.contains("appid=" + APP_ID), "须携带 AppId");
    }

    @Test
    void 正常响应_code与session_key不进日志() {
        FakeTransport transport = new FakeTransport().then(ok(
                "{\"openid\":\"" + OPENID + "\",\"session_key\":\"" + SESSION_KEY + "\"}"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);
        attachLogCapture();

        provider.getSessionByCode("code-must-not-be-logged");

        String text = logText();
        assertFalse(text.contains(SESSION_KEY), "日志不得包含 session_key");
        assertFalse(text.contains("code-must-not-be-logged"), "日志不得包含登录 code");
        assertFalse(text.contains(APP_SECRET), "日志不得包含 AppSecret");
    }

    // -------------------------------------------------------- 微信业务错误分类

    @Test
    void code无效_40029_返回422不可重试() {
        assertBusinessError(40029, ProdWechatSessionProvider.CODE_CODE_INVALID,
                HttpStatus.UNPROCESSABLE_ENTITY, false);
    }

    @Test
    void code已被使用_40163_返回422不可重试() {
        assertBusinessError(40163, ProdWechatSessionProvider.CODE_CODE_INVALID,
                HttpStatus.UNPROCESSABLE_ENTITY, false);
    }

    @Test
    void AppSecret错误_40125_返回503不可重试() {
        assertBusinessError(40125, ProdWechatSessionProvider.CODE_NOT_CONFIGURED,
                HttpStatus.SERVICE_UNAVAILABLE, false);
    }

    @Test
    void AppId错误_40013_返回503不可重试() {
        assertBusinessError(40013, ProdWechatSessionProvider.CODE_NOT_CONFIGURED,
                HttpStatus.SERVICE_UNAVAILABLE, false);
    }

    @Test
    void 系统繁忙_负1_返回503可重试() {
        assertBusinessError(-1, ProdWechatSessionProvider.CODE_UPSTREAM,
                HttpStatus.SERVICE_UNAVAILABLE, true);
    }

    @Test
    void 频率限制_45011_返回503可重试() {
        assertBusinessError(45011, ProdWechatSessionProvider.CODE_UPSTREAM,
                HttpStatus.SERVICE_UNAVAILABLE, true);
    }

    @Test
    void 未知业务错误_安全默认503不可重试_且日志含errcode但不含正文() {
        FakeTransport transport = new FakeTransport().then(ok(
                "{\"errcode\":99999,\"errmsg\":\"unknown\",\"session_key\":\"" + SESSION_KEY + "\"}"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);
        attachLogCapture();

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-x"));
        assertEquals(ProdWechatSessionProvider.CODE_UPSTREAM_REJECTED, ex.getCode(),
                "未知 errcode 不得沿用可重试的 WECHAT_UPSTREAM_UNAVAILABLE");
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatus());
        assertFalse(ex.isRetryable(), "未知 errcode 无法证明重试安全 → 安全默认不可重试");
        assertEquals(1, transport.calls(), "不可重试语义下不得重发登录 code");
        String text = logText();
        assertTrue(text.contains("99999"), "日志应保留 errcode 便于定位");
        assertTrue(text.contains("upstream_rejected"), "日志应记录分类，便于运维补充分类表");
        assertFalse(text.contains(SESSION_KEY), "日志不得包含响应正文中的 session_key");
    }

    @Test
    void 未知业务错误_文案引导重新进入小程序_不含密钥与上游地址() {
        FakeTransport transport = new FakeTransport().then(ok("{\"errcode\":88888,\"errmsg\":\"mystery\"}"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-x"));
        assertFalse(ex.getMessage().toLowerCase().contains("secret"));
        assertFalse(ex.getMessage().contains("api.weixin.qq.com"));
        assertFalse(ex.getMessage().contains("mystery"), "不得透传上游 errmsg 正文");
    }

    @Test
    void api_base_url非法_503不可重试_且密钥不进异常与日志() {
        WechatMiniProgramProperties badProps = props();
        badProps.setApiBaseUrl("http://bad host/weixin"); // 含空格 → URI.create 必失败
        FakeTransport transport = new FakeTransport();
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(badProps, transport);
        attachLogCapture();

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-x"));
        assertEquals(ProdWechatSessionProvider.CODE_NOT_CONFIGURED, ex.getCode());
        assertFalse(ex.isRetryable());
        assertEquals(0, transport.calls(), "URI 构造失败不得发起任何上游请求");
        assertFalse(logText().contains(APP_SECRET), "URI 构造异常的日志不得包含密钥");
    }

    @Test
    void 传输层未受检异常_503不可重试_日志只记类名不含密钥() {
        FakeTransport transport = new FakeTransport()
                .thenThrow(new IllegalStateException("boom uri-had-secret " + APP_SECRET));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);
        attachLogCapture();

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-x"));
        assertEquals(ProdWechatSessionProvider.CODE_RESPONSE_INVALID, ex.getCode());
        assertFalse(ex.isRetryable(), "未受检异常无法证明 code 未被消费 → 不可重试");
        assertEquals(1, transport.calls());
        assertTrue(logText().contains("IllegalStateException"), "日志应记录异常类名便于定位");
        assertFalse(logText().contains(APP_SECRET), "未受检异常消息不得进入日志");
    }

    @Test
    void token端点系统繁忙_可重试() {
        FakeTransport transport = new FakeTransport().then(ok("{\"errcode\":-1,\"errmsg\":\"system busy\"}"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getPhoneNumberByCode("phone-code-busy"));
        assertEquals(ProdWechatSessionProvider.CODE_UPSTREAM, ex.getCode());
        assertTrue(ex.isRetryable(), "-1 系统繁忙是可证明的可重试语义");
        assertEquals(1, transport.calls());
    }

    @Test
    void token端点凭证错误40001_503不可重试() {
        FakeTransport transport = new FakeTransport().then(ok("{\"errcode\":40001,\"errmsg\":\"invalid credential\"}"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getPhoneNumberByCode("phone-code-cred"));
        assertEquals(ProdWechatSessionProvider.CODE_NOT_CONFIGURED, ex.getCode(),
                "新取 access_token 即报凭证错误 = AppID/AppSecret 配置问题");
        assertFalse(ex.isRetryable());
    }

    // ------------------------------------------------- 网络异常 / 超时 / 上游 5xx

    @Test
    void 连接超时_返回503可重试() {
        assertTransportFailure(new HttpConnectTimeoutException("connect timed out"));
    }

    @Test
    void 读取超时_返回503可重试() {
        assertTransportFailure(new InterruptedIOException("Read timed out"));
    }

    @Test
    void 连接被拒_返回503可重试() {
        assertTransportFailure(new java.net.ConnectException("Connection refused"));
    }

    @Test
    void 其它IO异常_返回503可重试() {
        assertTransportFailure(new IOException("broken pipe"));
    }

    @Test
    void 中断异常_恢复中断标志并返回503() {
        FakeTransport transport = new FakeTransport().thenThrow(new InterruptedException("stop"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-1"));
        assertEquals(ProdWechatSessionProvider.CODE_UPSTREAM, ex.getCode());
        assertTrue(Thread.currentThread().isInterrupted(), "中断标志必须被恢复，否则会吞掉停机信号");
        Thread.interrupted(); // 清理标志，避免污染后续用例
    }

    @Test
    void 上游HTTP503_返回503可重试() {
        FakeTransport transport = new FakeTransport().then(
                status(503, "upstream down"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-1"));
        assertEquals(ProdWechatSessionProvider.CODE_UPSTREAM, ex.getCode());
        assertTrue(ex.isRetryable());
    }

    // ------------------------------------------------------------ 响应格式异常

    @Test
    void 缺失openid_返回503响应异常_不得当成登录成功() {
        FakeTransport transport = new FakeTransport().then(
                ok("{\"session_key\":\"" + SESSION_KEY + "\"}"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-1"));
        assertEquals(ProdWechatSessionProvider.CODE_RESPONSE_INVALID, ex.getCode());
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatus());
        assertFalse(ex.isRetryable(), "结构异常重试不会自愈");
    }

    @Test
    void openid为空串_同样视为响应异常() {
        FakeTransport transport = new FakeTransport().then(
                ok("{\"openid\":\"  \",\"session_key\":\"k\"}"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-1"));
        assertEquals(ProdWechatSessionProvider.CODE_RESPONSE_INVALID, ex.getCode());
    }

    @Test
    void 响应不是JSON_返回503响应异常() {
        FakeTransport transport = new FakeTransport().then(
                ok("<html>gateway error</html>"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);
        attachLogCapture();

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-1"));
        assertEquals(ProdWechatSessionProvider.CODE_RESPONSE_INVALID, ex.getCode());
        assertFalse(logText().contains("gateway error"), "日志不得打印上游完整正文");
    }

    @Test
    void 响应是JSON数组_返回503响应异常() {
        FakeTransport transport = new FakeTransport().then(
                ok("[{\"openid\":\"x\"}]"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-1"));
        assertEquals(ProdWechatSessionProvider.CODE_RESPONSE_INVALID, ex.getCode());
    }

    @Test
    void 响应正文为空_返回503响应异常() {
        FakeTransport transport = new FakeTransport().then(ok(""));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-1"));
        assertEquals(ProdWechatSessionProvider.CODE_RESPONSE_INVALID, ex.getCode());
    }

    @Test
    void 空白code_不打上游直接422() {
        FakeTransport transport = new FakeTransport();
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("   "));
        assertEquals(ProdWechatSessionProvider.CODE_CODE_INVALID, ex.getCode());
        assertEquals(0, transport.calls(), "空 code 不应浪费一次上游请求");
    }

    // ---------------------------------------------------------------- 辅助

    private void assertBusinessError(int errcode, String expectedCode, HttpStatus status, boolean retryable) {
        FakeTransport transport = new FakeTransport().then(ok(
                "{\"errcode\":" + errcode + ",\"errmsg\":\"wechat says no\"}"));
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);
        attachLogCapture();

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-biz"));
        assertEquals(expectedCode, ex.getCode(), "errcode=" + errcode + " 的错误码映射不符");
        assertEquals(status, ex.getStatus());
        assertEquals(retryable, ex.isRetryable());
        assertEquals(1, transport.calls(), "业务错误不应自动重试（code 一次性）");
        String text = logText();
        assertTrue(text.contains(String.valueOf(errcode)), "日志应保留 errcode");
        assertFalse(text.toLowerCase().contains("wechat says no"), "日志不得转储 errmsg 正文");
    }

    private void assertTransportFailure(Throwable failure) {
        FakeTransport transport = new FakeTransport().thenThrow(failure);
        ProdWechatSessionProvider provider = new ProdWechatSessionProvider(props(), transport);
        attachLogCapture();

        ApiException ex = assertThrows(ApiException.class, () -> provider.getSessionByCode("code-net"));
        assertEquals(ProdWechatSessionProvider.CODE_UPSTREAM, ex.getCode());
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatus());
        assertTrue(ex.isRetryable(), "网络类故障可重试");
        assertEquals(1, transport.calls(), "不得无限重试登录请求");
        assertFalse(logText().contains(APP_SECRET), "日志不得包含 AppSecret");
    }

    private static WechatHttpTransport.Response ok(String body) {
        return new WechatHttpTransport.Response(200, body);
    }

    private static WechatHttpTransport.Response status(int status, String body) {
        return new WechatHttpTransport.Response(status, body);
    }

    private static WechatMiniProgramProperties props() {
        WechatMiniProgramProperties props = new WechatMiniProgramProperties();
        props.setAppId(APP_ID);
        props.setAppSecret(APP_SECRET);
        props.setApiBaseUrl("https://api.weixin.qq.com");
        return props;
    }

    private void attachLogCapture() {
        providerLogger = (Logger) LoggerFactory.getLogger(ProdWechatSessionProvider.class);
        logs.start();
        providerLogger.addAppender(logs);
    }

    private String logText() {
        StringBuilder sb = new StringBuilder();
        for (ILoggingEvent event : logs.list) {
            sb.append(event.getFormattedMessage()).append('\n');
        }
        return sb.toString();
    }

    /** 可编程传输层：按顺序回放响应或抛异常，并记录请求。 */
    static final class FakeTransport implements WechatHttpTransport {

        private final Deque<Object> steps = new ArrayDeque<>();
        private final List<URI> uris = new ArrayList<>();
        private final List<String> methods = new ArrayList<>();
        private final List<String> bodies = new ArrayList<>();

        FakeTransport then(Response response) {
            steps.add(response);
            return this;
        }

        FakeTransport thenThrow(Throwable failure) {
            steps.add(failure);
            return this;
        }

        int calls() {
            return uris.size();
        }

        URI uri(int index) {
            return uris.get(index);
        }

        @Override
        public Response exchange(String method, URI uri, String jsonBody) throws IOException, InterruptedException {
            uris.add(uri);
            methods.add(method);
            bodies.add(jsonBody);
            Object step = steps.poll();
            if (step == null) {
                throw new AssertionError("未预期的第 " + uris.size() + " 次上游请求（脚本未预置响应）");
            }
            if (step instanceof IOException io) {
                throw io;
            }
            if (step instanceof InterruptedException interrupted) {
                throw interrupted;
            }
            if (step instanceof RuntimeException runtime) {
                throw runtime;
            }
            if (step instanceof Error error) {
                throw error;
            }
            return (Response) step;
        }
    }
}
