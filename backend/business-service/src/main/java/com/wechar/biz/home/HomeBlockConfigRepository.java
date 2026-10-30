package com.wechar.biz.home;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * home_block_config 数据访问（V7）：首页区块条目由运营配置，前端不再维护第二套真源。
 * 只读；enabled=0 的条目不参与下发（下线靠配置，不发版）。
 */
@Component
public class HomeBlockConfigRepository {

    private final JdbcTemplate jdbc;

    public HomeBlockConfigRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record ItemRow(String itemCode, String label, String iconKey) {
    }

    /** 按 sort_order 升序返回启用条目；表为空时调用方回退内置默认（启动期容错）。 */
    public List<ItemRow> listEnabled(String blockKind) {
        return jdbc.query("SELECT item_code, label, icon_key FROM home_block_config "
                        + "WHERE block_kind = ? AND enabled = 1 ORDER BY sort_order, item_code",
                (rs, i) -> new ItemRow(rs.getString("item_code"), rs.getString("label"),
                        rs.getString("icon_key")),
                blockKind);
    }
}
