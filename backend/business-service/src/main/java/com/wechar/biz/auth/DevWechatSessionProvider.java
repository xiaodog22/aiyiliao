package com.wechar.biz.auth;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import com.wechar.biz.common.ApiException;

/**
 * dev 档微信会话适配器：稳定假数据，不触网（README §启动接入契约已声明为开发档）。
 * 约定（供联调）：
 *   - code 含 "dev-user-2" → openid=dev-user-2；其余合法 code → openid=dev-user-1。
 *   - phoneCode 形如 dev-phone-13800001111 → 返回 13800001111；其余返回 null（令牌无效）。
 * 生产（非 dev profile）严禁启用本实现。
 *
 * ⚠️ 2026-10-29 加固：dev 派生 code **不再无条件接受**。dev 档必须同时配置
 *    APP_AUTH_DEV_LOGIN_ENABLED=true 与 APP_AUTH_DEV_LOGIN_KEY，并在请求头带
 *    X-Dev-Login-Key —— 否则 403 DEV_LOGIN_FORBIDDEN（见 {@link DevLoginGuard}）。
 *    背景：隧道暴露时任何人都能用 code=dev-user-1 拿到真实会话。
 *    itest 档不装配闸门（保持既有集成测试语义）。
 *
 * ⚠️ 2026-11-04 再加固：**手输登录的手机号必须落在白名单内**。
 *    背景（用户实测）：手输页 `services/user.js#login` 把任意手机号编成
 *    `dev-user-1-manual-<手机号>` 走契约登录，provider 只认 `dev-user-1` 前缀，
 *    于是"任意手机号 + 任意密码"都能进同一个 dev 会话，并把该用户手机号改写掉。
 *    前端那条注释写的"password 不参与校验"是事实，但它遗漏了"手机号也不校验"。
 *    边界只能落在这里：dev 档没有密码体系（users 表无 password 列），
 *    唯一可判的是"手机号是不是预置演示账号"。白名单由
 *    `app.auth.dev-login-phones`（env `APP_AUTH_DEV_LOGIN_PHONES`）配置，逗号分隔；
 *    **置空 = 拒绝所有手输登录**（fail-closed）。
 *    一键登录（`dev-user-1-wxlogin-<时间戳>`）不含手机号，不受影响，仍可联调。
 *
 * ⚠️ 2026-11-05（V9010 报告演示）：新增 `app.auth.dev-login.identity-map`
 *    （`手机号=openid`，逗号分隔，**仅 dev 档配置**）。命中的手输手机号映射到对应
 *    dev openid，使 V9010 新增的 3 个演示患者能用现有手输登录入口访问自己的报告。
 *    - 映射键自动并入手输白名单；未命中映射的手机号仍走原白名单与原 openid 逻辑，
 *      原 `dev-user-1` / `dev-user-2` 两个基础演示账号的登录信息**零改动**。
 *    - 映射值必须是 V9010 已登记 users.wechat_openid，不是伪造的微信凭证；
 *      仍受 X-Dev-Login-Key 闸门与白名单双重约束，生产档无此配置（空映射）。
 */
@Component
@Profile({"dev", "itest"}) // itest = 单测 H2 档（不连库生产环境，无真实凭证）
public class DevWechatSessionProvider implements WechatSessionProvider {

    /** 手输登录派生 code：dev-user-1-manual-13800138001 → 取末尾手机号做白名单校验。 */
    private static final Pattern MANUAL_PHONE =
            Pattern.compile("^dev-user-\\d+-manual-(1\\d{10})$");

    /**
     * 医生端联调登录 code：dev-doctor-doc-cardio-1 → openid=dev-doc-doc-cardio-1。
     *
     * <p>为什么需要（2026-11-22）：医生端预约/会话范围由 doctors.user_id 决定，
     * 但 dev 档 30 位医生只有 doc-gastro-1 有账号（V9002）。要验证「换一位医生是否也能看到自己的号」，
     * 只能给 30 位医生各配一个手机号白名单 + identity-map（120 行配置，且顺序敏感），
     * 或者在这里开一条确定性入口。选后者：医生 ID 本身就是稳定主键，
     * 直接派生 openid，账号由 V9017 预先建好，登录即可。
     *
     * <p>安全边界（与本类其它 dev 入口一致，不额外放宽）：
     * <ul>
     *   <li>仅 {@code @Profile({"dev","itest"})} 装配，生产档无此实现；</li>
     *   <li>仍受 {@link DevLoginGuard} 的 X-Dev-Login-Key 闸门约束；</li>
     *   <li>只派生 openid，不校验也不改写手机号；无任职关系的账号照样 403（DoctorService 判据不变）。</li>
     * </ul>
     */
    private static final Pattern DOCTOR_CODE =
            Pattern.compile("^dev-doctor-([a-z0-9][a-z0-9-]{0,39})$");

