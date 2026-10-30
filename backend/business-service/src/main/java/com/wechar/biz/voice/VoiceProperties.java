package com.wechar.biz.voice;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * voice 域配置（M2.3）。
 * 引擎取值与音色清单来自服务端配置而非客户端（契约：客户端不得把列表写死在包里）。
 * ⚠️ 引擎字段只是适配器标识——对外不得据此宣称 SLA，也不得描述成 Azure 正式商业服务（O-10 待定稿）。
 */
@Configuration
@ConfigurationProperties(prefix = "voice")
public class VoiceProperties {

    public static class Tts {
        /** 合成适配器标识（如实回传到 TtsResult.engine）。 */
        private String engine = "qwen3-tts-local";

        /** 短期签名 URL 有效秒数（过期后重新申请，不长期留存）。 */
        private int urlTtlSeconds = 900;

        /** 合成轮询总预算（超预算按 TTS_UNAVAILABLE 降级，不无限等待）。 */
        private long taskBudgetSeconds = 30;

        public String getEngine() { return engine; }
        public void setEngine(String engine) { this.engine = engine; }
        public int getUrlTtlSeconds() { return urlTtlSeconds; }
        public void setUrlTtlSeconds(int urlTtlSeconds) { this.urlTtlSeconds = urlTtlSeconds; }
        public long getTaskBudgetSeconds() { return taskBudgetSeconds; }
        public void setTaskBudgetSeconds(long taskBudgetSeconds) { this.taskBudgetSeconds = taskBudgetSeconds; }
    }

    public static class Asr {
        /**
         * 转写轮询总预算（超预算按 ASR_TIMEOUT 降级，不无限等待）。
         *
         * 2026-10-22 由 30 提到 60：实测 FunASR paraformer-zh 在 CPU 上**首次**调用含模型加载
         * 约 33.5s（之后同进程内复用，秒级返回），30s 预算会把"第一次就成功"的请求判成超时。
         * 三档关系：ai-service 侧 AI_ASR_TIMEOUT_SECONDS=60 ≥ 本层 60 < 前端 aiTimeout 90s。
         */
        private long taskBudgetSeconds = 60;

        /** 音频时长上限（契约 durationMs max=60000）。 */
        private long maxDurationMs = 60_000;

        /** 音频字节上限（约 3MB；超限 → 413）。 */
        private long maxBytes = 3L * 1024 * 1024;

        /** 受控临时目录（相对 java.io.tmpdir；任务终态后清理，不存绝对路径到库）。 */
        private String tempDir = "wechar-asr";

        public long getTaskBudgetSeconds() { return taskBudgetSeconds; }
        public void setTaskBudgetSeconds(long taskBudgetSeconds) { this.taskBudgetSeconds = taskBudgetSeconds; }
        public long getMaxDurationMs() { return maxDurationMs; }
        public void setMaxDurationMs(long maxDurationMs) { this.maxDurationMs = maxDurationMs; }
        public long getMaxBytes() { return maxBytes; }
        public void setMaxBytes(long maxBytes) { this.maxBytes = maxBytes; }
        public String getTempDir() { return tempDir; }
        public void setTempDir(String tempDir) { this.tempDir = tempDir; }
    }

    /** 试听固定示例文本（不接受任意文本，避免把试听接口变成任意合成通道）。 */
    private String previewText = "您好，我是您的健康助手，很高兴为您服务。";

    /** 内置音色（服务端配置；客户端必须容忍未知值并回退默认）。 */
    private List<BuiltinVoice> builtin = new ArrayList<>();

    private final Tts tts = new Tts();
    private final Asr asr = new Asr();

    public String getPreviewText() { return previewText; }
    public void setPreviewText(String previewText) { this.previewText = previewText; }
    public List<BuiltinVoice> getBuiltin() { return builtin; }
    public void setBuiltin(List<BuiltinVoice> builtin) { this.builtin = builtin; }
    public Tts getTts() { return tts; }
    public Asr getAsr() { return asr; }

    /** 内置音色项。 */
    public static class BuiltinVoice {
        private String id;
        private String displayName;
        private String locale = "zh-CN";
        private String gender;
        private boolean isDefault;
        private boolean available = true;

        public String getId() { return id; }
        public void setId(String id) { this.id = id; }
        public String getDisplayName() { return displayName; }
        public void setDisplayName(String displayName) { this.displayName = displayName; }
        public String getLocale() { return locale; }
        public void setLocale(String locale) { this.locale = locale; }
        public String getGender() { return gender; }
        public void setGender(String gender) { this.gender = gender; }
        public boolean isDefault() { return isDefault; }
        public void setDefault(boolean aDefault) { isDefault = aDefault; }
        public boolean isAvailable() { return available; }
        public void setAvailable(boolean available) { this.available = available; }
    }
}
