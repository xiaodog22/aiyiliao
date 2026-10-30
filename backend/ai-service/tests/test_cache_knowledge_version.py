"""缓存键 × 知识库版本（2026-10-22 修复）。

缺陷（事实复核 §3-⑨）：`tasks.py` 曾把 `knowledgeSnapshot` 恒写 `None`，而上游 business-service
从不赋值 → 缓存键里这一维**永远为空**。后果：改完 `config/hospital-knowledge.json`
（例如门诊时间、科室口径）后，TTL 内（默认 3600s）仍会命中**旧答案**，用户看到过时的院内事实。

修复：受理任务时把知识库 `version` 写进 `knowledgeSnapshot`（取不到则 `unknown`），
它本来就是 `compute_cache_key` 的一个分量 → 版本一变，旧条目自然不再命中。

本文件锁定：
1. 受理后任务记录里的 `knowledgeSnapshot` = 知识库版本（不是 None）；
2. 版本不同 → 同一输入的缓存键不同；版本相同 → 键相同。
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from app.cache import compute_cache_key
from app.config import Settings
from app.main import create_app

BASE = "/internal/v1/tasks"
REAL_KB = Path(__file__).resolve().parent.parent / "config" / "hospital-knowledge.json"


def _settings(tmp_path, kb_path, **overrides) -> Settings:
    base = dict(
        store_path=tmp_path / "tasks.json",
        cache_path=tmp_path / "cache.json",
        cache_enabled=True,
        tenant_secret="t" * 64,
        ollama_url="http://127.0.0.1:9",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=5,
        queue_max=10,
        auth_mode="off",
        log_level="WARNING",
        knowledge_base_path=kb_path,
    )
    base.update(overrides)
    return Settings(**base)


def _write_kb(path, version: str) -> None:
    path.write_text(
        json.dumps({
            "version": version,
            "scenarios": {"chat": {"budgetTokens": 10, "knowledge": [{"content": "x", "priority": 1}]}},
        }, ensure_ascii=False),
        encoding="utf-8",
    )


def _submit(client, key: str) -> None:
    body = {
        "tenantId": "t1", "userId": "u1", "taskType": "TRIAGE",
        "policyVersion": "p1", "traceId": f"trace-{key}",
        "inputInline": "胃疼两天",
    }
    resp = client.post(BASE, json=body, headers={"Idempotency-Key": key})
    assert resp.status_code == 200, resp.text


def _stored_snapshots(settings: Settings) -> list:
    deadline = time.time() + 5
    while time.time() < deadline:
        data = json.loads(settings.store_path.read_text(encoding="utf-8"))
        tasks = data.get("tasks") or data
        values = [t.get("knowledgeSnapshot") for t in (tasks.values() if isinstance(tasks, dict) else tasks)]
        if values:
            return values
        time.sleep(0.02)
    raise AssertionError("任务未落库")


def test_submitted_task_records_knowledge_version(tmp_path):
    """真实知识库：受理即记录 version（修复前恒为 None）。

    断言随真实知识库动态取值（2026-10-23 修正：不再硬编码 v2，避免知识库升级
    到 v3/v4… 时测试与数据漂移导致误报）。
    """
    data = json.loads(REAL_KB.read_text(encoding="utf-8"))
    expected_version = data.get("version", "unknown")
    settings = _settings(tmp_path, REAL_KB)
    with TestClient(create_app(settings, executors={})) as client:
        _submit(client, "kb-key-0001")

    snapshots = _stored_snapshots(settings)
    assert snapshots and snapshots[0] == expected_version, snapshots


def test_custom_knowledge_version_is_recorded(tmp_path):
    """自定义版本号同样写入（证明取的是 loader.version，不是硬编码）。"""
    kb = tmp_path / "kb.json"
    _write_kb(kb, "kb-test-v9")
    settings = _settings(tmp_path, kb)
    with TestClient(create_app(settings, executors={})) as client:
        _submit(client, "kb-key-0002")

    assert _stored_snapshots(settings)[0] == "kb-test-v9"


def test_cache_key_differs_across_knowledge_versions():
    """版本是缓存键的分量：版本变 → 键变（旧条目不再命中）；版本同 → 键同。"""
    task_a = {"taskType": "CHAT", "tenantId": "t1", "inputInline": "门诊时间", "knowledgeSnapshot": "kb-v1"}
    task_b = {**task_a, "knowledgeSnapshot": "kb-v2"}

    kwargs = dict(tenant_secret="s" * 64, prompt_template_version="consultation-chat-v1", model_id="qwen2.5:0.5b")
    key_a = compute_cache_key(task_a, **kwargs)
    key_b = compute_cache_key(task_b, **kwargs)

    assert key_a and key_b
    assert key_a != key_b, "知识库版本变化必须改变缓存键，否则会命中旧口径答案"
    assert key_a == compute_cache_key(dict(task_a), **kwargs)
