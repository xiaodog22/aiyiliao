package com.wechar.biz.auth;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * dev 档短信网关（**必须显式** app.sms.provider=dev 才装配）：
 * 不真正发短信，只打印**脱敏**日志（手机号 138****1234，验证码与完整号码不入日志）。
 *
 * <p>审计 H1：本类**不再保存任何验证码副本**。原实现用一个
 * {@code Map<手机号, 明文验证码>} 支撑集成测试的 {@code lastCode()}，
 * 等于在 dev/联调进程里常驻"最近验证码"明文，与"验证码只以 HMAC 摘要存在"冲突。
 * 现在验证码只经 {@link SmsCodeSink} 单向传出：默认 {@link SmsCodeSink#NOOP}，
 * 只有测试类路径注入的记录实现才会留存（见 {@code com.wechar.biz.support.RecordingSmsCodeSink}）。
 * 生产档由 {@link ProdSmsSender}（或后续真实网关实现）提供，不存在任何"取验证码"旁路。</p>
 */
@Component
// 2026-11-18（审计 H1）：去掉 matchIfMissing —— 缺省不再装配 dev 发送器。
// 漏配 APP_SMS_PROVIDER 时由 ProdSmsSender 如实 503（不再"假装已下发"）。
@ConditionalOnProperty(name = "app.sms.provider", havingValue = "dev")
public class DevSmsSender implements SmsSender {

    private static final Logger log = LoggerFactory.getLogger(DevSmsSender.class);

    /** 默认空实现：运行时不留存任何验证码；测试通过 @Import 提供记录实现。 */
    private final SmsCodeSink sink;

    public DevSmsSender(ObjectProvider<SmsCodeSink> sinkProvider) {
        this.sink = sinkProvider.getIfAvailable(() -> SmsCodeSink.NOOP);
    }

    @Override
    public void send(String phone, String code, String scene) {
        // 只交给注入的旁路（运行时为空实现），本类不再持有副本
        sink.onIssued(phone, code);
        // 只记脱敏号码与场景；验证码原文不入日志（红线：敏感信息不进日志正文）
        log.info("[dev-sms] scene={} phone={} 已生成验证码（dev 档不真实下发）", scene, mask(phone));
    }

    static String mask(String phone) {
        if (phone == null || phone.length() != 11) {
            return "***";
        }
        return phone.substring(0, 3) + "****" + phone.substring(7);
    }
}
