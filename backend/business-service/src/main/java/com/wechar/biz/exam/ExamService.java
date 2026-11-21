package com.wechar.biz.exam;

import com.wechar.biz.appointment.his.HisClient;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.exam.ExamOrderRepository.ExamOrderRow;
import com.wechar.biz.exam.dto.ExamConfigData;
import com.wechar.biz.exam.dto.ExamCreateRequest;
import com.wechar.biz.exam.dto.ExamItemData;
import com.wechar.biz.exam.dto.ExamOrderData;
import com.wechar.biz.exam.dto.ExamSlotsData;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 检查预约服务（P0-2）。
 *
 * <p>闭环：项目/排期只读 → 建单（先 HIS 占位，再落本地）→ 查询/取消。
 * 状态只在 HIS 成功后推进；HIS 失败不落单、不显示成功。取消先 HIS 后本地，
 * HIS 失败保持 BOOKED 并返回 503，绝不本地单方取消造成双端不一致。
 */
@Service
public class ExamService {

    private static final Logger log = LoggerFactory.getLogger(ExamService.class);
    private static final DateTimeFormatter REQUEST_TIME =
            DateTimeFormatter.ofPattern("yyyyMMddHHmmss").withZone(ZoneId.of("Asia/Shanghai"));
    private static final int IDEM_MAX = 128;

    private final ExamSettings settings;
    private final ExamGateway gateway;
    private final ExamOrderRepository repository;
    private final Clock clock;

    public ExamService(ExamSettings settings, ExamGateway gateway,
                       ExamOrderRepository repository, Clock clock) {
        this.settings = settings;
        this.gateway = gateway;
        this.repository = repository;
        this.clock = clock;
    }

    public ExamConfigData config() {
        return new ExamConfigData(settings.enabled(), settings.mode(), settings.source(),
                "检查预约暂未开放，请到院窗口办理",
                "演示预约（未真实排期，不产生检查费用）");
    }

    public List<ExamItemData> items() {
        settings.requireEnabled();
        return gateway.items().stream()
                .map(i -> new ExamItemData(i.itemCode(), i.itemName(), i.category(), i.price(), true))
                .toList();
    }

    public ExamSlotsData slots(String itemCode) {
        settings.requireEnabled();
        List<HisClient.HisExamSlot> slots = gateway.slots(itemCode);
        return new ExamSlotsData(itemCode, "", slots.stream()
                .map(s -> new ExamSlotsData.ExamSlotData(s.slotKey(), s.slotDate(), s.slotTime(), s.available()))
                .toList());
    }

    @Transactional
    public ExamOrderData create(String userId, ExamCreateRequest request, String idemKey) {
        settings.requireEnabled();

        Optional<ExamOrderRow> byIdem = repository.findByUserAndIdem(userId, idemKey);
        if (byIdem.isPresent()) {
            ExamOrderRow row = byIdem.get();
            if (!canonical(row).equals(canonical(request))) {
                throw new ApiException("IDEMPOTENCY_CONFLICT", HttpStatus.CONFLICT,
                        "同一幂等键不能用于不同检查预约");
            }
            return toData(row, true);
        }

        String requestNo = newRequestNo();
        String hisIdem = trim("EXAM-" + userId + "-" + idemKey);
        HisClient.HisExamBookingResult his;
        try {
            his = gateway.book(new HisClient.HisExamBookingCommand(
                    requestNo, request.itemCode(), request.slotKey(), request.patientName(), hisIdem));
        } catch (ApiException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new ApiException("HIS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "检查预约系统暂时不可用，本次预约未成立，请稍后重试", true, null);
        }

        try {
            repository.insert(requestNo, userId, request.familyMemberId(), request.patientName(),
                    his.itemCode(), his.itemName(), his.price(), his.slotKey(), his.slotDate(),
                    his.slotTime(), his.examOrderNo(), settings.source(), idemKey);
        } catch (RuntimeException e) {
            // 本地落单失败 → 尽力释放 HIS 占位，避免「院内有单、平台无单」
            try {
                gateway.cancel(his.examOrderNo(), "local insert failed");
            } catch (RuntimeException ignored) {
                log.warn("检查预约本地落单失败且 HIS 释放失败 examOrderNo={}", his.examOrderNo());
            }
            Optional<ExamOrderRow> raced = repository.findByUserAndIdem(userId, idemKey);
            if (raced.isPresent()) {
                return toData(raced.get(), true);
            }
            throw new ApiException("EXAM_BOOK_FAILED", HttpStatus.CONFLICT,
                    "检查预约未成立，请稍后重试");
        }
        ExamOrderRow row = repository.findByRequestNo(requestNo)
                .orElseThrow(() -> new IllegalStateException("检查预约落库后不可读: " + requestNo));
        log.info("检查预约成功 requestNo={} examOrderNo={} item={} slot={}",
                requestNo, his.examOrderNo(), request.itemCode(), request.slotKey());
        return toData(row, his.replayed());
    }

    public List<ExamOrderData> listMine(String userId) {
        settings.requireEnabled();
        return repository.listByUser(userId).stream().map(r -> toData(r, false)).toList();
    }

    public ExamOrderData get(String userId, String requestNo) {
        settings.requireEnabled();
        return toData(owned(userId, requestNo), false);
    }

    @Transactional
    public ExamOrderData cancel(String userId, String requestNo) {
        settings.requireEnabled();
        ExamOrderRow row = owned(userId, requestNo);
        if ("CANCELLED".equals(row.status())) {
            return toData(row, true);
        }
        if (!"BOOKED".equals(row.status())) {
            throw new ApiException("EXAM_NOT_CANCELLABLE", HttpStatus.CONFLICT,
                    "当前检查预约状态不可取消");
        }
        if (row.hisOrderNo() != null && !row.hisOrderNo().isBlank()) {
            gateway.cancel(row.hisOrderNo(), "patient cancel");
        }
        int changed = repository.markCancelled(requestNo);
        ExamOrderRow latest = repository.findByRequestNo(requestNo).orElse(row);
        return toData(latest, changed == 0);
    }

    private ExamOrderRow owned(String userId, String requestNo) {
        ExamOrderRow row = repository.findByRequestNo(requestNo)
                .orElseThrow(() -> new ApiException("EXAM_ORDER_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "检查预约不存在"));
        if (!row.userId().equals(userId)) {
            throw new ApiException("EXAM_ORDER_FORBIDDEN", HttpStatus.FORBIDDEN,
                    "无权查看该检查预约");
        }
        return row;
    }

    private ExamOrderData toData(ExamOrderRow r, boolean replayed) {
        return new ExamOrderData(r.requestNo(), r.hisOrderNo(), r.itemCode(), r.itemName(),
                r.price(), r.slotKey(), r.slotDate(), r.slotTime(), r.status(), r.source(),
                replayed, r.createdAt());
    }

    private String newRequestNo() {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 6).toUpperCase();
        return "EXR" + REQUEST_TIME.format(Instant.now(clock)) + "-" + suffix;
    }

    private static String canonical(ExamOrderRow row) {
        return canonical(row.itemCode(), row.slotKey(), row.patientName(), row.familyMemberId());
    }

    private static String canonical(ExamCreateRequest request) {
        return canonical(request.itemCode(), request.slotKey(), request.patientName(),
                request.familyMemberId());
    }

    private static String canonical(String item, String slot, String patient, String family) {
        return String.join("|", nullToEmpty(item), nullToEmpty(slot), nullToEmpty(patient),
                nullToEmpty(family));
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private static String trim(String value) {
        return value.length() <= IDEM_MAX ? value : value.substring(0, IDEM_MAX);
    }
}
