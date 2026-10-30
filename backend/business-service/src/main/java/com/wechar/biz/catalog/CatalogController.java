package com.wechar.biz.catalog;

import com.wechar.biz.catalog.dto.DepartmentData;
import com.wechar.biz.catalog.dto.DoctorData;
import com.wechar.biz.catalog.dto.HospitalData;
import com.wechar.biz.catalog.dto.SlotData;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import java.time.LocalDate;
import java.util.List;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * catalog 控制器（M1.3）：
 *  GET /api/v1/departments · GET /api/v1/departments/{departmentId}/doctors（契约）
 *  GET /api/v1/doctors · GET /api/v1/doctors/{doctorId} · GET /api/v1/doctors/{doctorId}/slots（契约+任务书）
 */
@RestController
@RequestMapping("/api/v1")
public class CatalogController {

    private final CatalogService catalogService;

    public CatalogController(CatalogService catalogService) {
        this.catalogService = catalogService;
    }

    @GetMapping("/departments")
    public ResponseEntity<Envelope<List<DepartmentData>>> listDepartments(
            @RequestParam(required = false) String hospitalId,
            @RequestParam(required = false) String keyword) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), catalogService.departments(hospitalId, keyword)));
    }

    /** 契约 listHospitals（N7，2026-10-19）：院区列表，匿名只读（登记于 AuthInterceptor.ANONYMOUS）。 */
    @GetMapping("/hospitals")
    public ResponseEntity<Envelope<List<HospitalData>>> listHospitals() {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), catalogService.hospitals()));
    }

    @GetMapping("/departments/{departmentId}/doctors")
    public ResponseEntity<Envelope<List<DoctorData>>> listDepartmentDoctors(
            @PathVariable String departmentId) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), catalogService.doctorsByDepartment(departmentId)));
    }

    @GetMapping("/doctors")
    public ResponseEntity<Envelope<List<DoctorData>>> listDoctors(
            @RequestParam(required = false) String hospitalId) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), catalogService.allDoctors(hospitalId)));
    }

    @GetMapping("/doctors/{doctorId}")
    public ResponseEntity<Envelope<DoctorData>> getDoctor(@PathVariable String doctorId) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), catalogService.doctor(doctorId)));
    }

    @GetMapping("/doctors/{doctorId}/slots")
    public ResponseEntity<Envelope<List<SlotData>>> listDoctorSlots(
            @PathVariable String doctorId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), catalogService.slots(doctorId, from, to)));
    }
}
