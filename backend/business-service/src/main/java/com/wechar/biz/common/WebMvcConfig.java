package com.wechar.biz.common;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * M4 拦截器注册（鉴权收口 + 审计）。
 * 拦截范围仅 /api/v1/**：
 *  - /api/gw/* 属网关，业务后端本无 handler（保持 501 语义，不被拦截器抢先 401）；
 *  - /internal/* 服务间接口由网关网络边界保护（O-02 前保持 501），不走客户端鉴权；
 *  - /actuator/health 就绪探针保持无鉴权（部署探活需要）。
 * 注册顺序（关键）：**audit 先于 auth**——Spring 仅对 preHandle 成功的拦截器回调
 * afterCompletion；audit 在前才能在 auth 抛 401（鉴权拒绝）时记录 DENIED 安全证据，
 * 且此时响应状态已由统一错误处理写定，audit 记到的是最终状态码。
 * 表内匿名路径由 AuthInterceptor 自身按契约 401 矩阵裁决。
 */
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final AuthInterceptor authInterceptor;
    private final AuditInterceptor auditInterceptor;
    private final RateLimitInterceptor rateLimitInterceptor;

    public WebMvcConfig(AuthInterceptor authInterceptor, AuditInterceptor auditInterceptor,
                        RateLimitInterceptor rateLimitInterceptor) {
        this.authInterceptor = authInterceptor;
        this.auditInterceptor = auditInterceptor;
        this.rateLimitInterceptor = rateLimitInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // 顺序（关键）：audit(0) 先于 auth(1) 才能记 DENIED；ratelimit(2) 在 auth 之后，
        // 以便 submit 类限流以认证主体为键（登录类用 IP，不受此序影响）。
        registry.addInterceptor(auditInterceptor).addPathPatterns("/api/v1/**").order(0);
        registry.addInterceptor(authInterceptor).addPathPatterns("/api/v1/**").order(1);
        registry.addInterceptor(rateLimitInterceptor).addPathPatterns("/api/v1/**").order(2);
    }
}
