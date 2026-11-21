package com.wechar.biz.appointment.his;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * HIS 模拟适配器（REQ-14②，V1.20 默认实现）。
 *
 * <p>只生成可追溯的模拟业务单号，不发起任何网络调用、不依赖任何真实凭据。
 * 单号固定以 {@code HIS-MOCK-} 开头，便于日志/审计与真实单号区分——
 * 任何人看到单号就能判断这是演示受理，不构成「已接 HIS」的误导。
 *
 * <p>P0-1 扩展：演示账单也只在进程内保存（重启即丢），chargeNo 固定
 * {@code HIS-MOCK-CHG-} 前缀；不是真实收费凭证，不落任何支付表。
 */
@Component
@ConditionalOnProperty(name = "app.his.mode", havingValue = "mock", matchIfMissing = true)
public class MockHisClient implements HisClient {

    private static final Logger log = LoggerFactory.getLogger(MockHisClient.class);

    /** 进程内自增；仅用于生成可读的模拟单号，不参与任何业务唯一性判定。 */
    private final AtomicLong sequence = new AtomicLong();

    /** 演示账单：refKey（refType:refId）→ 账单；chargeNo → 账单。进程内、线程安全。 */
    private final Map<String, MockCharge> chargesByRef = new ConcurrentHashMap<>();
    private final Map<String, MockCharge> chargesByNo = new ConcurrentHashMap<>();

    /** 检查预约（P0-2）：requestNo→预约、examOrderNo→预约、item|slot→examOrderNo。 */
    private final Map<String, MockExamBooking> examsByRequest = new ConcurrentHashMap<>();
    private final Map<String, MockExamBooking> examsByNo = new ConcurrentHashMap<>();
    private final Map<String, String> examSlotOwner = new ConcurrentHashMap<>();
    private static final List<HisExamItem> EXAM_ITEMS = List.of(
            new HisExamItem("LAB01", "血常规", "检验", new BigDecimal("25.00")),
            new HisExamItem("LAB02", "尿常规", "检验", new BigDecimal("15.00")),
            new HisExamItem("LAB03", "肝功能", "检验", new BigDecimal("60.00")),
            new HisExamItem("LAB04", "空腹血糖", "检验", new BigDecimal("8.00")),
            new HisExamItem("LAB05", "心电图", "检查", new BigDecimal("30.00")),
            new HisExamItem("LAB06", "胸部正位片", "检查", new BigDecimal("80.00")),
            new HisExamItem("LAB07", "血钾", "检验", new BigDecimal("12.00")),
            new HisExamItem("LAB08", "血红蛋白", "检验", new BigDecimal("10.00")),
            new HisExamItem("LAB09", "白细胞计数", "检验", new BigDecimal("10.00")));
    private static final List<String> EXAM_TIMES = List.of("08:30", "09:30", "10:30", "14:00", "15:00");
    private static final DateTimeFormatter SLOT_FORMAT = DateTimeFormatter.ofPattern("yyyyMMdd-HHmm");

    @Override
    public HisBookingResult book(HisBookingCommand command) {
        String orderNo = "HIS-MOCK-" + String.format("%06d", sequence.incrementAndGet());
        // 只记录 ID 级信息，不写患者姓名等敏感字段（医疗日志脱敏口径）
        log.info("HIS mock book appointment={} slot={} orderNo={}",
                command.appointmentId(), command.slotId(), orderNo);
        return new HisBookingResult(orderNo, "HIS_MOCK", true);
    }

    @Override
    public void cancel(String hisOrderNo, String reason) {
        // 模拟侧无外部副作用：只留补偿调用痕迹，供测试断言「失败路径确实做过补偿」
        log.info("HIS mock cancel orderNo={} reason={}", hisOrderNo, reason);
    }

    @Override
    public synchronized HisChargeResult createDemoCharge(HisChargeCommand command) {
        String refKey = command.refType() + ":" + command.refId();
        MockCharge existing = chargesByRef.get(refKey);
        if (existing != null) {
            return existing.result(true);
        }
        String chargeNo = "HIS-MOCK-CHG-" + String.format("%06d", sequence.incrementAndGet());
        MockCharge charge = new MockCharge(chargeNo, command.amount(), "UNPAID");
        chargesByRef.put(refKey, charge);
        chargesByNo.put(chargeNo, charge);
        log.info("HIS mock demo charge created ref={} chargeNo={} amount={}",
                refKey, chargeNo, command.amount());
        return charge.result(false);
    }

    @Override
    public HisChargeResult queryDemoCharge(String chargeNo) {
        MockCharge charge = chargesByNo.get(chargeNo);
        if (charge == null) {
            throw new IllegalArgumentException("HIS mock 演示账单不存在: " + chargeNo);
        }
        return charge.result(false);
    }

    @Override
    public synchronized HisChargeResult payDemoCharge(String chargeNo, BigDecimal amount, String idempotencyKey) {
        MockCharge charge = chargesByNo.get(chargeNo);
        if (charge == null) {
            throw new IllegalArgumentException("HIS mock 演示账单不存在: " + chargeNo);
        }
        if (charge.amount.compareTo(amount) != 0) {
            throw new IllegalArgumentException("HIS mock 金额不一致: 账单=" + charge.amount + " 支付=" + amount);
        }
        if ("PAID".equals(charge.status)) {
            return charge.result(true);
        }
        charge.status = "PAID";
        log.info("HIS mock demo charge paid chargeNo={} amount={} idem={}", chargeNo, amount, idempotencyKey);
        return charge.result(false);
    }

    @Override
    public List<HisExamItem> listExamItems() {
        return EXAM_ITEMS;
    }

