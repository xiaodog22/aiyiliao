package com.wechar.biz.deletion;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 注销冷静期到期账号的物理清除编排（N10 收尾，2026-10-23）。
 *
 * 合规口径（对齐 docs/v4/07 §9.2 与 DeletionService.retainedItemsFor）：
 *  - 30 天冷静期（deletion_effective_at）到期后，**物理删除**全部业务与身份敏感数据，
 *    users 主行匿名化至终态 DELETED —— 敏感数据不再存续，同时保留 deletion_requests /
 *    audit_events 等法定/审计例外；
 *  - **每个账号一个事务**（purgeOne REQUIRES_NEW 由 Task 外部调用触发）：
 *    任一子表删除失败即整体回滚，绝不留下"部分数据已删、部分还挂账"的半删状态；
 *  - 批量上限由调用方控制（Task 单轮限量），防止异常数据一次清不完拖垮调度。
 */
@Service
public class DeletionPurgeService {

    private final DeletionPurgeRepository repository;
    private final Clock clock;

    public DeletionPurgeService(DeletionPurgeRepository repository, Clock clock) {
        this.repository = repository;
        this.clock = clock;
    }

    /** 冷静期到期的用户 id（readOnly；限量由调用方决定）。 */
    @Transactional(readOnly = true)
    public List<String> findDueUserIds(int limit) {
        return repository.findDueUserIds(clock.instant(), limit);
    }

    /**
     * 物理清除单个到期账号（独立事务）：按外键依赖顺序删除全部关联业务表后匿名化 users 主行。
     * 返回是否真正完成匿名化（0 = 该用户已非 DELETION_PENDING，例如并发下已被处理 → 视为已清除）。
     */
    @Transactional
    public boolean purgeOne(String userId) {
        repository.deleteAppointmentStatusEvents(userId);
        repository.deleteAppointments(userId);
        repository.deleteConsultationMessages(userId);
        repository.deleteAiTasks(userId);
        repository.deleteConsultations(userId);
        repository.deleteCarePlanRequests(userId);
        repository.deleteCustomVoices(userId);
        repository.deleteVoicePreferences(userId);
        repository.deleteAsrInputs(userId);
        repository.deleteHealthRecordAttachments(userId);
        repository.deleteHealthRecords(userId);
        repository.deleteFamilyInvitations(userId);
        repository.deleteFamilyMembers(userId);
        repository.deleteMessages(userId);
        repository.deleteUserPreferences(userId);
        repository.deleteConsents(userId);
        repository.deleteUserProfiles(userId);
        repository.deleteUserExtended(userId);
        repository.deleteAuthSessions(userId);
        return repository.anonymizeUser(userId, clock.instant()) == 1;
    }
}
