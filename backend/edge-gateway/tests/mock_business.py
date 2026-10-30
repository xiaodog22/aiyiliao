"""联调替身（MOCK）—— 仅测试用途，模拟 business-service 的最小行为。

**不是业务实现**：用于 edge-gateway 的代理/兼容层验证与本地联调排障。
M1 起提供契约形状的关键端点（triage / catalog / auth），其余路径走回声兜底。

启动：backend/edge-gateway/.venv/Scripts/python.exe -m uvicorn tests.mock_business:app --port 8088
"""

from __future__ import annotations

import json

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="mock-business (test double)")


def _ok(request: Request, data):
    return {"code": "OK", "message": "成功",
            "requestId": request.headers.get("x-request-id") or "mock",
            "serverTime": "2026-10-15T00:00:00Z", "data": data}


def _err(status: int, code: str, message: str, request: Request):
    return JSONResponse(
        {"code": code, "message": message, "requestId": request.headers.get("x-request-id") or "mock",
         "retryable": False, "serverTime": "2026-10-15T00:00:00Z"},
        status_code=status,
    )


@app.get("/actuator/health")
async def health():
    return {"status": "UP"}


# ---------- M1 契约形状端点（供兼容层集成测试与本地排障） ----------

_DOCTORS = [
    {"id": "doc-1", "name": "张医生", "departmentId": "d-1", "departmentName": "消化内科",
     "title": "主任医师", "specialties": ["胃炎", "肠炎"], "introduction": "从业 20 年", "hasAvailableSlot": True},
    {"id": "doc-2", "name": "李医生", "departmentId": "d-1", "departmentName": "消化内科",
     "title": "副主任医师", "specialties": [], "hasAvailableSlot": False},
    {"id": "doc-3", "name": "王医生", "departmentId": "d-2", "departmentName": "骨科",
     "title": "主治医师", "specialties": ["骨折"], "hasAvailableSlot": None},
]


@app.post("/api/v1/triage/emergency-checks")
async def emergency_checks(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 —— 联调替身对坏体宽容，统一走 422 契约错误
        body = {}
    text = str(body.get("text") or "")
    if not text:
        return _err(422, "VALIDATION_FAILED", "缺少 text", request)
    emergency = any(word in text for word in ("胸", "压榨", "呼吸困难"))
    data = {
        "emergency": emergency,
        "level": "EMERGENCY" if emergency else "INFO",
        "matchedRules": ["胸痛"] if emergency else [],
        "rulesetVersion": "TRIAGE-RULES-MOCK",
        "advice": "立即拨打 120 或前往急诊" if emergency else None,
    }
    return _ok(request, data)


@app.post("/api/v1/triage/recommendations")
async def recommendations(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    symptoms = str(body.get("symptoms") or "")
    if not symptoms:
        return _err(422, "VALIDATION_FAILED", "缺少 symptoms", request)
    deps = []
    if any(word in symptoms for word in ("肚", "腹", "拉", "泻", "胃")):
        deps.append({"departmentId": "d-1", "departmentName": "消化内科",
                     "reason": "症状提示消化道问题", "provenance": "RULE_RESULT", "confidence": 0.8})
    if any(word in symptoms for word in ("腿", "骨", "摔")):
        deps.append({"departmentId": "d-2", "departmentName": "骨科",
                     "reason": "症状提示骨骼肌肉问题", "provenance": "RULE_RESULT", "confidence": 0.7})
    data = {
        "safety": {"emergency": False, "level": "INFO", "message": "未命中急症红旗规则。",
                   "provenance": "RULE_RESULT", "rulesetVersion": "TRIAGE-RULES-MOCK"},
        "recommendedDepartments": deps,
        "guidance": "建议提前预约就诊，遵医嘱完善检查。" if deps else None,
        "limitations": "本结果为规则/AI 辅助建议，不构成诊断。",
    }
    return _ok(request, data)


@app.get("/api/v1/doctors")
async def list_doctors(request: Request):
    return _ok(request, _DOCTORS)


@app.post("/api/v1/auth/wechat/login")
async def wechat_login(request: Request):
    if not request.headers.get("x-client-version") or not request.headers.get("x-platform"):
        return _err(400, "BAD_REQUEST", "缺少 X-Client-Version / X-Platform 头", request)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    if not body.get("code") or not body.get("consentVersion"):
        return _err(422, "VALIDATION_FAILED", "缺少 code / consentVersion", request)
    phone_code = str(body.get("phoneCode") or "")
    last4 = phone_code[-4:] if phone_code.startswith("dev-phone-") and len(phone_code) >= 4 else None
    data = {
        "accessToken": "mock-access-token", "refreshToken": "mock-refresh-token-0001",
        "expiresIn": 7200, "tokenType": "Bearer",
        "user": {"id": "u-dev-1", "displayName": "开发用户甲", "roles": ["PATIENT"]},
        "phoneBound": last4 is not None, "phoneLast4": last4,
    }
    return _ok(request, data)


@app.get("/api/v1/me")
async def me(request: Request):
    """鉴权透传 / 401 透传的验证端点（联调替身，M4 收口用）：
    - 回显收到的 Authorization：钉死"网关只透传、不解析也不改写鉴权头"；
    - `Bearer at-mock-401` → 401 统一错误信封：钉死"上游 401 原样透传"。
    """
    auth = request.headers.get("authorization") or ""
    if auth == "Bearer at-mock-401":
        return _err(401, "UNAUTHORIZED", "未登录或登录态无效", request)
    return _ok(request, {"id": "u-dev-1", "displayName": "开发用户甲",
                         "roles": ["PATIENT"], "authorization": auth})


# ---------- M2：SSE 事件流（D2.2 语义：阶段名而非百分比；不缓冲） ----------

@app.get("/api/v1/ai/tasks/{task_id}/events")
async def task_events(task_id: str, request: Request):
    """SSE 替身：分块下发 accepted / status / completed，并带「不缓冲」响应头。"""

    async def gen():
        yield b"event: accepted\ndata: {\"taskId\":\"" + task_id.encode() + b"\",\"status\":\"QUEUED\"}\n\n"
        yield b"event: status\ndata: {\"progressPhase\":\"generation\"}\n\n"
        yield b"event: completed\ndata: {\"status\":\"SUCCEEDED\"}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


# ---------- 兜底回声（其余路径） ----------

@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
)
async def echo(request: Request, path: str):
    raw = await request.body()
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = raw.decode("utf-8", "replace")
    return JSONResponse(
        _ok(request, {
            "method": request.method,
            "path": "/" + path,
            "query": str(request.url.query),
            "contentType": request.headers.get("content-type"),
            "body": parsed,
        })
    )
