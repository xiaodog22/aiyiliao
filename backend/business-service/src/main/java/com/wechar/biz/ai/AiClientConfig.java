package com.wechar.biz.ai;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * AI 服务（FastAPI，ai-openapi.yaml）内网编排配置（M2）。
 * 地址与令牌只来自环境变量，不得出现在对外响应、日志或公开文档（契约：内网地址不外泄）。
 */
@Configuration
@ConfigurationProperties(prefix = "ai.client")
public class AiClientConfig {

    /** 内网基地址，默认 http://127.0.0.1:8001（契约 servers 占位端口）。 */
    private String baseUrl = "http://127.0.0.1:8001";

    /** 服务间令牌（D 侧 static 联调档 AI_SERVICE_TOKEN）；为空 = 不带 Authorization（D 侧 off 档）。 */
    private String token = "";

    /** 策略版本（安全规则/提示模板/知识快照集合标识；上游缓存键组成部分）。 */
    private String policyVersion = "POLICY-v1";

    /** 租户边界（缓存与检索按它隔离）。 */
    private String tenantId = "wechar-dev";

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }
    public String getToken() { return token; }
    public void setToken(String token) { this.token = token; }
    public String getPolicyVersion() { return policyVersion; }
    public void setPolicyVersion(String policyVersion) { this.policyVersion = policyVersion; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
}
