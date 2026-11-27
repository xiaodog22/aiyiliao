package com.wechar.biz.payment;

import com.wechar.biz.appointment.AppointmentRepository;
import com.wechar.biz.appointment.his.HisClient;
import com.wechar.biz.appointment.his.HisClient.HisChargeCommand;
import com.wechar.biz.appointment.his.HisClient.HisChargeResult;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.payment.PaymentOrderRepository.PaymentOrderRow;
import com.wechar.biz.payment.dto.PaymentBillData;
import com.wechar.biz.payment.dto.PaymentConfigData;
import com.wechar.biz.payment.dto.PaymentDemoCallbackRequest;
import com.wechar.biz.payment.dto.PaymentOrderData;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 演示支付服务（P0-1）。
 *
 * <p>边界：
 * <ul>
 *   <li>金额只取号源 {@code doctor_slots.fee}，不信任客户端；预约必须属于当前用户。</li>
 *   <li>建单先让 clinic-his 建演示账单（按 appId+refType+refId 幂等），再落本地订单。</li>
 *   <li>置 PAID 的唯一前提是 HIS 演示账单已 PAID；HIS 失败时只记 last_error，不误置 PAID。</li>
 *   <li>回调验签不通过/金额不一致/来源非法一律拒绝，且不产生状态变更。</li>
 * </ul>
 */
@Service
public class PaymentService {

    private static final Logger log = LoggerFactory.getLogger(PaymentService.class);
    private static final DateTimeFormatter ORDER_TIME =
            DateTimeFormatter.ofPattern("yyyyMMddHHmmss").withZone(ZoneId.of("Asia/Shanghai"));
    private static final String ACTIVE_STATUSES = "PENDING,CONFIRMED,CHECKED_IN";

    private final AppointmentRepository appointmentRepository;
    private final PaymentOrderRepository orderRepository;
    private final PaymentSettings settings;
    private final PaymentDemoSigner signer;
    private final HisClient hisClient;
    private final HisReconcileDiffRepository reconciliation;
    private final Clock clock;
    private final AtomicInteger sequence = new AtomicInteger();

    public PaymentService(AppointmentRepository appointmentRepository,
                          PaymentOrderRepository orderRepository,
                          PaymentSettings settings,
                          PaymentDemoSigner signer,
                          HisClient hisClient,
                          HisReconcileDiffRepository reconciliation,
                          Clock clock) {
        this.appointmentRepository = appointmentRepository;
        this.orderRepository = orderRepository;
        this.settings = settings;
        this.signer = signer;
        this.hisClient = hisClient;
        this.reconciliation = reconciliation;
        this.clock = clock;
    }

    public PaymentConfigData config() {
        return new PaymentConfigData(
                settings.enabled(), settings.mode(), settings.source(),
                "演示支付未开启，请到院窗口缴费",
                "演示支付成功（未真实扣款）");
    }

