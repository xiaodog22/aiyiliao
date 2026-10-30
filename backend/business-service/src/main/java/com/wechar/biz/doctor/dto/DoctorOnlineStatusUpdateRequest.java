package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotNull;

/**
 * 契约 DoctorOnlineStatusUpdate（V22）：开关在线接诊。
 *
 * 服务端行为：online=true → online=accepting=true；online=false → 两者同时置 0。
 * 下线时若仍有待回复的在线问诊会话 → 409 ONLINE_BUSY（先回复完再下线）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DoctorOnlineStatusUpdateRequest(@NotNull(message = "online 不能为空") Boolean online) {
}
