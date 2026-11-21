package com.wechar.biz.appointment.his;

import java.math.BigDecimal;
import java.util.List;

/**
 * HIS 客户端契约（REQ-14 受限接入，V1.20；P0-1 演示支付扩展，2026-11-20）。
 *
 * <p>边界（红线，见 REQUIREMENTS_BASELINE_V1.20.md REQ-14 / PRODUCTION_GATE.md SC-06）：
 * <ul>
 *   <li>本接口只描述「申请受理 + 撤销受理」两个预约动作，以及 P0-1 的「演示账单」三动作；
 *       号源仍由本地 doctor_slots 管理，HIS 只做受理回执（业务单号）。</li>
 *   <li>实现方不得在 V1.20 内接入真实医院凭据；默认实现为 {@link MockHisClient}。</li>
 *   <li>返回值必须显式标明来源（LOCAL_DEMO / HIS_MOCK / HIS_LIVE），页面据此标注「演示预约」，
 *       禁止把模拟受理显示成真实挂号成功。</li>
 *   <li>演示账单只用于 P0-1 支付闭环演示：金额由平台按号源费下发，HIS 侧严格比对；
 *       不接微信支付、不是真实收费凭证。</li>
 * </ul>
 */
public interface HisClient {

    /**
     * 申请 HIS 受理。
     *
     * @throws RuntimeException 任何外部不可用/超时；调用方（HisGateway）必须转成
     *                          503 HIS_UNAVAILABLE，且不得落本地预约单。
     */
    HisBookingResult book(HisBookingCommand command);

    /**
     * 撤销受理（补偿动作）。本地落单失败时尽力释放已受理的 HIS 单，避免「院内有单、平台无单」。
     * 实现必须幂等：单号不存在/已撤销时按成功处理。
     */
    void cancel(String hisOrderNo, String reason);

    /**
     * 创建演示账单（P0-1）。同一 {@code appId + refType + refId} 必须幂等：
     * 重复调用返回同一 chargeNo，{@code replayed=true}。
     */
    HisChargeResult createDemoCharge(HisChargeCommand command);

    /** 查询演示账单状态；单号不存在抛 RuntimeException。 */
    HisChargeResult queryDemoCharge(String chargeNo);

    /**
     * 标记演示账单已支付（P0-1）。金额由平台按号源费下发，HIS 严格比对；
     * 已支付重复调用按幂等成功返回（{@code replayed=true}）。
     */
    HisChargeResult payDemoCharge(String chargeNo, BigDecimal amount, String idempotencyKey);

    /** 检查项目（P0-2）。只读；演示态由返回数据自带的 demo 标识表达。 */
    List<HisExamItem> listExamItems();

    /** 某检查项目的可预约时段（P0-2）；itemCode 不存在时抛 RuntimeException。 */
    List<HisExamSlot> listExamSlots(String itemCode);

    /**
     * 建检查预约（P0-2）。同一 {@code appId + idemKey} 或同一 {@code requestNo} 幂等；
     * 同一 {@code itemCode + slotKey} 已有 BOOKED 时抛业务冲突（消息含 SLOT_TAKEN）。
     */
    HisExamBookingResult bookExam(HisExamBookingCommand command);

    /** 查询检查预约（P0-2）；单号不存在抛 RuntimeException。 */
    HisExamBookingResult getExam(String examOrderNo);

    /** 取消检查预约（P0-2），必须幂等：已取消/不存在按成功处理。 */
    void cancelExam(String examOrderNo, String reason);

    /** 受理请求：只带业务必需字段，不含任何健康敏感信息（主诉不传给 HIS）。 */
    record HisBookingCommand(String appointmentId, String slotId, String patientName,
                             String doctorId, String departmentId) {
    }

    /**
     * 受理结果。
     *
     * @param hisOrderNo HIS 业务单号；LOCAL_DEMO 时为 null（本地演示从未对接）
     * @param source     预约来源：LOCAL_DEMO（开关关闭）/ HIS_MOCK（模拟受理）/ HIS_LIVE（真实受理）
     * @param mock       是否模拟受理；true 时页面必须显示「演示预约」
     */
    record HisBookingResult(String hisOrderNo, String source, boolean mock) {

        /** 开关关闭：不触达任何外部系统，按本地演示预约落库。 */
        public static HisBookingResult localDemo() {
            return new HisBookingResult(null, "LOCAL_DEMO", true);
        }
    }

    /**
     * 演示账单创建请求。
     *
     * @param refType/refId 业务引用（平台用 APPOINTMENT + 预约 ID），HIS 侧据此做幂等
     * @param idempotencyKey 平台幂等键（8~128），透传给 HIS
     */
    record HisChargeCommand(String patientName, BigDecimal amount, String description,
                            String refType, String refId, String idempotencyKey) {
    }

    /**
     * 演示账单结果。
     *
     * @param status   UNPAID / PAID（HIS 演示账单状态）
     * @param replayed 本次调用是否命中幂等回放
     * @param mock     是否由 MockHisClient 生成（页面仍标注「演示」）
     */
    record HisChargeResult(String chargeNo, BigDecimal amount, String status,
                           boolean replayed, boolean mock) {
    }

    /** 检查项目（P0-2）。 */
    record HisExamItem(String itemCode, String itemName, String category, BigDecimal price) {
    }

    /** 检查时段（P0-2）；available=false 表示已被占用。 */
    record HisExamSlot(String slotKey, String slotDate, String slotTime, boolean available) {
    }

    /**
     * 检查预约请求。
     *
     * @param requestNo 平台检查申请号（EXR…），HIS 侧按 appId+requestNo 幂等
     * @param idempotencyKey 平台幂等键，透传给 HIS
     */
    record HisExamBookingCommand(String requestNo, String itemCode, String slotKey,
                                 String patientName, String idempotencyKey) {
    }

    /** 检查预约结果；source 恒为 DEMO（演示排期，不冒充实院号源）。 */
    record HisExamBookingResult(String examOrderNo, String requestNo, String itemCode,
                                String itemName, BigDecimal price, String slotKey,
                                String slotDate, String slotTime, String status,
                                boolean replayed) {
    }
}
