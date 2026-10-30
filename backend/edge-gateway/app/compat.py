"""legacy 兼容层：迁移期把旧客户端路径翻译到新契约路径。

原则（docs/v4/08 §6）：
- 单一实现：新服务只实现契约路径，legacy 不复制进服务内部，全部在网关这一层承接。
- 每条都标注 deprecated 与移除条件（前端迁移完成即删）。
- 不能等价转发的，返回明确错误 + 迁移说明（不造假数据）。
- 本表与 `x-migration`、`api.js` 保持同步，活跃表见 COMPAT.md。
"""

from __future__ import annotations

import json
from typing import Optional

from .envelope import ApiError, compat_dropped, compat_pending

# kind:
#   self        → 由网关自身处理
#   forward     → 改写路径后原样转发（请求/响应均不改）
#   translate   → 改写路径 + 请求体翻译（translator 见下）
#   pending     → 未完成迁移：501 + 迁移说明
#   dropped     → 已废弃：410 + 说明
#   same_path   → 同路径直通（仅登记，catch-all 自然覆盖）
_BED_UPDATE_BLOCKERS = [
    "目标契约要求 action 枚举（ASSIGN/RELEASE/RESERVE/…）；legacy 仅传 status 文案，动作语义需推断",
    "目标契约要求 expectedVersion（乐观锁，required）；legacy 无版本号",
    "目标 patientRef 必须为内部患者 ID，契约明令不接受姓名/手机号；legacy 仅传 patientName——透传将违反隐私约定",
    "目标契约要求 Idempotency-Key 请求头；legacy 不发送",
    "方法不一致：前端实际以 PUT 调用，x-migration 登记为 POST",
]

