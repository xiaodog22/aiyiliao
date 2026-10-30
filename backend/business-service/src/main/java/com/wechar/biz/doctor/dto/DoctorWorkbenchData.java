package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * 契约 DoctorWorkbench（OkDoctorWorkbench.data）：
 * required=[summary]；scope 为服务端裁定的只读范围；blocks 为各子块独立降级状态。
 *
 * summary 各计数非契约必填 → 某子块不可用时**省略该计数**（NON_NULL），
 * 不用 0 冒充"确实为零"（红线：不伪造）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DoctorWorkbenchData(Summary summary, Scope scope, List<Block> blocks) {

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Summary(Integer todayAppointments, Integer waitingPatients,
                          Integer availableBeds, Integer pendingReviews) {
    }

    /** 服务端裁定的数据范围（客户端只读展示，不可修改）。 */
    public record Scope(List<String> departmentIds, List<String> wardIds) {
    }

    /** 子块降级状态：name ≤40；status ∈ ok/degraded/unavailable。 */
    public record Block(String name, String status) {

        public static final String OK = "ok";
        public static final String DEGRADED = "degraded";
        public static final String UNAVAILABLE = "unavailable";
    }
}
