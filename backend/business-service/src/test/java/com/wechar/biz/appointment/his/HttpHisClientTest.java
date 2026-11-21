package com.wechar.biz.appointment.his;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * HttpHisClient 与 clinic-his /openapi/v1/* 的契约测试（用 JDK 内置 HttpServer 冒充院方）。
 *
 * <p>钉死三件事：
 * <ol>
 *   <li>签名串逐字符对齐（METHOD\nPATH\nappId\ntimestamp\nnonce\nsha256hex(body)）；</li>
 *   <li>主数据不一致（诊所返回 NOT_FOUND）时按 fallback 映射重试一次，且复用同一 Idempotency-Key；</li>
 *   <li>院方非 2xx 一律抛异常（由 HisGateway 转 503），绝不返回「看似成功」的结果。</li>
 * </ol>
 */
class HttpHisClientTest {

    private static final String APP_ID = "wechar-mini";
    private static final String SECRET = "test-secret-0001";

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<HttpServer> servers = new ArrayList<>();

    @AfterEach
    void stopServers() {
        servers.forEach(s -> s.stop(0));
        servers.clear();
    }

    @Test
    void 主数据不同源时按映射重试并返回受理单号() throws Exception {
        List<Captured> captured = new CopyOnWriteArrayList<>();
        HttpServer server = start(exchange -> {
            byte[] body = exchange.getRequestBody().readAllBytes();
            String path = exchange.getRequestURI().getPath();
            String appId = exchange.getRequestHeaders().getFirst("X-App-Id");
            String timestamp = exchange.getRequestHeaders().getFirst("X-Timestamp");
            String nonce = exchange.getRequestHeaders().getFirst("X-Nonce");
            String signature = exchange.getRequestHeaders().getFirst("X-Signature");
            String idem = exchange.getRequestHeaders().getFirst("Idempotency-Key");
            boolean signatureOk = sign(path, appId, timestamp, nonce, body).equals(signature);
            captured.add(new Captured(path, idem, signatureOk, new String(body, StandardCharsets.UTF_8)));

            JsonNode request = mapper.readTree(body);
            if (!"QK".equals(request.path("departmentId").asText())) {
                respond(exchange, 404, "{\"code\":\"NOT_FOUND\",\"message\":\"科室不存在\"}");
                return;
            }
            respond(exchange, 201, "{\"code\":\"OK\",\"data\":{\"hisOrderNo\":\"CLN20261119-000001\","
                    + "\"status\":\"ACCEPTED\",\"replayed\":false}}");
        });

        HttpHisClient client = new HttpHisClient(mapper, "http://127.0.0.1:" + server.getAddress().getPort() + "/",
                APP_ID, SECRET, 2000, true, "D001", "QK", null);

        HisClient.HisBookingResult result = client.book(new HisClient.HisBookingCommand(
                "ap-4f0c5c62-1111-2222-3333-444455556666", "slot-future-1", "演示患者", "doc-gp-1", "dep-gp"));

        assertEquals("CLN20261119-000001", result.hisOrderNo());
        assertEquals("HIS_MOCK", result.source());
        assertTrue(result.mock(), "demo=true 时必须标记为演示受理");

        assertEquals(2, captured.size(), "首次 NOT_FOUND 后应重试一次");
        Captured first = captured.get(0);
        Captured retry = captured.get(1);
        assertTrue(first.signatureOk(), "首次请求签名必须与契约一致");
        assertTrue(retry.signatureOk(), "重试请求签名必须与契约一致");
        assertTrue(first.body().contains("\"dep-gp\""));
        assertTrue(retry.body().contains("\"D001\"") && retry.body().contains("\"QK\""));
        assertEquals(first.idemKey(), retry.idemKey(), "重试必须复用同一 Idempotency-Key");
        assertTrue(first.idemKey().length() >= 8 && first.idemKey().length() <= 128);
    }

    @Test
    void 院方报错时抛异常不伪造成功() throws Exception {
        HttpServer server = start(exchange -> {
            exchange.getRequestBody().readAllBytes();
            respond(exchange, 500, "{\"code\":\"INTERNAL_ERROR\",\"message\":\"系统繁忙\"}");
        });
        HttpHisClient client = new HttpHisClient(mapper, "http://127.0.0.1:" + server.getAddress().getPort(),
                APP_ID, SECRET, 2000, true, "D001", "QK", null);

        RuntimeException error = assertThrows(RuntimeException.class, () -> client.book(
                new HisClient.HisBookingCommand("ap-x", "slot-1", "演示患者", "D001", "QK")));
        assertTrue(error.getMessage().contains("INTERNAL_ERROR"), "异常应携带院方错误码，实际: " + error.getMessage());
    }

