package com.wechar.biz;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.wechar.biz.appointment.his.HisCancelRetryJob;
import com.wechar.biz.appointment.his.HisCancelTaskRepository;
import com.wechar.biz.appointment.his.HisClient;
import com.wechar.biz.payment.PaymentService;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * L5 取消/退费与 HIS 对账闭环集成测试（2026-11-22）。
 *
 * <p>复现的两条缺陷：
 * <ol>
 *   <li>取消预约时 HIS 撤销失败只 log.warn，进程重启后线索丢失；
 *       → 现在本地事务先入 outbox，失败由 {@link HisCancelRetryJob} 退避重试，成功置 DONE。</li>
 *   <li>reconcile 只遍历 PAID，退费订单退出对账视野，HIS 侧恒 PAID 无人发现；
 *       → 现在 REFUNDED 纳入视野，差异落 his_reconcile_diffs，恢复一致自动 RESOLVED。</li>
 * </ol>
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:l5reconcile;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql",
        "app.his.enabled=true",
        "app.his.mode=mock",
        "app.payment.enabled=true",
        "app.payment.demo-secret=test-demo-secret-0123456789",
        "app.his.cancel-retry-initial-delay-ms=999999999",
        "app.payment.reconcile-initial-delay-ms=999999999"
})
@AutoConfigureMockMvc
class HisReconcileClosureTest {

    private static final String ORDER_NO = "L5-PAY-1";
    private static final String CHARGE_NO = "L5-CHG-1";
    private static final String ORDER_NO_SYNC = "L5-PAY-SYNC";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private PaymentService paymentService;

    @Autowired
    private HisCancelRetryJob retryJob;

    @Autowired
    private HisCancelTaskRepository cancelTasks;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @MockitoBean
    private HisClient hisClient;

    @BeforeEach
    void cleanSlate() {
        jdbc.update("DELETE FROM his_cancel_tasks");
        jdbc.update("DELETE FROM his_reconcile_diffs");
        jdbc.update("DELETE FROM payment_orders WHERE order_no = ?", ORDER_NO);
        jdbc.update("DELETE FROM payment_orders WHERE order_no = ?", ORDER_NO_SYNC);
    }

    @Test
    void 退费订单纳入对账_仍PAID即记录差异_恢复后自动关闭() {
        // 退费发生在 1 小时前，支付发生在 25 小时前：旧实现按 paid_at 24h 窗口会直接漏掉
        Instant now = Instant.now();
        Instant longAgo = now.minus(Duration.ofHours(25));
        Instant recent = now.minus(Duration.ofHours(1));
        jdbc.update("INSERT INTO payment_orders (order_no, user_id, appointment_id, charge_no, amount, "
                        + "currency, status, source, idem_key, created_at, updated_at, paid_at, "
                        + "refunded_at, refund_reason, refund_channel) "
                        + "VALUES (?, ?, ?, ?, ?, 'CNY', 'REFUNDED', 'DEMO', ?, ?, ?, ?, ?, ?, 'LOCAL_DEMO')",
                ORDER_NO, "u-l5", "ap-l5", CHARGE_NO, new BigDecimal("20.50"), "idem-l5",
                Timestamp.from(longAgo), Timestamp.from(recent), Timestamp.from(longAgo),
                Timestamp.from(recent), "不想要了");

        // HIS 侧账单仍是 PAID → 演示退费未回写，必须被对账发现
        when(hisClient.queryDemoCharge(CHARGE_NO)).thenReturn(new HisClient.HisChargeResult(
                CHARGE_NO, new BigDecimal("20.50"), "PAID", false, true));
        int mismatches = paymentService.reconcile(now.minus(Duration.ofHours(24)));
        assertEquals(1, mismatches, "退费后 HIS 仍 PAID 必须计入差异");
        assertEquals("OPEN", jdbc.queryForObject(
                "SELECT status FROM his_reconcile_diffs WHERE biz_type = 'PAYMENT' AND biz_id = ?",
                String.class, ORDER_NO));
        assertEquals("PAID", jdbc.queryForObject(
                "SELECT actual_status FROM his_reconcile_diffs WHERE biz_type = 'PAYMENT' AND biz_id = ?",
                String.class, ORDER_NO));

        // HIS 侧完成退费（REFUNDED）→ 同一台账项自动 RESOLVED，不需要人工删数据
        when(hisClient.queryDemoCharge(CHARGE_NO)).thenReturn(new HisClient.HisChargeResult(
                CHARGE_NO, new BigDecimal("20.50"), "REFUNDED", false, true));
        assertEquals(0, paymentService.reconcile(now.minus(Duration.ofHours(24))));
        assertEquals("RESOLVED", jdbc.queryForObject(
                "SELECT status FROM his_reconcile_diffs WHERE biz_type = 'PAYMENT' AND biz_id = ?",
                String.class, ORDER_NO));
    }

