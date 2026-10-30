package com.wechar.biz.indoor;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.indoor.dto.IndoorFloorData;
import com.wechar.biz.indoor.dto.IndoorRouteData;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * 院内导航服务（N17，2026-10-19）。
 *
 * 数据源（唯一真源）：tools/floorplan-src.json，经 tools/build-floorplan.py 的同一套派生逻辑
 * 生成 classpath:indoor-map.json（与 miniprogram/packageNav/data/indoor-map.js 同值：百分比坐标 /
 * distanceM / steps / stepsBack）。改坐标须同步两处：改 floorplan-src.json → 重跑
 * build-floorplan.py → 重新生成本资源文件（两侧都不得手改派生字段）。
 *
 * 路径算法（真实计算，不臆造）：数据内所有路径经医院大门（ORIGIN，id=gate）连通——
 * 大门↔目的地取目的地去程（path/steps）或回程（path 反转/stepsBack）；
 * 目的地 A→目的地 B 为「A 回大门 + B 出大门」两段拼接（折线去掉重复的大门点、
 * steps 去掉首尾衔接步「到达医院大门」「从医院大门出发」，distanceM 直接相加，不重算像素）。
 *
 * 资源缺失/解析失败在 Bean 创建时即抛 IllegalStateException → 启动失败，不降级伪造空数据。
 */
@Service
public class IndoorMapService {

    private static final String RESOURCE = "indoor-map.json";

    /** 楼层 ID 提取正则（"门诊楼 1F" → "1F"）；提取失败时的兜底常量——当前数据只有门诊楼 1F。 */
    private static final String FALLBACK_FLOOR_ID = "1F";
    private static final Pattern FLOOR_ID_PATTERN = Pattern.compile("(\\d+\\s*[Ff])");

    /** 单个导航节点（gate 或目的地）。path 为底图百分比折线；distanceM/steps/stepsBack 均以数据源为准。 */
    private record Node(String id, String name, double x, double y,
                        List<List<Double>> path, List<String> steps, List<String> stepsBack,
                        int distanceM) {
    }

    private final IndoorFloorData floor;
    private final String originId;
    private final String originName;
    private final Map<String, Node> nodes = new LinkedHashMap<>();

    public IndoorMapService() {
        try (InputStream in = IndoorMapService.class.getClassLoader().getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException("缺少 classpath:" + RESOURCE);
            }
            JsonNode root = new ObjectMapper().readTree(in);
            this.floor = buildFloor(root);
            JsonNode origin = root.path("ORIGIN");
            this.originId = origin.path("id").asText("");
            this.originName = origin.path("name").asText("");
            double ox = origin.path("x").asDouble();
            double oy = origin.path("y").asDouble();
            this.nodes.put(this.originId,
                    new Node(this.originId, this.originName, ox, oy,
                            List.of(List.of(ox, oy)), List.of(), List.of(), 0));
            for (JsonNode d : root.path("DESTINATIONS")) {
                Node node = new Node(d.path("id").asText(""), d.path("name").asText(""),
                        d.path("x").asDouble(), d.path("y").asDouble(),
                        readPath(d.path("path")), readTexts(d.path("steps")),
                        readTexts(d.path("stepsBack")), d.path("distanceM").asInt());
                this.nodes.put(node.id(), node);
            }
        } catch (IOException e) {
            throw new IllegalStateException("院内导航数据解析失败：" + RESOURCE, e);
        }
    }

    /** 契约 listIndoorFloors：当前为单层数据（门诊楼 1F）→ 单元素清单。 */
    public List<IndoorFloorData> listFloors() {
        return List.of(floor);
    }

    /** 契约 getIndoorRoute：from/to 缺失或空白 → 400；节点不存在 → 404；否则按数据真实拼接。 */
    public IndoorRouteData route(String from, String to) {
        String srcId = from == null ? "" : from.trim();
        String dstId = to == null ? "" : to.trim();
        if (srcId.isEmpty() || dstId.isEmpty()) {
            throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST, "缺少必需参数 from/to");
        }
        Node a = nodes.get(srcId);
        if (a == null) {
            throw new ApiException("INDOOR_NODE_NOT_FOUND", HttpStatus.NOT_FOUND, "导航节点不存在：" + srcId);
        }
        Node b = nodes.get(dstId);
        if (b == null) {
            throw new ApiException("INDOOR_NODE_NOT_FOUND", HttpStatus.NOT_FOUND, "导航节点不存在：" + dstId);
        }
        if (srcId.equals(dstId)) {
            // 同点：path=[该点]，steps=已在某处，distanceM=0
            return new IndoorRouteData(srcId, dstId,
                    List.of(List.of(a.x(), a.y())), List.of("已在" + a.name()), 0);
        }
        if (a.id().equals(originId)) {
            // 大门 → 目的地：数据源去程段
            return new IndoorRouteData(srcId, dstId, b.path(), b.steps(), b.distanceM());
        }
        // 目的地 → 大门：数据源回程段（path 反转 + stepsBack）
        List<List<Double>> path = new ArrayList<>(a.path());
        Collections.reverse(path);
        if (b.id().equals(originId)) {
            return new IndoorRouteData(srcId, dstId, path, a.stepsBack(), a.distanceM());
        }
        // 目的地 A → 目的地 B：A 回大门 + B 出大门。折线去掉 B 段重复的大门首点，
        // steps 去掉首尾衔接步（A 的「到达医院大门」、B 的「从医院大门出发」），距离直接相加。
        path.addAll(b.path().subList(1, b.path().size()));
        List<String> steps = new ArrayList<>(a.stepsBack());
        String arriveOrigin = "到达" + originName;
        if (!steps.isEmpty() && arriveOrigin.equals(steps.get(steps.size() - 1))) {
            steps.remove(steps.size() - 1);
        }
        List<String> tail = new ArrayList<>(b.steps());
        String departOrigin = "从" + originName + "出发";
        if (!tail.isEmpty() && departOrigin.equals(tail.get(0))) {
            tail.remove(0);
        }
        steps.addAll(tail);
        return new IndoorRouteData(srcId, dstId, path, steps, a.distanceM() + b.distanceM());
    }

    /** 楼层：从 name 提取楼层 ID 与楼栋名（"门诊楼 1F" → id=1F、building=门诊楼）；提取不了用兜底常量 1F。 */
    private static IndoorFloorData buildFloor(JsonNode root) {
        String name = root.path("FLOOR").path("name").asText("");
        String originId = root.path("ORIGIN").path("id").asText("");
        Matcher m = FLOOR_ID_PATTERN.matcher(name);
        if (m.find()) {
            String id = m.group(1).replaceAll("\\s+", "").toUpperCase();
            String building = (name.substring(0, m.start()) + name.substring(m.end())).trim();
            return new IndoorFloorData(id, name, building.isEmpty() ? null : building, originId);
        }
        return new IndoorFloorData(FALLBACK_FLOOR_ID, name, null, originId);
    }

    private static List<List<Double>> readPath(JsonNode arr) {
        List<List<Double>> pts = new ArrayList<>();
        for (JsonNode p : arr) {
            if (p.size() < 2) {
                throw new IllegalStateException("院内导航路径点缺少坐标分量：" + p);
            }
            pts.add(List.of(p.get(0).asDouble(), p.get(1).asDouble()));
        }
        return pts;
    }

    private static List<String> readTexts(JsonNode arr) {
        List<String> out = new ArrayList<>();
        for (JsonNode s : arr) {
            out.add(s.asText(""));
        }
        return out;
    }
}
