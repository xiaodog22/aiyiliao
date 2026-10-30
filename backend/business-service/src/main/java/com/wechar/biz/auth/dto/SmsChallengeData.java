package com.wechar.biz.auth.dto;

/**
 * 契约 SmsChallenge（N9）响应 data：challengeId 一次性，ttlSec 为验证码有效期（秒）。
 * 不回显验证码原文（红线：验证码只在短信正文出现一次）。
 */
public record SmsChallengeData(String challengeId, int ttlSec) {
}
