package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.patient.AttachmentStorage;
import java.nio.file.Files;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;

/**
 * 阶段一/四：附件存储的 mp4 支持（真跑 save() 分支，不只断言常量）。
 *
 * 覆盖：
 *  ① mp4 上传真落盘 → 返回 key 扩展名为 mp4、磁盘文件存在、读取 mime 为 video/mp4
 *  ② 限额按类型分流：mp4=50MB、图片/PDF=10MB（用反射调私有 maxBytesFor，不改生产代码可见性）
 *  ③ 视频超 50MB → 413 且文案是 "50MB"；图片超 10MB → 413 且文案是 "10MB"（证明没有一刀切）
 *  ④ 未知扩展名 → 415
 *  ⑤ SAFE_KEY：接受 32hex.mp4，拒绝非 hex / 越界 / 非白名单扩展名
 *  ⑥ Range 请求 → 206 + Content-Range（拖动进度条的前提）
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:attachvideo;MODE=MySQL;DATABASE_TO_LOWER=TRUE;"
                + "CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "app.upload.dir=target/test-video",
        "app.attachment.sign-secret=test-sign-secret-0123456789abcdef",
        "app.resources.dir=../deploy/resources"
})
@AutoConfigureMockMvc
class AttachmentVideoTest {

    /** 4KB 假 mp4：Content-Type 由扩展名决定，不解析内容；长度足够测 Range。 */
    private static final byte[] MP4_BYTES = new byte[4096];

    static {
        MP4_BYTES[0] = 0x00;
        MP4_BYTES[1] = 0x00;
        MP4_BYTES[2] = 0x00;
        MP4_BYTES[3] = 0x18;   // ftyp box 长度
        MP4_BYTES[4] = 'f';
        MP4_BYTES[5] = 't';
        MP4_BYTES[6] = 'y';
        MP4_BYTES[7] = 'p';
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AttachmentStorage storage;

    private MockMultipartFile mp4() {
        return new MockMultipartFile("file", "demo.mp4", "video/mp4", MP4_BYTES);
    }

    @Test
    void mp4上传_真落盘_扩展名mp4_读取mime为video_mp4() {
        String key = storage.save(mp4());

        // 真跑 save()：返回的对象键是 32hex + .mp4
        assertThat(key).matches("^[0-9a-f]{32}\\.mp4$");
        var file = storage.resolve(key).orElseThrow();
        // 文件真的写到了磁盘（不是只返回了个字符串）
        assertThat(file.path()).exists();
        assertThat(Files.isRegularFile(file.path())).isTrue();
        assertThat(file.size()).isEqualTo(MP4_BYTES.length);
        // 读取时的 mime 必须是 video/mp4（不是 octet-stream、更不是 image/jpeg）
        assertThat(file.contentType()).isEqualTo("video/mp4");
    }

    @Test
    void 限额按类型分流_mp4为50MB_图片与PDF为10MB() {
        // 反射调用私有方法：不改生产代码可见性，也不需要为此把方法开成 public。
        // 显式声明 Long：invokeMethod 返回泛型 <T>，直接 assertThat 会与
        // assertThat(IntPredicate/Predicate) 的重载产生歧义（编译报"引用不明确"）。
        Long mp4Limit = ReflectionTestUtils.invokeMethod(storage, "maxBytesFor", "mp4");
        Long pngLimit = ReflectionTestUtils.invokeMethod(storage, "maxBytesFor", "png");
        Long pdfLimit = ReflectionTestUtils.invokeMethod(storage, "maxBytesFor", "pdf");
        Long jpgLimit = ReflectionTestUtils.invokeMethod(storage, "maxBytesFor", "jpg");

        assertThat(mp4Limit).isEqualTo(52428800L);
        assertThat(pngLimit).isEqualTo(10485760L);
        assertThat(pdfLimit).isEqualTo(10485760L);
        assertThat(jpgLimit).isEqualTo(10485760L);
    }

    @Test
    void 视频超50MB_返回413且文案为50MB() {
        // 覆写 getSize 伪造体积：不分配 50MB 内存，也保证走到限额分支
        var tooBig = new MockMultipartFile("file", "big.mp4", "video/mp4", new byte[16]) {
            @Override
            public long getSize() {
                return 52428801L;
            }
        };
        assertThatThrownBy(() -> storage.save(tooBig))
                .isInstanceOf(ApiException.class)
                .satisfies(e -> {
                    var ex = (ApiException) e;
                    assertThat(ex.getStatus()).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE);
                    assertThat(ex.getMessage()).contains("50MB");
                });
    }

    @Test
    void 图片超10MB_仍按10MB拒绝_证明没有一刀切放开() {
        var tooBig = new MockMultipartFile("file", "big.png", "image/png", new byte[16]) {
            @Override
            public long getSize() {
                return 10485761L;
            }
        };
        assertThatThrownBy(() -> storage.save(tooBig))
                .isInstanceOf(ApiException.class)
                .satisfies(e -> {
                    var ex = (ApiException) e;
                    assertThat(ex.getStatus()).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE);
                    assertThat(ex.getMessage()).contains("10MB");
                });
    }

    @Test
    void 未知扩展名_返回415() {
        var txt = new MockMultipartFile("file", "note.txt", "text/plain", "hi".getBytes());
        assertThatThrownBy(() -> storage.save(txt))
                .isInstanceOf(ApiException.class)
                .satisfies(e -> assertThat(((ApiException) e).getStatus())
                        .isEqualTo(HttpStatus.UNSUPPORTED_MEDIA_TYPE));
    }

    @Test
    void SAFE_KEY_接受32hex_mp4_拒绝非法名() {
        String key = storage.save(mp4());
        assertThat(storage.resolve(key)).as("合法 32hex.mp4 应可解析").isPresent();

        assertThat(storage.resolve("not-a-hex.mp4")).as("非 32hex").isEmpty();
        assertThat(storage.resolve("../../etc/passwd")).as("路径穿越").isEmpty();
        assertThat(storage.resolve("dddddddddddddddddddddddddddddddd.txt")).as("非白名单扩展名").isEmpty();
        assertThat(storage.resolve("dddddddddddddddddddddddddddddddd.mp4/../x")).as("混合穿越").isEmpty();
        assertThat(storage.resolve(null)).as("null").isEmpty();
        assertThat(storage.resolve("")).as("空串").isEmpty();
    }

    @Test
    void mp4响应头_video_mime与inline与acceptRanges() throws Exception {
        String key = storage.save(mp4());
        mockMvc.perform(get(storage.signedVideoUrl(key)))
                .andExpect(status().isOk())
                .andExpect(content().contentType("video/mp4"))
                .andExpect(header().string("Accept-Ranges", "bytes"))
                // 必须是 inline：attachment 会让 <video> 不播（浏览器当成下载）
                .andExpect(header().string("Content-Disposition",
                        org.hamcrest.Matchers.startsWith("inline")))
                .andExpect(header().string("Cache-Control",
                        org.hamcrest.Matchers.containsString("no-store")));
    }

    @Test
    void Range请求_返回206与Content_Range() throws Exception {
        String key = storage.save(mp4());
        mockMvc.perform(get(storage.signedVideoUrl(key)).header("Range", "bytes=0-1023"))
                .andExpect(status().isPartialContent())
                .andExpect(header().string("Content-Range",
                        "bytes 0-1023/" + MP4_BYTES.length))
                .andExpect(header().string("Content-Length", "1024"));
    }
}
