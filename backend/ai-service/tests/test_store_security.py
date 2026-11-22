"""L3（2026-11-22 敌意审查）：AI 任务快照加密必须 fail-closed。

覆盖：
  1. 默认配置（require=true）无密钥 → 拒绝启动；
  2. 生产档位显式 opt-out → 拒绝启动；
  3. 非生产 opt-out → 允许启动但必须打印高危警告；
  4. 有密钥时 runtime/tasks.json 不含病情/结果明文，且可正确回读；
  5. .env 示例与 docker-compose 的加密开关/强制注入保持一致。
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from app.config import Settings
from app.store import TaskStore

REPO_ROOT = Path(__file__).resolve().parents[3]


def _settings(tmp_path: Path, **overrides) -> Settings:
    base = {
        "store_path": tmp_path / "tasks.json",
        "store_encryption_key": "",
        "store_require_encryption": True,
        "deployment_env": "dev",
    }
    base.update(overrides)
    return Settings(**base)


def test_默认配置无密钥拒绝启动(tmp_path):
    settings = _settings(tmp_path)
    assert settings.store_require_encryption is True
    with pytest.raises(RuntimeError, match="AI_STORE_REQUIRE_ENCRYPTION"):
        settings.validate_security()


def test_生产档位禁止关闭加密(tmp_path):
    settings = _settings(tmp_path, store_require_encryption=False, deployment_env="production")
    with pytest.raises(RuntimeError, match="AI_STORE_REQUIRE_ENCRYPTION=false"):
        settings.validate_security()


def test_非生产关闭加密打印高危警告(tmp_path, caplog):
    settings = _settings(tmp_path, store_require_encryption=False, deployment_env="dev")
    with caplog.at_level(logging.WARNING, logger="ai-service.config"):
        settings.validate_security()
    assert any("高危" in record.getMessage() for record in caplog.records), "opt-out 必须留高危告警"


def test_有密钥时快照不含明文且可回读(tmp_path):
    key = Fernet.generate_key().decode()
    settings = _settings(tmp_path, store_encryption_key=key, deployment_env="production")
    settings.validate_security()

    secret_input = "患者主诉胸痛放射至左臂，伴大汗"
    secret_answer = "疑似急性冠脉综合征，立即拨打 120"
    store = TaskStore(settings.store_path, key)
    store.tasks["t-l3"] = {
        "taskId": "t-l3",
        "task": "chat",
        "status": "RUNNING",
        "inputInline": secret_input,
        "result": {"answer": secret_answer},
    }
    assert asyncio.run(store.save()) is True

    raw = settings.store_path.read_text(encoding="utf-8")
    assert secret_input not in raw, "inputInline 明文落盘"
    assert secret_answer not in raw, "result 明文落盘"
    assert "__fernet_input_v1__" in raw and "__fernet_v1__" in raw, "密文标记缺失"

    loaded = TaskStore(settings.store_path, key)
    asyncio.run(loaded.load())
    task = loaded.tasks["t-l3"]
    assert task["inputInline"] == secret_input
    assert task["result"]["answer"] == secret_answer


def test_示例配置与compose强制注入一致():
    example = (REPO_ROOT / "backend" / "deploy" / ".env.ai-service.example").read_text(encoding="utf-8")
    compose = (REPO_ROOT / "backend" / "docker-compose.yml").read_text(encoding="utf-8")

    assert "AI_STORE_REQUIRE_ENCRYPTION=true" in example
    assert "AI_STORE_ENCRYPTION_KEY=" in example
    assert "AI_DEPLOY_ENV=" in example

    assert "AI_STORE_REQUIRE_ENCRYPTION: \"true\"" in compose, "compose 必须显式 require=true"
    assert "AI_DEPLOY_ENV:" in compose
    assert "${AI_STORE_ENCRYPTION_KEY:?" in compose, "compose 缺失 key 时必须拒绝启动（${VAR:?}）"
