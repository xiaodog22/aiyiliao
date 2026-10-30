"""pytest 夹具：路径注入 + 可注入的探针/执行器。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SERVICE_DIR = Path(__file__).resolve().parent.parent
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

# 模块级 `app = create_app()`（app/main.py 末尾，供 uvicorn app:app 使用）读环境变量默认值：
# AI_AUTH_MODE 缺省已是 static（2026-10-23 安全收口），导入前必须先注入测试令牌，
# 否则 import app.main 即触发 fail-fast。各测试显式传 auth_mode="off" 的 Settings 不受影响。
os.environ.setdefault("AI_SERVICE_TOKEN", "test-token-0123456789abcdef0123456789abcdef")

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import TaskType  # noqa: E402

BASE = "/internal/v1/tasks"


async def fake_ollama_probe(url: str, timeout: float):
    """离线探针：假装本机模型在位。"""
    return ["qwen2.5:0.5b", "qwen2.5:7b"]


async def echo_executor(task, ctx):
    """测试用执行器：产出可辨识的结果（仅测试注入，服务默认不注册）。"""
    await ctx.set_phase("generation")
    return {
        "result": {"text": "测试结果", "provenance": "AI_GENERATED"},
        "model": {"modelProfile": "small-default", "modelId": "stub-echo"},
    }


@pytest.fixture()
def settings(tmp_path):
    return Settings(
        store_path=tmp_path / "tasks.json",
        ollama_url="http://127.0.0.1:9",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=60,
        result_ttl_seconds=3600,
        queue_max=10,
        auth_mode="off",
        log_level="WARNING",
    )


@pytest.fixture()
def client(settings):
    app = create_app(settings, executors={TaskType.CHAT: echo_executor}, ollama_probe=fake_ollama_probe)
    with TestClient(app) as test_client:
        yield test_client
