"""AI 能力降级/容灾开关与链路测试（2026-11-18）。

覆盖：
- 统一开关公式：local 模式一票否决 edge / DeepSeek / WechatSI；
- TTS 链：qwen3 失败 → edge，engine/degraded 如实返回；qwen3 成功则不被 edge 覆盖；
- locale 路由：粤语映射 zh-HK 音色，且不把粤语喂给本地 Qwen3；
- ASR locale：粤语快速失败，不调用普通话 FunASR（避免伪造转写）。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.config import Settings
from app.executors.asr import build_asr_executor
from app.executors.tts import build_tts_executor
from app.tasks import TaskFailure
from app import voice


def _settings(tmp_path, **overrides) -> Settings:
    base = dict(
        store_path=tmp_path / "tasks.json",
        ollama_url="http://ollama.test",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=30,
        result_ttl_seconds=3600,
        queue_max=10,
        auth_mode="off",
        log_level="WARNING",
        tts_output_dir=tmp_path / "tts",
        tts_url_ttl_seconds=600,
    )
    base.update(overrides)
    return Settings(**base)


class _Ctx:
    async def set_phase(self, phase: str):
        pass


# ---------------------------------------------------------------- 开关公式


def test_local_mode_denies_all_external_providers(tmp_path):
    settings = _settings(tmp_path, degrade_enabled=False, tts_engines="qwen3,edge",
                         tts_qwen3_endpoint="http://qwen.test")
    assert settings.degrade_mode() == "local"
    # 本地 Qwen3 仍允许（不依赖云端）
    assert settings.provider_allowed("qwen3") is True
    # 外部供应商一律否决
    assert settings.provider_allowed("edge") is False
    assert settings.provider_allowed("deepseek") is False
    assert settings.provider_allowed("wechat_si") is False
    assert settings.provider_allowed("asr_cloud") is False


def test_full_mode_still_respects_capability_and_provider_switches(tmp_path):
    settings = _settings(tmp_path, degrade_enabled=True, degrade_tts_enabled=False,
                         degrade_asr_enabled=False, deepseek_enabled=True)
    assert settings.degrade_mode() == "full"
    assert settings.provider_allowed("deepseek") is True       # LLM 能力未关
    assert settings.provider_allowed("edge") is False          # TTS 能力关闭
    assert settings.provider_allowed("wechat_si") is False     # ASR/TTS 能力均关闭
    assert settings.provider_allowed("azure") is False         # 未登记供应商默认否决


# ---------------------------------------------------------------- TTS 链


def test_qwen3_failure_falls_back_to_edge_and_reports_degraded(tmp_path, monkeypatch):
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: object())
    settings = _settings(
        tmp_path, degrade_enabled=True, tts_engines="qwen3,edge",
        tts_qwen3_endpoint="http://qwen.test", tts_qwen3_timeout_seconds=5,
        tts_edge_timeout_seconds=5,
    )
    calls: list[str] = []

    async def synth(settings_arg, text, engine_voice, out_path, *, engine=None, locale=None):
        calls.append(engine)
        if engine == "qwen3":
            raise RuntimeError("sidecar down")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"ID3-edge")
        return {"mode": "http", "firstByteMs": 1.0, "bytes": 8}

    executor = build_tts_executor(settings, probe=None, synthesizer=synth)
    result = asyncio.run(executor(
        {"taskId": "t-degrade-tts", "inputInline": "请按时服药。", "voice": "qwen3-female-1"},
        _Ctx(),
    ))

    assert calls == ["qwen3", "edge"]
    assert result["result"]["engine"] == "edge"
    assert result["result"]["degraded"] is True
    assert result["result"]["mime"] == "audio/mpeg"
    assert result["result"]["audioUrl"].endswith(".mp3?token=" + result["result"]["audioUrl"].split("token=")[-1])
    assert result["model"]["modelId"] == "tts-edge"


def test_qwen3_success_is_not_overwritten_by_edge(tmp_path, monkeypatch):
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: object())
    settings = _settings(
        tmp_path, degrade_enabled=True, tts_engines="qwen3,edge",
        tts_qwen3_endpoint="http://qwen.test", tts_qwen3_timeout_seconds=5,
        tts_edge_timeout_seconds=5,
    )
    calls: list[str] = []

    async def synth(settings_arg, text, engine_voice, out_path, *, engine=None, locale=None):
        calls.append(engine)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"RIFF-qwen3-wav")
        return {"mode": "http", "firstByteMs": 10.0, "bytes": 14}

    executor = build_tts_executor(settings, probe=None, synthesizer=synth)
    result = asyncio.run(executor(
        {"taskId": "t-qwen3-tts", "inputInline": "请按时服药。", "voice": "qwen3-female-1"},
        _Ctx(),
    ))

    assert calls == ["qwen3"]
    assert result["result"]["engine"] == "qwen3"
    assert result["result"]["mime"] == "audio/wav"
    assert result["result"]["degraded"] is False
    assert ".wav?token=" in result["result"]["audioUrl"]


# ---------------------------------------------------------------- locale 路由


def test_cantonese_voices_map_to_hk_edge_voices(tmp_path):
    settings = _settings(tmp_path, degrade_enabled=True, tts_engines="edge")
    assert voice.resolve_voice(settings, "yue-female-1", engine="edge", locale="zh-HK") == "zh-HK-HiuMaanNeural"
    assert voice.resolve_voice(settings, "yue-male-1", engine="edge", locale="zh-HK") == "zh-HK-WanLungNeural"


def test_cantonese_skips_local_qwen3(tmp_path, monkeypatch):
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: object())
    settings = _settings(
        tmp_path, degrade_enabled=True, tts_engines="qwen3,edge",
        tts_qwen3_endpoint="http://qwen.test",
    )
    assert voice.tts_engines_for_locale(settings, "zh-HK") == ["edge"]
    assert voice.tts_engines_for_locale(settings, "zh-CN") == ["qwen3", "edge"]


# ---------------------------------------------------------------- ASR locale


def test_asr_rejects_cantonese_without_calling_funasr(tmp_path):
    model_marker = tmp_path / "model.bin"
    model_marker.write_bytes(b"weights")
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    (audio_dir / "ref-yue.wav").write_bytes(b"RIFFfake")

    settings = _settings(
        tmp_path, asr_engine="funasr", asr_model_path=str(model_marker),
        asr_audio_dir=str(audio_dir),
    )
    called = {"n": 0}

    async def transcriber(settings_arg, audio_path, locale):
        called["n"] += 1
        return "不应被调用", None

    executor = build_asr_executor(settings, probe=None, transcriber=transcriber)
    with pytest.raises(TaskFailure) as ei:
        asyncio.run(executor(
            {"taskId": "t-asr-yue", "inputRef": "asr:ref-yue", "locale": "zh-HK"},
            _Ctx(),
        ))

    assert ei.value.code == "CAPABILITY_UNAVAILABLE"
    assert called["n"] == 0
    assert "仅支持普通话" in ei.value.message
