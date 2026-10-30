"""TTS 流式合成 + 连接池 + 缓存命中/降级回归（2026-10-22 性能优化）。

背景
----
优化前：每次合成都 `edge_tts.Communicate(...)` + `save()` —— 新建 aiohttp 会话/连接、
整段落盘后才知道结果，**首字节不可观测**，无音频只能等 save 结束才暴露。

优化后（`TTS_STREAM=true`，默认）：
- 复用进程级 `aiohttp.TCPConnector`（连接池 + DNS 缓存；WS 握手本身无法跨请求跳过，已实测并如实记录）；
- 走 `Communicate.stream()` 增量落盘，**首个 audio 分片到达即记 firstByteMs**，无音频立刻失败；
- 任何异常 → 清残片 + 降级回 `save()`（对外错误语义不变，仍由执行器转 `TTS_UNAVAILABLE`）；
- 回滚开关 `TTS_STREAM=false` / `AI_TTS_STREAM=false` → 完全回到旧路径（不建连接池、不调 stream）。

本文件锁定的契约
----------------
1. 流式成功：分片全量落盘、firstByteMs 有值、无 `.part` 残留；
2. 流式失败：自动降级非流式并成功返回（metrics.fallback 如实记录异常类名）；
3. 开关关闭：只走 `save()`（stream 一次都不许调）；
4. 两条路径都失败：不留任何产物（防 0 字节毒化缓存）；
5. 只收到元数据没有音频：按失败处理，绝不写空产物；
6. 连接池：同 loop 内复用同一实例，换 loop 自动重建（测试里多次 asyncio.run 不串）；
7. 执行器缓存命中：第二次不再调合成器、`model.cached=true`、result 契约不变（audioUrl + language）。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app import voice
from app.config import Settings
from app.executors import build_tts_executor

TEXT = "请按时服药，注意休息。"
VOICE = "zh-CN-XiaoxiaoNeural"
METADATA = {"type": "SentenceBoundary", "offset": 0, "duration": 100, "text": "请按时服药"}


# ---------------------------------------------------------------- 桩
def _settings(tmp_path, *, stream: bool = True) -> Settings:
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
        tts_stream=stream,
    )


class _Recorder:
    def __init__(self):
        self.calls: list[str] = []


def _fake_edge(
    *,
    chunks: tuple[bytes, ...] = (b"ID3a", b"ID3b"),
    stream_error: Exception | None = None,
    save_bytes: bytes = b"ID3-save-path",
    save_error: Exception | None = None,
    supports_stream: bool = True,
):
    """构造假 edge_tts 模块；recorder.calls 记录实际走了哪条路径。"""
    rec = _Recorder()

    class _Comm:
        def __init__(self, text, voice_name, **kwargs):
            self.text = text
            self.voice_name = voice_name
            self.kwargs = kwargs

        async def stream(self):
            rec.calls.append("stream")
            if stream_error is not None:
                raise stream_error
            yield METADATA                      # 元数据不落盘
            for piece in chunks:
                yield {"type": "audio", "data": piece}

        async def save(self, fname):
            rec.calls.append("save")
            if save_error is not None:
                raise save_error
            path = Path(fname)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(save_bytes)

    if not supports_stream:
        del _Comm.stream                        # 旧版 edge-tts：没有 stream()

    class _Module:
        Communicate = _Comm

    return _Module, rec


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- ① 流式成功
def test_stream_writes_all_chunks_and_reports_first_byte(tmp_path, monkeypatch):
    module, rec = _fake_edge(chunks=(b"ID3-a", b"ID3-b", b"ID3-c"))
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: module)
    settings = _settings(tmp_path)
    out_path = Path(settings.tts_output_dir) / "abcdef0123456789.mp3"

    metrics = _run(voice.synthesize(settings, TEXT, VOICE, out_path))

    assert rec.calls == ["stream"], "默认档必须走流式路径"
    assert out_path.read_bytes() == b"ID3-aID3-bID3-c", "分片必须按序全量落盘"
    assert metrics["mode"] == "stream"
    assert metrics["firstByteMs"] is not None, "流式必须给出首字节耗时"
    assert metrics["firstByteMs"] <= metrics["totalMs"], "首字节不可能晚于总耗时"
    assert metrics["bytes"] == len(b"ID3-aID3-bID3-c")
    assert metrics["fallback"] is None
    assert not list(Path(settings.tts_output_dir).glob("*.part")), "成功后不得留 .part"


def test_stream_passes_connector_and_timeouts(tmp_path, monkeypatch):
    """连接池与超时必须真的传给引擎（否则'复用'只是口号）。"""
    seen: dict = {}

    class _Comm:
        def __init__(self, text, voice_name, **kwargs):
            seen.update(kwargs)

        async def stream(self):
            yield {"type": "audio", "data": b"ID3-x"}

    class _Module:
        Communicate = _Comm

    monkeypatch.setattr(voice, "_edge_tts_module", lambda: _Module)
    settings = _settings(tmp_path)
    out_path = Path(settings.tts_output_dir) / "abcdabcdabcdabcd.mp3"

    _run(voice.synthesize(settings, TEXT, VOICE, out_path))
    _run(voice.close_tts_connector())

    assert seen.get("connector") is not None, "应传入共享 TCPConnector"
    assert seen.get("receive_timeout") == int(settings.tts_timeout_seconds), "AI_TTS_TIMEOUT_SECONDS 应生效到引擎层"
    assert isinstance(seen.get("connect_timeout"), int)


# ---------------------------------------------------------------- ② 流式失败 → 降级
def test_stream_failure_falls_back_to_save(tmp_path, monkeypatch, caplog):
    module, rec = _fake_edge(stream_error=RuntimeError("ws 断开"), save_bytes=b"ID3-fallback")
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: module)
    settings = _settings(tmp_path)
    out_path = Path(settings.tts_output_dir) / "1111222233334444.mp3"

    with caplog.at_level("WARNING", logger="ai-service.voice"):
        metrics = _run(voice.synthesize(settings, TEXT, VOICE, out_path))

    assert rec.calls == ["stream", "save"], "流式失败后必须重试一次非流式"
    assert out_path.read_bytes() == b"ID3-fallback"
    assert metrics["mode"] == "save"
    assert metrics["fallback"] == "RuntimeError"
    assert metrics["firstByteMs"] is None, "降级档没有首字节观测点，不得编造"
    assert not list(Path(settings.tts_output_dir).glob("*.part"))
    assert any("降级非流式" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------- ③ 回滚开关
def test_stream_switch_off_uses_save_only(tmp_path, monkeypatch):
    """TTS_STREAM=false：一次都不许碰 stream()。"""
    module, rec = _fake_edge(stream_error=AssertionError("开关关闭时不得调用 stream()"))
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: module)
    settings = _settings(tmp_path, stream=False)
    out_path = Path(settings.tts_output_dir) / "aaaabbbbccccdddd.mp3"

    metrics = _run(voice.synthesize(settings, TEXT, VOICE, out_path))

    assert rec.calls == ["save"], f"回滚档只走 save，实际 {rec.calls}"
    assert metrics["mode"] == "save" and metrics["firstByteMs"] is None
    assert out_path.read_bytes() == b"ID3-save-path"


def test_old_edge_tts_without_stream_falls_back_to_save(tmp_path, monkeypatch):
    """引擎没有 stream()（旧版本）→ 自动退到 save，不报错、不宣称流式。"""
    module, rec = _fake_edge(supports_stream=False)
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: module)
    settings = _settings(tmp_path)
    out_path = Path(settings.tts_output_dir) / "9999888877776666.mp3"

    metrics = _run(voice.synthesize(settings, TEXT, VOICE, out_path))

    assert rec.calls == ["save"]
    assert metrics["mode"] == "save"


# ---------------------------------------------------------------- ④ 双失败 / 空音频
def test_both_paths_fail_leaves_no_artifact(tmp_path, monkeypatch):
    module, rec = _fake_edge(stream_error=RuntimeError("ws 断开"), save_error=RuntimeError("再次断开"))
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: module)
    settings = _settings(tmp_path)
    out_path = Path(settings.tts_output_dir) / "5555666677778888.mp3"

    with pytest.raises(RuntimeError):
        _run(voice.synthesize(settings, TEXT, VOICE, out_path))

    assert rec.calls == ["stream", "save"]
    assert not out_path.exists()
    assert not list(Path(settings.tts_output_dir).glob("*.part")), "失败不得留残片"


def test_stream_without_audio_is_rejected(tmp_path, monkeypatch):
    """只收到元数据、没有 audio 分片：按失败处理（否则会写出 0 字节产物毒化缓存）。"""
    module, rec = _fake_edge(chunks=(), save_bytes=b"")
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: module)
    settings = _settings(tmp_path)
    out_path = Path(settings.tts_output_dir) / "aaaabbbb00001111.mp3"

    with pytest.raises(RuntimeError):
        _run(voice.synthesize(settings, TEXT, VOICE, out_path))

    assert rec.calls == ["stream", "save"]
    assert not out_path.exists()
    assert not list(Path(settings.tts_output_dir).glob("*.part"))


# ---------------------------------------------------------------- ⑤ 连接池复用
def test_connector_is_reused_within_one_loop_and_rebuilt_per_loop():
    kept: list = []

    async def once():
        first = voice._tts_connector()
        second = voice._tts_connector()
        assert first is second, "同一 event loop 内必须复用同一连接器"
        kept.append(first)
        return first

    _run(once())
    _run(voice.close_tts_connector())
    _run(once())
    _run(voice.close_tts_connector())

    assert kept[0] is not kept[1], "不同 event loop 必须各建各的连接器（避免跨 loop 使用）"


# ---------------------------------------------------------------- ⑥ 执行器：缓存命中 + 契约不变
class _Ctx:
    async def set_phase(self, phase: str):
        pass


def test_executor_cache_hit_skips_synthesis_and_keeps_contract(tmp_path, monkeypatch):
    module, rec = _fake_edge()
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: module)
    settings = _settings(tmp_path)

    calls = {"n": 0}

    async def counting_synth(settings_arg, text, engine_voice, out_path):
        calls["n"] += 1
        return await voice.synthesize(settings_arg, text, engine_voice, out_path)

    executor = build_tts_executor(settings, probe=None, synthesizer=counting_synth)
    task = {"taskId": "t-tts-cache", "inputInline": TEXT, "voice": "qwen3-female-1"}

    first = _run(executor(dict(task), _Ctx()))
    second = _run(executor(dict(task), _Ctx()))

    assert calls["n"] == 1, "第二次必须命中产物缓存，不得再次合成"
    assert first["model"]["cached"] is False
    assert second["model"]["cached"] is True
    assert set(second["result"].keys()) == {"audioUrl", "language"}, "返回契约不得改变"
    assert second["result"]["audioUrl"].startswith(settings.tts_public_base + "/internal/v1/tts/audio/")
    assert "token=" in second["result"]["audioUrl"]
    assert second["result"]["language"] == "zh-CN"


def test_executor_tolerates_synthesizer_returning_none(tmp_path):
    """注入的合成器（老式桩/外部实现）不返回耗时画像时，执行器照常工作。"""

    async def plain_synth(settings_arg, text, engine_voice, out_path):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"ID3-plain")
        return None

    settings = _settings(tmp_path)
    executor = build_tts_executor(settings, probe=None, synthesizer=plain_synth)

    outcome = asyncio.run(executor({"taskId": "t-tts-none", "inputInline": TEXT}, _Ctx()))

    assert outcome["result"]["audioUrl"].endswith(".mp3?token=" + outcome["result"]["audioUrl"].split("token=")[1])
    assert outcome["model"]["cached"] is False
