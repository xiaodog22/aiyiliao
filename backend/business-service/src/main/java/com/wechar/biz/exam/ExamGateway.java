package com.wechar.biz.exam;

import com.wechar.biz.appointment.his.HisClient;
import com.wechar.biz.common.ApiException;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 检查预约 HIS 门面（P0-2）。
 *
 * <p>失败一律显式：排期不可用 503；时段被占 409；申请号/幂等键冲突 409。
 * 不允许把 HIS 异常吞成「预约成功」。
 */
@Component
public class ExamGateway {

    private static final Logger log = LoggerFactory.getLogger(ExamGateway.class);

    private final HisClient client;

    public ExamGateway(HisClient client) {
        this.client = client;
    }

    public List<HisClient.HisExamItem> items() {
        try {
            return client.listExamItems();
        } catch (RuntimeException e) {
            log.warn("exam items failed: {}", e.toString());
            throw unavailable("检查项目暂时不可用，请稍后重试");
        }
    }

    public List<HisClient.HisExamSlot> slots(String itemCode) {
        try {
            return client.listExamSlots(itemCode);
        } catch (RuntimeException e) {
            if (has(e, "NOT_FOUND")) {
                throw new ApiException("EXAM_ITEM_NOT_FOUND", HttpStatus.NOT_FOUND, "检查项目不存在");
            }
            log.warn("exam slots failed item={}: {}", itemCode, e.toString());
            throw unavailable("检查排期暂时不可用，请稍后重试");
        }
    }

    public HisClient.HisExamBookingResult book(HisClient.HisExamBookingCommand command) {
        try {
            return client.bookExam(command);
        } catch (RuntimeException e) {
            if (has(e, "SLOT_TAKEN")) {
                throw new ApiException("EXAM_SLOT_TAKEN", HttpStatus.CONFLICT,
                        "该时段已被预约，请换一个时段");
            }
            if (has(e, "REQUEST_NO_REUSE") || has(e, "IDEMPOTENCY_KEY_REUSE")) {
                throw new ApiException("IDEMPOTENCY_CONFLICT", HttpStatus.CONFLICT,
                        "同一幂等键/申请号不能用于不同检查预约");
            }
            if (has(e, "SLOT_INVALID")) {
                throw new ApiException("EXAM_SLOT_INVALID", HttpStatus.BAD_REQUEST,
                        "所选时段不在可预约排期内");
            }
            if (has(e, "NOT_FOUND")) {
                throw new ApiException("EXAM_ITEM_NOT_FOUND", HttpStatus.NOT_FOUND, "检查项目不存在");
            }
            log.warn("exam book failed requestNo={}: {}", command.requestNo(), e.toString());
            throw unavailable("检查预约系统暂时不可用，本次预约未成立，请稍后重试");
        }
    }

    public HisClient.HisExamBookingResult get(String examOrderNo) {
        try {
            return client.getExam(examOrderNo);
        } catch (RuntimeException e) {
            if (has(e, "NOT_FOUND")) {
                throw new ApiException("EXAM_ORDER_NOT_FOUND", HttpStatus.NOT_FOUND, "检查预约不存在");
            }
            log.warn("exam get failed examOrderNo={}: {}", examOrderNo, e.toString());
            throw unavailable("检查预约系统暂时不可用，请稍后重试");
        }
    }

    public void cancel(String examOrderNo, String reason) {
        try {
            client.cancelExam(examOrderNo, reason);
        } catch (RuntimeException e) {
            log.warn("exam cancel failed examOrderNo={}: {}", examOrderNo, e.toString());
            throw unavailable("检查预约取消失败，请稍后重试");
        }
    }

    private static boolean has(RuntimeException e, String code) {
        return e.getMessage() != null && e.getMessage().contains(code);
    }

    private static ApiException unavailable(String message) {
        return new ApiException("HIS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE, message, true, null);
    }
}
