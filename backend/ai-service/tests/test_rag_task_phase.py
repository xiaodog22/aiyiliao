"""独立 RAG 任务的阶段名回归（2026-10-22 修复）。

缺陷：`rag.py` 曾调用 `ctx.set_phase("embedding")`，而 `TaskContext` 只接受契约枚举
`queued / safety_check / retrieval / generation / postprocess / synthesis`
（`backend/contracts/ai-openapi.yaml:397`）→ 提交独立 `RAG` 任务在**第一阶段就抛
`ValueError: 非法阶段名：embedding`**，被兜底成 `INTERNAL_ERROR / 执行器内部错误`。

为什么原有 6 项 RAG 测试没抓到：它们都用 `MockContext`（`set_phase` 空实现），
绕过了真实 `TaskContext` 的枚举校验；只有经 `TaskService` 跑的任务才会校验。

本文件用**真 TaskService + TestClient** 锁死：
1. 检索命中：SUCCEEDED、documents 非空、字段齐全；
2. 检索失败：SUCCEEDED + documents 空 + provenance=RAG_RETRIEVAL_FAILED（降级不阻断）；
3. 两种路径都不得出现 INTERNAL_ERROR。
"""

from __future__ import annotations

import json
import time

import httpx
from fastapi.testclient import TestClient

from app.config import Settings
from app.executors.rag import build_rag_executor
from app.main import create_app
from app.models import TaskType

BASE = "/internal/v1/tasks"
TERMINAL = {"SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"}


def _settings(tmp_path) -> Settings:
    return Settings(
        store_path=tmp_path / "tasks.json",
        cache_path=tmp_path / "cache.json",
        ollama_url="http://ollama.test",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=60,
        result_ttl_seconds=3600,
        queue_max=10,
        auth_mode="off",
        log_level="WARNING",
        rag_enabled=True,
        rag_store="qdrant",
        qdrant_url="http://qdrant.test",
        qdrant_collection="health_kb",
        embedding_model="nomic-embed-text",
        rag_max_retries=0,
    )


def _client(settings, transport) -> TestClient:
    executor = build_rag_executor(settings, probe=None, transport=transport)
    return TestClient(create_app(settings, executors={TaskType.RAG: executor}))


def _run(client, key: str) -> dict:
    body = {
        "tenantId": "t1", "userId": "u1", "taskType": "RAG",
        "policyVersion": "policy-1", "traceId": f"trace-{key}",
        "inputInline": "高血压要注意什么",
    }
    task_id = client.post(BASE, json=body, headers={"Idempotency-Key": key}).json()["data"]["taskId"]
    deadline = time.time() + 20
    while time.time() < deadline:
        data = client.get(f"{BASE}/{task_id}").json()["data"]
        if data["status"] in TERMINAL:
            return data
        time.sleep(0.02)
    raise AssertionError("RAG 任务未在期限内到达终态")


def _ok_handler(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/api/embeddings"):
        return httpx.Response(200, json={"embedding": [0.1, 0.2, 0.3]})
    return httpx.Response(200, json={"result": [{
        "score": 0.91,
        "payload": {
            "documentId": "kb_001", "chunkId": "kb_001_p1",
            "content": "高血压患者应低盐饮食并规律监测血压。",
            "title": "高血压防治", "source": "院内科普",
        },
    }]})


def test_rag_task_succeeds_with_valid_phase(tmp_path):
    """命中检索：任务必须 SUCCEEDED（此前因非法 phase 恒 FAILED）。"""
    settings = _settings(tmp_path)
    with _client(settings, httpx.MockTransport(_ok_handler)) as client:
        task = _run(client, "rag-ok-1")

    assert task["status"] == "SUCCEEDED", task.get("error")
    result = task["result"]
    assert result["provenance"] == "RAG_RETRIEVED"
    assert len(result["documents"]) == 1
    doc = result["documents"][0]
    assert doc["documentId"] == "kb_001" and doc["chunkId"] == "kb_001_p1"
    assert doc["score"] == 0.91
    assert doc["metadata"]["title"] == "高血压防治"
    # 终态允许把 progressPhase 清成 null（契约 enum 含 null），所以只校验"不是非法值"
    assert task.get("progressPhase") in (None, "retrieval"), task.get("progressPhase")


def test_rag_task_degrades_without_internal_error(tmp_path):
    """检索全失败：SUCCEEDED + 空 documents（降级），且**不得**是 INTERNAL_ERROR。"""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "unavailable"})

    settings = _settings(tmp_path)
    with _client(settings, httpx.MockTransport(handler)) as client:
        task = _run(client, "rag-down-1")

    assert task["status"] == "SUCCEEDED", task.get("error")
    assert task["result"]["documents"] == []
    assert task["result"]["provenance"] == "RAG_RETRIEVAL_FAILED"
    assert (task.get("error") or {}).get("code") != "INTERNAL_ERROR"
