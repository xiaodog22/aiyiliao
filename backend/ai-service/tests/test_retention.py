"""M4 硬化前瞻（提前到 M3）：周期清理（任务 TTL / 裁剪）与 TTS 产物回收。

覆盖三件事：
1. `TaskService.sweep()`：把超时未终结的任务推进为 `EXPIRED`、按保留期裁剪历史任务；
2. `retention.sweep_tts_artifacts()`：只删「未被引用 + 已过 TTL + 文件名合规」的产物；
3. `referenced_audio_filenames()`：以任务 `result.audioUrl` 为唯一引用来源。
"""

from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timedelta, timezone

from app.config import Settings
from app.retention import referenced_audio_filenames, sweep_tts_artifacts
from app.store import TaskStore
from app.tasks import TaskService

NOW = datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc)

VALID = "a1b2c3d4e5f60718.mp3"


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _settings(tmp_path) -> Settings:
    return Settings(
        store_path=tmp_path / "tasks.json",
        task_timeout_seconds=300,
        result_ttl_seconds=3600,
        task_retention_seconds=86400,
        tts_artifact_ttl_seconds=3600,
        log_level="WARNING",
    )


def _task(task_id: str, created: datetime, *, status: str = "SUCCEEDED", expires_at: datetime | None = None) -> dict:
    return {
        "taskId": task_id,
        "status": status,
        "taskType": "CHAT",
        "createdAt": _iso(created),
        "finishedAt": _iso(created) if status != "RUNNING" else None,
        "expiresAt": _iso(expires_at or (created + timedelta(seconds=3600))),
        "result": None,
        "error": None,
    }


def _service(tmp_path) -> TaskService:
    settings = _settings(tmp_path)
    service = TaskService(TaskStore(settings.store_path), settings, cache=None)
    return service


def test_sweep_expires_timed_out_active_task(tmp_path):
    service = _service(tmp_path)
    # 超过 task_timeout（300s）仍未终结 → EXPIRED
    service.store.tasks["t_old"] = _task("t_old", NOW - timedelta(seconds=400), status="RUNNING")

    stats = asyncio.run(service.sweep(now=NOW))

    assert stats["expired"] == 1
    assert service.store.tasks["t_old"]["status"] == "EXPIRED"


def test_sweep_keeps_fresh_active_task(tmp_path):
    service = _service(tmp_path)
    service.store.tasks["t_new"] = _task("t_new", NOW - timedelta(seconds=10), status="RUNNING")

    stats = asyncio.run(service.sweep(now=NOW))

    assert stats["expired"] == 0
    assert service.store.tasks["t_new"]["status"] == "RUNNING"


def test_sweep_prunes_tasks_past_retention(tmp_path):
    service = _service(tmp_path)
    service.store.tasks["t_ancient"] = _task("t_ancient", NOW - timedelta(seconds=86400 * 2))  # 超过 24h
    service.store.tasks["t_recent"] = _task("t_recent", NOW - timedelta(seconds=60))

    stats = asyncio.run(service.sweep(now=NOW))

    assert stats["pruned"] == 1
    assert "t_ancient" not in service.store.tasks
    assert "t_recent" in service.store.tasks


def test_sweep_prunes_stale_idempotency_index(tmp_path):
    service = _service(tmp_path)
    service.store.tasks["t_ancient"] = _task("t_ancient", NOW - timedelta(seconds=86400 * 2))
    service.store.idempotency["key-1"] = {"taskId": "t_ancient", "digest": "d"}

    asyncio.run(service.sweep(now=NOW))

    assert "key-1" not in service.store.idempotency


# ---------- TTS 产物回收 ----------

def _write(directory, name: str, *, age_seconds: int) -> None:
    path = directory / name
    path.write_bytes(b"ID3-fake")
    stamp = time.time() - age_seconds
    os.utime(path, (stamp, stamp))


def test_sweep_artifacts_removes_stale_unreferenced(tmp_path):
    tts = tmp_path / "tts"
    tts.mkdir()
    _write(tts, VALID, age_seconds=7200)              # 2h 前、无引用 → 删

    removed = sweep_tts_artifacts(tts, referenced=set(), ttl_seconds=3600)

    assert removed == 1
    assert not (tts / VALID).exists()


def test_sweep_artifacts_keeps_referenced(tmp_path):
    tts = tmp_path / "tts"
    tts.mkdir()
    _write(tts, VALID, age_seconds=7200)

    removed = sweep_tts_artifacts(tts, referenced={VALID}, ttl_seconds=3600)

    assert removed == 0
    assert (tts / VALID).exists()


def test_sweep_artifacts_keeps_fresh_file(tmp_path):
    tts = tmp_path / "tts"
    tts.mkdir()
    _write(tts, VALID, age_seconds=10)                # 未过 TTL → 保留

    removed = sweep_tts_artifacts(tts, referenced=set(), ttl_seconds=3600)

    assert removed == 0
    assert (tts / VALID).exists()


def test_sweep_artifacts_ignores_non_matching_names(tmp_path):
    tts = tmp_path / "tts"
    tts.mkdir()
    (tts / "notes.txt").write_text("keep me", encoding="utf-8")
    (tts / "abc.mp3").write_bytes(b"short-name")      # 不满足 16~64 位十六进制
    old = time.time() - 7200
    os.utime(tts / "notes.txt", (old, old))
    os.utime(tts / "abc.mp3", (old, old))

    removed = sweep_tts_artifacts(tts, referenced=set(), ttl_seconds=3600)

    assert removed == 0
    assert (tts / "notes.txt").exists() and (tts / "abc.mp3").exists()


def test_sweep_artifacts_missing_dir_is_noop(tmp_path):
    assert sweep_tts_artifacts(tmp_path / "nope", referenced=set(), ttl_seconds=3600) == 0


def test_referenced_filenames_parsed_from_audio_url():
    tasks = [
        {"result": {"audioUrl": f"http://127.0.0.1:8000/api/gw/tts/audio/{VALID}?token=1.abc"}},
        {"result": {"audioUrl": "http://host/api/gw/tts/audio/" + "b" * 16 + ".mp3"}},
        {"result": None},
        {"result": {"audioUrl": ""}},
        {"result": "不是对象"},
        {},
    ]

    names = referenced_audio_filenames(tasks)

    assert names == {VALID, "b" * 16 + ".mp3"}
