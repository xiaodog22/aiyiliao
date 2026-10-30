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
    public static final Duration REFRESH_TTL = Duration.ofDays(7);

    private final JdbcTemplate jdbc;
    private final Clock clock;

    public AuthSessionStore(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    /** 签发新会话：返回 [accessToken, refreshToken] 明文（仅响应体出现）。 */
    public Issued issue(String userId) {
        Instant now = clock.instant();
        String access = "at-" + UUID.randomUUID();
        String refresh = "rt-" + UUID.randomUUID();
        jdbc.update("INSERT INTO auth_sessions (id, user_id, access_token_hash, refresh_token_hash, "
                        + "access_expires_at, refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                "s-" + UUID.randomUUID(), userId, Digests.sha256Hex(access), Digests.sha256Hex(refresh),
                Timestamp.from(now.plusSeconds(ACCESS_TTL_SECONDS)),
                Timestamp.from(now.plus(REFRESH_TTL)), Timestamp.from(now));
        return new Issued(access, refresh);
    }

    /**
     * 刷新轮换：旧 refresh 匹配且可用 → 标记 used 并签发同归属用户的新对；
     * 重放/过期/撤销 → empty（调用方 401）。refresh 端点匿名（契约 security:[]），
     * 归属完全由令牌哈希反查决定，不接受调用方指定用户。
     */
    public Optional<Issued> rotate(String refreshToken) {
        String hash = Digests.sha256Hex(refreshToken);
        Instant now = clock.instant();
        String owner = ownerId(hash);
        if (owner == null) {
            return Optional.empty(); // 未知令牌
        }
        // 原子占用：仅当未使用、未撤销、未过期时成功（0 行 = 无效或重放）
        int taken = jdbc.update("UPDATE auth_sessions SET refresh_used = 1 "
                        + "WHERE refresh_token_hash = ? AND refresh_used = 0 AND revoked = 0 AND refresh_expires_at > ?",
                hash, Timestamp.from(now));
        if (taken != 1) {
            // 已使用过的刷新令牌再次出现 = 重放信号 → 撤销该会话链（契约 refresh 描述）
            jdbc.update("UPDATE auth_sessions SET revoked = 1, revoked_at = ? "
                    + "WHERE refresh_token_hash = ? AND refresh_used = 1 AND revoked = 0",
                    Timestamp.from(now), hash);
            return Optional.empty();
        }
        return Optional.of(issue(owner));
    }

    /** 注销：撤销该 refresh 所属整条链；未知令牌返回 false（幂等语义由调用方包装为 revoked:true）。 */
    public boolean revoke(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return false;
        }
        int updated = jdbc.update("UPDATE auth_sessions SET revoked = 1, revoked_at = ? "
                        + "WHERE refresh_token_hash = ? AND revoked = 0",
                Timestamp.from(clock.instant()), Digests.sha256Hex(refreshToken));
        return updated > 0;
    }

    /**
     * 注销（契约 logout）：按请求携带的 access token 撤销其整条链。
     * 幂等：链已撤销时再次调用同样返回 true（终态不变）；令牌不存在才返回 false。
     */
    public boolean revokeByAccessToken(String accessToken) {
        if (accessToken == null || accessToken.isBlank()) {
            return false;
        }
        String hash = Digests.sha256Hex(accessToken);
        int updated = jdbc.update("UPDATE auth_sessions SET revoked = 1, revoked_at = ? "
                        + "WHERE access_token_hash = ? AND revoked = 0",
                Timestamp.from(clock.instant()), hash);
        if (updated > 0) {
            return true;
        }
        // 已撤销 → 幂等仍 true；不存在 → false（不伪造撤销成功）
        Integer exists = jdbc.queryForObject(
                "SELECT COUNT(*) FROM auth_sessions WHERE access_token_hash = ?", Integer.class, hash);
        return exists != null && exists > 0;
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

    private String ownerId(String refreshHash) {
        var rows = jdbc.query("SELECT user_id FROM auth_sessions WHERE refresh_token_hash = ?",
                (rs, i) -> rs.getString(1), refreshHash);
        return rows.stream().findFirst().orElse(null);
    }

    public record Issued(String accessToken, String refreshToken) {
    }
}
