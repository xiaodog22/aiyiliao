"""TRIAGE 执行器测试：成功路径 + 三类快降级（不可达/模型缺失/超时/输出非法）。

注入方式：httpx.MockTransport（不触网） + 假探针（控制"模型在位"状态）。
"""

from __future__ import annotations

import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.capabilities import CapabilityProbe
from app.config import Settings
from app.executors import build_triage_executor
from app.main import create_app
from app.models import TaskType

from conftest import BASE, fake_ollama_probe


def _settings(tmp_path) -> Settings:
    return Settings(
        store_path=tmp_path / "tasks.json",
        ollama_url="http://ollama.test",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=30,
        triage_timeout_seconds=5,
        result_ttl_seconds=3600,
        queue_max=10,
        auth_mode="off",
        log_level="WARNING",
    )


def _make_client(tmp_path, handler, probe_result=fake_ollama_probe):
    """构造注入了 MockTransport 的 TRIAGE 执行器应用。"""
    settings = _settings(tmp_path)
    transport = httpx.MockTransport(handler)

    async def probe_fn(url, timeout):
        value = probe_result
        return await value(url, timeout) if callable(value) else value

    probe = CapabilityProbe(settings, ollama_probe=probe_fn)
    app = create_app(
        settings,
        executors={TaskType.TRIAGE: build_triage_executor(settings, probe, transport=transport)},
        ollama_probe=probe_fn,
    )
    return TestClient(app)


def _submit_triage(client, text="肚子疼，还拉肚子两天了"):
    return client.post(
        BASE,
        json={
            "tenantId": "t1",
            "userId": "u1",
            "taskType": "TRIAGE",
            "policyVersion": "policy-1",
            "traceId": "trace-triage-1",
            "inputInline": text,
        },
        headers={"Idempotency-Key": "triage-key-0001"},
    )


