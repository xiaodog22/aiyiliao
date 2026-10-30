"""M2 · O-10 定稿：TTS 产物经网关公开通道可达（`/api/gw/tts/audio/{filename}`）。

为什么要这条用例：
- ai-service **仅内网可达**（`/internal/**`），客户端拿不到 `audioUrl` 里那个内部地址；
- 故对外必须有一个「显式白名单路径」的公开通道，把它转发到 ai-service 的内部签名通道
  （对应 ai-service 侧 `AI_TTS_PUBLIC_BASE` + `AI_TTS_PUBLIC_PATH`）；
- 鉴权由**短期签名 token** 承担（音频元素无法携带 Authorization 头），故本路径不要求登录态；
  网关只转发，不解析 token、不缓存、不改写响应体（403/404 均原样透传）。

对照：本次新增前，`audioUrl` 指向内网 `http://127.0.0.1:8001/internal/v1/tts/audio/...`，
客户端不可达 —— 即用户的 O-10 裁定「env 中须明确 audioUrl 的可达基址」所指向的缺口。
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.config import GateSettings  # noqa: E402
from app.main import create_app  # noqa: E402

import mock_business  # noqa: E402

VALID = "a1b2c3d4e5f60718.mp3"  # 16 位十六进制 + .mp3（白名单形状）

ai = FastAPI(title="mock-ai (test double)")


@ai.get("/internal/v1/tts/audio/{filename}")
async def _tts_audio(filename: str, token: str = ""):
    if token != "1.good":
        return JSONResponse(status_code=403, content={"code": "FORBIDDEN", "message": "签名无效或已过期"})
    return Response(content=b"ID3fake-mp3-bytes", media_type="audio/mpeg")


class _DualApp:
    """按 Host 把 ASGI 请求分发到 business / ai 两个替身（ASGITransport 只能指向单个 app）。"""

    def __init__(self, by_host: dict, default):
        self._by_host = by_host
        self._default = default

    async def __call__(self, scope, receive, send):
        host = ""
        for key, value in scope.get("headers") or []:
            if key == b"host":
                host = value.decode()
                break
        await self._by_host.get(host, self._default)(scope, receive, send)


@pytest.fixture()
def gw():
    settings = GateSettings(business_url="http://business.test", ai_url="http://ai.test")
    app = create_app(settings)
    with TestClient(app) as client:
        app.state.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=_DualApp({"ai.test": ai}, default=mock_business.app)),
            base_url="http://business.test",
        )
        yield client


def test_public_tts_audio_route_forwards_to_internal_channel(gw):
    resp = gw.get(f"/api/gw/tts/audio/{VALID}", params={"token": "1.good"})

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("audio/mpeg")
    assert resp.content == b"ID3fake-mp3-bytes"      # 字节原样透传，不套业务信封


def test_public_tts_audio_route_passes_through_403(gw):
    resp = gw.get(f"/api/gw/tts/audio/{VALID}", params={"token": "1.bad"})

    assert resp.status_code == 403                    # 签名校验在 ai-service 侧，网关不越权判定
    assert resp.json()["code"] == "FORBIDDEN"


def test_public_tts_audio_route_rejects_non_whitelisted_filename(gw):
    # 网关侧白名单（16~64 位十六进制 + .mp3）：非法名直接 404，不下发上游
    for bad in ("abc.mp3", "not-audio.txt", "a1b2c3d4e5f60718.wav", "zzzzzzzzzzzzzzzz.mp3"):
        resp = gw.get(f"/api/gw/tts/audio/{bad}", params={"token": "1.good"})
        assert resp.status_code == 404, bad
