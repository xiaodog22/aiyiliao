package com.wechar.biz.deletion.dto;

import java.time.Instant;
import java.util.List;

/**
 * 契约 DeletionRequest：required=[requestId, scope, status, createdAt]。
 * retainedItems 为逐项法定保留例外（不省略、不概括）；createdAt 为受理时间（≠ 已删除）。
 */
public record DeletionRequestData(String requestId, List<String> scope, String status,
                                  List<RetainedItemData> retainedItems, Instant createdAt, Instant completedAt) {
}
