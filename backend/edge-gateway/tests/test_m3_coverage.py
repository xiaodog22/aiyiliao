"""M3 · 医生端与合规面：网关「不缺项」核验 + 两条 legacy 兼容条目的处置留痕。

M3 的 D 侧职责（`docs/v4/08A` §M3）= **网关不缺项**；本用例把「不缺项」做成可执行断言，
而不是靠人工看表：

1. **契约路径全部直通**：M3 全部契约路径（医生端 + 床位 + 档案 + 家庭 + 同意/删除 + 内容）
   不经任何兼容条目拦截，由 `catch-all` 全量代理到 business（用 mock 回声证明请求真的到达上游）。
2. **legacy 路径不伪装**：#17（`POST /api/appoint/updateStatus`）与 #18（`/api/v1/bed/update/{id}`）
   **不可等价转发**（缺乐观锁版本 / 状态枚举不可双射 / `patientRef` 禁传姓名 / 缺幂等头），
   必须返回 `501 COMPAT_PENDING` 并给出逐条原因——**不得**转发到上游换回一个令人误解的 404。
3. **方法差异已覆盖**：#18 前端实际用 **PUT**，`x-migration` 登记为 **POST**，两种方法均已注册。

背景（`docs/v4/08-后端实施双Agent总纲.md` §5.1 M3）：COMPAT 待激活项 = #17/#18，均为 M3。
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import compat  # noqa: E402
from app.config import GateSettings  # noqa: E402
from app.main import create_app  # noqa: E402

import mock_business  # noqa: E402

# M3 契约路径 × 方法（来源：miniprogram/config/api.js 实际调用 + business-openapi.yaml tags[doctor]/合规面）。
# 路径参数取占位实值，形状与契约一致。
M3_CONTRACT_ROUTES = [
    ("POST", "/api/v1/doctor/login"),
    ("GET", "/api/v1/doctor/workbench"),
    ("GET", "/api/v1/doctor/appointments"),
    ("POST", "/api/v1/doctor/appointments/apt-0001/status"),
    ("GET", "/api/v1/beds"),
    ("POST", "/api/v1/beds/bed-0001/assignment"),
    ("GET", "/api/v1/health-records"),
    ("GET", "/api/v1/family-members"),
    ("POST", "/api/v1/family-members/invitations"),
    ("GET", "/api/v1/consents"),
    ("POST", "/api/v1/consents/RESEARCH/withdraw"),
    ("POST", "/api/v1/me/deletion-requests"),
    ("GET", "/api/v1/contents"),
    ("GET", "/api/v1/appointments/me"),          # 医生端预约列表（前端复用患者侧列表契约）
    ("GET", "/api/v1/departments"),              # 医生端科室目录
]

# M3 legacy（兼容层承接）路径 × 方法。
M3_LEGACY_ROUTES = [
    ("POST", "/api/appoint/updateStatus"),
    ("PUT", "/api/v1/bed/update/bed-0001"),      # 前端实际方法（doctor.js updateBed 用 put）
    ("POST", "/api/v1/bed/update/bed-0001"),     # x-migration 声明方法
]


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


# ---------- 1. 兼容层不拦截任何 M3 契约路径 ----------

@pytest.mark.parametrize("method,path", M3_CONTRACT_ROUTES)
def test_no_compat_entry_intercepts_m3_contract_path(method, path):
    assert compat.match(method, path) is None, f"{method} {path} 被兼容条目拦截，应走全量代理"


@pytest.mark.parametrize("method,path", M3_CONTRACT_ROUTES)
def test_m3_contract_path_reaches_business_via_full_proxy(gw, method, path):
    resp = gw.request(method, path, json={})

    assert resp.status_code == 200
    echoed = resp.json()["data"]
    assert echoed["path"] == path, "上游未收到原路径 → 网关存在缺项"
    assert echoed["method"] == method


# ---------- 2. legacy 路径保持 pending（不转发、不伪造） ----------

@pytest.mark.parametrize("method,path", M3_LEGACY_ROUTES)
def test_m3_legacy_route_returns_501_pending(gw, method, path):
    resp = gw.request(method, path, json={"id": "apt-0001", "status": "就诊中"})

    assert resp.status_code == 501
    body = resp.json()
    assert body["code"] == "COMPAT_PENDING"
    assert "M3" in body["message"]
    assert body["retryable"] is False
    # 拒绝的原因必须逐条给出（不可等价转发），而不是一句笼统的 501。
    details = body.get("details") or []
    assert details, "pending 条目必须携带不可等价转发的逐条原因"


@pytest.mark.parametrize("method,path", M3_LEGACY_ROUTES)
def test_m3_legacy_route_not_forwarded_upstream(gw, method, path):
    """回归护栏：legacy 路径若被误转发，会拿回 mock 回声（含 method/path）→ 视为失败。"""
    resp = gw.request(method, path, json={})

    assert resp.status_code == 501
    assert "path" not in (resp.json().get("data") or {}), "legacy 路径被转发到上游（伪装）"


def test_legacy_appointment_update_blockers_are_specific():
    entry = compat.match("POST", "/api/appoint/updateStatus")
    assert entry["kind"] == "pending"
    assert entry["milestone"] == "M3"
    blockers = " ".join(entry["blockers"])
    assert "expectedVersion" in blockers          # 乐观锁版本缺失
    assert "Idempotency-Key" in blockers          # 幂等头缺失
    assert "状态" in blockers or "枚举" in blockers  # 状态枚举不可双射


def test_legacy_bed_update_registered_for_put_and_post():
    """#18 方法差异：前端 PUT（实际）与 x-migration POST（登记）都必须被 matches 承接。"""
    for method in ("PUT", "POST"):
        entry = compat.match(method, "/api/v1/bed/update/bed-0001")
        assert entry is not None, method
        assert entry["kind"] == "pending"
        assert entry["milestone"] == "M3"


def test_legacy_bed_update_put_has_blockers():
    entry = compat.match("PUT", "/api/v1/bed/update/bed-0001")
    blockers = " ".join(entry["blockers"])
    assert "patientRef" in blockers               # 姓名不可透传（隐私约定）
    assert "action" in blockers
    assert "expectedVersion" in blockers
