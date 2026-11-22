package com.wechar.biz.payment;

import java.time.Duration;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 演示支付对账（P0-1 步骤 6；L5 2026-11-22 扩展）：近 24h PAID + REFUNDED，
 * 以及所有仍为 OPEN 的待同步订单（含超出时间窗口的退费）逐一比对。
 *
 * <p>只告警不自动改账：对账不是状态机，不允许把 HIS 的失败反过来覆盖本地已入账记录；
 * 发现不一致由人工按 orderNo/chargeNo 核查。支付未开启时任务空转。
 */
@Component
public class PaymentReconciliationJob {

    private static final Logger log = LoggerFactory.getLogger(PaymentReconciliationJob.class);
    private static final Duration WINDOW = Duration.ofHours(24);

    private final PaymentService paymentService;

    public PaymentReconciliationJob(PaymentService paymentService) {
        this.paymentService = paymentService;
    }

    @Scheduled(fixedDelayString = "${app.payment.reconcile-interval-ms:300000}",
            initialDelayString = "${app.payment.reconcile-initial-delay-ms:60000}")
    public void run() {
        try {
            int mismatches = paymentService.reconcile(Instant.now().minus(WINDOW));
            if (mismatches > 0) {
                log.warn("演示支付对账完成，不一致 {} 笔（仅告警，不自动改账）", mismatches);
            }
        } catch (RuntimeException e) {
            // 定时任务异常不能终止调度；只记录，下一轮继续
            log.warn("演示支付对账任务异常：{}", e.getMessage());
        }
    }
}
