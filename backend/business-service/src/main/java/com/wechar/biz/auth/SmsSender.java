package com.wechar.biz.auth;

/**
 * 短信网关提供者接口（N9）：服务端选型，前端不感知。
 * 实现由 app.sms.provider 选择：
 *  - dev（默认）：{@link DevSmsSender}，落库校验为主、只打印脱敏日志，供本地/集成测试；
 *  - prod：{@link ProdSmsSender} 占位，接入真实网关前如实 503（不伪造发送成功）。
 */
public interface SmsSender {

    /**
     * 下发验证码短信。
     *
     * @param phone 明文手机号（仅在本进程内传递，不落日志、不进响应）
     * @param code  6 位验证码（明文只在网关请求里出现一次，服务端库存哈希）
     * @param scene 使用场景（当前仅 DOCTOR_LOGIN）
     */
    void send(String phone, String code, String scene);
}
