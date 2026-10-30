package com.wechar.biz.resource;

import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.resource.dto.ResourceManifestData;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/v1/resources/manifest（契约 operationId getResourceManifest）。
 * query：platform（const=wechat-miniprogram，非该值 → 422 VALIDATION_FAILED）、clientVersion（≤20）。
 */
@RestController
@RequestMapping("/api/v1/resources")
public class ResourceManifestController {

    private final ResourceManifestService resourceManifestService;

    public ResourceManifestController(ResourceManifestService resourceManifestService) {
        this.resourceManifestService = resourceManifestService;
    }

    @GetMapping("/manifest")
    public ResponseEntity<Envelope<ResourceManifestData>> manifest(
            @RequestParam(required = false) String platform,
            @RequestParam(required = false) String clientVersion) {
        if (platform != null && !platform.isBlank() && !"wechat-miniprogram".equals(platform)) {
            throw new com.wechar.biz.common.ApiException("VALIDATION_FAILED",
                    org.springframework.http.HttpStatus.UNPROCESSABLE_ENTITY,
                    "platform 仅接受 wechat-miniprogram");
        }
        if (clientVersion != null && clientVersion.length() > 20) {
            throw new com.wechar.biz.common.ApiException("VALIDATION_FAILED",
                    org.springframework.http.HttpStatus.UNPROCESSABLE_ENTITY,
                    "clientVersion 长度不得超过 20");
        }
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                resourceManifestService.manifest(platform, clientVersion)));
    }
}
