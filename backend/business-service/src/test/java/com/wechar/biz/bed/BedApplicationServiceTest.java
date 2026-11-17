package com.wechar.biz.bed;

import com.wechar.biz.appointment.AppointmentRepository;
import com.wechar.biz.bed.dto.BedApplicationRequest;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.doctor.DoctorRepository;
import com.wechar.biz.doctor.DoctorService;
import com.wechar.biz.user.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 床位申请服务单测（申请制，2026-11-15）。
 *
 * 覆盖申请制的四个关键语义：
 *   ① patientRef 只接受内部患者 ID（手机号 422，与床位分配 ASSIGN 同口径）；
 *   ② 患者必须已登记（404）；
 *   ③ 指定床位必须空闲且属授权病区（409/404）——医生不能「批了没床」；
 *   ④ 幂等：同键同载荷重放返回既有单，不重复落库；
 *   ⑤ 审批：APPROVED 且带床 → 同事务落床；非 PENDING 重复审批 → 409。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class BedApplicationServiceTest {

    @Mock private BedApplicationRepository applications;
    @Mock private BedRepository beds;
    @Mock private AppointmentRepository appointments;
    @Mock private DoctorService doctorService;
    @Mock private UserRepository users;
    @Mock private Clock clock;

    @InjectMocks private BedApplicationService service;

    private static final Instant NOW = Instant.parse("2026-11-15T07:00:00Z");

    private final DoctorRepository.DoctorRow doctor = new DoctorRepository.DoctorRow(
            "doc-1", "dep-1", "消化内科", "林建平", "主任医师");

    @BeforeEach
    void setUp() {
        lenient().when(clock.instant()).thenReturn(NOW);
        lenient().when(doctorService.requireDoctor("u-doc")).thenReturn(doctor);
        lenient().when(users.findById("u-pat")).thenReturn(Optional.of(new UserRepository.UserRow(
                "u-pat", null, null, null, true, "张建国", null, "ACTIVE", 1, NOW, NOW)));
        lenient().when(beds.listAuthorizedWardIds("dep-1")).thenReturn(List.of("w1"));
        lenient().when(beds.findBedDepartmentId("bed-1")).thenReturn(Optional.of("dep-1"));
        lenient().when(beds.findBed("bed-1")).thenReturn(Optional.of(new BedRepository.BedRow(
                "bed-1", "w1", "心血管内科病区", "A-01", "AVAILABLE", null, null, null, 1, null, null)));
    }

    private BedApplicationRequest req(String patientRef, String bedId, String wardId,
                                      String reason, String priority) {
        return new BedApplicationRequest(patientRef, bedId, wardId, reason, priority);
    }

    private BedApplicationRepository.ApplicationRow row(String status, String bedId, String digest) {
        return new BedApplicationRepository.ApplicationRow("ba-1", "doc-1", "林建平", "dep-1",
                "w1", "心血管内科病区", bedId, bedId == null ? null : "A-01",
                "u-pat", "张建*", "胸闷待查", "NORMAL", status, null, null, NOW,
                "ik-1", digest);
    }

    private AppointmentRepository.AppointmentRow appt(String doctorId, String userId,
                                                      String familyMemberId, String status) {
        return new AppointmentRepository.AppointmentRow("apt-1", userId, familyMemberId,
                "slot-1", doctorId, "dep-1", "张建国", null, "胸闷待查", status, 1,
                null, null, null, 1, NOW, NOW, null, "LOCAL_DEMO");
    }

    @Test
    void submitRejectsPhoneAsPatientRef() {
        ApiException e = assertThrows(ApiException.class,
                () -> service.submit("u-doc", "ik-a", req("13800138001", null, null, null, null)));
        assertEquals("VALIDATION_FAILED", e.getCode());
        verify(applications, never()).insert(any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any());
    }

    @Test
    void submitRejectsUnknownPatient() {
        ApiException e = assertThrows(ApiException.class,
                () -> service.submit("u-doc", "ik-a", req("u-ghost", null, null, null, null)));
        assertEquals("PATIENT_NOT_FOUND", e.getCode());
    }

    @Test
    void submitRejectsOccupiedBed() {
        when(beds.findBed("bed-1")).thenReturn(Optional.of(new BedRepository.BedRow(
                "bed-1", "w1", "心血管内科病区", "A-01", "OCCUPIED", null, null, null, 3, null, null)));
        ApiException e = assertThrows(ApiException.class,
                () -> service.submit("u-doc", "ik-a", req("u-pat", "bed-1", null, null, null)));
        assertEquals("BED_STATE_CONFLICT", e.getCode());
    }

    @Test
    void submitRejectsBedOutsideAuthorizedWard() {
        when(beds.findBedDepartmentId("bed-9")).thenReturn(Optional.of("dep-other"));
        when(beds.findBed("bed-9")).thenReturn(Optional.of(new BedRepository.BedRow(
                "bed-9", "w9", "其他病区", "Z-09", "AVAILABLE", null, null, null, 1, null, null)));
        ApiException e = assertThrows(ApiException.class,
                () -> service.submit("u-doc", "ik-a", req("u-pat", "bed-9", null, null, null)));
        assertEquals("BED_NOT_FOUND", e.getCode());
    }

    @Test
    void submitResolvesPatientRefFromOwnAppointment() {
        when(applications.findByIdempotencyKey("ik-a")).thenReturn(Optional.empty());
        when(appointments.findById("apt-1"))
                .thenReturn(Optional.of(appt("doc-1", "u-pat", null, "CHECKED_IN")));
        when(applications.findById(anyString())).thenReturn(Optional.of(row("PENDING", null,
                Digests.sha256Hex("u-pat|||胸闷待查|NORMAL"))));
        var out = service.submit("u-doc", "ik-a",
                new BedApplicationRequest(null, "apt-1", null, null, "胸闷待查", null));
        assertEquals("PENDING", out.status());
        verify(applications).insert(anyString(), eq("doc-1"), eq("dep-1"), isNull(), isNull(),
                eq("u-pat"), anyString(), eq("胸闷待查"), eq("NORMAL"), eq("PENDING"),
                eq("ik-a"), anyString(), eq(NOW));
    }

    @Test
    void submitRejectsAppointmentOfAnotherDoctor() {
        when(appointments.findById("apt-1"))
                .thenReturn(Optional.of(appt("doc-other", "u-pat", null, "CHECKED_IN")));
        ApiException e = assertThrows(ApiException.class,
                () -> service.submit("u-doc", "ik-a",
                        new BedApplicationRequest(null, "apt-1", null, null, null, null)));
        assertEquals("APPOINTMENT_NOT_FOUND", e.getCode());
    }

    @Test
    void submitRejectsFamilyMemberAppointment() {
        when(appointments.findById("apt-1"))
                .thenReturn(Optional.of(appt("doc-1", "u-pat", "fm-1", "CHECKED_IN")));
        ApiException e = assertThrows(ApiException.class,
                () -> service.submit("u-doc", "ik-a",
                        new BedApplicationRequest(null, "apt-1", null, null, null, null)));
        assertEquals("VALIDATION_FAILED", e.getCode());
    }

    @Test
    void submitRejectsBothPatientRefAndAppointment() {
        ApiException e = assertThrows(ApiException.class,
                () -> service.submit("u-doc", "ik-a",
                        new BedApplicationRequest("u-pat", "apt-1", null, null, null, null)));
        assertEquals("VALIDATION_FAILED", e.getCode());
    }

    @Test
    void submitRejectsMissingPatientIdentity() {
        ApiException e = assertThrows(ApiException.class,
                () -> service.submit("u-doc", "ik-a",
                        new BedApplicationRequest(null, null, null, null, null, null)));
        assertEquals("VALIDATION_FAILED", e.getCode());
    }

    @Test
    void submitReplaysSameKeySamePayload() {
        String digest = Digests.sha256Hex("u-pat|bed-1|w1|胸闷待查|NORMAL");
        when(applications.findByIdempotencyKey("ik-a"))
                .thenReturn(Optional.of(row("PENDING", "bed-1", digest)));
        var out = service.submit("u-doc", "ik-a", req("u-pat", "bed-1", "w1", "胸闷待查", null));
        assertEquals("ba-1", out.id());
        verify(applications, never()).insert(any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any());
    }

    @Test
    void submitInsertsPendingApplication() {
        when(applications.findByIdempotencyKey("ik-a")).thenReturn(Optional.empty());
        when(applications.findById(anyString())).thenReturn(Optional.of(row("PENDING", "bed-1",
                Digests.sha256Hex("u-pat|bed-1|w1|胸闷待查|NORMAL"))));
        var out = service.submit("u-doc", "ik-a", req("u-pat", "bed-1", "w1", "胸闷待查", null));
        assertEquals("PENDING", out.status());
        verify(applications).insert(anyString(), eq("doc-1"), eq("dep-1"), eq("w1"), eq("bed-1"),
                eq("u-pat"), anyString(), eq("胸闷待查"), eq("NORMAL"), eq("PENDING"),
                eq("ik-a"), anyString(), eq(NOW));
    }

    @Test
    void reviewApprovedOccupiesBedInSameTransaction() {
        // findById 被调两次：先校验状态（PENDING）→ 审批后回读（APPROVED）
        String digest = Digests.sha256Hex("u-pat|bed-1|w1|胸闷待查|NORMAL");
        when(applications.findById("ba-1"))
                .thenReturn(Optional.of(row("PENDING", "bed-1", digest)))
                .thenReturn(Optional.of(row("APPROVED", "bed-1", digest)));
        when(beds.findBed("bed-1")).thenReturn(Optional.of(new BedRepository.BedRow(
                "bed-1", "w1", "心血管内科病区", "A-01", "AVAILABLE", null, null, null, 7, null, null)));
        when(beds.updateAssignment(eq("bed-1"), eq(7), eq("OCCUPIED"), eq("u-pat"), anyString(),
                any(Instant.class), anyString(), anyString(), anyString(), any(Instant.class)))
                .thenReturn(true);
        when(applications.review(eq("ba-1"), eq("APPROVED"), anyString(), anyString(), any(Instant.class)))
                .thenReturn(true);
        var out = service.review("ba-1", "APPROVED", "同意入住", "护士站");
        assertEquals("APPROVED", out.status());
    }

    @Test
    void reviewRejectsAlreadyReviewed() {
        when(applications.findById("ba-1")).thenReturn(Optional.of(row("APPROVED", "bed-1", "d")));
        ApiException e = assertThrows(ApiException.class,
                () -> service.review("ba-1", "APPROVED", null, "护士站"));
        assertEquals("APPLICATION_STATE_CONFLICT", e.getCode());
    }
}
