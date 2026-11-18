package com.wechar.biz.common;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * 摘要工具：幂等载荷摘要（SHA-256）与手机号哈希（SHA-256，只存哈希用于比对，不存原文）。
 *
 * <p>2026-11-18（审计 H2/L2）补两项：
 * <ul>
 *   <li>{@link #hmacSha256Hex}：带密钥摘要。6 位验证码只有 10^6 种取值，无盐 SHA-256 可毫秒级穷举；
 *       HMAC 让攻击者在拿到库之后仍需密钥，才谈得上"不可离线反查"。</li>
 *   <li>{@link #constantTimeEquals}：恒定时间比较，统一本仓库"比哈希"的写法（原先散落 String.equals）。</li>
 * </ul></p>
 */
public final class Digests {

    private Digests() {
    }

    /** SHA-256 十六进制摘要（小写）。 */
    public static String sha256Hex(String text) {
        return sha256Hex(text.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * HMAC-SHA256 十六进制摘要（小写）。
     *
     * <p>密钥为空时**抛异常**而不是静默回落无盐摘要：调用方若在无密钥情况下继续，
     * 等于把"低熵口令哈希"这个缺陷留在了生产路径上（fail-closed）。</p>
     */
    public static String hmacSha256Hex(String secret, String text) {
        if (secret == null || secret.isEmpty()) {
            throw new IllegalStateException("HMAC 密钥为空（拒绝以无密钥方式计算低熵摘要）");
        }
        try {
            var mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec(
                    secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(text.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 不可用", e);
        }
    }

    /** 恒定时间字符串比较（审计 L2）：长度不同直接 false，内容比较用 MessageDigest.isEqual。 */
    public static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    /** SHA-256 十六进制摘要（小写，二进制内容）。 */
    public static String sha256Hex(byte[] data) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(data));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    /**
     * SHA-256 十六进制摘要（小写，**流式读文件**，8KB 缓冲）。
     *
     * 为什么不是 `sha256Hex(Files.readAllBytes(path))`：附件上限 10MB，并发建档时
     * 整份读入会把堆打满；流式摘要只占一个缓冲区，与文件大小无关。
     */
    public static String sha256Hex(java.nio.file.Path file) {
        try (var in = java.nio.file.Files.newInputStream(file);
             var digestIn = new java.security.DigestInputStream(in, MessageDigest.getInstance("SHA-256"))) {
            byte[] buf = new byte[8192];
            while (digestIn.read(buf) > 0) {
                // 读取即更新摘要，无需保留内容
            }
            return HexFormat.of().formatHex(digestIn.getMessageDigest().digest());
        } catch (java.io.IOException | NoSuchAlgorithmException e) {
            throw new IllegalStateException("附件摘要计算失败", e);
        }
    }
}
