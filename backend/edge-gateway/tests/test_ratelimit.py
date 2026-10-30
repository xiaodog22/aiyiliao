"""M4 硬化前瞻 · 网关限流（`app/ratelimit.py` + `main.py` 中间件）。

定位：**保护上游**不被单客户端突发打穿，不是配额计费。因此：
- 固定窗口计数（默认 60s / 300 次）；默认**关闭**，deploy 显式开启；
- 探针路径不参与限流（否则编排器健康轮询会把自己限死）；
- 命中 → 429 + 统一错误信封（`RATE_LIMITED`，retryable=true）+ `Retry-After`。

本文件分两层：纯函数层（窗口/隔离/清理）与集成层（中间件 429 与豁免）。
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
from app.ratelimit import EXEMPT_PATHS, FixedWindowLimiter, client_key  # noqa: E402

import mock_business  # noqa: E402


# ---------- 纯函数层 ----------

def test_allows_up_to_limit_then_blocks_with_retry_after():
    limiter = FixedWindowLimiter(limit=3, window_seconds=60)

    for i in range(3):
        decision = limiter.check("c1", now=1000.0 + i)
        assert decision.allowed is True
        assert decision.remaining == 2 - i
    blocked = limiter.check("c1", now=1003.0)
    assert blocked.allowed is False
    assert blocked.remaining == 0
    assert 1 <= blocked.retry_after <= 60


def test_window_reset_reallows():
    limiter = FixedWindowLimiter(limit=1, window_seconds=60)
    assert limiter.check("c1", now=1000.0).allowed is True     # 窗口起点 960
    assert limiter.check("c1", now=1010.0).allowed is False    # 仍在 960 窗口内
    assert limiter.check("c1", now=1020.0).allowed is True     # 进入 1020 窗口 → 计数清零


def test_keys_are_isolated():
    limiter = FixedWindowLimiter(limit=1, window_seconds=60)
    assert limiter.check("a", now=1000.0).allowed is True
    assert limiter.check("b", now=1000.0).allowed is True   # 不受 a 影响
    assert limiter.check("a", now=1000.5).allowed is False


def test_stale_buckets_are_evicted_when_exceeding_max_keys():
    limiter = FixedWindowLimiter(limit=5, window_seconds=60, max_keys=10)
    for i in range(50):
        limiter.check(f"k{i}", now=1000.0)          # 同一窗口内制造大量 key
    assert len(limiter._buckets) <= 10              # 有界，不无限增长


def test_client_key_prefers_first_hop_of_x_forwarded_for():
    assert client_key({"X-Forwarded-For": "203.0.113.9, 10.0.0.1"}, "10.0.0.5") == "203.0.113.9"
    assert client_key({}, "10.0.0.5") == "10.0.0.5"
    assert client_key({}, None) == "unknown"


def test_health_paths_are_exempt():
    assert "/api/gw/health" in EXEMPT_PATHS and "/health" in EXEMPT_PATHS


# ---------- 集成层（中间件） ----------

def _client(enabled: bool, per_minute: int = 2):
    settings = GateSettings(
        business_url="http://business.test",
        ai_url="http://ai.test",
        rate_limit_enabled=enabled,
        rate_limit_per_minute=per_minute,
        rate_limit_window_seconds=60,
    )
    app = create_app(settings)
    client = TestClient(app)
    client.__enter__()
    app.state.http = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=mock_business.app), base_url="http://business.test"
    )
    return app, client


def test_middleware_returns_429_with_envelope_and_retry_after():
    app, client = _client(enabled=True, per_minute=2)
    try:
        assert client.get("/api/v1/beds").status_code == 200
        assert client.get("/api/v1/beds").status_code == 200
        third = client.get("/api/v1/beds")
        assert third.status_code == 429
        assert third.headers["Retry-After"].isdigit()
        body = third.json()
        assert body["code"] == "RATE_LIMITED"
        assert body["retryable"] is True
    finally:
        client.__exit__(None, None, None)


def test_middleware_disabled_by_default_allows_all():
    app, client = _client(enabled=False, per_minute=1)
    try:
        for _ in range(5):
            assert client.get("/api/v1/beds").status_code == 200
    finally:
        client.__exit__(None, None, None)


def test_health_probe_not_throttled():
    app, client = _client(enabled=True, per_minute=1)
    try:
        # /api/gw/health 走豁免分支：即便配额耗尽也不 429（上游不可达时是 503，而非 429）
        for _ in range(3):
            assert client.get("/api/gw/health").status_code in (200, 503)
    finally:
        client.__exit__(None, None, None)
