package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 PatientProfile（GET/POST/PATCH /api/v1/patients 的元素）。
 *
 * 安全口径（C3，2026-11-27 定稿）：
 *   · 不含 HIS MRN、不含任何哈希、不含 HIS patientId —— 客户端只用 patientRef 引用就诊人；
 *   · patientRef 由服务端生成（pat- + UUIDv4 hex），客户端不得解析，日志只记 sha256[:16]；
 *   · idMasked 只可能是「星号 + 尾 4 位」：库里只存证件哈希与尾号，前 6 位从未落库。
 *
 * created 仅在创建接口返回：true=新建，false=命中同用户同姓名既有记录（幂等）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PatientData(
        String patientRef,
        String displayName,
        String relation,
        String familyMemberId,
        String birthDate,
        String sex,
        String idMasked,
        String phoneMasked,
        String verificationLevel,
        String status,
        String linkState,
        int version,
        Boolean created,
        Instant createdAt,
        Instant updatedAt
) {
}
