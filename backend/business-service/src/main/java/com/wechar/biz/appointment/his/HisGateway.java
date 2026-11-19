package com.wechar.biz.appointment.his;

import com.wechar.biz.common.ApiException;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * HIS 接入门面（REQ-14③⑤）。
 *
 * <p>三条硬边界：
 * <ol>
 *   <li><b>开关默认关闭</b>：{@code app.his.enabled} 缺省 false，此时完全不触达外部系统，
 *       按 LOCAL_DEMO 落库，页面标「演示预约」。</li>
 *   <li><b>失败不得显示成功</b>：HIS 抛任何异常都转成 503 HIS_UNAVAILABLE，
 *       由 {@code AppointmentService.create} 的事务整体回滚（含号源扣减），前端只会看到失败提示。</li>
 *   <li><b>不猜测成功</b>：超时/连接拒绝一律按失败处理，不做「可能已受理」的乐观假设。</li>
 * </ol>
 */
@Component
public class HisGateway {

    private static final Logger log = LoggerFactory.getLogger(HisGateway.class);

    /**
     * 允许 mock（默认，无外部调用）与 http（仅指向本地社区诊所演示系统 clinic-his）；
     * sandbox/live 需先过 PRODUCTION_GATE 与真实凭据评审。
     */
    private static final Set<String> SUPPORTED_MODES = Set.of("mock", "http");

    private final HisClient client;
    private final boolean enabled;
    private final String mode;

    public HisGateway(HisClient client,
                      @Value("${app.his.enabled:false}") boolean enabled,
                      @Value("${app.his.mode:mock}") String mode) {
        this.client = client;
        this.enabled = enabled;
        this.mode = mode == null ? "mock" : mode.trim().toLowerCase();
        // fail-fast：配了不支持的 mode 就直接启动失败，避免「以为接了沙箱、实际走 mock」
        if (enabled && !SUPPORTED_MODES.contains(this.mode)) {
            throw new IllegalStateException("app.his.mode 不支持: " + mode + "（支持 mock / http）");
        }
    }

    /** 是否启用了外部 HIS 受理（供只读接口/健康检查暴露当前模式，不含凭据）。 */
    public boolean enabled() {
        return enabled;
    }

    public String mode() {
        return enabled ? mode : "disabled";
    }

    /**
     * 申请受理。开关关闭 → LOCAL_DEMO（无外部调用）；开启且失败 → 503（调用方不得落单）。
     */
    public HisClient.HisBookingResult book(HisClient.HisBookingCommand command) {
        if (!enabled) {
            return HisClient.HisBookingResult.localDemo();
        }
        try {
            HisClient.HisBookingResult result = client.book(command);
            if (result == null || result.hisOrderNo() == null || result.hisOrderNo().isBlank()) {
                // 回执缺单号 = 受理不可确认，按失败处理（不得显示预约成功）
                throw new IllegalStateException("HIS 回执缺少业务单号");
            }
            return result;
        } catch (RuntimeException e) {
            log.warn("HIS book failed appointment={}: {}", command.appointmentId(), e.toString());
            throw new ApiException("HIS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "医院号源系统暂时不可用，本次预约未成立，请稍后重试", true, null);
        }
    }

    /**
     * 尽力撤销（补偿）。任何异常只记日志，不掩盖主异常：
     * 本地落单失败时调用，失败也只是「HIS 侧多一笔待清理」，不得反过来把请求变成成功。
     */
    public void cancelQuietly(String hisOrderNo, String reason) {
        if (!enabled || hisOrderNo == null || hisOrderNo.isBlank()) {
            return;
        }
        try {
            client.cancel(hisOrderNo, reason);
        } catch (RuntimeException e) {
            log.warn("HIS cancel compensation failed orderNo={}: {}", hisOrderNo, e.toString());
        }
    }
}
