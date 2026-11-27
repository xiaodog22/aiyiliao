package com.wechar.biz.payment.dto;

import java.math.BigDecimal;
import java.util.List;

/**
 * 费用清单（患者端）。
 *
 * <p>金额与状态一律来自院内侧 {@code charges}，平台只做中文映射与汇总展示，
 * 不重算金额、不猜测状态（2026-11-27）。
 */
public record PaymentBillData(String appointmentId, String hisOrderNo,
                              List<Item> items, Summary summary) {

    /**
     * 单条费用。
     *
     * @param category     REGISTRATION / DRUG / LAB
     * @param categoryText 中文分类（挂号费 / 药品费 / 检查费 / 其他费用）
     * @param status       UNPAID / PAID / REFUNDED / VOID
     * @param statusText   中文状态（待缴费 / 已缴费 / 已退费 / 已作废）
     */
    public record Item(String chargeNo, String category, String categoryText,
                       String description, BigDecimal amount,
                       String status, String statusText, String paidAt) {
    }

    /** payable 只统计 UNPAID，paid 只统计 PAID。 */
    public record Summary(BigDecimal payable, BigDecimal paid, int count) {
    }
}
