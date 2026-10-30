"""TTS 产物卫生回归（2026-10-15 M2 门实测缺陷）。

现场：E2E-B1 首次尝试在沙箱出站抖动下产出 **0 字节** `runtime/tts/{digest}.mp3`；
此后同文本（摘要相同）每次都被判为「缓存命中」→ 跳过合成 → 判空失败，**该文本被永久毒化**。
修复：①缓存命中要求「存在且非空」，0 字节残留先删再重合成；
      ②`voice.synthesize` 改为临时文件 + 原子替换，失败/空产物不留半成品；
      ③失败时记录引擎异常原因（不再只记异常类名）。

本文件锁定上述三条契约。
"""

from __future__ import annotations

import hashlib
import time
from pathlib import Path

from fastapi.testclient import TestClient

from app import voice
from app.capabilities import CapabilityProbe
from app.config import Settings
from app.executors import build_tts_executor
from app.main import create_app
from app.models import TaskType

from conftest import BASE, fake_ollama_probe

TERMINAL = ("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED")
TEXT = "请按时服药，注意休息。如有不适请及时就医。"


def _settings(tmp_path) -> Settings:
    return Settings(
        store_path=tmp_path / "tasks.json",
        ollama_url="http://ollama.test",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=30,
        result_ttl_seconds=3600,
        queue_max=10,
        auth_mode="off",
        log_level="WARNING",
        tts_engine="edge",
        tts_output_dir=tmp_path / "tts",
        tts_url_ttl_seconds=600,
    )


def _client(settings, executors) -> TestClient:
    async def probe_fn(url, timeout):
        return await fake_ollama_probe(url, timeout)

    return TestClient(create_app(settings, executors=executors, ollama_probe=probe_fn))


def _submit(client, key, text=TEXT, voice_id="qwen3-female-1"):
    body = {
        "tenantId": "t-dev", "userId": "u-dev", "taskType": "TTS",
        "policyVersion": "p1", "traceId": "t-" + key,
        "inputInline": text,
    }
    if voice_id:
        body["voice"] = voice_id
    return client.post(BASE, json=body, headers={"Idempotency-Key": key}).json()["data"]


def _wait_terminal(client, task_id, timeout=10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = client.get(f"{BASE}/{task_id}").json()["data"]
        if data["status"] in TERMINAL:
            return data
        time.sleep(0.05)
    raise AssertionError("任务未在超时内进入终态")


def _artifact_path(settings: Settings, text: str, voice_id: str = "qwen3-female-1") -> Path:
    engine_voice = voice.resolve_voice(settings, voice_id)
    digest = hashlib.sha256(f"{text}|{engine_voice}|zh-CN".encode("utf-8")).hexdigest()[:16]
    return Path(settings.tts_output_dir) / f"{digest}.mp3"


def _enable_edge(monkeypatch):
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: object())


# ---------- ① 0 字节残留不得算作缓存命中 ----------

def test_stale_zero_byte_artifact_is_purged_and_resynthesized(tmp_path, monkeypatch):
    _enable_edge(monkeypatch)
    settings = _settings(tmp_path)
    out_path = _artifact_path(settings, TEXT)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(b"")                      # 复现现场：0 字节残留
    assert out_path.stat().st_size == 0

    calls = []

    async def fake_synth(settings_arg, text, engine_voice, path: Path):
        calls.append(text)
        path.write_bytes(b"ID3" + b"\x00" * 64)    # 真实产出

    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    with _client(settings, {TaskType.TTS: build_tts_executor(settings, probe, synthesizer=fake_synth)}) as client:
        task = _wait_terminal(client, _submit(client, "hyg-key-0001")["taskId"])

    assert task["status"] == "SUCCEEDED", task.get("error")
    assert task["cached"] is False                  # 残留不算命中
    assert calls == [TEXT]                          # 确实重新合成了
    assert out_path.stat().st_size > 0              # 残留已被非空产物替换


# ---------- ② 合成失败不留半成品；失败不得毒化后续重试 ----------

