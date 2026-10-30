package com.wechar.biz.ai;

import com.wechar.biz.ai.dto.UpstreamReadiness;
import com.wechar.biz.ai.dto.UpstreamTask;

/**
 * ai-service 内网编排客户端接口（ai-openapi.yaml：任务提交/查询/取消 + 就绪探针）。
 * 抽接口目的：单测以 stub 替换真实 HTTP，保持 mvnw test 不依赖运行中的 ai-service。
 */
public interface AiTaskClient {

    /** 提交任务（inputRef 优先；敏感原文/音频引用不经过第二跳）。 */
    UpstreamTask submit(String userId, String taskType, String inputRef, String inputInline,
                        String requestedProfile, String idempotencyKey);

    /** 提交任务（语音任务带 voice/locale；未知音色由上游回退默认而非报错）。 */
    UpstreamTask submit(String userId, String taskType, String inputRef, String inputInline,
                        String requestedProfile, String idempotencyKey, String voice, String locale);

    /** 查询任务状态（O-02 定稿前唯一权威路径；调用方须自带轮询超时预算）。 */
    UpstreamTask get(String taskId);

    /** 尽力取消（终态任务返回同一终态，天然幂等）。 */
    UpstreamTask cancel(String taskId, String reason);

    /** 就绪探针：能力状态 available/degraded/unavailable（models/voices 用）。不可达返回 null。 */
    UpstreamReadiness readiness();
}
