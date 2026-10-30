package com.wechar.biz.consultation;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * consultations / consultation_messages 数据访问（M2.1）。
 * 幂等：consultations、consultation_messages 各有 (user_id, idempotency_key) 唯一键。
 */
@Component
public class ConsultationRepository {

    private final JdbcTemplate jdbc;

    public ConsultationRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record ConsultationRow(String id, String userId, String doctorId, String title, String status,
                                  String summary, Instant lastMessageAt, String idempotencyKey,
                                  String requestDigest, Instant createdAt, Instant updatedAt) {
    }

    public record MessageRow(String id, String consultationId, String userId, String role, String contentType,
                             String content, String provenance, String citationsJson, String riskTagsJson,
                             String generationStatus, String sourceTaskId, String idempotencyKey,
                             String requestDigest, String confirmIdempotencyKey, String confirmDigest,
                             Instant createdAt) {
    }

    /** 问诊卡医生信息（V21：Consultation 契约字段的关联来源；LEFT JOIN 不到 → 三项皆 null）。 */
    public record DoctorBrief(String name, String title, String departmentName) {
    }

    private static final String CONSULT_COLS = "id, user_id, doctor_id, title, status, summary, last_message_at, "
            + "idempotency_key, request_digest, created_at, updated_at";

    private static final String MESSAGE_COLS = "id, consultation_id, user_id, role, content_type, content, "
            + "provenance, citations_json, risk_tags_json, generation_status, source_task_id, "
            + "idempotency_key, request_digest, confirm_idempotency_key, confirm_digest, created_at";

    private static ConsultationRow mapConsultation(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp last = rs.getTimestamp("last_message_at");
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        return new ConsultationRow(rs.getString("id"), rs.getString("user_id"), rs.getString("doctor_id"),
                rs.getString("title"), rs.getString("status"), rs.getString("summary"),
                last == null ? null : last.toInstant(), rs.getString("idempotency_key"),
                rs.getString("request_digest"),
                created == null ? null : created.toInstant(),
                updated == null ? null : updated.toInstant());
    }

    private static MessageRow mapMessage(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        return new MessageRow(rs.getString("id"), rs.getString("consultation_id"), rs.getString("user_id"),
                rs.getString("role"), rs.getString("content_type"), rs.getString("content"),
                rs.getString("provenance"), rs.getString("citations_json"), rs.getString("risk_tags_json"),
                rs.getString("generation_status"), rs.getString("source_task_id"),
                rs.getString("idempotency_key"), rs.getString("request_digest"),
                rs.getString("confirm_idempotency_key"), rs.getString("confirm_digest"),
                created == null ? null : created.toInstant());
    }

    // ---------------------------------------------------------------- consultations

    public void insertConsultation(ConsultationRow row) {
        jdbc.update("INSERT INTO consultations (" + CONSULT_COLS + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row.id(), row.userId(), row.doctorId(), row.title(), row.status(), row.summary(),
                row.lastMessageAt() == null ? null : Timestamp.from(row.lastMessageAt()),
                row.idempotencyKey(), row.requestDigest(), Timestamp.from(row.createdAt()), null);
    }

    /**
     * 独立事务持久化会话 + 首条消息（契约 createConsultation：生成失败不阻塞安全提示，
     * 契约 sendConsultationMessage：生成失败不影响用户消息的持久化）。
     * REQUIRES_NEW：提交即落库，随后上游任务创建失败（503）只影响本次响应，不回滚已落内容。
     * 红线：调用方必须处于无事务上下文（控制器直调服务），否则外层事务回滚会吞掉这里的提交意图。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void persistConsultationWithInitialMessage(ConsultationRow consultation, MessageRow message) {
        insertConsultation(consultation);
        insertMessage(message);
        touchConsultation(consultation.id(), message.createdAt(), message.createdAt());
    }

    /**
     * 独立事务持久化单条用户消息并刷新会话（同上：先落权威记录，再创建 AI 任务）。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void persistMessageAndTouch(String consultationId, Instant lastMessageAt, Instant now,
                                       MessageRow message) {
        insertMessage(message);
        touchConsultation(consultationId, lastMessageAt, now);
    }

    public Optional<ConsultationRow> findConsultationById(String id) {
        return jdbc.query("SELECT " + CONSULT_COLS + " FROM consultations WHERE id = ?",
                ConsultationRepository::mapConsultation, id).stream().findFirst();
    }

    /**
     * V21 问诊卡医生信息：doctor_id → doctors + departments 关联 brief。
     * 未分配医生 / 医生行被删 → empty（调用方按契约 doctorName=null 处理，不编造）。
     */
    public Optional<DoctorBrief> findDoctorBrief(String doctorId) {
        if (doctorId == null || doctorId.isBlank()) {
            return Optional.empty();
        }
        return jdbc.query("SELECT d.name, d.title, dep.name AS department_name "
                        + "FROM doctors d, departments dep "
                        + "WHERE d.department_id = dep.id AND d.id = ?",
                (rs, i) -> new DoctorBrief(rs.getString("name"), rs.getString("title"),
                        rs.getString("department_name")), doctorId)
                .stream().findFirst();
    }

