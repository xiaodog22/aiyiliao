package com.wechar.biz.appointment.his;

import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * HIS 撤销补偿重试（L5，2026-11-22）。
 *
 * <p>取消链路在本地事务内先写 outbox 再尝试撤销；本任务负责把失败任务重试到成功。
 * 退避 1→2→4→8→16 分钟；第 5 次仍失败置 DEAD（保留记录等人工，绝不静默丢弃）。
 * HIS 未启用时无事可做（本地取消无需撤销）。
 */
@Component
public class HisCancelRetryJob {

    static final int MAX_ATTEMPTS = 5;
    private static final Logger log = LoggerFactory.getLogger(HisCancelRetryJob.class);

    private final HisGateway hisGateway;
    private final HisCancelTaskRepository tasks;

    public HisCancelRetryJob(HisGateway hisGateway, HisCancelTaskRepository tasks) {
        this.hisGateway = hisGateway;
        this.tasks = tasks;
    }

    @Scheduled(fixedDelayString = "${app.his.cancel-retry-interval-ms:60000}",
            initialDelayString = "${app.his.cancel-retry-initial-delay-ms:30000}")
    public void run() {
        if (!hisGateway.enabled()) {
            return;
        }
        try {
            for (HisCancelTaskRepository.Task task : tasks.listDue(Instant.now())) {
                retry(task);
            }
        } catch (RuntimeException e) {
            // 调度不能被单轮异常终止；下一轮继续
            log.warn("HIS 取消补偿任务异常：{}", e.getMessage());
        }
    }

    /** 单条重试：成功 DONE，失败按指数退避；达到上限转 DEAD。 */
    void retry(HisCancelTaskRepository.Task task) {
        boolean ok = hisGateway.cancelAttempt(task.hisOrderNo(), task.reason());
        if (ok) {
            tasks.markDone(task.appointmentId());
            log.info("HIS 取消补偿完成 appointment={} hisOrderNo={} attempts={}",
                    task.appointmentId(), task.hisOrderNo(), task.attempts() + 1);
            return;
        }
        int attempts = task.attempts() + 1;
        boolean dead = attempts >= MAX_ATTEMPTS;
        Instant next = Instant.now().plusSeconds(backoffSeconds(attempts));
        tasks.markFailure(task.appointmentId(), "cancel failed", dead, next);
        if (dead) {
            log.error("HIS 取消补偿失败达上限，转 DEAD 待人工 appointment={} hisOrderNo={} attempts={}",
                    task.appointmentId(), task.hisOrderNo(), attempts);
        } else {
            log.warn("HIS 取消补偿失败，{} 秒后重试 appointment={} attempts={}",
                    backoffSeconds(attempts), task.appointmentId(), attempts);
        }
    }

    static long backoffSeconds(int attempts) {
        return Math.min(3600L, 60L << Math.min(Math.max(attempts - 1, 0), 5));
    }
}
