package com.wechar.biz.patient;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * patient_index / his_patient_map 数据访问（V39）。
 *
 * 两条不变量（DDL 已强制，这里再写一遍便于排障）：
 *   · `UNIQUE (owner_user_id, display_name)` —— 同一账号可替多个不同姓名的人建档（代挂号），
 *     但同名只能有一条；代家人挂号不要求先建 family_members（实测 u-dev-user-1 名下 5 个姓名）。
 *   · `UNIQUE (owner_user_id, idempotency_key)` —— MySQL 允许多个 NULL，所以未带键的行不互相冲突。
 */
@Component
public class PatientIndexRepository {

    private final JdbcTemplate jdbc;

    public PatientIndexRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 就诊人主索引行（不含任何哈希字段以外的敏感列，哈希仅供内部匹配，绝不下发给客户端）。 */
    public record PatientRow(String patientRef, String ownerUserId, String familyMemberId,
                             String displayName, String birthDate, String sex, String idLast4,
                             String idCardHash, String phoneMask, String phoneHash,
                             String verificationLevel, String identitySource, String status,
                             int version, Instant createdAt, Instant updatedAt) {
    }

    /** 映射投影行（his_patient_map）。 */
    public record MappingRow(String status, String matchTier, Instant decidedAt, Instant updatedAt) {
    }

    private static final String COLS = "patient_ref, owner_user_id, family_member_id, display_name, "
            + "birth_date, sex, id_last4, id_card_hash, phone_mask, phone_hash, verification_level, "
            + "identity_source, status, version, created_at, updated_at";

