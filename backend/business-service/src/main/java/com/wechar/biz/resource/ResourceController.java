package com.wechar.biz.resource;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/v1/resources/{key} —— 按 key 流式返回图片/图标（V14）。
 *
 * 为什么不能用 byte[]：图片/视频动辄数百 KB，整文件读入堆会在并发下迅速放大 GC 压力；
 * 这里返回 `FileSystemResource`，由 ResourceHttpMessageConverter 零拷贝写盘。
 *
 * 鉴权策略：**方案 A（匿名白名单）**，已落地于 `AuthInterceptor.ANONYMOUS`
 * （`/api/v1/resources/*` GET，且 HEAD 视同 GET）。选 A 而不选「HMAC 签名 URL」的理由：
 *  1) 这里的资源是**图标/插画/首页 banner**，本身就要随包分发、无隐私属性，签名不增加保护；
 *  2) `<image>` 元素无法携带 Authorization 头，签名是唯一能"既鉴权又直连"的手段，
 *     但会让**清单也无法缓存**（每次刷新都要换 URL），丢掉 ETag/304 与 7 天 Cache-Control 的收益；
 *  3) 私密文件（检查报告、身份证照片）已经走另一套端点 `GET /api/v1/attachments/{key}?expires=&sig=`，
 *     那里才是必须签名的场景 —— 两套资源语义不同，不强行统一。
 *  代价：资源 key 可被枚举（`home.svc-*` 这类），但既然内容是公开图片，枚举不构成泄露；
 *  真正需要保护的是 `status=0` 与文件系统路径，二者都已按 404 处理。
 *
 * 响应头：
 *  - Content-Type：取库内 mime_type（**不**统一 application/octet-stream，否则微信端不渲染）；
 *  - Content-Length：显式给出，便于客户端显示进度与 `<image>` 预判；
 *  - Cache-Control：图片 7 天 / 视频 1 天 / 其它 1 小时（public，可被穿透/CDN 缓存）；
 *  - ETag：sha256，支持 If-None-Match → 304（真机弱网重复打开不重复下载）。
 *
 * 鉴权：本端点对 `<image>` 公开（`<image>`/`wx.downloadFile` 无法携带 Authorization），
 * 已在 AuthInterceptor 的 ANONYMOUS 中登记为 GET 匿名；只暴露 status=1 的资源，
 * 停用与不存在一律 404，不泄露存在性。
 */
@RestController
@RequestMapping("/api/v1/resources")
public class ResourceController {

    private final ResourceAssetService resourceAssetService;

    public ResourceController(ResourceAssetService resourceAssetService) {
        this.resourceAssetService = resourceAssetService;
    }

    @GetMapping("/{key}")
    public ResponseEntity<Resource> getResource(
            @PathVariable String key,
            @RequestHeader(value = "If-None-Match", required = false) String ifNoneMatch) {
        ResourceAssetService.ResolvedAsset asset = resourceAssetService.resolveActive(key);
        CacheControl cache = cacheFor(asset.mimeType());

        String etag = asset.sha256() == null || asset.sha256().isBlank() ? null : asset.sha256();
        if (etag != null && ("\"" + etag + "\"").equals(ifNoneMatch)) {
            // 304 不带 body：客户端复用本地缓存，省掉整文件传输。
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED)
                    .eTag(etag)
                    .cacheControl(cache)
                    .build();
        }

        ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(asset.mimeType()))
                .contentLength(asset.size())
                // 显式给出真实文件名：否则 Spring 会兜底成 inline;filename=f.txt，
                // 浏览器/下载工具会把图片与 PDF 都存成 f.txt。
                .header(HttpHeaders.CONTENT_DISPOSITION, contentDisposition(asset.fileName()))
                .cacheControl(cache);
        if (etag != null) {
            builder.eTag(etag);
        }
        return builder.body(asset.resource());
    }

    /**
     * 纯 ASCII 文件名用 `inline; filename="x.png"` 的简洁形式；
     * 含非 ASCII（中文名）才走 RFC 5987 编码，避免出现 `filename="=?UTF-8?Q?..."` 这种
     * 对纯英文名也做 MIME 词编码的冗余（部分老客户端解析会困惑）。
     */
    private static String contentDisposition(String fileName) {
        ContentDisposition.Builder builder = ContentDisposition.inline();
        if (StandardCharsets.US_ASCII.newEncoder().canEncode(fileName)) {
            return builder.filename(fileName).build().toString();
        }
        return builder.filename(fileName, StandardCharsets.UTF_8).build().toString();
    }

    /** 缓存时长按资源类型分级：图片最稳定，视频次之，PDF 等文档可能被替换故更短。 */
    private static CacheControl cacheFor(String mime) {
        if (mime.startsWith("image/")) {
            return CacheControl.maxAge(7, TimeUnit.DAYS).cachePublic();
        }
        if (mime.startsWith("video/")) {
            return CacheControl.maxAge(1, TimeUnit.DAYS).cachePublic();
        }
        return CacheControl.maxAge(1, TimeUnit.HOURS).cachePublic();
    }
}
