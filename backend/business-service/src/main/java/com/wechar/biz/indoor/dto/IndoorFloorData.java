package com.wechar.biz.indoor.dto;

/** 契约 IndoorFloor（N17，2026-10-19；additionalProperties:false，required=[id, name]，building/originId 可空）。 */
public record IndoorFloorData(String id, String name, String building, String originId) {
}
