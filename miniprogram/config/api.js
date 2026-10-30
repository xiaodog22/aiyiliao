/**
 * api.js —— API 路径注册表（页面与服务禁止硬编码路径）
 *
 * base 取值与含义（V4 网关 · 2026-10-15 修订）：
 *   'gateway'    网关自身路由（/api/gw/**）
 *   'python'     AI 能力产出（导诊/问诊/养生/语音/音色；V4 经 business 编排，客户端不直达）
 *   'java'       Spring Boot 业务产出（挂号/医生/床位/用户）
 *
 * ⚠️ python / java / gateway 三种 base 在 request.js 里解析出的**都是同一个
 *    ENV.gateway 地址**（唯一入口 :8000），base 只用于表达"这条请求最终由哪个上游处理"，
 *    便于对照网关路由表排查。前端**不得**出现 8001 / 8088。
 *
 * ⚠️ V4 网关路由：/api/gw/** 归网关自身；其余 /api/** 全量代理 business-service（统一出口，
 *    不再按旧 JAVA_PREFIXES 白名单分流）。base 仅表达"该能力最终由哪个上游产出"（供排查对照）。
 *    迁移期旧路径由网关兼容层翻译（backend/edge-gateway/COMPAT.md）；新增路径按契约登记
 *    （backend/contracts/），不得绕过网关。
 */

// ============ Java 上游（Spring Boot，经网关转发）============
const AUTH_WECHAT_LOGIN   = { base: 'java', path: '/api/v1/auth/wechat/login' }
const AUTH_REFRESH        = { base: 'java', path: '/api/v1/auth/refresh' }
const AUTH_LOGOUT         = { base: 'java', path: '/api/v1/auth/logout' }
const ME                  = { base: 'java', path: '/api/v1/me' }
// 个人信息设置扩展（V8）：联系方式/住址/实名/医保/账号改名/头像
const ME_EXTENDED         = { base: 'java', path: '/api/v1/me/extended' }
const ME_IDENTITY         = { base: 'java', path: '/api/v1/me/identity' }
const ME_INSURANCE        = { base: 'java', path: '/api/v1/me/insurance' }
const ME_ACCOUNT          = { base: 'java', path: '/api/v1/me/account' }
const ME_AVATAR           = { base: 'java', path: '/api/v1/me/avatar' }

// 旧登录路径暂保留，便于后端迁移期联调；生产构建只应使用 /api/v1/auth/**。
const USER_LOGIN          = { base: 'java', path: '/api/user/login' }
const USER_WX_LOGIN       = AUTH_WECHAT_LOGIN
const DOCTOR_LOGIN        = { base: 'java', path: '/api/v1/doctor/login' }
const DOCTOR_WX_LOGIN     = AUTH_WECHAT_LOGIN

const DEPARTMENT_LIST     = { base: 'java', path: '/api/v1/departments' }
const DEPARTMENT_DOCTORS  = { base: 'java', path: '/api/v1/departments/{id}/doctors' }
const DOCTOR_SLOTS        = { base: 'java', path: '/api/v1/doctors/{id}/slots' }
// 医生目录（CatalogController）：/api/v1/doctors 全量；/departments/{id}/doctors 按科室。
// ⚠️ 2026-10-24 修正：旧路径 /api/v1/doctor/list、/api/v1/doctor/by-department 后端不存在（404）。
const DOCTOR_LIST         = { base: 'java', path: '/api/v1/doctors' }
const DOCTOR_BY_DEPT      = { base: 'java', path: '/api/v1/departments/{id}/doctors' }

