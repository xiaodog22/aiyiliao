package com.wechar.biz.auth;

/**
 * 微信 code 换取的会话信息（服务端内部使用；客户端永不接触 openid/session_key 原文）。
 */
public record WechatSessionInfo(String openid, String nickname, String sessionKey) {
}
