package com.wechar.biz.patient;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.patient.dto.AttachmentData;
import java.time.Instant;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * 健康档案附件（V9）：
 *  - POST /api/v1/attachments：独立上传（两段式上传的第一段，产出 objectKey 供建档时
 *    以 HealthRecordCreate.attachmentKeys 挂载；也可用于先传后挂的暂存）。
 *    ⚠️ 暂存文件不与任何档案关联，弃用会留孤儿文件（V1 已知限制，运维定期清理
 *    {app.upload.dir}/attachments 下无引用的文件）。
 *  - GET /api/v1/attachments/{objectKey}：匿名读取（AuthInterceptor 白名单）——
 *    <image> 组件直连无法携带 Authorization；URL 必须带 expires+sig（HMAC 短期签名，
 *    TTL 默认 15 分钟），满足契约「短期签名 URL，不展示永久链接」。
 */
@RestController
public class AttachmentController {

    private final AttachmentStorage attachmentStorage;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public AttachmentController(AttachmentStorage attachmentStorage, AuthService authService,
                                CurrentUserContext currentUserContext) {
        this.attachmentStorage = attachmentStorage;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    /** 独立上传（multipart part="file"）：返回 objectKey 与元数据（含短期签名 URL）。 */
    @PostMapping("/api/v1/attachments")
    public ResponseEntity<Envelope<AttachmentData>> upload(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @RequestPart("file") MultipartFile file) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        String objectKey = attachmentStorage.save(file);
        byte[] bytes;
        String sha256;
        try {
            bytes = file.getBytes();
            sha256 = com.wechar.biz.common.Digests.sha256Hex(bytes);
        } catch (java.io.IOException e) {
            throw new ApiException("ATTACHMENT_READ_FAILED", HttpStatus.BAD_REQUEST, "文件读取失败，请重试");
        }
        String mime = file.getContentType() == null ? "application/octet-stream" : file.getContentType();
        // 暂存上传尚无附件行（建档挂载时才插行）→ id 为 null（NON_NULL 不出现在响应里）
        var data = new AttachmentData(null, objectKey, attachmentStorage.signedUrl(objectKey),
                file.getOriginalFilename(), mime, file.getSize(), sha256, Instant.now());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), data));
    }

    /**
     * 匿名读取（签名校验）。判定顺序固定，客户端据 code 区分：
     *  ① 缺 expires 或 sig   → 400 VALIDATION_FAILED
     *  ② expires 已过期       → 410 ATTACHMENT_URL_EXPIRED
     *  ③ sig 与 HMAC 不符     → 403 ATTACHMENT_SIGNATURE_INVALID
     *  ④ objectKey 不存在     → 404 ATTACHMENT_NOT_FOUND
     *  ⑤ 正常                 → 200 FileSystemResource（零拷贝，不整文件入堆）
     *
     * ⚠️ 参数必须 `required=false`：Spring 默认必填，缺参时抛
     * `MissingServletRequestParameterException`，此前被兜底成 500（V14 遗留缺陷）。
     * 这里显式判空给 400；全局 handler 也补了 400 兜底，防其它端点重犯。
     *
     * 响应禁缓存（no-store）：签名 URL 短期有效，缓存无意义且放大泄露面。
     * `Content-Disposition` 显式给出 objectKey：否则 Spring 会兜底成 `filename=f.txt`。
     */
    @GetMapping("/api/v1/attachments/{objectKey}")
    public ResponseEntity<Resource> read(@PathVariable String objectKey,
                                         @RequestParam(required = false) Long expires,
                                         @RequestParam(required = false) String sig) {
        if (expires == null || sig == null || sig.isBlank()) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.BAD_REQUEST,
                    "链接缺少 expires 或 sig 参数");
        }
        if (expires < Instant.now().getEpochSecond()) {
            throw new ApiException("ATTACHMENT_URL_EXPIRED", HttpStatus.GONE,
                    "链接已过期，请重新打开档案获取新链接");
        }
        if (!attachmentStorage.verifySignature(objectKey, expires, sig)) {
            throw new ApiException("ATTACHMENT_SIGNATURE_INVALID", HttpStatus.FORBIDDEN,
                    "链接签名无效");
        }
        var file = attachmentStorage.resolve(objectKey)
                .orElseThrow(() -> new ApiException("ATTACHMENT_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "文件不存在"));
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(file.contentType()))
                .contentLength(file.size())
                .cacheControl(CacheControl.noStore())
                // objectKey 已过白名单正则（仅 0-9a-f 与点），拼进头无注入面
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION,
                        "inline; filename=\"" + objectKey + "\"")
                .body(new org.springframework.core.io.FileSystemResource(file.path()));
    }
}
