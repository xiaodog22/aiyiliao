"""内容寻址缓存测试（M2 · D2.4）。

覆盖：
- 键设计（§9.2）：确定性、租户/输入/模板/模型/策略任一变化即换键；非白名单类型与空输入 → 不参与缓存；
- 规范化不做宽松折叠（「有点疼」≠「非常疼」，不得为提高命中率合并不同含义）；
- 端到端：同输入二次提交命中缓存（**不重复调模型**，`cached=true`）；
- 隔离：不同 tenantId 不互相命中；不同 tenantSecret 不互相命中；
- 纪律：拒答结果不入缓存；TTL 过期即失效；文件落盘可重载；缓存未启用时行为不变。

注入方式：httpx.MockTransport（不触网） + 假探针（不依赖本机 Ollama）。
"""

from __future__ import annotations

import json
import time

import httpx
from fastapi.testclient import TestClient

from app.cache import ContentCache, compute_cache_key, input_digest
from app.capabilities import CapabilityProbe
from app.config import Settings
from app.executors import build_chat_executor
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
        result_ttl_seconds=3600,
        queue_max=10,
        auth_mode="off",
        log_level="WARNING",
        cache_enabled=True,
        cache_path=tmp_path / "cache.json",
        cache_ttl_seconds=3600,
        tenant_secret="unit-test-tenant-secret",
    )
    base.update(overrides)
    return Settings(**base)


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


def _submit(client, *, key, text, tenant="t1", policy="policy-1", user="u1") -> dict:
    resp = client.post(
        BASE,
        json={
            "tenantId": tenant, "userId": user, "taskType": "CHAT",
            "policyVersion": policy, "traceId": f"trace-{key}", "inputInline": text,
        },
        headers={"Idempotency-Key": key},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def _counting_chat_client(tmp_path, calls: list, *, reply="多喝温水，注意休息。"):
    """构造启用缓存的 CHAT 应用；每次真实调模型都会往 calls 里记一笔。"""
    settings = _settings(tmp_path)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content)["prompt"])
        return httpx.Response(200, json={
            "model": "qwen2.5:0.5b",
            "response": json.dumps({"text": reply, "language": "zh-CN", "refused": False,
                                    "refusalReason": None}, ensure_ascii=False),
        })

    settings.ollama_url = "http://ollama.test"
    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    executors = {TaskType.CHAT: build_chat_executor(settings, probe, transport=httpx.MockTransport(handler))}
    return create_app(settings, executors=executors, ollama_probe=fake_ollama_probe)


# ---------------------------------------------------------------- 键设计（单元）


def _task(**overrides) -> dict:
    task = {
        "taskType": "CHAT", "tenantId": "t1", "inputInline": "这两天饭后胃胀怎么办",
        "policyVersion": "policy-1", "modelProfile": "small-default",
        "modelVersion": None, "quantization": None, "knowledgeSnapshot": None,
        "voice": None, "locale": None, "generationParameters": None,
    }
    task.update(overrides)
    return task


def test_key_deterministic_and_sensitive_to_components():
    base = dict(tenant_secret="s1", prompt_template_version="consultation-chat-v1", model_id="qwen2.5:0.5b")
    key = compute_cache_key(_task(), **base)
    assert key and len(key) == 64
    assert compute_cache_key(_task(), **base) == key                     # 确定性

    assert compute_cache_key(_task(), **{**base, "tenant_secret": "s2"}) != key      # 换 secret 换键
    assert compute_cache_key(_task(tenantId="t2"), **base) != key                   # 换租户换键
    assert compute_cache_key(_task(inputInline="头有点晕"), **base) != key          # 换输入换键
    assert compute_cache_key(_task(policyVersion="policy-2"), **base) != key        # 策略升级即失效
    assert compute_cache_key(_task(), **{**base, "model_id": "qwen2.5:7b"}) != key  # 换模型即失效
    assert compute_cache_key(_task(), **{**base, "prompt_template_version": "consultation-chat-v2"}) != key
    assert compute_cache_key(_task(voice="qwen3-female-1"), **base) != key          # 音色参与键


def test_key_none_for_non_cacheable_or_empty():
    base = dict(tenant_secret="s1", prompt_template_version="t", model_id="m")
    assert compute_cache_key(_task(taskType="TTS"), **base) is None      # 语音不并入内容寻址缓存
    assert compute_cache_key(_task(taskType="ASR"), **base) is None
    assert compute_cache_key(_task(inputInline="   "), **base) is None   # 空输入不参与缓存


def test_canonicalization_does_not_merge_degree_adverbs():
    # 只做 NFC + 首尾空白折叠；不做「有点/很/非常」宽松折叠（避免把不同含义合并成一键）。
    assert input_digest("有点疼") != input_digest("非常疼")
    assert input_digest(" 肚子疼 ") == input_digest("肚子疼")             # 首尾空白折叠
    assert input_digest("肚子疼") != input_digest("肚子疼，")             # 标点保留（可能改变含义）


# ---------------------------------------------------------------- 端到端


def test_second_identical_submit_hits_cache(tmp_path):
    calls: list = []
    app = _counting_chat_client(tmp_path, calls)
    with TestClient(app) as client:
        first = _wait_terminal(client, _submit(client, key="chat-cache-0001", text="这两天饭后胃胀怎么办")["taskId"])
        assert first["status"] == "SUCCEEDED"
        assert first["cached"] is False                      # 首次为真实计算
        assert len(calls) == 1

        second = _wait_terminal(client, _submit(client, key="chat-cache-0002", text="这两天饭后胃胀怎么办")["taskId"])
        assert second["status"] == "SUCCEEDED"
        assert second["cached"] is True                      # 命中缓存，如实标注
        assert second["result"] == first["result"]
        assert second["modelId"] == first["modelId"]          # 版本元信息随条目还原
        assert second["promptTemplateVersion"] == first["promptTemplateVersion"]
        assert len(calls) == 1                               # **未重复调模型**

        # 不同输入 → 不命中
        third = _wait_terminal(client, _submit(client, key="chat-cache-0003", text="最近总失眠")["taskId"])
        assert third["status"] == "SUCCEEDED"
        assert third["cached"] is False
        assert len(calls) == 2