    private static PatientRow map(ResultSet rs, int i) throws SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        return new PatientRow(
                rs.getString("patient_ref"), rs.getString("owner_user_id"),
                rs.getString("family_member_id"), rs.getString("display_name"),
                rs.getString("birth_date"), rs.getString("sex"), rs.getString("id_last4"),
                rs.getString("id_card_hash"), rs.getString("phone_mask"), rs.getString("phone_hash"),
                rs.getString("verification_level"), rs.getString("identity_source"),
                rs.getString("status"), rs.getInt("version"),
                created == null ? null : created.toInstant(),
                updated == null ? null : updated.toInstant());
    }

    private static MappingRow mapMapping(ResultSet rs, int i) throws SQLException {
        Timestamp decided = rs.getTimestamp("decided_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        return new MappingRow(rs.getString("status"), rs.getString("match_tier"),
                decided == null ? null : decided.toInstant(),
                updated == null ? null : updated.toInstant());
    }

    /** 当前用户的就诊人列表，按创建时间升序；ARCHIVED 默认不返回。 */
    public List<PatientRow> listByOwner(String userId, boolean includeArchived) {
        String sql = "SELECT " + COLS + " FROM patient_index WHERE owner_user_id = ?"
                + (includeArchived ? "" : " AND status = 'ACTIVE'")
                + " ORDER BY created_at, patient_ref";
        return jdbc.query(sql, PatientIndexRepository::map, userId);
    }

    /** 按 ref 精确取，且必须属于该用户 —— 不属于一律当作不存在（避免对象存在性泄漏）。 */
    public Optional<PatientRow> findOwned(String userId, String patientRef) {
        var rows = jdbc.query("SELECT " + COLS + " FROM patient_index "
                + "WHERE patient_ref = ? AND owner_user_id = ?",
                PatientIndexRepository::map, patientRef, userId);
        return rows.stream().findFirst();
    }

    /** 同用户同姓名查重（唯一键的读取侧，用于幂等返回既有记录）。 */
    public Optional<PatientRow> findByName(String userId, String displayName) {
        var rows = jdbc.query("SELECT " + COLS + " FROM patient_index "
                + "WHERE owner_user_id = ? AND display_name = ?",
                PatientIndexRepository::map, userId, displayName);
        return rows.stream().findFirst();
    }

    /** 证件哈希查重（同一证件不允许建两个就诊人）。 */
    public Optional<String> findByOwnerAndIdHash(String userId, String idCardHash) {
        var rows = jdbc.query("SELECT patient_ref FROM patient_index "
                + "WHERE owner_user_id = ? AND id_card_hash = ?",
                (rs, i) -> rs.getString(1), userId, idCardHash);
        return rows.stream().findFirst();
    }

    /** 幂等键摘要（同键异体判定）。 */
    public Optional<String> findIdempotencyDigest(String userId, String key) {
        var rows = jdbc.query("SELECT request_digest FROM patient_index "
                + "WHERE owner_user_id = ? AND idempotency_key = ?",
                (rs, i) -> rs.getString(1), userId, key);
        return rows.stream().findFirst();
    }

    public void insert(PatientRow row, String idempotencyKey, String requestDigest) {
        jdbc.update("INSERT INTO patient_index (patient_ref, owner_user_id, family_member_id, display_name, "
                        + "birth_date, sex, id_last4, id_card_hash, phone_mask, phone_hash, "
                        + "verification_level, identity_source, status, version, idempotency_key, "
                        + "request_digest, created_at) "
                        + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',1,?,?,?)",
                row.patientRef(), row.ownerUserId(), row.familyMemberId(), row.displayName(),
                emptyToNull(row.birthDate()), emptyToNull(row.sex()), emptyToNull(row.idLast4()),
                emptyToNull(row.idCardHash()), emptyToNull(row.phoneMask()),
                emptyToNull(row.phoneHash()), row.verificationLevel(), row.identitySource(),
                idempotencyKey, requestDigest, Timestamp.from(Instant.now()));
    }

    /** 乐观锁更新：返回 false 表示版本已被别人推进（调用方转 409 VERSION_CONFLICT）。 */
    public boolean updateWithVersion(String userId, String patientRef, int expectedVersion,
                                     String displayName, String birthDate, String sex,
                                     String idLast4, String idCardHash, String phoneMask,
                                     String phoneHash, String verificationLevel) {
        int updated = jdbc.update("UPDATE patient_index SET display_name = ?, birth_date = ?, sex = ?, "
                        + "id_last4 = ?, id_card_hash = ?, phone_mask = ?, phone_hash = ?, "
                        + "verification_level = ?, version = version + 1, updated_at = ? "
                        + "WHERE patient_ref = ? AND owner_user_id = ? AND version = ?",
                displayName, emptyToNull(birthDate), emptyToNull(sex), emptyToNull(idLast4),
                emptyToNull(idCardHash), emptyToNull(phoneMask), emptyToNull(phoneHash),
                verificationLevel, Timestamp.from(Instant.now()), patientRef, userId, expectedVersion);
        return updated == 1;
    }

    /** 归档：幂等（已 ARCHIVED 再归档不涨版本）。 */
    public void archive(String userId, String patientRef) {
        jdbc.update("UPDATE patient_index SET status = 'ARCHIVED', version = version + 1, updated_at = ? "
                        + "WHERE patient_ref = ? AND owner_user_id = ? AND status <> 'ARCHIVED'",
                Timestamp.from(Instant.now()), patientRef, userId);
    }

    /** 映射投影（可能不存在：尚未与 HIS 建关联）。 */
    public Optional<MappingRow> findMapping(String patientRef) {
        var rows = jdbc.query("SELECT status, match_tier, decided_at, updated_at FROM his_patient_map "
                + "WHERE platform_id = ? ORDER BY id DESC", PatientIndexRepository::mapMapping, patientRef);
        return rows.stream().findFirst();
    }

    /**
     * 未终态预约占用数（归档前置校验）。
     * V41 起 appointments 有 patient_ref；该列未迁移的库会抛异常，由调用方按「不阻塞」处理。
     */
    public List<String> listBlockingAppointments(String patientRef) {
        return jdbc.query("SELECT id FROM appointments WHERE patient_ref = ? "
                        + "AND status IN ('PENDING','CONFIRMED','CHECKED_IN') ORDER BY created_at DESC LIMIT 5",
                (rs, i) -> rs.getString(1), patientRef);
    }

    /**
     * 事实源侧的关联证据：该就诊人的预约里是否已带 his_patient_id（V41）。
     *
     * <p>用于 F3（投影写失败）场景把 linkState 报成 {@code LINKED_PROJECTION_PENDING} ——
     * 事实源已连、投影待补，读取不依赖投影，所以不能显示成「未关联」。</p>
     */
    public boolean hasLinkedAppointment(String patientRef) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointments WHERE patient_ref = ? AND his_patient_id IS NOT NULL",
                Integer.class, patientRef);
        return count != null && count > 0;
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
