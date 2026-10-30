"""网关出站头合并：`header_overrides` 必须**覆盖**同名客户端头，而不是叠加。

背景（docs/前端数据依赖与后端接口需求_20261017.md §5.1）：
兼容层把 `/api/user/login` 翻译到 `/api/v1/auth/wechat/login` 时注入 `X-Platform`。
旧实现用大小写敏感的 dict 合并请求头：客户端自带的 `X-Platform` 与注入键大小写不一致，
dict 里出现两个逻辑同名键，httpx 向上游发两条同名头；Spring 把多值头拼成
`wechat-miniprogram,wechat-miniprogram`，`"wechat-miniprogram".equals(platform)` 失败 → 422。

本用例直接打到「回声上游」，断言上游收到的 `x-platform` **只有一条**。
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.responses import JSONResponse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.proxy import forward  # noqa: E402

UPSTREAM = FastAPI()


@UPSTREAM.post("/api/v1/auth/wechat/login")
async def echo_headers(request: Request):
    return JSONResponse({
        "x_platform": request.headers.getlist("x-platform"),
        "x_client_version": request.headers.getlist("x-client-version"),
        "authorization": request.headers.getlist("authorization"),
    })


EDGE = FastAPI()


@EDGE.post("/api/user/login")
async def legacy_login(request: Request):
    """模拟 compat 条目的 translate 分支：带 body/头覆写转发到契约路径。"""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=UPSTREAM), base_url="http://business.test"
    ) as client:
        return await forward(
            client,
            request,
            "http://business.test",
            target_path="/api/v1/auth/wechat/login",
            body_override=b'{"code":"dev-code","consentVersion":"v1"}',
            content_type="application/json",
            header_overrides={
                "X-Client-Version": "1.0.0",
                "X-Platform": "wechat-miniprogram",
            },
        )


@pytest.fixture()
def edge():
    with TestClient(EDGE) as client:
        yield client


def test_client_header_is_overridden_not_duplicated(edge):
    """客户端自带正确值 → 上游只收到一条（旧实现会收到两条）。"""
    resp = edge.post(
        "/api/user/login",
        json={"phone": "13800138001"},
        headers={"X-Platform": "wechat-miniprogram", "X-Client-Version": "1.0.0"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["x_platform"] == ["wechat-miniprogram"]
    assert body["x_client_version"] == ["1.0.0"]


def test_lowercase_client_header_is_also_deduped(edge):
    """小写形态同样不能叠加（HTTP 头名大小写不敏感）。"""
    resp = edge.post(
        "/api/user/login",
        json={"phone": "13800138001"},
        headers={"x-platform": "wechat-miniprogram"},
    )
    assert resp.status_code == 200
    assert resp.json()["x_platform"] == ["wechat-miniprogram"]


def test_client_wrong_value_is_replaced_by_contract_value(edge):
    """客户端传错值 → 以服务端覆写值为准（上游只看到契约 const）。"""
    resp = edge.post(
        "/api/user/login",
        json={"phone": "13800138001"},
        headers={"X-Platform": "h5"},
    )
    assert resp.status_code == 200
    assert resp.json()["x_platform"] == ["wechat-miniprogram"]


def test_authorization_is_still_passed_through(edge):
    """回归：头合并改造不得丢掉 Authorization 等普通透传头。"""
    resp = edge.post(
        "/api/user/login",
        json={"phone": "13800138001"},
        headers={"Authorization": "Bearer smoke-token"},
    )
    assert resp.status_code == 200
    assert resp.json()["authorization"] == ["Bearer smoke-token"]
