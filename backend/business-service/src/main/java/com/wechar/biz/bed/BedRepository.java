package com.wechar.biz.bed;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * wards / beds 数据访问（V5 新建表）。
 * 契约 beds："范围限定在登录医生被授权的病区" —— 授权范围由医生的科室 → 病区推导，
 * 因此查询一律带 ward_id 白名单（范围过滤发生在 SQL 条件内，不上移到调用方）。
 */
@Component
public class BedRepository {

    private final JdbcTemplate jdbc;

    public BedRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 床位行（含病区名与最近一次分配操作的幂等键，用于重放判定）。 */
    public record BedRow(String id, String wardId, String wardName, String label, String status,
                         String occupantUserId, String occupantDisplayName, Instant admittedAt, int version,
                         String lastIdempotencyKey, String lastRequestDigest) {
    }

    private static final String BED_SELECT =
            "SELECT b.id, b.ward_id, w.name AS ward_name, b.label, b.status, b.occupant_user_id, "
                    + "b.occupant_display_name, b.admitted_at, b.version, b.last_idempotency_key, "
                    + "b.last_request_digest FROM beds b, wards w WHERE b.ward_id = w.id ";

    private static BedRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp admitted = rs.getTimestamp("admitted_at");
        return new BedRow(rs.getString("id"), rs.getString("ward_id"), rs.getString("ward_name"),
                rs.getString("label"), rs.getString("status"), rs.getString("occupant_user_id"),
                rs.getString("occupant_display_name"), admitted == null ? null : admitted.toInstant(),
                rs.getInt("version"), rs.getString("last_idempotency_key"), rs.getString("last_request_digest"));
    }

    /** 医生授权病区：其科室下所有 ACTIVE 病区。 */
    public List<String> listAuthorizedWardIds(String departmentId) {
        return jdbc.query("SELECT id FROM wards WHERE department_id = ? AND status = 'ACTIVE' ORDER BY id",
                (rs, i) -> rs.getString("id"), departmentId);
    }

    /** 授权范围内的床位列表（wardIds 为空 → 返回空，不越权返回全院）。 */
    public List<BedRow> listBeds(List<String> authorizedWardIds, String wardId, String status) {
        if (authorizedWardIds == null || authorizedWardIds.isEmpty()) {
            return List.of();
        }
        StringBuilder sql = new StringBuilder(BED_SELECT + inClause(authorizedWardIds.size()));
        List<Object> args = new java.util.ArrayList<>(authorizedWardIds);
        if (wardId != null && !wardId.isBlank()) {
            sql.append(" AND b.ward_id = ?");
            args.add(wardId);
        }
        if (status != null && !status.isBlank()) {
            sql.append(" AND b.status = ?");
            args.add(status);
        }
        sql.append(" ORDER BY b.ward_id, b.label");
        return jdbc.query(sql.toString(), BedRepository::map, args.toArray());
    }

    /** 单床位（含病区与病区所属科室，供范围校验）。 */
    public Optional<BedRow> findBed(String bedId) {
        return jdbc.query(BED_SELECT + " AND b.id = ?", BedRepository::map, bedId).stream().findFirst();
    }

    /** 床位所属科室（越权判定：与医生科室不一致 → 按 404 处理，不泄露他人资源）。 */
    public Optional<String> findBedDepartmentId(String bedId) {
        return jdbc.query("SELECT w.department_id FROM beds b, wards w WHERE b.ward_id = w.id AND b.id = ?",
                (rs, i) -> rs.getString("department_id"), bedId).stream().findFirst();
    }

    /** 授权病区内可入床床位数（workbench.summary.availableBeds）。 */
    public int countAvailable(List<String> authorizedWardIds) {
        if (authorizedWardIds == null || authorizedWardIds.isEmpty()) {
            return 0;
        }
        Object[] args = authorizedWardIds.toArray();
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM beds WHERE status = 'AVAILABLE' AND ward_id IN ("
                + placeholders(authorizedWardIds.size()) + ")", Integer.class, args);
        return n == null ? 0 : n;
    }

    /**
     * 乐观锁更新床位分配（version 不匹配 → 返回 false，调用方转 409 VERSION_CONFLICT）。
     * 同时记录本次操作的幂等键、载荷摘要与备注（M3 口径：床位分配以"最近一次操作"判定重放）。
     */
    public boolean updateAssignment(String bedId, int expectedVersion, String status, String occupantUserId,
                                    String occupantDisplayName, Instant admittedAt, String note,
                                    String idempotencyKey, String requestDigest, Instant now) {
        int updated = jdbc.update("UPDATE beds SET status = ?, occupant_user_id = ?, occupant_display_name = ?, "
                        + "admitted_at = ?, last_note = ?, last_idempotency_key = ?, last_request_digest = ?, "
                        + "version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
                status, occupantUserId, occupantDisplayName,
                admittedAt == null ? null : Timestamp.from(admittedAt), note,
                idempotencyKey, requestDigest, Timestamp.from(now), bedId, expectedVersion);
        return updated == 1;
    }

    private static String inClause(int size) {
        return "AND b.ward_id IN (" + placeholders(size) + ") ";
    }

    private static String placeholders(int size) {
        return String.join(", ", java.util.Collections.nCopies(size, "?"));
    }
}
