package com.wechar.biz;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * V4 业务服务入口（Agent-M 业务权威面）。
 * 契约事实源：backend/contracts/business-openapi.yaml（edge-gateway 标签除外的全部路径）。
 *
 * @EnableScheduling（2026-10-23）：账号注销 30 天物理清除任务（DeletionPurgeTask）等
 * 周期任务依赖调度器；启动失败即整体失败，不允许"调度没开任务静默不跑"。
 */
@SpringBootApplication
@EnableScheduling
public class BusinessServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(BusinessServiceApplication.class, args);
    }
}
