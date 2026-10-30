package com.wechar.biz.voice;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.wechar.biz.ai.AiClientConfig;
import com.wechar.biz.ai.AiTaskService;
import com.wechar.biz.ai.dto.UpstreamReadiness;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.voice.dto.AsrResultData;
import com.wechar.biz.voice.dto.TtsResultData;
import com.wechar.biz.voice.dto.VoiceData;
import com.wechar.biz.voice.dto.VoiceModelData;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

/**
 * 语音域服务（M2.3，契约 /api/v1/voice 域）：
 *  - ASR：音频不长期保存（受控临时目录 + asr_inputs 只登记摘要/大小）；
 *         requiresConfirmation 固定 true——转写必须经用户核对才进入诊疗流程；
 *         失败按稳定码结构化：CAPABILITY_UNAVAILABLE→503 / ASR_BUSY→429 / 超预算→504 ASR_TIMEOUT。
 *  - TTS：不内联音频字节，短期签名 URL；缓存键 HMAC-SHA-256(引擎版本|音色|语速|格式|规范化文本|隐私作用域)；
 *         命中缓存 cached=true；失败 TTS_UNAVAILABLE 降级（页面保留文字，不阻断对话）。
 *  - voices：内置来自服务端配置（客户端不得写死列表）；DELETE 幂等防探测；previews 只用固定示例文本。
 *  - models：返回能力状态而非承诺（ready 探针 unavailable 时如实反映，不是"服务挂了"）。
 * 红线：内网地址/令牌不进对外响应；不 200+空对象；不静默吞错。
 */
@Service
public class VoiceService {

    private static final Logger log = LoggerFactory.getLogger(VoiceService.class);

    /** ASR 转写语言标记只透传模型给出的值（模型不给 → null，不猜测）。 */
    private static final String MODEL_ID_PLACEHOLDER = "funasr";

    /** ai-service 侧 `resolve_audio_path` 支持的扩展名（多一个少一个都会导致取不到音频）。 */
    private static final java.util.Set<String> ASR_AUDIO_EXTENSIONS =
            java.util.Set.of(".wav", ".mp3", ".m4a", ".pcm", ".ogg", ".webm");

    /** 送上游前的脱敏：手机号 / 身份证号（只做数字形态剥离，不改变医学含义）。 */
    private static final Pattern PHONE = Pattern.compile("(?<!\\d)1[3-9]\\d{9}(?!\\d)");
    private static final Pattern ID_CARD = Pattern.compile("(?<!\\d)\\d{17}[\\dXx](?!\\d)");

    private final VoiceRepository repository;
    private final AiTaskService aiTaskService;
    private final AiClientConfig aiClientConfig;
    private final VoiceProperties properties;
    private final com.wechar.biz.consultation.ConsultationService consultationService;
    /** ai-service 侧读取音频的目录（AI_ASR_AUDIO_DIR）。两端口径必须一致，否则任务取不到音频。 */
    private final String asrAudioDir;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();

    public VoiceService(VoiceRepository repository, AiTaskService aiTaskService,
                        AiClientConfig aiClientConfig, VoiceProperties properties,
                        com.wechar.biz.consultation.ConsultationService consultationService, Clock clock,
                        @org.springframework.beans.factory.annotation.Value("${AI_ASR_AUDIO_DIR:}")
                        String asrAudioDir) {
        this.repository = repository;
        this.aiTaskService = aiTaskService;
        this.aiClientConfig = aiClientConfig;
        this.properties = properties;
        this.consultationService = consultationService;
        this.clock = clock;
        this.asrAudioDir = asrAudioDir;
    }

    // ---------------------------------------------------------------- 音色

    /** 音色列表：内置（服务端配置）+ 自定义（当前用户）。客户端必须容忍未知值。 */
    @Transactional(readOnly = true)
    public List<VoiceData> listVoices(String userId) {
        List<VoiceData> voices = new ArrayList<>();
        for (var builtin : properties.getBuiltin()) {
            voices.add(new VoiceData(builtin.getId(), builtin.getDisplayName(), builtin.getLocale(),
                    builtin.getGender(), builtin.isDefault(), false, builtin.isAvailable()));
        }
        for (var custom : repository.findCustomVoices(userId)) {
            voices.add(new VoiceData(custom.id(), custom.displayName(), custom.locale(), custom.gender(),
                    false, true, true));
        }
        return voices;
    }

