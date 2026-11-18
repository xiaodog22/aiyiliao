package com.wechar.biz.support;

import com.wechar.biz.auth.SmsCodeSink;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 测试专用验证码记录器（审计 H1）。
 *
 * <p>只存在于 {@code src/test/java}，不会打进产物 jar。集成测试通过
 * {@code @Import(RecordingSmsCodeSink.class)} 显式注入，替代原先主代码里的
 * {@code DevSmsSender#lastCode}。这样做的好处：**运行时无处可读验证码**，
 * 而测试仍然能拿到 6 位码完成登录链路验证。</p>
 */
public class RecordingSmsCodeSink implements SmsCodeSink {

    private final Map<String, String> codes = new ConcurrentHashMap<>();

    @Override
    public void onIssued(String phone, String code) {
        if (phone != null && code != null) {
            codes.put(phone, code);
        }
    }

    /** 该手机号最近一次下发的验证码；未下发返回 null。 */
    public String lastCode(String phone) {
        return codes.get(phone);
    }
}
