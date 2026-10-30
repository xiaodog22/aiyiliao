package com.wechar.biz.deletion;

import java.time.Clock;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 账号注销 30 天物理清除定时任务（N10 收尾，2026-10-23；V12 承诺的"后续清理任务"）。
 *
 * 规则：每日扫描 users 表 status='DELETION_PENDING' 且 deletion_effective_at &lt;= NOW() 的账号，
 * 按 deletion_effective_at 升序逐账号物理清除（每账号独立事务，见 DeletionPurgeService.purgeOne）。
 *
 * 调度口径：
 *  - cron `0 30 3 * * *` = 每日 03:30 **UTC**（= 北京时间 11:30），避开业务高峰与备份窗口；
 *  - 单轮限量 50 个账号（防极端数据一次执行过长；本轮未清完的剩余账号由次日轮次续清）；
 *  - 单个账号失败不阻断整轮（记录日志，该账号次轮重试），符合"清理失败可重入、不留半删"。
 *
 * 日志脱敏：只记内部 userId（UUID，无手机号/openid/姓名等可识别信息）。
 */
@Component
public class DeletionPurgeTask {

    private static final Logger log = LoggerFactory.getLogger(DeletionPurgeTask.class);

    /** 单轮处理上限：避免异常数据量一次执行过长拖垮调度线程。 */
    private static final int MAX_PER_RUN = 50;

    private final DeletionPurgeService service;
    private final Clock clock;

    public DeletionPurgeTask(DeletionPurgeService service, Clock clock) {
        this.service = service;
        this.clock = clock;
    }

    @Scheduled(cron = "0 30 3 * * *")
    public void purgeExpiredDeletions() {
        List<String> due;
        try {
            due = service.findDueUserIds(MAX_PER_RUN);
        } catch (RuntimeException e) {
            // 查询失败（如数据库瞬断）不扩散：下轮重试
            log.error("注销到期账号扫描失败 err={}", e.getClass().getSimpleName());
            return;
        }
        if (due.isEmpty()) {
            return;
        }
        log.info("注销冷静期到期账号清理开始 | 到期={}", due.size());
        int ok = 0;
        int fail = 0;
        for (String userId : due) {
            try {
                if (service.purgeOne(userId)) {
                    ok++;
                    log.info("注销到期账号已物理清除 user={}", userId);
                } else {
                    // anonymize 返回 0 = 已非 DELETION_PENDING（并发下被处理/状态异常）→ 计为已清除
                    ok++;
                }
            } catch (RuntimeException e) {
                fail++;
                log.error("注销到期账号物理清除失败 user={} err={}", userId, e.getClass().getSimpleName());
            }
        }
        log.info("注销冷静期到期账号清理结束 | 成功={} 失败={} 下一轮={}", ok, fail, clock.instant());
    }
}
