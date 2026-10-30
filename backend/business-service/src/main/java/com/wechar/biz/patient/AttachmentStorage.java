package com.wechar.biz.patient;

import com.wechar.biz.common.ApiException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;

/**
 * 健康档案附件存取（本地磁盘，V1 无对象存储；复刻 AvatarStorage 模式）：
 *  - 写：POST /api/v1/health-records/{recordId}/attachments（multipart "file"），
 *    存 {app.upload.dir}/attachments/<32位hex>.<ext>；
 *  - 读：GET /api/v1/attachments/{objectKey}?expires=&sig=（匿名，供 image 组件直连）。
 * 文件名恒由服务端生成（随机 hex + 扩展名白名单），客户端输入不参与路径 → 无路径穿越面。
 *
 * 短期签名 URL（契约 HealthRecord.attachments.url「短期签名 URL，不展示永久链接」）：
 *  sig = HMAC-SHA256(secret, objectKey + "|" + expires)，TTL 默认 15 分钟；
 *  密钥走 app.attachment.sign-secret 注入。
 *
 *  ⚠️ 密钥策略（红线，2026-10-23 收口）：**未配置 `app.attachment.sign-secret` 即启动失败（fail-fast）**，
 *     不再静默使用进程内随机值——随机密钥会让多实例 A 签 B 验必然 403、重启后全部旧 URL 立刻失效，
 *     属"生产可用性自伤"型缺陷。生产必须由 `APP_ATTACHMENT_SIGN_SECRET` 注入同一个强随机值
 *     （openssl rand -hex 32，且多实例一致；dev 已在 deploy/env.local 配置固定开发密钥）。
 */
@Component
public class AttachmentStorage {

    /**
     * 图片/PDF 默认上限 10MB（检验报告扫描件常见 3~8MB）。
     *
     * ⚠️ **仅作兼容保留**：实际判定走 {@link #maxBytesFor(String)}（按扩展名分支，视频用
     * `app.attachment.video-max-bytes`）。改限额请改配置项，不要改这个常量，
     * 更不要为了支持视频把它一刀切提到 50MB —— 那会把图片/PDF 的上限一起放开。
     */
    public static final long MAX_BYTES = 10 * 1024 * 1024;
    public static final Set<String> ALLOWED_EXT = Set.of("jpg", "jpeg", "png", "webp", "pdf", "mp4");
    /** 对象键白名单：32 位小写 hex + 扩展名。mp4 必须在这里，否则读取阶段会直接 403（不是 404）。 */
    private static final Pattern SAFE_KEY = Pattern.compile("^[0-9a-f]{32}\\.(jpg|jpeg|png|webp|pdf|mp4)$");
    private static final long DEFAULT_TTL_SECONDS = 15 * 60;
    /** 视频默认 TTL 2 小时：要覆盖「打开详情 → 停留 → 完整播放 → 拖动」的最长场景。 */
    private static final long DEFAULT_VIDEO_TTL_SECONDS = 2 * 60 * 60;

    private final Path attachmentsDir;
    private final byte[] signSecret;
    private final long ttlSeconds;
    private final long maxBytes;
    private final long videoMaxBytes;
    private final long videoTtlSeconds;

