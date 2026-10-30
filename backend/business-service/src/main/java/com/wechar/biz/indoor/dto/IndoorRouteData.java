package com.wechar.biz.indoor.dto;

import java.util.List;

/**
 * 契约 IndoorRoute（N17，2026-10-19；additionalProperties:false，
 * required=[from, to, path, steps, distanceM]；path 为底图百分比 [x, y]，distanceM 为整数米）。
 */
public record IndoorRouteData(String from, String to, List<List<Double>> path, List<String> steps, int distanceM) {
}
