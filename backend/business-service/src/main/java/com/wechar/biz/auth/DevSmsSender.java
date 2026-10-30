package com.wechar.biz.auth;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * dev 档短信网关（app.sms.provider=dev，缺省即此档）：
 * 不真正发短信，只打印**脱敏**日志（手机号 138****1234，验证码与完整号码不入日志）。
 * 为集成测试保留 {@link #lastCode(String)} 读取入口——仅 dev 档存在该能力，
 * 生产档由 {@link ProdSmsSender}（或后续真实网关实现）提供，不存在任何"取验证码"旁路。
 */
@Component
@ConditionalOnProperty(name = "app.sms.provider", havingValue = "dev", matchIfMissing = true)
public class DevSmsSender implements SmsSender {

    private static final Logger log = LoggerFactory.getLogger(DevSmsSender.class);

    /** 供 dev/itest 联调与集成测试读取的最近一次验证码（键 = 明文手机号，仅进程内存）。 */
    private final Map<String, String> lastCodes = new ConcurrentHashMap<>();

    @Override
    public void send(String phone, String code, String scene) {
        lastCodes.put(phone, code);
        // 只记脱敏号码与场景；验证码原文不入日志（红线：敏感信息不进日志正文）
        log.info("[dev-sms] scene={} phone={} 已生成验证码（dev 档不真实下发）", scene, mask(phone));
    }

    /** dev/itest 专用：取该手机号最近一次下发的验证码（生产档无此类入口）。 */
    public String lastCode(String phone) {
        return lastCodes.get(phone);
    }

    static String mask(String phone) {
        if (phone == null || phone.length() != 11) {
            return "***";
        }
        return phone.substring(0, 3) + "****" + phone.substring(7);
    }
}
