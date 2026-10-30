package com.wechar.biz.patient;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** family_members / family_invitations 数据访问（V3）。令牌与手机号只存哈希。 */
@Component
public class FamilyRepository {

    private final JdbcTemplate jdbc;

    public FamilyRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record MemberRow(String id, String userId, String displayName, String relation,
                            String proxyStatus, String ageBand, String gender, String avatarUrl,
                            String phoneHash, String phoneMasked, Instant createdAt, Instant updatedAt) {
    }

    public record InvitationRow(String invitationId, String userId, String relation, String channel,
                                String tokenHash, String phoneHash, String status, Instant expiresAt,
                                Instant createdAt) {
    }

    private static MemberRow mapMember(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        return new MemberRow(rs.getString("id"), rs.getString("user_id"), rs.getString("display_name"),
                rs.getString("relation"), rs.getString("proxy_status"), rs.getString("age_band"),
                rs.getString("gender"), rs.getString("avatar_url"), rs.getString("phone_hash"),
                rs.getString("phone_masked"),
                created == null ? null : created.toInstant(), updated == null ? null : updated.toInstant());
    }

    private static InvitationRow mapInvite(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp exp = rs.getTimestamp("expires_at");
        Timestamp created = rs.getTimestamp("created_at");
        return new InvitationRow(rs.getString("invitation_id"), rs.getString("user_id"),
                rs.getString("relation"), rs.getString("channel"), rs.getString("token_hash"),
                rs.getString("phone_hash"), rs.getString("status"),
                exp == null ? null : exp.toInstant(), created == null ? null : created.toInstant());
    }

    private static final String MEMBER_COLS = "id, user_id, display_name, relation, proxy_status, "
            + "age_band, gender, avatar_url, phone_hash, phone_masked, created_at, updated_at";
    private static final String INVITE_COLS = "invitation_id, user_id, relation, channel, token_hash, "
            + "phone_hash, status, expires_at, created_at";

    /** 幂等查询连同请求摘要一并返回（同键异体判定）。 */
    public Optional<String> findByIdempotencyKeyDigest(String userId, String key) {
        var rows = jdbc.query("SELECT request_digest FROM family_members WHERE user_id = ? AND idempotency_key = ?",
                (rs, i) -> rs.getString(1), userId, key);
        return rows.stream().findFirst();
    }

    public List<MemberRow> listMembers(String userId) {
        return jdbc.query("SELECT " + MEMBER_COLS + " FROM family_members WHERE user_id = ? "
                        + "ORDER BY created_at DESC, id DESC",
                FamilyRepository::mapMember, userId);
    }

    public Optional<MemberRow> findMember(String userId, String memberId) {
        return jdbc.query("SELECT " + MEMBER_COLS + " FROM family_members WHERE id = ? AND user_id = ?",
                FamilyRepository::mapMember, memberId, userId).stream().findFirst();
    }

    public Optional<MemberRow> findMemberByStatus(String userId, String memberId, String... proxyStatus) {
        StringBuilder sql = new StringBuilder("SELECT " + MEMBER_COLS
                + " FROM family_members WHERE id = ? AND user_id = ? AND proxy_status IN (");
        java.util.List<Object> args = new java.util.ArrayList<>(List.of(memberId, userId));
        for (int i = 0; i < proxyStatus.length; i++) {
            sql.append(i == 0 ? "?" : ", ?");
            args.add(proxyStatus[i]);
        }
        sql.append(")");
        return jdbc.query(sql.toString(), FamilyRepository::mapMember, args.toArray()).stream().findFirst();
    }

    public Optional<MemberRow> findMemberByIdempotencyKey(String userId, String key) {
        return jdbc.query("SELECT " + MEMBER_COLS + " FROM family_members WHERE user_id = ? AND idempotency_key = ?",
                FamilyRepository::mapMember, userId, key).stream().findFirst();
    }

    /** 添加成员：proxyStatus 恒为 NONE（添加 ≠ 获得代理权限）。 */
    public void insertMember(MemberRow row, String idempotencyKey, String requestDigest) {
        jdbc.update("INSERT INTO family_members (id, user_id, display_name, relation, proxy_status, "
                        + "age_band, gender, avatar_url, phone_hash, phone_masked, idempotency_key, "
                        + "request_digest, created_at) "
                        + "VALUES (?, ?, ?, ?, 'NONE', ?, ?, ?, ?, ?, ?, ?, ?)",
                row.id(), row.userId(), row.displayName(), row.relation(), row.ageBand(), row.gender(),
                row.avatarUrl(), row.phoneHash(), row.phoneMasked(),
                idempotencyKey, requestDigest, Timestamp.from(row.createdAt()));
    }

    public boolean updateMember(String userId, String memberId, String displayName, String relation,
                                String ageBand, String gender, Instant now) {
        return jdbc.update("UPDATE family_members SET display_name = ?, relation = ?, age_band = ?, "
                        + "gender = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                displayName, relation, ageBand, gender, Timestamp.from(now), memberId, userId) == 1;
    }

    public boolean deleteMember(String userId, String memberId) {
        return jdbc.update("DELETE FROM family_members WHERE id = ? AND user_id = ?", memberId, userId) == 1;
    }

    public void insertInvitation(InvitationRow row) {
        jdbc.update("INSERT INTO family_invitations (invitation_id, user_id, relation, channel, "
                        + "token_hash, phone_hash, status, expires_at, created_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)",
                row.invitationId(), row.userId(), row.relation(), row.channel(), row.tokenHash(),
                row.phoneHash(), Timestamp.from(row.expiresAt()), Timestamp.from(row.createdAt()));
    }

    /** 当前用户发出的邀请（GET /family-members/invitations）：只回元数据，token_hash/phone_hash 永不下发。 */
    public List<InvitationRow> listInvitations(String userId, int limit) {
        return jdbc.query("SELECT " + INVITE_COLS + " FROM family_invitations WHERE user_id = ? "
                        + "ORDER BY created_at DESC, invitation_id DESC LIMIT ?",
                FamilyRepository::mapInvite, userId, limit);
    }

    /** 按哈希取邀请（接受方用；明文 token 不落库）。 */
    public Optional<InvitationRow> findInvitationByTokenHash(String tokenHash) {
        return jdbc.query("SELECT " + INVITE_COLS + " FROM family_invitations WHERE token_hash = ?",
                FamilyRepository::mapInvite, tokenHash).stream().findFirst();
    }

    /** 邀请核销：仅 PENDING 且未过期可核销（一次性）。 */
    public boolean consumeInvitation(String invitationId, Instant now) {
        return jdbc.update("UPDATE family_invitations SET status = 'ACCEPTED', used_at = ? "
                        + "WHERE invitation_id = ? AND status = 'PENDING' AND expires_at > ?",
                Timestamp.from(now), invitationId, Timestamp.from(now)) == 1;
    }

    /** 授权生效：将指定成员 proxy_status 置为 GRANTED（仅受邀成功路径调用）。 */
    public boolean grantProxy(String userId, String memberId, Instant now) {
        return jdbc.update("UPDATE family_members SET proxy_status = 'GRANTED', updated_at = ? "
                        + "WHERE id = ? AND user_id = ?", Timestamp.from(now), memberId, userId) == 1;
    }
}
