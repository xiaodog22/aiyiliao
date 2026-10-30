package com.wechar.biz.home.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** 契约 HomeSummary（必填 blocks）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HomeSummaryData(String greeting, List<HomeBlockData> blocks) {
}