    @Test
    void 退费立即登记待同步_超出时间窗口仍被对账扫描() {
        Instant now = Instant.now();
        Instant longAgo = now.minus(Duration.ofDays(30));
        jdbc.update("INSERT INTO payment_orders (order_no, user_id, appointment_id, charge_no, amount, "
                        + "currency, status, source, idem_key, created_at, updated_at, paid_at, "
                        + "refunded_at, refund_reason, refund_channel) "
                        + "VALUES (?, 'u-l5', 'ap-l5-sync', 'L5-CHG-SYNC', ?, 'CNY', 'PAID', 'DEMO', ?, ?, ?, ?, NULL, NULL, NULL)",
                ORDER_NO_SYNC, new BigDecimal("20.50"), "idem-l5-sync",
                Timestamp.from(longAgo), Timestamp.from(longAgo), Timestamp.from(longAgo));

        paymentService.refund("u-l5", ORDER_NO_SYNC, "用户申请退费");
        assertEquals("REFUNDED", jdbc.queryForObject(
                "SELECT status FROM payment_orders WHERE order_no = ?", String.class, ORDER_NO_SYNC));
        // 退费成功即有待同步台账，不需要等下一轮对账才发现「没回写 HIS」
        assertEquals("PENDING_SYNC", jdbc.queryForObject(
                "SELECT actual_status FROM his_reconcile_diffs WHERE biz_type='PAYMENT' AND biz_id = ?",
                String.class, ORDER_NO_SYNC));

        // 把退费时间推到 40 天前：超出 24h 时间窗口，只有 OPEN 台账能把它拉回来
        jdbc.update("UPDATE payment_orders SET refunded_at = ? WHERE order_no = ?",
                Timestamp.from(now.minus(Duration.ofDays(40))), ORDER_NO_SYNC);
        when(hisClient.queryDemoCharge("L5-CHG-SYNC")).thenReturn(new HisClient.HisChargeResult(
                "L5-CHG-SYNC", new BigDecimal("20.50"), "PAID", false, true));

        paymentService.reconcile(now.minus(Duration.ofHours(24)));

        verify(hisClient).queryDemoCharge("L5-CHG-SYNC");
        assertEquals("PAID", jdbc.queryForObject(
                "SELECT actual_status FROM his_reconcile_diffs WHERE biz_type='PAYMENT' AND biz_id = ?",
                String.class, ORDER_NO_SYNC), "超出窗口的待同步订单必须被重新对账");
    }

    @Test
    void 对账查询失败登记UNKNOWN_恢复后自动RESOLVED() {
        Instant now = Instant.now();
        jdbc.update("INSERT INTO payment_orders (order_no, user_id, appointment_id, charge_no, amount, "
                        + "currency, status, source, idem_key, created_at, updated_at, paid_at, "
                        + "refunded_at, refund_reason, refund_channel) "
                        + "VALUES (?, 'u-l5', 'ap-l5-sync', 'L5-CHG-SYNC', ?, 'CNY', 'REFUNDED', 'DEMO', ?, ?, ?, ?, ?, ?, 'LOCAL_DEMO')",
                ORDER_NO_SYNC, new BigDecimal("20.50"), "idem-l5-sync",
                Timestamp.from(now.minus(Duration.ofHours(2))), Timestamp.from(now.minus(Duration.ofHours(1))),
                Timestamp.from(now.minus(Duration.ofHours(2))), Timestamp.from(now.minus(Duration.ofHours(1))),
                "不想要了");

        when(hisClient.queryDemoCharge("L5-CHG-SYNC")).thenThrow(new RuntimeException("timeout"));
        paymentService.reconcile(now.minus(Duration.ofHours(24)));
        assertEquals("OPEN", jdbc.queryForObject(
                "SELECT status FROM his_reconcile_diffs WHERE biz_type='PAYMENT' AND biz_id = ?",
                String.class, ORDER_NO_SYNC));
        assertEquals("UNKNOWN", jdbc.queryForObject(
                "SELECT actual_status FROM his_reconcile_diffs WHERE biz_type='PAYMENT' AND biz_id = ?",
                String.class, ORDER_NO_SYNC), "查询失败不得记为一致");

        doReturn(new HisClient.HisChargeResult(
                "L5-CHG-SYNC", new BigDecimal("20.50"), "REFUNDED", false, true))
                .when(hisClient).queryDemoCharge("L5-CHG-SYNC");
        assertEquals(0, paymentService.reconcile(now.minus(Duration.ofHours(24))));
        assertEquals("RESOLVED", jdbc.queryForObject(
                "SELECT status FROM his_reconcile_diffs WHERE biz_type='PAYMENT' AND biz_id = ?",
                String.class, ORDER_NO_SYNC));
    }

