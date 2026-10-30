/**
 * appointment.js —— 智能挂号服务（V2 契约版）
 * 经统一网关转发到 business-service（前端只连 config/env.js 的 gateway）
 *
 * 契约路径（backend/contracts/business-openapi.yaml）：
 * - GET  /api/v1/departments                      → Department[] {id, name, location?, building?, floor?}
 * - GET  /api/v1/departments/{id}/doctors?date=   → Doctor[] {id, name, title, specialties[], hasAvailableSlot?}
 * - GET  /api/v1/doctors/{id}/slots?from=&to=     → Slot[] {id, doctorId, startTime, endTime, remaining, fee?}
 * - POST /api/v1/appointments                     → 见 services/user.js submitAppointment（契约 AppointmentCreate，
 *   required [slotId, patientName]，写操作要求 Idempotency-Key，前端不重复封装）
 *
 * ⚠️ 旧接口 /api/v1/doctor/list、/api/appoint/submit 已被契约标记 legacy（契约 §2714），
 *    且旧 submit 发送契约外字段会被 additionalProperties:false 拒绝（400）——故本文件不再提供。
 */
const { get, withPath, API } = require('./request.js')

/** 响应统一成数组（Envelope data 即数组；兼容 {list:[]} 包裹） */
function asList(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.list)) return data.list
  if (data && Array.isArray(data.items)) return data.items
  return []
}

/**
 * 科室列表（契约 listDepartments）
 * @returns {Promise<Array<{id,name,location,building,floor}>>}
 */
function listDepartmentsC() {
  return get(API.DEPARTMENT_LIST).then((data) => {
    return asList(data).map((d) => ({
      id: String(d.id || ''),
      name: d.name || '',
      location: d.location || '',
      building: d.building || '',
      floor: d.floor || ''
    })).filter((d) => d.id && d.name)
  })
}

/**
 * 科室下的医生（契约 listDepartmentDoctors；date 可选，只返回该日期有号的医生）
 * @param {string} deptId
 * @param {string} [date] YYYY-MM-DD
 * @returns {Promise<Array<{id,name,title,specialties,hasAvailableSlot}>>}
 */
function listDeptDoctorsC(deptId, date) {
  const spec = withPath(API.DEPARTMENT_DOCTORS, { id: String(deptId || '') })
  const query = date ? { date } : undefined
  return get(spec, query).then((data) => {
    return asList(data).map((d) => ({
      id: String(d.id || ''),
      name: d.name || '',
      title: d.title || '',
      specialties: Array.isArray(d.specialties) ? d.specialties : [],
      /* hasAvailableSlot 保留**三态**：true / false / null(后端未给字段)。
         原来写成 `!!d.hasAvailableSlot` 会把"字段缺省"压成 false，
         页面据此渲染「约满 + 灰禁用按钮」→ 后端没维护该字段时整页误报约满。
         这里只做归一化，不猜值；三态怎么呈现由页面决定。 */
      hasAvailableSlot: d.hasAvailableSlot === true ? true : (d.hasAvailableSlot === false ? false : null)
    })).filter((d) => d.id && d.name)
  })
}

/**
 * 医生号源（契约 listDoctorSlots）
 * ⚠️ remaining 为快照值，不构成预留；下单失败（409 号满）必须回本接口重新取号。
 * @param {string} doctorId
 * @param {string} [from] YYYY-MM-DD
 * @param {string} [to]   YYYY-MM-DD
 * @returns {Promise<Array<{id,doctorId,startTime,endTime,remaining,fee}>>}
 */
function listDoctorSlotsC(doctorId, from, to) {
  const spec = withPath(API.DOCTOR_SLOTS, { id: String(doctorId || '') })
  const query = {}
  if (from) query.from = from
  if (to) query.to = to
  return get(spec, Object.keys(query).length ? query : undefined).then((data) => {
    return asList(data).map((s) => ({
      id: String(s.id || ''),
      doctorId: String(s.doctorId || ''),
      startTime: s.startTime || '',
      endTime: s.endTime || '',
      remaining: Number(s.remaining) || 0,
      // fee 为 null 表示未配置，界面不得显示猜测金额（契约注释）
      fee: (s.fee === null || s.fee === undefined) ? null : Number(s.fee)
    })).filter((s) => s.id && s.startTime)
  })
}

/**
 * 把契约 Slot 的 startTime（date-time）拆成页面需要的 {date, time}：
 * 兼容 'YYYY-MM-DDTHH:mm:ss(+08:00)' 与 'YYYY-MM-DD HH:mm:ss' 两种序列化。
 * 解析不出 → 返回 null，页面丢弃该号源（不展示猜的时间）。
 */
function slotDateTime(startTime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(startTime || ''))
  if (!m) return null
  return { date: m[1] + '-' + m[2] + '-' + m[3], time: m[4] + ':' + m[5] }
}

module.exports = {
  listDepartmentsC, listDeptDoctorsC, listDoctorSlotsC, slotDateTime
}
