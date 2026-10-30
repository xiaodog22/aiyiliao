package com.wechar.biz.catalog.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 契约 Department（additionalProperties:false，必填 id/name）。
 * location 为面向用户的整串展示；building/floor/area/roomNo 为结构化字段（导航/排序用）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DepartmentData(String id, String name, String hospitalId, String hospitalName,
                             String location, String building, String floor, String area, String roomNo,
                             String description, String iconKey) {
}
