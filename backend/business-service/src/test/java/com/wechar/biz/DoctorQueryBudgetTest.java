package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;

import com.wechar.biz.catalog.CatalogService;
import com.wechar.biz.catalog.dto.DoctorData;
import com.wechar.biz.support.QueryCounter;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 医生列表查询预算守卫（PERF-09 回归防线，2026-11-01）。
 *
 * **为什么要有这条测试**：2026-11-01 性能测试发现 {@code GET /api/v1/doctors} 在 1 VU 无排队下
 * P50 就 55ms，是同组其它端点（6.6~12.9ms）的 4.6 倍。根因是 N+1：
 * {@code CatalogService.toDoctorData()} 在 stream 里**逐行**调用 {@code hasAvailableSlot()}
 * 和 {@code slotStatus()}，20 个医生 → 1 主查询 + 40 子查询 = **41 SQL/请求**，
 * 把全局 SQL 成本推到 20.7 次/请求（正常只读端点应 1~3 次）。
 *
 * 这个缺陷**功能完全正确**——所有断言、契约测试、响应结构都对，只有查询次数不对。
 * 所以单元测试、契约测试、E2E 都拦不住它，只有"查了几次 SQL"这个维度能拦。
 *
 * **断言什么**：不锁死具体数值，而是锁"查询次数与医生数**无关**"——
 * 医生从 2 个加到 8 个，SQL 次数必须不变。这条断言在 N+1 存在时必红，修好后必绿，
 * 且不会因为以后 seed 数据变动而误报。
 *
 * 计数实现见 {@link QueryCounter}（JDK 动态代理，零第三方依赖）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:mquerybudget;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@Import(DoctorQueryBudgetTest.CountingConfig.class)
class DoctorQueryBudgetTest {

    /**
     * 医生列表的 SQL 预算 = **3 次**，构成为「1 主 + 1 批次 + 1 余量」：
     * <ul>
     *   <li><b>1 主</b>：{@code SELECT ... FROM doctors d, departments dep WHERE ...} 取医生行；</li>
     *   <li><b>1 批次</b>：{@code slotSummaries()} 一次 {@code GROUP BY doctor_id} 同时算
     *       "是否有号"和"今日剩余"，替代原来的 2×N 次子查询；</li>
     *   <li><b>1 余量</b>：留给后续必要扩展（例如加医院名联查、加软删过滤），
     *       <b>不是</b>允许再加一次 N+1 的额度。</li>
     * </ul>
     * ⚠️ 这个数字是**架构约束**，与 API 契约同级：改动它等于改动"这个端点允许几次往返"。
     * 调高前必须先证明新增查询与医生数无关（否则就是把 N+1 重新引进来）。
     * ⚠️ 0 医生时预算是 **1**（主查询返回空 → {@code slotSummaries} 短路不发 SQL）。
     */
    private static final int DOCTORS_SQL_BUDGET = 3;

    /** 0 医生预算：只有主查询，批量聚合必须短路。 */
    private static final int DOCTORS_SQL_BUDGET_EMPTY = 1;

    @Autowired
    private CatalogService catalogService;

    @Autowired
    private QueryCounter counter;

    @Autowired
    private JdbcTemplate jdbc;

    @BeforeEach
    void cleanExtraDoctors() {
        // 本类会插入临时医生，先清掉，保证每个用例从 seed 的 2 个医生开始
        jdbc.update("DELETE FROM doctor_slots WHERE doctor_id LIKE 'doc-budget-%'");
        jdbc.update("DELETE FROM doctors WHERE id LIKE 'doc-budget-%'");
    }

