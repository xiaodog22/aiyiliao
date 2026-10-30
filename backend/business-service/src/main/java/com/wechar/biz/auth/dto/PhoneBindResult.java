package com.wechar.biz.auth.dto;

/**
 * 手机绑定响应：phoneCipher 为非空占位串（AES-GCM 密文 Base64，不回显原文）、
 * phoneLast4 为真实后四位、phoneBound=true。
 */
public record PhoneBindResult(String phoneCipher, String phoneLast4, Boolean phoneBound) {
}
