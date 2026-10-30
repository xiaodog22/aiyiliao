package com.wechar.biz.catalog;

import com.wechar.biz.catalog.dto.DepartmentData;
import com.wechar.biz.catalog.dto.DoctorData;
import com.wechar.biz.catalog.dto.HospitalData;
import com.wechar.biz.catalog.dto.SlotData;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** catalog 只读目录服务（M1.3）：departments / doctors / doctors/{id} / slots / hospitals（N7）。 */
@Service
public class CatalogService {

    /** 医院名在 departments 表没有单独列（V1），按 hospital_id 归一；dev 种子只有一种医院。 */
    private static final Map<String, String> HOSPITAL_NAMES = Map.of("hosp-wechar-dev", "示例互联网医院");

    private static final String HOSPITAL_NAME_DEFAULT = "示例互联网医院";

    /** N6 号源三态阈值：今日剩余量 ≤ 该值 → FEW（号源紧张）；0 → FULL；阈值属部署配置。 */
    private static final int FEW_THRESHOLD = 3;

    private final CatalogRepository repository;
    private final java.time.Clock clock;

    public CatalogService(CatalogRepository repository, java.time.Clock clock) {
        this.repository = repository;
        this.clock = clock;
    }

    /**
     * 医院名优先取 departments.hospital_name（V7 起入库）；历史行缺失时按 hospital_id 归一
     * （dev 种子只有一种医院），绝不返回空串。
     */
    private static String hospitalName(CatalogRepository.DepartmentRow d) {
        if (d.hospitalName() != null && !d.hospitalName().isBlank()) {
            return d.hospitalName();
        }
        return HOSPITAL_NAMES.getOrDefault(d.hospitalId(), HOSPITAL_NAME_DEFAULT);
    }

    @Transactional(readOnly = true)
    public List<DepartmentData> departments(String hospitalId, String keyword) {
        return repository.listDepartments(hospitalId, keyword).stream()
                .map(d -> new DepartmentData(d.id(), d.name(), d.hospitalId(), hospitalName(d),
                        d.location(), d.building(), d.floor(), d.area(), d.roomNo(),
                        d.description(), d.iconKey()))
                .toList();
    }

    /** 科室下的医生（契约路径 {departmentId}/doctors）。科室不存在 → 404。 */
    @Transactional(readOnly = true)
    public List<DoctorData> doctorsByDepartment(String departmentId) {
        if (!repository.departmentExists(departmentId)) {
            throw new ApiException("DEPARTMENT_NOT_FOUND", HttpStatus.NOT_FOUND, "科室不存在");
        }
        return toDoctorData(repository.listDoctors(departmentId, null));
    }

    /** 全局医生列表（任务书 GET /api/v1/doctors；契约仅列科室下列表，本路径为任务书别名）。 */
    @Transactional(readOnly = true)
    public List<DoctorData> allDoctors(String hospitalId) {
        return toDoctorData(repository.listDoctors(null, hospitalId));
    }

    /** 医生详情（任务书 GET /api/v1/doctors/{id}）。不存在 → 404。 */
    @Transactional(readOnly = true)
    public DoctorData doctor(String doctorId) {
        var doc = repository.findDoctor(doctorId)
                .orElseThrow(() -> new ApiException("DOCTOR_NOT_FOUND", HttpStatus.NOT_FOUND, "医生不存在"));
        return toDoctorData(List.of(doc)).get(0);
    }