    /**
     * V21 accepting 判定依据：会话末条消息角色（created_at, id 双键排序，新→新取首条）。
     * 无消息 → empty（调用方按 false 处理：患者尚未发言，不存在"等待中"的接诊信号）。
     */
    public Optional<String> findLastMessageRole(String consultationId) {
        return jdbc.query("SELECT role FROM consultation_messages WHERE consultation_id = ? "
                        + "ORDER BY created_at DESC, id DESC LIMIT 1",
                (rs, i) -> rs.getString("role"), consultationId).stream().findFirst();
    }

    /**
     * 会话最近 N 条消息（旧→新）。
     *
     * 用途（2026-10-24 真实 AI 问诊接入）：
     *  · CHAT 任务的多轮上下文 —— 之前只把「本轮这一句」交给模型，模型看不到前文，
     *    所以问不出「先收集信息再判断」的效果；
     *  · TRIAGE 任务的症状聚合 —— 只有患者多轮描述拼起来，分诊置信度才有意义。
     *
     * ⚠️ 必须先 DESC 取最近 N 条再反转：长会话下按 ASC LIMIT 拿到的是最早的 N 条，
     *    模型会拿几天前的开场白当当前病情。
     */
    public List<MessageRow> listRecentMessages(String consultationId, int limit) {
        List<MessageRow> desc = new java.util.ArrayList<>(jdbc.query(
                "SELECT " + MESSAGE_COLS + " FROM consultation_messages WHERE consultation_id = ? "
                        + "ORDER BY created_at DESC, id DESC LIMIT ?",
                ConsultationRepository::mapMessage, consultationId, limit));
        java.util.Collections.reverse(desc);
        return desc;
    }

    /**
     * 接诊判定（V21+）：会话内是否已存在**非患者侧**消息（医生回复 / 接诊系统提示）。
     *
     * 与 findLastMessageRole 的区别：按「末条角色」判定会被患者后续发言翻转
     * （医生已接诊 → 患者再问一句 → 末条变 user → 患者端回落「待接诊」，与会话真实状态矛盾）。
     * 接诊是会话级事实，一旦发生过就不会逆转，因此改为「存在性」判定。
     */
    public boolean hasNonUserMessage(String consultationId) {
        Integer rows = jdbc.queryForObject("SELECT COUNT(1) FROM consultation_messages "
                + "WHERE consultation_id = ? AND role <> 'user'", Integer.class, consultationId);
        return rows != null && rows > 0;
    }

    public Optional<ConsultationRow> findConsultationByIdempotencyKey(String userId, String key) {
        return jdbc.query("SELECT " + CONSULT_COLS + " FROM consultations WHERE user_id = ? AND idempotency_key = ?",
                ConsultationRepository::mapConsultation, userId, key).stream().findFirst();
    }

    /** 游标列表（新→旧）：cursor 之前（created_at, id）严格更小。 */
    public List<ConsultationRow> listConsultations(String userId, Instant beforeCreatedAt, String beforeId, int limit) {
        if (beforeCreatedAt == null) {
            return jdbc.query("SELECT " + CONSULT_COLS + " FROM consultations WHERE user_id = ? "
                            + "ORDER BY created_at DESC, id DESC LIMIT ?",
                    ConsultationRepository::mapConsultation, userId, limit);
        }
        return jdbc.query("SELECT " + CONSULT_COLS + " FROM consultations WHERE user_id = ? "
                        + "AND (created_at < ? OR (created_at = ? AND id < ?)) "
                        + "ORDER BY created_at DESC, id DESC LIMIT ?",
                ConsultationRepository::mapConsultation, userId,
                Timestamp.from(beforeCreatedAt), Timestamp.from(beforeCreatedAt), beforeId, limit);
    }

