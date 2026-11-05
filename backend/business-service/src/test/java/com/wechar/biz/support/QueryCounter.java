package com.wechar.biz.support;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;

/**
 * SQL 语句计数器（PERF-09 回归防线，2026-11-01）。
 *
 * 用途：在集成测试里**断言一次请求的 SQL 次数**，把 N+1 这类"功能正确但查询爆炸"的缺陷
 * 钉死在测试层，而不是等压测采样才发现（PERF-09 就是这么被发现的：1VU 无排队 P50 55ms，
 * 而同组端点只有 6.6~12.9ms）。
 *
 * 实现取舍——为什么用 JDK 动态代理而不是引库：
 *  - QuickPerf / datasource-proxy 都要加依赖，而本项目 Maven 走 `-o` 离线模式，加依赖有失败风险；
 *  - 计数点极少（{@code prepareStatement*} / {@code createStatement*}），代理 60 行足够；
 *  - 只包测试用的 DataSource，生产代码零侵入、零依赖。
 *
 * 计的是"语句创建次数"不是"执行次数"：JdbcTemplate 每次查询都新建 PreparedStatement 并立即执行，
 * 两者一一对应；只有显式复用 PreparedStatement 做批处理时才会偏差（本项目无此用法）。
 */
public final class QueryCounter {

    private final AtomicInteger statements = new AtomicInteger();

    /** 归零，通常在发起被测调用前调用。 */
    public void reset() {
        statements.set(0);
    }

    /** 自上次 reset 以来创建的 JDBC 语句数。 */
    public int count() {
        return statements.get();
    }

    void increment() {
        statements.incrementAndGet();
    }

    /** 用计数代理包装真实 DataSource；重复包装会抛错，避免叠加计数。 */
    public DataSource wrap(DataSource delegate) {
        if (delegate == null) {
            throw new IllegalArgumentException("delegate DataSource 不能为空");
        }
        if (Proxy.isProxyClass(delegate.getClass())) {
            throw new IllegalStateException("DataSource 已被代理，禁止重复包装（会导致计数翻倍）");
        }
        return (DataSource) Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[] {DataSource.class},
                new CountingHandler(delegate, this)
        );
    }

    /** DataSource 代理：只拦 getConnection，其余（含 close / unwrap / toString）原样转发。 */
    private record CountingHandler(Object delegate, QueryCounter counter) implements InvocationHandler {

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            Object result = forward(delegate, method, args);
            if (result instanceof Connection conn) {
                return wrapConnection(conn, counter);
            }
            return result;
        }
    }

    /** Connection 代理：拦所有 prepareStatement / createStatement 重载，创建即计数。 */
    private static Connection wrapConnection(Connection delegate, QueryCounter counter) {
        return (Connection) Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                (proxy, method, args) -> {
                    String name = method.getName();
                    if (name.startsWith("prepareStatement") || name.startsWith("createStatement")) {
                        counter.increment();
                    }
                    return forward(delegate, method, args);
                }
        );
    }

    /** 统一转发；把反射异常还原成原样抛出，避免上层拿到 InvocationTargetException。 */
    private static Object forward(Object target, Method method, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException e) {
            throw e.getCause() == null ? e : e.getCause();
        } catch (IllegalAccessException e) {
            throw new SQLException("代理转发失败：" + method.getName(), e);
        }
    }
}
