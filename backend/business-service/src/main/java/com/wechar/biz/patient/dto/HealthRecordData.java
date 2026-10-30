package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.wechar.biz.patient.dto.AttachmentData;
import java.time.Instant;
import java.util.List;

/**
 * 契约 HealthRecord（additionalProperties:false；required=[id, category, recordedAt]）。
 * attachments 为检查资料附件（V9 落地：上传/查看/删除，短期签名 URL）；
 * source/doctorName 为记录来源；abnormal 为 null 表示"未判定"（客户端不得渲染正常/异常标记）；
 * reportStatus 为 null 表示非报告类/状态未知（客户端整个徽标不渲染）；
 * hospital 为 null 表示未记录就诊机构（客户端不渲染该行）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HealthRecordData(
        String id,
        String familyMemberId,
        String category,
        String title,
        String summary,
        Instant recordedAt,
        String source,
        String doctorName,
        Boolean abnormal,
        String reportStatus,
        String hospital,
        List<AttachmentData> attachments,
        Integer version
) {
}
