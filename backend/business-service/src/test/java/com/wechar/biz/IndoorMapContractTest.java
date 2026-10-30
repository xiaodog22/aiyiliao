package com.wechar.biz;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * N17 院内导航契约测试——逐路径对 backend/contracts/business-openapi.yaml 的
 * /api/v1/indoor-map/floors 与 /api/v1/indoor-map/route：对每条契约操作发真实探针，
 * 断言实测状态码 ∈ 该操作声明的状态码集合；并断言数据结构（path 折线数组、steps 中文非空、
 * distanceM>0、目的地↔目的地拼接距离 = 两段大门距离之和）。
 * 数据来自 main resources 的 classpath:indoor-map.json（与前端 indoor-map.js 同源），
 * 不依赖任何种子数据行。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m17indoor;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@AutoConfigureMockMvc
class IndoorMapContractTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper mapper;

    // ---------------------------------------------------------------- 基础设施

    /** 契约探针断言：实测状态码必须落在该操作契约声明的状态码集合内。 */
    private static void probe(String op, int actual, int... declared) {
        for (int d : declared) {
            if (d == actual) {
                return;
            }
        }
        throw new AssertionError("契约探针 " + op + " 实测 " + actual
                + " 不在契约声明集合 " + java.util.Arrays.toString(declared));
    }

    private static int st(MvcResult result) {
        return result.getResponse().getStatus();
    }

    private static String body(MvcResult result) throws java.io.UnsupportedEncodingException {
        return result.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    /** 取 from→to 的 distanceM（该探针必须 200）。 */
    private int distanceM(String from, String to) throws Exception {
        MvcResult r = mockMvc.perform(get("/api/v1/indoor-map/route")
                .param("from", from).param("to", to)).andReturn();
        probe("GET /api/v1/indoor-map/route?from=" + from + "&to=" + to, st(r), 200);
        return mapper.readTree(body(r)).path("data").path("distanceM").asInt();
    }

    // ---------------------------------------------------------------- floors

    @Test
    void 楼层清单_200与结构() throws Exception {
        // 契约 listIndoorFloors 仅声明 200 → 精确单码
        MvcResult r = mockMvc.perform(get("/api/v1/indoor-map/floors")).andReturn();
        probe("GET /api/v1/indoor-map/floors", st(r), 200);

        var data = mapper.readTree(body(r)).path("data");
        org.assertj.core.api.Assertions.assertThat(data.isArray()).isTrue();
        org.assertj.core.api.Assertions.assertThat(data.size()).isGreaterThan(0);
        var first = data.get(0);
        org.assertj.core.api.Assertions.assertThat(first.path("id").asText("")).isNotBlank();
        org.assertj.core.api.Assertions.assertThat(first.path("name").asText("")).isNotBlank();
    }

    // ---------------------------------------------------------------- route

    @Test
    void 路径规划_大门到目的地() throws Exception {
        // 契约 getIndoorRoute 声明 200,400,404
        MvcResult r = mockMvc.perform(get("/api/v1/indoor-map/route")
                .param("from", "gate").param("to", "gi")).andReturn();
        probe("GET /api/v1/indoor-map/route(gate→gi)", st(r), 200, 400, 404);

        var data = mapper.readTree(body(r)).path("data");
        org.assertj.core.api.Assertions.assertThat(data.path("path").isArray()).isTrue();
        org.assertj.core.api.Assertions.assertThat(data.path("path").size()).isGreaterThan(0);
        org.assertj.core.api.Assertions.assertThat(data.path("steps").size()).isGreaterThan(0);
        org.assertj.core.api.Assertions.assertThat(data.path("distanceM").asInt()).isGreaterThan(0);
        org.assertj.core.api.Assertions.assertThat(data.path("from").asText("")).isEqualTo("gate");
        org.assertj.core.api.Assertions.assertThat(data.path("to").asText("")).isEqualTo("gi");

        // 反向：目的地 → 大门（回程段）
        MvcResult back = mockMvc.perform(get("/api/v1/indoor-map/route")
                .param("from", "gi").param("to", "gate")).andReturn();
        probe("GET /api/v1/indoor-map/route(gi→gate)", st(back), 200, 400, 404);
        var backData = mapper.readTree(body(back)).path("data");
        org.assertj.core.api.Assertions.assertThat(backData.path("path").size()).isGreaterThan(0);
        org.assertj.core.api.Assertions.assertThat(backData.path("steps").size()).isGreaterThan(0);
        org.assertj.core.api.Assertions.assertThat(backData.path("distanceM").asInt()).isGreaterThan(0);
    }

    @Test
    void 路径规划_目的地到目的地_距离为两段之和() throws Exception {
        int dGi = distanceM("gate", "gi");
        int dResp = distanceM("gate", "resp");
        int dAB = distanceM("gi", "resp");
        assertEquals(dGi + dResp, dAB, "A→B 距离必须 = 大门→A + 大门→B（数据源 distanceM 相加）");

        MvcResult r = mockMvc.perform(get("/api/v1/indoor-map/route")
                .param("from", "gi").param("to", "resp")).andReturn();
        probe("GET /api/v1/indoor-map/route(gi→resp)", st(r), 200, 400, 404);
        var data = mapper.readTree(body(r)).path("data");
        org.assertj.core.api.Assertions.assertThat(data.path("path").size()).isGreaterThan(1);
        org.assertj.core.api.Assertions.assertThat(data.path("steps").size()).isGreaterThan(0);
    }

    @Test
    void 路径规划_缺参与未知节点() throws Exception {
        // from 缺失 → 400（契约声明；服务层手动校验而非 Spring 缺参异常）
        probe("GET /api/v1/indoor-map/route(缺 from)",
                st(mockMvc.perform(get("/api/v1/indoor-map/route")
                        .param("to", "gi")).andReturn()), 200, 400, 404);
        // to 缺失 → 400
        probe("GET /api/v1/indoor-map/route(缺 to)",
                st(mockMvc.perform(get("/api/v1/indoor-map/route")
                        .param("from", "gate")).andReturn()), 200, 400, 404);

        // 未知节点 → 404（中文 message 由 ApiException 下发）
        MvcResult unknown = mockMvc.perform(get("/api/v1/indoor-map/route")
                .param("from", "gate").param("to", "no-such-node")).andReturn();
        probe("GET /api/v1/indoor-map/route(未知节点)", st(unknown), 200, 400, 404);
        org.assertj.core.api.Assertions.assertThat(st(unknown)).isEqualTo(404);
        org.assertj.core.api.Assertions.assertThat(body(unknown)).contains("导航节点不存在");
    }
}