    public AttachmentStorage(@Value("${app.upload.dir:./run/uploads}") String uploadDir,
                             @Value("${app.attachment.sign-secret:}") String signSecret,
                             @Value("${app.attachment.url-ttl-seconds:900}") long ttlSeconds,
                             @Value("${app.attachment.max-bytes:10485760}") long maxBytes,
                             @Value("${app.attachment.video-max-bytes:52428800}") long videoMaxBytes,
                             @Value("${app.attachment.video-ttl-seconds:7200}") long videoTtlSeconds) {
        this.attachmentsDir = Paths.get(uploadDir, "attachments").toAbsolutePath().normalize();
        this.ttlSeconds = ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS;
        this.maxBytes = maxBytes > 0 ? maxBytes : MAX_BYTES;
        this.videoMaxBytes = videoMaxBytes > 0 ? videoMaxBytes : 50L * 1024 * 1024;
        this.videoTtlSeconds = videoTtlSeconds > 0 ? videoTtlSeconds : DEFAULT_VIDEO_TTL_SECONDS;
        if (signSecret == null || signSecret.isBlank()) {
            // 红线（fail-fast）：生产未配置 APP_ATTACHMENT_SIGN_SECRET 一律拒绝启动。
            // 进程内随机密钥会导致多实例/重启后签名互不认可（全员 403），
            // 属可预见的配置缺陷，不允许静默兜底掩盖（2026-10-23 安全收口）。
            throw new IllegalStateException(
                    "app.attachment.sign-secret 未配置：生产必须通过 APP_ATTACHMENT_SIGN_SECRET "
                            + "注入固定强随机密钥（openssl rand -hex 32，多实例一致），拒绝以随机密钥启动。");
        }
        this.signSecret = signSecret.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    /** 按扩展名取上限：mp4 用 videoMaxBytes，其余（图片/PDF）用 maxBytes。 */
    private long maxBytesFor(String ext) {
        return "mp4".equals(ext) ? videoMaxBytes : maxBytes;
    }

    /** 保存附件，返回 objectKey（32 位 hex + 扩展名）。 */
    public String save(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new ApiException("ATTACHMENT_EMPTY", HttpStatus.BAD_REQUEST, "请选择要上传的文件");
        }
        // 顺序很重要：先定扩展名 → 再按类型取限额。若先判大小，视频 50MB 会被 10MB 常量直接挡掉。
        String ext = extOf(file.getOriginalFilename());
        if (!ALLOWED_EXT.contains(ext)) {
            throw new ApiException("ATTACHMENT_FORMAT", HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                    "仅支持 jpg/png/webp/pdf/mp4 格式");
        }
        long limit = maxBytesFor(ext);
        if (file.getSize() > limit) {
            throw new ApiException("ATTACHMENT_TOO_LARGE", HttpStatus.PAYLOAD_TOO_LARGE,
                    "文件不能超过 " + (limit / (1024 * 1024)) + "MB");
        }
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException e) {
            throw new ApiException("ATTACHMENT_READ_FAILED", HttpStatus.BAD_REQUEST, "文件读取失败，请重试");
        }
        String objectKey = newObjectKey(ext);
        try {
            Files.createDirectories(attachmentsDir);
            Files.write(attachmentsDir.resolve(objectKey), bytes);
            return objectKey;
        } catch (IOException e) {
            throw new ApiException("ATTACHMENT_SAVE_FAILED", HttpStatus.INTERNAL_SERVER_ERROR,
                    "文件保存失败，请稍后重试");
        }
    }

    /** 物理删除附件文件；objectKey 不匹配白名单或缺文件一律静默（不泄露文件系统信息）。 */
    public void delete(String objectKey) {
        if (objectKey == null || !SAFE_KEY.matcher(objectKey).matches()) {
            return;
        }
        Path target = attachmentsDir.resolve(objectKey).normalize();
        if (!target.startsWith(attachmentsDir)) {
            return;
        }
        try {
            Files.deleteIfExists(target);
        } catch (IOException e) {
            // 删除失败不阻断业务（行已删，孤儿文件由运维清理）；仅记类名不记路径
            org.slf4j.LoggerFactory.getLogger(AttachmentStorage.class)
                    .warn("attachment file delete failed: {}", e.getClass().getSimpleName());
        }
    }

    /**
     * 按 objectKey 安全解析出磁盘路径与元数据，**不读取文件内容**。
     *
     * 为什么不再提供 `read()` 返回 byte[]：10MB 扫描件 × 并发会把堆打满，
     * 且返回给客户端时还要再复制一次。控制层用 `FileSystemResource` 零拷贝输出，
     * 建档挂载用 {@link com.wechar.biz.common.Digests#sha256Hex(Path)} 流式摘要。
     * 文件名不匹配白名单或缺文件一律 empty（不泄露文件系统信息）。
     */
    public Optional<ResolvedFile> resolve(String objectKey) {
        if (objectKey == null || !SAFE_KEY.matcher(objectKey).matches()) {
            return Optional.empty();
        }
        Path target = attachmentsDir.resolve(objectKey).normalize();
        if (!target.startsWith(attachmentsDir) || !Files.isRegularFile(target)) {
            return Optional.empty();
        }
        try {
            return Optional.of(new ResolvedFile(contentTypeOf(objectKey), target, Files.size(target)));
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    /** objectKey 是否指向一个已落盘的有效文件（建档时校验 attachmentKeys 用）。 */
    public boolean exists(String objectKey) {
        if (objectKey == null || !SAFE_KEY.matcher(objectKey).matches()) {
            return false;
        }
        Path target = attachmentsDir.resolve(objectKey).normalize();
        return target.startsWith(attachmentsDir) && Files.isRegularFile(target);
    }

    /** 生成短期签名 URL（相对路径，客户端拼网关前缀）：/api/v1/attachments/{key}?expires=&sig= */
    public String signedUrl(String objectKey) {
        return signedUrl(objectKey, ttlSeconds);
    }

    /**
     * 指定 TTL 的签名 URL。图片/PDF 走默认 15 分钟；**视频必须用 {@link #signedVideoUrl}**
     * （默认 7200 秒），否则用户停留超过 15 分钟后拖动进度条会 403、播放中断。
     */
    public String signedUrl(String objectKey, long ttl) {
        long effective = ttl > 0 ? ttl : ttlSeconds;
        long expires = Instant.now().getEpochSecond() + effective;
        return "/api/v1/attachments/" + objectKey + "?expires=" + expires + "&sig=" + sign(objectKey, expires);
    }

    /** 视频专用签名 URL：TTL = app.attachment.video-ttl-seconds（默认 7200s）。 */
    public String signedVideoUrl(String objectKey) {
        return signedUrl(objectKey, videoTtlSeconds);
    }

    /** 校验签名与时效；true = 可读取。 */
    public boolean verifySignature(String objectKey, long expires, String sig) {
        if (objectKey == null || sig == null || !SAFE_KEY.matcher(objectKey).matches()) {
            return false;
        }
        if (expires < Instant.now().getEpochSecond()) {
            return false;
        }
        String expected = sign(objectKey, expires);
        // 恒定时间比较，防时序侧信道
        return constantTimeEquals(expected, sig);
    }

    private static boolean constantTimeEquals(String a, String b) {
        return java.security.MessageDigest.isEqual(
                a.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                b.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private String sign(String objectKey, long expires) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(signSecret, "HmacSHA256"));
            byte[] raw = mac.doFinal((objectKey + "|" + expires)
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(raw);
        } catch (Exception e) {
            throw new ApiException("ATTACHMENT_SIGN_FAILED", HttpStatus.INTERNAL_SERVER_ERROR,
                    "签名生成失败，请稍后重试");
        }
    }

    private static String contentTypeOf(String objectKey) {
        String ext = objectKey.substring(objectKey.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        return switch (ext) {
            case "png" -> "image/png";
            case "jpg", "jpeg" -> "image/jpeg";
            case "webp" -> "image/webp";
            case "pdf" -> "application/pdf";
            // 视频必须是 video/mp4：落成 octet-stream 或（更糟）image/jpeg 时，<video> 会拒绝播放
            // 且没有明显错误可查，很容易被误判成前端接线问题。
            case "mp4" -> "video/mp4";
            // 未知扩展名不应被标成图片：SAFE_KEY 已白名单，这里理论上不会命中，
            // 但语义上必须诚实（历史上 default 是 image/jpeg，新增格式会被静默标错）。
            default -> "application/octet-stream";
        };
    }

    private static String extOf(String original) {
        if (original == null) {
            return "";
        }
        int dot = original.lastIndexOf('.');
        return dot < 0 ? "" : original.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    /** 服务端生成 objectKey：32 位随机 hex + 白名单扩展名（HexFormat 保证仅 0-9a-f）。 */
    private static String newObjectKey(String ext) {
        byte[] raw = new byte[16];
        new SecureRandom().nextBytes(raw);
        return HexFormat.of().formatHex(raw) + "." + ext;
    }

    /** 已校验的附件文件（路径 + mime + 大小），供零拷贝输出与流式摘要使用。 */
    public record ResolvedFile(String contentType, Path path, long size) {
    }
}