ENTRIES = [
    {"method": "GET", "path": "/health", "kind": "self", "target": "/api/gw/health",
     "status": "active", "note": "探针路径收敛到网关（x-migration）"},
    {"method": "POST", "path": "/api/v1/consultation/emergency/check", "kind": "translate",
     "target": "/api/v1/triage/emergency-checks", "translator": "text_query_to_body",
     "responseAdapter": "emergency_legacy_view",
     "status": "active", "note": "旧前端把 text 放在 query；响应恢复遗留字段（is_emergency/risk_level/emergency_message 等）+ 信封 code=200（M1 校准）"},
    {"method": "POST", "path": "/api/v1/case/recommend-department", "kind": "translate",
     "target": "/api/v1/triage/recommendations", "translator": "text_body_to_symptoms",
     "responseAdapter": "recommend_legacy_view",
     "status": "active", "note": "{text}→{symptoms}；响应补 clinic/reason 遗留字段 + 信封 code=200（M1 校准）"},
    {"method": "POST", "path": "/api/v1/voice/tts/edge", "kind": "forward",
     "target": "/api/v1/voice/tts", "status": "active", "note": "兼容别名：引擎由服务端配置决定"},
    {"method": "POST", "path": "/api/v1/voice/voices/save", "kind": "forward",
     "target": "/api/v1/voice/voices", "status": "active", "note": "资源化：POST 集合表示保存偏好"},
    {"method": "GET", "path": "/api/v1/voice/models", "kind": "same_path",
     "status": "active", "note": "路径不变；语义改由业务侧返回能力状态"},
    {"method": "DELETE", "prefix": "/api/v1/voice/voices/", "kind": "same_path",
     "status": "active", "note": "路径形状相同，参数名统一为 voiceId 由业务侧承接"},
    {"method": "POST", "path": "/api/v1/voice/voices/preview", "kind": "pending", "milestone": "M2",
     "note": "迁移为 /api/v1/voice/voices/{voiceId}/previews（固定示例文本，避免任意合成通道）"},
    {"method": "POST", "path": "/api/v1/voice/voices/reload", "kind": "dropped",
     "note": "运维动作不再下发给客户端（x-migration: replacement=null），改由管理面/进程信号触发"},
    {"method": "POST", "path": "/api/v1/consultation/start", "kind": "pending", "milestone": "M2",
     "note": "迁移为 POST /api/v1/consultations（返回会话与任务两个对象）"},
    {"method": "POST", "path": "/api/v1/consultation/continue", "kind": "pending", "milestone": "M2",
     "note": "迁移为 POST /api/v1/consultations/{consultationId}/messages"},
    {"method": "POST", "path": "/api/v1/consultation/confirm", "kind": "pending", "milestone": "M2",
     "note": "迁移为 POST /api/v1/consultations/{consultationId}/confirmations"},
    {"method": "GET", "prefix": "/api/v1/consultation/status/", "kind": "pending", "milestone": "M2",
     "note": "迁移为 GET /api/v1/ai/tasks/{taskId}"},
    {"method": "POST", "path": "/api/v1/case/health/care-plan", "kind": "pending", "milestone": "M2",
     "note": "迁移为 POST /api/v1/care-plans（输出为生活方式建议，不构成处方）"},
    {"method": "GET", "path": "/api/v1/doctor/list", "kind": "translate",
     "target": "/api/v1/doctors", "translator": None, "dropQuery": True,
     "responseAdapter": "doctor_list_legacy_view",
     "status": "active", "note": "全局医生列表由 GET /api/v1/doctors 承接（契约迁移口径为科室挂载）；响应按旧端字段 department/expertise/status 补齐"},
    {"method": "GET", "path": "/api/v1/doctor/by-department", "kind": "translate",
     "target": "/api/v1/doctors", "translator": None, "dropQuery": True,
     "responseAdapter": "doctor_by_department_legacy_view",
     "status": "active", "note": "同上；legacy 参数是科室名（dept=），本层按 departmentName/departmentId 过滤"},
    # ---- M3 医生端（不可等价转发：以下条目保持 pending，返回明确迁移说明，不代填、不伪造）----
    {"method": "POST", "path": "/api/appoint/updateStatus", "kind": "pending", "milestone": "M3",
     "blockers": [
         "目标契约要求 expectedVersion（乐观锁，required）；legacy 请求体仅 {id,status}，无版本号——代填即等于伪造并发控制",
         "legacy 状态文案（待就诊/就诊中/已完成）与契约 AppointmentStatus 枚举不可双射：契约无「就诊中」态",
         "目标契约要求 Idempotency-Key 请求头；legacy 客户端 request.js 不发送",
     ],
     "note": "迁移为 POST /api/v1/doctor/appointments/{appointmentId}/status（乐观锁版本）；因缺 version/枚举不可双射/缺幂等头，**不可等价转发**，前端须迁移（不代填版本）"},
    {"method": "PUT", "prefix": "/api/v1/bed/update/", "kind": "pending", "milestone": "M3",
     "blockers": _BED_UPDATE_BLOCKERS,
     "note": "迁移为 POST /api/v1/beds/{bedId}/assignment（显式 action + expectedVersion）；多条不可等价，**不可转发**。本条按前端**实际方法 PUT** 注册（x-migration 记为 POST，方法差异已登记待 M 侧统一）"},
    {"method": "POST", "prefix": "/api/v1/bed/update/", "kind": "pending", "milestone": "M3",
     "blockers": _BED_UPDATE_BLOCKERS,
     "note": "同 PUT 条目：x-migration 声明为 POST，一并注册以避免落到上游 404（迁移为 POST /api/v1/beds/{bedId}/assignment）"},
    {"method": "POST", "path": "/api/user/login", "kind": "translate",
     "target": "/api/v1/auth/wechat/login", "translator": "legacy_login_to_wechat",
     "headerOverrides": {"X-Client-Version": "legacy-compat", "X-Platform": "wechat-miniprogram"},
     "responseAdapter": "legacy_login_view",
     "devOnly": True,
     "status": "active", "note": "dev 联调替身：{phone}→dev 微信登录换取（不做密码校验）；生产构建不得使用（x-migration）。X-Platform 必须为契约 const wechat-miniprogram（2026-10-15 修正：原 miniprogram-legacy 被 M 侧 const 校验拒绝 → 422）。2026-10-16：本条目挂 devOnly 标记，由 compat.legacyLoginEnabled / GW_LEGACY_LOGIN_ENABLED 控制，未显式开启即 404（生产安全默认）"},
]

_EXACT: dict[tuple[str, str], dict] = {}
_PREFIX: list[dict] = []
for _entry in ENTRIES:
    if _entry["kind"] in ("same_path",):
        continue
    if "prefix" in _entry:
        _PREFIX.append(_entry)
    else:
        _EXACT[(_entry["method"], _entry["path"])] = _entry


def match(method: str, path: str) -> Optional[dict]:
    """返回命中的兼容条目；未命中返回 None（走常规代理）。"""
    entry = _EXACT.get((method.upper(), path))
    if entry is not None:
        return entry
    for candidate in _PREFIX:
        if method.upper() == candidate["method"] and path.startswith(candidate["prefix"]):
            return candidate
    return None


def raise_for(entry: dict) -> None:
    """对 pending/dropped 条目给出明确错误（不造假数据）。

    `blockers`（可选）：逐条列出「不可等价转发」的技术原因，随错误 details 返回，
    便于前端/联调方判断为何不能自动翻译——不代填缺失字段、不伪造数据。
    """
    if entry["kind"] == "pending":
        raise compat_pending(entry.get("milestone", "待定"), entry.get("note", ""), entry.get("blockers"))
    if entry["kind"] == "dropped":
        raise compat_dropped(entry.get("note", ""))


