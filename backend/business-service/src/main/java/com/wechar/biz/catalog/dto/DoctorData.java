package com.wechar.biz.catalog.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** 契约 Doctor（additionalProperties:false，必填 id/name/departmentId/title）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DoctorData(String id, String name, String departmentId, String departmentName, String title,
                         String avatarUrl, List<String> specialties, String introduction,
                         Boolean hasAvailableSlot, String slotStatus, String slotStatusText) {
}
