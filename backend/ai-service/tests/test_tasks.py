"""任务接口行为测试：状态机、幂等、取消、过期、校验与未接入执行器的失败语义。"""

from __future__ import annotations

import asyncio
import time
from dataclasses import replace

from fastapi.testclient import TestClient

from app.main import create_app
from app.models import TaskType

from conftest import BASE, echo_executor, fake_ollama_probe


def payload(**overrides):
    body = {
        "tenantId": "t1",
        "userId": "u1",
        "taskType": "CHAT",
        "policyVersion": "policy-1",
        "traceId": "trace-0001",
    }
    body.update(overrides)
    return body


def submit(client, key="key-12345678", body=None):
    return client.post(BASE, json=body or payload(), headers={"Idempotency-Key": key})


def wait_terminal(client, task_id, timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = client.get(f"{BASE}/{task_id}")
        assert resp.status_code == 200
        data = resp.json()["data"]
        if data["status"] in ("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"):
            return data
        time.sleep(0.05)
    raise AssertionError("任务未在期限内到达终态")


def test_submit_requires_idempotency_key(client):
    resp = client.post(BASE, json=payload())
    assert resp.status_code == 400
    assert resp.json()["code"] == "BAD_REQUEST"


def test_submit_and_succeed_flow(client):
    resp = submit(client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == "OK"
    assert body["data"]["status"] in ("QUEUED", "RUNNING")
    task = wait_terminal(client, body["data"]["taskId"])
    assert task["status"] == "SUCCEEDED"
    assert task["result"]["text"] == "测试结果"
    assert task["modelId"] == "stub-echo"
    assert task["progressPhase"] is None
    assert task["finishedAt"] is not None
    assert task["expiresAt"] is not None


def test_idempotent_replay_returns_same_task(client):
    first = submit(client, key="replay-key-0001").json()["data"]["taskId"]
    again = client.post(BASE, json=payload(), headers={"Idempotency-Key": "replay-key-0001"})
    assert again.status_code == 200
    assert again.json()["data"]["taskId"] == first
    assert again.json()["meta"]["idempotentReplay"] is True


def test_idempotency_conflict_on_different_payload(client):
    submit(client, key="conflict-key-0001")
    resp = client.post(BASE, json=payload(taskType="TRIAGE"), headers={"Idempotency-Key": "conflict-key-0001"})
    assert resp.status_code == 409
    assert resp.json()["code"] == "IDEMPOTENCY_CONFLICT"


def test_no_executor_fails_fast_with_capability_code(client):
    resp = submit(client, key="triage-key-0001", body=payload(taskType="TRIAGE"))
    task = wait_terminal(client, resp.json()["data"]["taskId"])
    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert task["error"]["dependency"] == "ollama"
    assert task["error"]["retryable"] is False


def test_cancel_is_best_effort_and_idempotent(settings):
    async def slow_executor(task, ctx):
        await asyncio.sleep(1.2)
        return {"result": {"text": "should-not-be-kept"}}

    app = create_app(settings, executors={TaskType.CHAT: slow_executor}, ollama_probe=fake_ollama_probe)
    with TestClient(app) as test_client:
        running = submit(test_client, key="cancel-run-0001").json()["data"]["taskId"]
        queued = submit(test_client, key="cancel-queue-001").json()["data"]["taskId"]
        time.sleep(0.2)  # 快执行器占用 worker，第二个任务排队

        first = test_client.post(f"{BASE}/{running}/cancel", json={"reason": "USER_CANCELLED"})
        assert first.status_code == 200
        assert first.json()["data"]["status"] == "CANCELLED"

        second = test_client.post(f"{BASE}/{queued}/cancel")
        assert second.status_code == 200
        assert second.json()["data"]["status"] == "CANCELLED"

        # 重复取消：返回同一终态，不报错
        repeat = test_client.post(f"{BASE}/{running}/cancel")
        assert repeat.status_code == 200
        assert repeat.json()["data"]["status"] == "CANCELLED"

        time.sleep(1.4)  # 等慢执行器结束后，结果不得被写回
        final = test_client.get(f"{BASE}/{running}").json()["data"]
        assert final["status"] == "CANCELLED"
        assert final["result"] is None


def test_not_found(client):
    assert client.get(f"{BASE}/t_missing").status_code == 404
    assert client.post(f"{BASE}/t_missing/cancel").status_code == 404


def test_validation_rejects_unknown_field(client):
    body = payload()
    body["surprise"] = 1
    resp = submit(client, key="val-key-000001", body=body)
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_FAILED"


def test_validation_rejects_both_inputs(client):
    resp = submit(client, key="val-key-000002", body=payload(inputRef="ref-1", inputInline="hello"))
    assert resp.status_code == 422


def test_result_expires_after_ttl(settings):
    short_ttl = replace(settings, result_ttl_seconds=1)
    app = create_app(short_ttl, executors={TaskType.CHAT: echo_executor}, ollama_probe=fake_ollama_probe)
    with TestClient(app) as test_client:
        task_id = submit(test_client, key="expire-key-0001").json()["data"]["taskId"]
        task = wait_terminal(test_client, task_id)
        assert task["status"] == "SUCCEEDED"
        time.sleep(1.3)
        expired = test_client.get(f"{BASE}/{task_id}").json()["data"]
        assert expired["status"] == "EXPIRED"
        assert expired["result"] is None