    @Test
    @DisplayName("医生列表：一次请求的 SQL 次数不随医生数量增长（N+1 守卫）")
    void doctors_query_count_is_independent_of_doctor_count() {
        // 基线：seed 里只有 2 个 ACTIVE 医生
        List<DoctorData> baseline = measureDoctors();
        int baselineSql = counter.count();

        // 加到 8 个医生（6 个临时 + 原来 2 个），每个都挂一条今日号源
        insertDoctorsWithTodaySlots(6);
        List<DoctorData> expanded = measureDoctors();
        int expandedSql = counter.count();

        assertThat(expanded).as("临时医生必须真的被查出来（否则下面的断言无意义）")
                .hasSizeGreaterThanOrEqualTo(baseline.size() + 6);
        assertThat(expandedSql)
                .as("医生从 %d 个增到 %d 个，SQL 次数不得增长（当前 %d → %d）",
                        baseline.size(), expanded.size(), baselineSql, expandedSql)
                .isEqualTo(baselineSql);
        assertThat(expandedSql)
                .as("医生列表 SQL 预算 %d 次；超出说明又引入 N+1", DOCTORS_SQL_BUDGET)
                .isLessThanOrEqualTo(DOCTORS_SQL_BUDGET);
    }

    @Test
    @DisplayName("医生列表：号源三态（FULL/FEW/OPEN）在批量查询下仍然正确")
    void doctors_slot_status_still_correct_after_batch_query() {
        String dept = jdbc.queryForObject(
                "SELECT department_id FROM doctors WHERE id = 'doc-gastro-1'", String.class);
        // OPEN：今日剩余 5；FEW：今日剩余 2（≤ 阈值 3）；FULL：今日剩余 0
        insertDoctor("doc-budget-open", dept, 5);
        insertDoctor("doc-budget-few", dept, 2);
        insertDoctor("doc-budget-full", dept, 0);

        List<DoctorData> doctors = measureDoctors();

        assertThat(statusOf(doctors, "doc-budget-open")).as("今日剩余 5 → OPEN").isEqualTo("OPEN");
        assertThat(statusOf(doctors, "doc-budget-few")).as("今日剩余 2 ≤ 阈值 3 → FEW").isEqualTo("FEW");
        assertThat(statusOf(doctors, "doc-budget-full")).as("今日剩余 0 → FULL").isEqualTo("FULL");
        assertThat(counter.count())
                .as("三态判定不得为每个医生单独发查询")
                .isLessThanOrEqualTo(DOCTORS_SQL_BUDGET);
    }

    @Test
    @DisplayName("医生列表：0 医生时批量聚合必须短路，不得发 IN () 空查询")
    void doctors_empty_list_skips_batch_query() {
        // 把 seed 的医生全部置为 INACTIVE，构造"空列表"场景。
        // ⚠️ 必须在 finally 里**按原 id 精确恢复**，不能写 `UPDATE ... WHERE status='INACTIVE'`——
        //    那会把 seed 里本来就非 ACTIVE 的医生一并激活，污染后续用例。
        List<String> activeIds = jdbc.queryForList(
                "SELECT id FROM doctors WHERE status = 'ACTIVE'", String.class);
        try {
            assertThat(activeIds).as("seed 里必须已有 ACTIVE 医生，否则本用例退化为空跑").isNotEmpty();
            int deactivated = jdbc.update("UPDATE doctors SET status = 'INACTIVE' WHERE status = 'ACTIVE'");
            assertThat(deactivated).isEqualTo(activeIds.size());

            counter.reset();
            List<DoctorData> doctors = catalogService.allDoctors(null);
            int sql = counter.count();

            assertThat(doctors).as("停用后不应再查出任何医生").isEmpty();
            assertThat(sql)
                    .as("0 医生时只允许主查询 1 次；多出来的是对空 IN () 的浪费查询（预算 %d）",
                            DOCTORS_SQL_BUDGET_EMPTY)
                    .isLessThanOrEqualTo(DOCTORS_SQL_BUDGET_EMPTY);
        } finally {
            jdbc.batchUpdate("UPDATE doctors SET status = 'ACTIVE' WHERE id = ?",
                    activeIds.stream().map(id -> new Object[] {id}).toList());
        }
    }

