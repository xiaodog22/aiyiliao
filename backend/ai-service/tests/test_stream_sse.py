"""对外流式（SSE）第一期：增量抽取 + 订阅端点。

范围（对齐 `docs/设计/对外流式契约提案.md` §0）：
- 只放行 CHAT；triage/careplan/interpret 不绑增量出口（JSON 结构化输出不外发）；
- 未订阅时任务行为不变（旁路），故所有断言同时校验"轮询链路照常"。
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app import streaming
from app.config import Settings
from app.main import create_app
from app.models import TaskType

BASE = "/internal/v1/tasks"


def _submit(client: TestClient, task_type: str, text: str) -> str:
    # 幂等键必须每次唯一且纯 ASCII：同键不同正文会被判 CONFLICT，
    # 而 HTTP 头不允许非 ASCII（中文正文不能进 key）。
    key = f"stream-test-{task_type.lower()}-{uuid.uuid4().hex}"
    resp = client.post(
        BASE,
        json={
            "tenantId": "t-test",
            "userId": "u-test",
            "taskType": task_type,
            "policyVersion": "v1",
            "traceId": uuid.uuid4().hex,
            "inputInline": text,
        },
        headers={"Idempotency-Key": key},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["taskId"]


def _stream(client: TestClient, task_id: str) -> str:
    with client.stream("GET", f"{BASE}/{task_id}/stream") as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        return "".join(resp.iter_text())


# ---------- TextFieldExtractor：CHAT 的 json_mode 结构化输出 ----------

def test_extractor_handles_split_key_and_escapes():
    ext = streaming.TextFieldExtractor()
    out = []
    # 键被切在中间 + 值里含转义与跨块反斜杠
    for chunk in ['{"te', 'xt":"你', '好\\', 'n世界', '\\u4e2d', '文","refused":false}']:
        out.append(ext.feed(chunk))
    assert "".join(out) == "你好\n世界中文"
    assert ext.done is True


def test_extractor_ignores_non_json_output():
    ext = streaming.TextFieldExtractor()
    assert ext.feed("直接输出纯文本，没有 json 键") == ""
    assert ext.done is False


def test_extractor_stops_at_closing_quote():
    ext = streaming.TextFieldExtractor()
    got = ext.feed('{"text":"正文","language":"zh-CN"}')
    assert got == "正文"


# ---------- 端点：活流 ----------

@pytest.fixture()
def stream_app(tmp_path):
    """执行器等订阅者连上再吐字，保证断言的是**活流**而不是终态回放（避免时序抖动）。"""
    async def streaming_executor(task, ctx):
        await ctx.set_phase("generation")
        for _ in range(300):
            if ctx._service.has_stream(task["taskId"]):
                break
            await asyncio.sleep(0.01)
        for piece in ('{"text":"你', '好，', '在的"}',):
            ctx.emit_token(piece)
            await asyncio.sleep(0)
        return {"result": {"text": "你好，在的"}, "model": {"modelId": "stub-stream"}}

    settings = Settings(
        store_path=tmp_path / "tasks.json",
        ollama_url="http://127.0.0.1:9",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=60,
        result_ttl_seconds=3600,
        queue_max=10,
        auth_mode="off",
        log_level="WARNING",
    )
    app = create_app(
        settings,
        executors={TaskType.CHAT: streaming_executor},
        ollama_probe=lambda url, timeout: _ready(url, timeout),
    )
    with TestClient(app) as c:
        yield c


async def _ready(url: str, timeout: float):
    return ["qwen2.5:0.5b"]


def test_sse_streams_deltas_then_done(stream_app):
    task_id = _submit(stream_app, "CHAT", "你好")
    body = _stream(stream_app, task_id)

    assert "event: start" in body
    assert body.count("event: delta") == 3
    assert "event: done" in body
    # 原始模型片段（`{"text":"…`，冒号后无空格）不得出现在流里；
    # 本端点自身的 SSE data 是 `{"text": "…"}`（有空格），不在此列。
    assert '{"text":"' not in body
    joined = "".join(
        json.loads(line[len("data: "):])["text"]
        for line in body.splitlines()
        if line.startswith("data: ") and '"text"' in line
    )
    assert joined == "你好，在的"


def test_sse_frame_shape_and_headers(stream_app):
    """冻结契约：帧 = event/id/data + 空行；id 从 1 单调递增；中文不转义；反代不缓冲。"""
    task_id = _submit(stream_app, "CHAT", "你好")
    with stream_app.stream("GET", f"{BASE}/{task_id}/stream") as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.headers["cache-control"] == "no-cache"
        assert resp.headers["connection"] == "keep-alive"
        assert resp.headers["x-accel-buffering"] == "no"
        body = "".join(resp.iter_text())

    # 逐帧解析：每帧三行 + 一个空行；不得出现提案里已明确不做的事件
    frames = []
    for block in body.split("\n\n"):
        if not block.strip():
            continue
        lines = block.splitlines()
        assert len(lines) == 3, lines
        assert lines[0].startswith("event: ")
        assert lines[1].startswith("id: ")
        assert lines[2].startswith("data: ")
        frames.append((lines[0][7:], int(lines[1][4:]), json.loads(lines[2][6:])))

    assert [f[0] for f in frames] == ["start", "delta", "delta", "delta", "done"]
    assert [f[1] for f in frames] == list(range(1, len(frames) + 1))
    assert frames[0][2]["taskId"] == task_id
    assert frames[0][2]["taskType"] == "CHAT"
    # 中文原文（ensure_ascii=False），不能是 \\uXXXX 这类转义。
    # 注意 delta 分块，正文不会连续出现在同一帧（"你"/"好，"/"在的" 分三帧），故只断言单字。
    assert "你" in body and "\\u" not in body


def test_sse_requires_existing_task(client):
    with client.stream("GET", f"{BASE}/t-not-exist/stream") as resp:
        assert resp.status_code == 404


# ---------- 端点：终态回放（缓存命中 / 断线重连） ----------

def test_terminal_task_replays_result(client):
    task_id = _submit(client, "CHAT", "任意输入")
    for _ in range(50):
        view = client.get(f"{BASE}/{task_id}").json()["data"]
        if view["status"] == "SUCCEEDED":
            break
    body = _stream(client, task_id)
    assert "event: delta" in body
    assert "测试结果" in body
    assert "event: done" in body
    # 契约收口（2026-11-17）：done 不带 status，成功与否只看事件类型。
    # 活流与终态回放必须同口径，客户端不得依赖该字段。
    done_data = [
        json.loads(line[len("data: "):])
        for line in body.splitlines()
        if line.startswith("data: ") and "finishReason" in line
    ][0]
    assert "status" not in done_data


def test_sse_zero_delta_falls_back_to_full_text(tmp_path):
    """冻结契约：零增量（DeepSeek 降级等）时补一块完整正文，客户端不得拿到空流。"""

    async def silent_executor(task, ctx):
        # 不 emit_token：模拟 provider 无增量
        return {"result": {"text": "降级后的完整正文"}, "model": {"modelId": "deepseek"}}

    settings = Settings(
        store_path=tmp_path / "tasks.json",
        ollama_url="http://127.0.0.1:9",
        probe_timeout_seconds=0.2,
        auth_mode="off",
        log_level="WARNING",
    )
    app = create_app(
        settings,
        executors={TaskType.CHAT: silent_executor},
        ollama_probe=_ready,
    )
    with TestClient(app) as c:
        task_id = _submit(c, "CHAT", "降级")
        body = _stream(c, task_id)

    assert body.count("event: delta") == 1
    assert "降级后的完整正文" in body
    assert "event: done" in body


def test_terminal_failed_task_replays_error_not_done(tmp_path):
    """失败任务重连必须回 error：回 done 会让客户端把失败当成功落库。"""
    from app.tasks import TaskFailure

    async def failing_executor(task, ctx):
        raise TaskFailure("PROVIDER_UNAVAILABLE", "模型不可用", retryable=True)

    settings = Settings(
        store_path=tmp_path / "tasks.json",
        ollama_url="http://127.0.0.1:9",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=60,
        auth_mode="off",
        log_level="WARNING",
    )
    app = create_app(
        settings,
        executors={TaskType.CHAT: failing_executor},
        ollama_probe=_ready,
    )
    with TestClient(app) as c:
        task_id = _submit(c, "CHAT", "会失败")
        for _ in range(60):
            if c.get(f"{BASE}/{task_id}").json()["data"]["status"] == "FAILED":
                break
        body = _stream(c, task_id)

    assert "event: start" in body
    assert "event: error" in body
    assert "event: done" not in body
    assert "PROVIDER_UNAVAILABLE" in body


# ---------- 订阅位：重连顶替（不共享队列，避免死连接抢走增量） ----------

def test_reconnect_supersedes_previous_subscriber(tmp_path):
    """旧连接（常见于断网后的死链）不得与新连接抢同一队列，否则增量会被静默丢掉。"""
    from app.store import TaskStore
    from app.tasks import TaskService

    settings = Settings(
        store_path=tmp_path / "tasks.json",
        ollama_url="http://127.0.0.1:9",
        probe_timeout_seconds=0.2,
        auth_mode="off",
        log_level="WARNING",
    )
    svc = TaskService(TaskStore(tmp_path / "tasks.json"), settings)

    q1 = svc.open_stream("t-1")
    q2 = svc.open_stream("t-1")
    assert q1 is not q2
    assert q1.get_nowait() is streaming.STREAM_SUPERSEDED

    # 旧连接的 finally 不得把新订阅者一起摘掉
    svc.close_stream("t-1", q1)
    assert svc.has_stream("t-1") is True

    # 任务收尾：无条件摘除当前订阅者并投结束哨兵
    svc.close_stream("t-1", q2)
    assert q2.get_nowait() is streaming.STREAM_END
    assert svc.has_stream("t-1") is False


# ---------- 红线：非 CHAT 不绑增量出口 ----------

def test_non_chat_type_has_no_sink(tmp_path):
    seen = {}

    async def probe_executor(task, ctx):
        seen["sink"] = streaming.current_sink()
        return {"result": {"departments": []}, "model": {}}

    settings = Settings(
        store_path=tmp_path / "tasks.json",
        ollama_url="http://127.0.0.1:9",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=60,
        auth_mode="off",
        log_level="WARNING",
    )
    app = create_app(
        settings,
        executors={TaskType.TRIAGE: probe_executor},
        ollama_probe=_ready,
    )
    with TestClient(app) as c:
        task_id = _submit(c, "TRIAGE", "咳嗽三天")
        for _ in range(50):
            if c.get(f"{BASE}/{task_id}").json()["data"]["status"] == "SUCCEEDED":
                break
    assert seen["sink"] is None


# ---------- 指标可观测 ----------

def test_metrics_exposes_stream_counters(stream_app):
    task_id = _submit(stream_app, "CHAT", "指标")
    _stream(stream_app, task_id)
    snapshot = stream_app.get("/internal/metrics/llm").json()
    assert snapshot["streamSubscribers"] >= 1
    assert snapshot["streamDeltas"] >= 1
