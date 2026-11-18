package com.wechar.biz.user;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;

/**
 * 审计 M5 回归：匿名头像读取必须短签，裸文件名/过期/篡改一律拒绝。
 *
 * <p>不启动 Spring 上下文，直接验证 {@link AvatarStorage} 的签名边界；端点层
 * 仅把 {@code verify=false} 映射为 403，不改变本类的不变式。</p>
 */
class AvatarSignatureTest {

    private static final String SECRET = "test-avatar-secret-0123456789abcdef";
    private static final Instant NOW = Instant.parse("2026-11-18T12:00:00Z");
    /** 1x1 透明 PNG（仅用于内容嗅探，不含任何用户数据）。 */
    private static final byte[] PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");

    @TempDir
    Path tmp;

    private AvatarStorage storageAt(Instant instant) {
        return new AvatarStorage(tmp.toString(), SECRET, Clock.fixed(instant, ZoneOffset.UTC));
    }

    @Test
    void 裸文件名不可读_签名后可读() throws Exception {
        AvatarStorage storage = storageAt(NOW);
        String saved = storage.save(new MockMultipartFile("file", "avatar.png", "image/png", PNG));
        String name = saved.substring("/api/v1/avatars/".length());

        assertThat(storage.read(name, null, null)).isEmpty();

        String signed = storage.signedPath(saved);
        String query = java.net.URI.create(signed).getQuery();
        String expires = query.replaceAll(".*expires=([0-9]+).*", "$1");
        String sig = query.replaceAll(".*sig=([0-9a-f]+).*", "$1");

        Optional<AvatarStorage.LoadedAvatar> loaded = storage.read(name, expires, sig);
        assertThat(loaded).isPresent();
        assertThat(loaded.get().contentType()).isEqualTo("image/png");
        assertThat(loaded.get().bytes()).isEqualTo(PNG);
    }

    @Test
    void 过期签名拒绝() throws Exception {
        AvatarStorage issuer = storageAt(NOW);
        String saved = issuer.save(new MockMultipartFile("file", "avatar.png", "image/png", PNG));
        String name = saved.substring("/api/v1/avatars/".length());
        String signed = issuer.signedPath(saved);
        String query = java.net.URI.create(signed).getQuery();
        String expires = query.replaceAll(".*expires=([0-9]+).*", "$1");
        String sig = query.replaceAll(".*sig=([0-9a-f]+).*", "$1");

        // TTL 900s：把校验时钟推到 1000s 后，同一签名必须失效
        AvatarStorage verifier = storageAt(NOW.plusSeconds(1000));
        assertThat(verifier.read(name, expires, sig)).isEmpty();
    }

    @Test
    void 篡改签名或文件名拒绝() throws Exception {
        AvatarStorage storage = storageAt(NOW);
        String saved = storage.save(new MockMultipartFile("file", "avatar.png", "image/png", PNG));
        String name = saved.substring("/api/v1/avatars/".length());
        String signed = storage.signedPath(saved);
        String query = java.net.URI.create(signed).getQuery();
        String expires = query.replaceAll(".*expires=([0-9]+).*", "$1");
        String sig = query.replaceAll(".*sig=([0-9a-f]+).*", "$1");

        String tampered = (sig.charAt(0) == '0' ? "1" : "0") + sig.substring(1);
        assertThat(storage.read(name, expires, tampered)).isEmpty();
        assertThat(storage.read("../../etc/passwd", expires, sig)).isEmpty();
        assertThat(storage.read(name, "9999999999", sig)).isEmpty();
    }

    @Test
    void 上传响应生成签名URL_且只对头像路径签名() {
        AvatarStorage storage = storageAt(NOW);
        String signed = storage.signedPath("/api/v1/avatars/0123456789abcdef0123456789abcdef.png");
        assertThat(signed).contains("expires=").contains("&sig=");
        assertThat(storage.signedPath("https://example.com/a.png")).isEqualTo("https://example.com/a.png");
        assertThat(storage.signedPath("/api/v1/attachments/secret.pdf"))
                .isEqualTo("/api/v1/attachments/secret.pdf");
    }
}
