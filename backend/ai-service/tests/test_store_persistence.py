"""任务存储落盘健壮性（DEF-06 / BUG-06 回归）。

背景：Windows 上 `os.replace` 会因目标文件被其他句柄占用（杀毒 / 索引 / 并发读）抛
`PermissionError: [WinError 5]`；原实现无 try/except、无重试：
- 在「完成回写」阶段抛 → 结果丢失、business 侧任务永远 QUEUED（前端一直转圈）；
- 在 `set_phase` 阶段抛 → 任务直接 FAILED（模型其实已经跑完）。

本文件锁死三条不变式：
1. 瞬时占用 → 退避重试后成功；
2. 持续不可写 → `save()` 返回 False、不抛异常、清理残留 `.tmp`（内存态仍然有效）；
3. 幂等索引写入失败 → 任务**照常入队**并跑完。
"""

from __future__ import annotations

import asyncio
import os
import time

import pytest

from app.store import TaskStore

BASE = "/internal/v1/tasks"


def test_replace_retries_transient_permission_error(tmp_path, monkeypatch):
    """前 2 次占用、第 3 次成功 → save 仍算成功，且文件真的落盘。"""
    calls = {"n": 0}
    real_replace = os.replace

    def flaky(src, dst):
        calls["n"] += 1
        if calls["n"] < 3:
            raise PermissionError(13, "目标文件被占用")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", flaky)
    store = TaskStore(tmp_path / "tasks.json")
    store.tasks["t_demo"] = {"taskId": "t_demo"}

    assert asyncio.run(store.save()) is True
    assert calls["n"] == 3, "应对瞬时占用做退避重试，而不是一次失败就放弃"
    assert (tmp_path / "tasks.json").exists()


def test_save_swallows_persistent_permission_error(tmp_path, monkeypatch):
    """持续不可写 → 返回 False（不抛），并清理残留 .tmp。"""
    def always_deny(src, dst):
        raise PermissionError(13, "目标文件被占用")

    monkeypatch.setattr(os, "replace", always_deny)
    store = TaskStore(tmp_path / "tasks.json")
    store.tasks["t_demo"] = {"taskId": "t_demo"}

    assert asyncio.run(store.save()) is False
    assert store.tasks["t_demo"]["taskId"] == "t_demo", "内存态不得因落盘失败被破坏"
    assert not (tmp_path / "tasks.json.tmp").exists(), "残留半成品会误导排障，必须清掉"


def test_save_reports_success_on_normal_write(tmp_path):
    store = TaskStore(tmp_path / "tasks.json")
    store.tasks["t_demo"] = {"taskId": "t_demo", "status": "QUEUED"}
    assert asyncio.run(store.save()) is True

    reloaded = TaskStore(tmp_path / "tasks.json")
    asyncio.run(reloaded.load())
    assert reloaded.tasks["t_demo"]["status"] == "QUEUED"


def test_idempotency_index_failure_still_enqueues(client, monkeypatch):
    """幂等索引写失败不得挡住入队：任务必须跑完，不能停在 QUEUED。"""
    store = client.app.state.store

    async def boom(key, task_id, digest):  # noqa: ARG001
        raise RuntimeError("index unavailable")

    monkeypatch.setattr(store, "put_idempotency", boom)

    resp = client.post(
        BASE,
        json={"tenantId": "t1", "userId": "u1", "taskType": "CHAT",
              "policyVersion": "p1", "traceId": "tr-store-1"},
        headers={"Idempotency-Key": "key-index-fail-01"},
    )
    assert resp.status_code == 200
    task_id = resp.json()["data"]["taskId"]

    deadline = time.time() + 8
    status = None
    while time.time() < deadline:
        status = client.get(f"{BASE}/{task_id}").json()["data"]["status"]
        if status in ("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"):
            break
        time.sleep(0.05)
    assert status == "SUCCEEDED", "索引失败只应少一条幂等记录，任务本身必须照常执行"


@pytest.mark.parametrize("path_name", ["nested/dir/tasks.json"])
def test_save_creates_parent_directory(tmp_path, path_name):
    store = TaskStore(tmp_path / path_name)
    assert asyncio.run(store.save()) is True
    assert (tmp_path / path_name).exists()
