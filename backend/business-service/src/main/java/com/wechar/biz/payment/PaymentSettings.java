package com.wechar.biz.payment;

import com.wechar.biz.common.ApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 演示支付配置与启动闸门（P0-1，D1）。
 *
 * <p>红线：
 * <ul>
 *   <li>唯一启用档为 {@code DEMO}；{@code LIVE} / 任何其它值启动即失败——
 *       当前无企业主体/商户号，不允许把演示支付伪装成真实支付。</li>
 *   <li>{@code enabled=true} 时演示密钥必填，否则签名无法校验，宁可启动失败。</li>
 *   <li>{@code enabled=false} 是总回退：页面只显示「请到院窗口缴费」，不创建订单。</li>
 * </ul>
 */
@Component
public class PaymentSettings {

    public static final String MODE_DEMO = "DEMO";
    public static final String SOURCE_DEMO = "DEMO";
    public static final String SOURCE_SANDBOX = "SANDBOX";

    private final boolean enabled;
    private final String mode;
    private final String source;
    private final String demoSecret;
    private final long callbackTtlSeconds;

    public PaymentSettings(
            @Value("${app.payment.enabled:false}") boolean enabled,
            @Value("${app.payment.mode:DEMO}") String mode,
            @Value("${app.payment.source:DEMO}") String source,
            @Value("${app.payment.demo-secret:}") String demoSecret,
            @Value("${app.payment.callback-ttl-seconds:300}") long callbackTtlSeconds) {
        this.mode = mode == null ? "" : mode.trim().toUpperCase();
        if (!MODE_DEMO.equals(this.mode)) {
            throw new IllegalStateException(
                    "app.payment.mode 仅支持 DEMO（当前无企业主体/商户号，禁止接入真实或沙箱支付）: " + mode);
        }
        this.source = source == null ? "" : source.trim().toUpperCase();
        if (!SOURCE_DEMO.equals(this.source) && !SOURCE_SANDBOX.equals(this.source)) {
            throw new IllegalStateException("app.payment.source 仅支持 DEMO / SANDBOX: " + source);
        }
        this.enabled = enabled;
        this.demoSecret = demoSecret == null ? "" : demoSecret.trim();
        if (enabled && this.demoSecret.length() < 16) {
            throw new IllegalStateException(
                    "app.payment.enabled=true 必须配置 app.payment.demo-secret（至少 16 字符）");
        }
        this.callbackTtlSeconds = Math.max(30L, Math.min(callbackTtlSeconds, 900L));
    }

    public boolean enabled() { return enabled; }
    public String mode() { return mode; }
    public String source() { return source; }
    public String demoSecret() { return demoSecret; }
    public long callbackTtlSeconds() { return callbackTtlSeconds; }

    /** 未开启支付演示时统一 503，页面据此显示「请到院窗口缴费」。 */
    public void requireEnabled() {
        if (!enabled) {
            throw new ApiException("PAYMENT_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
                    "演示支付未开启，请到院窗口缴费");
        }
    }
}
