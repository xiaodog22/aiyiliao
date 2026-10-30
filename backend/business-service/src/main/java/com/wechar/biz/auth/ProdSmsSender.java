package com.wechar.biz.auth;

import com.wechar.biz.common.ApiException;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 生产档短信网关占位（app.sms.provider=prod）：真实网关尚未接入。
 * 如实返回 503 SMS_UNAVAILABLE（retryable=false），**绝不伪造发送成功**——
 * 伪造会直接破坏 N8 登录链（challengeId 已下发但用户永远收不到验证码）。
 * 接入真实网关（短信服务商 SDK / HTTP API）时以同名实现替换本类。
 */
@Component
@ConditionalOnProperty(name = "app.sms.provider", havingValue = "prod")
public class ProdSmsSender implements SmsSender {

    @Override
    public void send(String phone, String code, String scene) {
        throw new ApiException("SMS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                "短信网关尚未接入，验证码暂无法下发", false, null);
    }
}
