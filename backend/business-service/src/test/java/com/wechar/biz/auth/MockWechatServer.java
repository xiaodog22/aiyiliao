package com.wechar.biz.auth;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 受控 HTTP mock：本地 loopback 上起一个真实 HTTP 服务，按注册的路由回放脚本化响应。
 *
 * <p><b>边界声明（必须如实传达）</b>：本类用于验证"代码在真实 HTTP 语义下
 * （真实连接、真实读取超时、真实状态码与正文）的行为是否正确"，<b>不是</b>真实微信联调，
 * 也不能替代真实 AppID/AppSecret 的端到端验证。测试报告须把两者分开陈述。</p>
 *
 * <p>用法：{@code mock.route("/sns/jscode2session", req -> Resp.ok(body))}；
 * 需要按请求参数分支时直接读 {@link Captured#query()}。</p>
 */
public final class MockWechatServer implements AutoCloseable {

    /** 回放响应：状态码 + 正文 + 可选的模拟延迟（毫秒）。 */
    public record Resp(int status, String body, long delayMillis) {
        public static Resp ok(String body) {
            return new Resp(200, body, 0);
        }

        public static Resp status(int status, String body) {
            return new Resp(status, body, 0);
        }

        /** 延迟响应：用于制造真实的"读取超时"。 */
        public static Resp delayed(String body, long delayMillis) {
            return new Resp(200, body, delayMillis);
        }
    }

    /** 捕获到的请求（路径已去掉查询串，查询串单独保留，便于断言参数是否齐全）。 */
    public record Captured(String method, String path, String query, String body) {
    }

    /** 路由处理器。 */
    @FunctionalInterface
    public interface Handler {
        Resp handle(Captured request) throws Exception;
    }

    private final HttpServer server;
    private final Map<String, Handler> routes = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> hits = new ConcurrentHashMap<>();
    private final Map<String, Captured> last = new ConcurrentHashMap<>();

    public MockWechatServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", this::dispatch);
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();
    }

    /** 注册/替换某路径的响应逻辑（后注册覆盖先注册）。 */
    public MockWechatServer route(String path, Handler handler) {
        routes.put(path, handler);
        return this;
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** 某路径累计被请求次数（用于验证 access_token 缓存是否生效）。 */
    public int hits(String path) {
        AtomicInteger counter = hits.get(path);
        return counter == null ? 0 : counter.get();
    }

    /** 某路径最近一次请求（null = 未发生过）。 */
    public Captured last(String path) {
        return last.get(path);
    }

    public void resetHits() {
        hits.clear();
        last.clear();
    }

    private void dispatch(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        String query = exchange.getRequestURI().getRawQuery();
        String body = readBody(exchange);
        String method = exchange.getRequestMethod();
        hits.computeIfAbsent(path, k -> new AtomicInteger()).incrementAndGet();
        last.put(path, new Captured(method, path, query, body));

        Handler handler = routes.get(path);
        Resp response;
        if (handler == null) {
            response = Resp.status(404, "{\"errcode\":-404,\"errmsg\":\"mock route not registered\"}");
        } else {
            try {
                response = handler.handle(new Captured(method, path, query, body));
            } catch (Exception e) {
                response = Resp.status(500, "{\"errcode\":-500,\"errmsg\":\"mock handler error\"}");
            }
        }
        if (response.delayMillis() > 0) {
            try {
                Thread.sleep(response.delayMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        byte[] payload = response.body() == null ? new byte[0] : response.body().getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(response.status(), payload.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(payload);
        }
    }

    private static String readBody(HttpExchange exchange) throws IOException {
        try (InputStream in = exchange.getRequestBody()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
