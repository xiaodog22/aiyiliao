package com.wechar.biz.bed;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import java.util.List;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 护士站床位看板（2026-11-19）。
 *
 * <p>为什么单独一个控制器：审批路径是 {@code /api/v1/nurse/bed-applications}，床位列表是
 * {@code /api/v1/nurse/beds}，两者共享终端令牌但不共享申请单语义。只返回床位 ID/病区/标签/状态，
 * 不返回占用者姓名或手机号，避免护士站页面成为 PII 扩散面。</p>
 *
 * <pre>
 * GET /api/v1/nurse/beds?wardId=W01&amp;status=AVAILABLE
 * </pre>
 */
@RestController
@RequestMapping("/api/v1/nurse/beds")
public class NurseBedController {

    private static final Set<String> STATUSES =
            Set.of("AVAILABLE", "RESERVED", "OCCUPIED", "CLEANING", "OUT_OF_SERVICE");
    private static final int LIMIT = 200;

    private final BedRepository bedRepository;
    private final NurseStationGuard guard;

    public NurseBedController(BedRepository bedRepository, NurseStationGuard guard) {
        this.bedRepository = bedRepository;
        this.guard = guard;
    }

    @GetMapping
    public ResponseEntity<Envelope<List<NurseBedView>>> list(
            @RequestHeader(value = NurseStationGuard.HEADER, required = false) String stationToken,
            @RequestParam(required = false) String wardId,
            @RequestParam(required = false, defaultValue = "AVAILABLE") String status) {
        guard.require(stationToken);
        String s = status == null ? "AVAILABLE" : status.trim().toUpperCase();
        if (!STATUSES.contains(s)) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "status 只能是 AVAILABLE / RESERVED / OCCUPIED / CLEANING / OUT_OF_SERVICE");
        }
        List<BedRepository.BedRow> rows = bedRepository.listBedsByWard(wardId, s);
        if (rows.size() > LIMIT) {
            rows = rows.subList(0, LIMIT);
        }
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                rows.stream().map(NurseBedView::from).toList()));
    }

    /** 护士站床位视图：只给排床必需字段。 */
    public record NurseBedView(String id, String wardId, String wardName, String label, String status) {
        static NurseBedView from(BedRepository.BedRow row) {
            return new NurseBedView(row.id(), row.wardId(), row.wardName(), row.label(), row.status());
        }
    }
}
