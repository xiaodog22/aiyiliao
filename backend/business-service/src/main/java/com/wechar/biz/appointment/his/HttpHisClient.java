package com.wechar.biz.appointment.his;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * HIS HTTP 适配器（{@code app.his.mode=http}）——只指向本地社区诊所演示系统 clinic-his。
 *
 * <p>与 clinic-his 的 {@code /openapi/v1/*} 契约严格对齐（见 clinic-his/docs/02-接口契约.md）：
 * <ul>
 *   <li>签名：{@code HMAC-SHA256(secret, METHOD\nPATH\nappId\ntimestamp\nnonce\nsha256hex(body))}；</li>
 *   <li>请求头：{@code X-App-Id / X-Timestamp(±300s) / X-Nonce(8~64) / X-Signature / Idempotency-Key}；</li>
 *   <li>成功信封 {@code {code:"OK", data}}；非 2xx 或 code!=OK 一律抛异常，
 *       由 {@link HisGateway} 转 503 HIS_UNAVAILABLE（绝不伪造成功）。</li>
 * </ul>
 *
 * <p>主数据映射：主项目科室/医生（{@code dep-*} / {@code doc-*}）与诊所（{@code QK} / {@code D001}）
 * 不同源。仅 {@code demo=true} 的演示联调在首次受理返回 NOT_FOUND 时用 {@code fallback-*} 重试一次；
 * 真实档必须失败（HIS_UNAVAILABLE），禁止把患者静默挂到默认医生/科室。
 *
 * <p>日志只记 ID 级信息，不写患者姓名等敏感字段（医疗日志脱敏口径）。
 */
@Component
@ConditionalOnProperty(name = "app.his.mode", havingValue = "http")
public class HttpHisClient implements HisClient {

    /** 医院所在时区：号源 Instant → 院内 reg_date/slotTime 的唯一换算口径。 */
    private static final ZoneId HOSPITAL_ZONE = ZoneId.of("Asia/Shanghai");
    private static final DateTimeFormatter SLOT_TIME = DateTimeFormatter.ofPattern("HH:mm");


    private static final Logger log = LoggerFactory.getLogger(HttpHisClient.class);

    private static final String SIGN_ALGORITHM = "HmacSHA256";
    private static final int IDEM_MIN = 8;
    private static final int IDEM_MAX = 128;

    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;
    private final String baseUrl;
    private final String appId;
    private final String appSecret;
    private final long timeoutMs;
    private final boolean demo;
    private final String fallbackDoctorId;
    private final String fallbackDepartmentId;
    private final HisMasterDataRepository mappingRepository;

    public HttpHisClient(
            ObjectMapper objectMapper,
            @Value("${app.his.http.base-url:http://127.0.0.1:8310}") String baseUrl,
            @Value("${app.his.http.app-id:wechar-mini}") String appId,
            @Value("${app.his.http.app-secret:}") String appSecret,
            @Value("${app.his.http.timeout-ms:3000}") long timeoutMs,
            @Value("${app.his.http.demo:true}") boolean demo,
            @Value("${app.his.http.fallback-doctor-id:D001}") String fallbackDoctorId,
            @Value("${app.his.http.fallback-department-id:QK}") String fallbackDepartmentId,
            HisMasterDataRepository mappingRepository) {
        // fail-fast：没有密钥就无法签名，宁可启动失败也不要运行时逐笔 401
        if (appSecret == null || appSecret.isBlank()) {
            throw new IllegalStateException(
                    "app.his.mode=http 必须配置 app.his.http.app-secret"
                            + "（取自 clinic-his/data/openapi-credentials.txt 的 appSecret）");
        }
        this.objectMapper = objectMapper;
        this.baseUrl = normalizeBase(baseUrl);
        this.appId = appId;
        this.appSecret = appSecret.trim();
        this.timeoutMs = timeoutMs > 0 ? timeoutMs : 3000L;
        this.demo = demo;
        this.fallbackDoctorId = fallbackDoctorId;
        this.fallbackDepartmentId = fallbackDepartmentId;
        this.mappingRepository = mappingRepository;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(this.timeoutMs))
                .build();
    }

    @Override
    public HisBookingResult book(HisBookingCommand command) {
        String doctorId = command.doctorId();
        String departmentId = command.departmentId();
        // 只使用 CONFIRMED 映射；CONFLICT / UNMAPPED 保持原平台 ID，让 HIS 明确拒绝，
        // 不在真实档静默落到 D001/QK。
        if (mappingRepository != null) {
            doctorId = mappingRepository.resolveConfirmed("DOCTOR", doctorId).orElse(doctorId);
            departmentId = mappingRepository.resolveConfirmed("DEPARTMENT", departmentId).orElse(departmentId);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("appointmentId", command.appointmentId());
        if (hasText(command.slotId())) {
            payload.put("slotId", command.slotId());
        }
        if (hasText(command.patientName())) {
            payload.put("patientName", truncate(command.patientName(), 50));
        }
        payload.put("doctorId", doctorId);
        payload.put("departmentId", departmentId);
        // 就诊日期/时间（2026-11-22）：HIS 受理要落院内挂号，挂号必须按本地日期进队列。
        // 号源是 UTC Instant，这里按医院时区（Asia/Shanghai）转成本地日期与 HH:mm，
        // 不把 UTC 日期直接丢给院方（跨零点会把号排到前一天）。
        if (command.slotStart() != null) {
            var local = command.slotStart().atZone(HOSPITAL_ZONE);
            payload.put("slotDate", local.toLocalDate().toString());
            payload.put("slotTime", local.toLocalTime().format(SLOT_TIME));
        }

        String idempotencyKey = idempotencyKey(command.appointmentId());
        JsonNode data;
        try {
            data = post("/openapi/v1/appointments", payload, idempotencyKey);
        } catch (HisHttpException e) {
            // 仅 demo=true 允许回落演示映射。真实档（demo=false）主数据不一致必须失败，
            // 否则会把患者挂到 D001/QK 的“默认医生/科室”，产生错误院内单。
            if (!demo || !"NOT_FOUND".equals(e.code()) || !hasText(fallbackDoctorId) || !hasText(fallbackDepartmentId)) {
                throw e;
            }
            // 演示映射：主项目与诊所主数据不同源（dep-gp/doc-gp-1 ↔ QK/D001），重试一次并留痕
            log.info("clinic-his 未识别主数据 doctor={} dept={}，改用演示映射 {}/{}",
                    command.doctorId(), command.departmentId(), fallbackDoctorId, fallbackDepartmentId);
            payload.put("doctorId", fallbackDoctorId);
            payload.put("departmentId", fallbackDepartmentId);
            data = post("/openapi/v1/appointments", payload, idempotencyKey);
        }

        String orderNo = data.path("hisOrderNo").asText("");
        if (orderNo.isBlank()) {
            throw new IllegalStateException("clinic-his 回执缺少 hisOrderNo");
        }
        log.info("clinic-his accepted appointment={} orderNo={} replayed={} demo={}",
                command.appointmentId(), orderNo, data.path("replayed").asBoolean(false), demo);
        // demo=true 时页面按 HIS_MOCK 显示「演示预约」，不冒充实院受理
        return new HisBookingResult(orderNo, demo ? "HIS_MOCK" : "HIS_LIVE", demo);
    }

    @Override
    public void cancel(String hisOrderNo, String reason) {
        if (!hisOrderNo.matches("[A-Za-z0-9-]{1,64}")) {
            throw new IllegalArgumentException("非法的 HIS 单号: " + hisOrderNo);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        if (hasText(reason)) {
            payload.put("reason", truncate(reason, 200));
        }
        post("/openapi/v1/appointments/" + hisOrderNo + "/cancel", payload,
                idempotencyKey("cancel-" + hisOrderNo));
        log.info("clinic-his cancel orderNo={} reason={}", hisOrderNo, truncate(reason, 50));
    }

    @Override
    public HisOrderStatus queryOrder(String hisOrderNo) {
        if (!hasText(hisOrderNo)) {
            throw new IllegalArgumentException("HIS 单号为空");
        }
        if (!hisOrderNo.matches("[A-Za-z0-9-]{1,64}")) {
            throw new IllegalArgumentException("非法的 HIS 单号: " + hisOrderNo);
        }
        // GET /openapi/v1/appointments/{his_order_no}：受理单 + 院内挂号/预排号进度
        JsonNode data = get("/openapi/v1/appointments/" + hisOrderNo);
        return new HisOrderStatus(
                textOf(data, "hisOrderNo", hisOrderNo),
                textOf(data, "status", ""),
                textOf(data, "registrationNo", null),
                textOf(data, "registrationStatus", ""),
                textOf(data, "queueNo", null));
    }

    private static String textOf(JsonNode node, String field, String fallback) {
        return node != null && node.hasNonNull(field) ? node.get(field).asText() : fallback;
    }

    @Override
    public HisBill listCharges(String hisOrderNo) {
        if (!hasText(hisOrderNo) || !hisOrderNo.matches("[A-Za-z0-9-]{1,64}")) {
            throw new IllegalArgumentException("非法的 HIS 单号: " + hisOrderNo);
        }
        JsonNode data = get("/openapi/v1/appointments/" + hisOrderNo + "/charges");
        java.util.List<HisChargeItem> items = new java.util.ArrayList<>();
        JsonNode arr = data.get("items");
        if (arr != null && arr.isArray()) {
            for (JsonNode n : arr) {
                items.add(new HisChargeItem(
                        textOf(n, "chargeNo", ""),
                        textOf(n, "category", ""),
                        textOf(n, "description", ""),
                        n.hasNonNull("amount") ? n.get("amount").decimalValue() : BigDecimal.ZERO,
                        textOf(n, "status", ""),
                        textOf(n, "createdAt", null),
                        textOf(n, "paidAt", null)));
            }
        }
        JsonNode sum = data.get("summary");
        BigDecimal payable = sum != null && sum.hasNonNull("payable")
                ? sum.get("payable").decimalValue() : BigDecimal.ZERO;
        BigDecimal paid = sum != null && sum.hasNonNull("paid")
                ? sum.get("paid").decimalValue() : BigDecimal.ZERO;
        return new HisBill(hisOrderNo, items, payable, paid);
    }

    // ------------------------------------------------------------ 演示账单（P0-1）

    @Override
    public HisChargeResult createDemoCharge(HisChargeCommand command) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("patientName", truncate(command.patientName(), 50));
        payload.put("amount", command.amount());
        payload.put("description", truncate(command.description(), 100));
        payload.put("refType", command.refType());
        payload.put("refId", command.refId());
        JsonNode data = post("/openapi/v1/demo/charges", payload, idempotencyKey(command.idempotencyKey()));
        HisChargeResult result = parseCharge(data);
        log.info("clinic-his demo charge created ref={}/{} chargeNo={} amount={} replayed={}",
                command.refType(), command.refId(), result.chargeNo(), result.amount(), result.replayed());
        return result;
    }

    @Override
    public HisChargeResult queryDemoCharge(String chargeNo) {
        requireChargeNo(chargeNo);
        return parseCharge(get("/openapi/v1/charges/" + chargeNo));
    }

    @Override
    public HisChargeResult payDemoCharge(String chargeNo, BigDecimal amount, String idempotencyKey) {
        requireChargeNo(chargeNo);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("amount", amount);
        payload.put("source", "DEMO");
        JsonNode data = post("/openapi/v1/charges/" + chargeNo + "/pay", payload,
                idempotencyKey(idempotencyKey));
        HisChargeResult result = parseCharge(data);
        log.info("clinic-his demo charge paid chargeNo={} amount={} replayed={}",
                chargeNo, amount, result.replayed());
        return result;
    }

    private HisChargeResult parseCharge(JsonNode data) {
        String chargeNo = data.path("chargeNo").asText("");
        if (chargeNo.isBlank()) {
            throw new IllegalStateException("clinic-his 回执缺少 chargeNo");
        }
        BigDecimal amount = data.hasNonNull("amount") ? data.get("amount").decimalValue() : BigDecimal.ZERO;
        return new HisChargeResult(chargeNo, amount, data.path("status").asText("UNPAID"),
                data.path("replayed").asBoolean(false), demo);
    }

    private void requireChargeNo(String chargeNo) {
        if (chargeNo == null || !chargeNo.matches("[A-Za-z0-9-]{1,64}")) {
            throw new IllegalArgumentException("非法的演示账单号: " + chargeNo);
        }
    }

    // ------------------------------------------------------------ 检查预约（P0-2）

    @Override
    public List<HisExamItem> listExamItems() {
        JsonNode data = get("/openapi/v1/exam-items");
        if (!data.isArray()) {
            throw new IllegalStateException("clinic-his 检查项目回执不是数组");
        }
        List<HisExamItem> items = new java.util.ArrayList<>();
        for (JsonNode node : data) {
            items.add(new HisExamItem(node.path("itemCode").asText(""),
                    node.path("itemName").asText(""), node.path("category").asText(""),
                    node.hasNonNull("price") ? node.get("price").decimalValue() : BigDecimal.ZERO));
        }
        return items;
    }

    @Override
    public List<HisExamSlot> listExamSlots(String itemCode) {
        requireExamItemCode(itemCode);
        JsonNode data = get("/openapi/v1/exam-items/" + itemCode + "/slots");
        JsonNode slotsNode = data.path("slots");
        if (!slotsNode.isArray()) {
            throw new IllegalStateException("clinic-his 检查排期回执缺少 slots");
        }
        List<HisExamSlot> slots = new java.util.ArrayList<>();
        for (JsonNode node : slotsNode) {
            slots.add(new HisExamSlot(node.path("slotKey").asText(""),
                    node.path("slotDate").asText(""), node.path("slotTime").asText(""),
                    node.path("available").asBoolean(false)));
        }
        return slots;
    }

    @Override
    public HisExamBookingResult bookExam(HisExamBookingCommand command) {
        requireExamItemCode(command.itemCode());
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("requestNo", command.requestNo());
        payload.put("itemCode", command.itemCode());
        payload.put("slotKey", command.slotKey());
        payload.put("patientName", truncate(command.patientName(), 50));
        JsonNode data = post("/openapi/v1/exam-orders", payload,
                idempotencyKey(command.idempotencyKey()));
        HisExamBookingResult result = parseExam(data);
        log.info("clinic-his exam booked requestNo={} examOrderNo={} item={} slot={} replayed={}",
                command.requestNo(), result.examOrderNo(), command.itemCode(),
                command.slotKey(), result.replayed());
        return result;
    }

    @Override
    public HisExamBookingResult getExam(String examOrderNo) {
        requireExamOrderNo(examOrderNo);
        return parseExam(get("/openapi/v1/exam-orders/" + examOrderNo));
    }

    @Override
    public void cancelExam(String examOrderNo, String reason) {
        requireExamOrderNo(examOrderNo);
        Map<String, Object> payload = new LinkedHashMap<>();
        if (hasText(reason)) {
            payload.put("reason", truncate(reason, 200));
        }
        post("/openapi/v1/exam-orders/" + examOrderNo + "/cancel", payload,
                idempotencyKey("cancel-exam-" + examOrderNo));
        log.info("clinic-his exam cancelled examOrderNo={} reason={}", examOrderNo, truncate(reason, 50));
    }

    private HisExamBookingResult parseExam(JsonNode data) {
        String examOrderNo = data.path("examOrderNo").asText("");
        if (examOrderNo.isBlank()) {
            throw new IllegalStateException("clinic-his 检查预约回执缺少 examOrderNo");
        }
        return new HisExamBookingResult(
                examOrderNo, data.path("requestNo").asText(""), data.path("itemCode").asText(""),
                data.path("itemName").asText(""),
                data.hasNonNull("price") ? data.get("price").decimalValue() : BigDecimal.ZERO,
                data.path("slotKey").asText(""), data.path("slotDate").asText(""),
                data.path("slotTime").asText(""), data.path("status").asText("BOOKED"),
                data.path("replayed").asBoolean(false));
    }

    private void requireExamItemCode(String itemCode) {
        if (itemCode == null || !itemCode.matches("[A-Za-z0-9-]{1,32}")) {
            throw new IllegalArgumentException("非法的检查项目编码: " + itemCode);
        }
    }

    private void requireExamOrderNo(String examOrderNo) {
        if (examOrderNo == null || !examOrderNo.matches("[A-Za-z0-9-]{1,64}")) {
            throw new IllegalArgumentException("非法的检查预约单号: " + examOrderNo);
        }
    }

    // ------------------------------------------------------------ 传输与签名

    private JsonNode post(String path, Map<String, Object> payload, String idempotencyKey) {
        byte[] body;
        try {
            body = objectMapper.writeValueAsBytes(payload);
        } catch (IOException e) {
            throw new IllegalStateException("clinic-his 请求序列化失败", e);
        }
        return request("POST", path, body, idempotencyKey);
    }

    private JsonNode get(String path) {
        return request("GET", path, new byte[0], null);
    }

    private JsonNode request(String method, String path, byte[] body, String idempotencyKey) {
        String timestamp = String.valueOf(Instant.now().getEpochSecond());
        String nonce = UUID.randomUUID().toString().replace("-", "");
        String signature = sign(method, path, timestamp, nonce, body);

        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(Duration.ofMillis(timeoutMs))
                .header("Content-Type", "application/json; charset=utf-8")
                .header("X-App-Id", appId)
                .header("X-Timestamp", timestamp)
                .header("X-Nonce", nonce)
                .header("X-Signature", signature);
        if (idempotencyKey != null) {
            builder.header("Idempotency-Key", idempotencyKey);
        }
        HttpRequest request = "GET".equals(method)
                ? builder.GET().build()
                : builder.method(method, HttpRequest.BodyPublishers.ofByteArray(body)).build();

        HttpResponse<byte[]> response;
        try {
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("clinic-his 调用被中断 path=" + path, e);
        } catch (IOException e) {
            // 连接拒绝 / 超时：一律按失败处理，不做「可能已受理」的乐观假设
            throw new IllegalStateException("clinic-his 不可达 path=" + path + "：" + e, e);
        }

        JsonNode root = null;
        try {
            root = objectMapper.readTree(response.body());
        } catch (IOException ignored) {
            // 非 JSON（如 502 网关页）走下面的 BAD_RESPONSE 分支
        }
        int status = response.statusCode();
        String code = root == null ? "" : root.path("code").asText("");
        if (status / 100 != 2 || !"OK".equals(code)) {
            String message = root == null ? "" : root.path("message").asText("");
            throw new HisHttpException(status, code.isEmpty() ? "BAD_RESPONSE" : code, message);
        }
        return root.path("data");
    }

    private String sign(String method, String path, String timestamp, String nonce, byte[] body) {
        String message = String.join("\n", method, path, appId, timestamp, nonce, sha256Hex(body));
        try {
            Mac mac = Mac.getInstance(SIGN_ALGORITHM);
            mac.init(new SecretKeySpec(appSecret.getBytes(StandardCharsets.UTF_8), SIGN_ALGORITHM));
            return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("clinic-his 签名计算失败", e);
        }
    }

    private static String sha256Hex(byte[] body) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ------------------------------------------------------------ 工具

    private static String normalizeBase(String baseUrl) {
        String base = baseUrl == null ? "" : baseUrl.trim();
        if (base.isEmpty()) {
            base = "http://127.0.0.1:8310";
        }
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base;
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private static String truncate(String value, int max) {
        if (value == null) {
            return null;
        }
        return value.length() <= max ? value : value.substring(0, max);
    }

    /** clinic-his 要求 8~128 字符；重试必须复用同一键（本方法对同一输入恒定）。 */
    private static String idempotencyKey(String raw) {
        String key = raw == null ? "" : raw.trim();
        if (key.length() < IDEM_MIN) {
            key = "wechar-" + key;
        }
        return key.length() > IDEM_MAX ? key.substring(0, IDEM_MAX) : key;
    }

    /** clinic-his 业务错误（非 2xx 或 code!=OK）。{@link HisGateway} 统一转 503。 */
    private static final class HisHttpException extends RuntimeException {

        private final int status;
        private final String code;

        HisHttpException(int status, String code, String message) {
            super("clinic-his HTTP " + status + " " + code + (message == null || message.isBlank() ? "" : "：" + message));
            this.status = status;
            this.code = code;
        }

        int status() {
            return status;
        }

        String code() {
            return code;
        }
    }
}
