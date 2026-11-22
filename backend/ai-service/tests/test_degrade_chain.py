"""AI 能力降级/容灾开关与链路测试（2026-11-18）。

覆盖：
- 统一开关公式：local 模式一票否决 edge / DeepSeek / WechatSI；
- TTS 链：qwen3 失败 → edge，engine/degraded 如实返回；qwen3 成功则不被 edge 覆盖；
- locale 路由：粤语映射 zh-HK 音色，且不把粤语喂给本地 Qwen3；
- ASR locale：粤语快速失败，不调用普通话 FunASR（避免伪造转写）。
"""

from __future__ import annotations

import asyncio
import base64
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


class _FakeQwen3Response:
    status_code = 200
    headers = {"content-type": "application/json"}
    content = b""

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _FakeQwen3Client:
    def __init__(self, payload):
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        return _FakeQwen3Response(self._payload)

    async def get(self, url):
        raise AssertionError("success payload should not fetch audioUrl")


def _patch_qwen3(monkeypatch, payload):
    monkeypatch.setattr(voice.httpx, "AsyncClient", lambda timeout: _FakeQwen3Client(payload))


def test_qwen3_adapter_unwraps_v02_nested_data(tmp_path, monkeypatch):
    """V02 返回 {code,message,data:{audio_base64}}，适配器必须解包并落盘。"""
    _patch_qwen3(monkeypatch, {
        "code": 200,
        "message": "success",
        "data": {
            "audio_base64": base64.b64encode(b"RIFF-v02-wav").decode("ascii"),
            "sample_rate": 24000,
            "mock": False,
            "degraded": False,
            "cached": False,
        },
    })
    settings = _settings(tmp_path, tts_qwen3_endpoint="http://qwen.test", tts_qwen3_timeout_seconds=5)
    out = tmp_path / "nested.wav"
    asyncio.run(voice.synthesize(settings, "请按时服药。", "female-1", out, engine="qwen3", locale="zh-CN"))
    assert out.read_bytes() == b"RIFF-v02-wav"


def test_qwen3_adapter_rejects_mock_or_degraded_audio(tmp_path, monkeypatch):
    """真实模型失败时 sidecar 会回模拟正弦波；不得当真实医疗语音播放。"""
    _patch_qwen3(monkeypatch, {
        "code": 200,
        "message": "success",
        "data": {
            "audio_base64": base64.b64encode(b"RIFF-mock").decode("ascii"),
            "sample_rate": 24000,
            "mock": False,
            "degraded": True,
            "cached": False,
        },
    })
    settings = _settings(tmp_path, tts_qwen3_endpoint="http://qwen.test", tts_qwen3_timeout_seconds=5)
    out = tmp_path / "mock.wav"
    with pytest.raises(RuntimeError, match="模拟音频"):
        asyncio.run(voice.synthesize(settings, "请按时服药。", "female-1", out, engine="qwen3", locale="zh-CN"))
    assert not out.exists()


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


def test_domestic_rejects_cloud_deepseek_key_at_startup(tmp_path):
    """H10：domestic 不是“运行期再否决”，配了境外 key 应在启动自检直接失败。"""
    settings = _settings(tmp_path, egress_policy="domestic", deepseek_api_key="sk-test")
    with pytest.raises(RuntimeError, match="AI_DEEPSEEK_API_KEY"):
        settings.validate_security()


def test_invalid_store_encryption_key_rejected_at_startup(tmp_path):
    """M2：静态加密密钥形状非法时启动即失败，禁止带病运行。"""
    settings = _settings(tmp_path, store_encryption_key="not-a-fernet-key")
    with pytest.raises(RuntimeError, match="AI_STORE_ENCRYPTION_KEY"):
        settings.validate_security()


def test_store_require_encryption_defaults_true(monkeypatch, tmp_path):
    """L3：环境未显式关闭时必须默认加密（fail-closed），缺 key 拒绝启动。"""
    monkeypatch.delenv("AI_STORE_REQUIRE_ENCRYPTION", raising=False)
    monkeypatch.delenv("AI_STORE_ENCRYPTION_KEY", raising=False)
    settings = _settings(tmp_path)
    assert settings.store_require_encryption is True, "默认值必须为 true（原默认 false 属 fail-open）"
    with pytest.raises(RuntimeError, match="AI_STORE_REQUIRE_ENCRYPTION"):
        settings.validate_security()


def test_store_encryption_required_but_missing_key_rejected(tmp_path):
    """F-03：生产置 AI_STORE_REQUIRE_ENCRYPTION=true 时，缺 key 必须拒绝启动。"""
    settings = _settings(tmp_path, store_require_encryption=True)
    with pytest.raises(RuntimeError, match="AI_STORE_REQUIRE_ENCRYPTION"):
        settings.validate_security()