    /** 医生号源（契约 {doctorId}/slots）。医生不存在 → 404；from/to 为日期（UTC 解释）。 */
    @Transactional(readOnly = true)
    public List<SlotData> slots(String doctorId, LocalDate from, LocalDate to) {
        if (repository.findDoctor(doctorId).isEmpty()) {
            throw new ApiException("DOCTOR_NOT_FOUND", HttpStatus.NOT_FOUND, "医生不存在");
        }
        Instant fromInstant = from == null ? null : from.atStartOfDay().toInstant(ZoneOffset.UTC);
        Instant toInstant = to == null ? null : to.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC);
        return repository.listSlots(doctorId, fromInstant, toInstant).stream()
                .map(s -> new SlotData(s.id(), s.doctorId(), s.startTime(), s.endTime(),
                        s.remaining(), s.fee(), s.currency()))
                .toList();
    }

    private List<DoctorData> toDoctorData(List<CatalogRepository.DoctorRow> rows) {
        return rows.stream().map(d -> {
            List<String> specialties = parseSpecialties(d.specialtiesJson());
            Boolean hasSlot = repository.hasAvailableSlot(d.id());
            String[] slotStatus = slotStatus(d.id());
            return new DoctorData(d.id(), d.name(), d.departmentId(), d.departmentName(), d.title(),
                    null, specialties, d.introduction(), hasSlot, slotStatus[0], slotStatus[1]);
        }).toList();
    }

    /**
     * N6 号源三态：按**今日（UTC 日窗口，与 workbench/todo 计数同一口径）** OPEN 号源剩余量判定。
     *  - 剩余 0（含今日无号源）→ FULL「约满」（与今日不可约一致）；
     *  - 剩余 ≤ FEW_THRESHOLD → FEW「今日号源紧张」；
     *  - 其余 → OPEN「今日可预约」。
     * 返回 [枚举, 中文文案]——红线：状态不靠颜色单独表达，文案随枚举同时下发。
     * 仅展示提示：下单仍以 createAppointment 原子扣减为准（契约 hasAvailableSlot 同语义）。
     */
    private String[] slotStatus(String doctorId) {
        java.time.Instant dayFrom = clock.instant().truncatedTo(java.time.temporal.ChronoUnit.DAYS);
        java.time.Instant dayTo = dayFrom.plus(1, java.time.temporal.ChronoUnit.DAYS);
        int remaining = repository.sumRemainingInWindow(doctorId, dayFrom, dayTo);
        if (remaining <= 0) {
            return new String[] {"FULL", "约满"};
        }
        if (remaining <= FEW_THRESHOLD) {
            return new String[] {"FEW", "今日号源紧张"};
        }
        return new String[] {"OPEN", "今日可预约"};
    }

    /**
     * 契约 listHospitals（N7）：院区由 ACTIVE 科室归属去重派生；名称口径与科室列表
     * hospitalName 完全一致（hospital_name 优先，缺失按 hospital_id 归一），同一院区两处展示同名。
     */
    @Transactional(readOnly = true)
    public List<HospitalData> hospitals() {
        return repository.listHospitals().stream()
                .map(h -> new HospitalData(h.id(),
                        h.name() != null && !h.name().isBlank() ? h.name()
                                : HOSPITAL_NAMES.getOrDefault(h.id(), HOSPITAL_NAME_DEFAULT)))
                .toList();
    }

    /** specialties_json 容错解析（种子为 JSON 数组字符串）。 */
    private static List<String> parseSpecialties(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        String trimmed = json.trim();
        if (trimmed.startsWith("[")) {
            return Arrays.stream(trimmed.replaceAll("[\\[\\]\"]", "").split(","))
                    .map(String::trim).filter(s -> !s.isEmpty()).toList();
        }
        return List.of(trimmed);
    }

    /** 供 appointment 域复用：取号源（含 doctor/department 关联），不存在返回 empty。 */
    public java.util.Optional<CatalogRepository.SlotRow> findSlot(String slotId, List<CatalogRepository.SlotRow> rows) {
        return rows.stream().filter(r -> r.id().equals(slotId)).findFirst();
    }

    /** 供 appointment 域校验 slot 属于某 doctor。 */
    public boolean slotBelongsToDoctor(String slotId, String doctorId) {
        java.util.List<CatalogRepository.SlotRow> rows = repository.listSlots(doctorId, null, null);
        return rows.stream().anyMatch(r -> r.id().equals(slotId));
    }

    /** 内部暴露 repository 给 appointment 服务（同包内共享查询能力）。 */
    CatalogRepository repository() {
        return repository;
    }

    /** 校验医生-科室关联（任务书规则 4d）。 */
    public void requireDoctorInDepartment(String doctorId, String departmentId) {
        var doc = repository.findDoctor(doctorId)
                .orElseThrow(() -> new ApiException("DOCTOR_NOT_FOUND", HttpStatus.NOT_FOUND, "医生不存在"));
        if (!doc.departmentId().equals(departmentId)) {
            throw new ApiException("DOCTOR_DEPARTMENT_MISMATCH", HttpStatus.UNPROCESSABLE_ENTITY,
                    "医生与科室关联不一致");
        }
    }

    /** 摘要工具复用（避免循环依赖，此处仅占位说明）。 */
    static String digest(String text) {
        return Digests.sha256Hex(text);
    }
}
