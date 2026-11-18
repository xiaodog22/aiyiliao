package com.wechar.biz.ai;

import jakarta.annotation.PostConstruct;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * AI 服务（FastAPI，ai-openapi.yaml）内网编排配置（M2）。
 * 地址与令牌只来自环境变量，不得出现在对外响应、日志或公开文档（契约：内网地址不外泄）。
 *
 * <p>2026-11-18（审计 C3）：{@code token} 默认空值会让全部 /internal/v1/tasks 调用**不带任何凭证**，
 * 信任模型退化为"网络边界即安全"。现改为启动自检：token 为空或过短且 {@code require-token=true}
 * 时直接抛异常退出（与附件签名密钥、手机号密钥同一条红线），不再静默以零凭证上游。
 * itest/prodtest 档在 profile 配置里显式关闭该自检（单测不连真实 ai-service）。</p>
 */
@Configuration
@ConfigurationProperties(prefix = "ai.client")
public class AiClientConfig {

    /** 服务令牌最小长度（与 ai-service security.py 的 _MIN_TOKEN_LENGTH 对齐）。 */
    private static final int MIN_TOKEN_LENGTH = 32;

    /** 内网基地址，默认 http://127.0.0.1:8001（契约 servers 占位端口）。 */
    private String baseUrl = "http://127.0.0.1:8001";

    /** 服务间令牌（AI_SERVICE_TOKEN）；为空 = 未配置（启动即失败，除非显式关闭自检）。 */
    private String token = "";

    /** 是否强制要求服务间令牌（生产/联调档 true；H2 单测档在 profile 配置里置 false）。 */
    private boolean requireToken = true;

    /** 策略版本（安全规则/提示模板/知识快照集合标识；上游缓存键组成部分）。 */
    private String policyVersion = "POLICY-v1";

    /** 租户边界（缓存与检索按它隔离）。 */
    private String tenantId = "wechar-dev";

    @PostConstruct
    void validate() {
        if (!requireToken) {
            return;
        }
        if (token == null || token.isBlank()) {
            throw new IllegalStateException(
                    "未配置 AI_SERVICE_TOKEN：业务服务拒绝以零凭证调用 ai-service（审计 C3）。"
                            + "请注入 openssl rand -hex 32 生成的强随机值，两侧保持一致。");
        }
        if (token.trim().length() < MIN_TOKEN_LENGTH) {
            throw new IllegalStateException(
                    "AI_SERVICE_TOKEN 过短（" + token.trim().length() + " 字符），必须 ≥ " + MIN_TOKEN_LENGTH
                            + " 字符；弱令牌可被离线枚举，拒绝启动。");
        }
    }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }
    public String getToken() { return token; }
    public void setToken(String token) { this.token = token; }
    public boolean isRequireToken() { return requireToken; }
    public void setRequireToken(boolean requireToken) { this.requireToken = requireToken; }
    public String getPolicyVersion() { return policyVersion; }
    public void setPolicyVersion(String policyVersion) { this.policyVersion = policyVersion; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
}
