package com.wechar.biz.appointment.his;

/**
 * HIS 客户端契约（REQ-14 受限接入，V1.20）。
 *
 * <p>边界（红线，见 REQUIREMENTS_BASELINE_V1.20.md REQ-14 / PRODUCTION_GATE.md SC-06）：
 * <ul>
 *   <li>本接口只描述「申请受理 + 撤销受理」两个动作，不假装能查真实号源——号源仍由本地
 *       doctor_slots 管理，HIS 只做受理回执（业务单号）。</li>
 *   <li>实现方不得在 V1.20 内接入真实医院凭据；默认实现为 {@link MockHisClient}。</li>
 *   <li>返回值必须显式标明来源（LOCAL_DEMO / HIS_MOCK / HIS_LIVE），页面据此标注「演示预约」，
 *       禁止把模拟受理显示成真实挂号成功。</li>
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
}
