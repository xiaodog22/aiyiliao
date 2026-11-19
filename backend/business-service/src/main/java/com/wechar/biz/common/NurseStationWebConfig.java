package com.wechar.biz.common;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 护士站审批页静态资源映射（2026-11-19）。
 *
 * <p>项目基线配置了 {@code spring.web.resources.add-mappings=false}（禁用默认静态映射），
 * 因此这里显式只放行 {@code /nurse-station/**} 一个目录，不重新打开全站静态资源。
 * 页面本身不含患者数据，数据由 {@code /api/v1/nurse/bed-applications} 按终端令牌拉取。</p>
 */
@Configuration
public class NurseStationWebConfig implements WebMvcConfigurer {

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/nurse-station/**")
                .addResourceLocations("classpath:/static/nurse-station/")
                .setCachePeriod(0);
    }
}