    @Transactional
    public PaymentOrderData create(String userId, String appointmentId, String idemKey) {
        settings.requireEnabled();

        Optional<PaymentOrderRow> byIdem = orderRepository.findByUserAndIdem(userId, idemKey);
        if (byIdem.isPresent()) {
            PaymentOrderRow row = byIdem.get();
            if (!row.appointmentId().equals(appointmentId)) {
                throw new ApiException("IDEMPOTENCY_CONFLICT", HttpStatus.CONFLICT,
                        "同一幂等键不能用于不同预约");
            }
            return toData(row);
        }

        Optional<PaymentOrderRow> byAppointment = orderRepository.findByAppointment(appointmentId);
        if (byAppointment.isPresent()) {
            PaymentOrderRow row = byAppointment.get();
            if (!row.userId().equals(userId)) {
                throw new ApiException("APPOINTMENT_NOT_PAYABLE", HttpStatus.FORBIDDEN, "无权支付该预约");
            }
            return toData(row);
        }

        AppointmentRepository.AppointmentRow appointment = appointmentRepository.findById(appointmentId)
                .orElseThrow(() -> new ApiException("APPOINTMENT_NOT_FOUND", HttpStatus.NOT_FOUND, "预约不存在"));
        if (!appointment.userId().equals(userId)) {
            throw new ApiException("APPOINTMENT_NOT_PAYABLE", HttpStatus.FORBIDDEN, "无权支付该预约");
        }
        if (appointment.status() == null || !ACTIVE_STATUSES.contains(appointment.status().toUpperCase())) {
            throw new ApiException("APPOINTMENT_NOT_PAYABLE", HttpStatus.CONFLICT, "预约已结束，无需支付");
        }

        AppointmentRepository.SlotRow slot = appointmentRepository.findSlot(appointment.slotId())
                .orElseThrow(() -> new ApiException("SLOT_NOT_FOUND", HttpStatus.CONFLICT, "号源不存在"));
        BigDecimal amount = slot.fee();
        if (amount == null || amount.signum() <= 0) {
            throw new ApiException("PAYMENT_AMOUNT_INVALID", HttpStatus.CONFLICT, "该号源无有效费用，请到院窗口缴费");
        }
        String currency = slot.currency() == null || slot.currency().isBlank() ? "CNY" : slot.currency();

        HisChargeResult his;
        try {
            his = hisClient.createDemoCharge(new HisChargeCommand(
                    safeName(appointment.patientName()), amount, "挂号费（演示）",
                    "APPOINTMENT", appointmentId, "PAYMENT-ORDER-" + appointmentId));
        } catch (RuntimeException e) {
            log.warn("演示账单创建失败 appointment={}：{}", appointmentId, e.getMessage());
            throw new ApiException("PAYMENT_HIS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "HIS 演示账单暂不可用，请稍后重试", true, null);
        }
        if (!"UNPAID".equals(his.status()) && !"PAID".equals(his.status())) {
            throw new ApiException("PAYMENT_HIS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "HIS 演示账单状态异常，请稍后重试", true, null);
        }

        for (int attempt = 0; attempt < 3; attempt++) {
            String orderNo = nextOrderNo();
            try {
                orderRepository.insert(orderNo, userId, appointmentId, his.chargeNo(),
                        amount, currency, his.status(), settings.source(), idemKey);
                return toData(orderRepository.findByOrderNo(orderNo)
                        .orElseThrow(() -> new IllegalStateException("支付订单写入后不可读")));
            } catch (DuplicateKeyException e) {
                Optional<PaymentOrderRow> raced = orderRepository.findByAppointment(appointmentId);
                if (raced.isPresent()) {
                    return toData(raced.get());
                }
                raced = orderRepository.findByChargeNo(his.chargeNo());
                if (raced.isPresent()) {
                    return toData(raced.get());
                }
                // 仅单号撞车时换号重试；连续 3 次仍失败才报冲突
                if (attempt == 2) {
                    throw new ApiException("PAYMENT_ORDER_CONFLICT", HttpStatus.CONFLICT,
                            "支付单号冲突，请稍后重试", true, null);
                }
            }
        }
        throw new ApiException("PAYMENT_ORDER_CONFLICT", HttpStatus.CONFLICT, "支付单号冲突，请稍后重试");
    }

    public PaymentOrderData get(String userId, String orderNo) {
        PaymentOrderRow row = requireOwned(userId, orderNo);
        return toData(row);
    }

    /**
     * 页面「演示支付」动作（显式点击，不调用 wx.requestPayment）。
     * HIS 失败绝不置 PAID；成功后页面文案固定「演示支付成功（未真实扣款）」。
     */
    public PaymentOrderData demoPay(String userId, String orderNo) {
        settings.requireEnabled();
        PaymentOrderRow row = requireOwned(userId, orderNo);
        if ("PAID".equals(row.status())) {
            return toData(row);
        }
        try {
            HisChargeResult his = hisClient.payDemoCharge(row.chargeNo(), row.amount(), "PAY:" + orderNo);
            if (!"PAID".equals(his.status())) {
                throw new IllegalStateException("HIS 演示账单未置 PAID: " + his.status());
            }
        } catch (RuntimeException e) {
            orderRepository.markError(orderNo, e.getMessage());
            log.warn("演示支付失败 order={} charge={}：{}", orderNo, row.chargeNo(), e.getMessage());
            throw new ApiException("PAYMENT_HIS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "支付未完成，请稍后重试；如已扣款请联系窗口", true, null);
        }
        orderRepository.markPaid(orderNo);
        log.info("演示支付完成 order={} charge={} amount={}（未真实扣款）", orderNo, row.chargeNo(), row.amount());
        return toData(orderRepository.findByOrderNo(orderNo)
                .orElseThrow(() -> new IllegalStateException("支付订单更新后不可读")));
    }

    // ------------------------------------------------------------ 费用清单（P2，2026-11-27）

    /** 院内侧费用分类 → 中文（前端只负责展示，不再维护一份映射）。 */
    private static final Map<String, String> CATEGORY_TEXT = Map.of(
            "REGISTRATION", "挂号费", "DRUG", "药品费", "LAB", "检查费");
    private static final Map<String, String> CHARGE_STATUS_TEXT = Map.of(
            "UNPAID", "待缴费", "PAID", "已缴费", "REFUNDED", "已退费", "VOID", "已作废");

    /**
     * 费用清单：按预约归属校验后透传院内侧账单（挂号费 + 诊中处方/检查）。
     *
     * <p>没有 HIS 单号（本地演示预约）返回空清单，不伪造金额。
     */
    public PaymentBillData bill(String userId, String appointmentId) {
        AppointmentRepository.AppointmentRow appt = requireOwnedAppointment(userId, appointmentId);
        if (appt.hisOrderNo() == null || appt.hisOrderNo().isBlank()) {
            return new PaymentBillData(appointmentId, null, List.of(),
                    new PaymentBillData.Summary(BigDecimal.ZERO, BigDecimal.ZERO, 0));
        }
        return toBillData(appointmentId, loadBill(appt.hisOrderNo()));
    }

    /**
     * 缴纳单笔院内侧费用（演示态，不调起微信支付）。
     *
     * <p>前置：费用单必须属于该预约且状态为 UNPAID（以院内侧为准，客户端不可指定金额）；
     * 只有 HIS 把账单置 PAID 才返回成功，否则 503 且不改任何本地状态。
     */
    public PaymentBillData payBillItem(String userId, String appointmentId, String chargeNo) {
        AppointmentRepository.AppointmentRow appt = requireOwnedAppointment(userId, appointmentId);
        if (appt.hisOrderNo() == null || appt.hisOrderNo().isBlank()) {
            throw new ApiException("PAYMENT_HIS_UNAVAILABLE", HttpStatus.CONFLICT,
                    "该预约没有院内费用单（本地演示预约），请到院窗口缴费");
        }
        if (chargeNo == null || chargeNo.isBlank()) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.BAD_REQUEST, "缺少费用单号");
        }
        HisClient.HisBill bill = loadBill(appt.hisOrderNo());
        HisClient.HisChargeItem item = bill.items().stream()
                .filter(i -> chargeNo.equals(i.chargeNo()))
                .findFirst()
                .orElseThrow(() -> new ApiException("CHARGE_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "费用单不存在或不属于该预约"));
        if (!"UNPAID".equals(item.status())) {
            throw new ApiException("CHARGE_STATE_CONFLICT", HttpStatus.CONFLICT,
                    "该费用单当前不可缴费（" + CHARGE_STATUS_TEXT.getOrDefault(item.status(), item.status()) + "）");
        }
        try {
            HisChargeResult his = hisClient.payDemoCharge(item.chargeNo(), item.amount(),
                    "BILLPAY:" + item.chargeNo());
            if (!"PAID".equals(his.status())) {
                throw new IllegalStateException("HIS 未置 PAID: " + his.status());
            }
        } catch (ApiException e) {
            throw e;
        } catch (RuntimeException e) {
            log.warn("费用单缴费失败 appointment={} charge={}：{}", appointmentId, chargeNo, e.getMessage());
            throw new ApiException("PAYMENT_HIS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "缴费未完成，请稍后重试；如已扣款请联系窗口", true, null);
        }
        log.info("费用单缴费完成 appointment={} charge={} amount={}（演示，未真实扣款）",
                appointmentId, chargeNo, item.amount());
        return toBillData(appointmentId, loadBill(appt.hisOrderNo()));
    }

    private AppointmentRepository.AppointmentRow requireOwnedAppointment(String userId, String appointmentId) {
        AppointmentRepository.AppointmentRow appt = appointmentRepository.findById(appointmentId)
                .orElseThrow(() -> new ApiException("APPOINTMENT_NOT_FOUND", HttpStatus.NOT_FOUND, "预约不存在"));
        if (!appt.userId().equals(userId)) {
            throw new ApiException("APPOINTMENT_NOT_PAYABLE", HttpStatus.FORBIDDEN, "无权查看该预约费用");
        }
        return appt;
    }

    private HisClient.HisBill loadBill(String hisOrderNo) {
        try {
            return hisClient.listCharges(hisOrderNo);
        } catch (ApiException e) {
            throw e;
        } catch (RuntimeException e) {
            log.warn("费用清单读取失败 order={}：{}", hisOrderNo, e.getMessage());
            throw new ApiException("PAYMENT_HIS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "费用清单暂不可用，请稍后重试", true, null);
        }
    }

    private static PaymentBillData toBillData(String appointmentId, HisClient.HisBill bill) {
        List<PaymentBillData.Item> items = bill.items().stream()
                .map(i -> new PaymentBillData.Item(
                        i.chargeNo(), i.category(),
                        CATEGORY_TEXT.getOrDefault(i.category(), "其他费用"),
                        i.description(), i.amount(), i.status(),
                        CHARGE_STATUS_TEXT.getOrDefault(i.status(), i.status()), i.paidAt()))
                .toList();
        return new PaymentBillData(appointmentId, bill.hisOrderNo(), items,
                new PaymentBillData.Summary(bill.payable(), bill.paid(), items.size()));
    }

    /**
     * 本地演示回调：先验签，再按订单号幂等入账。     * 重复回调 N 次只允许第一次 markPaid 生效；HIS 失败不置 PAID。
     */
    @Transactional
    public PaymentOrderData demoCallback(PaymentDemoCallbackRequest request,
                                         String timestamp, String nonce, String signature) {
        settings.requireEnabled();
        if (!settings.source().equals(request.source())) {
            throw new ApiException("PAYMENT_SOURCE_INVALID", HttpStatus.BAD_REQUEST, "非法的支付来源");
        }
        signer.verify(request.orderNo(), request.chargeNo(), request.amount(), request.source(),
                timestamp, nonce, signature);

        PaymentOrderRow row = orderRepository.findByOrderNo(request.orderNo())
                .orElseThrow(() -> new ApiException("PAYMENT_ORDER_NOT_FOUND", HttpStatus.NOT_FOUND, "支付订单不存在"));
        if (!row.chargeNo().equals(request.chargeNo())) {
            throw new ApiException("PAYMENT_CHARGE_MISMATCH", HttpStatus.CONFLICT, "账单号不一致");
        }
        if (row.amount().compareTo(request.amount()) != 0) {
            throw new ApiException("PAYMENT_AMOUNT_MISMATCH", HttpStatus.CONFLICT, "支付金额不一致");
        }
        if ("PAID".equals(row.status())) {
            return toData(row);
        }

        try {
            HisChargeResult his = hisClient.payDemoCharge(row.chargeNo(), row.amount(), "PAY-CALLBACK:" + row.orderNo());
            if (!"PAID".equals(his.status())) {
                throw new IllegalStateException("HIS 演示账单未置 PAID: " + his.status());
            }
        } catch (RuntimeException e) {
            orderRepository.markError(row.orderNo(), e.getMessage());
            log.warn("演示回调入账失败 order={} charge={}：{}", row.orderNo(), row.chargeNo(), e.getMessage());
            throw new ApiException("PAYMENT_HIS_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "回调暂未入账，请稍后重试", true, null);
        }

        int updated = orderRepository.markPaid(row.orderNo());
        log.info("演示回调入账 order={} charge={} amount={} updated={}（未真实扣款）",
                row.orderNo(), row.chargeNo(), row.amount(), updated);
        return toData(orderRepository.findByOrderNo(row.orderNo())
                .orElseThrow(() -> new IllegalStateException("支付订单更新后不可读")));
    }

    /**
     * 演示退费（2026-11-21，DEF-20261121-04）。
     *
     * <p>边界：
     * <ul>
     *   <li>只有 PAID 可退；未支付/已关闭返回 409，不猜状态。</li>
     *   <li>幂等：已 REFUNDED 直接返回当前订单，不重复写审计字段。</li>
     *   <li>仅本地状态流转（refund_channel=LOCAL_DEMO）：不调用微信支付、不调 clinic-his
     *       退费（其退费接口未在 openapi 暴露），页面必须标注“演示退费”。</li>
     * </ul>
     */
    @Transactional
    public PaymentOrderData refund(String userId, String orderNo, String reason) {
        settings.requireEnabled();
        PaymentOrderRow row = requireOwned(userId, orderNo);
        if ("REFUNDED".equals(row.status())) {
            return toData(row);
        }
        if (!"PAID".equals(row.status())) {
            throw new ApiException("PAYMENT_NOT_REFUNDABLE", HttpStatus.CONFLICT, "仅已支付订单可退费");
        }
        String safeReason = (reason == null || reason.isBlank()) ? "用户申请退费（演示）" : reason.trim();
        int updated = orderRepository.markRefunded(orderNo, safeReason, "LOCAL_DEMO");
        PaymentOrderRow next = orderRepository.findByOrderNo(orderNo)
                .orElseThrow(() -> new IllegalStateException("支付订单更新后不可读"));
        if (updated == 0 && !"REFUNDED".equals(next.status())) {
            throw new ApiException("PAYMENT_REFUND_CONFLICT", HttpStatus.CONFLICT, "订单状态已变化，请刷新后重试");
        }
        // L5（2026-11-22）：clinic-his 未在 openapi 暴露退费接口，不能假装已联动。
        // 退费成功即落一条 OPEN 待同步台账（同事务：台账写不进则退费回滚），
        // 由 reconcile 把「HIS 仍 PAID」的订单拉回视野并可自动 RESOLVED。
        reconciliation.recordOpen("PAYMENT", orderNo, "REFUNDED", "PENDING_SYNC",
                "演示退费待回写 HIS（clinic-his 未提供退费接口）");
        log.info("演示退费完成 order={} amount={} channel=LOCAL_DEMO，已登记 HIS 待同步台账",
                orderNo, row.amount());
        return toData(next);
    }

    /**
     * 对账（L5，2026-11-22 扩展）：PAID + REFUNDED 都在视野内，差异落台账。
     *
     * <ul>
     *   <li>PAID：要求 HIS 同单号且 PAID、金额一致；</li>
     *   <li>REFUNDED：要求 HIS 已非 PAID（演示退费不调 HIS，若仍 PAID 即“退费未回写”差异）；</li>
     *   <li>查询失败记 UNKNOWN 差异（不掩盖、不误判一致）；</li>
     *   <li>恢复一致时自动把差异置 RESOLVED（台账可闭环）；只告警不自动改账。</li>
     * </ul>
     */
    public int reconcile(Instant since) {
        if (!settings.enabled()) {
            return 0;
        }
        List<PaymentOrderRow> rows = new ArrayList<>(orderRepository.listReconcilableSince(since));
        Set<String> seen = new HashSet<>();
        rows.forEach(row -> seen.add(row.orderNo()));
        // L5 扩展：OPEN 台账里的订单无论是否落在时间窗口内都要回到视野，
        // 否则「退费待同步」开了台账却永远不会被再次检查。
        for (String orderNo : reconciliation.listOpenBizIds("PAYMENT")) {
            if (seen.add(orderNo)) {
                orderRepository.findByOrderNo(orderNo).ifPresent(rows::add);
            }
        }
        int mismatches = 0;
        int resolved = 0;
        for (PaymentOrderRow row : rows) {
            boolean refunded = "REFUNDED".equals(row.status());
            try {
                HisChargeResult his = hisClient.queryDemoCharge(row.chargeNo());
                boolean statusOk = refunded
                        ? !"PAID".equals(his.status())
                        : "PAID".equals(his.status());
                boolean amountOk = his.amount() != null && his.amount().compareTo(row.amount()) == 0;
                if (statusOk && amountOk) {
                    if (reconciliation.resolve("PAYMENT", row.orderNo()) > 0) {
                        resolved++;
                    }
                    continue;
                }
                mismatches++;
                String detail = "local=" + row.status() + "/" + row.amount()
                        + " his=" + his.status() + "/" + his.amount()
                        + (refunded && "PAID".equals(his.status()) ? "；演示退费未回写 HIS" : "");
                reconciliation.recordOpen("PAYMENT", row.orderNo(), row.status(), his.status(), detail);
                log.warn("支付对账不一致 order={} charge={} {}", row.orderNo(), row.chargeNo(), detail);
            } catch (RuntimeException e) {
                mismatches++;
                reconciliation.recordOpen("PAYMENT", row.orderNo(), row.status(), "UNKNOWN",
                        "查询失败: " + e.getMessage());
                log.warn("支付对账查询失败 order={} charge={}：{}", row.orderNo(), row.chargeNo(), e.getMessage());
            }
        }
        log.info("支付对账完成 since={} scanned={} mismatches={} resolved={}",
                since, rows.size(), mismatches, resolved);
        return mismatches;
    }

    private PaymentOrderRow requireOwned(String userId, String orderNo) {
        return orderRepository.findByOrderNo(orderNo)
                .filter(row -> row.userId().equals(userId))
                .orElseThrow(() -> new ApiException("PAYMENT_ORDER_NOT_FOUND", HttpStatus.NOT_FOUND, "支付订单不存在"));
    }

    private PaymentOrderData toData(PaymentOrderRow row) {
        return new PaymentOrderData(row.orderNo(), row.appointmentId(), row.chargeNo(),
                row.amount(), row.currency(), row.status(), row.source(), true, row.createdAt(), row.paidAt(),
                row.refundedAt(), row.refundReason());
    }

    private String nextOrderNo() {
        int seq = Math.floorMod(sequence.incrementAndGet(), 1000);
        return "PAY" + ORDER_TIME.format(Instant.now(clock)) + String.format("%03d", seq);
    }

    private static String safeName(String name) {
        if (name == null || name.isBlank()) {
            return "演示患者";
        }
        return name.length() <= 50 ? name : name.substring(0, 50);
    }
}
