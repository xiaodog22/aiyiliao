package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 DoctorOnlineStatus（V22）：医生实时在线/接诊状态。
 *
 * - online：是否在线（医生自己开关）；
 * - accepting：是否愿意接新会话。服务端不变式：online=false 时恒为 false（拒绝"离线但仍接诊"脏态）；
 * - version：在线状态自身版本（每次开关 +1），与排班 version 相互独立。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DoctorOnlineStatusData(boolean online, boolean accepting, int version, Instant updatedAt) {
}
