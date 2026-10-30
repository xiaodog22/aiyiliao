/**
 * doctor.js —— 医生端服务（V1.7 契约登录版）
 *
 * 登录（契约路径，服务端签发会话）：
 *   POST /api/v1/doctor/login
 *   请求头：X-Client-Version / X-Platform（契约 required，由 request.js 统一拼装）
 *   请求体：{ code, phoneCode?, consentVersion } —— 与患者登录同一套（WechatLoginRequest）
 *   响应：Envelope<SessionData>
 *   ⚠️ **角色只能由服务端按数据库任职关系判定**（契约 doctorLogin：请求体无角色字段，
 *      客户端无法通过参数提权）；无 ACTIVE 医生任职 → 403。
 *   ⚠️ 登录成功后必须 session.setTokens(data)，否则受保护接口 401。
 *
 * 其余接口走契约端点（/api/v1/doctor/*）。
 * ⚠️ 医生端「挂号列表 / 状态流转」已迁到契约端点（2026-10-18）；
 *    「床位流转」仍是网关 compat pending（501 + 迁移说明，见 COMPAT.md），属待迁移项。
 *
 * 错误约定：reject 结构化 { code, message, httpCode }
 */
const req = require('./request.js')
const { post, get, put, API } = req
const session = require('./session.js')
const ENV = req.ENV

// 模块级登录态（患者端 / 医生端共用一份 role/user/app.globalData）
let _doctor = null

function getDoctor() { return _doctor }

function logout() {
  _doctor = null
  try { wx.removeStorageSync('wb_doctor') } catch (e) {}
}

function setDoctor(d) {
  _doctor = d
  try { wx.setStorageSync('wb_doctor', d) } catch (e) {}
}

function restore() {
  try { _doctor = wx.getStorageSync('wb_doctor') || null } catch (e) { _doctor = null }
  return _doctor
}

/** 契约 Session → 医生 profile，并把会话落到 session */
function applySession(data) {
  const d = data || {}
  if (!d.accessToken) {
    throw Object.assign(new Error('登录响应缺少会话令牌'), { code: 'BIZ_ERROR' })
  }
  session.setTokens(d)
  const u = d.user || {}
  const profile = {
    id: u.id || '',
    name: u.displayName || '医生',
    avatarUrl: u.avatarUrl || '',
    // 服务端认定的角色（应含 DOCTOR）；登录页据此判定去向
    roles: Array.isArray(u.roles) ? u.roles : [],
    role: 'doctor'
  }
  setDoctor(profile)
  return profile
}

/** 组装契约 WechatLoginRequest（严格按契约字段；不得夹带 username/role 等契约外字段） */
function loginBody(code, phoneCode) {
  const body = { code: String(code || ''), consentVersion: ENV.consentVersion }
  if (phoneCode) body.phoneCode = String(phoneCode)
  return body
}

/**
 * 微信一键登录（医生端，契约路径）
 * @param {string} code        wx.login() 的临时 code
 * @param {string} [phoneCode] getPhoneNumber 的 detail.code
 * ⚠️ dev 档 provider 只认两个身份（openid=dev-user-1 / 含 'dev-user-2' → dev-user-2），
 *    而医生任职关系登记在 dev-user-2 上，故 dev 档一键登录可能如实返回 403；
 *    本地联调请走手输入口（其派生 code 含 dev-user-2）。
 *    生产：后端 ProdWechatSessionProvider 已实现真实 jscode2session（jscode2session → openid），
 *    配置 WECHAT_MINIPROGRAM_APP_ID / WECHAT_MINIPROGRAM_APP_SECRET 后即走真实微信登录。
 */
function loginByWxCode(code, phoneCode) {
  return post(API.DOCTOR_LOGIN, loginBody(code, phoneCode)).then(applySession)
}

