"""全链路 X-Request-Id：网关生成一次 → 信封 / 响应头 / 上游三处必须是同一个值。

背景（2026-11-17）：此前 `_rid()` 只在网关**本地**生成 id 用于错误信封，
转发给 Java / FastAPI 的请求头里没有它 → 三个服务各生成一个 id，
一次请求在日志里变成三条互不关联的记录，故障归因只能靠时间戳猜。

红线：
  ① 客户端自带 X-Request-Id → 原样贯穿，不得覆盖；
  ② 客户端未带 → 网关生成一次，且**只生成一次**（响应头与上游必须一致）；
  ③ 响应必须回显 X-Request-Id（前端/网关日志可据此串联）。
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.config import GateSettings  # noqa: E402
from app.main import create_app  # noqa: E402

import mock_business  # noqa: E402


@pytest.fixture()
def gw():
    settings = GateSettings(business_url="http://business.test", ai_url="http://ai.test")
    app = create_app(settings)
    with TestClient(app) as client:
        app.state.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=mock_business.app),
            base_url="http://business.test",
        )
        yield client


def test_generated_request_id_stays_same_through_gateway(gw):
    """未带 id：响应头 == 上游收到的 requestId（网关只生成一次）。"""
    resp = gw.get("/api/v1/departments")

    assert resp.status_code == 200
    rid_header = resp.headers.get("x-request-id")
    rid_upstream = resp.json().get("requestId")
    assert rid_header, "响应必须回显 X-Request-Id"
    assert rid_header == rid_upstream, (
        "网关信封 / 响应头 / 上游 requestId 不一致 → 日志无法串联"
    )


def test_client_request_id_is_preserved(gw):
    """客户端自带 id：必须原样贯穿（便于跨端复现与抓包对账）。"""
    resp = gw.get("/api/v1/departments", headers={"X-Request-Id": "rid-trace-0001"})

    assert resp.status_code == 200
    assert resp.headers.get("x-request-id") == "rid-trace-0001"
    assert resp.json().get("requestId") == "rid-trace-0001"