def translate_body(entry: dict, path: str, query: dict, body: bytes) -> tuple[bytes, Optional[str]]:
    """执行请求体翻译。返回 (新 body, content_type)；翻译条件不满足时原样返回。

    翻译只做**无歧义**的形状收敛，不猜测业务语义。
    """
    translator = entry.get("translator")
    if translator is None:
        return body, None
    if translator == "text_query_to_body":
        text = (query.get("text") or [""])[0] if isinstance(query.get("text"), list) else (query.get("text") or "")
        if text:
            return json.dumps({"text": text}, ensure_ascii=False).encode("utf-8"), "application/json"
        return body, None
    if translator == "text_body_to_symptoms":
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except (ValueError, UnicodeDecodeError):
            return body, None
        if isinstance(payload, dict) and "text" in payload and "symptoms" not in payload:
            payload["symptoms"] = str(payload.pop("text"))
            return json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json"
        return body, None
    if translator == "legacy_login_to_wechat":
        return _legacy_login_to_wechat(body)
    raise ApiError(500, "COMPAT_TRANSLATOR_MISSING", f"兼容翻译器未实现：{translator}", retryable=False)


def _legacy_login_to_wechat(body: bytes) -> tuple[bytes, Optional[str]]:
    """`/api/user/login {phone, password}` → dev 档微信登录换取。

    ⚠️ 联调替身语义（生产构建不得使用，x-migration 已声明）：
    - 本机联调没有真实微信凭证，走 business-service 的 **dev 档** WechatSessionProvider；
    - `password` 不做校验（dev 档无密码体系）——只按 phone 建立稳定 dev 会话；
    - `phoneCode` 用 `dev-phone-<手机号>`，与 dev 档 provider 的约定一致（11 位则绑定）。
    """
    try:
        payload = json.loads(body.decode("utf-8")) if body else {}
    except (ValueError, UnicodeDecodeError):
        return body, None
    if not isinstance(payload, dict) or not payload.get("phone"):
        return body, None
    phone = str(payload.get("phone")).strip()
    new_payload = {
        "code": "legacy-compat-" + phone,
        "phoneCode": "dev-phone-" + phone,
        "consentVersion": "legacy-compat-dev",
    }
    return json.dumps(new_payload, ensure_ascii=False).encode("utf-8"), "application/json"


# ==========================================================================
# 响应适配（M1）：新契约响应 → 遗留客户端可消费形状
# ==========================================================================
# 约定：
# - 只作用于 **2xx + application/json** 响应；其余（错误/二进制/流式）原样透传。
# - 适配是**加字段**（保留新字段）+ 信封降级（code:"OK" → code:200），不删除原始信息。
# - 适配失败（结构不符/解析失败）时**原样透传**并告警，绝不中断用户链路。


def _legacy_ok_envelope(doc: dict, data) -> dict:
    """契约成功信封（code:"OK"）→ 遗留客户端信封（code:200）。

    旧前端 request.js 的 unwrap 只认 code===200/'200'/0/'0'；契约口径是字符串 \"OK\"。
    兼容层为 legacy 条目恢复数字 200，并保留 requestId/serverTime 供排障。
    """
    out = {
        "code": 200,
        "msg": str(doc.get("message") or "成功"),
        "message": str(doc.get("message") or "成功"),
        "data": data,
    }
    if doc.get("requestId") is not None:
        out["requestId"] = doc["requestId"]
    if doc.get("serverTime") is not None:
        out["serverTime"] = doc["serverTime"]
    return out


def emergency_legacy_view(doc: dict, query: dict) -> Optional[dict]:
    """急诊检查：契约 {emergency,level,matchedRules,advice} → 旧端字段（加字段式）。

    - `risk_level`：emergency=true → "high"（旧端 `=== 'high'` 判定与 `is_emergency` 双保险）；
      非紧急透传小写 level（urgent/caution/info），旧端不识别也不会误报。
    - `emergency_message`→advice、`matched_keywords`→matchedRules、`safe`=!emergency。
    """
    data = doc.get("data")
    if not isinstance(data, dict):
        return None
    emergency = bool(data.get("emergency"))
    level = str(data.get("level") or "").lower()
    adapted = dict(data)
    adapted["is_emergency"] = emergency
    adapted["risk_level"] = "high" if emergency else level
    adapted["emergency_message"] = data.get("advice")
    adapted["matched_keywords"] = data.get("matchedRules") or []
    adapted["safe"] = not emergency
    return _legacy_ok_envelope(doc, adapted)


