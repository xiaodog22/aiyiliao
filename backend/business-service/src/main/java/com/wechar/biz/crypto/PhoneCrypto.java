package com.wechar.biz.crypto;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 手机号 AES-GCM 加解密（docs/v4/03 §5 / §11：手机号密文落库，密钥与数据库分离）。
 * 密钥来自环境变量 PHONE_KEY_BASE64（Base64，32 字节）；生产必须覆盖 dev 占位值。
 * 密钥缺失或长度非法时启动即失败——不降级、不掩盖（§10 红线）。
 * 密文格式：Base64( 12 字节 IV || GCM 密文+Tag )。
 */
@Component
public class PhoneCrypto {

    private static final int KEY_BYTES = 32;
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private final SecretKey key;
    private final SecureRandom random = new SecureRandom();

    public PhoneCrypto(@Value("${phone.key-base64:}") String keyBase64) {
        if (keyBase64 == null || keyBase64.isBlank()) {
            throw new IllegalStateException(
                    "phone.key-base64 未配置：生产必须设置环境变量 PHONE_KEY_BASE64（Base64 编码的 32 字节密钥）");
        }
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(keyBase64.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("PHONE_KEY_BASE64 不是合法 Base64", e);
        }
        if (raw.length != KEY_BYTES) {
            throw new IllegalStateException("PHONE_KEY_BASE64 解码后须为 32 字节，实际 " + raw.length + " 字节");
        }
        this.key = new SecretKeySpec(raw, "AES");
    }

    /** 加密手机号，返回 Base64 密文（响应中的 phoneCipher 用它，不回显原文）。 */
    public String encrypt(String phone) {
        try {
            byte[] iv = new byte[IV_BYTES];
            random.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            byte[] ct = cipher.doFinal(phone.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return Base64.getEncoder().encodeToString(out);
        } catch (Exception e) {
            throw new IllegalStateException("手机号加密失败", e);
        }
    }

    /** 解密（仅服务端内部比对/回显后四位等场景使用，响应永不回显原文）。 */
    public String decrypt(String cipherBase64) {
        try {
            byte[] in = Base64.getDecoder().decode(cipherBase64);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, in, 0, IV_BYTES));
            byte[] pt = cipher.doFinal(in, IV_BYTES, in.length - IV_BYTES);
            return new String(pt, StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException("手机号解密失败（密钥不匹配或密文损坏）", e);
        }
    }

    /** 校验手机号基本格式（大陆 11 位）。不合法返回 false，由调用方转 422。 */
    public static boolean isValidPhone(String phone) {
        return phone != null && phone.matches("^1\\d{10}$");
    }
}
