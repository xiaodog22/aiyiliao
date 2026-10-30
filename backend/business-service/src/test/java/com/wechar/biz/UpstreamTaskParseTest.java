package com.wechar.biz;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.wechar.biz.ai.dto.UpstreamTask;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 上游任务响应反序列化（2026-10-24）。
 *
 * 背景：项目全局是**严格反序列化**（FAIL_ON_UNKNOWN_PROPERTIES=true），
 * 而 ai-service 的 citations 自 2026-10-22 起带 index/documentId/chunkId/source。
 * 只要 RAG/知识库检索返回非空 citations，整条任务响应就会解析失败 →
 * business 抛 AI_UPSTREAM_MALFORMED(502) → 客户端表现「AI 一直不回复」。
 *
 * 本测试用**真实上游报文**（含 3 条 citations + cached + knowledgeSnapshot 等扩展字段）
 * 在严格模式下反序列化，锁死"上游加字段不得打断编排"。
 */
class UpstreamTaskParseTest {

    private static final String REAL_PAYLOAD = "{"
            + "\"code\":\"OK\",\"message\":\"OK\",\"requestId\":\"r_x\","
            + "\"data\":{"
            + "\"taskId\":\"t_d3d025383a964e20\",\"tenantId\":\"wechar-dev\",\"taskType\":\"CHAT\","
            + "\"status\":\"SUCCEEDED\",\"priority\":\"INTERACTIVE\",\"progressPhase\":null,"
            + "\"modelProfile\":\"large-upgrade\",\"modelId\":\"qwen2.5:7b\",\"modelVersion\":null,"
            + "\"quantization\":null,\"promptTemplateVersion\":\"consultation-chat-v3\","
            + "\"policyVersion\":\"POLICY-v1\",\"knowledgeSnapshot\":\"hospital-knowledge-v3\","
            + "\"result\":{\"text\":\"有没有发热或咳嗽？\",\"citations\":["
            + "{\"index\":1,\"documentId\":\"chat\",\"chunkId\":\"chat:挂号与退号:2\","
            + "\"title\":\"挂号与退号\",\"source\":\"院方提供\",\"score\":0.65},"
            + "{\"index\":2,\"documentId\":\"triage\",\"chunkId\":\"triage:x:0\","
            + "\"title\":\"常见症状科室映射\",\"source\":\"config\",\"score\":0.628}],"
            + "\"provenance\":\"AI_GENERATED\",\"refused\":false,\"refusalReason\":null,"
            + "\"language\":\"zh-CN\",\"hasTimestamps\":false},"
            + "\"error\":null,\"cached\":true,"
            + "\"createdAt\":\"2026-10-24T15:31:43.938Z\","
            + "\"startedAt\":\"2026-10-24T15:31:43.948Z\","
            + "\"finishedAt\":\"2026-10-24T15:31:43.954Z\","
            + "\"expiresAt\":\"2026-10-24T16:31:43.954Z\"}}";

    private static final String TRIAGE_PAYLOAD = "{"
            + "\"code\":\"OK\",\"message\":\"OK\",\"requestId\":\"r_t\","
            + "\"data\":{\"taskId\":\"t_triage\",\"tenantId\":\"wechar-dev\",\"taskType\":\"TRIAGE\","
            + "\"status\":\"SUCCEEDED\",\"priority\":\"INTERACTIVE\",\"modelProfile\":\"large-upgrade\","
            + "\"modelId\":\"qwen2.5:7b\",\"promptTemplateVersion\":\"triage-supplement-v2\","
            + "\"policyVersion\":\"POLICY-v1\","
            + "\"result\":{\"recommendedDepartments\":["
            + "{\"departmentName\":\"耳鼻喉科\",\"reason\":\"咽痛、声音嘶哑\",\"confidence\":0.8},"
            + "{\"departmentName\":\"全科医学科\",\"reason\":\"症状不典型\",\"confidence\":0.3}],"
            + "\"provenance\":\"AI_GENERATED\","
            + "\"limitations\":\"AI 补充建议，不构成诊断\"},"
            + "\"error\":null,\"cached\":false,"
            + "\"createdAt\":\"2026-10-24T15:40:53.180Z\","
            + "\"finishedAt\":\"2026-10-24T15:41:20.408Z\"}}";

    private ObjectMapper strictMapper() {
        ObjectMapper m = new ObjectMapper();
        m.registerModule(new JavaTimeModule());
        m.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, true);
        return m;
    }

    @Test
    void 真实上游报文在严格反序列化下可解析() throws Exception {
        ObjectMapper mapper = strictMapper();

        // 与 HttpAiTaskClient.parseEnvelope 同口径：先取信封 data 节点再转 record
        UpstreamTask task = mapper.treeToValue(
                mapper.readTree(REAL_PAYLOAD).get("data"), UpstreamTask.class);

        Assertions.assertEquals("SUCCEEDED", task.status());
        Assertions.assertEquals("qwen2.5:7b", task.modelId());
        Assertions.assertEquals(Boolean.TRUE, task.cached());
        Assertions.assertEquals("有没有发热或咳嗽？", task.result().text());
        Assertions.assertEquals(2, task.result().citations().size(), "citations 必须被完整保留");
        Assertions.assertEquals("chat:挂号与退号:2", task.result().citations().get(0).chunkId());
        Assertions.assertEquals("院方提供", task.result().citations().get(0).source());
    }

    /**
     * TRIAGE 的科室与置信度必须活过「反序列化 → 再序列化落库」这一趟。
     *
     * business 侧 applyUpstream 会把 upstream.result()（强类型 record）重新 toJson 存 result_json，
     * 未建模字段在这一步永久丢失 —— 前端只会拿到 provenance/limitations，分诊卡永远出不来。
     */
    @Test
    void 分诊科室与置信度必须完整落库() throws Exception {
        ObjectMapper mapper = strictMapper();
        UpstreamTask task = mapper.treeToValue(
                mapper.readTree(TRIAGE_PAYLOAD).get("data"), UpstreamTask.class);

        Assertions.assertNotNull(task.result().recommendedDepartments(), "recommendedDepartments 不得为 null");
        Assertions.assertEquals("耳鼻喉科",
                task.result().recommendedDepartments().get(0).path("departmentName").asText());

        String persisted = mapper.writeValueAsString(task.result());
        Assertions.assertTrue(persisted.contains("耳鼻喉科"), "落库 JSON 必须保留科室：" + persisted);
        Assertions.assertTrue(persisted.contains("0.8"), "落库 JSON 必须保留置信度：" + persisted);
    }
}