/**
 * 手输「工号/手机号 + 密码」登录 —— **仅开发构建**（生产构建该入口隐藏）
 *
 * ⚠️ 契约不存在密码端点，这里用**派生 code** 走契约登录（服务端真实签发会话，非伪造响应）：
 *    - code 含 'dev-user-2' → dev 档 provider 映射 openid=dev-user-2（医生任职登记在该 openid 上，
 *      见 business-service/db/dev/V9002__m3_dev_seed.sql）；
 *    - 工号不是手机号时不传 phoneCode（dev 档只接受 11 位手机号，否则 422 PHONE_CODE_INVALID）；
 *    - password **不参与校验**（dev 档无密码体系）—— 故该入口仅限开发构建。
 *    若账号确无任职关系，服务端仍如实 403（不伪造任职）。
 */
function login(account, password) {
  if (!ENV.legacyManualLoginEnabled) {
    return Promise.reject(Object.assign(new Error('当前版本仅支持微信一键登录'), { code: 'BAD_SPEC' }))
  }
  // dev 派生 code 必须带联调密钥，否则后端一律 403（DevLoginGuard）
  if (!ENV.devLoginKey) {
    return Promise.reject(Object.assign(new Error('联调登录未配置密钥，请联系管理员'), { code: 'BAD_SPEC' }))
  }
  const a = String(account || '').trim()
  const phoneCode = /^1\d{10}$/.test(a) ? 'dev-phone-' + a : ''
  return post(API.DOCTOR_LOGIN, loginBody('dev-user-2-manual-' + a, phoneCode)).then(applySession)
}

// 全部医生
function listAllDoctors() {
  return get(API.DOCTOR_LIST)
}

// 按科室查医生（契约 /api/v1/departments/{id}/doctors；参数名 id）
function listDoctorsByDept(deptId) {
  return get(API.DOCTOR_BY_DEPT, { id: deptId })
}

// ============ 排班与在线接诊（V22）============

/**
 * 医生本人周模板 + 在线状态（GET /api/v1/doctor/schedule）
 * @returns {Promise<{version:number, weekdays:Array, online:Object}>}
 *          weekdays=[{weekday,slots:[{startTime,endTime,slotMinutes,capacity,onlineOnly}]}]
 *          online={online,accepting,version,updatedAt}
 */
function getSchedule() {
  return get(API.DOCTOR_SCHEDULE)
}

/**
 * 整体替换周模板（PUT /api/v1/doctor/schedule；写操作强校验幂等键）
 * @param {number} expectedVersion 取 getSchedule().version（无排班为 0）
 * @param {Array}  weekdays        [{weekday,slots:[{startTime,endTime,slotMinutes,capacity,onlineOnly}]}]
 * @returns {Promise<{schedule:Object, replayed:boolean}>}
 */
function saveSchedule(expectedVersion, weekdays) {
  return req.put(API.DOCTOR_SCHEDULE, {
    expectedVersion: Number(expectedVersion) || 0,
    weekdays: Array.isArray(weekdays) ? weekdays : []
  }, { idempotencyKey: req.newIdempotencyKey() })
}

/**
 * 开关在线接诊（POST /api/v1/doctor/online-status；写操作强校验幂等键）
 * @param {boolean} online true=在线接诊 / false=下线
 */
function setOnlineStatus(online) {
  return post(API.DOCTOR_ONLINE_STATUS, { online: !!online },
    { idempotencyKey: req.newIdempotencyKey() })
}

/**
 * 医生排队列表（契约 GET /api/v1/doctor/appointments）
 *
 * ⚠️ 不能用 /api/v1/appointments/me 代替：那条是**患者本人预约**语义（SQL 按 user_id 过滤），
 *    医生账号调它只会得到"他作为患者自己的预约"（通常为空），不是他的接诊队列。
 *
 * @param {{status?:string, date?:string, cursor?:string, limit?:number}} [params]
 * @returns {Promise<{items:Array, nextCursor:string}>} items 为契约原始项
 *          （id/status/patientName/startTime/departmentName/doctorName/version/queueNumber…），
 *          状态是英文枚举，展示一律经 utils/apt-status.js 转换。
 */
