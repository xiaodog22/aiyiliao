package com.wechar.biz.common;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class RequestIdsTest {

    @Test
    void normalize_回显合法客户端ID() {
        assertThat(RequestIds.normalize("12345678-abcd")).isEqualTo("12345678-abcd");
    }

    @Test
    void normalize_过短则生成新ID() {
        assertThat(RequestIds.normalize("123")).hasSize(36); // UUID
    }

    @Test
    void normalize_为空则生成新ID() {
        assertThat(RequestIds.normalize(null)).hasSize(36);
        assertThat(RequestIds.normalize("  ")).hasSize(36);
    }
}
