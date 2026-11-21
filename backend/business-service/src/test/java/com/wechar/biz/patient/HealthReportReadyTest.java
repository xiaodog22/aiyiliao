package com.wechar.biz.patient;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.message.MessageService;
import com.wechar.biz.patient.dto.ReportReadyData;
import java.time.Clock;
import java.time.Instant;
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
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * P0-3 报告发布单测：READY 门禁、幂等与提醒开关。
 *
 * 覆盖四个关键语义：
 *   ① PENDING/REVIEWING → READY 时写 1 条消息，bizKey=REPORT_READY:{recordId}；
 *   ② 已 READY 时按幂等成功返回，消息已存在则不重复写；
 *   ③ 状态 NULL / 非 EXAM 一律 422，不把"未知"当"已出具"；
 *   ④ APP_REPORT_NOTIFY_ENABLED=false 时只发布状态、不写消息。
 *
 * 注：H2 单测档没有 V27 报告表（Flyway target=26.x），本测试用 Mock 验证服务语义，
 * 真实 SQL（markReady / 唯一索引）由 MySQL 运行时验收覆盖。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class HealthReportReadyTest {

    private static final Instant NOW = Instant.parse("2026-11-20T06:00:00Z");
    private static final String USER = "u-1";
    private static final String RECORD = "hr-1";

    @Mock private HealthReportRepository reports;
    @Mock private HealthRecordRepository healthRecords;
    @Mock private AttachmentRepository attachments;
    @Mock private AttachmentStorage storage;
    @Mock private MessageService messages;
    @Mock private Clock clock;

    private HealthReportService service;

    @BeforeEach
    void setUp() {
        when(clock.instant()).thenReturn(NOW);
        service = new HealthReportService(reports, healthRecords, attachments, storage,
                messages, clock, true);
    }

    private static HealthRecordRepository.HealthRecordRow record(String status) {
        return new HealthRecordRepository.HealthRecordRow(RECORD, USER, null, "EXAM",
                "血常规检验报告（待审核）", "演示摘要", NOW, "DEMO_SEED_V9010", "演示医师（模拟）",
                Boolean.FALSE, status, "演示医学检验中心（模拟）", 1, null, null, NOW, null);
    }

    private static HealthReportRepository.DetailRow detail(Instant reportedAt, boolean demo) {
        return new HealthReportRepository.DetailRow("hrd-1", RECORD, USER, "DEMO-20261020-001",
                "LAB", "演示医学检验中心（模拟）", "LAB", "检验科", "演示患者甲", "MALE", "45岁",
                "DEMO-OP-1", null, "演示诊断", "演示医师（模拟）", "静脉血", "DEMO-SP-1",
                NOW, NOW, NOW, reportedAt, "演示检验员（模拟）", "演示审核员（模拟）",
                "模拟方法学", "演示设备", null, null, "模拟结论", "演示数据", "DEMO", null,
                null, null, demo, "演示数据 · 非真实医疗报告 · 不构成诊断依据");
    }

    @Test
    void 待审核报告_置READY并只写一条消息() {
        when(healthRecords.findById(USER, RECORD)).thenReturn(Optional.of(record("REVIEWING")));
        when(reports.findDetail(USER, RECORD)).thenReturn(Optional.of(detail(null, true)));
        when(reports.markReady(eq(USER), eq(RECORD), any())).thenReturn(true);
        when(messages.notifyOnce(eq(USER), eq(MessageService.TYPE_REPORT_READY), anyString(),
                anyString(), eq("report"), eq(RECORD), eq("REPORT_READY:" + RECORD))).thenReturn(true);

        ReportReadyData ready = service.publishReady(USER, RECORD);

        assertEquals("READY", ready.reportStatus());
        assertTrue(ready.messageCreated());
        assertEquals(NOW, ready.reportedAt());
        verify(messages).notifyOnce(eq(USER), eq(MessageService.TYPE_REPORT_READY), anyString(),
                org.mockito.ArgumentMatchers.contains("血常规检验报告"),
                eq("report"), eq(RECORD), eq("REPORT_READY:" + RECORD));
        verify(messages, never()).notifyOnce(anyString(), anyString(),
                org.mockito.ArgumentMatchers.contains("待审核"), anyString(), anyString(), anyString(), anyString());
    }

    @Test
    void 已READY报告_重复发布幂等且不重复写消息() {
        when(healthRecords.findById(USER, RECORD)).thenReturn(Optional.of(record("READY")));
        when(reports.findDetail(USER, RECORD)).thenReturn(Optional.of(detail(NOW, true)));
        when(reports.markReady(eq(USER), eq(RECORD), any())).thenReturn(false);
        when(messages.notifyOnce(anyString(), anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString())).thenReturn(false);

        ReportReadyData ready = service.publishReady(USER, RECORD);

        assertEquals("READY", ready.reportStatus());
        assertFalse(ready.messageCreated());
        assertEquals(NOW, ready.reportedAt());
    }

    @Test
    void 状态为空的报告_拒绝发布() {
        when(healthRecords.findById(USER, RECORD)).thenReturn(Optional.of(record(null)));
        when(reports.findDetail(USER, RECORD)).thenReturn(Optional.of(detail(null, true)));
        when(reports.markReady(eq(USER), eq(RECORD), any())).thenReturn(false);

        ApiException ex = assertThrows(ApiException.class, () -> service.publishReady(USER, RECORD));
        assertEquals("VALIDATION_FAILED", ex.getCode());
        verify(messages, never()).notifyOnce(anyString(), anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void 非检查报告档案_拒绝发布() {
        var vitals = new HealthRecordRepository.HealthRecordRow(RECORD, USER, null, "VITALS",
                "血压记录", "118/76", NOW, null, null, null, null, null, 1, null, null, NOW, null);
        when(healthRecords.findById(USER, RECORD)).thenReturn(Optional.of(vitals));

        ApiException ex = assertThrows(ApiException.class, () -> service.publishReady(USER, RECORD));
        assertEquals("VALIDATION_FAILED", ex.getCode());
        verify(reports, never()).findDetail(anyString(), anyString());
    }

    @Test
    void 提醒关闭_仍发布状态但不写消息() {
        HealthReportService quiet = new HealthReportService(reports, healthRecords, attachments,
                storage, messages, clock, false);
        when(healthRecords.findById(USER, RECORD)).thenReturn(Optional.of(record("PENDING")));
        when(reports.findDetail(USER, RECORD)).thenReturn(Optional.of(detail(null, true)));
        when(reports.markReady(eq(USER), eq(RECORD), any())).thenReturn(true);

        ReportReadyData ready = quiet.publishReady(USER, RECORD);

        assertEquals("READY", ready.reportStatus());
        assertFalse(ready.messageCreated());
        verify(messages, never()).notifyOnce(anyString(), anyString(), anyString(), anyString(),
                anyString(), anyString(), anyString());
    }
}