const APPOINT_SUBMIT      = { base: 'java', path: '/api/v1/appointments' }
const APPOINT_LIST        = { base: 'java', path: '/api/v1/appointments/me' }
const APPOINT_BY_KEY      = { base: 'java', path: '/api/v1/appointments/by-idempotency-key/{key}' }
// 患者取消预约（契约已实现：POST /api/v1/appointments/{id}/cancel，Idempotency-Key 必填）
const APPOINT_CANCEL      = { base: 'java', path: '/api/v1/appointments/{appointmentId}/cancel' }
// ⚠️ 遗留路径：网关 compat 为 pending（501 COMPAT_PENDING）。**仅保留迁移台账**
//    （check-v4-contracts 要求 x-migration 的 legacy 仍登记在 api.js），页面不得再调用。
const APPOINT_UPDATE      = { base: 'java', path: '/api/appoint/updateStatus' }
// 医生端（契约 M3）：医生自己的排队列表 / 状态流转（需 expectedVersion + Idempotency-Key）
const DOCTOR_APPOINTMENTS = { base: 'java', path: '/api/v1/doctor/appointments' }
const DOCTOR_APPTS_STATUS = { base: 'java', path: '/api/v1/doctor/appointments/{id}/status' }
// 医生工作台「待处理事项」卡（契约已实现，2026-10-19）
const DOCTOR_TODOS        = { base: 'java', path: '/api/v1/doctor/todos' }
// 医生问诊会话（V21 医生回复闭环，2026-10-23）：列表 / 会话消息 / 认领 / 回复
const DOCTOR_CONSULTATIONS  = { base: 'java', path: '/api/v1/doctor/consultations' }
const DOCTOR_CONSULT_MESSAGES = { base: 'java', path: '/api/v1/doctor/consultations/{consultationId}/messages' }
const DOCTOR_ACCEPT          = { base: 'java', path: '/api/v1/doctor/consultations/{consultationId}/accept' }
// 医生结束问诊（2026-10-24 收口）：status → CLOSED + 系统提示 + 患者通知
const DOCTOR_CONSULT_CLOSE   = { base: 'java', path: '/api/v1/doctor/consultations/{consultationId}/close' }
const DOCTOR_REPLY           = { base: 'java', path: '/api/v1/consultations/{consultationId}/doctor-reply' }
const BED_LIST            = { base: 'java', path: '/api/v1/beds' }
// ⚠️ 遗留路径：网关 compat 为 pending（501 COMPAT_PENDING）。**仅保留迁移台账**
//    （check-v4-contracts 要求 legacy 仍登记在 api.js）。新契约端点见 BED_ASSIGNMENT。
const BED_UPDATE          = { base: 'java', path: '/api/v1/bed/update/{id}' }
// 床位分配变更（契约 M3）：显式 action + expectedVersion + 幂等键（替代旧 bed/update）
const BED_ASSIGNMENT      = { base: 'java', path: '/api/v1/beds/{bedId}/assignment' }
const HEALTH_RECORDS      = { base: 'java', path: '/api/v1/health-records' }
const FAMILY_MEMBERS      = { base: 'java', path: '/api/v1/family-members' }
const FAMILY_MEMBER_BY_ID = { base: 'java', path: '/api/v1/family-members/{id}' }
const FAMILY_INVITATIONS  = { base: 'java', path: '/api/v1/family-members/invitations' }
// 健康档案检查资料附件（V9）：上传（multipart file）/列表/删除/匿名签名读取
const HR_ATTACHMENTS      = { base: 'java', path: '/api/v1/health-records/{recordId}/attachments' }
// 报告 AI 解读（契约已实现，2026-10-19：business-service 承接，同步返回）
const HR_INTERPRET        = { base: 'java', path: '/api/v1/health-records/{recordId}/interpret' }
const HR_ATTACHMENT_BY_ID = { base: 'java', path: '/api/v1/health-records/{recordId}/attachments/{attachmentId}' }
// 科普文章（N12/N13）：列表/详情均匿名只读；详情可能带 videoUrl（V19，签名 URL，2h TTL）
const HEALTH_ARTICLE_DETAIL = { base: 'java', path: '/api/v1/health-articles/{id}' }
const ATTACHMENT_UPLOAD   = { base: 'java', path: '/api/v1/attachments' }
const ATTACHMENT_FILE     = { base: 'java', path: '/api/v1/attachments/{objectKey}' }
const CONSULTATION_LIST   = { base: 'java', path: '/api/v1/consultations' }
// 会话详情 + 消息（GET，契约 getConsultation）：一次拿到医生卡字段与消息，重进会话可恢复
const CONSULTATION_DETAIL = { base: 'java', path: '/api/v1/consultations/{consultationId}' }
// 会话消息正文：GET 拉取历史（2026-10-19 契约补齐）/ POST 发送
const CONSULTATION_MESSAGES = { base: 'java', path: '/api/v1/consultations/{consultationId}/messages' }
// AI 分诊建议（POST，2026-10-24）：聚合会话内患者描述 → 建 TRIAGE 任务，返回 taskId（异步，轮询任务结果）
const CONSULTATION_TRIAGE = { base: 'java', path: '/api/v1/consultations/{consultationId}/triage' }
// AI 任务状态查询（GET，契约 fetchAiTask）：SUCCEEDED 时 data.result 为执行器结果
const AI_TASK             = { base: 'java', path: '/api/v1/ai/tasks/{taskId}' }
// 消息中心（V21 已上线）：列表 / 未读数 / 单条已读（写操作需 Idempotency-Key）
const MESSAGE_LIST        = { base: 'java', path: '/api/v1/messages' }
const MESSAGE_UNREAD_COUNT = { base: 'java', path: '/api/v1/messages/unread-count' }
const MESSAGE_READ        = { base: 'java', path: '/api/v1/messages/{messageId}/read' }
const RESOURCE_MANIFEST   = { base: 'java', path: '/api/v1/resources/manifest' }
// 单个资源按 key 直取（GET，匿名白名单；<image>/wx.downloadFile 无法带 Authorization）
const RESOURCE_ITEM       = { base: 'java', path: '/api/v1/resources/{key}' }
const HOME_SUMMARY        = { base: 'java', path: '/api/v1/home/summary' }

