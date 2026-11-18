"""审计 H5 回归：投屏桥接必须向 business 反查 DOCTOR，不得只校验 token 形态。

本文件专门覆盖 whoami 的拒绝/不可达分支；test_cast.py 用固定 DOCTOR 身份
只测桥接状态机。
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import GateSettings  # noqa: E402
from app.main import create_app  # noqa: E402

AUTH = {"Authorization": "Bearer at-0000aaaa-1111-2222-3333-444455556666"}
DEVICES = [{"deviceId": "tv-1", "name": "候诊大屏", "ip": "10.1.2.3"}]


def _client(call):
    settings = GateSettings(
        business_url="http://business.test",
        ai_url="http://ai.test",
        cast_bridge_enabled=True,
        cast_devices=[dict(d) for d in DEVICES],
    )
    client = TestClient(create_app(settings))
    client.__enter__()

    async def fake_get(*_args, **_kwargs):
        return call()

    client.app.state.http.get = fake_get
    return client


def _doctor_response():
    return httpx.Response(200, json={"code": "OK", "data": {"role": "doctor", "roles": ["DOCTOR"]}})


def _patient_response():
    return httpx.Response(200, json={"code": "OK", "data": {"role": "patient", "roles": ["PATIENT"]}})


def test_doctor_session_can_list_devices():
    client = _client(_doctor_response)
    try:
        resp = client.get("/api/gw/cast/devices", headers=AUTH)
        assert resp.status_code == 200
        assert resp.json()["code"] == "OK"
    finally:
        client.__exit__(None, None, None)


def test_patient_session_is_forbidden():
    client = _client(_patient_response)
    try:
        resp = client.get("/api/gw/cast/devices", headers=AUTH)
        assert resp.status_code == 403
        assert resp.json()["code"] == "FORBIDDEN"
    finally:
        client.__exit__(None, None, None)


def test_business_401_is_unauthorized():
    client = _client(lambda: httpx.Response(401, json={"code": "UNAUTHORIZED"}))
    try:
        resp = client.get("/api/gw/cast/devices", headers=AUTH)
        assert resp.status_code == 401
        assert resp.json()["code"] == "UNAUTHORIZED"
    finally:
        client.__exit__(None, None, None)


def test_business_500_fails_closed_503():
    client = _client(lambda: httpx.Response(500, json={"code": "INTERNAL_ERROR"}))
    try:
        resp = client.get("/api/gw/cast/devices", headers=AUTH)
        assert resp.status_code == 503
        assert resp.json()["code"] == "UPSTREAM_UNAVAILABLE"
        assert resp.json()["retryable"] is True
    finally:
        client.__exit__(None, None, None)


def test_business_network_error_fails_closed_503():
    def _raise():
        raise httpx.ConnectError("business down")

    client = _client(_raise)
    try:
        resp = client.get("/api/gw/cast/devices", headers=AUTH)
        assert resp.status_code == 503
        assert resp.json()["code"] == "UPSTREAM_UNAVAILABLE"
    finally:
        client.__exit__(None, None, None)


def test_business_timeout_fails_closed_503():
    def _raise():
        raise httpx.ReadTimeout("slow")

    client = _client(_raise)
    try:
        resp = client.get("/api/gw/cast/devices", headers=AUTH)
        assert resp.status_code == 503
        assert resp.json()["code"] == "UPSTREAM_UNAVAILABLE"
    finally:
        client.__exit__(None, None, None)


def test_malformed_token_shape_rejected_before_business():
    client = _client(_doctor_response)
    try:
        resp = client.get("/api/gw/cast/devices", headers={"Authorization": "Bearer not-a-session"})
        assert resp.status_code == 401
    finally:
        client.__exit__(None, None, None)


@pytest.mark.parametrize("route", ["/api/gw/cast/pair", "/api/gw/cast/push"])
def test_all_cast_endpoints_require_doctor(route):
    client = _client(_patient_response)
    try:
        resp = client.post(route, json={"deviceId": "tv-1", "contentType": "QUEUE", "payload": {}},
                           headers={**AUTH, "Idempotency-Key": "cast-key-12345678"})
        assert resp.status_code == 403
        assert resp.json()["code"] == "FORBIDDEN"
    finally:
        client.__exit__(None, None, None)
