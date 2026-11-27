package com.wechar.biz.patient;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.common.PhoneHashing;
import com.wechar.biz.patient.dto.PatientCreateRequest;
import com.wechar.biz.patient.dto.PatientData;
import com.wechar.biz.patient.dto.PatientUpdateRequest;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 就诊人主索引服务单测（契约 §7.2 的 B-01/B-03/B-04/B-05/B-06/B-07/B-09）。
 *
 * <p>为什么用 Mock 而不是 H2：H2 单测档的 Flyway target 不含 V39（见 HealthReportReadyTest 的说明），
 * 真实 SQL 与约束由 MySQL 运行时验收覆盖；这里锁定的是**服务层语义**，尤其是
 * 「校验不通过绝不产生证件哈希」与「归属只认服务端 userId」这两条红线。</p>
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class PatientIndexServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-27T14:00:00Z");
    private static final String USER = "u-dev-user-1";
    private static final String SALT = "his-salt-for-test";
    /** GB 11643 校验位正确的样例号码（440101 1962-05-12 顺序码 052 校验位 0）。 */
    private static final String VALID_ID = "440101196205123620";

    @Mock
    private PatientIndexRepository repository;
    @Mock
    private FamilyRepository familyRepository;
    @Mock
    private PhoneHashing phoneHashing;

    private PatientIndexService service;

    @BeforeEach
    void setUp() {
        service = new PatientIndexService(repository, familyRepository, phoneHashing,
                Clock.fixed(NOW, ZoneOffset.UTC), true, SALT);
        when(phoneHashing.hash(anyString())).thenReturn("phone-hash");
        when(repository.findMapping(anyString())).thenReturn(Optional.empty());
        when(repository.hasLinkedAppointment(anyString())).thenReturn(false);
    }

    private static PatientIndexRepository.PatientRow row(String ref, String name, int version, String status) {
        return new PatientIndexRepository.PatientRow(ref, USER, null, name, "1962-05-12", "男",
                "3620", Digests.sha256Hex(SALT + VALID_ID), "138****8000", "phone-hash",
                "ID_VERIFIED", "USER_INPUT", status, version, NOW, null);
    }

    // ---------------- B-01 ----------------

    @Test
    void 建档_证件校验位不通过_422且不写库() {
        var request = new PatientCreateRequest("张三", null, null, null, "440101196205123621", null);
        ApiException ex = assertThrows(ApiException.class,
                () -> service.create(USER, "idem-0001", request));
        assertEquals("INVALID_ID_CARD", ex.getCode());
        assertEquals(422, ex.getStatus().value());
        verify(repository, never()).insert(any(), anyString(), anyString());
    }

    // ---------------- B-02 ----------------

    @Test
    void 建档_合法证件_哈希与HIS同口径且只存尾号() {
        when(repository.findByName(eq(USER), anyString())).thenReturn(Optional.empty());
        when(repository.findByOwnerAndIdHash(eq(USER), anyString())).thenReturn(Optional.empty());
        when(repository.findIdempotencyDigest(eq(USER), anyString())).thenReturn(Optional.empty());

        var request = new PatientCreateRequest("张三", null, "1962-05-12", "男", VALID_ID, "13800138000");
        service.create(USER, "idem-0002", request);

        ArgumentCaptor<PatientIndexRepository.PatientRow> captor =
                ArgumentCaptor.forClass(PatientIndexRepository.PatientRow.class);
        verify(repository).insert(captor.capture(), eq("idem-0002"), anyString());
        var saved = captor.getValue();
        assertEquals(Digests.sha256Hex(SALT + VALID_ID), saved.idCardHash(),
                "证件哈希必须是 sha256(salt+证件号)，与 HIS 同口径（无盐的值永不相等）");
        assertEquals("3620", saved.idLast4());
        assertEquals("ID_VERIFIED", saved.verificationLevel());
        assertFalse(saved.patientRef().contains(USER), "ref 不得包含 userId（不可推导）");
        assertTrue(saved.patientRef().matches("^pat-[0-9a-f]{32}$"), saved.patientRef());
    }

    // ---------------- B-03 ----------------

    @Test
    void 建档_同用户同姓名_返回既有记录不新建() {
        when(repository.findIdempotencyDigest(eq(USER), anyString())).thenReturn(Optional.empty());
        var existing = row("pat-" + "1".repeat(32), "张三", 3, "ACTIVE");
        when(repository.findByName(eq(USER), eq("张三"))).thenReturn(Optional.of(existing));

        PatientData data = service.create(USER, "idem-0003",
                new PatientCreateRequest("张三", null, null, null, null, null));

        assertFalse(data.created(), "同姓名必须返回既有记录（created=false）");
        assertEquals(existing.patientRef(), data.patientRef());
        assertEquals(3, data.version());
        verify(repository, never()).insert(any(), anyString(), anyString());
    }

    // ---------------- B-04 ----------------

    @Test
    void 建档_家人不属于当前用户_403() {
        when(familyRepository.findMember(USER, "fm-x")).thenReturn(Optional.empty());
        ApiException ex = assertThrows(ApiException.class, () -> service.create(USER, "idem-0004",
                new PatientCreateRequest("李四", "fm-x", null, null, null, null)));
        assertEquals("FAMILY_MEMBER_FORBIDDEN", ex.getCode());
        assertEquals(403, ex.getStatus().value());
    }

    // ---------------- B-05 ----------------

    @Test
    void 读他人ref_404且不复述存在性() {
        when(repository.findOwned(eq(USER), eq("pat-" + "2".repeat(32)))).thenReturn(Optional.empty());
        ApiException ex = assertThrows(ApiException.class,
                () -> service.get(USER, "pat-" + "2".repeat(32)));
        assertEquals("PATIENT_NOT_FOUND", ex.getCode());
        assertEquals(404, ex.getStatus().value());
    }

    // ---------------- B-06 ----------------

    @Test
    void 修改_版本不匹配_409() {
        when(repository.findOwned(eq(USER), anyString()))
                .thenReturn(Optional.of(row("pat-" + "3".repeat(32), "张三", 5, "ACTIVE")));
        ApiException ex = assertThrows(ApiException.class, () -> service.update(USER,
                "pat-" + "3".repeat(32), new PatientUpdateRequest(4, "张三丰", null, null, null, null)));
        assertEquals("VERSION_CONFLICT", ex.getCode());
        assertEquals(409, ex.getStatus().value());
    }

    // ---------------- B-07 ----------------

    @Test
    void 归档_有未终态预约_409并给出预约id() {
        String ref = "pat-" + "4".repeat(32);
        when(repository.findOwned(eq(USER), eq(ref)))
                .thenReturn(Optional.of(row(ref, "张三", 1, "ACTIVE")));
        when(repository.listBlockingAppointments(ref)).thenReturn(List.of("ap-1", "ap-2"));

        ApiException ex = assertThrows(ApiException.class, () -> service.archive(USER, ref));
        assertEquals("PATIENT_IN_USE", ex.getCode());
        assertEquals(409, ex.getStatus().value());
        assertNotNull(ex.getDetails());
        verify(repository, never()).archive(anyString(), anyString());
    }

    // ---------------- B-08 ----------------

    @Test
    void 列表_linkState按投影状态映射() {
        String ref = "pat-" + "5".repeat(32);
        when(repository.listByOwner(USER, false)).thenReturn(List.of(row(ref, "张三", 1, "ACTIVE")));
        when(repository.findMapping(ref)).thenReturn(Optional.of(
                new PatientIndexRepository.MappingRow("CONFIRMED", "T4", NOW, NOW)));

        PatientData data = service.list(USER, false).get(0);
        assertEquals("LINKED", data.linkState());
    }

    @Test
    void 列表_投影缺失但事实源已连_报待补投影() {
        String ref = "pat-" + "6".repeat(32);
        when(repository.listByOwner(USER, false)).thenReturn(List.of(row(ref, "张三", 1, "ACTIVE")));
        when(repository.findMapping(ref)).thenReturn(Optional.empty());
        when(repository.hasLinkedAppointment(ref)).thenReturn(true);

        assertEquals("LINKED_PROJECTION_PENDING", service.list(USER, false).get(0).linkState(),
                "F3：事实源已连、投影失败时不得显示成未关联");
    }

    // ---------------- B-09 ----------------

    @Test
    void 响应脱敏_不含哈希与HIS标识() {
        String ref = "pat-" + "7".repeat(32);
        when(repository.findOwned(eq(USER), eq(ref)))
                .thenReturn(Optional.of(row(ref, "张三", 1, "ACTIVE")));

        PatientData data = service.get(USER, ref);
        assertEquals("************3620", data.idMasked(), "只给星号+尾4位，前6位从未落库");
        assertEquals("138****8000", data.phoneMasked());
        assertNull(data.familyMemberId());
        assertEquals("SELF", data.relation());
        // record 结构本身没有 idCardHash / hisMrn / hisPatientId 组件 —— 编译期即保证不泄露
    }

    // ---------------- 幂等 ----------------

    @Test
    void 幂等_同键异载荷_409() {
        when(repository.findIdempotencyDigest(eq(USER), eq("idem-fixed")))
                .thenReturn(Optional.of("another-digest"));

        ApiException ex = assertThrows(ApiException.class, () -> service.create(USER, "idem-fixed",
                new PatientCreateRequest("张三", null, null, null, null, null)));
        assertEquals("IDEMPOTENCY_KEY_REUSE", ex.getCode());
    }

    @Test
    void 幂等_同键同载荷_返回既有且不重复写审计() {
        var existing = row("pat-" + "8".repeat(32), "张三", 1, "ACTIVE");
        String digest = Digests.sha256Hex("name=张三|fm=|birth=|sex=|id=|phone=");
        when(repository.findIdempotencyDigest(eq(USER), eq("idem-same")))
                .thenReturn(Optional.of(digest));
        when(repository.findByName(eq(USER), eq("张三"))).thenReturn(Optional.of(existing));

        PatientData data = service.create(USER, "idem-same",
                new PatientCreateRequest("张三", null, null, null, null, null));
        assertFalse(data.created());
        verify(repository, never()).insert(any(), anyString(), anyString());
    }

    // ---------------- 归档幂等 ----------------

    @Test
    void 归档_已归档再归档幂等() {
        String ref = "pat-" + "9".repeat(32);
        when(repository.findOwned(eq(USER), eq(ref)))
                .thenReturn(Optional.of(row(ref, "张三", 2, "ARCHIVED")));
        PatientData data = service.archive(USER, ref);
        assertEquals("ARCHIVED", data.status());
        assertEquals("ARCHIVED", data.linkState());
        verify(repository, never()).archive(anyString(), anyString());
    }

    // ---------------- 未配置盐 ----------------

    @Test
    void 未配置HIS盐_不写证件哈希() {
        var noSalt = new PatientIndexService(repository, familyRepository, phoneHashing,
                Clock.fixed(NOW, ZoneOffset.UTC), true, "");
        when(repository.findByName(eq(USER), anyString())).thenReturn(Optional.empty());
        when(repository.findIdempotencyDigest(eq(USER), anyString())).thenReturn(Optional.empty());
        when(repository.findMapping(anyString())).thenReturn(Optional.empty());

        noSalt.create(USER, "idem-nosalt",
                new PatientCreateRequest("王五", null, null, null, VALID_ID, null));

        ArgumentCaptor<PatientIndexRepository.PatientRow> captor =
                ArgumentCaptor.forClass(PatientIndexRepository.PatientRow.class);
        verify(repository).insert(captor.capture(), anyString(), anyString());
        assertEquals("", captor.getValue().idCardHash(),
                "没有盐就写不出可比对的哈希；宁可不写，也不写一个永远匹配不上的值");
        assertEquals("3620", captor.getValue().idLast4(), "尾号仍保留，供人工核对");
        assertEquals("ID_VERIFIED", captor.getValue().verificationLevel(),
                "校验位通过即 ID_VERIFIED，与是否配置盐无关");
    }

    // ---------------- 缺省开关 ----------------

    @Test
    void 开关关闭时isEnabled为false() {
        var disabled = new PatientIndexService(repository, familyRepository, phoneHashing,
                Clock.fixed(NOW, ZoneOffset.UTC), false, SALT);
        assertFalse(disabled.isEnabled());
    }
}
