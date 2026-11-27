package com.wechar.biz.common;

/**
 * 身份证号校验（GB 11643-1999）：18 位、前 17 位数字、末位校验码（可为 X）。
 *
 * <p>为什么单独抽出来：这条校验同时被「实名绑定」（UserService.bindIdentity）与
 * 「就诊人建档」（PatientIndexService）使用，而它的失败语义必须一致 ——
 * 不通过就**不能**产生任何证件哈希，否则「4 个字符」也能变成看似完整的身份
 * （2026-11-27 实测：HIS 种子档案 P000099 的证件号就是字符串 {@code 0520}，
 * 其 id_hash 恰好等于姓名哈希，污染了跨端 T1 匹配）。</p>
 */
public final class IdCards {

    private static final int[] WEIGHTS = {7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2};
    private static final String CHECK_CODES = "10X98765432";

    private IdCards() {
    }

    /** 18 位大陆居民身份证校验（大小写不敏感，末位 x 视同 X）。 */
    public static boolean isValid(String id) {
        if (id == null) {
            return false;
        }
        String v = id.trim().toUpperCase(java.util.Locale.ROOT);
        if (v.length() != 18) {
            return false;
        }
        int sum = 0;
        for (int i = 0; i < 17; i++) {
            char c = v.charAt(i);
            if (c < '0' || c > '9') {
                return false;
            }
            sum += (c - '0') * WEIGHTS[i];
        }
        return CHECK_CODES.charAt(sum % 11) == v.charAt(17);
    }

    /** 尾 4 位（不足 4 位返回空串）—— 只用于展示与人工核对，不构成身份凭证。 */
    public static String last4(String id) {
        String v = id == null ? "" : id.trim();
        return v.length() >= 4 ? v.substring(v.length() - 4) : "";
    }

    /**
     * 展示用掩码：星号 + 尾 4 位。
     * 前 6 位省市区码**从未落库**，所以这里不能拼出「4401**********3621」那种半真实掩码。
     */
    public static String mask(String last4) {
        if (last4 == null || last4.isBlank()) {
            return "";
        }
        return "************" + last4;
    }
}
