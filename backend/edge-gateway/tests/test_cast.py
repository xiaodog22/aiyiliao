"""投屏桥接三端点（N14/N15/N16，契约 /api/gw/cast/*）集成测试。

覆盖：
- devices：401（无 Authorization）/ 503（桥接未接入）/ 200（data 为 CastDevice 数组）/
  配对后状态覆盖为 PAIRED；
- pair：Idempotency-Key 必填与长度（同 business-service IdempotencyKeys 口径）/
  未知 deviceId → 404 / 请求体 additionalProperties=false / 成功与幂等重复；
- push：鉴权与幂等键 / contentType 枚举 / 未知与未配对设备 → 404 / >16KB → 413 /
  配对后成功 → data.accepted == true；
- 统一信封形状（code / message / requestId）。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import GateSettings  # noqa: E402
from app.main import create_app  # noqa: E402

AUTH = {"Authorization": "Bearer test-token"}
IDEM = {"Idempotency-Key": "cast-key-12345678"}

DEVICES = [
    {"deviceId": "tv-1", "name": "候诊大屏", "ip": "10.1.2.3"},
    {"deviceId": "tv-2", "name": "走廊屏", "ip": "10.1.2.4", "status": "OFFLINE"},
]


def _make_client(**overrides) -> TestClient:
    settings = GateSettings(
        business_url="http://business.test",
        ai_url="http://ai.test",
        **overrides,
    )
    app = create_app(settings)
    return TestClient(app)


@pytest.fixture()
def gw_on():
    with _make_client(cast_bridge_enabled=True, cast_devices=[dict(d) for d in DEVICES]) as client:
        yield client


@pytest.fixture()
def gw_off():
    with _make_client(cast_bridge_enabled=False) as client:
        yield client


# ---------- GET /api/gw/cast/devices ----------

def test_devices_requires_authorization_header(gw_on):
    resp = gw_on.get("/api/gw/cast/devices")
    assert resp.status_code == 401
    body = resp.json()
    assert body["code"] == "UNAUTHORIZED"
    assert body["message"]
    assert body["requestId"]


def test_devices_bridge_disabled_returns_503(gw_off):
    resp = gw_off.get("/api/gw/cast/devices", headers=AUTH)
    assert resp.status_code == 503
    body = resp.json()
    assert body["code"] == "CAST_BRIDGE_UNAVAILABLE"
    assert "投屏桥接" in body["message"]  # 中文文案
    assert body["retryable"] is True
    assert body["requestId"]


def test_devices_disabled_still_requires_auth(gw_off):
    """鉴权先于桥接可用性：无 Authorization 必须 401（不泄露桥接状态）。"""
    assert gw_off.get("/api/gw/cast/devices").status_code == 401


def test_devices_ok_returns_cast_device_array(gw_on):
    resp = gw_on.get("/api/gw/cast/devices", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    # 统一信封形状
    assert body["code"] == "OK"
    assert body["message"]
    assert body["requestId"]
    assert body["serverTime"]
    # OkCastDeviceList：data 直接是设备数组（不是 {devices:[...]})
    data = body["data"]
    assert isinstance(data, list) and len(data) == 2
    by_id = {d["deviceId"]: d for d in data}
    assert set(by_id) == {"tv-1", "tv-2"}
    for device in data:
        assert set(device) == {"deviceId", "name", "ip", "status"}
        assert device["status"] in ("ONLINE", "PAIRED", "OFFLINE")
    assert by_id["tv-1"]["status"] == "ONLINE"  # 注册表未写 status → 默认 ONLINE
    assert by_id["tv-2"]["status"] == "OFFLINE"


def test_devices_paired_device_shows_paired(gw_on):
    gw_on.post("/api/gw/cast/pair", json={"deviceId": "tv-1"}, headers={**AUTH, **IDEM})
    data = gw_on.get("/api/gw/cast/devices", headers=AUTH).json()["data"]
    by_id = {d["deviceId"]: d for d in data}
    assert by_id["tv-1"]["status"] == "PAIRED"  # 配对状态覆盖注册表状态
    assert by_id["tv-2"]["status"] == "OFFLINE"


# ---------- POST /api/gw/cast/pair ----------

def test_pair_requires_auth(gw_on):
    resp = gw_on.post("/api/gw/cast/pair", json={"deviceId": "tv-1"}, headers=IDEM)
    assert resp.status_code == 401
    assert resp.json()["code"] == "UNAUTHORIZED"


def test_pair_missing_idempotency_key(gw_on):
    resp = gw_on.post("/api/gw/cast/pair", json={"deviceId": "tv-1"}, headers=AUTH)
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "MISSING_IDEMPOTENCY_KEY"
    assert "Idempotency-Key" in body["message"]  # 中文文案，同 business-service 口径
    assert body["requestId"]


def test_pair_invalid_idempotency_key_length(gw_on):
    resp = gw_on.post("/api/gw/cast/pair", json={"deviceId": "tv-1"},
                      headers={**AUTH, "Idempotency-Key": "short"})
    assert resp.status_code == 400
    assert resp.json()["code"] == "INVALID_IDEMPOTENCY_KEY"


def test_pair_unknown_device_404(gw_on):
    resp = gw_on.post("/api/gw/cast/pair", json={"deviceId": "no-such"},
                      headers={**AUTH, **IDEM})
    assert resp.status_code == 404
    body = resp.json()
    assert body["code"] == "NOT_FOUND"
    assert "不存在" in body["message"]  # 中文文案
    assert body["requestId"]


def test_pair_body_validation(gw_on):
    # 缺字段 → 400
    resp = gw_on.post("/api/gw/cast/pair", json={}, headers={**AUTH, **IDEM})
    assert resp.status_code == 400
    assert resp.json()["code"] == "VALIDATION_FAILED"
    # 未知字段（additionalProperties=false）→ 400
    resp = gw_on.post("/api/gw/cast/pair", json={"deviceId": "tv-1", "extra": 1},
                      headers={**AUTH, **IDEM})
    assert resp.status_code == 400
    assert resp.json()["code"] == "VALIDATION_FAILED"


def test_pair_success_and_idempotent_repeat(gw_on):
    resp = gw_on.post("/api/gw/cast/pair", json={"deviceId": "tv-1"},
                      headers={**AUTH, **IDEM})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == "OK"
    assert body["data"] == {"deviceId": "tv-1", "status": "PAIRED"}
    # 重复配对同一 deviceId → 幂等终态 200 同结果
    resp2 = gw_on.post("/api/gw/cast/pair", json={"deviceId": "tv-1"},
                       headers={**AUTH, "Idempotency-Key": "another-key-9999"})
    assert resp2.status_code == 200
    assert resp2.json()["data"] == body["data"]


# ---------- POST /api/gw/cast/push ----------

def _push(client, payload: dict, headers=None, device="tv-1", content_type="QUEUE"):
    body = {"deviceId": device, "contentType": content_type, "payload": payload}
    return client.post("/api/gw/cast/push", json=body, headers=headers or {**AUTH, **IDEM})


def test_push_requires_auth(gw_on):
    resp = gw_on.post("/api/gw/cast/push",
                      json={"deviceId": "tv-1", "contentType": "QUEUE", "payload": {}},
                      headers=IDEM)
    assert resp.status_code == 401
    assert resp.json()["code"] == "UNAUTHORIZED"


def test_push_missing_idempotency_key(gw_on):
    resp = gw_on.post("/api/gw/cast/push",
                      json={"deviceId": "tv-1", "contentType": "QUEUE", "payload": {}},
                      headers=AUTH)
    assert resp.status_code == 400
    assert resp.json()["code"] == "MISSING_IDEMPOTENCY_KEY"


def test_push_invalid_content_type(gw_on):
    resp = _push(gw_on, {}, content_type="VIDEO")
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "VALIDATION_FAILED"
    assert "contentType" in body["message"]
    # 字段缺失 → 400
    resp = gw_on.post("/api/gw/cast/push", json={"deviceId": "tv-1"}, headers={**AUTH, **IDEM})
    assert resp.status_code == 400
    assert resp.json()["code"] == "VALIDATION_FAILED"


def test_push_unknown_device_404(gw_on):
    resp = _push(gw_on, {}, device="no-such")
    assert resp.status_code == 404
    assert "不存在" in resp.json()["message"]


def test_push_offline_device_404(gw_on):
    # tv-2 注册表状态 OFFLINE：即使已配对也不受理（契约：设备不存在/离线 → 404）
    gw_on.post("/api/gw/cast/pair", json={"deviceId": "tv-2"}, headers={**AUTH, **IDEM})
    resp = _push(gw_on, {}, device="tv-2")
    assert resp.status_code == 404
    assert "离线" in resp.json()["message"]


def test_push_unpaired_device_404(gw_on):
    # tv-1 存在且 ONLINE，但从未 pair → 未配对不受理
    resp = _push(gw_on, {}, device="tv-1")
    assert resp.status_code == 404
    assert "未配对" in resp.json()["message"]


def test_push_payload_too_large_413(gw_on):
    resp = _push(gw_on, {"text": "x" * (17 * 1024)})
    assert resp.status_code == 413
    body = resp.json()
    assert body["code"] == "PAYLOAD_TOO_LARGE"
    assert body["message"]  # 中文文案
    assert body["requestId"]


def test_push_success_after_pair(gw_on):
    gw_on.post("/api/gw/cast/pair", json={"deviceId": "tv-1"}, headers={**AUTH, **IDEM})
    resp = _push(gw_on, {"title": "叫号", "no": "A012"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == "OK"
    assert body["requestId"]
    assert body["data"] == {"accepted": True}
