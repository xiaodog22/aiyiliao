package com.wechar.biz.appointment.his;

import com.wechar.biz.common.ApiException;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
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

    /**
     * Spring 装配入口：client 用 {@link ObjectProvider} 取，允许 {@code enabled=false} 时为空。
     *
     * <p>敌意审查 L6（2026-11-22）修复：原实现 {@code app.his.mode} 默认 "mock"，
     * 且 MockHisClient {@code matchIfMissing=true} —— 运维只打开 {@code app.his.enabled=true}
     * 却漏配 mode 时，系统会**静默**用模拟适配器受理预约并在页面上标注已接 HIS。
     * 现在：enabled=true 时必须显式声明 mode，且必须有对应实现，否则启动失败（fail-closed）。
     */
    @Autowired
    public HisGateway(ObjectProvider<HisClient> clients,
                      @Value("${app.his.enabled:false}") boolean enabled,
                      @Value("${app.his.mode:}") String mode) {
        this(clients.getIfAvailable(), enabled, mode);
    }

    /** 显式装配/单测入口；client 可为 null，仅在 enabled=false 时合法。 */
    HisGateway(HisClient client, boolean enabled, String mode) {
        this.client = client;
        this.enabled = enabled;
        this.mode = mode == null ? "" : mode.trim().toLowerCase();
        if (enabled) {
            if (this.mode.isEmpty()) {
                throw new IllegalStateException(
                        "app.his.enabled=true 但未显式配置 app.his.mode，拒绝启动（禁止默认 mock 静默放行）");
            }
            // fail-fast：配了不支持的 mode 就直接启动失败，避免「以为接了沙箱、实际走 mock」
            if (!SUPPORTED_MODES.contains(this.mode)) {
                throw new IllegalStateException("app.his.mode 不支持: " + mode + "（支持 mock / http）");
            }
            if (client == null) {
                throw new IllegalStateException(
                        "app.his.mode=" + this.mode + " 但没有对应 HisClient 实现，拒绝启动");
            }
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
     * 尝试撤销并返回结果（L5，2026-11-22）：true=成功或无需撤销；false=调用失败。
     * 调用方（{@link HisCancelRetryJob}）据此决定是否保留 outbox 任务继续重试；
     * 不得把失败当成功（否则「平台已取消、医院仍有单」永久静默）。
     */
    public boolean cancelAttempt(String hisOrderNo, String reason) {
        if (!enabled || hisOrderNo == null || hisOrderNo.isBlank()) {
            return true;
        }
        try {
            client.cancel(hisOrderNo, reason);
            return true;
        } catch (RuntimeException e) {
            log.warn("HIS cancel failed orderNo={}: {}", hisOrderNo, e.toString());
            return false;
        }
    }

    /**
     * 尽力撤销（补偿）。任何异常只记日志，不掩盖主异常：
     * 本地落单失败时调用，失败也只是「HIS 侧多一笔待清理」，不得反过来把请求变成成功。
     */
    public void cancelQuietly(String hisOrderNo, String reason) {
        cancelAttempt(hisOrderNo, reason);
    }
}
