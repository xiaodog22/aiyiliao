package com.wechar.biz.crypto;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Base64;
import org.junit.jupiter.api.Test;

/** PhoneCrypto 关键规则：加解密回环、密文不泄露原文、密钥校验（不降级）。 */
class PhoneCryptoTest {

    private static final String DEV_KEY = Base64.getEncoder()
            .encodeToString("0123456789abcdef0123456789abcdef".getBytes());

    @Test
    void 加解密回环_原文一致且密文不含原文() {
        PhoneCrypto crypto = new PhoneCrypto(DEV_KEY);
        String phone = "13800001111";
        String cipher = crypto.encrypt(phone);
        assertNotEquals(phone, cipher);
        assertFalse(cipher.contains(phone));
        assertEquals(phone, crypto.decrypt(cipher));
    }

    @Test
    void 每次加密随机IV_同原文密文不同() {
        PhoneCrypto crypto = new PhoneCrypto(DEV_KEY);
        assertNotEquals(crypto.encrypt("13800001111"), crypto.encrypt("13800001111"));
    }

    @Test
    void 密钥缺失或长度非法_启动即失败不降级() {
        assertThrows(IllegalStateException.class, () -> new PhoneCrypto(""));
        assertThrows(IllegalStateException.class, () -> new PhoneCrypto("not-base64!!"));
        assertThrows(IllegalStateException.class,
                () -> new PhoneCrypto(Base64.getEncoder().encodeToString("short".getBytes())));
    }

    @Test
    void 手机号格式校验() {
        assertTrue(PhoneCrypto.isValidPhone("13800001111"));
        assertFalse(PhoneCrypto.isValidPhone("23800001111"));
        assertFalse(PhoneCrypto.isValidPhone("1380000111"));
        assertFalse(PhoneCrypto.isValidPhone(null));
    }
}
