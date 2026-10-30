"""M1 兼容层集成测试：网关全链路（TestClient）→ ASGI 联调替身（httpx.ASGITransport，不触网）。

覆盖五条 M1 条目的端到端语义：请求翻译 + 响应适配 + 信封降级（code:"OK"→200）+ 头注入 +
错误透传（上游 4xx 信封不被双重包装）。
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
    # compat_legacy_login_enabled=True = 本机联调档，等价 deploy/config.json 的
    # "compat": { "legacyLoginEnabled": true }（该 dev 替身默认关闭，见 test_legacy_login_disabled_by_default）
    settings = GateSettings(
        business_url="http://business.test",
        ai_url="http://ai.test",
        compat_legacy_login_enabled=True,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        # 把出站 client 换成指向联调替身的 ASGI 传输（同事件循环内完成，不占用端口）
        app.state.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=mock_business.app),
            base_url="http://business.test",
        )
        yield client


# ---------- 急诊检查（#2） ----------

def test_legacy_emergency_translated_and_adapted(gw):
    resp = gw.post("/api/v1/consultation/emergency/check", params={"text": "胸口压榨样疼，冒冷汗"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 200  # 信封降级：契约 "OK" → 数字 200
    d = body["data"]
    # 遗留字段（旧前端直接消费）
    assert d["is_emergency"] is True
    assert d["risk_level"] == "high"
    assert d["emergency_message"]
    assert d["matched_keywords"] == ["胸痛"]
    assert d["safe"] is False
    # 新契约字段保留（不删除原始信息）
    assert d["emergency"] is True and d["level"] == "EMERGENCY"


def test_legacy_emergency_non_emergency_view(gw):
    resp = gw.post("/api/v1/consultation/emergency/check", params={"text": "最近有点头晕"})
    d = resp.json()["data"]
    assert d["is_emergency"] is False
    assert d["risk_level"] == "info"  # 非紧急透传小写 level（不会触发旧端 === 'high'）
    assert d["safe"] is True


def test_legacy_emergency_error_passthrough(gw):
    # 上游 422 统一错误信封原样透传（不双重包装、不改成 200）
    resp = gw.post("/api/v1/consultation/emergency/check", params={"text": ""})
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_FAILED"


# ---------- 科室推荐（#3） ----------

def test_legacy_recommend_translated_and_adapted(gw):
    resp = gw.post("/api/v1/case/recommend-department", json={"text": "肚子疼，还拉肚子两天了"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 200
    d = body["data"]
    assert d["clinic"] == "消化内科"
    assert d["department"] == "消化内科" and d["dept"] == "消化内科"
    assert d["reason"]
    assert d["recommendedDepartments"][0]["departmentName"] == "消化内科"  # 新字段保留


def test_legacy_recommend_no_hit_yields_empty_clinic(gw):
    resp = gw.post("/api/v1/case/recommend-department", json={"text": "心情不太好想咨询一下"})
    d = resp.json()["data"]
    assert d["clinic"] == ""  # 旧端据此回退本地规则（远端补充档语义）


# ---------- 医生列表（#15 / #16） ----------

def test_legacy_doctor_list_adapted(gw):
    resp = gw.get("/api/v1/doctor/list")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 200
    arr = body["data"]
    assert [x["name"] for x in arr] == ["张医生", "李医生", "王医生"]
    assert arr[0]["department"] == "消化内科"
    assert arr[0]["expertise"] == "胃炎、肠炎"
    assert arr[0]["status"] == "可预约"
    assert arr[1]["status"] == "约满"
    assert arr[2]["status"] == ""
    assert arr[0]["departmentName"] == "消化内科"  # 新字段保留


def test_legacy_doctor_by_department_filters_by_name_and_id(gw):
    by_name = gw.get("/api/v1/doctor/by-department", params={"dept": "消化内科"})
    assert [x["name"] for x in by_name.json()["data"]] == ["张医生", "李医生"]
    by_id = gw.get("/api/v1/doctor/by-department", params={"dept": "d-2"})
    assert [x["name"] for x in by_id.json()["data"]] == ["王医生"]
    no_arg = gw.get("/api/v1/doctor/by-department")
    assert len(no_arg.json()["data"]) == 3  # 无参数不过滤


# ---------- 患者登录（#19） ----------

def test_legacy_login_translated_and_adapted(gw):
    resp = gw.post("/api/user/login", json={"phone": "13800138001", "password": "123456"})
    assert resp.status_code == 200
    body = resp.json()
    # 旧端消费形状：扁平对象（刻意无 data 字段，否则 unwrap 会取走 data 导致读不到 name/userId）
    assert body["code"] == 200
    assert body["name"] == "开发用户甲"
    assert body["userId"] == "u-dev-1"
    assert "data" not in body


def test_legacy_login_disabled_by_default():
    """安全默认：未显式开启 legacy 登录开关（生产档）时，dev 替身条目直接 404。

    该条目用派生 code 换取会话、不做密码校验 —— 生产不得下发（x-migration 已声明），
    因此默认必须是"关"而不是"开"（fail-safe）。
    """
    settings = GateSettings(business_url="http://business.test", ai_url="http://ai.test")
    app = create_app(settings)
    with TestClient(app) as client:
        app.state.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=mock_business.app),
            base_url="http://business.test",
        )
        resp = client.post("/api/user/login", json={"phone": "13800138001", "password": "123456"})
    assert resp.status_code == 404


def test_auth_header_is_forwarded_upstream(gw):
    """网关必须透传 Authorization（不解析、不改写）—— 鉴权只由业务侧裁决。"""
    resp = gw.get("/api/v1/me", headers={"Authorization": "Bearer at-smoke-token"})
    assert resp.status_code == 200
    # mock_business 回显收到的 Authorization，用于钉死"透传"这件事
    assert resp.json()["data"]["authorization"] == "Bearer at-smoke-token"


def test_upstream_401_envelope_passthrough(gw):
    """上游 401 必须原样透传（含统一错误信封），不被网关改写状态码或吞掉。"""
    resp = gw.get("/api/v1/me", headers={"Authorization": "Bearer at-mock-401"})
    assert resp.status_code == 401
    body = resp.json()
    assert body["code"] == "UNAUTHORIZED"
    assert body["message"] == "未登录或登录态无效"


def test_legacy_login_upstream_rejects_without_gateway_headers(gw):
    # 反向验证头注入确有发生：直接对上游调用（缺失 X-Client-Version/X-Platform）应 400
    import asyncio

    async def _direct():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=mock_business.app), base_url="http://business.test") as c:
            return await c.post("/api/v1/auth/wechat/login", json={"code": "x" * 8, "consentVersion": "v1"})

    resp = asyncio.run(_direct())
    assert resp.status_code == 400
