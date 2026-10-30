"""兼容层纯函数单测：命中、翻译、pending/dropped 错误语义。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import compat  # noqa: E402
from app.envelope import ApiError  # noqa: E402


def test_match_exact_translate_entry():
    entry = compat.match("POST", "/api/v1/consultation/emergency/check")
    assert entry is not None
    assert entry["kind"] == "translate"
    assert entry["target"] == "/api/v1/triage/emergency-checks"


def test_match_prefix_dynamic_entry():
    entry = compat.match("GET", "/api/v1/consultation/status/abc123")
    assert entry is not None
    assert entry["kind"] == "pending"
    assert entry["milestone"] == "M2"


def test_match_miss_falls_through_to_proxy():
    assert compat.match("GET", "/api/v1/me") is None
    assert compat.match("POST", "/api/v1/appointments") is None


def test_translate_text_query_to_body():
    entry = compat.match("POST", "/api/v1/consultation/emergency/check")
    body, content_type = compat.translate_body(entry, "", {"text": "胸口压榨样疼"}, b"")
    assert content_type == "application/json"
    assert json.loads(body) == {"text": "胸口压榨样疼"}


def test_translate_recommend_text_to_symptoms():
    entry = compat.match("POST", "/api/v1/case/recommend-department")
    body, content_type = compat.translate_body(entry, "", {}, json.dumps({"text": "肚子疼"}).encode("utf-8"))
    assert content_type == "application/json"
    assert json.loads(body) == {"symptoms": "肚子疼"}


def test_translate_keeps_new_shape_untouched():
    entry = compat.match("POST", "/api/v1/case/recommend-department")
    original = json.dumps({"symptoms": "头疼", "ageBand": "adult"}).encode("utf-8")
    body, content_type = compat.translate_body(entry, "", {}, original)
    assert content_type is None
    assert body == original


def test_pending_raises_501_with_migration_note():
    entry = compat.match("POST", "/api/v1/consultation/start")
    with pytest.raises(ApiError) as excinfo:
        compat.raise_for(entry)
    assert excinfo.value.http_status == 501
    assert excinfo.value.code == "COMPAT_PENDING"


def test_dropped_raises_410():
    entry = compat.match("POST", "/api/v1/voice/voices/reload")
    with pytest.raises(ApiError) as excinfo:
        compat.raise_for(entry)
    assert excinfo.value.http_status == 410
    assert excinfo.value.code == "COMPAT_DROPPED"


# ==========================================================================
# M1：响应适配器 + 条目接线自洽性
# ==========================================================================

def _ok_doc(data, code="OK", message="成功"):
    return {"code": code, "message": message, "requestId": "rid-1", "serverTime": "2026-10-15T00:00:00Z", "data": data}


def test_emergency_adapter_maps_legacy_fields():
    out = compat.emergency_legacy_view(
        _ok_doc({"emergency": True, "level": "EMERGENCY", "matchedRules": ["胸痛"], "advice": "立即就医"}),
        {},
    )
    assert out["code"] == 200                       # 信封降级
    assert out["data"]["is_emergency"] is True
    assert out["data"]["risk_level"] == "high"
    assert out["data"]["emergency_message"] == "立即就医"
    assert out["data"]["matched_keywords"] == ["胸痛"]
    assert out["data"]["safe"] is False
    assert out["data"]["emergency"] is True          # 原字段保留
    assert out["requestId"] == "rid-1"


def test_emergency_adapter_non_emergency_keeps_lowercase_level():
    out = compat.emergency_legacy_view(_ok_doc({"emergency": False, "level": "URGENT"}), {})
    assert out["data"]["risk_level"] == "urgent"
    assert out["data"]["is_emergency"] is False


def test_emergency_adapter_malformed_returns_none():
    assert compat.emergency_legacy_view({"code": "OK", "data": "不是对象"}, {}) is None


def test_recommend_adapter_first_department_to_clinic():
    out = compat.recommend_legacy_view(
        _ok_doc({
            "recommendedDepartments": [
                {"departmentName": "消化内科", "reason": "腹痛提示消化道问题"},
                {"departmentName": "全科医学科"},
            ],
            "guidance": "建议提前预约",
        }),
        {},
    )
    assert out["data"]["clinic"] == "消化内科"
    assert out["data"]["dept"] == "消化内科"
    assert out["data"]["reason"] == "腹痛提示消化道问题"


def test_recommend_adapter_empty_departments_falls_back_to_guidance():
    out = compat.recommend_legacy_view(_ok_doc({"recommendedDepartments": [], "guidance": "请补充描述"}), {})
    assert out["data"]["clinic"] == ""
    assert out["data"]["reason"] == "请补充描述"


def test_doctor_list_adapter_maps_fields_without_dropping_new():
    out = compat.doctor_list_legacy_view(
        _ok_doc([
            {"id": "doc-1", "name": "张医生", "departmentId": "d-1", "departmentName": "消化内科",
             "title": "主任医师", "specialties": ["胃炎", "肠炎"], "hasAvailableSlot": True},
            {"id": "doc-2", "name": "李医生", "departmentId": "d-1", "departmentName": "消化内科",
             "title": "副主任医师", "hasAvailableSlot": False},
            {"id": "doc-3", "name": "王医生", "departmentId": "d-2", "departmentName": "骨科",
             "title": "主治医师", "hasAvailableSlot": None},
        ]),
        {},
    )
    arr = out["data"]
    assert arr[0]["department"] == "消化内科" and arr[0]["expertise"] == "胃炎、肠炎" and arr[0]["status"] == "可预约"
    assert arr[1]["expertise"] == "" and arr[1]["status"] == "约满"
    assert arr[2]["status"] == ""
    assert arr[0]["id"] == "doc-1" and arr[0]["departmentName"] == "消化内科"  # 新字段保留


def test_doctor_by_department_adapter_filters():
    doc = _ok_doc([
        {"id": "doc-1", "name": "张医生", "departmentId": "d-1", "departmentName": "消化内科", "title": "主任医师"},
        {"id": "doc-3", "name": "王医生", "departmentId": "d-2", "departmentName": "骨科", "title": "主治医师"},
    ])
    by_name = compat.doctor_by_department_legacy_view(doc, {"dept": "消化内科"})
    assert [x["name"] for x in by_name["data"]] == ["张医生"]
    by_id = compat.doctor_by_department_legacy_view(doc, {"dept": "d-2"})
    assert [x["name"] for x in by_id["data"]] == ["王医生"]
    no_filter = compat.doctor_by_department_legacy_view(doc, {})
    assert len(no_filter["data"]) == 2


def test_login_adapter_flat_shape_no_data_field():
    out = compat.legacy_login_view(
        _ok_doc({
            "accessToken": "a", "refreshToken": "b", "expiresIn": 7200, "tokenType": "Bearer",
            "user": {"id": "u-dev-1", "displayName": "开发用户甲", "roles": ["PATIENT"]},
        }),
        {},
    )
    assert out["code"] == 200
    assert out["name"] == "开发用户甲"
    assert out["userId"] == "u-dev-1"
    assert "data" not in out  # 关键：旧端 unwrap 依赖扁平对象


def test_legacy_login_translator_builds_dev_shim_payload():
    body, ctype = compat.translate_body(
        compat.match("POST", "/api/user/login"), "/api/user/login", {}, b'{"phone":"13800138001","password":"x"}'
    )
    payload = json.loads(body)
    assert ctype == "application/json"
    assert payload["code"] == "legacy-compat-13800138001"
    assert payload["phoneCode"] == "dev-phone-13800138001"
    assert payload["consentVersion"]


def test_drops_query_semantics():
    assert compat.drops_query(compat.match("POST", "/api/v1/consultation/emergency/check")) is True
    assert compat.drops_query(compat.match("GET", "/api/v1/doctor/list")) is True
    assert compat.drops_query(compat.match("POST", "/api/v1/case/recommend-department")) is False


def test_response_adapter_for_missing_name_raises_500():
    with pytest.raises(ApiError) as excinfo:
        compat.response_adapter_for({"responseAdapter": "不存在的适配器"}, {})
    assert excinfo.value.http_status == 500
    assert excinfo.value.code == "COMPAT_ADAPTER_MISSING"


def test_all_entries_reference_existing_handlers():
    """条目自洽性：所有 adapter / translator 名称必须可解析（防手误写空转）。"""
    for entry in compat.ENTRIES:
        assert entry.get("kind") in ("self", "forward", "translate", "pending", "dropped", "same_path"), entry
        if entry.get("responseAdapter"):
            assert entry["responseAdapter"] in compat.RESPONSE_ADAPTERS, entry
        if entry.get("translator"):
            assert entry["translator"] in ("text_query_to_body", "text_body_to_symptoms", "legacy_login_to_wechat"), entry
        status = entry.get("status")
        if status is not None:
            assert status in ("active", "pending", "dropped", "same-path"), entry
        if entry.get("kind") == "translate":
            assert entry.get("target"), entry


def test_m1_entries_no_longer_pending():
    """M1 归属项已全部转 active；M2/M3 保持 pending。"""
    assert compat.match("GET", "/api/v1/doctor/list")["kind"] == "translate"
    assert compat.match("GET", "/api/v1/doctor/by-department")["kind"] == "translate"
    assert compat.match("POST", "/api/user/login")["kind"] == "translate"
    assert compat.match("POST", "/api/v1/consultation/start")["kind"] == "pending"
    assert compat.match("POST", "/api/appoint/updateStatus")["kind"] == "pending"
    assert compat.match("POST", "/api/v1/bed/update/9")["kind"] == "pending"
