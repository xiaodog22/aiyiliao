package com.wechar.biz.consent;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.GlobalExceptionHandler;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 隐私政策版本（审计 M11）。
 *
 * <p>登录请求里的 consentVersion 必须是**服务端当前发布的版本**，不能由客户端写死。
 * 版本不一致 → 409 CONSENT_VERSION_MISMATCH，前端强制回到独立同意页重新阅读并确认。
 * 版本值由运营通过 APP_CONSENT_VERSION 发布；服务端同时用 users.login_consent_version
 * 记录“登录当时用户确认的版本”，发生争议时可回溯。</p>
 */
@Component
public class ConsentPolicy {

    private final String currentVersion;
    private final String effectiveAt;
    private final String title;

    public ConsentPolicy(
            @Value("${app.consent.current-version:v1.0}") String currentVersion,
            @Value("${app.consent.effective-at:2026-11-18}") String effectiveAt,
            @Value("${app.consent.title:隐私政策}") String title) {
        this.currentVersion = currentVersion == null ? "" : currentVersion.trim();
        this.effectiveAt = effectiveAt == null ? "" : effectiveAt.trim();
        this.title = title == null ? "" : title.trim();
        if (this.currentVersion.isEmpty()) {
            throw new IllegalStateException("app.consent.current-version 不能为空（M11 fail-fast）");
        }
    }

    /** 公开端点返回的最新政策元数据；不返回政策全文（全文在客户端静态页，避免接口被篡改）。 */
    public Map<String, Object> latest() {
        return Map.of(
                "version", currentVersion,
                "effectiveAt", effectiveAt,
                "title", title,
                "purposes", List.of("PRIVACY_POLICY", "HEALTH_DATA_PROCESSING", "FAMILY_PROXY"));
    }

    /** 登录版本校验：空白/旧版本一律 409，不进入 openid 换码与用户建档。 */
    public void requireCurrent(String clientVersion) {
        String offered = clientVersion == null ? "" : clientVersion.trim();
        if (offered.isEmpty() || !offered.equals(currentVersion)) {
            throw new ApiException("CONSENT_VERSION_MISMATCH", HttpStatus.CONFLICT,
                    "隐私政策已更新，请重新阅读并同意后再登录", false,
                    List.of(new GlobalExceptionHandler.ErrorDetail(
                            "consentVersion", "当前有效版本 " + currentVersion,
                            "CONSENT_VERSION_MISMATCH")));
        }
    }

    public String currentVersion() {
        return currentVersion;
    }
}
