package com.wechar.biz.common;

import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 时钟 Bean：响应 serverTime 与业务"当前时刻"的唯一权威来源，测试可注入固定时钟。 */
@Configuration
public class TimeConfig {

    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }
}
