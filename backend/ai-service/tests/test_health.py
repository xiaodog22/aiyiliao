"""健康探针行为测试（存活 ≠ 就绪；degraded 不重启、down 才 503）。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app


def test_liveness_is_plain_and_cheap(client):
    resp = client.get("/internal/health/live")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "uptimeSeconds" in body


def test_ready_degraded_still_200(client):
    resp = client.get("/internal/health/ready")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "degraded"  # ollama 在位（fake），asr/tts 未接入
    deps = {d["name"]: d["status"] for d in body["dependencies"]}
    assert deps["ollama"] == "available"
    assert deps["asr_model"] == "unavailable"
    roles = {m["role"]: m["status"] for m in body["models"]}
    assert roles["small-default"] == "loaded"
    assert roles["asr"] == "unavailable"


def test_ready_down_returns_503(settings):
    async def offline_probe(url, timeout):
        return None

    app = create_app(settings, ollama_probe=offline_probe)
    with TestClient(app) as test_client:
        resp = test_client.get("/internal/health/ready")
        assert resp.status_code == 503
        body = resp.json()
        assert body["status"] == "down"
        # 探针失败响应仍然是不带信封的状态报告
        assert "code" not in body
