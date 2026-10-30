package com.wechar.biz.auth;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * 微信开放接口的 HTTP 传输层（端口-适配器，便于"受控 mock"验证）。
 *
 * <p>约束（与任务红线一致）：</p>
 * <ul>
 *   <li><b>不重试</b>：登录 code 是一次性凭证，重复提交只会拿到 40163；重试由调用方
 *       按错误类别决定，且最多一次（仅"access_token 失效"需要换票重试）。</li>
 *   <li><b>显式超时</b>：建连超时 + 单请求读取超时，均由配置给定，不出现无限等待。</li>
 *   <li><b>不记录</b>：URI（含 appid/secret/js_code）与响应正文一律不入日志。</li>
 * </ul>
 */
public interface WechatHttpTransport {

    /**
     * 发起一次请求（不做任何重试）。
     *
     * @param method   "GET" 或 "POST"
     * @param uri      完整 URI（含查询串；其中可能含密钥，禁止打日志）
     * @param jsonBody POST 请求体（GET 传 null）
     * @return 状态码 + 响应正文
     */
    Response exchange(String method, URI uri, String jsonBody) throws IOException, InterruptedException;

    /** 上游响应：仅状态码与正文（正文不落日志）。 */
    record Response(int status, String body) {
    }

    /** JDK {@link HttpClient} 实现：零额外依赖，超时显式。 */
    final class Jdk implements WechatHttpTransport {

        private final HttpClient client;
        private final Duration readTimeout;

        public Jdk(int connectTimeoutMs, int readTimeoutMs) {
            this.readTimeout = Duration.ofMillis(readTimeoutMs > 0 ? readTimeoutMs : 5000);
            this.client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofMillis(connectTimeoutMs > 0 ? connectTimeoutMs : 3000))
                    .followRedirects(HttpClient.Redirect.NEVER)
                    .build();
        }

        @Override
        public Response exchange(String method, URI uri, String jsonBody) throws IOException, InterruptedException {
            HttpRequest.Builder builder = HttpRequest.newBuilder(uri).timeout(readTimeout);
            if ("POST".equalsIgnoreCase(method)) {
                builder.header("Content-Type", "application/json; charset=utf-8")
                        .POST(HttpRequest.BodyPublishers.ofString(jsonBody == null ? "" : jsonBody,
                                StandardCharsets.UTF_8));
            } else {
                builder.GET();
            }
            HttpResponse<String> response = client.send(builder.build(),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            return new Response(response.statusCode(), response.body());
        }
    }
}