    @Override
    public List<HisExamSlot> listExamSlots(String itemCode) {
        requireExamItem(itemCode);
        List<HisExamSlot> slots = new ArrayList<>();
        LocalDate start = LocalDate.now().plusDays(1);
        for (int day = 0; day < 7; day++) {
            LocalDate date = start.plusDays(day);
            String dateText = date.toString();
            for (String time : EXAM_TIMES) {
                String key = date.format(DateTimeFormatter.ofPattern("yyyyMMdd")) + "-" + time.replace(":", "");
                slots.add(new HisExamSlot(key, dateText, time,
                        !examSlotOwner.containsKey(itemCode + "|" + key)));
            }
        }
        return slots;
    }

    @Override
    public synchronized HisExamBookingResult bookExam(HisExamBookingCommand command) {
        MockExamBooking existing = examsByRequest.get(command.requestNo());
        if (existing != null) {
            if (!existing.itemCode.equals(command.itemCode()) || !existing.slotKey.equals(command.slotKey())) {
                throw new IllegalArgumentException("REQUEST_NO_REUSE 检查申请号已用于不同项目/时段");
            }
            return existing.result(true);
        }
        HisExamItem item = requireExamItem(command.itemCode());
        SlotInfo slot = parseSlot(command.slotKey());
        if (slot == null) {
            throw new IllegalArgumentException("SLOT_INVALID 所选时段不在可预约排期内");
        }
        String ownerKey = command.itemCode() + "|" + command.slotKey();
        if (examSlotOwner.containsKey(ownerKey)) {
            throw new IllegalArgumentException("SLOT_TAKEN 该时段已被预约");
        }
        String no = "HIS-MOCK-EXM-" + String.format("%06d", sequence.incrementAndGet());
        MockExamBooking booking = new MockExamBooking(no, command.requestNo(), item.itemCode(),
                item.itemName(), item.price(), command.slotKey(), slot.date, slot.time, "BOOKED");
        examsByRequest.put(command.requestNo(), booking);
        examsByNo.put(no, booking);
        examSlotOwner.put(ownerKey, no);
        log.info("HIS mock exam booked requestNo={} item={} slot={} examOrderNo={}",
                command.requestNo(), command.itemCode(), command.slotKey(), no);
        return booking.result(false);
    }

    @Override
    public HisExamBookingResult getExam(String examOrderNo) {
        MockExamBooking booking = examsByNo.get(examOrderNo);
        if (booking == null) {
            throw new IllegalArgumentException("NOT_FOUND 检查预约不存在");
        }
        return booking.result(false);
    }

    @Override
    public synchronized void cancelExam(String examOrderNo, String reason) {
        MockExamBooking booking = examsByNo.get(examOrderNo);
        if (booking == null || "CANCELLED".equals(booking.status)) {
            return;
        }
        booking.status = "CANCELLED";
        examSlotOwner.remove(booking.itemCode + "|" + booking.slotKey);
        log.info("HIS mock exam cancelled examOrderNo={} reason={}", examOrderNo, reason);
    }

    private HisExamItem requireExamItem(String itemCode) {
        return EXAM_ITEMS.stream().filter(i -> i.itemCode().equals(itemCode)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("NOT_FOUND 检查项目不存在"));
    }

    /** 只接受未来 7 天内的 08:30/09:30/10:30/14:00/15:00。 */
    private SlotInfo parseSlot(String slotKey) {
        try {
            java.time.LocalDateTime parsed = java.time.LocalDateTime.parse(slotKey, SLOT_FORMAT);
            LocalDate start = LocalDate.now().plusDays(1);
            if (parsed.toLocalDate().isBefore(start) || !parsed.toLocalDate().isBefore(start.plusDays(7))) {
                return null;
            }
            String time = parsed.toLocalTime().format(DateTimeFormatter.ofPattern("HH:mm"));
            if (!EXAM_TIMES.contains(time)) {
                return null;
            }
            return new SlotInfo(parsed.toLocalDate().toString(), time);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private record SlotInfo(String date, String time) {
    }

    /** 进程内检查预约；不保存患者姓名。 */
    private static final class MockExamBooking {
        private final String examOrderNo;
        private final String requestNo;
        private final String itemCode;
        private final String itemName;
        private final BigDecimal price;
        private final String slotKey;
        private final String slotDate;
        private final String slotTime;
        private volatile String status;

        private MockExamBooking(String examOrderNo, String requestNo, String itemCode, String itemName,
                                BigDecimal price, String slotKey, String slotDate, String slotTime,
                                String status) {
            this.examOrderNo = examOrderNo;
            this.requestNo = requestNo;
            this.itemCode = itemCode;
            this.itemName = itemName;
            this.price = price;
            this.slotKey = slotKey;
            this.slotDate = slotDate;
            this.slotTime = slotTime;
            this.status = status;
        }

        private HisExamBookingResult result(boolean replayed) {
            return new HisExamBookingResult(examOrderNo, requestNo, itemCode, itemName, price,
                    slotKey, slotDate, slotTime, status, replayed);
        }
    }

    /** 进程内演示账单；只保存单号/金额/状态，不保存患者姓名。 */
    private static final class MockCharge {
        private final String chargeNo;
        private final BigDecimal amount;
        private volatile String status;

        private MockCharge(String chargeNo, BigDecimal amount, String status) {
            this.chargeNo = chargeNo;
            this.amount = amount;
            this.status = status;
        }

        private HisChargeResult result(boolean replayed) {
            return new HisChargeResult(chargeNo, amount, status, replayed, true);
        }
    }
}
