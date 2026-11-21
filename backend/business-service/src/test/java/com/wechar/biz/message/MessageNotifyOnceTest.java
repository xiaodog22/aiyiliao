package com.wechar.biz.message;

import com.wechar.biz.message.MessageRepository.MessageRow;
import java.time.Clock;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.dao.DuplicateKeyException;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * P0-3 消息幂等单测：notifyOnce 的三种判定路径。
 * 唯一索引 uq_messages_user_biz 是最终裁决点；本测试验证服务层在
 * ①已存在 ②并发撞键 ③bizKey 为空 三种情况下的行为，避免重复提醒。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class MessageNotifyOnceTest {

    private static final Instant NOW = Instant.parse("2026-11-20T06:00:00Z");
    private static final String USER = "u-1";
    private static final String KEY = "REPORT_READY:hr-1";

    @Mock private MessageRepository repository;
    @Mock private Clock clock;

    private MessageService service;

    @BeforeEach
    void setUp() {
        when(clock.instant()).thenReturn(NOW);
        service = new MessageService(repository, clock);
    }

    @Test
    void 新幂等键_写入一条并带bizKey() {
        when(repository.existsByBizKey(USER, KEY)).thenReturn(false);

        assertTrue(service.notifyOnce(USER, MessageService.TYPE_REPORT_READY, "检查报告已出具",
                "您的报告已出具。", "report", "hr-1", KEY));

        verify(repository).insert(any(MessageRow.class));
    }

    @Test
    void 已存在幂等键_返回false不重复写() {
        when(repository.existsByBizKey(USER, KEY)).thenReturn(true);

        assertFalse(service.notifyOnce(USER, MessageService.TYPE_REPORT_READY, "检查报告已出具",
                "您的报告已出具。", "report", "hr-1", KEY));

        verify(repository, never()).insert(any(MessageRow.class));
    }

    @Test
    void 并发撞唯一键_按已通知处理返回false() {
        when(repository.existsByBizKey(USER, KEY)).thenReturn(false);
        doThrow(new DuplicateKeyException("uq_messages_user_biz")).when(repository)
                .insert(any(MessageRow.class));

        assertFalse(service.notifyOnce(USER, MessageService.TYPE_REPORT_READY, "检查报告已出具",
                "您的报告已出具。", "report", "hr-1", KEY));
    }

    @Test
    void 幂等键为空_退化为普通notify() {
        assertTrue(service.notifyOnce(USER, MessageService.TYPE_SYSTEM_NOTICE, "系统通知",
                "内容", null, null, " "));

        verify(repository).insert(any(MessageRow.class));
    }
}
