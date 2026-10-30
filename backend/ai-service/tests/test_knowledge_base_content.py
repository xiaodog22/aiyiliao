"""院内知识库内容契约（v2，2026-10-22 内容替换任务）。

锁定「内容可替换但结构不能乱」的约束：
1. 四场景齐全（triage/chat/careplan/interpret），每场景预算内**不被截断**（v2 全部装得下）；
2. `metadata` 具备 reviewedBy / reviewedAt / source（人工复核痕迹）+ reviewStatus + todo 清单；
3. `triage` 条目声明的 `departments` 必须是 `triage-departments.json` 白名单子集；
4. 内容不得含手机号/身份证/邮箱/银行卡/患者姓名占位，也不得写 URL/IP/端口/磁盘路径（会进 prompt）；
5. **schema 向后兼容**：只含 v1 字段（version/scenarios/knowledge[topic,content,priority]）的配置
   仍能被加载与注入——新增字段（departments/source/status/reviewedBy…）全部可选。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.knowledge import KnowledgeLoader

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
KB = CONFIG_DIR / "hospital-knowledge.json"
WHITELIST = CONFIG_DIR / "triage-departments.json"
SCENARIOS = ("triage", "chat", "careplan", "interpret")


def _load() -> dict:
    return json.loads(KB.read_text(encoding="utf-8"))


def _estimate(text: str) -> int:
    return int(len(text) * 1.5)


def _whitelist_names() -> set[str]:
    data = json.loads(WHITELIST.read_text(encoding="utf-8"))
    names: set[str] = set()
    for dept in data["departments"]:
        names.add(dept["name"])
        names.update(dept.get("alias") or [])
    return names


def test_four_scenarios_present_with_budget():
    data = _load()
    assert set(SCENARIOS) <= set(data["scenarios"]), "必须覆盖四个场景"

    for name in SCENARIOS:
        block = data["scenarios"][name]
        budget = block["budgetTokens"]
        used = sum(_estimate(item["content"]) for item in block["knowledge"])
        assert used <= budget, f"{name} 超预算：{used} > {budget}"


def test_loader_keeps_every_item_within_budget():
    """v2 内容应**全部**装进预算（无静默丢弃）；丢弃意味着写了却没进 prompt。"""
    loader = KnowledgeLoader(KB)
    data = _load()

    for name in SCENARIOS:
        items = data["scenarios"][name]["knowledge"]
        injected = loader.get_knowledge(name, budget_tokens=data["scenarios"][name]["budgetTokens"])
        for item in items:
            head = item["content"][:12]
            assert head in injected, f"{name} 的片段「{item['topic']}」未进入注入文本（被预算丢弃）"


def test_metadata_records_review_trail():
    meta = _load()["metadata"]
    for key in ("hospital", "lastUpdated", "reviewedBy", "reviewedAt", "source"):
        assert str(meta.get(key) or "").strip(), f"metadata.{key} 不得为空"
    assert isinstance(meta["source"], list) and meta["source"], "source 必须是非空数组（可追溯）"
    assert meta.get("reviewStatus") in ("partial", "verified", "ai_checked_pending_clinical_review"), "reviewStatus 必须显式标注复核程度"
    assert meta.get("todo"), "仍有未核实项时必须保留 todo 清单"


def test_version_is_monotonic_v3():
    assert _load()["version"] == "hospital-knowledge-v3"


def test_triage_departments_match_whitelist():
    whitelist = _whitelist_names()
    for item in _load()["scenarios"]["triage"]["knowledge"]:
        declared = item.get("departments") or []
        unknown = [d for d in declared if d not in whitelist]
        assert not unknown, f"triage 片段「{item['topic']}」写了白名单外科室：{unknown}"


@pytest.mark.parametrize("label,pattern", [
    ("手机号", r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    ("身份证", r"(?<!\d)\d{17}[\dXx](?!\d)"),
    ("邮箱", r"[\w.+-]+@[\w-]+\.[\w.]+"),
    ("银行卡", r"(?<!\d)\d{16,19}(?!\d)"),
    ("姓名占位", r"[张王李赵刘陈杨黄周吴]某"),
    ("URL", r"https?://"),
    ("IP", r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)"),
    ("磁盘路径", r"[A-Za-z]:[\\/]"),
])
def test_no_privacy_or_internal_info(label, pattern):
    data = _load()
    texts = [item["content"] for block in data["scenarios"].values() for item in block["knowledge"]]
    for text in texts:
        assert not re.search(pattern, text), f"知识库内容命中「{label}」规则：{text[:40]}"


def test_v1_shaped_config_still_loads(tmp_path):
    """向后兼容：只有 v1 字段（无 reviewedBy/departments/source/status）也必须能加载并注入。"""
    legacy = {
        "version": "hospital-knowledge-v1",
        "scenarios": {
            "chat": {
                "budgetTokens": 100,
                "knowledge": [{"topic": "旧格式", "content": "旧格式知识仍可使用。", "priority": 1}],
            }
        },
    }
    path = tmp_path / "legacy-kb.json"
    path.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")

    loader = KnowledgeLoader(path)

    assert loader.is_loaded and loader.version == "hospital-knowledge-v1"
    assert loader.get_knowledge("chat", budget_tokens=100) == "旧格式知识仍可使用。"