    @Test
    void 本地落单事务回滚_独立补偿任务仍保留() {
        new TransactionTemplate(transactionManager).execute(status -> {
            cancelTasks.enqueueIndependent("ap-l5-rollback", "HIS-L5-RB", "local insert failed", Instant.now());
            status.setRollbackOnly();
            return null;
        });
        // 外层（预约落单）事务已回滚，补偿任务必须仍在，否则线索随失败一起丢失
        assertEquals("PENDING", jdbc.queryForObject(
                "SELECT status FROM his_cancel_tasks WHERE appointment_id = ?",
                String.class, "ap-l5-rollback"));
    }

    @Test
    void 取消失败_先入outbox_重试成功后置DONE() throws Exception {
        when(hisClient.book(any())).thenReturn(new HisClient.HisBookingResult(
                "HIS-L5-1", "HIS_MOCK", true));
        MvcResult created = mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "l5-cancel-0001")
                        .content("{\"slotId\":\"slot-future-1\",\"patientName\":\"演示患者\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String body = created.getResponse().getContentAsString(StandardCharsets.UTF_8);
        Matcher m = Pattern.compile("\"id\":\"(ap-[^\"]+)\"").matcher(body);
        String appointmentId = m.find() ? m.group(1) : null;
        assertEquals(true, appointmentId != null, "创建预约应返回 ap- 前缀 ID: " + body);

        doThrow(new RuntimeException("his down")).when(hisClient).cancel(eq("HIS-L5-1"), anyString());
        mockMvc.perform(post("/api/v1/appointments/" + appointmentId + "/cancel")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "l5-cancel-0002")
                        .content("{\"reason\":\"行程冲突\"}"))
                .andExpect(status().isOk());

        // 失败也必须有持久化线索（原实现只有一行日志）
        assertEquals("PENDING", jdbc.queryForObject(
                "SELECT status FROM his_cancel_tasks WHERE appointment_id = ?", String.class, appointmentId));
        assertEquals("HIS-L5-1", jdbc.queryForObject(
                "SELECT his_order_no FROM his_cancel_tasks WHERE appointment_id = ?", String.class, appointmentId));

        // 第一次重试仍失败 → 记 attempts，保留 PENDING
        retryJob.run();
        assertEquals(1, jdbc.queryForObject(
                "SELECT attempts FROM his_cancel_tasks WHERE appointment_id = ?", Integer.class, appointmentId));
        assertEquals("PENDING", jdbc.queryForObject(
                "SELECT status FROM his_cancel_tasks WHERE appointment_id = ?", String.class, appointmentId));

        // HIS 恢复：把重试时间拉回现在，跑一轮 → DONE
        jdbc.update("UPDATE his_cancel_tasks SET next_retry_at = ? WHERE appointment_id = ?",
                Timestamp.from(Instant.now().minusSeconds(1)), appointmentId);
        doThrow(new RuntimeException()).when(hisClient).cancel(anyString(), anyString());
        retryJob.run(); // 仍失败 → attempts=2
        jdbc.update("UPDATE his_cancel_tasks SET next_retry_at = ? WHERE appointment_id = ?",
                Timestamp.from(Instant.now().minusSeconds(1)), appointmentId);
        org.mockito.Mockito.doNothing().when(hisClient).cancel(anyString(), anyString());
        retryJob.run();
        assertEquals("DONE", jdbc.queryForObject(
                "SELECT status FROM his_cancel_tasks WHERE appointment_id = ?", String.class, appointmentId));
    }
}