    /** dev 档才有该 bean（itest 为 null → 不设闸门）。 */
    private final ObjectProvider<DevLoginGuard> guard;

    /** 允许手输登录的演示手机号；空集合 = 全部拒绝。 */
    private final Set<String> allowedPhones;

    /** 显式登记的演示患者身份：手机号 → dev openid；空映射 = 完全保持旧行为。 */
    private final Map<String, String> identityByPhone;

    public DevWechatSessionProvider(
            ObjectProvider<DevLoginGuard> guard,
            @Value("${app.auth.dev-login-phones:13800138001,13900139001}") String allowedPhones,
            @Value("${app.auth.dev-login.identity-map:}") String identityMap) {
        this.guard = guard;
        this.allowedPhones = Arrays.stream(String.valueOf(allowedPhones).split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(Collectors.toUnmodifiableSet());
        Map<String, String> parsed = new HashMap<>();
        for (String pair : String.valueOf(identityMap).split(",")) {
            String[] kv = pair.trim().split("=", 2);
            if (kv.length == 2 && kv[0].trim().matches("1\\d{10}") && !kv[1].trim().isBlank()) {
                parsed.put(kv[0].trim(), kv[1].trim());
            }
        }
        this.identityByPhone = Map.copyOf(parsed);
    }

    private void checkGuard(String scene) {
        DevLoginGuard g = guard == null ? null : guard.getIfAvailable();
        if (g != null) g.assertAllowed(scene);
    }

    @Override
    public WechatSessionInfo getSessionByCode(String code) {
        checkGuard("login");
        assertManualPhoneAllowed(code);
        // 医生端：dev-doctor-<doctorId> 直接映射到 V9017 预建的 dev-doc-<doctorId> 账号
        String doctorId = doctorCode(code);
        if (doctorId != null) {
            return new WechatSessionInfo("dev-doc-" + doctorId, "演示医生", "dev-session-key");
        }
        String phone = manualPhone(code);
        String mapped = phone == null ? null : identityByPhone.get(phone);
        if (mapped != null) {
            return new WechatSessionInfo(mapped, "演示用户", "dev-session-key");
        }
        String openid = code != null && code.contains("dev-user-2") ? "dev-user-2" : "dev-user-1";
        String nickname = "dev-user-2".equals(openid) ? "开发用户乙" : "开发用户甲";
        return new WechatSessionInfo(openid, nickname, "dev-session-key");
    }

    /** 取出医生登录 code 里的医生 ID；非该形态返回 null（不抛错，交回原有分支）。 */
    private static String doctorCode(String code) {
        if (code == null) {
            return null;
        }
        Matcher m = DOCTOR_CODE.matcher(code);
        return m.matches() ? m.group(1) : null;
    }

    /** 取出手输派生 code 末尾手机号；非手输 code 返回 null。 */
    private static String manualPhone(String code) {
        if (code == null) {
            return null;
        }
        Matcher m = MANUAL_PHONE.matcher(code);
        return m.matches() ? m.group(1) : null;
    }

    /**
     * 手输登录的手机号白名单校验。
     *
     * 不区分「手机号不存在」与「密码错误」：dev 档没有密码库，任何细化提示都会变成枚举入口。
     * 只对 `-manual-` 派生 code 生效 —— 一键登录 code 不含手机号，不做限制。
     * identity-map 中显式登记的演示手机号视为已登记账号，等价放行。
     */
    private void assertManualPhoneAllowed(String code) {
        String phone = manualPhone(code);
        if (phone == null) {
            return;
        }
        if (!allowedPhones.contains(phone) && !identityByPhone.containsKey(phone)) {
            throw new ApiException("AUTH_FAILED", HttpStatus.UNAUTHORIZED,
                    "手机号或密码不正确（演示环境请使用预置账号）");
        }
    }

    @Override
    public String getPhoneNumberByCode(String phoneCode) {
        if (phoneCode == null || !phoneCode.startsWith("dev-phone-")) {
            return null;
        }
        checkGuard("phone");
        String digits = phoneCode.substring("dev-phone-".length());
        return digits.matches("^1\\d{10}$") ? digits : null;
    }
}
