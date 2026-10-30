package com.wechar.biz.deletion;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.common.GlobalExceptionHandler;
import com.wechar.biz.deletion.dto.DeletionRequestCreateRequest;
import com.wechar.biz.deletion.dto.DeletionRequestData;
import com.wechar.biz.deletion.dto.RetainedItemData;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 删除/注销申请服务（契约 createDeletionRequest / getDeletionRequest + docs/v4/07 §9.2）。
 *
 * 红线遵守：
 *  - 返回的是**受理状态**（RECEIVED）而非"已删除"——不设 completedAt、不声明完成；
 *  - 法定保留例外必须**逐项**说明范围与依据，绝不用"已全部删除"概括；
 *  - 保留期限在 07 §8 全部标注"待确认"（未获法务确认）→ retainUntil 一律 null，不编造日期；
 *  - 他人的申请一律 404（不返回 403，避免存在性泄漏）；
 *  - 幂等：同键同载荷 → 重放同一申请；同键异载荷 → 409。
 */
@Service
public class DeletionService {

    /** 契约 DeletionRequestCreate.scope 全集。 */
    private static final Set<String> SCOPES = Set.of("ACCOUNT", "PROFILE", "HEALTH_RECORDS",
            "CONSULTATIONS", "VOICE_DATA", "UPLOADS");

    private static final int REASON_MAX = 200;

    private final DeletionRepository repository;
    private final Clock clock;

    public DeletionService(DeletionRepository repository, Clock clock) {
        this.repository = repository;
        this.clock = clock;
    }

    @Transactional
    public DeletionRequestData create(String userId, String idempotencyKey, DeletionRequestCreateRequest request) {
        List<String> scope = request.scope();
        if (scope == null || scope.isEmpty()) {
            throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST, "scope 至少需要一项（minItems 1）");
        }
        for (String item : scope) {
            if (item == null || !SCOPES.contains(item)) {
                throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST,
                        "scope 取值须属于 [ACCOUNT, PROFILE, HEALTH_RECORDS, CONSULTATIONS, VOICE_DATA, UPLOADS]");
            }
        }
        String reason = request.reason();
        if (reason != null && reason.length() > REASON_MAX) {
            throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST, "reason 长度不得超过 200 字符");
        }

        String digest = Digests.sha256Hex(String.join(",", scope) + "|" + (reason == null ? "" : reason));
        var existing = repository.findByIdempotencyKey(userId, idempotencyKey);
        if (existing.isPresent()) {
            if (!DeletionRepository.sameDigest(existing.get(), digest)) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键", false,
                        List.of(new GlobalExceptionHandler.ErrorDetail(
                                "Idempotency-Key", "同键不同载荷，按契约返回 409", "IDEMPOTENCY_KEY_REUSE")));
            }
            return toData(existing.get());
        }

        Instant now = clock.instant();
        String id = "dr-" + UUID.randomUUID();
        List<RetainedItemData> retained = retainedItemsFor(scope);
        repository.insert(new DeletionRepository.DeletionRow(id, userId, repository.toJson(scope), "RECEIVED",
                reason, repository.toJson(retained), idempotencyKey, digest, now, null));
        return toData(repository.findByIdForUser(id, userId)
                .orElseThrow(() -> new ApiException("INTERNAL_ERROR", HttpStatus.INTERNAL_SERVER_ERROR,
                        "删除申请写入后读取失败", true, null)));
    }

    /** 契约 getDeletionRequest：他人的申请一律 404。 */
    @Transactional(readOnly = true)
    public DeletionRequestData get(String userId, String requestId) {
        return repository.findByIdForUser(requestId, userId).map(DeletionService::toData)
                .orElseThrow(() -> new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND,
                        "删除申请不存在或不属于当前用户"));
    }

    /**
     * 法定保留例外（docs/v4/07 §8）：逐项列出范围与依据；期限未获法务确认 → retainUntil 保持 null。
     * 依据文本直接引用 07 的条目原文与其"待确认"状态，不夸大也不省略。
     */
    private static List<RetainedItemData> retainedItemsFor(List<String> scope) {
        List<RetainedItemData> items = new ArrayList<>();
        items.add(new RetainedItemData("注销申请记录",
                "保留 3 年以证明已履行删除义务（docs/v4/07 §8，期限待法务确认）", null));
        items.add(new RetainedItemData("审计日志",
                "操作与安全审计日志按 6 个月~1 年保留（docs/v4/07 §8，期限待确认）", null));
        items.add(new RetainedItemData("备份",
                "备份按 RPO 设计加密保留，删除通过再删除机制在后续备份窗口生效（docs/v4/07 §9.2 第 4 条）", null));
        if (scope.contains("ACCOUNT") || scope.contains("PROFILE")) {
            items.add(new RetainedItemData("同意与撤回记录",
                    "账号注销后保留 3 年，可能受法定义务约束（docs/v4/07 §8，待确认）", null));
        }
        if (scope.contains("HEALTH_RECORDS") || scope.contains("CONSULTATIONS")) {
            items.add(new RetainedItemData("预约与就诊记录",
                    "按医疗档案相关法规执行，须法务与医疗共同确认（docs/v4/07 §8，未确认）", null));
        }
        return items;
    }

    private static DeletionRequestData toData(DeletionRepository.DeletionRow row) {
        return new DeletionRequestData(row.id(), DeletionRepository.parseStringList(row.scopeJson()),
                row.status(), DeletionRepository.parseRetainedItems(row.retainedJson()),
                row.createdAt(), row.completedAt());
    }
}
