package com.wechar.biz.home.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/** 契约 HomeSummary.blocks[].services 元素（必填 code/label）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HomeServiceItem(String code, String label, String iconKey) {
}