    /** 默认音色：用户偏好里的 voiceId 若仍可用则用它，否则回落到内置默认。 */
    @Transactional(readOnly = true)
    public VoiceData defaultVoice(String userId) {
        var pref = repository.findPreference(userId);
        String preferred = pref.map(VoiceRepository.VoicePreferenceRow::voiceId).orElse(null);
        List<VoiceData> voices = listVoices(userId);
        if (preferred != null) {
            for (var v : voices) {
                if (v.id().equals(preferred) && Boolean.TRUE.equals(v.available())) {
                    return v;
                }
            }
        }
        for (var v : voices) {
            if (Boolean.TRUE.equals(v.isDefault())) {
                return v;
            }
        }
        // 配置里没标默认：回退首条（不返回空对象；正常配置下必有内置音色）
        if (!voices.isEmpty()) {
            return voices.get(0);
        }
        throw new ApiException("VOICE_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                "服务端未配置任何可用音色", true, null);
    }

    /** 保存音色偏好（契约 POST /voices：body 即 VoicePreference；返回所选音色）。 */
    @Transactional
    public VoiceData savePreference(String userId, String voiceId, BigDecimal rate, Boolean autoPlay) {
        VoiceData voice = resolveVoice(userId, voiceId);
        repository.savePreference(userId, voice.id(), rate, autoPlay, clock.instant());
        return voice;
    }

    /**
     * 解析音色（未知音色回退默认而非报错——契约 TtsRequest.voiceId 语义）。
     * 传入 null/空白 → 默认音色；已知但不可用（第三方失效）→ 也回退默认。
     */
    public VoiceData resolveVoice(String userId, String voiceId) {
        if (voiceId == null || voiceId.isBlank()) {
            return defaultVoice(userId);
        }
        List<VoiceData> voices = listVoices(userId);
        for (var v : voices) {
            if (v.id().equals(voiceId)) {
                return Boolean.TRUE.equals(v.available()) ? v : defaultVoice(userId);
            }
        }
        return defaultVoice(userId); // 未知音色 → 默认（客户端容忍未知值的对端保障）
    }

    /**
     * 删除自定义音色（契约 DELETE /voices/{voiceId}）：幂等——不存在同样返回成功，
     * 且只删当前用户的（他人音色 ID 即使猜中也删不掉，不构成探测通道）。
     */
    @Transactional
    public boolean deleteVoice(String userId, String voiceId) {
        return repository.deleteCustomVoice(userId, voiceId) > 0;
    }

    // ---------------------------------------------------------------- TTS

    /**
     * 语音合成（契约 POST /tts）：
     *  1) 脱敏（手机号/身份证剥离，不改变医学含义）；
     *  2) 缓存键 HMAC-SHA-256(引擎版本|音色|语速|格式|规范化文本|隐私作用域)；
     *  3) 命中未过期缓存 → 直接返回 URL + cached=true；
     *  4) 未命中 → 提交 TTS 任务并轮询；上游失败/超预算 → TTS_UNAVAILABLE（可重试），
     *     页面保留文字、不播占位音频、不阻断对话。
     */
    @Transactional
    public TtsResultData synthesize(String userId, String text, String voiceId, BigDecimal rate,
                                    String format, String locale) {
        VoiceData voice = resolveVoice(userId, voiceId);
        String fmt = format == null || format.isBlank() ? "mp3" : format;
        String normalized = normalizeForTts(text);
        Instant now = clock.instant();

        String cacheKey = hmacCacheKey(voice.id(), rate, fmt, normalized);
        var cached = repository.findTtsCache(cacheKey, now);
        if (cached.isPresent()) {
            return new TtsResultData(cached.get().audioUrl(), cached.get().mime(),
                    cached.get().durationMs(), true, cached.get().engine(), voice.id(), false);
        }

        AiTaskService.AiTaskRow taskRow = aiTaskService.create(userId, null, "TTS",
                null, normalized, null, voice.id(), locale);
        AiTaskService.AiTaskData task = aiTaskService.await(userId, taskRow.id(),
                Duration.ofSeconds(properties.getTts().getTaskBudgetSeconds()));

        if (!"SUCCEEDED".equals(task.status())) {
            // 失败/取消/超预算/仍在跑：一律 TTS_UNAVAILABLE 结构化降级（不静默、不空 200）
            String reason = "FAILED".equals(task.status()) ? "合成任务失败"
                    : ("EXPIRED".equals(task.status()) ? "合成超时" : "合成未完成");
            log.info("TTS 降级 task={} status={}", taskRow.id(), task.status());
            throw new ApiException("TTS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    reason + "，请保留文字展示并稍后重试", true, null);
        }

        var result = task.result();
        String audioUrl = result != null && result.hasNonNull("audioUrl")
                ? result.get("audioUrl").asText() : null;
        if (audioUrl == null || audioUrl.isBlank()) {
            // 成功但无音频地址：上游形态异常——降级而非 200+空对象
            throw new ApiException("TTS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "合成结果缺少音频地址，请保留文字展示并稍后重试", true, null);
        }

        String mime = "wav".equals(fmt) ? "audio/wav" : "audio/mpeg";
        Instant expiresAt = now.plusSeconds(properties.getTts().getUrlTtlSeconds());
        repository.saveTtsCache(cacheKey, audioUrl, mime, null, properties.getTts().getEngine(),
                voice.id(), now, expiresAt);
        return new TtsResultData(audioUrl, mime, null, false, properties.getTts().getEngine(),
                voice.id(), false);
    }

    /**
     * 试听（契约 POST /voices/{voiceId}/previews）：固定示例文本，不接受任意文本——
     * 避免把试听接口变成任意合成通道。未知/不可用音色 → 404。
     */
    @Transactional
    public TtsResultData preview(String userId, String voiceId) {
        VoiceData voice = listVoices(userId).stream()
                .filter(v -> v.id().equals(voiceId) && Boolean.TRUE.equals(v.available()))
                .findFirst()
                .orElseThrow(() -> new ApiException("VOICE_NOT_FOUND", HttpStatus.NOT_FOUND, "音色不存在"));
        return synthesize(userId, properties.getPreviewText(), voice.id(), null, "mp3", null);
    }

    // ---------------------------------------------------------------- ASR

    /**
     * 语音识别（契约 POST /asr，multipart）：
     *  - 音频写入受控临时目录，任务终态后清理；asr_inputs 只登记大小/摘要/过期（不存字节/路径）；
     *  - 音频通过 inputRef（asr:{id}）引用进入上游，不走 inputInline；
     *  - requiresConfirmation 恒为 true：转写必须经用户核对才能进入诊疗流程；
     *  - 失败稳定码：CAPABILITY_UNAVAILABLE→503 / ASR_BUSY→429 / 超预算→504 ASR_TIMEOUT。
     */
    @Transactional
    public AsrResultData recognize(String userId, MultipartFile audio, Long durationMs,
                                   String locale, String consultationId) {
        if (audio == null || audio.isEmpty()) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.BAD_REQUEST, "音频为空", false, null);
        }
        if (durationMs != null && (durationMs < 1 || durationMs > properties.getAsr().getMaxDurationMs())) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.BAD_REQUEST,
                    "音频时长须为 1~" + properties.getAsr().getMaxDurationMs() + " 毫秒", false, null);
        }
        long size = audio.getSize();
        if (size > properties.getAsr().getMaxBytes()) {
            throw new ApiException("PAYLOAD_TOO_LARGE", HttpStatus.PAYLOAD_TOO_LARGE,
                    "音频超过大小上限，请缩短录音", false, null);
        }

