package com.wechar.biz.appointment.his;

import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 平台主数据 ↔ clinic-his 辅助映射（V36）。
 *
 * <p>只返回 {@code status=CONFIRMED} 的映射；{@code CONFLICT} / {@code UNMAPPED} 一律不自动使用，
 * 避免把患者挂到同名不同科或默认医生。查询失败按异常上抛，由调用方失败（fail-closed），
 * 不静默当作已映射。
 */
@Component
public class HisMasterDataRepository {

    private final JdbcTemplate jdbc;

    public HisMasterDataRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** entityType: DEPARTMENT / DOCTOR / SLOT；platformId: dep-* / doc-* / slot-*。 */
    public Optional<String> resolveConfirmed(String entityType, String platformId) {
        if (entityType == null || entityType.isBlank() || platformId == null || platformId.isBlank()) {
            return Optional.empty();
        }
        List<String> rows = jdbc.queryForList(
                "SELECT his_id FROM his_master_data_map "
                        + "WHERE entity_type = ? AND platform_id = ? AND status = 'CONFIRMED' "
                        + "AND his_id IS NOT NULL AND his_id <> ''",
                String.class, entityType, platformId);
        return rows.stream().findFirst().map(String::trim).filter(s -> !s.isEmpty());
    }
}
