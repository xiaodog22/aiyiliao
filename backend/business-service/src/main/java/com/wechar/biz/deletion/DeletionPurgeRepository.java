package com.wechar.biz.deletion;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 注销冷静期到期账号的物理清除数据访问（N10 收尾，2026-10-23；V12 声明"清除由后续任务执行"）。
 *
 * 清除范围 = 该用户全部**业务与身份敏感数据**（物理删除），users 主行**匿名化保留**（终态 DELETED）：
 *  - 物理删除：auth_sessions / consents / user_profiles / user_extended / user_preferences /
 *    family_members / family_invitations / health_records（含 health_record_attachments）/
 *    appointments（含 appointment_status_events）/ consultations（含 consultation_messages）/
 *    ai_tasks / care_plan_requests / messages / custom_voices / voice_preferences / asr_inputs；
 *  - 匿名化 users：wechat_openid→deleted-&lt;id&gt;、手机号密文/哈希/绑定、姓名、头像、
 *    login_consent_version 全部清空，status=DELETED（终态，不再可登录）；
 *  - **保留**（法定/审计例外，见 DeletionService.retainedItemsFor）：deletion_requests（3 年）、
 *    audit_events（审计）；sms_challenges 无 user 维度（仅 phone_hash，不可逆），tts_cache 无用户维度，均不动；
 *  - doctors 关联不处理：医生账号不走患者注销流程，且 users 采用匿名化而非删行，FK 不会断裂。
 *
 * 所有 DELETE 均以 user_id 为边界（appointment_status_events 经 appointments 归属子查询），
 * 不存在跨用户波及；顺序按外键依赖（先子后父）。
 */
@Component
public class DeletionPurgeRepository {

    private final JdbcTemplate jdbc;

    public DeletionPurgeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 冷静期到期的用户（status=DELETION_PENDING 且 deletion_effective_at &lt;= now），按到期时间升序、限量。 */
    public List<String> findDueUserIds(Instant now, int limit) {
        return jdbc.query(
                "SELECT id FROM users WHERE status = 'DELETION_PENDING' AND deletion_effective_at <= ? "
                        + "ORDER BY deletion_effective_at ASC LIMIT ?",
                (rs, i) -> rs.getString("id"),
                Timestamp.from(now), limit);
    }

    /** 删除该用户的挂号状态流转事件（经 appointments 归属，先于 appointments 删除）。 */
    public int deleteAppointmentStatusEvents(String userId) {
        return jdbc.update(
                "DELETE FROM appointment_status_events WHERE appointment_id IN "
                        + "(SELECT id FROM appointments WHERE user_id = ?)", userId);
    }

    public int deleteAppointments(String userId) {
        return jdbc.update("DELETE FROM appointments WHERE user_id = ?", userId);
    }

    public int deleteConsultationMessages(String userId) {
        return jdbc.update("DELETE FROM consultation_messages WHERE user_id = ?", userId);
    }

    public int deleteAiTasks(String userId) {
        return jdbc.update("DELETE FROM ai_tasks WHERE user_id = ?", userId);
    }

    public int deleteConsultations(String userId) {
        return jdbc.update("DELETE FROM consultations WHERE user_id = ?", userId);
    }

    public int deleteCarePlanRequests(String userId) {
        return jdbc.update("DELETE FROM care_plan_requests WHERE user_id = ?", userId);
    }

    public int deleteCustomVoices(String userId) {
        return jdbc.update("DELETE FROM custom_voices WHERE user_id = ?", userId);
    }

    public int deleteVoicePreferences(String userId) {
        return jdbc.update("DELETE FROM voice_preferences WHERE user_id = ?", userId);
    }

    public int deleteAsrInputs(String userId) {
        return jdbc.update("DELETE FROM asr_inputs WHERE user_id = ?", userId);
    }

    public int deleteHealthRecordAttachments(String userId) {
        return jdbc.update("DELETE FROM health_record_attachments WHERE user_id = ?", userId);
    }

    public int deleteHealthRecords(String userId) {
        return jdbc.update("DELETE FROM health_records WHERE user_id = ?", userId);
    }

    public int deleteFamilyInvitations(String userId) {
        return jdbc.update("DELETE FROM family_invitations WHERE user_id = ?", userId);
    }

    public int deleteFamilyMembers(String userId) {
        return jdbc.update("DELETE FROM family_members WHERE user_id = ?", userId);
    }

    public int deleteMessages(String userId) {
        return jdbc.update("DELETE FROM messages WHERE user_id = ?", userId);
    }

    public int deleteUserPreferences(String userId) {
        return jdbc.update("DELETE FROM user_preferences WHERE user_id = ?", userId);
    }

    public int deleteConsents(String userId) {
        return jdbc.update("DELETE FROM consents WHERE user_id = ?", userId);
    }

    public int deleteUserProfiles(String userId) {
        return jdbc.update("DELETE FROM user_profiles WHERE user_id = ?", userId);
    }

    public int deleteUserExtended(String userId) {
        return jdbc.update("DELETE FROM user_extended WHERE user_id = ?", userId);
    }

    public int deleteAuthSessions(String userId) {
        return jdbc.update("DELETE FROM auth_sessions WHERE user_id = ?", userId);
    }

    /**
     * 匿名化 users 主行：status 置终态 DELETED（不再可登录），全部身份可识别字段清空；
     * wechat_openid 以 deleted-&lt;id&gt; 保证 UNIQUE 约束不冲突；deletion_requested_at/effective_at 保留供审计。
     * 仅从 DELETION_PENDING 流转（并发下重复执行返回 0）。
     */
    public int anonymizeUser(String userId, Instant now) {
        return jdbc.update(
                "UPDATE users SET status = 'DELETED', wechat_openid = CONCAT('deleted-', id), "
                        + "phone_cipher = NULL, phone_hash = NULL, phone_bound = 0, display_name = '[已注销]', "
                        + "avatar_key = NULL, login_consent_version = NULL, version = version + 1, updated_at = ? "
                        + "WHERE id = ? AND status = 'DELETION_PENDING'",
                Timestamp.from(now), userId);
    }
}
