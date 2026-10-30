package com.wechar.biz.user;

import com.wechar.biz.common.ApiException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;

/**
 * 头像文件存取（本地磁盘，V1 无 CDN）：
 *  - 写：POST /api/v1/me/avatar（multipart "file"），存 {app.upload.dir}/avatars/<32位hex>.<ext>；
 *  - 读：GET /api/v1/avatars/{name}（匿名，供 image 组件直连，无法带 Authorization）。
 * 文件名恒由服务端生成（随机 hex + 扩展名白名单），客户端输入不参与路径 → 无路径穿越面。
 */
@Component
public class AvatarStorage {

    private static final long MAX_BYTES = 2 * 1024 * 1024; // 2MB：头像足够，避免主包/带宽滥用
    private static final Set<String> ALLOWED_EXT = Set.of("jpg", "jpeg", "png", "webp");
    private static final Pattern SAFE_NAME = Pattern.compile("^[0-9a-f]{32}\\.(jpg|jpeg|png|webp)$");

    private final Path avatarsDir;

    public AvatarStorage(@Value("${app.upload.dir:./run/uploads}") String uploadDir) {
        this.avatarsDir = Paths.get(uploadDir, "avatars").toAbsolutePath().normalize();
    }

    /** 保存头像，返回对外相对路径（/api/v1/avatars/<name>；客户端拼网关前缀）。 */
    public String save(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new ApiException("AVATAR_EMPTY", HttpStatus.BAD_REQUEST, "请选择头像图片");
        }
        if (file.getSize() > MAX_BYTES) {
            throw new ApiException("AVATAR_TOO_LARGE", HttpStatus.PAYLOAD_TOO_LARGE, "头像图片不能超过 2MB");
        }
        String ext = extOf(file.getOriginalFilename());
        if (!ALLOWED_EXT.contains(ext)) {
            throw new ApiException("AVATAR_FORMAT", HttpStatus.UNSUPPORTED_MEDIA_TYPE, "仅支持 jpg/png/webp 图片");
        }
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException e) {
            throw new ApiException("AVATAR_READ_FAILED", HttpStatus.BAD_REQUEST, "头像读取失败，请重试");
        }
        String name = newName(ext);
        try {
            Files.createDirectories(avatarsDir);
            Path target = avatarsDir.resolve(name);
            Files.write(target, bytes);
            return "/api/v1/avatars/" + name;
        } catch (IOException e) {
            throw new ApiException("AVATAR_SAVE_FAILED", HttpStatus.INTERNAL_SERVER_ERROR, "头像保存失败，请稍后重试");
        }
    }

    /** 按名读取头像；文件名不匹配白名单或缺文件一律 empty（不泄露文件系统信息）。 */
    public Optional<LoadedAvatar> read(String name) {
        if (name == null || !SAFE_NAME.matcher(name).matches()) {
            return Optional.empty();
        }
        Path target = avatarsDir.resolve(name).normalize();
        if (!target.startsWith(avatarsDir) || !Files.isRegularFile(target)) {
            return Optional.empty();
        }
        try {
            byte[] bytes = Files.readAllBytes(target);
            String contentType = switch (name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT)) {
                case "png" -> "image/png";
                case "webp" -> "image/webp";
                default -> "image/jpeg";
            };
            return Optional.of(new LoadedAvatar(contentType, bytes));
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    public record LoadedAvatar(String contentType, byte[] bytes) {
    }

    private static String extOf(String original) {
        if (original == null) {
            return "";
        }
        int dot = original.lastIndexOf('.');
        return dot < 0 ? "" : original.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    /** 服务端生成文件名：32 位随机 hex + 白名单扩展名（HexFormat 保证仅 0-9a-f）。 */
    private static String newName(String ext) {
        byte[] raw = new byte[16];
        new java.security.SecureRandom().nextBytes(raw);
        return HexFormat.of().formatHex(raw) + "." + ext;
    }
}
