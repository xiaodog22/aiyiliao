package com.wechar.biz.payment;

import com.wechar.biz.appointment.AppointmentRepository;
import com.wechar.biz.appointment.his.HisClient;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.payment.PaymentOrderRepository.PaymentOrderRow;
import com.wechar.biz.payment.dto.PaymentDemoCallbackRequest;
import com.wechar.biz.payment.dto.PaymentOrderData;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * P0-1 演示支付服务单测（Mockito）。
 *
 * 覆盖验收口径的核心语义：
 *   ① 未开启即拒绝建单；LIVE 配置启动失败；
 *   ② 金额只取号源费（20.50），不信任客户端；
 *   ③ HIS 建账/支付失败不落本地订单、不误置 PAID；
 *   ④ 重复回调 10 次只入账 1 次；
 *   ⑤ 签名篡改一律拒绝。
 *
 * 注：真实 SQL（V34 唯一键、markPaid 条件更新）由 MySQL 运行时验收覆盖。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class PaymentServiceTest {

    private static final String USER = "u-1";
    private static final String APPT = "apt-1";
    private static final String ORDER = "PAY20261120120000001";
    private static final String CHARGE = "DCHG20261120-000001";
    private static final Instant NOW = Instant.parse("2026-11-20T04:00:00Z");

    @Mock private AppointmentRepository appointments;
    @Mock private PaymentOrderRepository orders;
    @Mock private HisClient hisClient;
    @Mock private HisReconcileDiffRepository reconciliation;

    private PaymentSettings settings;
    private PaymentDemoSigner signer;
    private PaymentService service;

    @BeforeEach
    void setUp() {
        settings = new PaymentSettings(true, "DEMO", "DEMO", "demo-secret-0123456789", 300);
        signer = new PaymentDemoSigner(settings);
        service = new PaymentService(appointments, orders, settings, signer, hisClient, reconciliation,
                Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static AppointmentRepository.AppointmentRow appointment() {
        return new AppointmentRepository.AppointmentRow(APPT, USER, null, "slot-1", "doc-1",
                "dep-1", "张三", null, "演示", "CONFIRMED", 1, null, "idem-1", "digest", 1,
                NOW, NOW, "HIS-MOCK-1", "HIS_MOCK");
    }

    private static AppointmentRepository.SlotRow slot() {
        return new AppointmentRepository.SlotRow("slot-1", "doc-1", NOW, NOW, 10, 5,
                new BigDecimal("20.50"), "CNY", "OPEN");
    }

    private static PaymentOrderRow row(String status) {
        return new PaymentOrderRow(1L, ORDER, USER, APPT, CHARGE, new BigDecimal("20.50"),
                "CNY", status, "DEMO", "idem-1", null, NOW, NOW,
                "PAID".equals(status) || "REFUNDED".equals(status) ? NOW : null,
                "REFUNDED".equals(status) ? NOW : null,
                "REFUNDED".equals(status) ? "不想要了" : null,
                "REFUNDED".equals(status) ? "LOCAL_DEMO" : null);
    }

    private static HisClient.HisChargeResult charge(String status, boolean replayed) {
        return new HisClient.HisChargeResult(CHARGE, new BigDecimal("20.50"), status, replayed, true);
    }

    @Test
    void 未开启支付_建单直接拒绝() {
        PaymentSettings disabled = new PaymentSettings(false, "DEMO", "DEMO", "", 300);
        PaymentService disabledService = new PaymentService(appointments, orders, disabled, signer,
                hisClient, reconciliation, Clock.fixed(NOW, ZoneOffset.UTC));

        ApiException error = assertThrows(ApiException.class,
                () -> disabledService.create(USER, APPT, "idem-1"));
        assertEquals("PAYMENT_DISABLED", error.getCode());
        verify(orders, never()).insert(anyString(), anyString(), anyString(), anyString(),
                any(), anyString(), anyString(), anyString(), anyString());
    }

    @Test
    void LIVE配置_启动即失败() {
        assertThrows(IllegalStateException.class,
                () -> new PaymentSettings(true, "LIVE", "DEMO", "demo-secret-0123456789", 300));
    }

    @Test
    void 建单金额只取号源费() {
        when(orders.findByUserAndIdem(USER, "idem-1")).thenReturn(Optional.empty());
        when(orders.findByAppointment(APPT)).thenReturn(Optional.empty());
        when(appointments.findById(APPT)).thenReturn(Optional.of(appointment()));
        when(appointments.findSlot("slot-1")).thenReturn(Optional.of(slot()));
        when(hisClient.createDemoCharge(any())).thenReturn(charge("UNPAID", false));
        when(orders.findByOrderNo(anyString())).thenReturn(Optional.of(row("UNPAID")));

        PaymentOrderData data = service.create(USER, APPT, "idem-1");

        assertEquals(new BigDecimal("20.50"), data.amount());
        assertEquals("DEMO", data.source());
        verify(orders).insert(anyString(), eq(USER), eq(APPT), eq(CHARGE),
                argThat(a -> a != null && a.compareTo(new BigDecimal("20.50")) == 0),
                eq("CNY"), eq("UNPAID"), eq("DEMO"), eq("idem-1"));
        ArgumentCaptor<HisClient.HisChargeCommand> captor =
                ArgumentCaptor.forClass(HisClient.HisChargeCommand.class);
        verify(hisClient).createDemoCharge(captor.capture());
        assertEquals(0, captor.getValue().amount().compareTo(new BigDecimal("20.50")));
    }

    @Test
    void HIS建账失败_不落本地订单() {
        when(orders.findByUserAndIdem(USER, "idem-1")).thenReturn(Optional.empty());
        when(orders.findByAppointment(APPT)).thenReturn(Optional.empty());
        when(appointments.findById(APPT)).thenReturn(Optional.of(appointment()));
        when(appointments.findSlot("slot-1")).thenReturn(Optional.of(slot()));
        when(hisClient.createDemoCharge(any())).thenThrow(new IllegalStateException("HIS 不可达"));

        ApiException error = assertThrows(ApiException.class,
                () -> service.create(USER, APPT, "idem-1"));
        assertEquals("PAYMENT_HIS_UNAVAILABLE", error.getCode());
        verify(orders, never()).insert(anyString(), anyString(), anyString(), anyString(),
                any(), anyString(), anyString(), anyString(), anyString());
    }

    @Test
    void HIS支付失败_不误置PAID() {
        when(orders.findByOrderNo(ORDER)).thenReturn(Optional.of(row("UNPAID")));
        when(hisClient.payDemoCharge(anyString(), any(), anyString()))
                .thenThrow(new IllegalStateException("HIS 超时"));

        ApiException error = assertThrows(ApiException.class, () -> service.demoPay(USER, ORDER));
        assertEquals("PAYMENT_HIS_UNAVAILABLE", error.getCode());
        verify(orders).markError(eq(ORDER), anyString());
        verify(orders, never()).markPaid(anyString());
    }

    @Test
    void 重复回调10次_只入账一次() {
        AtomicReference<String> status = new AtomicReference<>("UNPAID");
        when(orders.findByOrderNo(ORDER)).thenAnswer(inv -> Optional.of(row(status.get())));
        when(orders.markPaid(ORDER)).thenAnswer(inv -> {
            if (status.compareAndSet("UNPAID", "PAID")) {
                return 1;
            }
            return 0;
        });
        when(hisClient.payDemoCharge(anyString(), any(), anyString())).thenReturn(charge("PAID", false));

        String timestamp = String.valueOf(Instant.now().getEpochSecond());
        String nonce = "nonce-12345678";
        String signature = signer.sign(ORDER, CHARGE, new BigDecimal("20.50"), "DEMO", timestamp, nonce);
        PaymentDemoCallbackRequest request = new PaymentDemoCallbackRequest(
                ORDER, CHARGE, new BigDecimal("20.500"), "DEMO");

        for (int i = 0; i < 10; i++) {
            PaymentOrderData data = service.demoCallback(request, timestamp, nonce, signature);
            assertEquals("PAID", data.status());
        }

        verify(orders, times(1)).markPaid(ORDER);
        // 已是 PAID 的回调在本地直接回放，不再二次调用 HIS（比 10 次幂等调用更严格）
        verify(hisClient, times(1)).payDemoCharge(anyString(), any(), anyString());
    }

    @Test
    void 签名篡改_拒绝且不改状态() {
        String timestamp = String.valueOf(Instant.now().getEpochSecond());
        String nonce = "nonce-12345678";
        String good = signer.sign(ORDER, CHARGE, new BigDecimal("20.50"), "DEMO", timestamp, nonce);
        String tampered = good.substring(0, good.length() - 1) + (good.endsWith("0") ? "1" : "0");
        PaymentDemoCallbackRequest request = new PaymentDemoCallbackRequest(
                ORDER, CHARGE, new BigDecimal("20.50"), "DEMO");

        ApiException error = assertThrows(ApiException.class,
                () -> service.demoCallback(request, timestamp, nonce, tampered));
        assertEquals("PAYMENT_SIGNATURE_INVALID", error.getCode());
        verify(orders, never()).markPaid(anyString());
    }

    // ==================== 演示退费（V37 / DEF-20261121-04） ====================

    @Test
    void 退费_未支付订单拒绝且不写状态() {
        when(orders.findByOrderNo(ORDER)).thenReturn(Optional.of(row("UNPAID")));

        ApiException error = assertThrows(ApiException.class,
                () -> service.refund(USER, ORDER, "不想要了"));
        assertEquals("PAYMENT_NOT_REFUNDABLE", error.getCode());
        verify(orders, never()).markRefunded(anyString(), anyString(), anyString());
    }

    @Test
    void 退费_已支付置REFUNDED且写审计字段() {
        when(orders.findByOrderNo(ORDER))
                .thenReturn(Optional.of(row("PAID")), Optional.of(row("REFUNDED")));
        when(orders.markRefunded(eq(ORDER), anyString(), eq("LOCAL_DEMO"))).thenReturn(1);

        PaymentOrderData data = service.refund(USER, ORDER, "不想要了");

        assertEquals("REFUNDED", data.status());
        assertEquals("不想要了", data.refundReason());
        verify(orders, times(1)).markRefunded(eq(ORDER), eq("不想要了"), eq("LOCAL_DEMO"));
    }

    @Test
    void 退费_重复调用直接回放不重复写库() {
        when(orders.findByOrderNo(ORDER)).thenReturn(Optional.of(row("REFUNDED")));

        PaymentOrderData data = service.refund(USER, ORDER, "再次申请");

        assertEquals("REFUNDED", data.status());
        verify(orders, never()).markRefunded(anyString(), anyString(), anyString());
    }
}
