"""M2 · D2.2 SSE 语义测试：网关对 `/api/v1/ai/tasks/{id}/events` 必须**原样流式透传**。

为什么这样断言「不缓冲」：
- Starlette 的 `Response`（把 body 读齐再返回）会自带 `content-length`；
  `StreamingResponse`（逐块下发）**不会**。故「响应无 content-length」是「网关走了流式分支」的
  确定性证据（对比：走兼容响应适配器的 legacy 路径会被读齐 → 有 content-length）。
- `Cache-Control: no-store` 与 `X-Accel-Buffering: no` 是上游（business-service）声明的
  「不缓存 / 不缓冲」头，网关必须原样透传——否则中间层会攒包，SSE 就不再是流。
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


def test_sse_events_stream_through_unbuffered(gw):
    resp = gw.get("/api/v1/ai/tasks/t_demo/events")

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    # 上游声明的「不缓存 / 不缓冲」头必须原样到达（否则 SSE 被中间层攒包）
    assert resp.headers["cache-control"] == "no-store"
    assert resp.headers["x-accel-buffering"] == "no"

    # 流式分支：无 content-length（对比见下方 legacy 适配路径的反例）
    header_names = {name.lower() for name in resp.headers}
    assert "content-length" not in header_names

    body = resp.text
    assert body.count("event:") == 3
    assert body.index("event: accepted") < body.index("event: status") < body.index("event: completed")
    assert '"status":"SUCCEEDED"' in body


def test_compat_adapter_path_is_buffered_by_contrast(gw):
    """反例对照：走响应适配器的 legacy 路径会被读齐 → 带 content-length。

    证明上一条断言不是「所有响应都没有 content-length」的空断言。
    """
    resp = gw.post("/api/v1/consultation/emergency/check", params={"text": "胸口压榨样疼，冒冷汗"})

    assert resp.status_code == 200
    assert resp.json()["data"]["is_emergency"] is True      # 适配生效
    header_names = {name.lower() for name in resp.headers}
    assert "content-length" in header_names                 # 读齐后一次性下发
