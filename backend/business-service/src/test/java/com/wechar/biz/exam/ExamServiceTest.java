package com.wechar.biz.exam;

import com.wechar.biz.appointment.his.HisClient;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.exam.ExamOrderRepository.ExamOrderRow;
import com.wechar.biz.exam.dto.ExamCreateRequest;
import com.wechar.biz.exam.dto.ExamOrderData;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * P0-2 检查预约服务单测（Mockito）。
 *
 * 覆盖：关闭即拒绝、项目映射、建单先 HIS 后落单、幂等回放/冲突、时段占用 409、
 * 取消先 HIS 后本地、HIS 取消失败不本地取消。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ExamServiceTest {

    private static final String USER = "u-1";
    private static final String REQ = "EXR20261120120000-ABC123";
    private static final String HIS_NO = "EXM20261120-000001";
    private static final Instant NOW = Instant.parse("2026-11-20T04:00:00Z");
    private static final String SLOT = "20261121-0830";

    @Mock private HisClient hisClient;
    @Mock private ExamOrderRepository repository;

    private ExamGateway gateway;
    private ExamService service;

    @BeforeEach
    void setUp() {
        gateway = new ExamGateway(hisClient);
        service = new ExamService(new ExamSettings(true, "DEMO", "DEMO"), gateway,
                repository, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static ExamOrderRow row(String status) {
        return new ExamOrderRow(1L, REQ, USER, null, "张三", "LAB01", "血常规",
                new BigDecimal("25.00"), SLOT, "2026-11-21", "08:30", status,
                HIS_NO, "DEMO", "idem-1", null, NOW, NOW,
                "CANCELLED".equals(status) ? NOW : null);
    }

    private static HisClient.HisExamBookingResult hisResult() {
        return new HisClient.HisExamBookingResult(HIS_NO, REQ, "LAB01", "血常规",
                new BigDecimal("25.00"), SLOT, "2026-11-21", "08:30", "BOOKED", false);
    }

    private static ExamCreateRequest request(String item) {
        return new ExamCreateRequest(item, SLOT, "张三", null);
    }

    @Test
    void 未开启检查预约_建单直接拒绝() {
        ExamSettings disabled = new ExamSettings(false, "DEMO", "DEMO");
        ExamService disabledService = new ExamService(disabled, gateway, repository,
                Clock.fixed(NOW, ZoneOffset.UTC));

        ApiException error = assertThrows(ApiException.class,
                () -> disabledService.create(USER, request("LAB01"), "exam-idem-1"));
        assertEquals("EXAM_DISABLED", error.getCode());
        verify(hisClient, never()).bookExam(any());
    }

    @Test
    void LIVE配置_启动即失败() {
        assertThrows(IllegalStateException.class,
                () -> new ExamSettings(true, "LIVE", "DEMO"));
    }

    @Test
    void 项目列表映射且价格来自HIS() {
        when(hisClient.listExamItems()).thenReturn(List.of(
                new HisClient.HisExamItem("LAB01", "血常规", "检验", new BigDecimal("25.00"))));

        assertEquals(1, service.items().size());
        assertEquals("LAB01", service.items().get(0).itemCode());
        assertEquals(new BigDecimal("25.00"), service.items().get(0).price());
    }

    @Test
    void 建单先HIS占位再落本地() {
        when(repository.findByUserAndIdem(USER, "exam-idem-1")).thenReturn(Optional.empty());
        when(hisClient.bookExam(any())).thenReturn(hisResult());
        when(repository.findByRequestNo(anyString())).thenReturn(Optional.of(row("BOOKED")));

        ExamOrderData data = service.create(USER, request("LAB01"), "exam-idem-1");

        assertEquals(HIS_NO, data.examOrderNo());
        assertEquals("BOOKED", data.status());
        verify(repository).insert(anyString(), anyString(), any(), anyString(),
                anyString(), anyString(), any(), anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void 同幂等键同内容_回放不重复占位() {
        when(repository.findByUserAndIdem(USER, "exam-idem-1")).thenReturn(Optional.of(row("BOOKED")));

        ExamOrderData data = service.create(USER, request("LAB01"), "exam-idem-1");

        assertTrue(data.replayed());
        verify(hisClient, never()).bookExam(any());
    }

    @Test
    void 同幂等键不同内容_409() {
        when(repository.findByUserAndIdem(USER, "exam-idem-1")).thenReturn(Optional.of(row("BOOKED")));

        ApiException error = assertThrows(ApiException.class,
                () -> service.create(USER, request("LAB02"), "exam-idem-1"));
        assertEquals("IDEMPOTENCY_CONFLICT", error.getCode());
    }

    @Test
    void HIS时段被占_409且不落本地() {
        when(repository.findByUserAndIdem(USER, "exam-idem-1")).thenReturn(Optional.empty());
        when(hisClient.bookExam(any()))
                .thenThrow(new IllegalArgumentException("SLOT_TAKEN 该时段已被预约"));

        ApiException error = assertThrows(ApiException.class,
                () -> service.create(USER, request("LAB01"), "exam-idem-1"));
        assertEquals("EXAM_SLOT_TAKEN", error.getCode());
        verify(repository, never()).insert(anyString(), anyString(), any(), anyString(),
                anyString(), anyString(), any(), anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void 取消先HIS再本地置CANCELLED() {
        when(repository.findByRequestNo(REQ))
                .thenReturn(Optional.of(row("BOOKED")), Optional.of(row("CANCELLED")));
        when(repository.markCancelled(REQ)).thenReturn(1);

        ExamOrderData data = service.cancel(USER, REQ);

        assertEquals("CANCELLED", data.status());
        verify(hisClient).cancelExam(HIS_NO, "patient cancel");
        verify(repository).markCancelled(REQ);
    }

    @Test
    void HIS取消失败_503且本地保持BOOKED() {
        when(repository.findByRequestNo(REQ)).thenReturn(Optional.of(row("BOOKED")));
        org.mockito.Mockito.doThrow(new RuntimeException("timeout"))
                .when(hisClient).cancelExam(HIS_NO, "patient cancel");

        ApiException error = assertThrows(ApiException.class, () -> service.cancel(USER, REQ));
        assertEquals("HIS_UNAVAILABLE", error.getCode());
        verify(repository, never()).markCancelled(REQ);
    }

    @Test
    void 已取消重复取消_幂等回放() {
        when(repository.findByRequestNo(REQ)).thenReturn(Optional.of(row("CANCELLED")));

        ExamOrderData data = service.cancel(USER, REQ);

        assertTrue(data.replayed());
        assertFalse("BOOKED".equals(data.status()));
        verify(hisClient, never()).cancelExam(anyString(), anyString());
    }
}
