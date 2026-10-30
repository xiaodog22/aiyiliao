package com.wechar.biz.resource;

import com.wechar.biz.common.ApiException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * 资源解析与路径安全（V14）。
 *
 * 安全模型（纵深防御，任一层失效都不至于越界读文件）：
 *  1) key 只做**数据库查询**，绝不参与路径拼接 —— 路径 100% 来自库内 file_path；
 *  2) key 形状白名单（无 `..`、无绝对路径、长度上限）→ 非法即 400；
 *  3) file_path 必须相对根目录，`resolve().normalize()` 后仍须 `startsWith(root)` → 穿越即 404；
 *  4) mime 白名单（图片/视频/PDF），库内登记了其它类型按不存在处理；
 *  5) 文件不存在/不可读 → 404，不把文件系统路径回显给客户端。
 *
 * 返回 `FileSystemResource`：Spring MVC 走 ResourceHttpMessageConverter 的零拷贝输出，
 * 不把文件读成 byte[]（禁止整文件入堆）。
 */
@Service
public class ResourceAssetService {

    /**
     * key 形状：字母数字开头，允许 `.` `_` `-`，封顶 128。
     * ⚠️ **不含 `/`**：AuthInterceptor 的匿名白名单是单段通配 `/api/v1/resources/*`，
     * 多段 key 会匹配失败并被打成 401；分级语义用点号（`icons.home`）。
     */
    private static final Pattern KEY_PATTERN = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");

    /** 可下发类型白名单（与库内 mime_type 精确匹配，大小写不敏感）。 */
    private static final Set<String> ALLOWED_MIME = Set.of(
            "image/png", "image/jpeg", "image/webp", "image/gif",
            "video/mp4", "application/pdf");

    private final ResourceAssetRepository repository;
    private final Path root;

    public ResourceAssetService(ResourceAssetRepository repository,
                                @Value("${app.resources.dir:../deploy/resources}") String dir) {
        this.repository = repository;
        this.root = Paths.get(dir).toAbsolutePath().normalize();
        // 启动期校验：目录不存在/不是目录 → 直接启动失败。
        // 为什么不在请求时才发现：文件根配错时资源会**全部 404**，而清单仍能正常下发
        // （url 照拼），现象是"清单有、图全裂"，极难定位。宁可启动就崩，把配置错误暴露在部署阶段。
        if (!Files.isDirectory(root)) {
            throw new IllegalStateException(
                    "资源目录不存在或不是目录：" + root + "（检查 app.resources.dir / APP_RESOURCES_DIR）");
        }
    }

    /** 资源根目录（绝对、已归一化）：启动日志与诊断用，不对外下发。 */
    public Path root() {
        return root;
    }

    /**
     * 已校验的可用资源。
     * fileName 单独带出：Spring 的 ResourceHttpMessageConverter 在未显式设置
     * Content-Disposition 时会兜底写成 `inline;filename=f.txt`（框架默认值），
     * 下载 PDF/图片时文件名会错成 f.txt —— 必须由控制层显式给出真实名。
     */
    public record ResolvedAsset(Resource resource, String mimeType, long size, String sha256, String fileName) {
    }

    /** 取启用资源并完成全部校验；任何不满足项都抛契约信封异常。 */
    public ResolvedAsset resolveActive(String key) {
        requireValidKey(key);
        ResourceAssetRepository.AssetRow row = repository.findActiveByKey(key)
                .orElseThrow(ResourceAssetService::notFound);
        String mime = row.mimeType() == null ? "" : row.mimeType().trim().toLowerCase(Locale.ROOT);
        if (!ALLOWED_MIME.contains(mime)) {
            throw notFound();
        }
        Path path = resolveSafe(row.filePath());
        if (!Files.isRegularFile(path)) {
            throw notFound();
        }
        long size;
        try {
            size = Files.size(path);
        } catch (IOException e) {
            throw notFound();
        }
        return new ResolvedAsset(new FileSystemResource(path), mime, size, row.sha256(),
                path.getFileName() == null ? key : path.getFileName().toString());
    }

    /** key 形状校验：非法 → 400（与"库里没有"的 404 区分，便于客户端定位）。 */
    public void requireValidKey(String key) {
        if (key == null || key.isBlank() || key.contains("..") || !KEY_PATTERN.matcher(key).matches()) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.BAD_REQUEST, "资源 key 非法");
        }
    }

    /** 路径穿越防护：非绝对路径 + normalize 后必须仍在根目录内。 */
    public Path resolveSafe(String filePath) {
        if (filePath == null || filePath.isBlank()) {
            throw notFound();
        }
        Path raw = Paths.get(filePath);
        if (raw.isAbsolute()) {
            throw notFound();
        }
        Path candidate = root.resolve(raw).normalize();
        if (!candidate.startsWith(root)) {
            throw notFound();
        }
        return candidate;
    }

    private static ApiException notFound() {
        return new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND, "资源不存在");
    }
}