function listAppointments(params) {
  const p = params || {}
  const query = { limit: Math.min(Math.max(Number(p.limit) || 50, 1), 50) }
  if (p.status) query.status = p.status
  if (p.date) query.date = p.date
  if (p.cursor) query.cursor = p.cursor
  // rawEnvelope：需要 meta.nextCursor 才能判断"是否还有下一页"（get 默认会脱壳丢掉 meta）
  return get(API.DOCTOR_APPOINTMENTS, query, { rawEnvelope: true }).then((env) => {
    const items = Array.isArray(env && env.data) ? env.data : []
    const meta = (env && env.meta) || {}
    return { items, nextCursor: meta.nextCursor || '' }
  })
}

/**
 * 预约状态流转（契约 POST /api/v1/doctor/appointments/{id}/status）
 *
 * ⚠️ 旧路径 /api/appoint/updateStatus 在网关 compat 中是 pending（501 COMPAT_PENDING），
 *    它缺 expectedVersion / 缺幂等头 / 状态枚举不可双射 —— 网关**刻意不代填**，不得再调用。
 *
 * @param {string} id              预约 id
 * @param {string} toStatus        契约枚举（PENDING/CONFIRMED/CHECKED_IN/COMPLETED/…）
 * @param {number} expectedVersion 乐观锁版本（取列表项 version；不匹配 → 409 VERSION_CONFLICT）
 * @param {{note?:string, idempotencyKey?:string}} [opts] 幂等键缺省自动生成
 */
function updateStatus(id, toStatus, expectedVersion, opts) {
  const o = opts || {}
  const spec = {
    base: API.DOCTOR_APPTS_STATUS.base,
    path: API.DOCTOR_APPTS_STATUS.path.replace('{id}', String(id || ''))
  }
  const body = { toStatus: String(toStatus || ''), expectedVersion: Number(expectedVersion) }
  if (o.note) body.note = String(o.note).slice(0, 200)
  return post(spec, body, { idempotencyKey: o.idempotencyKey || req.newIdempotencyKey() })
}

// 医生工作台待处理事项（GET /api/v1/doctor/todos；可能为空数组，表示确实无待办）
function listDoctorTodos() {
  return get(API.DOCTOR_TODOS)
}

/**
 * 医生问诊会话列表（V21，GET /api/v1/doctor/consultations；医生回复闭环入口）
 * @param {{cursor?:string, limit?:number}} [params]
 * @returns {Promise<{items:Array, nextCursor:string}>} items：医生视角会话
 *          （id/title/status/lastMessageAt/messageCount/summary/createdAt/patientName/patientAvatarKey）
 */
function listConsultations(params) {
  const p = params || {}
  const query = { limit: Math.min(Math.max(Number(p.limit) || 50, 1), 50) }
  if (p.cursor) query.cursor = p.cursor
  return get(API.DOCTOR_CONSULTATIONS, query, { rawEnvelope: true }).then((env) => {
    const items = Array.isArray(env && env.data) ? env.data : []
    const meta = (env && env.meta) || {}
    return { items, nextCursor: meta.nextCursor || '' }
  })
}

/**
 * 医生视角拉取会话消息（V21，GET /api/v1/doctor/consultations/{id}/messages；旧→新升序）
 * @param {string} consultationId 会话 id
 * @param {{cursor?:string, limit?:number}} [params]
 * @returns {Promise<{items:Array, nextCursor:string}>}
 */
function consultationMessages(consultationId, params) {
  const p = params || {}
  const query = { limit: Math.min(Math.max(Number(p.limit) || 50, 1), 50) }
  if (p.cursor) query.cursor = p.cursor
  const spec = {
    base: API.DOCTOR_CONSULT_MESSAGES.base,
    path: API.DOCTOR_CONSULT_MESSAGES.path.replace('{consultationId}', String(consultationId || ''))
  }
  return get(spec, query, { rawEnvelope: true }).then((env) => {
    const items = Array.isArray(env && env.data) ? env.data : []
    const meta = (env && env.meta) || {}
    return { items, nextCursor: meta.nextCursor || '' }
  })
}

/**
 * 医生认领未分配咨询（V21，POST /api/v1/doctor/consultations/{id}/accept；写操作强校验幂等键）
 * @param {string} consultationId 会话 id
 * @returns {Promise<{replayed:boolean}>} replayed=true 表示已归属本人（幂等重放）
 */
