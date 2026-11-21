package com.wechar.biz.payment;

import com.wechar.biz.common.ApiException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 演示回调签名（P0-1）。只用于本地演示，不接微信支付证书/平台证书。
 *
 * <p>签名串（固定 7 段，缺一不可）：
 * <pre>
 * PAYDEMO
 * {orderNo}
 * {chargeNo}
 * {amount 两位小数}
 * {source}
 * {timestamp 秒}
 * {nonce}
 * </pre>
 * HMAC-SHA256(app.payment.demo-secret)，hex 小写。
 */
@Component
public class PaymentDemoSigner {

    public static final String HEADER_SIGNATURE = "X-Payment-Signature";
    public static final String HEADER_TIMESTAMP = "X-Payment-Timestamp";
    public static final String HEADER_NONCE = "X-Payment-Nonce";

    private static final String ALGORITHM = "HmacSHA256";
    private static final String PREFIX = "PAYDEMO";

    private final PaymentSettings settings;

    public PaymentDemoSigner(PaymentSettings settings) {
        this.settings = settings;
    }

    public String sign(String orderNo, String chargeNo, BigDecimal amount, String source,
                       String timestamp, String nonce) {
        String message = String.join("\n", PREFIX, orderNo, chargeNo, amountText(amount), source, timestamp, nonce);
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(new SecretKeySpec(settings.demoSecret().getBytes(StandardCharsets.UTF_8), ALGORITHM));
            return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("演示支付签名计算失败", e);
        }
    }

    /** 验签失败/过期/格式非法一律 401 或 400，绝不进入状态变更。 */
    public void verify(String orderNo, String chargeNo, BigDecimal amount, String source,
                       String timestamp, String nonce, String signature) {
        if (isBlank(timestamp) || isBlank(nonce) || isBlank(signature)) {
            throw new ApiException("PAYMENT_SIGNATURE_REQUIRED", HttpStatus.UNAUTHORIZED,
                    "演示回调缺少签名头");
        }
        long ts;
        try {
            ts = Long.parseLong(timestamp);
        } catch (NumberFormatException e) {
            throw new ApiException("PAYMENT_SIGNATURE_INVALID", HttpStatus.UNAUTHORIZED, "演示回调时间戳非法");
        }
        if (Math.abs(Instant.now().getEpochSecond() - ts) > settings.callbackTtlSeconds()) {
            throw new ApiException("PAYMENT_SIGNATURE_EXPIRED", HttpStatus.UNAUTHORIZED, "演示回调已过期");
        }
        if (!nonce.matches("[A-Za-z0-9-]{8,64}")) {
            throw new ApiException("PAYMENT_SIGNATURE_INVALID", HttpStatus.UNAUTHORIZED, "演示回调 nonce 非法");
        }
        String expected = sign(orderNo, chargeNo, amount, source, timestamp, nonce);
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                signature.getBytes(StandardCharsets.UTF_8))) {
            throw new ApiException("PAYMENT_SIGNATURE_INVALID", HttpStatus.UNAUTHORIZED, "演示回调签名不匹配");
        }
    }

    public static String amountText(BigDecimal amount) {
        if (amount == null) {
            return "0.00";
        }
        return amount.setScale(2, RoundingMode.HALF_UP).toPlainString();
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
