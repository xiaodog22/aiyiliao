/**
 * user.js —— 患者端服务（V1.7 契约登录版）
 *
 * 登录走**契约路径**（真实签发会话，不再是网关 dev 替身）：
 *   POST /api/v1/auth/wechat/login
 *   请求头：X-Client-Version / X-Platform:wechat-miniprogram（契约 required，由 request.js 统一拼装）
 *   请求体：{ code, phoneCode?, consentVersion }
 *     - code：`wx.login()` 的临时 code（服务端换 openid；8~256）
 *     - phoneCode：`getPhoneNumber` 返回的动态令牌（服务端解密并加密存储；可选）
 *     - consentVersion：用户确认过的隐私政策版本
 *     ⚠️ 契约 additionalProperties:false —— 不得夹带 role / username 等契约外字段（会 400）
 *   响应：Envelope<SessionData>{ accessToken, refreshToken, expiresIn, tokenType:"Bearer", user }
 *
 * ⚠️ 登录成功后**必须** `session.setTokens(data)`：access token 只在内存、refresh 落 storage，
 *    否则后续所有受保护接口（/appointments/me、/voice/tts…）一律 401（本次修复的核心问题）。
 * ⚠️ 角色一律以服务端 `user.roles` 为准，客户端不得据其他来源判权限（契约 User.roles）。
 */
const req = require('./request.js')
const { post, get, API, withPath } = req
const session = require('./session.js')
const ENV = req.ENV

let _user = null

function getUser() { return _user }

function setUser(u) {
  _user = u
  try { wx.setStorageSync('wb_user_profile', u) } catch (e) {}
}

function logout() {
  _user = null
  try { wx.removeStorageSync('wb_user_profile') } catch (e) {}
}

function restore() {
  try { _user = wx.getStorageSync('wb_user_profile') || null } catch (e) { _user = null }
  return _user
}

/**
 * 契约 Session → 页面/全局用的 profile，并把会话落到 session。
 * @param {Object} data 契约 SessionData
 * @returns {{id,name,avatarUrl,roles,phoneBound,role}}
 */
function applySession(data) {
  const d = data || {}
  if (!d.accessToken) {
    throw Object.assign(new Error('登录响应缺少会话令牌'), { code: 'BIZ_ERROR' })
  }
  session.setTokens(d)
  const u = d.user || {}
  const profile = {
    id: u.id || '',
    name: u.displayName || '患者',
    avatarUrl: u.avatarUrl || '',
    phoneBound: !!u.phoneBound,
    // 服务端下发的角色（患者端契约恒含 PATIENT）；登录页据此判定去向，不再看点击入口的 data-role
    roles: Array.isArray(u.roles) ? u.roles : [],
    role: 'patient'
  }
  setUser(profile)
  return profile
}

/** 组装契约 WechatLoginRequest（严格按契约字段，不夹带契约外字段） */
function loginBody(code, phoneCode) {
  const body = { code: String(code || ''), consentVersion: ENV.consentVersion }
  if (phoneCode) body.phoneCode = String(phoneCode)
  return body
}

/**
 * 微信一键登录（契约路径）
 * @param {string} code        wx.login() 的临时 code
 * @param {string} [phoneCode] getPhoneNumber 的 detail.code（服务端解密手机号；可选）
 */
function loginByWxCode(code, phoneCode) {
  return post(API.USER_WX_LOGIN, loginBody(code, phoneCode)).then(applySession)
}

/**
 * 手输「手机号 + 密码」登录 —— **仅开发构建**（生产构建该入口隐藏）
 *
 * ⚠️ 契约不存在密码端点，故这里用**派生 code** 走契约登录（服务端仍真实签发会话，非伪造响应）：
 *    - code      = 'dev-user-1-manual-<手机号>' → dev 档 provider 映射 openid=dev-user-1
 *    - phoneCode = 'dev-phone-<手机号>'          → dev 档 provider 解出手机号并绑定
 *    - password **不参与校验**（dev 档无密码体系）—— 这正是该入口仅限开发构建的原因。
 * 生产只允许微信一键登录；服务端侧另有网关 legacy 登录开关兜底（默认 404）。
 */
