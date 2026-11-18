package com.wechar.biz.common;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 认证会话存储（契约 Session / refresh 轮换，V3 auth_sessions）：
 *  - accessToken/refreshToken 明文只出现在响应体；库内仅存 SHA-256（"服务端只保存其哈希"）；
 *  - refresh 一次一换：rotate 即把旧行 refresh_used=1；已使用的令牌再来 = 重放信号 → 撤销链并 401；
 *  - logout = 撤销整条链（revoked=1），重复撤销幂等。
 * M1 占位鉴权（不强制 401）：CurrentUserContext 允许无 token 兜底 dev 用户，
 * 但一旦携带 Bearer access token，本组件即为权威解析（命中失败按旧规则回退 openid 兜底）。
 */
@Component
public class AuthSessionStore {

    public static final int ACCESS_TTL_SECONDS = 7200;   // expiresIn ≥ 60（契约下限）
    /** 审计 M14：refresh TTL 由 7 天降为 24h；被盗 refresh 的离线可用窗口同步缩短。 */
    public static final Duration REFRESH_TTL = Duration.ofHours(24);
    /** 审计 M12：同一账号最多 3 条存活会话链，超出后 /auth/session 返回 409。 */
    public static final int MAX_ACTIVE_SESSIONS = 3;

    private final JdbcTemplate jdbc;
    private final Clock clock;