// 医生排班与在线接诊（V22，2026-10-22；后端已实现，页面待接线）：
//  GET/PUT /doctor/schedule（整体替换周模板，PUT 需 Idempotency-Key + expectedVersion）
//  POST /doctor/online-status（开/关在线接诊，下线前后端校验待回复问诊）
//  GET /doctors/{id}/availability（患者侧只读，公开；不可接诊时给 nextSlotAt）
const DOCTOR_SCHEDULE      = { base: 'java', path: '/api/v1/doctor/schedule' }
const DOCTOR_ONLINE_STATUS = { base: 'java', path: '/api/v1/doctor/online-status' }
const DOCTOR_AVAILABILITY  = { base: 'java', path: '/api/v1/doctors/{id}/availability' }

// ============ Python 上游（FastAPI，经网关转发）============
const HEALTH_CHECK        = { base: 'python', path: '/health' }
const TRIAGE_RECOMMEND    = { base: 'python', path: '/api/v1/case/recommend-department' }
const TRIAGE_EMERGENCY    = { base: 'python', path: '/api/v1/consultation/emergency/check' }
const CONSULTATION_START  = { base: 'python', path: '/api/v1/consultation/start' }
const CONSULTATION_CONT   = { base: 'python', path: '/api/v1/consultation/continue' }
const CONSULTATION_CONF   = { base: 'python', path: '/api/v1/consultation/confirm' }
const CONSULTATION_STAT   = { base: 'python', path: '/api/v1/consultation/status/{id}' }
// ⚠️ 遗留路径：同上，仅迁移台账（compat pending，501）。
const CARE_PLAN           = { base: 'python', path: '/api/v1/case/health/care-plan' }
// 契约端点 POST /api/v1/care-plans（business-service 承接，同步返回；响应为 suggestions[]，
// 不是旧接口的 day1~day3 —— 页面按新结构渲染）。
const CARE_PLAN_CREATE    = { base: 'java', path: '/api/v1/care-plans' }

// ============ 语音（Qwen3-TTS 版：engine=sidecar/local/placeholder）============
const VOICE_ASR           = { base: 'python', path: '/api/v1/voice/asr' }
const VOICE_TTS           = { base: 'python', path: '/api/v1/voice/tts' }         // 主接口（multipart）
const TTS_BACKEND         = { base: 'python', path: '/api/v1/voice/tts' }         // 兼容旧引用
const TTS_EDGE            = { base: 'python', path: '/api/v1/voice/tts/edge' }    // 【兼容别名】内部同样走 Qwen3-TTS，返回已由 mp3 变 wav
const VOICE_MODELS        = { base: 'python', path: '/api/v1/voice/models' }