function login(phone, password) {
  if (!ENV.legacyManualLoginEnabled) {
    return Promise.reject(Object.assign(new Error('当前版本仅支持微信一键登录'), { code: 'BAD_SPEC' }))
  }
  // dev 派生 code 必须带联调密钥，否则后端一律 403（DevLoginGuard）。本地先拦，文案可执行。
  if (!ENV.devLoginKey) {
    return Promise.reject(Object.assign(new Error('联调登录未配置密钥，请联系管理员'), { code: 'BAD_SPEC' }))
  }
  const p = String(phone || '').trim()
  return post(API.USER_WX_LOGIN, loginBody('dev-user-1-manual-' + p, 'dev-phone-' + p))
    .then(applySession)
}

/**
 * 我的预约（契约 GET /api/v1/appointments/me）
 * 后端已按认证主体在 SQL 条件内做范围过滤，**客户端不再自带 phone 过滤**
 * （前端过滤会与后端口径不一致，也可能拿不到登录主体真正的数据）。
 * 参数保留以兼容既有调用点，但不再参与过滤。
 */
function listMyAppointments() {
  return get(API.APPOINT_LIST).then((list) => {
    return Array.isArray(list) ? list : ((list && list.list) || [])
  })
}

/**
 * 取消预约（契约 POST /api/v1/appointments/{appointmentId}/cancel；写操作强校验幂等键）
 * @param {string} appointmentId 预约 id
 * @param {string} [reason] 可选取消原因（≤100）
 * @returns {Promise<Object>} 契约 AppointmentData（终态重复取消返回 200 同终态；不可取消 → 409）
 */
function cancelAppointment(appointmentId, reason) {
  const spec = {
    base: API.APPOINT_CANCEL.base,
    path: API.APPOINT_CANCEL.path.replace('{appointmentId}', String(appointmentId || ''))
  }
  const body = {}
  if (reason) body.reason = String(reason).slice(0, 100)
  return post(spec, body, { idempotencyKey: req.newIdempotencyKey() })
}

/** 契约列表响应统一成数组（data 即数组；兼容 {list:[]} / {items:[]} 包裹形状） */
function asList(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.list)) return data.list
  if (data && Array.isArray(data.items)) return data.items
  return []
}

/**
 * 当前用户（契约 GET /api/v1/me → UserData）
 * 字段：id / displayName / avatarUrl / profileCompleteness / roles / phoneBound / createdAt / updatedAt
 * ⚠️ 不含手机号明文与性别/生日（契约 additionalProperties:false）；页面按"未返回字段不显示"处理。
 */
function getMe() {
  return get(API.ME)
}

/** 健康档案（GET /api/v1/health-records → HealthRecordData[]：category/title/summary/recordedAt…） */
function listHealthRecords() {
  return get(API.HEALTH_RECORDS).then(asList)
}

// ==================== 健康档案检查资料附件（V9） ====================

/**
 * 上传检查资料并挂到既有档案（POST /api/v1/health-records/{recordId}/attachments，multipart file）
 * @param {string} recordId 档案 id
 * @param {string} filePath 本地临时文件路径（wx.chooseMedia 返回的 tempFilePath）
 * @returns {Promise<AttachmentData>} { objectKey, url（短期签名）, fileName, mime, size, sha256, createdAt }
 */
function uploadAttachment(recordId, filePath) {
  const spec = withPath(API.HR_ATTACHMENTS, { recordId: String(recordId || '') })
  return req.uploadFile(spec, filePath, 'file', {}, {
    idempotencyKey: req.newIdempotencyKey(),
    timeout: 60000
  })
}

/** 附件列表（GET .../attachments → AttachmentData[]；url 为短期签名，过期后重新拉取） */
function listAttachments(recordId) {
  const spec = withPath(API.HR_ATTACHMENTS, { recordId: String(recordId || '') })
  return get(spec).then(asList)
}

/** 删除附件（DELETE .../attachments/{attachmentId}；页面负责二次确认） */
function deleteAttachment(recordId, attachmentId) {
  const spec = withPath(API.HR_ATTACHMENT_BY_ID, {
    recordId: String(recordId || ''),
    attachmentId: String(attachmentId || '')
  })
  return req.del(spec)
}

