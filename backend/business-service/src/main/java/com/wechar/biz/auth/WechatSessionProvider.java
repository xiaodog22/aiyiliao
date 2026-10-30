package com.wechar.biz.auth;

/**
 * 微信会话适配器（端口-适配器模式）：登录只依赖本接口，不感知具体实现。
 * dev 实现（{@link DevWechatSessionProvider}）返回稳定假数据；
 * 生产实现（{@link ProdWechatSessionProvider}）调 api.weixin.qq.com（M1 保留 TODO 骨架）。
 */
public interface WechatSessionProvider {

    /** 用 wx.login 的临时 code 换取会话信息。code 失效/非法时抛业务异常（422/503 由调用层决定）。 */
    WechatSessionInfo getSessionByCode(String code);

    /**
     * 用微信 getPhoneNumber 的动态令牌换取手机号明文（仅服务端内部使用，落库前先加密）。
     * 微信侧要求服务端持 AppSecret 调 getPhoneNumber 解密 data.phoneInfo。
     * 返回 null 表示令牌无效/未授权（由调用层转 422）。
     */
    String getPhoneNumberByCode(String phoneCode);
}
