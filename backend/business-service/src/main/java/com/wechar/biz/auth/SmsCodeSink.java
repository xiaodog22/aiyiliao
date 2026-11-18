package com.wechar.biz.auth;

/**
 * 验证码下发旁路（审计 H1）。
 *
 * <p>背景：dev 档为了联调方便，曾在 {@code DevSmsSender} 里维护一份
 * {@code Map<手机号, 明文验证码>}，只因为集成测试要读验证码。问题是——
 * 这份明文 Map 落在**主代码**里：任何以 {@code app.sms.provider=dev} 起的进程
 * （联调机、演示机、误配档的容器）都持有一份"最近验证码"的内存副本，
 * 与"验证码只应存在于一次性挑战的 HMAC 摘要里"这条红线冲突。</p>
 *
 * <p>现在主代码只保留这个**空实现**钩子：默认 {@link #NOOP} 什么也不做，
 * 生产/dev 运行时不持有任何验证码副本。测试在 test sources 里提供记录实现
 * （{@code com.wechar.biz.support.RecordingSmsCodeSink}）并通过 {@code @Import} 注入，
 * 因此"能读验证码"这件事只存在于测试类路径上。</p>
 */
public interface SmsCodeSink {

    /** 验证码已生成并交给下发通道（实现方不得写日志、不得落盘）。 */
    void onIssued(String phone, String code);

    /** 运行时默认实现：不保存、不留痕。 */
    SmsCodeSink NOOP = (phone, code) -> { };
}
