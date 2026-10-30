"""投屏桥接（N14/N15/N16）：SSDP/DLNA 发现与推送的进程内抽象。

红线（契约 /api/gw/cast/*）：
- 设备发现由部署在医院内网的网关桥接完成，前端只走统一网关；桥接未接入时**不得伪造设备**
  （devices → 503 CAST_BRIDGE_UNAVAILABLE，由 main.py 判定 cast_bridge_enabled）。
- push 的 payload 与设备 IP 不落日志（含就诊信息，见契约 push 描述）。

`CastBridge` 是抽象边界：dev 实现（进程内存注册表，来自 settings.cast_devices）
如实反映"有没有设备/配没配对/在不在线"；后续接真实 SSDP/DLNA 只需替换实现。
"""

from __future__ import annotations

import json

from .envelope import ApiError, not_found

# 契约 contentType 枚举：QUEUE 叫号 · PATIENT 就诊指引 · KB 科普内容
VALID_CONTENT_TYPES = ("QUEUE", "PATIENT", "KB")
# 契约：单请求总大小 ≤ 16KB
MAX_PAYLOAD_BYTES = 16 * 1024

_DEVICE_ID_MAX = 64


def require_idempotency_key(request) -> None:
    """必填校验，与 business-service IdempotencyKeys 同口径：
    缺失/空白 → 400 MISSING_IDEMPOTENCY_KEY；长度不在 8~128 → 400 INVALID_IDEMPOTENCY_KEY。
    """
    key = (request.headers.get("idempotency-key") or "").strip()
    if not key:
        raise ApiError(400, "MISSING_IDEMPOTENCY_KEY", "缺少必需请求头 Idempotency-Key；重试必须复用同一键")
    if len(key) < 8 or len(key) > 128:
        raise ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 长度须为 8~128 字符")


def _load_object(raw: bytes) -> dict:
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ApiError(400, "VALIDATION_FAILED", "请求体必须是合法的 JSON 对象") from None
    if not isinstance(obj, dict):
        raise ApiError(400, "VALIDATION_FAILED", "请求体必须是 JSON 对象")
    return obj


def _check_fields(obj: dict, allowed: set[str], required: list[str]) -> None:
    unknown = [k for k in obj if k not in allowed]
    if unknown:
        raise ApiError(
            400,
            "VALIDATION_FAILED",
            f"请求包含未知字段：{'、'.join(sorted(unknown))}",
            details=[{"field": k, "reason": "未知字段（additionalProperties=false）", "code": "UNKNOWN_FIELD"} for k in sorted(unknown)],
        )
    missing = [k for k in required if k not in obj]
    if missing:
        raise ApiError(
            400,
            "VALIDATION_FAILED",
            f"缺少必需字段：{'、'.join(missing)}",
            details=[{"field": k, "reason": "缺少必需字段", "code": "REQUIRED"} for k in missing],
        )


def _check_device_id(value) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > _DEVICE_ID_MAX:
        raise ApiError(400, "VALIDATION_FAILED", f"deviceId 须为 1~{_DEVICE_ID_MAX} 字符的非空字符串",
                       details=[{"field": "deviceId", "reason": "格式不合法", "code": "INVALID"}])
    return value


def parse_pair_body(raw: bytes) -> str:
    """POST /api/gw/cast/pair 请求体校验（additionalProperties=false）→ deviceId。"""
    obj = _load_object(raw)
    _check_fields(obj, allowed={"deviceId"}, required=["deviceId"])
    return _check_device_id(obj["deviceId"])


def parse_push_body(raw: bytes) -> tuple[str, str, dict]:
    """POST /api/gw/cast/push 请求体校验（additionalProperties=false）→ (deviceId, contentType, payload)。"""
    obj = _load_object(raw)
    _check_fields(obj, allowed={"deviceId", "contentType", "payload"}, required=["deviceId", "contentType", "payload"])
    device_id = _check_device_id(obj["deviceId"])
    content_type = obj["contentType"]
    if not isinstance(content_type, str) or content_type not in VALID_CONTENT_TYPES:
        raise ApiError(
            400,
            "VALIDATION_FAILED",
            f"contentType 取值须为 {'/'.join(VALID_CONTENT_TYPES)} 之一",
            details=[{"field": "contentType", "reason": "不在枚举范围内", "code": "ENUM"}],
        )
    payload = obj["payload"]
    if not isinstance(payload, dict):
        raise ApiError(400, "VALIDATION_FAILED", "payload 须为 JSON 对象",
                       details=[{"field": "payload", "reason": "须为对象", "code": "INVALID"}])
    return device_id, content_type, payload


def payload_too_large() -> ApiError:
    return ApiError(413, "PAYLOAD_TOO_LARGE", f"投屏请求体超过 {MAX_PAYLOAD_BYTES // 1024}KB 上限")


def bridge_unavailable() -> ApiError:
    return ApiError(503, "CAST_BRIDGE_UNAVAILABLE", "投屏桥接未接入，设备发现暂不可用", retryable=True)


class CastBridge:
    """桥接抽象：discover / pair / push。

    dev 实现 = 进程内存：注册表来自 settings.cast_devices，配对集合为进程内状态
    （随 app 实例隔离，测试用独立 create_app 即天然重置）。后续接真实 SSDP/DLNA
    时替换本类即可，路由与校验层不动。
    """

    def __init__(self, devices: list[dict] | None = None) -> None:
        self._registry: dict[str, dict] = {}
        for item in devices or []:
            if not isinstance(item, dict):
                continue
            device_id = str(item.get("deviceId") or "").strip()
            if not device_id or len(device_id) > _DEVICE_ID_MAX:
                continue
            status = item.get("status")
            if status not in ("ONLINE", "PAIRED", "OFFLINE"):
                status = "ONLINE"
            self._registry[device_id] = {
                "deviceId": device_id,
                "name": str(item.get("name") or device_id)[:60],
                "ip": str(item.get("ip") or "")[:45],
                "status": status,
            }
        # 注册表初始即为 PAIRED 的设备视为已配对
        self._paired: set[str] = {d for d, dev in self._registry.items() if dev["status"] == "PAIRED"}

    def discover(self) -> list[dict]:
        """设备发现快照；已配对设备在注册表基础上覆盖为 PAIRED。"""
        snapshots = []
        for device_id, device in self._registry.items():
            snapshot = dict(device)
            if device_id in self._paired:
                snapshot["status"] = "PAIRED"
            snapshots.append(snapshot)
        return snapshots

    def pair(self, device_id: str) -> dict:
        """配对（幂等终态：重复提交同一 deviceId 返回同结果）。"""
        if device_id not in self._registry:
            raise not_found("投屏设备不存在")
        self._paired.add(device_id)
        return {"deviceId": device_id, "status": "PAIRED"}

    def push(self, device_id: str, content_type: str, payload: dict) -> dict:
        """推送受理：不存在/离线/未配对均如实 404（不伪造受理）。

        成功语义 = 已受理并交由桥接发送；payload 与设备 IP 不写日志。
        """
        device = self._registry.get(device_id)
        if device is None:
            raise not_found("投屏设备不存在")
        if device["status"] == "OFFLINE":
            raise not_found("投屏设备已离线，无法推送")
        if device_id not in self._paired:
            raise not_found("投屏设备未配对或不存在")
        # dev 实现无真实屏端：受理即交桥接发送（不记录 payload / 设备 IP）
        return {"accepted": True}
