package com.wechar.biz.common;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * 生产启动自检（审计阻断机制，2026-11-18）。
 *
 * <p>只允许 `prod` profile 装配：把“安全默认”从文档约定变成启动失败。
 * 缺密钥、弱密钥、dev 短信/匿名登录、明文存储目录等任一命中，直接抛
 * IllegalStateException，容器退出，不进入可服务状态（fail-fast，而非降级放行）。</p>
 *
 * <p>这里只读取**非敏感**配置的存在性与长度，不打印密钥值；错误消息给出变量名与
 * 生成命令，便于运维一次修复。</p>
 */
@Component
@Profile("prod")
public class ProductionSecurityCheck {

    private static final Logger log = LoggerFactory.getLogger(ProductionSecurityCheck.class);

    private final String authMode;
    private final String phoneHmacKey;
    private final String phoneHmacKeyPrevious;
    private final String codeHashSecret;
    private final String attachmentSignSecret;
    private final String avatarSignSecret;
    private final String smsProvider;
    private final String uploadDir;

    public ProductionSecurityCheck(
            @Value("${app.auth.mode:strict}") String authMode,
            @Value("${app.auth.phone-hmac-key:}") String phoneHmacKey,
            @Value("${app.auth.phone-hmac-key-previous:}") String phoneHmacKeyPrevious,
            @Value("${app.auth.code-hash-secret:}") String codeHashSecret,
            @Value("${app.attachment.sign-secret:}") String attachmentSignSecret,
            @Value("${app.avatar.sign-secret:}") String avatarSignSecret,
            @Value("${app.sms.provider:prod}") String smsProvider,
            @Value("${app.upload.dir:./run/uploads}") String uploadDir) {
        this.authMode = authMode;
        this.phoneHmacKey = phoneHmacKey;
        this.phoneHmacKeyPrevious = phoneHmacKeyPrevious;
        this.codeHashSecret = codeHashSecret;
        this.attachmentSignSecret = attachmentSignSecret;
        this.avatarSignSecret = avatarSignSecret;
        this.smsProvider = smsProvider;
        this.uploadDir = uploadDir;
    }

    @PostConstruct
    public void validate() {
        var failures = new java.util.ArrayList<String>();
        if (!"strict".equalsIgnoreCase(authMode == null ? "" : authMode.trim())) {
            failures.add("APP_AUTH_MODE 必须为 strict（当前非 strict）");
        }
        requireSecret(failures, "APP_PHONE_HMAC_KEY", phoneHmacKey, 32);
        if (phoneHmacKeyPrevious != null && !phoneHmacKeyPrevious.trim().isEmpty()
                && phoneHmacKeyPrevious.trim().length() < 32) {
            failures.add("APP_PHONE_HMAC_KEY_PREVIOUS 长度 " + phoneHmacKeyPrevious.trim().length()
                    + " < 32（轮换窗口密钥也必须是强随机值）");
        }
        requireSecret(failures, "APP_CODE_HASH_SECRET", codeHashSecret, 32);
        requireSecret(failures, "APP_ATTACHMENT_SIGN_SECRET", attachmentSignSecret, 32);
        requireSecret(failures, "APP_AVATAR_SIGN_SECRET", avatarSignSecret, 32);
        if ("dev".equalsIgnoreCase(smsProvider == null ? "" : smsProvider.trim())) {
            failures.add("APP_SMS_PROVIDER=dev 禁止用于生产（验证码会落开发日志/内存）");
        }
        if (uploadDir != null && (uploadDir.contains("src/main") || uploadDir.contains("target/classes"))) {
            failures.add("APP_UPLOAD_DIR 不得指向源码/构建目录");
        }
        if (!failures.isEmpty()) {
            throw new IllegalStateException("生产安全自检失败，拒绝启动：\n- " + String.join("\n- ", failures));
        }
        log.info("生产安全自检通过：strict 鉴权 / HMAC 手机号与验证码 / 附件与头像短签 / prod 短信");
    }

    private static void requireSecret(java.util.List<String> failures, String name, String value, int minLength) {
        String v = value == null ? "" : value.trim();
        if (v.isEmpty()) {
            failures.add(name + " 未配置（生成：openssl rand -hex 32）");
        } else if (v.length() < minLength) {
            failures.add(name + " 长度 " + v.length() + " < " + minLength + "（生成：openssl rand -hex 32）");
        }
    }
}
