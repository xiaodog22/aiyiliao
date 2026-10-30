"""前端适配 · 静态素材公开通道（`GET /api/gw/assets/{filename}`）。

为什么要这条用例：
- 契约 `ResourceManifest.items[].url` 需要一个**客户端可达**的素材分发地址；
  ai-service 与 business-service 均不直接对外，故由统一入口（网关）承担
  —— 与 `/api/gw/tts/audio/{filename}` 同构的「显式白名单通道」。
- 该通道只读、公开（图片元素无法携带 Authorization 头），因此安全边界**全部**
  落在网关侧：文件名白名单、扩展名白名单、目录穿越双保险、体积上限。

覆盖：
- 单元层（`assets.try_serve`）：白名单/穿越/非图片/缺失/大写名 → None 或响应；
- HTTP 层：200 + 缓存与校验头（ETag / Cache-Control / X-Resource-Sha256 / X-Resource-Size）；
  `If-None-Match` → 304；非白名单 404；目录缺失 404；HEAD 可用（Starlette 对 GET 路由自动支持 HEAD，便于客户端探测后下载）。
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import assets  # noqa: E402
from app.config import GateSettings  # noqa: E402
from app.main import create_app  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\nfake-png-bytes"
JPEG = b"\xff\xd8\xff fake-jpeg-bytes"
MP4 = b"\x00\x00\x00\x18ftypmp42fake-mp4-bytes"


@pytest.fixture()
def gw_res(tmp_path: Path):
    res = tmp_path / "resources"
    res.mkdir()
    (res / "banner-home.png").write_bytes(PNG)
    (res / "photo.jpg").write_bytes(JPEG)
    (res / "clip.mp4").write_bytes(MP4)
    (res / "notes.txt").write_bytes(b"nope")

    settings = GateSettings(assets_dir=res)
    app = create_app(settings)
    with TestClient(app) as client:
        yield client, res


# ---------- 单元层：白名单与目录穿越（安全边界的主体在断言里逐条钉死） ----------

def test_try_serve_rejects_traversal(tmp_path: Path):
    (tmp_path / "ok.png").write_bytes(PNG)

    assert assets.try_serve(tmp_path, "../ok.png", None) is None      # 斜杠穿越
    assert assets.try_serve(tmp_path, "..\\ok.png", None) is None     # 反斜杠（_NAME_RE 直接拒绝）
    assert assets.try_serve(tmp_path, "a..b.png", None) is None       # 内含 ..
    assert assets.try_serve(tmp_path, "sub/ok.png", None) is None     # 子目录路径
    assert assets.try_serve(tmp_path, "C:/windows/x.png", None) is None  # 盘符/绝对路径形态


def test_try_serve_name_and_ext_whitelist(tmp_path: Path):
    (tmp_path / "ok.png").write_bytes(PNG)
    (tmp_path / "upper.PNG").write_bytes(PNG)
    (tmp_path / "script.js.png.bak").write_bytes(b"x")

    assert assets.try_serve(tmp_path, "ok.png", None) is not None
    assert assets.try_serve(tmp_path, "upper.PNG", None) is None      # 仅小写
    assert assets.try_serve(tmp_path, "script.js.png.bak", None) is None  # 非图片扩展名
    assert assets.try_serve(tmp_path, "missing.png", None) is None    # 不存在
    assert assets.try_serve(tmp_path, "s" * 81 + ".png", None) is None  # 超长


def test_try_serve_rejects_oversize(tmp_path: Path, monkeypatch):
    big = tmp_path / "big.png"
    big.write_bytes(b"0" * 16)
    monkeypatch.setattr(assets, "MAX_BYTES", 8)
    assert assets.try_serve(tmp_path, "big.png", None) is None


def test_try_serve_304_unit(tmp_path: Path):
    (tmp_path / "ok.png").write_bytes(PNG)
    first = assets.try_serve(tmp_path, "ok.png", None)
    etag = first.headers["etag"]
    again = assets.try_serve(tmp_path, "ok.png", etag)
    assert again.status_code == 304 and again.body == b""
    assert again.headers["etag"] == etag  # 304 仍带校验头，客户端可继续复用


# ---------- HTTP 层 ----------

def test_asset_served_with_cache_and_integrity_headers(gw_res):
    client, _ = gw_res
    resp = client.get("/api/gw/assets/banner-home.png")

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/png")
    assert resp.content == PNG
    assert resp.headers["cache-control"] == "public, max-age=86400"
    assert resp.headers["x-resource-sha256"] == hashlib.sha256(PNG).hexdigest()
    assert resp.headers["x-resource-size"] == str(len(PNG))
    assert resp.headers["etag"].startswith('"') and len(resp.headers["etag"]) == 34


def test_asset_conditional_304(gw_res):
    client, _ = gw_res
    first = client.get("/api/gw/assets/photo.jpg")
    etag = first.headers["etag"]

    second = client.get("/api/gw/assets/photo.jpg", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.content == b""
    # 内容仍原样可达（未被 304 逻辑污染）
    assert client.get("/api/gw/assets/photo.jpg").content == JPEG


def test_asset_404_for_non_whitelisted_and_missing(gw_res):
    client, _ = gw_res
    for bad in ("notes.txt", "missing.png", "upper.PNG", "a..b.png"):
        assert client.get(f"/api/gw/assets/{bad}").status_code == 404, bad


def test_asset_404_when_dir_missing(tmp_path: Path):
    settings = GateSettings(assets_dir=tmp_path / "does-not-exist")
    app = create_app(settings)
    with TestClient(app) as client:
        assert client.get("/api/gw/assets/banner-home.png").status_code == 404


def test_asset_head_probe(gw_res):
    """HEAD 探测：同头、无正文（客户端可先探再下）。"""
    client, _ = gw_res
    resp = client.head("/api/gw/assets/banner-home.png")
    assert resp.status_code == 200
    assert resp.content == b""
    assert resp.headers["x-resource-sha256"] == hashlib.sha256(PNG).hexdigest()


def test_asset_envelope_404_body(gw_res):
    """404 走统一信封（不是裸文本），前端 errText 可正常兜底。"""
    client, _ = gw_res
    resp = client.get("/api/gw/assets/notes.txt")
    body = resp.json()
    assert body["code"] == "NOT_FOUND"
    assert body["requestId"]


def test_try_serve_allows_short_mp4(tmp_path: Path):
    """2026-10-17 起科普提示视频经同一通道分发（mp4 白名单 + video/mp4）。"""
    (tmp_path / "clip.mp4").write_bytes(MP4)
    resp = assets.try_serve(tmp_path, "clip.mp4", None)
    assert resp is not None
    assert resp.media_type == "video/mp4"
    assert resp.headers["X-Resource-Size"] == str(len(MP4))


def test_try_serve_still_rejects_other_media(tmp_path: Path):
    """白名单外扩展名（含 .m3u8/.js）仍一律 404。"""
    for name in ("stream.m3u8", "app.js", "clip.mov"):
        (tmp_path / name).write_bytes(b"x")
        assert assets.try_serve(tmp_path, name, None) is None