function acceptConsultation(consultationId) {
  const spec = {
    base: API.DOCTOR_ACCEPT.base,
    path: API.DOCTOR_ACCEPT.path.replace('{consultationId}', String(consultationId || ''))
  }
  return post(spec, {}, { idempotencyKey: req.newIdempotencyKey() })
}

/**
 * 医生回复问诊（V21，POST /api/v1/consultations/{id}/doctor-reply；写操作强校验幂等键）
 * @param {string} consultationId 会话 id
 * @param {string} content        回复正文（≤2000 字）
 * @returns {Promise<{message:Object, replayed:boolean}>}
 */
function doctorReply(consultationId, content) {
  const spec = {
    base: API.DOCTOR_REPLY.base,
    path: API.DOCTOR_REPLY.path.replace('{consultationId}', String(consultationId || ''))
  }
  return post(spec, { content: String(content || '') }, { idempotencyKey: req.newIdempotencyKey() })
}

/**
 * 医生结束本次在线问诊（POST /api/v1/doctor/consultations/{id}/close）
 *
 * 服务端：status → CLOSED + 写一条 system_notice（双方可见）+ 通知患者；
 * 结束后该会话从医生「待处理列表」消失（listByDoctor 只查 ACTIVE），患者端锁输入。
 *
 * @param {string} consultationId 会话 id
 * @returns {Promise<{status:string}>} status=CLOSED；已结束 → reject(409 CONSULTATION_CLOSED)
 */
function closeConsultation(consultationId) {
  const spec = {
    base: API.DOCTOR_CONSULT_CLOSE.base,
    path: API.DOCTOR_CONSULT_CLOSE.path.replace('{consultationId}', String(consultationId || ''))
  }
  return post(spec, {}, { idempotencyKey: req.newIdempotencyKey() })
}

// 床位
function listBeds() {
  return get(API.BED_LIST)
}

function updateBed(id, status, patientName) {
  const spec = { base: API.BED_UPDATE.base, path: API.BED_UPDATE.path.replace('{id}', id) }
  return put(spec, { status, patientName: patientName || '' })
}

/**
 * 床位分配变更（契约 POST /api/v1/beds/{bedId}/assignment）
 *
 * ⚠️ 旧路径 /api/v1/bed/update/{id} 已迁移为显式动作语义 + 乐观锁（网关 compat pending）。
 *
 * @param {string} bedId            床位 id
 * @param {string} action          枚举 ASSIGN/RELEASE/RESERVE/SET_CLEANING/SET_OUT_OF_SERVICE
 * @param {number} expectedVersion 床位乐观锁版本（取列表项 version；不匹配 → 409）
 * @param {string} [patientRef]    ASSIGN 必填；其他动作忽略。用**内部患者 ID**，不接受姓名/手机号。
 * @param {{note?:string, idempotencyKey?:string}} [opts] 幂等键缺省自动生成
 */
function assignBed(bedId, action, expectedVersion, patientRef, opts) {
  const o = opts || {}
  const spec = {
    base: API.BED_ASSIGNMENT.base,
    path: API.BED_ASSIGNMENT.path.replace('{bedId}', String(bedId || ''))
  }
  const body = {
    action: String(action || ''),
    expectedVersion: Number(expectedVersion)
  }
  if (action === 'ASSIGN' && patientRef) body.patientRef = String(patientRef)
  if (o.note) body.note = String(o.note).slice(0, 200)
  return post(spec, body, { idempotencyKey: o.idempotencyKey || req.newIdempotencyKey() })
}

module.exports = {
  getDoctor, setDoctor, restore, logout,
  login, loginByWxCode, listAllDoctors, listDoctorsByDept,
  listAppointments, updateStatus, listDoctorTodos,
  listConsultations, consultationMessages, acceptConsultation, doctorReply, closeConsultation,
  getSchedule, saveSchedule, setOnlineStatus,
  listBeds, updateBed, assignBed
}