def test_cache_does_not_leak_across_tenants(tmp_path):
    calls: list = []
    app = _counting_chat_client(tmp_path, calls)
    with TestClient(app) as client:
        _wait_terminal(client, _submit(client, key="chat-t1-0001", text="这两天饭后胃胀怎么办", tenant="t1")["taskId"])
        _wait_terminal(client, _submit(client, key="chat-t2-0001", text="这两天饭后胃胀怎么办", tenant="t2")["taskId"])
        assert len(calls) == 2                               # 租户不同 → 不共享缓存条目


def test_chat_second_identical_submit_isolated_per_secret(tmp_path):
    """换 tenantSecret → 旧缓存条目天然失效（不跨密钥命中）。"""
    calls: list = []
    settings_a = _settings(tmp_path)
    app_a = _app_with_chat(settings_a, calls)
    with TestClient(app_a) as client:
        _wait_terminal(client, _submit(client, key="chat-sec-0001", text="这两天饭后胃胀怎么办")["taskId"])

    settings_b = _settings(tmp_path)                          # 同一 cache 文件、不同 secret
    settings_b.tenant_secret = "another-tenant-secret"
    app_b = _app_with_chat(settings_b, calls)
    with TestClient(app_b) as client:
        task = _wait_terminal(client, _submit(client, key="chat-sec-0002", text="这两天饭后胃胀怎么办")["taskId"])

    assert task["cached"] is False
    assert len(calls) == 2


def _app_with_chat(settings, calls: list):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={
            "model": "qwen2.5:0.5b",
            "response": json.dumps({"text": "注意休息。", "language": "zh-CN", "refused": False,
                                    "refusalReason": None}, ensure_ascii=False),
        })

    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    executors = {TaskType.CHAT: build_chat_executor(settings, probe, transport=httpx.MockTransport(handler))}
    return create_app(settings, executors=executors, ollama_probe=fake_ollama_probe)


def test_refused_result_is_not_cached(tmp_path):
    calls: list = []
    settings = _settings(tmp_path)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={
            "model": "qwen2.5:0.5b",
            "response": json.dumps({"text": "请线下咨询医生。", "language": "zh-CN", "refused": True,
                                    "refusalReason": "涉及处方调整，超出线上咨询范围"}, ensure_ascii=False),
        })

    probe = CapabilityProbe(settings, ollama_probe=fake_ollama_probe)
    executors = {TaskType.CHAT: build_chat_executor(settings, probe, transport=httpx.MockTransport(handler))}
    with TestClient(create_app(settings, executors=executors, ollama_probe=fake_ollama_probe)) as client:
        first = _wait_terminal(client, _submit(client, key="chat-refuse-0001", text="帮我把降压药换一种")["taskId"])
        second = _wait_terminal(client, _submit(client, key="chat-refuse-0002", text="帮我把降压药换一种")["taskId"])

    assert first["result"]["refused"] is True
    assert second["cached"] is not True                       # 拒答不入缓存，二次仍真实计算
    assert len(calls) == 2


def test_cache_disabled_by_default(tmp_path):
    """未显式开启时行为不变：二次提交仍真实计算，且不写缓存文件。"""
    calls: list = []
    settings = _settings(tmp_path, cache_enabled=False, cache_path=tmp_path / "never.json")
    app = _app_with_chat(settings, calls)
    with TestClient(app) as client:
        _wait_terminal(client, _submit(client, key="chat-off-0001", text="这两天饭后胃胀怎么办")["taskId"])
        second = _wait_terminal(client, _submit(client, key="chat-off-0002", text="这两天饭后胃胀怎么办")["taskId"])

    assert second["cached"] is not True
    assert len(calls) == 2
    assert not (tmp_path / "never.json").exists()


# ---------------------------------------------------------------- 存储与生命周期


def test_cache_persists_and_reloads(tmp_path):
    cache = ContentCache(tmp_path / "cache.json", ttl_seconds=3600)
    cache.entries["k1"] = {"result": {"text": "x"}, "model": {}, "createdAt": time.time(),
                          "expiresAt": time.time() + 3600}
    import asyncio

    asyncio.run(cache.save())

    reloaded = ContentCache(tmp_path / "cache.json", ttl_seconds=3600)
    asyncio.run(reloaded.load())
    assert "k1" in reloaded.entries


def test_expired_entry_is_a_miss(tmp_path):
    cache = ContentCache(tmp_path / "cache.json", ttl_seconds=1)
    cache.entries["k1"] = {"result": {"text": "x"}, "model": {}, "createdAt": time.time(),
                          "expiresAt": time.time() - 1}      # 已过期
    assert cache.get("k1") is None
    assert "k1" not in cache.entries                          # 顺手剔除
    assert cache.stats()["misses"] == 1


def test_corrupt_cache_file_is_discarded_not_crash(tmp_path):
    path = tmp_path / "cache.json"
    path.write_text("{ not json", encoding="utf-8")
    cache = ContentCache(path, ttl_seconds=60)
    import asyncio

    asyncio.run(cache.load())
    assert cache.entries == {}
