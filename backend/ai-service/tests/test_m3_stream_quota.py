"""M3 回归：SSE 单租户并发上限（全局上限之外的第二道配额）。"""

from __future__ import annotations

import pytest

from app.config import Settings
from app.store import TaskStore
from app.tasks import StreamCapacityExceeded, TaskService


def _settings(tmp_path) -> Settings:
    return Settings(
        store_path=tmp_path / "tasks.json",
        queue_max=10,
        auth_mode="off",
        log_level="WARNING",
        tts_output_dir=tmp_path / "tts",
        stream_max_connections=10,
        stream_max_connections_per_tenant=1,
    )


def test_per_tenant_stream_limit_and_release(tmp_path):
    service = TaskService(TaskStore(tmp_path / "tasks.json"), _settings(tmp_path))

    first = service.open_stream("task-a", "tenant-a")
    with pytest.raises(StreamCapacityExceeded, match="tenant-a"):
        service.open_stream("task-b", "tenant-a")

    # 其他租户不受影响；全局上限仍为 10
    service.open_stream("task-c", "tenant-b")

    # 断连/终态释放后，同租户可重新订阅
    service.close_stream("task-a", first)
    replacement = service.open_stream("task-d", "tenant-a")
    assert replacement is not None
