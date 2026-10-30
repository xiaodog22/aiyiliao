"""LLM 并发 / 连接复用 / 流式与降级（2026-10-22 优化）。

验收点：
1. 默认配置（pool=1, stream=off, reuse=on 透明）行为 = 旧版（单 worker、响应契约不变）。
2. worker 池开启后多任务并发消费（max 并发 > 1）。
3. httpx 复用单例：reuse=on 返回同一对象；reuse=off 返回 None（回落一次性 client）。
4. 流式：开启后走 stream=True 并累积，首 token 延迟记入 metrics。
5. 流式失败自动回退非流式（WARN + 计数），响应契约不变。
6. worker 池某 worker 异常退出 → 监督器回退单 worker 并告警，任务仍可完成。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.executors._llm import generate_text
from app.http_client import close_http_client, get_client, ollama_client, reset_client
from app.main import create_app
from app.metrics import metrics, reset_metrics
from app.models import TaskType
from app.tasks import TaskService

from conftest import BASE, echo_executor, fake_ollama_probe

pytestmark = pytest.mark.usefixtures("reset_llm_state")


@pytest.fixture(autouse=True)
def reset_llm_state():
    reset_client()
    reset_metrics()
    yield
    reset_client()
    reset_metrics()


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
    )
    base.update(overrides)
    return Settings(**base)


def _submit(client, key, body=None):
    return client.post(BASE, json=body or {"tenantId": "t1", "userId": "u1", "taskType": "CHAT",
                                           "policyVersion": "p1", "traceId": "t"},
                       headers={"Idempotency-Key": key})


def _wait(client, task_id, timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = client.get(f"{BASE}/{task_id}")
        assert resp.status_code == 200
        data = resp.json()["data"]
        if data["status"] in ("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"):
            return data
        time.sleep(0.05)
    raise AssertionError("任务未在期限内到达终态")


# ---------------------------------------------------------------- 1) 默认单 worker 不变


def test_default_is_single_worker(tmp_path):
    settings = _settings(tmp_path)  # 默认 llm_worker_pool_size=1
    app = create_app(settings, executors={TaskType.CHAT: echo_executor}, ollama_probe=fake_ollama_probe)
    with TestClient(app) as client:
        svc = client.app.state.service
        assert len(svc._workers) == 1
        assert svc._supervisor is None
        # 队列背压上限仍为配置值
        assert svc._queue.maxsize == 10
        # 启动摘要 concurrency 如实为 1
        from app.config import config_summary
        assert config_summary(settings)["concurrency"] == 1

    # 单 worker 下并发执行器不会并行：慢执行器串行
    state = {"cur": 0, "max": 0}

    async def slow(task, ctx):
        state["cur"] += 1
        state["max"] = max(state["max"], state["cur"])
        await asyncio.sleep(0.2)
        state["cur"] -= 1
        return {"result": {"text": "x"}, "model": {"modelId": "e"}}

    app2 = create_app(_settings(tmp_path), executors={TaskType.CHAT: slow}, ollama_probe=fake_ollama_probe)
    with TestClient(app2) as client:
        ids = [_submit(client, f"seq-key-000{i}").json()["data"]["taskId"] for i in range(3)]
        for i in ids:
            _wait(client, i)
    assert state["max"] == 1  # 单 worker 严格串行


# ---------------------------------------------------------------- 2) 池并发正确


def test_pool_runs_concurrent(tmp_path):
    state = {"cur": 0, "max": 0}

    async def slow(task, ctx):
        state["cur"] += 1
        state["max"] = max(state["max"], state["cur"])
        await asyncio.sleep(0.3)
        state["cur"] -= 1
        return {"result": {"text": "x"}, "model": {"modelId": "e"}}

    settings = _settings(tmp_path, llm_worker_pool_size=4)
    app = create_app(settings, executors={TaskType.CHAT: slow}, ollama_probe=fake_ollama_probe)
    with TestClient(app) as client:
        svc = client.app.state.service
        assert len(svc._workers) == 4
        assert svc._supervisor is not None
        ids = [_submit(client, f"par-key-000{i}").json()["data"]["taskId"] for i in range(4)]
        for i in ids:
            _wait(client, i)
    assert state["max"] >= 2, f"pool=4 应出现并发，实际 max={state['max']}"


# ---------------------------------------------------------------- 3) httpx 复用单例


def test_http_client_reuse_singleton():
    on = Settings(llm_http_client_reuse=True)
    reset_client()
    a = get_client(on)
    b = get_client(on)
    assert a is not None and a is b, "reuse=on 必须返回同一单例"

    off = Settings(llm_http_client_reuse=False)
    assert get_client(off) is None, "reuse=off 必须返回 None（回落一次性 client）"

    # ollama_client：transport 注入 → 一次性且关闭；reuse=on 无 transport → 单例
    async def check():
        async with ollama_client(on, transport=httpx.MockTransport(lambda r: httpx.Response(200))) as c1:
            pass
        # transport 路径不使用全局单例
        assert get_client(on) is a
        async with ollama_client(off) as c2:
            assert isinstance(c2, httpx.AsyncClient)

    asyncio.run(check())
    asyncio.run(close_http_client())
    reset_client()


# ---------------------------------------------------------------- 4) 流式首 token 记录


def _stream_ok_handler(request: httpx.Request) -> httpx.Response:
    sent = json.loads(request.content)
    assert sent.get("stream") is True, "流式路径应发送 stream=true"
    lines = "\n".join([
        json.dumps({"response": "你好", "done": False}),
        json.dumps({"response": "，我是健康助手", "done": False}),
        json.dumps({"done": True, "response": ""}),
    ])
    return httpx.Response(200, text=lines)


def test_stream_records_first_token(tmp_path):
    settings = _settings(tmp_path, llm_stream=True)
    transport = httpx.MockTransport(_stream_ok_handler)

    async def run():
        text, model = await generate_text(
            settings, "qwen2.5:0.5b", "sys", "hi", {}, 5,
            transport=transport, json_mode=False,
        )
        return text, model

    text, _ = asyncio.run(run())
    assert text == "你好，我是健康助手", text
    snap = metrics().snapshot()
    assert snap["firstTokenSamples"] >= 1, "应记录首 token 延迟样本"
    assert snap["streamOk"] >= 1, "应记录流式成功"


# ---------------------------------------------------------------- 5) 流式失败回退非流式


def _stream_fallback_handler(request: httpx.Request) -> httpx.Response:
    sent = json.loads(request.content)
    if sent.get("stream") is True:
        return httpx.Response(500, json={"error": "stream unsupported"})
    # 非流式回退：返回正常 JSON 文本
    return httpx.Response(200, json={"model": "qwen2.5:0.5b",
                                     "response": json.dumps({"text": "回退成功", "language": "zh-CN",
                                                             "refused": False, "refusalReason": None})})


def test_stream_fallback_to_nonstream(tmp_path, caplog):
    settings = _settings(tmp_path, llm_stream=True)
    transport = httpx.MockTransport(_stream_fallback_handler)

    async def run():
        # 复用 _llm 的 chat 风格调用；此处直接调 generate_text 验证回退
        from app.executors._llm import generate_text as gt
        return await gt(settings, "qwen2.5:0.5b", "sys", "hi", {}, 5, transport=transport, json_mode=True)

    with caplog.at_level(logging.WARNING, logger="ai-service.executors.llm"):
        result = asyncio.run(run())
    assert result[0] == json.dumps({"text": "回退成功", "language": "zh-CN", "refused": False, "refusalReason": None}), result
    snap = metrics().snapshot()
    assert snap["streamFallback"] >= 1, "应记录流式回退次数"
    assert "回退非流式" in caplog.text, "应打印 WARN 回退日志"


# ---------------------------------------------------------------- 6) worker 异常回退单 worker


def test_worker_pool_fallback_on_crash(tmp_path, monkeypatch, caplog):
    real_run = TaskService._run_worker
    calls = {"n": 0}

    async def fake_run(self):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated worker crash")  # 模拟某 worker 异常退出
        return await real_run(self)

    monkeypatch.setattr(TaskService, "_run_worker", fake_run)
    settings = _settings(tmp_path, llm_worker_pool_size=2, log_level="WARNING")
    app = create_app(settings, executors={TaskType.CHAT: echo_executor}, ollama_probe=fake_ollama_probe)

    with caplog.at_level(logging.WARNING, logger="ai-service.tasks"):
        with TestClient(app) as client:
            svc = client.app.state.service
            # 等待监督器检测到崩溃并回退单 worker（监督周期 0.5s）
            time.sleep(0.9)
            assert len(svc._workers) == 1, "崩溃后应回退为单 worker"
            task = _wait(client, _submit(client, "crash-key-0001").json()["data"]["taskId"])
    assert task["status"] == "SUCCEEDED", "回退后任务仍应正常完成"
    assert "回退单 worker" in caplog.text, "应打印回退告警"