def test_failed_synthesis_leaves_no_artifact_and_later_retry_succeeds(tmp_path, monkeypatch):
    _enable_edge(monkeypatch)
    settings = _settings(tmp_path)
    out_path = _artifact_path(settings, TEXT)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)

    async def failing_synth(settings_arg, text, engine_voice, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"half")                   # 模拟写到一半失败留下的残片
        raise RuntimeError("edge-tts 连接被对端中断")

    with _client(settings, {TaskType.TTS: build_tts_executor(settings, probe, synthesizer=failing_synth)}) as client:
        failed = _wait_terminal(client, _submit(client, "hyg-key-0002")["taskId"])

    assert failed["status"] == "FAILED"
    assert failed["error"]["code"] == "TTS_UNAVAILABLE"
    assert failed["error"]["dependency"] == "tts_provider"
    assert failed["error"]["retryable"] is True
    assert not out_path.exists(), "失败后不得留下产物（否则该文本会被永久毒化）"

    async def good_synth(settings_arg, text, engine_voice, path: Path):
        path.write_bytes(b"ID3" + b"\x00" * 32)

    with _client(settings, {TaskType.TTS: build_tts_executor(settings, probe, synthesizer=good_synth)}) as client:
        retried = _wait_terminal(client, _submit(client, "hyg-key-0003")["taskId"])

    assert retried["status"] == "SUCCEEDED", retried.get("error")
    assert retried["cached"] is False
    assert out_path.stat().st_size > 0


# ---------- ③ 空产物不得当成功返回 ----------

def test_empty_synth_result_is_not_success_and_artifact_removed(tmp_path, monkeypatch):
    _enable_edge(monkeypatch)
    settings = _settings(tmp_path)
    out_path = _artifact_path(settings, TEXT)

    async def empty_synth(settings_arg, text, engine_voice, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")                       # 引擎静默产出 0 字节

    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    with _client(settings, {TaskType.TTS: build_tts_executor(settings, probe, synthesizer=empty_synth)}) as client:
        task = _wait_terminal(client, _submit(client, "hyg-key-0004")["taskId"])

    assert task["status"] == "FAILED"               # 不 200 + 空对象
    assert task["error"]["code"] == "TTS_UNAVAILABLE"
    assert task.get("result") is None
    if out_path.exists():
        assert out_path.stat().st_size == 0         # 允许残留但绝不能被当作成功


# ---------- ④ synthesize 落盘原子性（直接单测，不注入合成器） ----------

class _FakeCommunicate:
    def __init__(self, text, voice, *, fail_after=None, empty=False):
        self._fail_after = fail_after
        self._empty = empty

    async def save(self, fname):
        p = Path(fname)
        p.parent.mkdir(parents=True, exist_ok=True)
        if self._empty:
            p.write_bytes(b"")
            return
        p.write_bytes(b"ID3partial")
        if self._fail_after is not None:
            raise RuntimeError("对端中断")


class _FakeEdgeModule:
    def __init__(self, *, fail=False, empty=False):
        outer = self

        class _C(_FakeCommunicate):
            def __init__(self, text, voice):
                super().__init__(text, voice, fail_after=1 if fail else None, empty=empty)

        self.Communicate = _C


def test_synthesize_is_atomic_and_never_leaves_partial(tmp_path, monkeypatch):
    settings = _settings(tmp_path)
    settings.tts_engine = "edge"

    # 失败：不留目标文件、也不留 .part
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: _FakeEdgeModule(fail=True))
    out_path = _artifact_path(settings, TEXT)
    try:
        import asyncio
        asyncio.run(voice.synthesize(settings, TEXT, "zh-CN-XiaoxiaoNeural", out_path))
        raise AssertionError("应当抛错")
    except RuntimeError:
        pass
    assert not out_path.exists()
    assert not list(Path(settings.tts_output_dir).glob("*.part"))

    # 空产物：同样不留残片
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: _FakeEdgeModule(empty=True))
    try:
        import asyncio
        asyncio.run(voice.synthesize(settings, TEXT, "zh-CN-XiaoxiaoNeural", out_path))
        raise AssertionError("应当抛错")
    except RuntimeError:
        pass
    assert not out_path.exists()
    assert not list(Path(settings.tts_output_dir).glob("*.part"))

    # 成功：原子落位，无 .part 残留
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: _FakeEdgeModule())
    import asyncio
    asyncio.run(voice.synthesize(settings, TEXT, "zh-CN-XiaoxiaoNeural", out_path))
    assert out_path.exists() and out_path.stat().st_size > 0
    assert not list(Path(settings.tts_output_dir).glob("*.part"))
