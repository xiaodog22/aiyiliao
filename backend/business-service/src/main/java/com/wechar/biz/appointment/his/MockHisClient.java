package com.wechar.biz.appointment.his;

import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * HIS 模拟适配器（REQ-14②，V1.20 默认实现）。
 *
 * <p>只生成可追溯的模拟业务单号，不发起任何网络调用、不依赖任何真实凭据。
 * 单号固定以 {@code HIS-MOCK-} 开头，便于日志/审计与真实单号区分——
 * 任何人看到单号就能判断这是演示受理，不构成「已接 HIS」的误导。
 */
@Component
@ConditionalOnProperty(name = "app.his.mode", havingValue = "mock", matchIfMissing = true)
public class MockHisClient implements HisClient {

    private static final Logger log = LoggerFactory.getLogger(MockHisClient.class);

    /** 进程内自增；仅用于生成可读的模拟单号，不参与任何业务唯一性判定。 */
    private final AtomicLong sequence = new AtomicLong();

    @Override
    public HisBookingResult book(HisBookingCommand command) {
        String orderNo = "HIS-MOCK-" + String.format("%06d", sequence.incrementAndGet());
        // 只记录 ID 级信息，不写患者姓名等敏感字段（医疗日志脱敏口径）
        log.info("HIS mock book appointment={} slot={} orderNo={}",
                command.appointmentId(), command.slotId(), orderNo);
        return new HisBookingResult(orderNo, "HIS_MOCK", true);
    }

    @Override
    public void cancel(String hisOrderNo, String reason) {
        // 模拟侧无外部副作用：只留补偿调用痕迹，供测试断言「失败路径确实做过补偿」
        log.info("HIS mock cancel orderNo={} reason={}", hisOrderNo, reason);
    }
}
