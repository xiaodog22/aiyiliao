package com.wechar.biz.auth;

import com.wechar.biz.common.AuthSessionStore;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * auth_sessions 过期会话物理清除（PERF-06，2026-11-01）。
 *
 * 背景：全仓原本唯一一处 {@code DELETE FROM auth_sessions} 在 DeletionPurgeRepository（只随账号注销触发），
 * 没有任何按过期时间的清理。结果表只增不删 —— 2026-11-01 压测后实测全表 369 行中 286 行已彻底过期
 * （refresh_expires_at 早于当前时刻），且这些僵尸行会让"登录次数""会话数"类观测口径永久偏移。
 *
 * 调度口径（与 DeletionPurgeTask 错峰，避免两个清理任务撞在同一分钟）：
 *  - cron {@code 0 40 3 * * *} = 每日 03:40 **UTC**（北京时间 11:40）；
 *  - 只删 refresh 已过期的行（判据见 AuthSessionStore.deleteRefreshExpiredBefore 注释）；
 *  - cutoff 额外保留 {@value #GRACE_HOURS} 小时余量，防多实例时钟漂移误删刚过期但仍在重试窗口的行；
 *  - 单批 {@value #BATCH_SIZE} 行、单轮最多 {@value #MAX_BATCHES} 批：
 *    常规量一轮删完，异常积压则次日续删，不让一次 DELETE 拖成长事务。
 *
 * 失败不扩散：查询/删除抛 RuntimeException（如数据库瞬断）只记异常类名，本轮放弃、次日重试。
 * 日志脱敏：只记行数与耗时，不含 userId / token 哈希。
 */
@Component
public class AuthSessionCleanupTask {

    private static final Logger log = LoggerFactory.getLogger(AuthSessionCleanupTask.class);

    /** 过期判据再往前推的小时数（时钟漂移容错窗口）。 */
    private static final int GRACE_HOURS = 24;
    /** 单批删除行数：兼顾清理速度与单事务时长。 */
    private static final int BATCH_SIZE = 2000;
    /** 单轮最多批数：2000 × 10 = 20000 行/日上限。 */
    private static final int MAX_BATCHES = 10;

    private final AuthSessionStore store;
    private final Clock clock;

    public AuthSessionCleanupTask(AuthSessionStore store, Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    @Scheduled(cron = "0 40 3 * * *")
    public void purgeExpiredSessions() {
        Instant cutoff = clock.instant().minus(Duration.ofHours(GRACE_HOURS));
        long startedAt = System.nanoTime();
        int total = 0;
        try {
            for (int batch = 0; batch < MAX_BATCHES; batch++) {
                int deleted = store.deleteRefreshExpiredBefore(cutoff, BATCH_SIZE);
                total += deleted;
                if (deleted < BATCH_SIZE) {
                    break; // 本批未满 = 已删净
                }
            }
        } catch (RuntimeException e) {
            // 不抛给调度线程：本轮放弃，次日重试；已删批次不回滚（幂等，重复删同条件无副作用）
            log.error("过期会话清理失败 deleted={} err={}", total, e.getClass().getSimpleName());
            return;
        }
        if (total > 0) {
            long ms = (System.nanoTime() - startedAt) / 1_000_000L;
            log.info("过期会话清理完成 deleted={} cutoff={} costMs={}", total, cutoff, ms);
        }
    }
}
