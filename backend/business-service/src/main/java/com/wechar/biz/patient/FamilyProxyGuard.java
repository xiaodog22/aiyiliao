package com.wechar.biz.patient;

import com.wechar.biz.common.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 家庭成员代操作授权闸门（契约红线：带 familyMemberId 的读写必须 proxyStatus=GRANTED）。
 *
 * 为什么单独抽成一个组件（2026-11-12 缺陷 DEF-01 / BUG-01）：
 * 这条红线此前只写在 {@link PatientService} 的**档案**路径里；挂号的
 * {@code AppointmentService} 直接把 familyMemberId 落库，全程没有授权查询 ——
 * 于是「添加家人（proxyStatus 恒 NONE）」就能替对方挂号、占用真实号源。
 * 抽出唯一入口后，任何吃 familyMemberId 的写路径都必须经过这里，
 * 避免「新加一条链路就漏一次授权」的同类问题再发生。
 *
 * 语义与档案路径完全一致：非 GRANTED 一律 **404 FAMILY_MEMBER_NOT_FOUND**
 * （不区分「不存在」与「无授权」，避免被枚举出家庭成员 id 是否有效）。
 */
@Component
public class FamilyProxyGuard {

    private final FamilyRepository family;

    public FamilyProxyGuard(FamilyRepository family) {
        this.family = family;
    }

    /**
     * 校验当前用户对目标家庭成员的代理授权。
     *
     * @param userId         当前登录用户
     * @param familyMemberId 目标成员；null/空串 = 本人，直接放行
     */
    public void requireGranted(String userId, String familyMemberId) {
        if (familyMemberId == null || familyMemberId.isBlank()) {
            return; // 本人
        }
        family.findMemberByStatus(userId, familyMemberId, "GRANTED")
                .orElseThrow(() -> new ApiException("FAMILY_MEMBER_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "家庭成员不存在或未获得代理授权（添加不等于授权）"));
    }
}