        byte[] bytes;
        try {
            bytes = audio.getBytes();
        } catch (IOException e) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.BAD_REQUEST, "音频读取失败", false, null);
        }

        String inputId = "asr-" + UUID.randomUUID();
        Instant now = clock.instant();
        String sha256 = Digests.sha256Hex(Base64.getEncoder().encodeToString(bytes));
        repository.insertAsrInput(inputId, userId, null, bytes.length, sha256,
                now, now.plus(Duration.ofSeconds(properties.getAsr().getTaskBudgetSeconds() * 2)));

        // 2026-10-22 修复：原实现写 `{java.io.tmpdir}\wechar-asr\{id}.bin` 并在提交任务后**立刻删除**，
        // 而 ai-service 只在 `AI_ASR_AUDIO_DIR/{id}.{wav|mp3|m4a|pcm|ogg|webm}` 找音频 ——
        // 目录不同 + 扩展名不对 + 文件已删，三条同时不满足，识别必然 CAPABILITY_UNAVAILABLE。
        // 现改为：写进与 ai-service 共享的目录、保留真实扩展名（前端录音为 mp3），
        // 任务收口（await 返回）后再清理，保证读取期间文件存在。
        Path audioFile = asrAudioPath(inputId, audio.getOriginalFilename(), audio.getContentType());
        try {
            Files.write(audioFile, bytes);
        } catch (IOException e) {
            log.warn("ASR 音频暂存失败：{}", e.getClass().getSimpleName());
            throw new ApiException("ASR_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "音频暂存失败，请重录", true, null);
        }

        AiTaskService.AiTaskRow taskRow;
        AiTaskService.AiTaskData task;
        try {
            taskRow = aiTaskService.create(userId, consultationId, "ASR",
                    "asr:" + inputId, null, null, null, locale);
            repository.bindAsrTask(inputId, taskRow.id());
            task = aiTaskService.await(userId, taskRow.id(),
                    Duration.ofSeconds(properties.getAsr().getTaskBudgetSeconds()));
        } finally {
            // 收口后再删：ai-service 通过 inputRef 读取期间文件必须存在（失败/超时同样清理）
            cleanupQuietly(audioFile);
        }

        AsrResultData result = toAsrResult(taskRow, task);
        // 识别成功且归属会话 → 落 DRAFT 转写草稿（未经 confirmations 确认不得据此生成结论）。
        // 客户端从会话详情取草稿 message.id，确认时作为 sourceTaskId 回传（契约 AsrResult 不含任务 ID）。
        if (consultationId != null && !consultationId.isBlank()) {
            consultationService.saveTranscriptDraft(userId, consultationId, taskRow.id(), result.text());
        }
        return result;
    }

    /** 任务 → AsrResult：失败按稳定码分类降级（契约 asr 响应 429/503/504）。 */
    private AsrResultData toAsrResult(AiTaskService.AiTaskRow taskRow, AiTaskService.AiTaskData task) {
        if ("SUCCEEDED".equals(task.status())) {
            var result = task.result();
            String transcript = result != null && result.hasNonNull("transcript")
                    ? result.get("transcript").asText() : null;
            if (transcript == null || transcript.isBlank()) {
                throw new ApiException("ASR_EMPTY", HttpStatus.UNPROCESSABLE_ENTITY,
                        "没有听清，请重录或改用文字输入", false, null);
            }
            String modelId = taskRow.modelId() == null ? MODEL_ID_PLACEHOLDER : taskRow.modelId();
            // language/hasTimestamps 只取模型真实给出的值（不给 → null/false，不猜测）
            String language = result != null && result.hasNonNull("language")
                    ? result.get("language").asText() : null;
            boolean timestamps = result != null && result.hasNonNull("hasTimestamps")
                    && result.get("hasTimestamps").asBoolean(false);
            return new AsrResultData(transcript, language, null, modelId, taskRow.modelVersion(),
                    timestamps, true, false);
        }
        if ("FAILED".equals(task.status())) {
            String code = task.error() != null && task.error().hasNonNull("code")
                    ? task.error().get("code").asText() : "ASR_FAILED";
            if ("ASR_BUSY".equals(code)) {
                throw new ApiException("ASR_BUSY", HttpStatus.TOO_MANY_REQUESTS,
                        "识别服务繁忙，请稍后重试", true, null);
            }
            if ("CAPABILITY_UNAVAILABLE".equals(code)) {
                throw new ApiException("CAPABILITY_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                        "语音识别能力暂不可用，请改用文字输入", true, null);
            }
            throw new ApiException("ASR_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "识别失败，请重录或改用文字输入", true, null);
        }
        // QUEUED/RUNNING（超预算未终态）/EXPIRED / CANCELLED → 超时降级
        throw new ApiException("ASR_TIMEOUT", HttpStatus.GATEWAY_TIMEOUT,
                "识别超时，请重录或改用文字输入", true, null);
    }

    /** 规范化：脱敏（手机号/证件号）+ 去首尾空白 + 折叠连续空白；不改变医学含义。 */
    static String normalizeForTts(String text) {
        String t = text == null ? "" : text.trim();
        t = PHONE.matcher(t).replaceAll("[手机号已隐藏]");
        t = ID_CARD.matcher(t).replaceAll("[证件号已隐藏]");
        return t.replaceAll("\\s+", " ");
    }

    /** 缓存键：HMAC-SHA-256(引擎版本|音色|语速|格式|规范化文本|隐私作用域)。 */
    String hmacCacheKey(String voiceId, BigDecimal rate, String format, String normalizedText) {
        String scope = "tenant:" + aiClientConfig.getTenantId(); // 隐私作用域：缓存不跨租户共享
        String material = String.join("|",
                properties.getTts().getEngine(),
                voiceId,
                rate == null ? "1.0" : rate.toPlainString(),
                format,
                normalizedText,
                scope);
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(cacheSecret(), "HmacSHA256"));
            return java.util.HexFormat.of()
                    .formatHex(mac.doFinal(material.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException("HMAC-SHA-256 不可用", e);
        }
    }

    /** 缓存 HMAC 密钥（dev 有确定性占位值；生产用环境变量覆盖，见 README）。 */
    private byte[] cacheSecret() {
        String secret = System.getProperty("voice.cache.secret",
                System.getenv().getOrDefault("VOICE_CACHE_SECRET", "wechar-dev-tts-cache-secret"));
        return secret.getBytes(StandardCharsets.UTF_8);
    }

    /**
     * 音频中转目录（2026-10-22）：优先 `AI_ASR_AUDIO_DIR` —— 该目录必须与 ai-service 的
     * `AI_ASR_AUDIO_DIR` **完全一致**，否则任务侧 `resolve_audio_path` 取不到文件。
     *
     * 未配置时回落到 `{java.io.tmpdir}/wechar-asr` 并告警：这条回落只够单测跑通，
     * 真实 ASR 链路会因两端目录不一致而降级 —— 不静默装作可用。
     */
    private Path asrAudioDir() {
        try {
            Path dir;
            if (asrAudioDir != null && !asrAudioDir.isBlank()) {
                dir = Path.of(asrAudioDir.trim());
            } else {
                dir = Path.of(System.getProperty("java.io.tmpdir"), properties.getAsr().getTempDir());
                log.warn("AI_ASR_AUDIO_DIR 未配置：音频暂存到 {}，ai-service 无法读取（ASR 将降级）", dir);
            }
            Files.createDirectories(dir);
            return dir;
        } catch (Exception e) {
            throw new ApiException("ASR_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "音频暂存目录不可用，请重录", true, null);
        }
    }

    /**
     * 音频落盘路径 `{inputId}.{ext}`：扩展名必须真实 —— ai-service 按
     * `wav/mp3/m4a/pcm/ogg/webm` 逐个探测，`{id}.bin` 永远取不到。
     * 取上传文件名扩展 → Content-Type 推断 → 兜底 wav（前端录音格式为 mp3）。
     */
    private Path asrAudioPath(String inputId, String originalFilename, String contentType) {
        return asrAudioDir().resolve(inputId + asrAudioExtension(originalFilename, contentType));
    }

    /** 扩展名归一：只接受 ai-service 支持的 6 种，其它一律按 Content-Type 推断，最后兜底 .wav。 */
    private static String asrAudioExtension(String originalFilename, String contentType) {
        String name = originalFilename == null ? "" : originalFilename.toLowerCase(java.util.Locale.ROOT);
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String ext = name.substring(dot);
            if (ASR_AUDIO_EXTENSIONS.contains(ext)) {
                return ext;
            }
        }
        String ct = contentType == null ? "" : contentType.toLowerCase(java.util.Locale.ROOT);
        if (ct.contains("wav")) return ".wav";
        if (ct.contains("mpeg") || ct.contains("mp3")) return ".mp3";
        if (ct.contains("mp4")) return ".m4a";
        if (ct.contains("ogg")) return ".ogg";
        if (ct.contains("webm")) return ".webm";
        if (ct.contains("pcm")) return ".pcm";
        return ".wav";
    }

    private void cleanupQuietly(Path file) {
        try {
            Files.deleteIfExists(file);
        } catch (IOException e) {
            log.warn("ASR 临时文件清理失败（不影响请求）：{}", e.getClass().getSimpleName());
        }
    }

    // ---------------------------------------------------------------- 模型能力状态

    /**
     * 模型能力状态（契约 GET /models）：返回能力状态而非承诺。
     * 就绪探针不可达 → 全部 unavailable 并给可读 detail（如实反映，不是 200+空对象）。
     */
    @Transactional(readOnly = true)
    public List<VoiceModelData> models() {
        UpstreamReadiness ready = aiTaskService.readiness();
        Map<String, String> modelStatus = new LinkedHashMap<>();
        Map<String, String> modelIds = new LinkedHashMap<>();
        Map<String, String> depStatus = new LinkedHashMap<>();
        if (ready != null && ready.models() != null) {
            for (var m : ready.models()) {
                if (m.role() != null) {
                    modelStatus.put(m.role(), m.status());
                    // 2026-10-22：modelId 如实取上游上报值（ASR 引擎为 funasr），
                    // 不再硬编码 "qwen3-asr-0.6b"（引擎已改 funasr，硬编码会谎报模型）。
                    if (m.modelId() != null && !m.modelId().isBlank()) {
                        modelIds.put(m.role(), m.modelId());
                    }
                }
            }
        }
        if (ready != null && ready.dependencies() != null) {
            for (var d : ready.dependencies()) {
                if (d.name() != null) {
                    depStatus.put(d.name(), d.status());
                }
            }
        }
        boolean unreachable = ready == null;

        List<VoiceModelData> models = new ArrayList<>();
        models.add(new VoiceModelData(modelIds.getOrDefault("asr", MODEL_ID_PLACEHOLDER), "ASR",
                mapAsrStatus(modelStatus.get("asr"), depStatus.get("asr_model"), unreachable),
                unreachable ? "就绪探针不可达，按不可用处理" : asrDetail(depStatus.get("asr_model"))));
        models.add(new VoiceModelData(properties.getTts().getEngine(), "TTS",
                mapTtsStatus(depStatus.get("tts_provider"), unreachable),
                unreachable ? "就绪探针不可达，按不可用处理" : ttsDetail(depStatus.get("tts_provider"))));
        models.add(new VoiceModelData("chat-small-default", "CHAT",
                mapChatStatus(modelStatus.get("small-default"), unreachable),
                unreachable ? "就绪探针不可达，按不可用处理" : "对话模型能力状态来自就绪探针"));
        models.add(new VoiceModelData("embedding", "EMBEDDING",
                mapEmbeddingStatus(modelStatus.get("embedding"), unreachable),
                unreachable ? "就绪探针不可达，按不可用处理" : "检索向量化能力状态来自就绪探针"));
        return models;
    }

    /** 上游 loaded→available / not_loaded→degraded / unavailable→unavailable（如实映射）。 */
    private static String mapAsrStatus(String modelState, String depState, boolean unreachable) {
        if (unreachable) return "unavailable";
        if ("unavailable".equals(depState)) return "unavailable";
        if ("loaded".equals(modelState)) return "available";
        if ("not_loaded".equals(modelState)) return "degraded";
        return "unavailable";
    }

    private static String mapTtsStatus(String depState, boolean unreachable) {
        if (unreachable) return "unavailable";
        if ("available".equals(depState)) return "available";
        if ("degraded".equals(depState)) return "degraded";
        return "unavailable";
    }

    private static String mapChatStatus(String modelState, boolean unreachable) {
        if (unreachable) return "unavailable";
        if ("loaded".equals(modelState)) return "available";
        if ("not_loaded".equals(modelState)) return "degraded";
        return "unavailable";
    }

    private static String mapEmbeddingStatus(String modelState, boolean unreachable) {
        if (unreachable) return "unavailable";
        if ("loaded".equals(modelState)) return "available";
        return "unavailable";
    }

    private static String asrDetail(String depState) {
        if ("available".equals(depState)) return "本地 ASR 权重已就绪（准确率未经测试集验证）";
        if ("degraded".equals(depState)) return "ASR 依赖降级可用";
        return "ASR 权重未配置，语音输入暂不可用";
    }

    private static String ttsDetail(String depState) {
        if ("available".equals(depState)) return "TTS 引擎已配置（引擎标识如实返回，不构成 SLA）";
        if ("degraded".equals(depState)) return "TTS 引擎降级可用";
        return "TTS 引擎未配置，朗读暂不可用（文字展示不受影响）";
    }
}
