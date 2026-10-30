package com.wechar.biz.message;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Cursors;
import com.wechar.biz.message.dto.MessageData;
import com.wechar.biz.message.MessageRepository.MessageRow;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 消息中心服务（V21 医生-患者互通）：
 *  - notify()：业务事件写入消息（患者挂号成功 / 医生状态流转通知）；
 *  - list()/unreadCount()/markRead()：患者侧读取（身份范围过滤在 SQL 条件内）。
 *
 * 边界：消息内容只描述服务端已确认的事实（状态、时间、科室位置），
 * 不含诊断建议；refId 指向真实业务对象，客户端不得凭此构造敏感读取。
 */
@Service
public class MessageService {

    /** 契约 MessageCenterItem.type 枚举。 */
    public static final String TYPE_APPOINTMENT_CREATED = "APPOINTMENT_CREATED";
    public static final String TYPE_APPOINTMENT_STATUS = "APPOINTMENT_STATUS";
    public static final String TYPE_SYSTEM_NOTICE = "SYSTEM_NOTICE";
    /** V21 医生回复问诊通知（患者消息中心未读红点；refType=consultation，refId=会话 id）。 */
    public static final String TYPE_CONSULT_REPLY = "CONSULT_REPLY";
    /** V23 患者指定医生发起在线问诊申请（医生消息中心未读红点；refType=consultation，refId=会话 id）。 */
    public static final String TYPE_CONSULT_APPLY = "CONSULT_APPLY";

    private static final int MAX_LIMIT = 50;

    private final MessageRepository repository;
    private final Clock clock;

    public MessageService(MessageRepository repository, Clock clock) {
        this.repository = repository;
        this.clock = clock;
    }

    /**
     * 业务事件通知（内部调用，非 HTTP 面）。
     * 与调用方同一事务：消息写入失败则业务流转整体回滚（不出现"状态变了但没通知"）。
     */
    @Transactional
    public void notify(String userId, String type, String title, String body,
                       String refType, String refId) {
        if (userId == null || userId.isBlank() || type == null || type.isBlank()
                || title == null || title.isBlank()) {
            return; // 无接收人或无实质内容 → 不写空消息
        }
        repository.insert(new MessageRow("msg-" + UUID.randomUUID(), userId, type,
                title, body, refType, refId, null, clock.instant()));
    }

    /** 列表（新→旧，cursor 双键分页）：返回 items + nextCursor。 */
    @Transactional(readOnly = true)
    public MessagePage list(String userId, String cursor, int limit) {
        int bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
        Instant cursorTime = null;
        String cursorId = null;
        if (cursor != null && !cursor.isBlank()) {
            Cursors.PageCursor decoded = Cursors.decode(cursor.trim());
            cursorTime = decoded.createdAt();
            cursorId = decoded.id();
        }
        List<MessageRow> rows = repository.listByUser(userId, cursorTime, cursorId, bounded + 1);
        boolean hasMore = rows.size() > bounded;
        List<MessageRow> page = hasMore ? rows.subList(0, bounded) : rows;
        String nextCursor = hasMore && !page.isEmpty()
                ? Cursors.encode(page.get(page.size() - 1).createdAt(), page.get(page.size() - 1).id())
                : null;
        return new MessagePage(page.stream().map(MessageService::toData).toList(), nextCursor);
    }

    @Transactional(readOnly = true)
    public int unreadCount(String userId) {
        return repository.countUnread(userId);
    }

    /** 标记已读（幂等：已读/不存在/他人 → 200 同结果，不泄露存在性）。 */
    @Transactional
    public boolean markRead(String userId, String id) {
        if (id == null || id.isBlank() || id.length() > 64) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "消息 id 长度须为 1~64 字符");
        }
        return repository.markRead(userId, id, clock.instant());
    }

    private static MessageData toData(MessageRow row) {
        return new MessageData(row.id(), row.type(), row.title(), row.body(),
                row.refType(), row.refId(), row.readAt() != null, row.createdAt());
    }

    public record MessagePage(List<MessageData> items, String nextCursor) {
    }
}