def _wait_terminal(client, task_id, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = client.get(f"{BASE}/{task_id}")
        assert resp.status_code == 200
        data = resp.json()["data"]
        if data["status"] in ("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"):
            return data
        time.sleep(0.05)
    raise AssertionError("任务未在期限内到达终态")


def _ok_handler(departments):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/generate"
        payload = json.loads(request.content)
        return httpx.Response(
            200,
            json={"model": payload["model"], "response": json.dumps({"recommendedDepartments": departments}, ensure_ascii=False)},
        )

    return handler


def test_triage_success_flow(tmp_path):
    handler = _ok_handler([
        {"departmentName": "消化内科", "reason": "腹痛腹泻提示消化道症状", "confidence": 0.82},
        {"departmentName": "全科医学科", "reason": "作为兜底", "confidence": 0.5},
    ])
    with _make_client(tmp_path, handler) as client:
        task_id = _submit_triage(client).json()["data"]["taskId"]
        task = _wait_terminal(client, task_id)

    assert task["status"] == "SUCCEEDED"
    assert task["progressPhase"] is None
    result = task["result"]
    assert result["provenance"] == "AI_GENERATED"
    assert result["promptTemplateVersion"] == "triage-supplement-v2"
    assert [d["departmentName"] for d in result["recommendedDepartments"]] == ["消化内科", "全科医学科"]
    assert task["modelId"] == "qwen2.5:0.5b"  # 默认 small-default
    assert task["promptTemplateVersion"] == "triage-supplement-v2"


def test_triage_normalizes_and_caps_departments(tmp_path):
    # 注意：P0③ 之后 triage 只接受本院科室白名单（config/triage-departments.json）内的科室，
    # 因此这里使用白名单内科室名验证“规范化 + 截断到 3 条”的行为。
    handler = _ok_handler([
        {"departmentName": "消化内科", "confidence": 2.0},      # 越界 → 丢 confidence
        {"departmentName": "  ", "reason": "空名"},              # 丢条目
        "not-a-dict",                                            # 丢条目
        {"departmentName": "呼吸内科"},
        {"departmentName": "心血管内科"},
        {"departmentName": "骨科"},                              # 超出上限应被截掉
        {"departmentName": "急诊科"},                            # 超出上限应被截掉
    ])
    with _make_client(tmp_path, handler) as client:
        task = _wait_terminal(client, _submit_triage(client).json()["data"]["taskId"])

    assert task["status"] == "SUCCEEDED"
    names = [d["departmentName"] for d in task["result"]["recommendedDepartments"]]
    assert names == ["消化内科", "呼吸内科", "心血管内科"]        # 截断到 3 条
    assert "confidence" not in task["result"]["recommendedDepartments"][0]


def test_triage_filters_non_whitelisted_departments_to_fallback(tmp_path):
    """白名单外科室应被过滤，全部被过滤时回退到 fallbackDepartment。

    ⚠️ 2026-10-24：白名单已扩到院内 15 个科室（含眼科/耳鼻喉科），
    原测试拿「眼科」当白名单外样本已经失效 —— 改用院内确实没有的科室名。
    """
    handler = _ok_handler([
        {"departmentName": "内科"},
        {"departmentName": "外科"},
        {"departmentName": "康复科"},
    ])
    with _make_client(tmp_path, handler) as client:
        task = _wait_terminal(client, _submit_triage(client).json()["data"]["taskId"])

    assert task["status"] == "SUCCEEDED"
    names = [d["departmentName"] for d in task["result"]["recommendedDepartments"]]
    assert names == ["全科医学科"], f"白名单外科室应全部被过滤并回退兜底：{names}"


def test_triage_fast_fail_when_ollama_unreachable(tmp_path):
    async def probe_none(url, timeout):
        return None

    def handler(request):  # 不应被调用
        raise AssertionError("探针已判定不可达，不应发起生成请求")

    started = time.perf_counter()
    with _make_client(tmp_path, handler, probe_result=probe_none) as client:
        task = _wait_terminal(client, _submit_triage(client).json()["data"]["taskId"])
    elapsed = time.perf_counter() - started

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert task["error"]["dependency"] == "ollama"
    assert task["error"]["retryable"] is True
    assert elapsed < 2.0  # 快降级：秒级失败，不让上游等待


def test_triage_fast_fail_when_model_missing(tmp_path):
    async def probe_other(url, timeout):
        return ["some-other-model"]

    def handler(request):
        raise AssertionError("模型缺失应在探针阶段拦截")

    with _make_client(tmp_path, handler, probe_result=probe_other) as client:
        task = _wait_terminal(client, _submit_triage(client).json()["data"]["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert "qwen2.5:0.5b" in task["error"]["message"]


def test_triage_model_timeout(tmp_path):
    def handler(request):
        raise httpx.ReadTimeout("read timeout", request=request)

    with _make_client(tmp_path, handler) as client:
        task = _wait_terminal(client, _submit_triage(client).json()["data"]["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "MODEL_TIMEOUT"
    assert task["error"]["dependency"] == "ollama"


def test_triage_invalid_json_output(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"model": "qwen2.5:0.5b", "response": "抱歉，我建议去内科。"})

    with _make_client(tmp_path, handler) as client:
        task = _wait_terminal(client, _submit_triage(client).json()["data"]["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "MODEL_OUTPUT_INVALID"


def test_triage_missing_structure(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"model": "qwen2.5:0.5b", "response": json.dumps({"foo": "bar"})})

    with _make_client(tmp_path, handler) as client:
        task = _wait_terminal(client, _submit_triage(client).json()["data"]["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "MODEL_OUTPUT_INVALID"


def test_triage_empty_input_fails_fast(tmp_path):
    def handler(request):
        raise AssertionError("空输入不应发起生成请求")

    with _make_client(tmp_path, handler) as client:
        resp = client.post(
            BASE,
            json={
                "tenantId": "t1",
                "userId": "u1",
                "taskType": "TRIAGE",
                "policyVersion": "policy-1",
                "traceId": "trace-triage-2",
            },
            headers={"Idempotency-Key": "triage-key-0002"},
        )
        task = _wait_terminal(client, resp.json()["data"]["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "INVALID_INPUT"
    assert task["error"]["retryable"] is False
