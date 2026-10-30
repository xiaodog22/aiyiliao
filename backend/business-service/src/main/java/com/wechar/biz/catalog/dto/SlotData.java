package com.wechar.biz.catalog.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.math.BigDecimal;
import java.time.Instant;

/** 契约 Slot（additionalProperties:false，必填 id/doctorId/startTime/endTime/remaining）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SlotData(String id, String doctorId, Instant startTime, Instant endTime, Integer remaining,
                       BigDecimal fee, String currency) {
}