    public AuthSessionStore(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    /** 签发新会话：返回 [accessToken, refreshToken] 明文（仅响应体出现）。 */
    public Issued issue(String userId) {
        return issue(userId, null);
    }

    /**
     * 签发会话（可选父会话，审计 M12）。
     * parentSessionId 只作拓扑记录，不参与鉴权；access/refresh 仍是一次性随机令牌。
     */
    public Issued issue(String userId, String parentSessionId) {
        Instant now = clock.instant();
        String access = "at-" + UUID.randomUUID();
        String refresh = "rt-" + UUID.randomUUID();
        jdbc.update("INSERT INTO auth_sessions (id, parent_session_id, user_id, access_token_hash, refresh_token_hash, "
                        + "access_expires_at, refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                "s-" + UUID.randomUUID(), parentSessionId, userId, Digests.sha256Hex(access), Digests.sha256Hex(refresh),
                Timestamp.from(now.plusSeconds(ACCESS_TTL_SECONDS)),
                Timestamp.from(now.plus(REFRESH_TTL)), Timestamp.from(now));
        return new Issued(access, refresh);
    }

    /**
     * 当前账号存活会话数（可续期 + 未撤销），供 /auth/session 上限判定。
     *
     * <p>⚠️ 必须带 `refresh_used = 0`（审计 X-02）：轮换后的旧行只标 used、不撤 revoked，
     * 它已经交不出新的 access token 了，但仍满足 `revoked = 0` 且 refresh_expires_at 未到。
     * 按旧口径计数时，单设备每 2h 轮换一次就会稳定 +1，约 4~6h 撞满上限 3 → /auth/session
     * 返回 409，且 logout 只能撤掉当前一行，反而越登越死。</p>
     */
    public int activeSessionCount(String userId) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM auth_sessions WHERE user_id = ? AND revoked = 0 "
                        + "AND refresh_used = 0 AND refresh_expires_at > ?",
                Integer.class, userId, Timestamp.from(clock.instant()));
        return count == null ? 0 : count;
    }

    /** access token → 当前会话行 ID（只用于建立 parent_session_id 拓扑，不用于鉴权）。 */
    public Optional<String> sessionIdByAccessToken(String accessToken) {
        if (accessToken == null || accessToken.isBlank()) {
            return Optional.empty();
        }
        var rows = jdbc.query("SELECT id FROM auth_sessions WHERE access_token_hash = ?",
                (rs, i) -> rs.getString(1), Digests.sha256Hex(accessToken));
        return rows.stream().findFirst();
    }

    /**
     * 刷新轮换：旧 refresh 匹配且可用 → 标记 used 并签发同归属用户的新对；
     * 重放/过期/撤销 → empty（调用方 401）。refresh 端点匿名（契约 security:[]），
     * 归属完全由令牌哈希反查决定，不接受调用方指定用户。
     */
    public Optional<Issued> rotate(String refreshToken) {
        String hash = Digests.sha256Hex(refreshToken);
        Instant now = clock.instant();
        // 审计 X-02：一次查出 (id, user_id) —— 轮换出来的新行必须挂上父会话，
        // 否则链拓扑全是孤儿，"logout 撤销整条链"无从谈起。
        var rows = jdbc.query("SELECT id, user_id FROM auth_sessions WHERE refresh_token_hash = ?",
                (rs, i) -> new String[]{rs.getString(1), rs.getString(2)}, hash);
        if (rows.isEmpty()) {
            return Optional.empty(); // 未知令牌
        }
        String parentId = rows.get(0)[0];
        String owner = rows.get(0)[1];
        // 原子占用：仅当未使用、未撤销、未过期时成功（0 行 = 无效或重放）
        int taken = jdbc.update("UPDATE auth_sessions SET refresh_used = 1 "
                        + "WHERE refresh_token_hash = ? AND refresh_used = 0 AND revoked = 0 AND refresh_expires_at > ?",
                hash, Timestamp.from(now));
        if (taken != 1) {
            // 已使用过的刷新令牌再次出现 = 重放信号 → 撤销该会话链（契约 refresh 描述）
            revokeChain(parentId, now);
            return Optional.empty();
        }
        return Optional.of(issue(owner, parentId));
    }

    /** 注销：撤销该 refresh 所属整条链；未知令牌返回 false（幂等语义由调用方包装为 revoked:true）。 */
    public boolean revoke(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return false;
        }
        String sessionId = sessionIdByRefreshHash(Digests.sha256Hex(refreshToken));
        if (sessionId == null) {
            return false;
        }
        revokeChain(sessionId, clock.instant());
        return true;
    }

    /**
     * 注销（契约 logout）：按请求携带的 access token 撤销其整条链。
     * 幂等：链已撤销时再次调用同样返回 true（终态不变）；令牌不存在才返回 false。
     */
    public boolean revokeByAccessToken(String accessToken) {
        if (accessToken == null || accessToken.isBlank()) {
            return false;
        }
        String sessionId = sessionIdByAccessHash(Digests.sha256Hex(accessToken));
        if (sessionId == null) {
            return false; // 不存在 → 不伪造撤销成功
        }
        // 已撤销 → 幂等仍 true（revokeChain 命中 0 行也返回 true）
        revokeChain(sessionId, clock.instant());
        return true;
    }

    /**
     * 会话哈希是否存在（任意状态）：logout 拦截器据此决定放行——
     * 已撤销的令牌必须仍可再次调用 logout（重复撤销幂等 200）。
     */
    public boolean sessionHashExists(String accessToken) {
        if (accessToken == null || accessToken.isBlank()) {
            return false;
        }
        Integer exists = jdbc.queryForObject(
                "SELECT COUNT(*) FROM auth_sessions WHERE access_token_hash = ?", Integer.class,
                Digests.sha256Hex(accessToken));
        return exists != null && exists > 0;
    }

    /**
     * 会话归属用户（忽略过期/撤销状态）：仅供 logout 幂等路径建立主体。
     * 绝不可用于普通鉴权——普通鉴权一律走 resolveUserByAccessToken。
     */
    public Optional<String> resolveUserAnyState(String accessToken) {
        if (accessToken == null || accessToken.isBlank()) {
            return Optional.empty();
        }
        var rows = jdbc.query("SELECT user_id FROM auth_sessions WHERE access_token_hash = ?",
                (rs, i) -> rs.getString(1), Digests.sha256Hex(accessToken));
        return rows.stream().findFirst();
    }

    /** Bearer access token → userId；不存在/过期/撤销 → empty。 */
    public Optional<String> resolveUserByAccessToken(String accessToken) {
        if (accessToken == null || accessToken.isBlank()) {
            return Optional.empty();
        }
        var rows = jdbc.query("SELECT user_id FROM auth_sessions WHERE access_token_hash = ? "
                        + "AND revoked = 0 AND access_expires_at > ?",
                (rs, i) -> rs.getString(1), Digests.sha256Hex(accessToken), Timestamp.from(clock.instant()));
        return rows.stream().findFirst();
    }

    /**
     * 物理清除已彻底失效的会话行（PERF-06，2026-11-01）。
     *
     * 判据用 **refresh_expires_at**，不是 access_expires_at：access 过期后 refresh 仍可轮换，
     * 提前删会让用户在 7 天内无法续期；反过来说 refresh 过期即整条会话彻底无用，删之无副作用。
     * cutoff 再留 grace 余量（见调用方），避免多实例时钟漂移把边界行误删。
     *
     * 分批删除：limit 控制单批行数，避免一次删数十万行压住 undo log 与主从延迟。
     * 返回本批实删行数，调用方循环到 0 为止。
     *
     * ⚠️ 不加 ORDER BY：目标是"删掉所有过期行"，删哪个先无所谓 —— 排序只会多一次排序开销；
     * 且 **H2 不支持 DELETE ... ORDER BY ... LIMIT**（测试库 MODE=MySQL 也会语法报错），
     * 加了会让生产可跑、测试不可跑，破坏可移植性（2026-11-01 实测踩到）。
     * 依赖 V9004 建在 refresh_expires_at 上的索引做范围扫描。
     */
    public int deleteRefreshExpiredBefore(Instant cutoff, int limit) {
        return jdbc.update("DELETE FROM auth_sessions WHERE refresh_expires_at < ? LIMIT ?",
                Timestamp.from(cutoff), limit);
    }

    /**
     * 撤销整条会话链（自身 + 祖先 + 后代，审计 X-02）。
     *
     * <p>链由 `parent_session_id` 串起：登录是根，refresh 轮换与 /auth/session 派生各自挂上一行。
     * 原实现按"令牌命中行"撤销，只能撤掉一行 —— 轮换后留下的旧 access token 在 logout 之后
     * 仍可用到过期，且旧行堆在配额里让 409 解不开。这里先上溯到根、再 BFS 下溯收全链，
     * 一次 UPDATE 全部置 revoked。</p>
     *
     * <p>步数/节点数都设了上限（64 / 256）：正常链长等于轮换次数，异常数据不应把内存打满，
     * 也不允许 parent 环把线程卡死。</p>
     */
    private void revokeChain(String sessionId, Instant now) {
        if (sessionId == null || sessionId.isBlank()) {
            return;
        }
        String root = sessionId;
        for (int depth = 0; depth < 64; depth++) {
            // ⚠️ parent_session_id 为 NULL 是根的合法形态：必须先滤掉 null 再 findFirst，
            // 否则 Stream.findFirst 会用 Optional.of(null) 抛 NPE（logout 直接 500）。
            String parent = jdbc.query("SELECT parent_session_id FROM auth_sessions WHERE id = ?",
                            (rs, i) -> rs.getString(1), root).stream()
                    .filter(java.util.Objects::nonNull)
                    .findFirst().orElse(null);
            if (parent == null || parent.isBlank() || parent.equals(root)) {
                break;
            }
            root = parent;
        }
        java.util.Set<String> ids = new java.util.LinkedHashSet<>();
        java.util.ArrayDeque<String> queue = new java.util.ArrayDeque<>();
        ids.add(root);
        queue.add(root);
        while (!queue.isEmpty() && ids.size() < 256) {
            String current = queue.poll();
            for (String child : jdbc.query("SELECT id FROM auth_sessions WHERE parent_session_id = ?",
                    (rs, i) -> rs.getString(1), current)) {
                if (ids.add(child)) {
                    queue.add(child);
                }
            }
        }
        Object[] args = new Object[ids.size() + 1];
        args[0] = Timestamp.from(now);
        int idx = 1;
        for (String id : ids) {
            args[idx++] = id;
        }
        jdbc.update("UPDATE auth_sessions SET revoked = 1, revoked_at = ? "
                + "WHERE revoked = 0 AND id IN (" + String.join(",", java.util.Collections.nCopies(ids.size(), "?")) + ")",
                args);
    }

    private String sessionIdByRefreshHash(String refreshHash) {
        return jdbc.query("SELECT id FROM auth_sessions WHERE refresh_token_hash = ?",
                (rs, i) -> rs.getString(1), refreshHash).stream().findFirst().orElse(null);
    }

    private String sessionIdByAccessHash(String accessHash) {
        return jdbc.query("SELECT id FROM auth_sessions WHERE access_token_hash = ?",
                (rs, i) -> rs.getString(1), accessHash).stream().findFirst().orElse(null);
    }

    public record Issued(String accessToken, String refreshToken) {
    }
}