    @Test
    void 受理前使用已确认主数据映射() throws Exception {
        List<String> bodies = new CopyOnWriteArrayList<>();
        HttpServer server = start(exchange -> {
            bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            respond(exchange, 201, "{\"code\":\"OK\",\"data\":{\"hisOrderNo\":\"CLN20261120-000007\","
                    + "\"status\":\"ACCEPTED\",\"replayed\":false}}");
        });
        HisMasterDataRepository mappings = mock(HisMasterDataRepository.class);
        when(mappings.resolveConfirmed("DOCTOR", "doc-gp-1")).thenReturn(Optional.of("D001"));
        when(mappings.resolveConfirmed("DEPARTMENT", "dep-gp")).thenReturn(Optional.of("QK"));

        HttpHisClient client = new HttpHisClient(mapper, "http://127.0.0.1:" + server.getAddress().getPort(),
                APP_ID, SECRET, 2000, false, "", "", mappings);

        HisClient.HisBookingResult result = client.book(new HisClient.HisBookingCommand(
                "ap-map-1", "slot-future-1", "演示患者", "doc-gp-1", "dep-gp"));

        assertEquals("CLN20261120-000007", result.hisOrderNo());
        assertEquals("HIS_LIVE", result.source());
        assertEquals(1, bodies.size());
        assertTrue(bodies.get(0).contains("\"doctorId\":\"D001\""));
        assertTrue(bodies.get(0).contains("\"departmentId\":\"QK\""));
    }

    @Test
    void 真实档主数据不一致不得回落演示映射() throws Exception {
        List<String> bodies = new CopyOnWriteArrayList<>();
        HttpServer server = start(exchange -> {
            bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            respond(exchange, 404, "{\"code\":\"NOT_FOUND\",\"message\":\"科室不存在\"}");
        });
        HttpHisClient client = new HttpHisClient(mapper, "http://127.0.0.1:" + server.getAddress().getPort(),
                APP_ID, SECRET, 2000, false, "D001", "QK", null);

        RuntimeException error = assertThrows(RuntimeException.class, () -> client.book(
                new HisClient.HisBookingCommand("ap-real-1", "slot-1", "演示患者", "doc-unknown", "dep-unknown")));

        assertTrue(error.getMessage().contains("NOT_FOUND"), "真实档应直接失败，实际: " + error.getMessage());
        assertEquals(1, bodies.size(), "demo=false 时不得用 D001/QK 重试");
        assertTrue(bodies.get(0).contains("doc-unknown") && bodies.get(0).contains("dep-unknown"));
    }

    @Test
    void 撤销受理走幂等路径() throws Exception {
        List<String> paths = new CopyOnWriteArrayList<>();
        HttpServer server = start(exchange -> {
            exchange.getRequestBody().readAllBytes();
            paths.add(exchange.getRequestURI().getPath());
            respond(exchange, 200, "{\"code\":\"OK\",\"data\":{\"status\":\"CANCELLED\",\"idempotent\":true}}");
        });
        HttpHisClient client = new HttpHisClient(mapper, "http://127.0.0.1:" + server.getAddress().getPort(),
                APP_ID, SECRET, 2000, true, "D001", "QK", null);

        client.cancel("CLN20261119-000001", "患者取消");

        assertEquals(List.of("/openapi/v1/appointments/CLN20261119-000001/cancel"), paths);
    }

    // ------------------------------------------------------------ 辅助

    private HttpServer start(ThrowingHandler handler) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/openapi/v1/appointments", exchange -> {
            try {
                handler.handle(exchange);
            } catch (Exception e) {
                throw new RuntimeException(e);
            } finally {
                exchange.close();
            }
        });
        server.start();
        servers.add(server);
        return server;
    }

    private static void respond(HttpExchange exchange, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    /** 与 clinic-his security.sign_request 完全一致的签名实现（契约真源）。 */
    private static String sign(String path, String appId, String timestamp, String nonce, byte[] body)
            throws Exception {
        String bodyHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
        String message = String.join("\n", "POST", path, appId, timestamp, nonce, bodyHash);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
    }

    private record Captured(String path, String idemKey, boolean signatureOk, String body) {
    }

    @FunctionalInterface
    private interface ThrowingHandler {
        void handle(HttpExchange exchange) throws Exception;
    }
}
