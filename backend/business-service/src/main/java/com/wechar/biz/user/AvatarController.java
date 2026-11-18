package com.wechar.biz.user;

import com.wechar.biz.common.ApiException;
import java.util.concurrent.TimeUnit;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 头像读取端点（V8，审计 M5 收紧）：GET /api/v1/avatars/{name}?expires=&sig=。
 * AuthInterceptor 仍匿名放行（&lt;image&gt; 组件直连无法携带 Authorization），
 * 但端点本身校验 HMAC 短期签名：裸文件名/过期/篡改签名一律 403，不再公开可枚举。
 */
@RestController
public class AvatarController {

    private final AvatarStorage avatarStorage;

    public AvatarController(AvatarStorage avatarStorage) {
        this.avatarStorage = avatarStorage;
    }

    @GetMapping("/api/v1/avatars/{name}")
    public ResponseEntity<byte[]> avatar(@PathVariable("name") String name,
                                         @RequestParam(value = "expires", required = false) String expires,
                                         @RequestParam(value = "sig", required = false) String sig) {
        if (!avatarStorage.verify(name, expires, sig)) {
            throw new ApiException("AVATAR_SIGNATURE_INVALID", HttpStatus.FORBIDDEN, "头像链接无效或已过期");
        }
        var loaded = avatarStorage.read(name, expires, sig)
                .orElseThrow(() -> new ApiException("AVATAR_NOT_FOUND", HttpStatus.NOT_FOUND, "头像不存在"));
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(loaded.contentType()))
                .cacheControl(CacheControl.maxAge(15, TimeUnit.MINUTES).cachePrivate())
                .body(loaded.bytes());
    }
}
