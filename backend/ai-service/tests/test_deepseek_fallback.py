"""DeepSeek 兜底 provider 测试（2026-11-15）。

覆盖：
- 正常补全与请求体约束（官方模型名 / Bearer / 关闭思考 / JSON 提示 / 参数映射）；
- 未配置 key → NotConfigured（不发请求），chain 静默跳过该级；
- 官方错误码分流：401/402/403/408/422/429/500/503/504；
- 响应结构：finish_reason 未完成、空白 content、choices 缺失、传输超时；
- provider 链：Ollama 失败 → DeepSeek 成功；首级/兜级预算分配；
- 缓存键：provider 配置签名参与隔离；启动摘要不回显 key；契约 dependency 枚举含 deepseek。

注入方式：httpx.MockTransport，全程不触网、不需要真实 API Key。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from app.cache import compute_cache_key
from app.config import Settings, config_summary
from app.providers import chain, deepseek
from app.tasks import TaskFailure

DS_HOST = "https://api.deepseek.test"
OLLAMA_HOST = "http://ollama.test"
FAKE_KEY = "unit-test-key-not-a-real-secret"


def _settings(**overrides) -> Settings:
    base = dict(
        auth_mode="off",
        log_level="WARNING",
        ollama_url=OLLAMA_HOST,
        deepseek_base_url=DS_HOST,
        deepseek_api_key=FAKE_KEY,
        deepseek_model="deepseek-flash",
        provider_order="ollama,deepseek",
        # 2026-11-18：DeepSeek 属外部供应商，默认 local 模式会否决；链路用例显式开启全链路
        degrade_enabled=True,
        probe_timeout_seconds=0.2,
        llm_http_client_reuse=False,
        breaker_failures=0,  # 关熔断，避免用例间串扰
    )
    base.update(overrides)
    return Settings(**base)


def _payload(**overrides) -> dict:
    base = {
        "model": "qwen2.5:7b",
        "system": "你是导诊助手。只输出 JSON，不输出其他文字。",
        "prompt": "请只输出 JSON，格式：{\"departmentName\":\"<科室>\"}",
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.3, "num_predict": 300},
    }
    base.update(overrides)
    return base


def _chat_response(content='{"ok": true}', *, finish="stop", status=200, model="deepseek-flash"):
    return httpx.Response(status, json={
        "model": model,
        "choices": [{"index": 0, "finish_reason": finish,
                     "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 120, "completion_tokens": 40, "prompt_cache_hit_tokens": 30},
    })


def _run(coro):
    return asyncio.run(coro)


def _call(handler, *, settings=None, payload=None, timeout_s=5):
    return _run(deepseek.generate(
        settings or _settings(), payload or _payload(),
        timeout_s=timeout_s, transport=httpx.MockTransport(handler),
    ))


# ---------------------------------------------------------------- 正常路径与请求体


def test_success_returns_content_model_and_bearer():
    seen: dict = {}

    def handler(req):
        seen["body"] = json.loads(req.content)
        seen["auth"] = req.headers.get("authorization")
        seen["path"] = req.url.path
        seen["content_type"] = req.headers.get("content-type")
        return _chat_response('{"recommendedDepartments":[]}')

    text, model = _call(handler)
    assert text == '{"recommendedDepartments":[]}'
    assert model == "deepseek-flash"
    assert seen["path"] == "/chat/completions"
    assert seen["auth"] == f"Bearer {FAKE_KEY}"
    assert seen["content_type"].startswith("application/json")


def test_request_body_meets_official_constraints():
    seen: dict = {}

    def handler(req):
        seen["body"] = json.loads(req.content)
        return _chat_response()

    _call(handler)
    body = seen["body"]
    assert body["model"] == "deepseek-flash"          # 官方当前有效名，不是 deepseek-chat
    assert body["stream"] is False
    assert body["thinking"] == {"type": "disabled"}   # 默认思考模式会让 temperature 静默失效
    assert body["reasoning_effort"] == "none"
    assert body["temperature"] == 0.3
    assert body["max_tokens"] == 300                  # Ollama num_predict 的映射
    assert body["response_format"] == {"type": "json_object"}
    # 官方 JSON Output 要求 prompt 含小写 "json"；执行器模板是大写「JSON」，本层必须补齐
    assert any("json" in str(m.get("content") or "") for m in body["messages"])
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][-1]["role"] == "user"
    assert FAKE_KEY not in json.dumps(body)           # key 只能出现在 Authorization 头


def test_plain_text_mode_has_no_json_constraints():
    seen: dict = {}

    def handler(req):
        seen["body"] = json.loads(req.content)
        return _chat_response("多喝温水。")

    text, _ = _call(handler, payload=_payload(format=""))
    assert text == "多喝温水。"
    assert "response_format" not in seen["body"]


def test_missing_key_skips_without_sending_request():
    def handler(req):  # pragma: no cover - 被调用即失败
        pytest.fail("未配置 key 时不应发起任何请求")

    with pytest.raises(deepseek.NotConfigured):
        _call(handler, settings=_settings(deepseek_api_key=""))


# ---------------------------------------------------------------- 官方错误码与响应结构


@pytest.mark.parametrize("status,code,retryable", [
    (401, "CAPABILITY_UNAVAILABLE", False),
    (403, "CAPABILITY_UNAVAILABLE", False),
    (402, "CAPABILITY_UNAVAILABLE", False),   # 余额不足：单独可观测，不与参数错误混为一谈
    (422, "CAPABILITY_UNAVAILABLE", False),
    (408, "MODEL_TIMEOUT", True),
    (504, "MODEL_TIMEOUT", True),
    (429, "MODEL_UNAVAILABLE", True),
    (500, "MODEL_UNAVAILABLE", True),
    (503, "MODEL_UNAVAILABLE", True),
])
def test_official_error_codes_are_mapped(status, code, retryable):
    with pytest.raises(TaskFailure) as ei:
        _call(lambda req: httpx.Response(status, json={"error": {"message": "upstream"}}))
    assert ei.value.code == code
    assert ei.value.retryable is retryable
    assert ei.value.dependency == "deepseek"


@pytest.mark.parametrize("finish", ["length", "content_filter", "insufficient_system_resource", "aborted"])
def test_unfinished_generation_is_structured_failure(finish):
    with pytest.raises(TaskFailure) as ei:
        _call(lambda req: _chat_response('{"a":', finish=finish))
    assert ei.value.code == "MODEL_OUTPUT_INVALID"
    assert finish in ei.value.message


def test_blank_content_is_invalid():
    # 官方：JSON 模式下非 JSON 内容会被替换成空格，content 看起来为空但 finish_reason 仍是 stop
    with pytest.raises(TaskFailure) as ei:
        _call(lambda req: _chat_response("   ", finish="stop"))
    assert ei.value.code == "MODEL_OUTPUT_INVALID"


def test_malformed_response_structure_is_invalid():
    with pytest.raises(TaskFailure) as ei:
        _call(lambda req: httpx.Response(200, json={"choices": []}))
    assert ei.value.code == "MODEL_OUTPUT_INVALID"


def test_transport_timeout_maps_model_timeout():
    def handler(req):
        raise httpx.ReadTimeout("simulated", request=req)

    with pytest.raises(TaskFailure) as ei:
        _call(handler)
    assert ei.value.code == "MODEL_TIMEOUT"
    assert ei.value.retryable is True


# ---------------------------------------------------------------- provider 链


def test_chain_falls_back_to_deepseek_when_ollama_fails():
    chain.reset_breakers()
    urls: list[str] = []

    def handler(req):
        urls.append(str(req.url))
        if req.url.host == "ollama.test":
            return httpx.Response(500, json={"error": "local model down"})
        return _chat_response('{"text":"云端兜底","language":"zh-CN","refused":false}')

    async def scenario():
        # current_provider() 是 ContextVar：必须在**同一个协程上下文**里读，
        # 跨 asyncio.run 边界读到的是 default="ollama"（生产里执行器与链同属一个 Task）。
        result = await chain.generate(
            _settings(), _payload(),
            timeout_s=5, first_token_timeout_s=1, fallback_timeout_s=3,
            transport=httpx.MockTransport(handler),
        )
        return result, chain.current_provider()

    result, provider = _run(scenario())
    assert result.source == "deepseek"
    assert "云端兜底" in result.text
    assert provider == "deepseek"                       # llmSource / dependency 如实归因
    assert any("ollama.test" in u for u in urls)
    assert any("api.deepseek.test" in u for u in urls)


def test_chain_skips_deepseek_without_key():
    chain.reset_breakers()

    def handler(req):
        assert req.url.host == "ollama.test", "未配 key 时不得请求 DeepSeek"
        return httpx.Response(500, json={"error": "local model down"})

    with pytest.raises(TaskFailure) as ei:
        _run(chain.generate(
            _settings(deepseek_api_key=""), _payload(),
            timeout_s=5, first_token_timeout_s=1, fallback_timeout_s=3,
            transport=httpx.MockTransport(handler),
        ))
    assert ei.value.code == "MODEL_UNAVAILABLE"   # 本地真实失败如实上报，不伪装成成功


def test_local_mode_denies_deepseek_without_any_request():
    """总开关关闭 = 仅本地：即使配了 key，也不得建连 DeepSeek（不探测、不重试）。"""
    chain.reset_breakers()

    def handler(req):
        assert req.url.host == "ollama.test", "local 模式不得请求 DeepSeek"
        return httpx.Response(500, json={"error": "local model down"})

    with pytest.raises(TaskFailure) as ei:
        _run(chain.generate(
            _settings(degrade_enabled=False), _payload(),
            timeout_s=5, first_token_timeout_s=1, fallback_timeout_s=3,
            transport=httpx.MockTransport(handler),
        ))
    assert ei.value.code == "MODEL_UNAVAILABLE"


@pytest.mark.parametrize("order,expected_budget", [
    ("ollama,deepseek", 3.0),   # 兜底：短预算
    ("deepseek,ollama", 17.0),  # 首级：满任务预算
    ("deepseek", 17.0),         # 单级：满任务预算
])
def test_budget_follows_provider_position(monkeypatch, order, expected_budget):
    chain.reset_breakers()
    captured: dict = {}

    async def fake_generate(settings, payload, *, timeout_s, transport=None):
        captured["timeout_s"] = timeout_s
        return ('{"ok":1}', "deepseek-flash")

    monkeypatch.setattr(chain.deepseek_provider, "generate", fake_generate)
    result = _run(chain.generate(
        _settings(provider_order=order), _payload(),
        timeout_s=17, first_token_timeout_s=1, fallback_timeout_s=3,
    ))
    assert result.source == "deepseek"
    # 预算由链内部按**墙钟剩余时间**扣减（deadline - now），不是原样透传 int：
    # CI Linux 实测得 16.999998847999994，精确 == 会假红（本地 Windows 恰好落在 17.0）。
    # 容差 0.05s 对 3~17s 的预算足够区分「首级满预算」与「兜底短预算」。
    assert captured["timeout_s"] == pytest.approx(expected_budget, abs=0.05)


# ---------------------------------------------------------------- 缓存 / 配置 / 契约


def test_cache_key_isolates_provider_signature():
    task = {
        "taskType": "CHAT", "tenantId": "t1", "inputInline": "饭后胃胀怎么办",
        "policyVersion": "p1", "modelVersion": None, "quantization": None,
        "knowledgeSnapshot": None, "voice": None, "locale": None, "generationParameters": None,
    }
    base = dict(tenant_secret="s", model_id="qwen2.5:7b", prompt_template_version="v1")
    a = compute_cache_key(task, **base, provider_signature="ollama,deepseek|deepseek-flash|nokey")
    b = compute_cache_key(task, **base, provider_signature="ollama,deepseek|deepseek-flash|key")
    c = compute_cache_key(task, **base, provider_signature="deepseek,ollama|deepseek-flash|key")
    assert a and b and c
    assert a != b and b != c                                  # 配 key / 改顺序都换键
    assert a == compute_cache_key(task, **base, provider_signature="ollama,deepseek|deepseek-flash|nokey")


def test_config_summary_reports_state_without_key_value():
    summary = config_summary(_settings())
    assert summary["deepseek"] == "configured"
    assert summary["fallback"] == "on"
    assert summary["deepseekModel"] == "deepseek-flash"
    assert FAKE_KEY not in json.dumps(summary)


def test_contract_dependency_enum_allows_deepseek():
    # 契约两处 error.dependency 枚举必须允许 DeepSeek 归因，否则响应越界
    path = Path(__file__).resolve().parents[2] / "contracts" / "ai-openapi.yaml"
    text = path.read_text(encoding="utf-8")
    assert text.count("enum: [ollama, deepseek, redis, qdrant, tts_provider, asr_model, null]") == 2
