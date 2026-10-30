package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * N9 同手机号 60s 冷却红线测试（2026-10-19）：同一手机号 cooldown-seconds 内重复下发 → 429。
 * 独立上下文保留默认 60s 冷却（SmsLoginContractTest 为跑通登录链把冷却置 0，两者互补）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m8smscool;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8"
})
@AutoConfigureMockMvc
class SmsCooldownContractTest {

    private static final String PHONE = "13900003333";

    @Autowired
    private MockMvc mockMvc;

    private static void probe(String op, int actual, int... declared) {
        for (int d : declared) {
            if (d == actual) {
                return;
            }
        }
        throw new AssertionError("契约探针 " + op + " 实测 " + actual
                + " 不在契约声明集合 " + java.util.Arrays.toString(declared));
    }

    private MvcResult send(String phone) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/sms/send")
                .header("Idempotency-Key", "n9cool-" + UUID.randomUUID())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"phone\":\"" + phone + "\",\"scene\":\"DOCTOR_LOGIN\"}"))
                .andReturn();
    }

    @Test
    void 同手机号冷却内重复下发() throws Exception {
        // 首次下发 → 200
        probe("POST /api/v1/auth/sms/send(首次)", send(PHONE).getResponse().getStatus(), 200);
        // 同一手机号 60s 内再发 → 429（契约声明 429）
        probe("POST /api/v1/auth/sms/send(冷却内)", send(PHONE).getResponse().getStatus(), 429);
        // 其它手机号不受影响（限流按手机号维度，非全局）
        probe("POST /api/v1/auth/sms/send(其它号码)", send("13900004444").getResponse().getStatus(), 200);
    }
}
