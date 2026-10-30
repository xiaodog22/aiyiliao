package com.wechar.biz.common;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * 摘要工具：幂等载荷摘要（SHA-256）与手机号哈希（SHA-256，只存哈希用于比对，不存原文）。
 */
public final class Digests {

    private Digests() {
    }

    /** SHA-256 十六进制摘要（小写）。 */
    public static String sha256Hex(String text) {
        return sha256Hex(text.getBytes(StandardCharsets.UTF_8));
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