    @Test
    @DisplayName("计数器自身：原生 Statement（createStatement）也被计入，不只有 PreparedStatement")
    void query_counter_covers_native_statement_too() {
        // JdbcTemplate.execute(String) 走 StatementCallback → createStatement()，
        // 与 query() 的 prepareStatement() 是两条不同的计数分支。
        // 这条测试把"覆盖 createStatement"从"读代码相信"变成"测试锁定"：
        // 若将来有人只保留 prepareStatement 分支，这里立刻红。
        counter.reset();
        jdbc.execute("SELECT 1");
        assertThat(counter.count()).as("createStatement 路径必须被计数").isGreaterThanOrEqualTo(1);
    }

    @Test
    @DisplayName("对照组：科室列表（无子查询）本身就是 1 次 SQL，证明计数器有效")
    void departments_query_count_is_sane() {
        counter.reset();
        catalogService.departments(null, null);

        assertThat(counter.count())
                .as("科室列表若超过 2 次说明计数器本身有问题，或该端点也引入了 N+1")
                .isBetween(1, 2);
    }

    /** 调一次全局医生列表并返回结果，SQL 次数留在 counter 里由调用方读取。 */
    private List<DoctorData> measureDoctors() {
        counter.reset();
        List<DoctorData> doctors = catalogService.allDoctors(null);
        return doctors;
    }

    private String statusOf(List<DoctorData> doctors, String doctorId) {
        return doctors.stream()
                .filter(d -> doctorId.equals(d.id()))
                .map(DoctorData::slotStatus)
                .findFirst()
                .orElseThrow(() -> new AssertionError("未查到医生 " + doctorId));
    }

    private void insertDoctorsWithTodaySlots(int count) {
        String dept = jdbc.queryForObject(
                "SELECT department_id FROM doctors WHERE id = 'doc-gastro-1'", String.class);
        for (int i = 0; i < count; i++) {
            insertDoctor("doc-budget-" + i, dept, 5);
        }
    }

    /** 插一个医生 + 一条**今日（UTC）**号源，remaining 决定三态。 */
    private void insertDoctor(String id, String departmentId, int remaining) {
        jdbc.update("INSERT INTO doctors (id, department_id, name, title, specialties_json, "
                        + "introduction, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', CURRENT_TIMESTAMP)",
                id, departmentId, "预算测试医生" + id, "主治医师", "[\"测试\"]", "仅测试用");
        // 时间窗口径必须与 CatalogService.slotStatus 一致：Clock.systemUTC() + truncatedTo(DAYS)
        // → 今日 UTC 00:00 起算。⚠️ 不能用 H2 的 CURRENT_DATE（那是 JVM 本地时区 UTC+8，
        // 换算成 UTC 会落到"昨天 16:00"，导致号源不在窗口内、状态被判成 FULL）。
        Instant todayStartUtc = Instant.now().truncatedTo(ChronoUnit.DAYS);
        jdbc.update("INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, "
                        + "fee, currency, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 50.00, 'CNY', 'OPEN', ?)",
                "slot-" + id, id,
                Timestamp.from(todayStartUtc.plus(1, ChronoUnit.HOURS)),
                Timestamp.from(todayStartUtc.plus(2, ChronoUnit.HOURS)),
                Math.max(remaining, 1), remaining,
                Timestamp.from(Instant.now()));
    }

    /**
     * 计数装配：用 BeanPostProcessor 把容器里的 DataSource 换成计数代理。
     * 必须是 static @Bean——BeanPostProcessor 要在普通单例初始化之前注册，非 static 会让整个配置类被提前实例化。
     */
    @TestConfiguration
    static class CountingConfig {

        @Bean
        static QueryCounter queryCounter() {
            return new QueryCounter();
        }

        @Bean
        static BeanPostProcessor queryCountingDataSourcePostProcessor(QueryCounter counter) {
            return new BeanPostProcessor() {
                @Override
                public Object postProcessAfterInitialization(Object bean, String beanName) {
                    if (bean instanceof DataSource dataSource) {
                        return counter.wrap(dataSource);
                    }
                    return bean;
                }
            };
        }
    }
}
