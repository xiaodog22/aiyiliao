package com.wechar.biz.user;

import com.wechar.biz.common.ApiException;
import java.util.concurrent.TimeUnit;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * 头像公开读取端点（V8）：GET /api/v1/avatars/{name}。
 * 匿名可访问（AuthInterceptor 白名单）：<image> 组件直连无法携带 Authorization。
 * 文件名由服务端生成（32 位 hex + 白名单扩展名），AvatarStorage 白名单兜底路径安全。
 */
@RestController
public class AvatarController {

    private final AvatarStorage avatarStorage;

    public AvatarController(AvatarStorage avatarStorage) {
        this.avatarStorage = avatarStorage;
    }

    @GetMapping("/api/v1/avatars/{name}")
    public ResponseEntity<byte[]> avatar(@PathVariable("name") String name) {
        var loaded = avatarStorage.read(name)
                .orElseThrow(() -> new ApiException("AVATAR_NOT_FOUND", HttpStatus.NOT_FOUND, "头像不存在"));
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(loaded.contentType()))
                .cacheControl(CacheControl.maxAge(7, TimeUnit.DAYS).cachePublic())
                .body(loaded.bytes());
    }
}
