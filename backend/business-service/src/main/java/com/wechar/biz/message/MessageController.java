package com.wechar.biz.message;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Cursors;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.message.dto.MessageData;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 消息中心控制器（V21 契约新增）：
 *  GET  /api/v1/messages（cursor?/limit?，新→旧；身份范围过滤在 SQL 条件内）
 *  GET  /api/v1/messages/unread-count（未读红点唯一数据源）
 *  POST /api/v1/messages/{messageId}/read（幂等；他人/不存在同一 200，不泄露存在性）
 */
@RestController
@RequestMapping("/api/v1/messages")
public class MessageController {

    private static final int DEFAULT_LIMIT = 20;
    private static final int PATH_ID_MAX = 64;

    private final MessageService messageService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public MessageController(MessageService messageService, AuthService authService,
                             CurrentUserContext currentUserContext) {
        this.messageService = messageService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    @GetMapping
    public ResponseEntity<Envelope<List<MessageData>>> list(
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        MessageService.MessagePage page = messageService.list(userId, cursor, limit);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), page.items(),
                new Cursors.ApiMeta(page.nextCursor(), null, null)));
    }

    @GetMapping("/unread-count")
    public ResponseEntity<Envelope<Integer>> unreadCount() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), messageService.unreadCount(userId)));
    }

    @PostMapping("/{messageId}/read")
    public ResponseEntity<Envelope<Boolean>> markRead(@PathVariable String messageId) {
        if (messageId == null || messageId.isBlank() || messageId.length() > PATH_ID_MAX) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "messageId 长度须为 1~64 字符");
        }
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                messageService.markRead(userId, messageId)));
    }
}
