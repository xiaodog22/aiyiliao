package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 契约 DoctorProfile（V21 新增 GET /api/v1/doctor/me；additionalProperties:false）。
 * 医生自述资料：解决「User 契约（additionalProperties:false）不含科室/职称，
 * 医生工作台/个人管理页只能靠 /doctors 名录姓名匹配」的缺口（遗留清单第 8 页 #6、第 22 页 #1）。
 * 全部字段来自 doctors 任职行与 departments；employeeNo 未登记 → null（不编造）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DoctorProfileData(
        String userId,
        String name,
        String employeeNo,
        String departmentId,
        String departmentName,
        String title
) {
}
