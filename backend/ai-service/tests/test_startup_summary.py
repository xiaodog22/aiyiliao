"""启动配置摘要日志（2026-10-22 配置开启任务）。

背景：三个默认关闭的开关（`AI_CACHE_ENABLED` / `AI_ASR_PRELOAD` / `AI_RAG_ENABLED`）开启后，
现场只能靠"猜"判断是否生效。本组用例锁定一行可 grep 的启动摘要：
`启动配置摘要 | version=... | cache=on | cacheBackend=json | ...`

契约：
1. 反映真实开关值（on/off 两态都要对）；
2. **绝不回显**密钥值、`ollama/qdrant` 地址、磁盘路径；
3. lifespan 启动时**确实**打出这一行（不是只在单元测试里能拼出来）。
"""

from __future__ import annotations

import logging

from fastapi.testclient import TestClient

from app.config import Settings, config_summary, format_config_summary
from app.main import create_app

SECRET = "0123456789abcdef" * 4  # 64 字符假密钥：只用于断言"不出现"


def _settings(tmp_path, **overrides) -> Settings:
    base = dict(
        store_path=tmp_path / "tasks.json",
        cache_path=tmp_path / "cache.json",
        ollama_url="http://127.0.0.1:9",
        probe_timeout_seconds=0.2,
        task_timeout_seconds=60,
        result_ttl_seconds=3600,
        queue_max=10,
        auth_mode="off",
        log_level="INFO",
    )
    base.update(overrides)
    return Settings(**base)


def test_summary_reflects_switch_states(tmp_path):
    """开关全开：摘要应显示 on/具体值。"""
    on = config_summary(
        _settings(
            tmp_path,
            cache_enabled=True,
            tenant_secret=SECRET,
            cache_ttl_seconds=7200,
            rag_enabled=True,
            asr_preload=True,
            asr_engine="funasr",
            tts_stream=True,
        ),
        knowledge_version="hospital-knowledge-v1",
    )

    assert on["cache"] == "on" and on["cacheBackend"] == "json" and on["cacheTtlSeconds"] == 7200
    assert on["cacheTenantSecret"] == "configured"  # 固定密钥：重启后缓存仍可命中
    assert on["rag"] == "on" and on["qdrantCollection"] == "health_kb"
    assert on["embeddingModel"] == "nomic-embed-text"
    assert on["asrPreload"] == "on" and on["asrEngine"] == "funasr"
    assert on["ttsStream"] == "on"
    assert on["knowledgeVersion"] == "hospital-knowledge-v1"
    assert on["concurrency"] == 1  # 如实标注：当前是单 worker，不是池

    off = config_summary(_settings(tmp_path), knowledge_version="unknown")
    assert off["cache"] == "off" and off["cacheBackend"] == "none" and off["cacheTtlSeconds"] == 0
    assert off["rag"] == "off" and off["qdrantCollection"] == "n/a" and off["embeddingModel"] == "n/a"
    assert off["asrPreload"] == "off"
    # 未配置租户密钥 → 进程内随机（重启即失效），这个信息对运维比密钥本身更重要
    assert off["cacheTenantSecret"] == "auto-random"


def test_summary_never_leaks_secret_or_address(tmp_path):
    """摘要里不得出现密钥值、URL、绝对路径。"""
    settings = _settings(
        tmp_path,
        cache_enabled=True,
        tenant_secret=SECRET,
        rag_enabled=True,
        qdrant_api_key="qk-should-not-appear",
    )
    line = format_config_summary(config_summary(settings, knowledge_version="vX"))

    for forbidden in (SECRET, "qk-should-not-appear", "http://", "https://", "127.0.0.1", "11434", "6333"):
        assert forbidden not in line, f"启动摘要不得包含 {forbidden!r}"
    assert str(tmp_path) not in line, "启动摘要不得包含磁盘路径"


def test_lifespan_emits_summary_line(tmp_path, caplog):
    """lifespan 启动时必须真的打出该行（防止"只写了函数没人调"）。"""
    settings = _settings(
        tmp_path,
        cache_enabled=True,
        tenant_secret=SECRET,
        asr_preload=True,
        asr_engine="funasr",
        tts_engine="edge",
    )

    with caplog.at_level(logging.INFO, logger="ai-service"):
        with TestClient(create_app(settings, executors={})):
            pass

    lines = [r.getMessage() for r in caplog.records if "启动配置摘要" in r.getMessage()]
    assert len(lines) == 1, f"应恰好打印一行启动摘要，实际 {len(lines)}"
    line = lines[0]
    assert "cache=on" in line and "cacheBackend=json" in line
    assert "asrPreload=on" in line and "ttsStream=on" in line
    assert "http://" not in line and SECRET not in line