/** 附件短期签名 URL（相对路径）→ 完整 URL（<image> 组件需要绝对地址；空值原样返回） */
function resolveAttachmentUrl(attachmentUrl) {
  const u = String(attachmentUrl || '')
  if (!u) return ''
  if (/^https?:\/\//.test(u)) return u
  if (u.charAt(0) === '/') return ENV.gateway + u
  return u
}

/** 家庭成员（GET /api/v1/family-members → FamilyMemberData[]：displayName/relation/ageBand/proxyStatus…） */
function listFamilyMembers() {
  return get(API.FAMILY_MEMBERS).then(asList)
}

/** 添加家庭成员（POST /api/v1/family-members；displayName/relation 必填，ageBand/phone 可选；契约要求幂等键） */
function createFamilyMember(payload) {
  return post(API.FAMILY_MEMBERS, payload, { idempotencyKey: req.newIdempotencyKey() })
}

/** 移除家庭成员（DELETE /api/v1/family-members/{id}；路径占位走 api.js 注册表） */
function removeFamilyMember(id) {
  return req.del(withPath(API.FAMILY_MEMBER_BY_ID, { id: String(id || '') }))
}

/** 我的问诊/咨询（GET /api/v1/consultations → ConsultationData[]） */
function listMyConsultations() {
  return get(API.CONSULTATION_LIST).then(asList)
}

/**
 * 发起问诊会话（POST /api/v1/consultations → OkConsultationCreated）
 * @param {{initialMessage: string, inputMode?: string, requestedProfile?: string, locale?: string}} payload 契约 ConsultationCreate
 * @param {{idempotencyKey?: string}} [opts]
 *   ⚠️ 契约 additionalProperties:false —— 不得夹带契约外字段（会 400）。
 */
function createConsultation(payload, opts) {
  const key = (opts && opts.idempotencyKey) || req.newIdempotencyKey()
  return post(API.CONSULTATION_LIST, payload || {}, { idempotencyKey: key })
}

/**
 * AI 解读报告（POST /api/v1/health-records/{recordId}/interpret → Interpretation）
 * ⚠️ 写操作契约：缺 Idempotency-Key 后端直接 400（PatientController.interpretRecord）；
 *    后端未实现时返回 501；页面须显示可见降级提示，不得本地编造解读内容。
 */
function interpretRecord(recordId) {
  return post(withPath(API.HR_INTERPRET, { recordId: recordId }), { scope: 'SUMMARY' },
    { idempotencyKey: req.newIdempotencyKey() })
}

/**
 * 问诊会话详情 + 消息（GET /api/v1/consultations/{consultationId} → Consultation & {messages}）。
 * 契约 getConsultation：一次拿到医生卡字段（doctorName/doctorTitle/departmentName/accepting）
 * 与已分页的消息，避免「列表 + 消息」两次往返。
 * ⚠️ 后端未实现（501/404）时由页面回退到 listMyConsultations + listConsultationMessages，
 *    不在此处静默兜底 —— 调用方要能区分「会话不存在」与「接口未实现」。
 */
function getConsultation(consultationId) {
  return get(withPath(API.CONSULTATION_DETAIL, { consultationId }))
}

/**
 * 问诊会话消息正文（GET /api/v1/consultations/{consultationId}/messages → Message[]）。
 * ⚠️ 契约 2026-10-19 补齐：此前只有 POST 发送端，重进会话无法恢复历史消息。
 *    后端未实现时返回 501 —— 页面必须显示**可见的降级提示**，
 *    不得用本地假数据冒充历史消息（违反「禁止伪造业务数据」红线）。
 */
function listConsultationMessages(consultationId) {
  return get(withPath(API.CONSULTATION_MESSAGES, { consultationId })).then(asList)
}

/**
 * 发送问诊消息（POST /api/v1/consultations/{consultationId}/messages → OkMessageSent）
 * @param {string} consultationId
 * @param {{content: string, inputMode?: string, requestedProfile?: string, confirmedInputId?: string}} payload 契约 MessageCreate
 * @param {{idempotencyKey?: string}} [opts]
 *   ⚠️ **超时/断网重试必须复用同一键**：服务端按键去重，每次新建键会把
 *   「超时后用户重点一次」当作两条真实消息。
 */
function sendConsultationMessage(consultationId, payload, opts) {
  const key = (opts && opts.idempotencyKey) || req.newIdempotencyKey()
  return post(withPath(API.CONSULTATION_MESSAGES, { consultationId }), payload || {}, { idempotencyKey: key })
}

/**
 * 提交挂号（一键挂号：导诊结果直达）—— 契约写操作要求 Idempotency-Key
 * @param {object} payload 契约 AppointmentCreate（slotId + patientName…）
 * @param {object} [opts] { idempotencyKey }
 *   ⚠️ **超时/断网重试必须复用同一键**：服务端按键去重，若每次都新建键，
 *   用户"超时后重点一次"会被当成两笔真实挂号（医疗场景的重复预约）。
 *   不传则由本方法新建（单次调用语义）。
 */
function submitAppointment(payload, opts) {
  const key = (opts && opts.idempotencyKey) || req.newIdempotencyKey()
  return post(API.APPOINT_SUBMIT, payload, { idempotencyKey: key })
}

// ==================== 个人信息设置扩展（V8） ====================

/** 医生目录（患者端只读，GET /api/v1/doctors → DoctorData[]） */
function listCatalogDoctors() {
  return get(API.DOCTOR_LIST)
}

/** 科室目录（GET /api/v1/departments → DepartmentData[]） */
function listDepartments() {
  return get(API.DEPARTMENT_LIST)
}

/** 消息中心：列表（GET /api/v1/messages → Message[]，含未读标记） */
function listMessages() {
  return get(API.MESSAGE_LIST)
}

/** 消息中心：未读数（GET /api/v1/messages/unread-count → 裸数字） */
function unreadCount() {
  return get(API.MESSAGE_UNREAD_COUNT)
}

/** 消息中心：标记已读（POST /api/v1/messages/{messageId}/read；写操作需幂等键） */
function markMessageRead(messageId) {
  return post(withPath(API.MESSAGE_READ, { messageId: String(messageId || '') }), {},
    { idempotencyKey: req.newIdempotencyKey() })
}

/** 个人信息扩展资料（GET /api/v1/me/extended）：邮箱/住宅/户籍 + 证件号/医保号掩码与绑定状态 */
function getExtendedProfile() {
  return get(API.ME_EXTENDED)
}

/** 更新联系方式/住址（PUT /api/v1/me/extended；null 字段保留原值） */
function updateExtendedProfile(payload) {
  return req.put(API.ME_EXTENDED, payload || {})
}

/** 身份证实名绑定（POST /api/v1/me/identity；服务端做 GB 11643 校验码验证） */
function bindIdentity(name, idCardNumber) {
  return post(API.ME_IDENTITY, { name: String(name || '').trim(), idCardNumber: String(idCardNumber || '').trim() },
    { idempotencyKey: req.newIdempotencyKey() })
}

/** 医保绑定（POST /api/v1/me/insurance；类型受后端枚举约束） */
function bindInsurance(insuranceType, insuranceNo) {
  return post(API.ME_INSURANCE, { insuranceType, insuranceNo: String(insuranceNo || '').trim() },
    { idempotencyKey: req.newIdempotencyKey() })
}

/** 账号改名（PUT /api/v1/me/account；返回更新后的契约 User） */
function updateAccount(displayName) {
  return req.put(API.ME_ACCOUNT, { displayName: String(displayName || '').trim() })
}

/** 头像上传（POST /api/v1/me/avatar multipart；返回更新后的契约 User，avatarUrl 为站内相对路径） */
function uploadAvatar(filePath) {
  return req.uploadFile(API.ME_AVATAR, filePath, 'file', {}, { timeout: 30000 })
}

/** 头像相对路径 → 完整 URL（<image> 组件需要绝对地址；空值原样返回） */
/**
 * 头像地址解析（远端绝对 URL 优先 → 站内相对路径拼网关 → 空值给默认头像）。
 *
 * ⚠️ 空值必须返回**包内默认头像**而不是空串：`<image src="">` 在部分机型会渲染成
 * 一个空白灰块（比不渲染更难看），而 `wx:if="{{avatarUrl}}"` 又会让布局抖动。
 * 返回包内路径后，调用方可以直接渲染，无需再判空。
 */
const DEFAULT_AVATAR = '/assets/img/avatar-default.png'

function resolveAvatar(avatarUrl) {
  const u = String(avatarUrl || '')
  if (!u) return DEFAULT_AVATAR
  if (/^https?:\/\//.test(u)) return u
  if (u.charAt(0) === '/') return ENV.gateway + u
  return u
}

module.exports = {
  getUser, setUser, restore, logout,
  login, loginByWxCode, listMyAppointments, submitAppointment, cancelAppointment,
  getMe, listHealthRecords, listFamilyMembers, createFamilyMember, removeFamilyMember, listMyConsultations, getConsultation, createConsultation, listConsultationMessages, sendConsultationMessage,
  listCatalogDoctors, listDepartments, listMessages, unreadCount, markMessageRead,
  interpretRecord,
  uploadAttachment, listAttachments, deleteAttachment, resolveAttachmentUrl,
  getExtendedProfile, updateExtendedProfile, bindIdentity, bindInsurance, updateAccount, uploadAvatar, resolveAvatar,
  // 幂等键工厂：页面需要"跨重试复用同一键"时自行持有（见 appointment.onSubmit）
  newIdempotencyKey: req.newIdempotencyKey
}
