package com.wechar.biz.appointment.his;

import com.wechar.biz.common.ApiException;
import java.math.BigDecimal;
import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * HIS 未启用（{@code APP_HIS_ENABLED=false}，且未显式声明 mode）时的占位实现。
 *
 * <p>敌意审查 L6（2026-11-22）：去掉 MockHisClient 的 {@code matchIfMissing=true} 后，
 * 未接 HIS 的环境不再有 HisClient Bean，而 {@code ExamGateway}/{@code PaymentService}
 * 仍依赖该类型。本实现只为满足装配，并保证**任何误调用立即 503**——
 * 绝不返回假成功、绝不默默走 mock。
 *
 * <p>cancel/cancelExam 是补偿动作，按接口约定幂等静默成功（此时不可能有 HIS 单号）。
 */
@Component
@ConditionalOnProperty(name = "app.his.mode", havingValue = "disabled", matchIfMissing = true)
public class DisabledHisClient implements HisClient {

    private static ApiException disabled() {
        return new ApiException("HIS_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
                "医院信息系统未接入（APP_HIS_ENABLED=false），该功能不可用", false, null);
    }

    @Override
    public HisBookingResult book(HisBookingCommand command) {
        throw disabled();
    }

    @Override
    public void cancel(String hisOrderNo, String reason) {
        // 未启用时不存在 HIS 单，补偿动作按幂等成功处理
    }

    @Override
    public HisOrderStatus queryOrder(String hisOrderNo) {
        throw disabled();
    }

    @Override
    public HisBill listCharges(String hisOrderNo) {
        throw disabled();
    }

    @Override
    public HisChargeResult createDemoCharge(HisChargeCommand command) {
        throw disabled();
    }

    @Override
    public HisChargeResult queryDemoCharge(String chargeNo) {
        throw disabled();
    }

    @Override
    public HisChargeResult payDemoCharge(String chargeNo, BigDecimal amount, String idempotencyKey) {
        throw disabled();
    }

    @Override
    public List<HisExamItem> listExamItems() {
        throw disabled();
    }

    @Override
    public List<HisExamSlot> listExamSlots(String itemCode) {
        throw disabled();
    }

    @Override
    public HisExamBookingResult bookExam(HisExamBookingCommand command) {
        throw disabled();
    }

    @Override
    public HisExamBookingResult getExam(String examOrderNo) {
        throw disabled();
    }

    @Override
    public void cancelExam(String examOrderNo, String reason) {
        // 未启用时不存在检查预约，补偿动作按幂等成功处理
    }
}
