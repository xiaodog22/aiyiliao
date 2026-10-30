package com.wechar.biz.bed.dto;

import java.time.Instant;

/**
 * 契约 Bed：required=[id, wardId, label, status, version]。
 * occupantDisplayName 是**脱敏展示名**（服务端在写入时即脱敏，床位表不落明文姓名）。
 */
public record BedData(String id, String wardId, String wardName, String label, String status,
                      String occupantDisplayName, Instant admittedAt, int version) {
}