    public int countMessages(String consultationId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM consultation_messages WHERE consultation_id = ?",
                Integer.class, consultationId);
        return count == null ? 0 : count;
    }

    // ---------------------------------------------------------------- 医生视角（V21 doctor_id）

    /** 医生视角会话行：患者姓名/头像 join users（V21 医生回复闭环）。 */
    public record DoctorConsultationRow(String id, String userId, String patientName, String patientAvatarKey,
                                        String title, String status, String summary, Instant lastMessageAt,
                                        Instant createdAt, String assignedDoctorId) {
    }

    private static DoctorConsultationRow mapDoctorConsultation(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        Timestamp last = rs.getTimestamp("last_message_at");
        Timestamp created = rs.getTimestamp("created_at");
        return new DoctorConsultationRow(rs.getString("id"), rs.getString("user_id"),
                rs.getString("patient_name"), rs.getString("patient_avatar_key"),
                rs.getString("title"), rs.getString("status"), rs.getString("summary"),
                last == null ? null : last.toInstant(),
                created == null ? null : created.toInstant(),
                rs.getString("assigned_doctor_id"));
    }

    /**
     * 医生视角待处理会话列表：本医生名下 ACTIVE 会话 + **未分配** ACTIVE 会话（认领池）。
     * 未分配置前（先来先认领），已分配按最近消息倒序。assignedDoctorId 供前端区分「认领/回复」。
     */
    public List<DoctorConsultationRow> listByDoctor(String doctorId, Instant beforeCreatedAt, String beforeId, int limit) {
        String base = "SELECT c.id, c.user_id, u.display_name AS patient_name, u.avatar_key AS patient_avatar_key, "
                + "c.title, c.status, c.summary, c.last_message_at, c.created_at, c.doctor_id AS assigned_doctor_id "
                + "FROM consultations c LEFT JOIN users u ON u.id = c.user_id "
                + "WHERE c.status = 'ACTIVE' AND (c.doctor_id = ? OR c.doctor_id IS NULL) ";
        if (beforeCreatedAt == null) {
            return jdbc.query(base
                            + "ORDER BY (c.doctor_id IS NULL) DESC, c.created_at ASC, c.id ASC LIMIT ?",
                    ConsultationRepository::mapDoctorConsultation, doctorId, limit);
        }
        return jdbc.query(base
                        + "AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?)) "
                        + "ORDER BY (c.doctor_id IS NULL) DESC, c.created_at ASC, c.id ASC LIMIT ?",
                ConsultationRepository::mapDoctorConsultation, doctorId,
                Timestamp.from(beforeCreatedAt), Timestamp.from(beforeCreatedAt), beforeId, limit);
    }

    /**
     * 认领未分配咨询（幂等条件）：仅当会话未分配或已归本人时可写；已归他人 → 0 行（调用方转 409）。
     * @return 受影响行数
     */
    public int acceptConsultation(String consultationId, String doctorId, Instant now) {
        return jdbc.update("UPDATE consultations SET doctor_id = ?, updated_at = ? "
                        + "WHERE id = ? AND (doctor_id IS NULL OR doctor_id = ?)",
                doctorId, Timestamp.from(now), consultationId, doctorId);
    }

    /**
     * 结束咨询（医生侧收口）：仅本人 + 仍 ACTIVE 时置 CLOSED。
     * 条件写保证并发安全 —— 非本人 / 已结束 → 0 行，调用方据此区分 404 / 409。
     * @return 受影响行数
     */
    public int closeConsultation(String consultationId, String doctorId, Instant now) {
        return jdbc.update("UPDATE consultations SET status = 'CLOSED', updated_at = ? "
                        + "WHERE id = ? AND doctor_id = ? AND status = 'ACTIVE'",
                Timestamp.from(now), consultationId, doctorId);
    }

    public void touchConsultation(String id, Instant lastMessageAt, Instant now) {
        jdbc.update("UPDATE consultations SET last_message_at = ?, updated_at = ? WHERE id = ?",
                Timestamp.from(lastMessageAt), Timestamp.from(now), id);
    }

    // ---------------------------------------------------------------- messages

    public void insertMessage(MessageRow row) {
        jdbc.update("INSERT INTO consultation_messages (" + MESSAGE_COLS + ") "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row.id(), row.consultationId(), row.userId(), row.role(), row.contentType(), row.content(),
                row.provenance(), row.citationsJson(), row.riskTagsJson(), row.generationStatus(),
                row.sourceTaskId(), row.idempotencyKey(), row.requestDigest(),
                row.confirmIdempotencyKey(), row.confirmDigest(), Timestamp.from(row.createdAt()));
    }

    public Optional<MessageRow> findMessageById(String id) {
        return jdbc.query("SELECT " + MESSAGE_COLS + " FROM consultation_messages WHERE id = ?",
                ConsultationRepository::mapMessage, id).stream().findFirst();
    }

    public Optional<MessageRow> findMessageByIdempotencyKey(String userId, String key) {
        return jdbc.query("SELECT " + MESSAGE_COLS
                        + " FROM consultation_messages WHERE user_id = ? AND idempotency_key = ?",
                ConsultationRepository::mapMessage, userId, key).stream().findFirst();
    }

    /** 医生回复幂等：按会话维度判重（医生侧键空间独立，不与患者消息的 (user_id, key) 冲突）。 */
    public Optional<MessageRow> findMessageByConsultationAndIdempotencyKey(String consultationId, String key) {
        return jdbc.query("SELECT " + MESSAGE_COLS
                        + " FROM consultation_messages WHERE consultation_id = ? AND idempotency_key = ?",
                ConsultationRepository::mapMessage, consultationId, key).stream().findFirst();
    }

    /** 游标列表（旧→新，会话正文方向）：cursor 之后（created_at, id）严格更大。 */
    public List<MessageRow> listMessages(String consultationId, Instant afterCreatedAt, String afterId, int limit) {
        if (afterCreatedAt == null) {
            return jdbc.query("SELECT " + MESSAGE_COLS + " FROM consultation_messages WHERE consultation_id = ? "
                            + "ORDER BY created_at ASC, id ASC LIMIT ?",
                    ConsultationRepository::mapMessage, consultationId, limit);
        }
        return jdbc.query("SELECT " + MESSAGE_COLS + " FROM consultation_messages WHERE consultation_id = ? "
                        + "AND (created_at > ? OR (created_at = ? AND id > ?)) "
                        + "ORDER BY created_at ASC, id ASC LIMIT ?",
                ConsultationRepository::mapMessage, consultationId,
                Timestamp.from(afterCreatedAt), Timestamp.from(afterCreatedAt), afterId, limit);
    }

    /** 草稿转写（未确认不得据此生成结论）：按来源任务（或草稿消息 ID）查 DRAFT 用户消息。
     *  契约 AsrResult 未暴露 taskId，而 Message.id 对客户端可见（会话详情），故两者都认。 */
    public Optional<MessageRow> findDraftBySourceTask(String consultationId, String sourceTaskId) {
        return jdbc.query("SELECT " + MESSAGE_COLS + " FROM consultation_messages WHERE consultation_id = ? "
                        + "AND (source_task_id = ? OR id = ?) AND role = 'user' AND generation_status = 'DRAFT' "
                        + "ORDER BY created_at DESC LIMIT 1",
                ConsultationRepository::mapMessage, consultationId, sourceTaskId, sourceTaskId).stream().findFirst();
    }

    /** 确认转写：草稿 → CONFIRMED，内容以用户核对后的文本为准，并记录确认幂等键（同键重放比对）。 */
    public void confirmMessage(String id, String content, String confirmKey, String confirmDigest) {
        jdbc.update("UPDATE consultation_messages SET content = ?, generation_status = 'CONFIRMED', "
                        + "confirm_idempotency_key = ?, confirm_digest = ? WHERE id = ?",
                content, confirmKey, confirmDigest, id);
    }

    /**
     * 独立事务确认转写（REQUIRES_NEW）：确认先提交，随后终止源任务时上游不可达/任务不存在
     * 被 catch 不会把确认连带回滚（否则外层事务已被标记 rollback-only，提交抛
     * UnexpectedRollbackException → 500 且用户核对结果丢失）。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void confirmMessageCommitted(String id, String content, String confirmKey, String confirmDigest) {
        confirmMessage(id, content, confirmKey, confirmDigest);
    }

    /** 同一来源任务是否已确认过（重复确认 → 幂等/409 依据）。 */
    public Optional<MessageRow> findConfirmedBySourceTask(String consultationId, String sourceTaskId) {
        return jdbc.query("SELECT " + MESSAGE_COLS + " FROM consultation_messages WHERE consultation_id = ? "
                        + "AND (source_task_id = ? OR id = ?) AND role = 'user' AND generation_status = 'CONFIRMED' "
                        + "ORDER BY created_at DESC LIMIT 1",
                ConsultationRepository::mapMessage, consultationId, sourceTaskId, sourceTaskId).stream().findFirst();
    }

    /**
     * N10 注销 409 判定：该用户"进行中"的问诊计数 —— status=ACTIVE 且 since 之后有消息
     * （或刚创建无消息）。问诊无关闭端点，以时间窗口（契约登记 24h）判定进行中，
     * 避免历史 ACTIVE 会话永久阻塞注销。
     */
    public int countRecentActiveForUser(String userId, java.time.Instant since) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM consultations WHERE user_id = ? AND status = 'ACTIVE' "
                        + "AND ((last_message_at IS NOT NULL AND last_message_at >= ?) "
                        + "OR (last_message_at IS NULL AND created_at >= ?))",
                Integer.class, userId, java.sql.Timestamp.from(since), java.sql.Timestamp.from(since));
        return n == null ? 0 : n;
    }
}
