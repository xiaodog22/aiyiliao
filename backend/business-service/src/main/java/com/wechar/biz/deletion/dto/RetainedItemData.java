package com.wechar.biz.deletion.dto;

/**
 * 契约 DeletionRequest.retainedItems 条目：required=[category, reason]，retainUntil 可空。
 * 契约明文：必须逐项说明范围与依据，不能用"已全部删除"概括，也不得为好看而省略。
 */
public record RetainedItemData(String category, String reason, String retainUntil) {
}
