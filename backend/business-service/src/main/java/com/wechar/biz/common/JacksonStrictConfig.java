package com.wechar.biz.common;

import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Jackson 严格请求体（契约 additionalProperties:false 的落地机制）。
 *
 * Spring Boot 默认关闭 FAIL_ON_UNKNOWN_PROPERTIES，@JsonIgnoreProperties(ignoreUnknown=false)
 * 因此形同虚设（实测 {code, clientType} 会被静默接受）。此处全局开启严格反序列化：
 *  - 严格 DTO（WechatLoginRequest / HealthRecordCreateRequest / FamilyMemberCreateRequest /
 *    FamilyInvitationCreateRequest / HealthRecordUpdateRequest）无需额外注解即拒绝未知字段 → 400；
 *  - 宽松 DTO（PATCH/POST 契约外补充路径、triage 等）显式标注
 *    @JsonIgnoreProperties(ignoreUnknown = true) 保留宽容。
 */
@Configuration
public class JacksonStrictConfig {

    @Bean
    public Jackson2ObjectMapperBuilderCustomizer strictDeserialization() {
        return builder -> builder.featuresToEnable(
                com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }
}
