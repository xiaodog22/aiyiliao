package com.wechar.biz.exam;

import com.wechar.biz.common.ApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 检查预约开关（P0-2）。
 *
 * <p>只有 DEMO 档：排期为演示生成，不接真实医院检查号源。任何非 DEMO 配置启动即失败，
 * 避免把演示排期误当真实可约资源。关闭 {@code app.exam.enabled=false} 时页面只显示提示，
 * 已生成数据保留、不删除。
 */
@Component
public class ExamSettings {

    private static final String DEMO = "DEMO";

    private final boolean enabled;
    private final String mode;
    private final String source;

    public ExamSettings(@Value("${app.exam.enabled:false}") boolean enabled,
                        @Value("${app.exam.mode:DEMO}") String mode,
                        @Value("${app.exam.source:DEMO}") String source) {
        this.enabled = enabled;
        this.mode = mode == null ? "" : mode.trim().toUpperCase();
        this.source = source == null ? "" : source.trim().toUpperCase();
        if (!DEMO.equals(this.mode)) {
            throw new IllegalStateException("app.exam.mode 仅支持 DEMO（演示排期，不接真实检查号源）: " + mode);
        }
        if (!DEMO.equals(this.source) && !"SANDBOX".equals(this.source)) {
            throw new IllegalStateException("app.exam.source 仅支持 DEMO / SANDBOX: " + source);
        }
    }

    public boolean enabled() {
        return enabled;
    }

    public String mode() {
        return mode;
    }

    public String source() {
        return source;
    }

    public void requireEnabled() {
        if (!enabled) {
            throw new ApiException("EXAM_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
                    "检查预约暂未开放，请到院窗口办理", false, null);
        }
    }
}
