package com.wechar.biz.payment;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.payment.dto.PaymentBillData;
import com.wechar.biz.payment.dto.PaymentBillPayRequest;
import com.wechar.biz.payment.dto.PaymentConfigData;
import com.wechar.biz.payment.dto.PaymentCreateRequest;
import com.wechar.biz.payment.dto.PaymentDemoCallbackRequest;
import com.wechar.biz.payment.dto.PaymentOrderData;
import com.wechar.biz.payment.dto.PaymentRefundRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 演示支付控制器（P0-1）。
 *
 * <p>契约路径见 backend/contracts/business-openapi.yaml：
 * <ul>
 *   <li>GET  /api/v1/payment/config（登录）</li>
 *   <li>POST /api/v1/payment/orders（登录 + Idempotency-Key）</li>
 *   <li>GET  /api/v1/payment/orders/{orderNo}（登录）</li>
 *   <li>POST /api/v1/payment/orders/{orderNo}/demo-pay（登录 + Idempotency-Key）</li>
 *   <li>POST /api/v1/payment/demo/callback（匿名 + HMAC 验签，本地演示专用）</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/v1/payment")
public class PaymentController {

    private final PaymentService paymentService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public PaymentController(PaymentService paymentService, AuthService authService,
                             CurrentUserContext currentUserContext) {
        this.paymentService = paymentService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    @GetMapping("/config")
    public Envelope<PaymentConfigData> config() {
        return Envelope.ok(RequestIds.current(), paymentService.config());
    }

    @PostMapping("/orders")
    public ResponseEntity<Envelope<PaymentOrderData>> create(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody PaymentCreateRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                paymentService.create(userId, request.appointmentId(), key)));
    }

    @GetMapping("/orders/{orderNo}")
    public Envelope<PaymentOrderData> get(@PathVariable String orderNo) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return Envelope.ok(RequestIds.current(), paymentService.get(userId, orderNo));
    }

    /**
     * 费用清单（P2，2026-11-27）：该预约在院内的全部费用单（挂号费 + 诊中处方/检查）。
     * 金额与状态以院内侧 charges 为准，平台只做中文映射与汇总。
     */
    @GetMapping("/bill")
    public Envelope<PaymentBillData> bill(
            @org.springframework.web.bind.annotation.RequestParam("appointmentId") String appointmentId) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return Envelope.ok(RequestIds.current(), paymentService.bill(userId, appointmentId));
    }

    /**
     * 缴纳单笔院内侧费用（演示态，不调起微信支付）。
     * 前置：该单属于当前用户的预约且未缴费；HIS 未置 PAID 一律 503。
     */
    /**
     * 缴纳单笔院内侧费用（演示态，不调起微信支付）。
     * 前置：该单属于当前用户的预约且未缴费；HIS 未置 PAID 一律 503。
     * 幂等：`Idempotency-Key` 必填（与其它写接口同口径）；真正的重复保护来自
     * 「只允许 UNPAID 缴」+ HIS `payDemoCharge` 的重放语义，键本身不做去重表。
     */
    @PostMapping("/bill/pay")
    public Envelope<PaymentBillData> payBill(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody PaymentBillPayRequest request) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return Envelope.ok(RequestIds.current(),
                paymentService.payBillItem(userId, request.appointmentId(), request.chargeNo()));
    }

    @PostMapping("/orders/{orderNo}/demo-pay")
    public Envelope<PaymentOrderData> demoPay(
            @PathVariable String orderNo,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return Envelope.ok(RequestIds.current(), paymentService.demoPay(userId, orderNo));
    }

    /** 演示退费（2026-11-21）：仅本地状态流转，不触发真实退款/HIS 退费。 */
    @PostMapping("/orders/{orderNo}/refund")
    public Envelope<PaymentOrderData> refund(
            @PathVariable String orderNo,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody(required = false) PaymentRefundRequest request) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return Envelope.ok(RequestIds.current(),
                paymentService.refund(userId, orderNo, request == null ? null : request.reason()));
    }

    /** 本地演示回调：不走微信支付，签名由 PaymentDemoSigner 用演示密钥校验。 */
    @PostMapping("/demo/callback")
    public Envelope<PaymentOrderData> demoCallback(
            @RequestHeader(value = PaymentDemoSigner.HEADER_SIGNATURE, required = false) String signature,
            @RequestHeader(value = PaymentDemoSigner.HEADER_TIMESTAMP, required = false) String timestamp,
            @RequestHeader(value = PaymentDemoSigner.HEADER_NONCE, required = false) String nonce,
            @Valid @RequestBody PaymentDemoCallbackRequest request) {
        return Envelope.ok(RequestIds.current(),
                paymentService.demoCallback(request, timestamp, nonce, signature));
    }
}