def recommend_legacy_view(doc: dict, query: dict) -> Optional[dict]:
    """科室推荐：契约 {recommendedDepartments:[...],guidance} → 旧端字段。

    旧端读取 `clinic/department/dept` 与 `reason`（取首个推荐科室）。
    无推荐科室时 clinic 为空串 → 旧端回退本地规则（符合「远端补充档」语义）。
    """
    data = doc.get("data")
    if not isinstance(data, dict):
        return None
    deps = data.get("recommendedDepartments")
    first = deps[0] if isinstance(deps, list) and deps and isinstance(deps[0], dict) else {}
    clinic = str(first.get("departmentName") or "").strip()
    reason = str(first.get("reason") or "").strip() or str(data.get("guidance") or "").strip()
    adapted = dict(data)
    adapted["clinic"] = clinic
    adapted["department"] = clinic
    adapted["dept"] = clinic
    adapted["reason"] = reason
    adapted["advice"] = data.get("guidance")
    return _legacy_ok_envelope(doc, adapted)


def _doctor_legacy_item(item: dict) -> dict:
    """契约 Doctor → 旧端医生条目（保留新字段 + 补 department/expertise/status）。"""
    out = dict(item)
    out["department"] = item.get("departmentName") or item.get("departmentId") or ""
    specs = item.get("specialties")
    if isinstance(specs, list):
        out["expertise"] = "、".join(str(s) for s in specs if s)
    else:
        out["expertise"] = ""
    has = item.get("hasAvailableSlot")
    out["status"] = "可预约" if has is True else ("约满" if has is False else "")
    return out


def doctor_list_legacy_view(doc: dict, query: dict) -> Optional[dict]:
    """医师全局列表：契约 List<Doctor> → 旧端 [{name,department,title,expertise,status}]。"""
    data = doc.get("data")
    if not isinstance(data, list):
        return None
    return _legacy_ok_envelope(doc, [_doctor_legacy_item(x) for x in data if isinstance(x, dict)])


def doctor_by_department_legacy_view(doc: dict, query: dict) -> Optional[dict]:
    """按科室过滤的医生列表：legacy 参数为科室名（dept=）或科室 ID。

    在网关层对全局列表做真实数据过滤（不改数据、不伪造）；空 dept 表示不过滤。
    """
    data = doc.get("data")
    if not isinstance(data, list):
        return None
    wanted = str(query.get("dept") or query.get("department") or query.get("departmentId") or "").strip()
    items = [x for x in data if isinstance(x, dict)]
    if wanted:
        items = [x for x in items if x.get("departmentName") == wanted or x.get("departmentId") == wanted]
    return _legacy_ok_envelope(doc, [_doctor_legacy_item(x) for x in items])


def legacy_login_view(doc: dict, query: dict) -> Optional[dict]:
    """登录：契约 Session → 旧端扁平形状 {code:200, msg, name, userId}。

    ⚠️ 刻意**不带 data 字段**：旧端 unwrap 命中 code===200 后若存在 data 会优先取 data，
    导致页面读不到 name/userId。旧端行为就是「扁平对象」，此处严格对齐（令牌不落旧端）。
    """
    data = doc.get("data")
    if not isinstance(data, dict):
        return None
    user = data.get("user") if isinstance(data.get("user"), dict) else {}
    name = str(user.get("displayName") or user.get("nickname") or user.get("name") or "用户")
    user_id = user.get("id") or user.get("userId") or ""
    out = {"code": 200, "msg": "登录成功", "name": name, "userId": user_id}
    if doc.get("requestId") is not None:
        out["requestId"] = doc["requestId"]
    return out


RESPONSE_ADAPTERS = {
    "emergency_legacy_view": emergency_legacy_view,
    "recommend_legacy_view": recommend_legacy_view,
    "doctor_list_legacy_view": doctor_list_legacy_view,
    "doctor_by_department_legacy_view": doctor_by_department_legacy_view,
    "legacy_login_view": legacy_login_view,
}


def drops_query(entry: dict) -> bool:
    """legacy 请求的 query 是否由本层消化（不向上游透传）。"""
    return bool(entry.get("dropQuery")) or entry.get("translator") == "text_query_to_body"


def response_adapter_for(entry: dict, query: dict):
    """构造响应适配闭包；条目未声明适配器时返回 None（走原样透传）。"""
    name = entry.get("responseAdapter")
    if not name:
        return None
    fn = RESPONSE_ADAPTERS.get(name)
    if fn is None:
        raise ApiError(500, "COMPAT_ADAPTER_MISSING", f"响应适配器未实现：{name}", retryable=False)

    def _adapted(doc: dict) -> Optional[dict]:
        return fn(doc, query)

    return _adapted
