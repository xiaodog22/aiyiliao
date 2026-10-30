package com.wechar.biz.voice;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.voice.dto.AsrResultData;
import com.wechar.biz.voice.dto.TtsResultData;
import com.wechar.biz.voice.dto.VoiceData;
import com.wechar.biz.voice.dto.VoiceModelData;
import jakarta.validation.Valid;
import java.math.BigDecimal;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * 语音域控制器（M2.3，契约 /api/v1/voice 域）：
 *  POST /api/v1/voice/asr                      识别（multipart；requiresConfirmation 恒 true）
 *  POST /api/v1/voice/tts                      合成（短期签名 URL；失败 TTS_UNAVAILABLE 降级）
 *  GET/POST /api/v1/voice/voices               列表 / 保存偏好
 *  GET  /api/v1/voice/voices/default           默认音色
 *  DELETE /api/v1/voice/voices/{voiceId}       删除自定义音色（幂等防探测）
 *  POST /api/v1/voice/voices/{voiceId}/previews 试听（固定示例文本）
 *  GET  /api/v1/voice/models                   能力状态（available/degraded/unavailable）
 * asr 的 Idempotency-Key 遵循契约 Header（08G §12 N-3 返工：原 multipart 字段读取与契约
 * `in: header, required: true` 不符，按契约 header 调用恒 400）。
 */
@RestController
@RequestMapping("/api/v1/voice")
public class VoiceController {

    private final VoiceService voiceService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public VoiceController(VoiceService voiceService, AuthService authService,
                           CurrentUserContext currentUserContext) {
        this.voiceService = voiceService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    /** 语音识别（音频不出服务器；转写必须经用户确认才进入诊疗流程）。
     *  契约 Idempotency-Key in:header required:true → 08G §12 N-3：改由 header 读取（与 TTS 同式，
     *  required=false + IdempotencyKeys.require 保留结构化 400 MISSING_IDEMPOTENCY_KEY）。 */
    @PostMapping("/asr")
    public ResponseEntity<Envelope<AsrResultData>> asr(
            @RequestPart("audio") MultipartFile audio,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @RequestParam(required = false) Long durationMs,
            @RequestParam(required = false, defaultValue = "zh-CN") String locale,
            @RequestParam(required = false) String consultationId) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                voiceService.recognize(userId, audio, durationMs, locale, consultationId)));
    }

    /** 语音合成（音频以短期签名 URL 交付，不内联字节）。契约 Idempotency-Key required:true → 缺失 400。 */
    @PostMapping("/tts")
    public ResponseEntity<Envelope<TtsResultData>> tts(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody TtsRequest request) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                voiceService.synthesize(userId, request.text(), request.voiceId(), request.rate(),
                        request.format(), request.locale())));
    }

    /** 契约 TtsRequest（additionalProperties:false 由全局严格反序列化保证）。 */
    @com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
    public record TtsRequest(@jakarta.validation.constraints.NotBlank(message = "text 不能为空")
                             @jakarta.validation.constraints.Size(max = 1000) String text,
                             String voiceId, BigDecimal rate, String format, String locale) {
    }

    /** 可用音色（内置来自服务端配置 + 当前用户自定义；客户端容忍未知值并回退默认）。 */
    @GetMapping("/voices")
    public ResponseEntity<Envelope<List<VoiceData>>> listVoices() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), voiceService.listVoices(userId)));
    }

    /** 保存音色偏好（body 即 VoicePreference：voiceId 必填，rate/autoPlay 可选）。 */
    @PostMapping("/voices")
    public ResponseEntity<Envelope<VoiceData>> savePreference(@Valid @RequestBody VoicePreferenceRequest request) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                voiceService.savePreference(userId, request.voiceId(), request.rate(), request.autoPlay())));
    }

    /** 契约 VoicePreference（additionalProperties:false）。 */
    @com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
    public record VoicePreferenceRequest(String voiceId, BigDecimal rate, Boolean autoPlay) {
    }

    /**
     * 设默认音色（PUT 别名，2026-10-17 补）：语义 = 覆盖当前账号的音色偏好，
     * 换机后随账号恢复（此前只有 POST /voices，语义含糊）。
     */
    @PutMapping("/voices/default")
    public ResponseEntity<Envelope<VoiceData>> setDefaultVoice(@Valid @RequestBody VoicePreferenceRequest request) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                voiceService.savePreference(userId, request.voiceId(), request.rate(), request.autoPlay())));
    }

    /** 默认音色。 */
    @GetMapping("/voices/default")
    public ResponseEntity<Envelope<VoiceData>> defaultVoice() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), voiceService.defaultVoice(userId)));
    }

    /** 删除自定义音色（幂等：不存在也返回成功，避免探测他人音色 ID）。 */
    @DeleteMapping("/voices/{voiceId}")
    public ResponseEntity<Envelope<DeletedData>> deleteVoice(@PathVariable String voiceId) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        voiceService.deleteVoice(userId, voiceId);
        // 契约 OkDeleted：幂等语义下"未找到/已删除"同样返回成功，客户端无需分支
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), new DeletedData(true)));
    }

    /** 契约 OkDeleted.data。 */
    public record DeletedData(Boolean deleted) {
    }

    /** 试听（固定示例文本；未知音色 404）。 */
    @PostMapping("/voices/{voiceId}/previews")
    public ResponseEntity<Envelope<TtsResultData>> preview(@PathVariable String voiceId) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), voiceService.preview(userId, voiceId)));
    }

    /** 语音模型能力状态（available/degraded/unavailable；如实反映权重缺失）。 */
    @GetMapping("/models")
    public ResponseEntity<Envelope<List<VoiceModelData>>> models() {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), voiceService.models()));
    }
}
