package com.wechar.biz.indoor;

import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.indoor.dto.IndoorFloorData;
import com.wechar.biz.indoor.dto.IndoorRouteData;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 院内导航控制器（N17，2026-10-19，契约 /api/v1/indoor-map/*）：
 *  GET /floors 楼层清单 · GET /route 路径规划（均匿名只读，登记于 AuthInterceptor.ANONYMOUS）。
 */
@RestController
@RequestMapping("/api/v1/indoor-map")
public class IndoorMapController {

    private final IndoorMapService indoorMapService;

    public IndoorMapController(IndoorMapService indoorMapService) {
        this.indoorMapService = indoorMapService;
    }

    /** 契约 listIndoorFloors（N17）：楼层清单，匿名只读。 */
    @GetMapping("/floors")
    public ResponseEntity<Envelope<List<IndoorFloorData>>> listFloors() {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), indoorMapService.listFloors()));
    }

    /**
     * 契约 getIndoorRoute（N17）：from/to 契约必填，但用 required=false 接收后在服务层手动校验——
     * GlobalExceptionHandler 未处理 MissingRequestParameterException，Spring 直接抛会落 500 违约，
     * 这里统一转 400 中文信封。
     */
    @GetMapping("/route")
    public ResponseEntity<Envelope<IndoorRouteData>> route(
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), indoorMapService.route(from, to)));
    }
}
