"""RAG 集成测试：特征开关 + 降级安全（2026-10-22）。

测试覆盖：
- RAG 开关关闭：不检索，citations 为空
- RAG 开关开启：检索成功，citations 非空
- Qdrant 不可用：降级为空 citations，不阻断回答
- Embedding 失败：降级为空 citations，不阻断回答
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from app.config import Settings
from app.executors.chat import build_chat_executor
from app.executors.rag import build_rag_executor
from app.tasks import TaskContext


class MockContext:
    """模拟 TaskContext（用于测试）。"""
    
    async def set_phase(self, phase: str):
        pass


@pytest.fixture
def base_settings():
    """基础配置（RAG 关闭）。"""
    return Settings(
        ollama_url="http://localhost:11434",
        small_model="qwen2.5:0.5b",
        rag_enabled=False,
    )


@pytest.fixture
def rag_enabled_settings():
    """RAG 开启配置。"""
    return Settings(
        ollama_url="http://localhost:11434",
        small_model="qwen2.5:0.5b",
        rag_enabled=True,
        rag_store="qdrant",
        qdrant_url="http://localhost:6333",
        qdrant_collection="health_kb",
        qdrant_timeout_seconds=3.0,
        embedding_model="nomic-embed-text",
        rag_top_k=3,
        rag_score_threshold=0.7,
        rag_max_retries=2,
    )


@pytest.fixture
def mock_probe():
    """模拟探针（已就绪）。"""
    probe = Mock()
    probe.ollama_tags = AsyncMock(return_value=["qwen2.5:0.5b", "nomic-embed-text"])
    return probe


def test_rag_disabled_by_default(base_settings):
    """测试 RAG 默认关闭。"""
    assert base_settings.rag_enabled is False


def test_rag_executor_fails_when_disabled(base_settings, mock_probe):
    """测试 RAG 开关关闭时执行器快速失败。"""
    executor = build_rag_executor(base_settings, mock_probe)
    task = {"taskId": "test_001", "inputInline": "高血压注意事项"}
    
    with pytest.raises(Exception) as exc_info:
        import asyncio
        asyncio.run(executor(task, MockContext()))
    
    # 应该抛出 CAPABILITY_UNAVAILABLE
    assert "CAPABILITY_UNAVAILABLE" in str(exc_info.value) or "RAG 检索未启用" in str(exc_info.value)


def test_chat_with_rag_disabled_returns_empty_citations(base_settings, mock_probe):
    """测试 RAG 关闭时 CHAT citations 为空。"""
    # Mock Ollama 响应
    mock_response = httpx.Response(
        200,
        json={
            "model": "qwen2.5:0.5b",
            "response": json.dumps({
                "text": "高血压患者应注意低盐饮食。",
                "language": "zh-CN",
                "refused": False,
                "refusalReason": None,
            }),
        },
    )
    
    transport = httpx.MockTransport(lambda req: mock_response)
    executor = build_chat_executor(base_settings, mock_probe, transport=transport)
    
    task = {
        "taskId": "test_002",
        "inputInline": "高血压要注意什么？",
        "modelProfile": "small-default",
    }
    
    result = asyncio.run(executor(task, MockContext()))
    
    assert result["result"]["citations"] == []
    assert result["result"]["text"] == "高血压患者应注意低盐饮食。"


def test_chat_with_rag_enabled_returns_citations(rag_enabled_settings, mock_probe):
    """测试 RAG 开启时 CHAT citations 非空。"""
    # Mock Ollama 响应（生成）
    mock_chat_response = httpx.Response(
        200,
        json={
            "model": "qwen2.5:0.5b",
            "response": json.dumps({
                "text": "根据院内科普资料，高血压患者应注意低盐饮食、适量运动。",
                "language": "zh-CN",
                "refused": False,
                "refusalReason": None,
            }),
        },
    )
    
    # Mock Ollama embedding 响应
    mock_embedding_response = httpx.Response(
        200,
        json={"embedding": [0.1] * 768},
    )
    
    # Mock Qdrant 检索响应
    mock_qdrant_response = httpx.Response(
        200,
        json={
            "result": [
                {
                    "score": 0.85,
                    "payload": {
                        "documentId": "kb_001",
                        "chunkId": "kb_001_p1",
                        "content": "高血压患者应注意低盐饮食，每日食盐摄入量不超过 6 克。",
                        "title": "高血压健康指南",
                        "source": "院内科普",
                        "publishedAt": "2024-01-01",
                    },
                },
            ],
        },
    )
    
    def mock_router(request: httpx.Request):
        url = str(request.url)
        if "/api/embeddings" in url:
            return mock_embedding_response
        elif "/collections/" in url and "/points/search" in url:
            return mock_qdrant_response
        else:
            return mock_chat_response
    
    transport = httpx.MockTransport(mock_router)
    executor = build_chat_executor(rag_enabled_settings, mock_probe, transport=transport)
    
    task = {
        "taskId": "test_003",
        "inputInline": "高血压要注意什么？",
        "modelProfile": "small-default",
    }
    
    result = asyncio.run(executor(task, MockContext()))
    
    # 验证 citations 非空
    assert len(result["result"]["citations"]) == 1
    assert result["result"]["citations"][0]["documentId"] == "kb_001"
    assert result["result"]["citations"][0]["score"] == 0.85


def test_rag_degrades_gracefully_when_qdrant_unavailable(rag_enabled_settings, mock_probe):
    """测试 Qdrant 不可用时降级为空 citations（不阻断回答）。"""
    # Mock Ollama 响应（生成）
    mock_chat_response = httpx.Response(
        200,
        json={
            "model": "qwen2.5:0.5b",
            "response": json.dumps({
                "text": "高血压患者应注意低盐饮食。",
                "language": "zh-CN",
                "refused": False,
                "refusalReason": None,
            }),
        },
    )
    
    # Mock Ollama embedding 响应
    mock_embedding_response = httpx.Response(
        200,
        json={"embedding": [0.1] * 768},
    )
    
    # Mock Qdrant 不可用（500 错误）
    mock_qdrant_error = httpx.Response(500, text="Internal Server Error")
    
    def mock_router(request: httpx.Request):
        url = str(request.url)
        if "/api/embeddings" in url:
            return mock_embedding_response
        elif "/collections/" in url and "/points/search" in url:
            return mock_qdrant_error
        else:
            return mock_chat_response
    
    transport = httpx.MockTransport(mock_router)
    executor = build_chat_executor(rag_enabled_settings, mock_probe, transport=transport)
    
    task = {
        "taskId": "test_004",
        "inputInline": "高血压要注意什么？",
        "modelProfile": "small-default",
    }
    
    result = asyncio.run(executor(task, MockContext()))
    
    # 验证降级为空 citations，但回答正常
    assert result["result"]["citations"] == []
    assert result["result"]["text"] == "高血压患者应注意低盐饮食。"


def test_rag_degrades_gracefully_when_embedding_fails(rag_enabled_settings, mock_probe):
    """测试 Embedding 失败时降级为空 citations（不阻断回答）。"""
    # Mock Ollama 响应（生成）
    mock_chat_response = httpx.Response(
        200,
        json={
            "model": "qwen2.5:0.5b",
            "response": json.dumps({
                "text": "高血压患者应注意低盐饮食。",
                "language": "zh-CN",
                "refused": False,
                "refusalReason": None,
            }),
        },
    )
    
    # Mock Ollama embedding 失败（500 错误）
    mock_embedding_error = httpx.Response(500, text="Model not found")
    
    def mock_router(request: httpx.Request):
        url = str(request.url)
        if "/api/embeddings" in url:
            return mock_embedding_error
        else:
            return mock_chat_response
    
    transport = httpx.MockTransport(mock_router)
    executor = build_chat_executor(rag_enabled_settings, mock_probe, transport=transport)
    
    task = {
        "taskId": "test_005",
        "inputInline": "高血压要注意什么？",
        "modelProfile": "small-default",
    }
    
    result = asyncio.run(executor(task, MockContext()))
    
    # 验证降级为空 citations，但回答正常
    assert result["result"]["citations"] == []
    assert result["result"]["text"] == "高血压患者应注意低盐饮食。"
