"""M2 执行器测试（D2.1 生成类 + D2.3 语音适配）。

覆盖：
- CHAT：成功 / 结构化拒答 / 空输入 / 模型不可达 / 输出非法 JSON / 超时；
- CARE_PLAN：成功（limitations 含「不构成处方」）/ 无建议转拒答 / 上游 404 降级；
- TTS：未配置引擎 → TTS_UNAVAILABLE；引擎可用（注入合成器）→ 出签名 URL + 二次命中缓存 +
        音频通道签名校验（篡改 token → 403、路径穿越 → 404）；
- ASR：未配置权重 → CAPABILITY_UNAVAILABLE；权重就绪（注入识别器）→ 转写 + 语言透传；
- INTERPRET（2026-10-22）：成功（summary + sections 归一）/ 拒答清空 sections /
        缺 summary 判输出非法 / 模型不可达 → CAPABILITY_UNAVAILABLE；
- INTERPRET（2026-10-22）：成功（summary + sections 归一）/ 拒答清空 sections /
        缺 summary 判输出非法 / 模型不可达 → CAPABILITY_UNAVAILABLE；
- 就绪探针：tts_provider/asr_model 状态随配置如实变化（degraded 而非假 available）。

注入方式：httpx.MockTransport（不触网） + 假探针 + 注入式合成器/识别器（不依赖本机引擎）。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi.testclient import TestClient

from app import voice
from app.capabilities import CapabilityProbe
from app.config import Settings
from app.executors import (
    build_asr_executor,
    build_careplan_executor,
    build_chat_executor,
    build_interpret_executor,
    build_tts_executor,
)
from app.main import create_app
from app.models import TaskType

from conftest import BASE, fake_ollama_probe

TERMINAL = ("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED")


def _settings(tmp_path, **overrides) -> Settings:
    base = dict(
        store_path=tmp_path / "tasks.json",
        ollama_url="http://ollama.test",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=30,
        chat_timeout_seconds=5,
        careplan_timeout_seconds=5,
        result_ttl_seconds=3600,
        queue_max=10,
        auth_mode="off",
        log_level="WARNING",
    )
    base.update(overrides)
    return Settings(**base)


def _client(settings, executors, probe_result=fake_ollama_probe) -> TestClient:
    async def probe_fn(url, timeout):
        value = probe_result
        return await value(url, timeout) if callable(value) else value

    app = create_app(settings, executors=executors, ollama_probe=probe_fn)
    return TestClient(app)


def _wait_terminal(client, task_id, timeout=10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = client.get(f"{BASE}/{task_id}")
        assert resp.status_code == 200
        data = resp.json()["data"]
        if data["status"] in TERMINAL:
            return data
        time.sleep(0.05)
    raise AssertionError("任务未在期限内到达终态")


def _submit(client, task_type, *, key, input_inline=None, input_ref=None, voice_id=None) -> dict:
    body = {
        "tenantId": "t1", "userId": "u1", "taskType": task_type,
        "policyVersion": "policy-1", "traceId": f"trace-{task_type}-1",
    }
    if input_inline is not None:
        body["inputInline"] = input_inline
    if input_ref is not None:
        body["inputRef"] = input_ref
    if voice_id is not None:
        body["voice"] = voice_id
    resp = client.post(BASE, json=body, headers={"Idempotency-Key": key})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def _llm_handler(payload_obj, model="qwen2.5:0.5b"):
    """Ollama /api/generate 替身：把 payload_obj 序列化进 response 字段。"""
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/generate"
        sent = json.loads(request.content)
        assert sent["format"] == "json"  # CHAT/CARE_PLAN 都强制结构化输出
        return httpx.Response(200, json={"model": model, "response": json.dumps(payload_obj, ensure_ascii=False)})

    return handler


def _raw_handler(response_text, model="qwen2.5:0.5b"):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"model": model, "response": response_text})

    return handler


def _chat_executors(settings, probe, handler):
    return {TaskType.CHAT: build_chat_executor(settings, probe, transport=httpx.MockTransport(handler))}


# ---------------------------------------------------------------- CHAT


def test_chat_success_flow(tmp_path):
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    handler = _llm_handler({"text": "建议先记录症状出现时间，饭后加重要留意。", "language": "zh-CN",
                            "refused": False, "refusalReason": None})
    with _client(settings, _chat_executors(settings, probe, handler)) as client:
        task_id = _submit(client, "CHAT", key="chat-key-0001", input_inline="这两天饭后胃胀怎么办")["taskId"]
        task = _wait_terminal(client, task_id)

    assert task["status"] == "SUCCEEDED"
    result = task["result"]
    assert result["text"].startswith("建议先记录症状")
    assert result["citations"] == []            # 无检索链路：如实空数组，不编造来源
    assert result["provenance"] == "AI_GENERATED"
    assert result["refused"] is False
    assert result["hasTimestamps"] is False
    assert task["modelId"] == "qwen2.5:0.5b"
    assert task["promptTemplateVersion"] == "consultation-chat-v5"


def test_chat_structured_refusal(tmp_path):
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    handler = _llm_handler({"text": "这个属于用药调整，请线下咨询医生。", "language": "zh-CN",
                            "refused": True, "refusalReason": "涉及处方调整，超出线上咨询范围"})
    with _client(settings, _chat_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(
            client, "CHAT", key="chat-key-0002", input_inline="帮我把降压药换成另一种")["taskId"])

    assert task["status"] == "SUCCEEDED"
    assert task["result"]["refused"] is True
    assert task["result"]["refusalReason"] == "涉及处方调整，超出线上咨询范围"


def test_chat_empty_input_fails_fast(tmp_path):
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)

    def handler(request):  # 不应被调用
        raise AssertionError("空输入不应发起生成请求")

    with _client(settings, _chat_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(client, "CHAT", key="chat-key-0003")["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "INVALID_INPUT"
    assert task["error"]["retryable"] is False


def test_chat_fast_fail_when_ollama_unreachable(tmp_path):
    async def probe_none(url, timeout):
        return None

    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=probe_none)  # 执行器内探针如实不可达

    def handler(request):
        raise AssertionError("探针已判定不可达，不应发起生成请求")

    started = time.perf_counter()
    with _client(settings, _chat_executors(settings, probe, handler), probe_result=probe_none) as client:
        task = _wait_terminal(client, _submit(client, "CHAT", key="chat-key-0004", input_inline="头晕")["taskId"])
    elapsed = time.perf_counter() - started

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert task["error"]["dependency"] == "ollama"
    assert elapsed < 2.0


def test_chat_invalid_json_output(tmp_path):
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    handler = _raw_handler("好的，我建议您去医院看看。")
    with _client(settings, _chat_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(client, "CHAT", key="chat-key-0005", input_inline="不舒服")["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "MODEL_OUTPUT_INVALID"


def test_chat_model_timeout(tmp_path):
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)

    def handler(request):
        raise httpx.ReadTimeout("read timeout", request=request)

    with _client(settings, _chat_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(client, "CHAT", key="chat-key-0006", input_inline="咳嗽")["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "MODEL_TIMEOUT"


# ---------------------------------------------------------------- CARE_PLAN


def _careplan_executors(settings, probe, handler):
    return {TaskType.CARE_PLAN: build_careplan_executor(settings, probe, transport=httpx.MockTransport(handler))}


def test_careplan_success_flow(tmp_path):
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    handler = _llm_handler({"suggestions": [
        {"title": "固定就寝时间", "detail": "每天同一时间上床，睡前一小时远离屏幕。"},
        {"title": "白天适度活动", "detail": "白天散步 30 分钟，避免傍晚剧烈运动。"},
    ], "days": [
        {"label": "第 1 天", "diet": "少油少盐", "exercise": "散步20分钟", "sleep": "22:30前入睡"},
        {"label": "第 2 天", "diet": "增加蔬菜", "exercise": "伸展操", "sleep": "固定起床时间"},
        {"label": "第 3 天", "diet": "控制晚餐量", "exercise": "快走30分钟", "sleep": "睡前少看屏幕"},
    ], "refused": False, "refusalReason": None})
    with _client(settings, _careplan_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(
            client, "CARE_PLAN", key="cp-key-0001", input_inline="目标：改善睡眠；约束：高血压。")["taskId"])

    assert task["status"] == "SUCCEEDED"
    result = task["result"]
    assert [s["title"] for s in result["suggestions"]] == ["固定就寝时间", "白天适度活动"]
    assert all(s["provenance"] == "AI_GENERATED" for s in result["suggestions"])
    assert "不构成处方" in result["limitations"]      # 业务侧 containsString 红线断言
    assert result["refused"] is False
    # V21 按天结构：3 天上行，label/diet/exercise/sleep 原样透传
    assert len(result["days"]) == 3
    assert result["days"][0]["label"] == "第 1 天"
    assert result["days"][2]["sleep"] == "睡前少看屏幕"


def test_careplan_days_normalization_tolerates_dirty_data(tmp_path):
    """days 脏数据归一：非 dict / 三全空条目丢弃，label 缺失补序号，上限 3 天。"""
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    handler = _llm_handler({"suggestions": [
        {"title": "规律作息", "detail": "每天固定时间起床和入睡。"},
    ], "days": [
        "not-a-dict",                                                    # 非 dict → 丢弃
        {"diet": "", "exercise": "", "sleep": ""},                       # 三全空 → 丢弃
        {"diet": "多喝水", "exercise": "拉伸", "sleep": "早睡"},          # label 缺失 → 补「第 1 天」
        {"label": "第二天", "diet": "少糖"},                              # 部分字段 → 保留
        {"label": "第4天", "diet": "x", "exercise": "y", "sleep": "z"},  # 第5条超上限 → 丢弃
        {"label": "第5天", "diet": "x", "exercise": "y", "sleep": "z"},
    ], "refused": False, "refusalReason": None})
    with _client(settings, _careplan_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(
            client, "CARE_PLAN", key="cp-key-0004", input_inline="目标：规律作息")["taskId"])

    assert task["status"] == "SUCCEEDED"
    days = task["result"]["days"]
    assert len(days) == 3
    assert days[0]["label"] == "第 1 天"          # 序号按**保留后**的位置补
    assert days[1]["label"] == "第二天"
    assert days[1]["exercise"] is None            # 缺失维度归一为 None（业务侧不渲染该行）


def test_careplan_refusal_has_no_days(tmp_path):
    """拒答时 days 恒空数组（不把「没有建议」包装成按天内容）。"""
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    handler = _llm_handler({"suggestions": [], "days": [
        {"label": "第 1 天", "diet": "x", "exercise": "y", "sleep": "z"},
    ], "refused": True, "refusalReason": "涉及用药调整，超出生活方式建议范围"})
    with _client(settings, _careplan_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(
            client, "CARE_PLAN", key="cp-key-0005", input_inline="目标：调整降压药剂量")["taskId"])

    assert task["status"] == "SUCCEEDED"
    assert task["result"]["refused"] is True
    assert task["result"]["days"] == []
    assert task["result"]["suggestions"] == []


def test_careplan_empty_suggestions_becomes_refusal(tmp_path):
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    handler = _llm_handler({"suggestions": [], "refused": False, "refusalReason": None})
    with _client(settings, _careplan_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(
            client, "CARE_PLAN", key="cp-key-0002", input_inline="目标：缓解关节疼痛")["taskId"])

    assert task["status"] == "SUCCEEDED"
    assert task["result"]["refused"] is True                     # 不用空数组冒充"没有建议"
    assert task["result"]["suggestions"] == []
    assert task["result"]["refusalReason"]


def test_careplan_upstream_404_degrades(tmp_path):
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)

    def handler(request):
        return httpx.Response(404, json={"error": "model not found"})

    with _client(settings, _careplan_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(client, "CARE_PLAN", key="cp-key-0003", input_inline="目标：控体重")["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert task["error"]["retryable"] is True


# ---------------------------------------------------------------- TTS


def test_tts_unavailable_when_engine_not_configured(tmp_path):
    settings = _settings(tmp_path, tts_output_dir=tmp_path / "tts")  # tts_engine 默认 none
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    with _client(settings, {TaskType.TTS: build_tts_executor(settings, probe)}) as client:
        task = _wait_terminal(client, _submit(
            client, "TTS", key="tts-key-0001", input_inline="您的复查建议已生成", voice_id="qwen3-female-1")["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "TTS_UNAVAILABLE"          # 不播占位音、不 200+空对象
    assert task["error"]["dependency"] == "tts_provider"
    assert task["error"]["retryable"] is True
    assert not (tmp_path / "tts").exists()                     # 未配置引擎 → 不落任何产物


def _enable_edge_engine(monkeypatch):
    monkeypatch.setattr(voice, "_edge_tts_module", lambda: object())


def test_tts_success_cache_and_signed_audio_route(tmp_path, monkeypatch):
    _enable_edge_engine(monkeypatch)
    settings = _settings(tmp_path, tts_engine="edge", tts_output_dir=tmp_path / "tts",
                         tts_url_ttl_seconds=600)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)

    async def fake_synth(settings_arg, text, engine_voice, out_path: Path):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"ID3fake-mp3-bytes")

    executor = build_tts_executor(settings, probe, synthesizer=fake_synth)
    with _client(settings, {TaskType.TTS: executor}) as client:
        first = _wait_terminal(client, _submit(
            client, "TTS", key="tts-key-0002", input_inline="请按时服药", voice_id="qwen3-female-1")["taskId"])
        assert first["status"] == "SUCCEEDED"
        assert first["cached"] is False
        audio_url = first["result"]["audioUrl"]
        assert "/internal/v1/tts/audio/" in audio_url and "token=" in audio_url

        # 音频通道：合法签名可取；篡改 token → 403
        parts = urlsplit(audio_url)
        ok = client.get(parts.path + "?" + parts.query)
        assert ok.status_code == 200
        assert ok.headers["content-type"].startswith("audio/mpeg")
        assert client.get(parts.path + "?token=1.deadbeef").status_code == 403
        # 路径穿越/非法文件名 → 404
        assert client.get("/internal/v1/tts/audio/..%2Fetc%2Fpasswd?token=1.deadbeef").status_code in (403, 404)

        # 同文本同音色 → 命中本地产物，cached=true（不重复合成）
        second = _wait_terminal(client, _submit(
            client, "TTS", key="tts-key-0003", input_inline="请按时服药", voice_id="qwen3-female-1")["taskId"])
        assert second["status"] == "SUCCEEDED"
        assert second["cached"] is True
        assert second["result"]["audioUrl"] == audio_url


def test_tts_audio_url_honours_public_base_and_path(tmp_path, monkeypatch):
    """O-10 定稿（2026-10-15）：对外部署时 audioUrl 必须落在「客户端可达基址 + 公开路径」上，且可配置。"""
    _enable_edge_engine(monkeypatch)
    settings = _settings(tmp_path, tts_engine="edge", tts_output_dir=tmp_path / "tts",
                         tts_public_base="http://gw.example:8000/",     # 故意带尾斜杠，验证归一
                         tts_public_path="/api/gw/tts/audio")
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)

    async def fake_synth(settings_arg, text, engine_voice, out_path: Path):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"ID3fake-mp3-bytes")

    with _client(settings, {TaskType.TTS: build_tts_executor(settings, probe, synthesizer=fake_synth)}) as client:
        task = _wait_terminal(client, _submit(client, "TTS", key="tts-key-0005", input_inline="请多喝水")["taskId"])

    assert task["status"] == "SUCCEEDED"
    url = task["result"]["audioUrl"]
    assert url.startswith("http://gw.example:8000/api/gw/tts/audio/")
    assert "//api" not in url          # base 尾斜杠 + path 首斜杠不得拼出双斜杠
    assert "token=" in url


def test_tts_engine_failure_degrades(tmp_path, monkeypatch):
    _enable_edge_engine(monkeypatch)
    settings = _settings(tmp_path, tts_engine="edge", tts_output_dir=tmp_path / "tts")
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)

    async def boom(settings_arg, text, engine_voice, out_path: Path):
        raise RuntimeError("engine exploded")

    executor = build_tts_executor(settings, probe, synthesizer=boom)
    with _client(settings, {TaskType.TTS: executor}) as client:
        task = _wait_terminal(client, _submit(client, "TTS", key="tts-key-0004", input_inline="测试")["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "TTS_UNAVAILABLE"
    assert "engine exploded" not in json.dumps(task, ensure_ascii=False)  # 不泄露内部细节


# ---------------------------------------------------------------- ASR


def test_asr_unavailable_when_weights_not_configured(tmp_path):
    settings = _settings(tmp_path)  # asr_engine 默认 none
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    with _client(settings, {TaskType.ASR: build_asr_executor(settings, probe)}) as client:
        task = _wait_terminal(client, _submit(client, "ASR", key="asr-key-0001", input_ref="asr:ref-1")["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert task["error"]["dependency"] == "asr_model"


def test_asr_success_with_ready_weights_and_audio_channel(tmp_path):
    model_marker = tmp_path / "model.bin"
    model_marker.write_bytes(b"weights")
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    (audio_dir / "ref-42.wav").write_bytes(b"RIFFfake")

    settings = _settings(tmp_path, asr_engine="funasr", asr_model_path=str(model_marker),
                         asr_audio_dir=str(audio_dir))
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)

    async def fake_transcribe(settings_arg, audio_path: Path, locale):
        assert audio_path.name == "ref-42.wav"        # inputRef → 约定目录下的实际文件
        return "胃胀三天，饭后明显", "zh-CN"

    executor = build_asr_executor(settings, probe, transcriber=fake_transcribe)
    with _client(settings, {TaskType.ASR: executor}) as client:
        task = _wait_terminal(client, _submit(client, "ASR", key="asr-key-0002", input_ref="asr:ref-42")["taskId"])

    assert task["status"] == "SUCCEEDED"
    assert task["result"]["transcript"] == "胃胀三天，饭后明显"
    assert task["result"]["language"] == "zh-CN"
    assert task["result"]["hasTimestamps"] is False


def test_asr_ready_but_audio_unreachable_degrades(tmp_path):
    model_marker = tmp_path / "model.bin"
    model_marker.write_bytes(b"weights")
    settings = _settings(tmp_path, asr_engine="funasr", asr_model_path=str(model_marker),
                         asr_audio_dir=str(tmp_path / "audio"))  # 目录里没有对应文件
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    with _client(settings, {TaskType.ASR: build_asr_executor(settings, probe)}) as client:
        task = _wait_terminal(client, _submit(client, "ASR", key="asr-key-0003", input_ref="asr:missing")["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert task["error"]["dependency"] == "asr_model"


# ---------------------------------------------------------------- 就绪探针如实


def test_readiness_reflects_voice_configuration(tmp_path, monkeypatch):
    _enable_edge_engine(monkeypatch)
    model_marker = tmp_path / "model.bin"
    model_marker.write_bytes(b"weights")
    settings = _settings(tmp_path, tts_engine="edge", asr_engine="funasr", asr_model_path=str(model_marker))
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    app = create_app(settings, executors={}, ollama_probe=fake_ollama_probe)
    with TestClient(app) as client:
        body = client.get("/internal/health/ready").json()

    deps = {d["name"]: d["status"] for d in body["dependencies"]}
    assert deps["ollama"] == "available"
    assert deps["asr_model"] == "available"
    assert deps["tts_provider"] == "available"
    assert body["status"] == "ok"          # 三类核心能力均 available


# ---------------------------------------------------------------- INTERPRET（2026-10-22）


def _interpret_executors(settings, probe, handler):
    return {TaskType.INTERPRET: build_interpret_executor(settings, probe, transport=httpx.MockTransport(handler))}


_INTERPRET_INPUT = (
    "档案标题：血常规；类别：EXAM；医院：社区医院；来源：检验科；出具医师：王医生；"
    "异常标注：未见明显异常；报告摘要：白细胞 6.2，红细胞 4.5。；解读范围：DETAIL"
)


def test_interpret_success_flow(tmp_path):
    """成功路径：summary 透传、sections 归一（脏条目丢弃）、provenance 恒 AI_GENERATED。"""
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    handler = _llm_handler({
        "summary": "本次血常规各项大致在参考范围内，不必过度担心。",
        "sections": [
            {"title": "白细胞", "body": "白细胞反映免疫状态，本次数值处在参考范围内。", "abnormal": False},
            "not-a-dict",                                                    # 非 dict → 丢弃
            {"title": "", "body": ""},                                       # 全空 → 丢弃
            {"title": "血红蛋白", "body": "反映携氧能力，报告未给出异常提示。"},  # abnormal 缺省 → None
        ],
        "refused": False,
        "refusalReason": None,
        "language": "zh-CN",
    })
    with _client(settings, _interpret_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(
            client, "INTERPRET", key="ip-key-0001", input_inline=_INTERPRET_INPUT)["taskId"])

    assert task["status"] == "SUCCEEDED"
    result = task["result"]
    assert result["summary"].startswith("本次血常规")
    assert result["provenance"] == "AI_GENERATED"
    assert result["refused"] is False
    assert result["language"] == "zh-CN"
    assert [s["title"] for s in result["sections"]] == ["白细胞", "血红蛋白"]
    assert result["sections"][0]["abnormal"] is False
    assert result["sections"][1]["abnormal"] is None


def test_interpret_refusal_clears_sections(tmp_path):
    """拒答：summary 置空、sections 恒空数组（不把拒答包装成「暂无可解读内容」）。"""
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    handler = _llm_handler({
        "summary": "建议直接确诊并开药。",
        "sections": [{"title": "建议", "body": "服用某药每日三次。", "abnormal": True}],
        "refused": True,
        "refusalReason": "涉及诊断与用药，超出报告解读范围",
    })
    with _client(settings, _interpret_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(
            client, "INTERPRET", key="ip-key-0002", input_inline=_INTERPRET_INPUT)["taskId"])

    assert task["status"] == "SUCCEEDED"
    result = task["result"]
    assert result["refused"] is True
    assert result["summary"] is None
    assert result["sections"] == []
    assert "超出报告解读范围" in result["refusalReason"]


def test_interpret_missing_summary_is_invalid_output(tmp_path):
    """非拒答但没给 summary → MODEL_OUTPUT_INVALID（不用占位文案兜底）。"""
    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    handler = _llm_handler({"refused": False, "sections": []})
    with _client(settings, _interpret_executors(settings, probe, handler)) as client:
        task = _wait_terminal(client, _submit(
            client, "INTERPRET", key="ip-key-0003", input_inline=_INTERPRET_INPUT)["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "MODEL_OUTPUT_INVALID"


def test_interpret_fast_fail_when_model_unreachable(tmp_path):
    """模型不可达 → CAPABILITY_UNAVAILABLE（dependency=ollama），且不发起生成请求。"""
    async def probe_none(url, timeout):
        return None

    settings = _settings(tmp_path)
    probe = CapabilityProbe(settings, ollama_probe=probe_none)

    def handler(request):
        raise AssertionError("探针已判定不可达，不应发起生成请求")

    with _client(settings, _interpret_executors(settings, probe, handler), probe_result=probe_none) as client:
        task = _wait_terminal(client, _submit(
            client, "INTERPRET", key="ip-key-0004", input_inline=_INTERPRET_INPUT)["taskId"])

    assert task["status"] == "FAILED"
    assert task["error"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert task["error"]["dependency"] == "ollama"
