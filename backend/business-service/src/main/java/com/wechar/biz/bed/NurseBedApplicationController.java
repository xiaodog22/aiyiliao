package com.wechar.biz.bed;

import com.wechar.biz.bed.dto.BedApplicationData;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 护士站床位申请审批端点（2026-11-19）。
 *
 * <p>与 dev 端点 {@code /api/v1/dev/bed-applications} 的区别：
 *  · 不受 {@code dev} profile 限制，生产档也可用；
 *  · 用病区护士站终端令牌 {@link NurseStationGuard} 鉴权，而不是无鉴权的 dev 端点；
 *  · 只暴露「列待审 / 通过 / 驳回」，不暴露医生提交与我的申请（医生走 /api/v1/beds/applications）。</p>
 *
 * <p>接口：</p>
 * <pre>
 * GET  /api/v1/nurse/bed-applications?status=PENDING&amp;wardId=...
 * POST /api/v1/nurse/bed-applications/{id}/approve   {"note":"..."}
 * POST /api/v1/nurse/bed-applications/{id}/reject    {"note":"..."}
 * </pre>
 *
 * <p>令牌请求头：{@code X-Nurse-Station-Token}。未配置令牌 → 503；令牌错误 → 403。</p>
 */
@RestController
@RequestMapping("/api/v1/nurse/bed-applications")
public class NurseBedApplicationController {

    private static final int PATH_ID_MAX = 64;
    private static final String REVIEWER = "nurse-station";

    private final BedApplicationService applicationService;
    private final NurseStationGuard guard;

    public NurseBedApplicationController(BedApplicationService applicationService,
                                         NurseStationGuard guard) {
        this.applicationService = applicationService;
        this.guard = guard;
    }

    @GetMapping
    public ResponseEntity<Envelope<List<BedApplicationData>>> list(
            @RequestHeader(value = NurseStationGuard.HEADER, required = false) String stationToken,
            @RequestParam(required = false, defaultValue = "PENDING") String status,
            @RequestParam(required = false) String wardId) {
        guard.require(stationToken);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                applicationService.listForNurse(status, wardId)));
    }

    @PostMapping("/{id}/approve")
    public ResponseEntity<Envelope<BedApplicationData>> approve(
            @PathVariable String id,
            @RequestHeader(value = NurseStationGuard.HEADER, required = false) String stationToken,
            @RequestParam(required = false) String wardId,
            @RequestBody(required = false) ReviewRequest request) {
        guard.require(stationToken);
        requireId(id);
        String bedId = request == null ? null : request.bedId();
        String note = request == null ? null : request.note();
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                applicationService.reviewForNurse(id, "APPROVED", note, REVIEWER, wardId, bedId)));
    }

    @PostMapping("/{id}/reject")
    public ResponseEntity<Envelope<BedApplicationData>> reject(
            @PathVariable String id,
            @RequestHeader(value = NurseStationGuard.HEADER, required = false) String stationToken,
            @RequestParam(required = false) String wardId,
            @RequestBody(required = false) ReviewRequest request) {
        guard.require(stationToken);
        requireId(id);
        String note = request == null ? null : request.note();
        if (note == null || note.isBlank()) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "驳回必须填写原因（便于医生补充材料后重新申请）");
        }
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                applicationService.reviewForNurse(id, "REJECTED", note, REVIEWER, wardId, null)));
    }

    private static void requireId(String id) {
        if (id == null || id.isBlank() || id.length() > PATH_ID_MAX) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "申请 ID 长度须为 1~64 字符");
        }
    }

    /** 审批载荷：bedId 选填（通过时用于排床/改床）；note 选填（通过时可写排床说明，驳回时必填原因）。 */
    public record ReviewRequest(String bedId, String note) {
    }
}
