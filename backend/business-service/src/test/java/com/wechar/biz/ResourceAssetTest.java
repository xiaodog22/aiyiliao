package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.resource.ResourceAssetService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * V14 资源库集成测试（H2 MySQL 兼容模式，Flyway 建表 + 种子在本测试上下文中真实执行）。
 *
 * 覆盖验收项：
 *  - 按 key 流式返回：Content-Type 取库内 mime、Content-Length 显式、Cache-Control 分级；
 *  - 响应体是**真实图片字节**（PNG 魔数），不是 JSON 信封；
 *  - status=0 / 不存在 → 404；key 非法 / 路径穿越 → 400 / 404；
 *  - If-None-Match 命中 → 304（真机重复打开省流量）；
 *  - 清单下发绝对 HTTPS url（配置 public-base-url 时），且保留 bundlePath 兜底。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:resourceasset;MODE=MySQL;DATABASE_TO_LOWER=TRUE;"
                + "CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "app.resources.public-base-url=https://qv56gv32944.vicp.fun",
        "app.resources.dir=../deploy/resources"
})
@AutoConfigureMockMvc
class ResourceAssetTest {

    /** 种子里 ai-doctor.png 的真实大小与 sha256（V14 种子同源）。 */
    private static final long AI_DOCTOR_SIZE = 12518L;
    private static final String AI_DOCTOR_SHA256 =
            "2b780ccb244a0567bde5ad3eb1eb15f19f703ea8346ed8b1d2ff372bd6432152";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ResourceAssetService resourceAssetService;

    @Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbc;

    @Test
    void 资源_按key流式返回_头部与图片字节正确() throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/resources/home.ai-doctor"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("image/png"))
                .andExpect(header().string("Content-Length", String.valueOf(AI_DOCTOR_SIZE)))
                // 图片 7 天公有缓存（604800s）
                .andExpect(header().string("Cache-Control",
                        org.hamcrest.Matchers.containsString("max-age=604800")))
                .andExpect(header().string("Cache-Control",
                        org.hamcrest.Matchers.containsString("public")))
                .andExpect(header().string("ETag", "\"" + AI_DOCTOR_SHA256 + "\""))
                .andReturn();

        byte[] body = result.getResponse().getContentAsByteArray();
        assertThat(body).as("必须返回完整文件字节，而不是 JSON 信封").hasSize((int) AI_DOCTOR_SIZE);
        assertThat(new byte[] {body[0], body[1], body[2], body[3], body[4], body[5], body[6], body[7]})
                .as("PNG 魔数")
                .containsExactly((byte) 0x89, (byte) 0x50, (byte) 0x4E, (byte) 0x47,
                        (byte) 0x0D, (byte) 0x0A, (byte) 0x1A, (byte) 0x0A);
    }

    @Test
    void 资源_IfNoneMatch命中_返回304() throws Exception {
        mockMvc.perform(get("/api/v1/resources/home.ai-doctor")
                        .header("If-None-Match", "\"" + AI_DOCTOR_SHA256 + "\""))
                .andExpect(status().isNotModified())
                .andExpect(header().doesNotExist("Content-Length"));
    }

    @Test
    void 资源_停用与不存在_都返回404() throws Exception {
        // status=0：元数据与文件都真实存在，仅停用 → 404（不泄露存在性）
        mockMvc.perform(get("/api/v1/resources/legacy.disabled-sample"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("NOT_FOUND"));
        mockMvc.perform(get("/api/v1/resources/home.not-exists"))
                .andExpect(status().isNotFound());
    }

    @Test
    void 资源_视频按video_mime返回_缓存1天() throws Exception {
        mockMvc.perform(get("/api/v1/resources/video.wash-hands"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("video/mp4"))
                .andExpect(header().string("Cache-Control",
                        org.hamcrest.Matchers.containsString("max-age=86400")));
    }

    @Test
    void 路径穿越与非法key_被拦在查询与路径解析之外() {
        // key 含 .. 或路径分隔符 → 400（不进入数据库查询）
        assertThatThrownBy(() -> resourceAssetService.requireValidKey("../../etc/passwd"))
                .isInstanceOf(ApiException.class)
                .satisfies(e -> assertThat(((ApiException) e).getStatus()).isEqualTo(HttpStatus.BAD_REQUEST));
        assertThatThrownBy(() -> resourceAssetService.requireValidKey("a/b"))
                .isInstanceOf(ApiException.class)
                .satisfies(e -> assertThat(((ApiException) e).getStatus()).isEqualTo(HttpStatus.BAD_REQUEST));

        // 库内 file_path 若被污染，resolveSafe 仍必须拒绝越界（纵深防御第二层）
        assertThatThrownBy(() -> resourceAssetService.resolveSafe("../../../etc/passwd"))
                .isInstanceOf(ApiException.class)
                .satisfies(e -> assertThat(((ApiException) e).getStatus()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> resourceAssetService.resolveSafe("/etc/passwd"))
                .as("绝对路径一律拒绝")
                .isInstanceOf(ApiException.class);
        // 正常相对路径可解析
        assertThat(resourceAssetService.resolveSafe("ai-doctor.png").getFileName().toString())
                .isEqualTo("ai-doctor.png");
    }

    @Test
    void 资源_mime不在白名单_按不存在处理() throws Exception {
        // 登记一条 mime 非图片、但文件真实存在的启用记录：不允许下发的类型必须 404，
        // 不能把库内任意文件当资源吐给客户端（例如误登记 text/html 或可执行文件）。
        jdbc.update("INSERT INTO resource_asset (resource_key, category, file_path, mime_type, "
                        + "file_size, sha256, status, level, bundle_path, sort_order) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                "test.html-asset", "icon", "svc-more.png", "text/html", 3012,
                "a107827e90ca1e17c374f59f51c920facb75e90be27f3021d1832548d88b57b1", 1, "B", null, 250);

        mockMvc.perform(get("/api/v1/resources/test.html-asset"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("NOT_FOUND"));

        // 同时不得进入资源清单（契约 items.mime 仅图片）
        mockMvc.perform(get("/api/v1/resources/manifest").param("platform", "wechat-miniprogram"))
                .andExpect(jsonPath("$.data.items[*].key",
                        org.hamcrest.Matchers.not(org.hamcrest.Matchers.hasItem("test.html-asset"))));
    }

    @Test
    void 资源_匿名访问无需Authorization() throws Exception {
        // 不加任何 Authorization / X-User-Id 头（模拟 <image> 组件）
        mockMvc.perform(get("/api/v1/resources/home.ai-doctor"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("image/png"));
    }

    @Test
    void 清单_下发绝对HTTPS地址_并保留bundlePath兜底() throws Exception {
        mockMvc.perform(get("/api/v1/resources/manifest")
                        .param("platform", "wechat-miniprogram"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.manifestVersion").value("v1.1.0"))
                // V15 起清单只下发 delivery=remote：首条是 banner（cover），
                // ai-doctor / svc-* 等高频小图已改为 local（不下发 url，前端用包内图）
                .andExpect(jsonPath("$.data.items[0].key").value("home.banner-hospital"))
                .andExpect(jsonPath("$.data.items[0].url")
                        .value("https://qv56gv32944.vicp.fun/api/v1/resources/home.banner-hospital"))
                .andExpect(jsonPath("$.data.items[0].fallbackKey").value("/assets/home/banner-hospital.jpg"))
                .andExpect(jsonPath("$.data.items[0].mime").value("image/jpeg"));
    }
}