// 音色管理（说明 §6.3）——**四条路径 2026-10-29 按真实契约校对**：
//   · 设默认 = PUT /voices/default（VoiceController.setDefaultVoice；POST 会 405）
//   · 保存偏好 = POST /voices（旧的 /voices/save 在契约迁移表里已标记 legacy）
//   · 试听 = POST /voices/{voiceId}/previews（旧的 /voices/preview 同为 legacy）
//   · reload 是运维动作，契约 replacement=null，不下发客户端 → 注册表里删除
const VOICE_LIST          = { base: 'java', path: '/api/v1/voice/voices' }
const VOICE_DEFAULT       = { base: 'java', path: '/api/v1/voice/voices/default' }
const VOICE_SAVE          = { base: 'java', path: '/api/v1/voice/voices' }
const VOICE_DELETE        = { base: 'java', path: '/api/v1/voice/voices/{voiceId}' }
const VOICE_PREVIEW       = { base: 'java', path: '/api/v1/voice/voices/{voiceId}/previews' }

// ============ 统一网关自身（/api/gw/**）============
const GW_VOICES           = { base: 'gateway', path: '/api/gw/voices' }           // 等价 /api/v1/voice/voices，网关域内统一取列表
const GW_HEALTH           = { base: 'gateway', path: '/api/gw/health' }
const GW_ROUTES           = { base: 'gateway', path: '/api/gw/routes' }

module.exports = {
  AUTH_WECHAT_LOGIN, AUTH_REFRESH, AUTH_LOGOUT, ME,
  ME_EXTENDED, ME_IDENTITY, ME_INSURANCE, ME_ACCOUNT, ME_AVATAR,
  USER_LOGIN, USER_WX_LOGIN,
  DOCTOR_LOGIN, DOCTOR_WX_LOGIN, DOCTOR_LIST, DOCTOR_BY_DEPT,
  DEPARTMENT_LIST, DEPARTMENT_DOCTORS, DOCTOR_SLOTS,
  APPOINT_SUBMIT, APPOINT_LIST, APPOINT_BY_KEY, APPOINT_UPDATE, APPOINT_CANCEL,
  DOCTOR_APPOINTMENTS, DOCTOR_APPTS_STATUS, DOCTOR_TODOS,
  DOCTOR_CONSULTATIONS, DOCTOR_CONSULT_MESSAGES, DOCTOR_ACCEPT, DOCTOR_CONSULT_CLOSE, DOCTOR_REPLY,
  DOCTOR_SCHEDULE, DOCTOR_ONLINE_STATUS, DOCTOR_AVAILABILITY,
  BED_LIST, BED_UPDATE, BED_ASSIGNMENT, HEALTH_RECORDS, FAMILY_MEMBERS, FAMILY_MEMBER_BY_ID, FAMILY_INVITATIONS,
  HR_ATTACHMENTS, HR_ATTACHMENT_BY_ID, ATTACHMENT_UPLOAD, ATTACHMENT_FILE, HR_INTERPRET,
  HEALTH_ARTICLE_DETAIL,
  CONSULTATION_LIST, CONSULTATION_DETAIL, CONSULTATION_MESSAGES,
  CONSULTATION_TRIAGE, AI_TASK,
  MESSAGE_LIST, MESSAGE_UNREAD_COUNT, MESSAGE_READ,
  RESOURCE_MANIFEST, RESOURCE_ITEM, HOME_SUMMARY,
  HEALTH_CHECK, TRIAGE_RECOMMEND, TRIAGE_EMERGENCY,
  CONSULTATION_START, CONSULTATION_CONT, CONSULTATION_CONF, CONSULTATION_STAT,
  CARE_PLAN, CARE_PLAN_CREATE,
  VOICE_ASR, VOICE_TTS, TTS_BACKEND, TTS_EDGE, VOICE_MODELS,
  VOICE_LIST, VOICE_DEFAULT, VOICE_SAVE, VOICE_DELETE, VOICE_PREVIEW,
  GW_VOICES, GW_HEALTH, GW_ROUTES
}
