package com.wechar.biz.common;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** 审计 H2 回归：手机号新写入必须 HMAC，旧 SHA-256 仅用于双读并在命中后升级。 */
class PhoneHashingTest {

    private static final String SECRET = "test-phone-hmac-0123456789abcdef";
    private static final String PHONE = "13800138000";

    @Test
    void 新写入是HMAC而不是裸SHA() {
        PhoneHashing hashing = new PhoneHashing(SECRET, "");
        String stored = hashing.hash(PHONE);

        assertThat(stored).isNotEqualTo(Digests.sha256Hex(PHONE));
        assertThat(stored).isEqualTo(Digests.hmacSha256Hex(SECRET, PHONE));
    }

    @Test
    void 旧SHA行可双读且需要升级() {
        PhoneHashing hashing = new PhoneHashing(SECRET, "");
        String legacy = hashing.legacyHash(PHONE);
        String current = hashing.hash(PHONE);

        assertThat(hashing.matches(legacy, PHONE)).isTrue();
        assertThat(hashing.matches(current, PHONE)).isTrue();
        assertThat(hashing.matches(Digests.sha256Hex("13900139000"), PHONE)).isFalse();

        assertThat(hashing.needsUpgrade(legacy, PHONE)).isTrue();
        assertThat(hashing.needsUpgrade(current, PHONE)).isFalse();
    }

    @Test
    void 查找候选同时包含新旧摘要() {
        PhoneHashing hashing = new PhoneHashing(SECRET, "");

        assertThat(hashing.candidateHashes(PHONE))
                .containsExactly(hashing.hash(PHONE), hashing.legacyHash(PHONE));
        assertThat(hashing.candidateHashes(" ")).isEmpty();
        assertThat(hashing.hash(null)).isNull();
    }

    @Test
    void 上一把HMAC密钥在轮换窗口内可双读且提示升级() {
        PhoneHashing hashing = new PhoneHashing(SECRET, "old-phone-hmac-0123456789abcdef");
        String old = hashing.previousHash(PHONE);

        assertThat(old).isNotNull();
        assertThat(hashing.matches(old, PHONE)).isTrue();
        assertThat(hashing.candidateHashes(PHONE)).contains(old);
        assertThat(hashing.needsUpgrade(old, PHONE)).isTrue();
    }

    @Test
    void 无密钥联调档回落SHA且只产生一个候选() {
        PhoneHashing hashing = new PhoneHashing("", "");

        assertThat(hashing.hash(PHONE)).isEqualTo(Digests.sha256Hex(PHONE));
        assertThat(hashing.candidateHashes(PHONE)).containsExactly(Digests.sha256Hex(PHONE));
        assertThat(hashing.needsUpgrade(Digests.sha256Hex(PHONE), PHONE)).isFalse();
    }
}

