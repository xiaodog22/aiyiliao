"""TRIAGE 科室白名单配置加载与校验测试（可配置化 2026-10-22）。

测试覆盖：
- 加载有效配置文件
- 文件不存在时使用内置默认
- 文件损坏时使用内置默认
- 空白名单时使用内置默认
- 白名单内科室通过过滤
- 白名单外科室被拦截
- 别名映射正确
- 全部过滤后返回兜底
- AI 返回空时返回兜底
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from app.executors.triage import _load_departments_config


def test_load_valid_config():
    """加载有效配置文件。"""
    config = {
        "version": "1.0.0",
        "departments": [
            {"name": "全科医学科", "alias": ["全科"]},
            {"name": "消化内科", "alias": ["消化科"]},
        ],
        "fallbackDepartment": "全科医学科",
        "fallbackReason": "建议人工分诊",
    }
    
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".json", delete=False) as f:
        json.dump(config, f, ensure_ascii=False)
        config_path = Path(f.name)
    
    try:
        result = _load_departments_config(config_path)
        
        assert len(result["departments"]) == 2
        assert result["allowed_names"] == {"全科医学科", "全科", "消化内科", "消化科"}
        assert result["hint"] == "全科医学科、消化内科"
        assert result["fallback_dept"] == "全科医学科"
        assert result["fallback_reason"] == "建议人工分诊"
    finally:
        config_path.unlink()


def test_load_missing_file_uses_default():
    """文件不存在时使用内置默认。"""
    config_path = Path("/nonexistent/path/to/config.json")
    result = _load_departments_config(config_path)
    
    # 默认 6 个科室
    assert len(result["departments"]) == 6
    assert "全科医学科" in result["allowed_names"]
    assert "消化内科" in result["allowed_names"]
    assert result["fallback_dept"] == "全科医学科"


def test_load_corrupted_file_uses_default():
    """文件损坏时使用内置默认。"""
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".json", delete=False) as f:
        f.write("{ invalid json }")
        config_path = Path(f.name)
    
    try:
        result = _load_departments_config(config_path)
        
        # 默认 6 个科室
        assert len(result["departments"]) == 6
        assert "全科医学科" in result["allowed_names"]
    finally:
        config_path.unlink()


def test_load_empty_departments_uses_default():
    """空白名单时使用内置默认。"""
    config = {
        "version": "1.0.0",
        "departments": [],
        "fallbackDepartment": "全科医学科",
        "fallbackReason": "建议人工分诊",
    }
    
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".json", delete=False) as f:
        json.dump(config, f, ensure_ascii=False)
        config_path = Path(f.name)
    
    try:
        result = _load_departments_config(config_path)
        
        # 默认 6 个科室
        assert len(result["departments"]) == 6
        assert "全科医学科" in result["allowed_names"]
    finally:
        config_path.unlink()


def test_filter_allows_valid_departments():
    """白名单内科室通过过滤。"""
    config_path = Path(__file__).parent.parent / "config" / "triage-departments.json"
    if not config_path.exists():
        pytest.skip("配置文件不存在，跳过测试")
    
    result = _load_departments_config(config_path)
    
    # 模拟 AI 推荐的科室（全在白名单内）
    raw_departments = [
        {"departmentName": "消化内科", "reason": "胃痛", "confidence": 0.9},
        {"departmentName": "全科医学科", "reason": "常见病", "confidence": 0.7},
    ]
    
    filtered = []
    for dept in raw_departments:
        dept_name = dept.get("departmentName", "").strip()
        if dept_name in result["allowed_names"]:
            filtered.append(dept)
    
    assert len(filtered) == 2
    assert filtered[0]["departmentName"] == "消化内科"
    assert filtered[1]["departmentName"] == "全科医学科"


def test_filter_blocks_invalid_departments():
    """白名单外科室被拦截。"""
    config_path = Path(__file__).parent.parent / "config" / "triage-departments.json"
    if not config_path.exists():
        pytest.skip("配置文件不存在，跳过测试")
    
    result = _load_departments_config(config_path)
    
    # 模拟 AI 推荐的科室（部分不在白名单内）
    raw_departments = [
        {"departmentName": "消化内科", "reason": "胃痛", "confidence": 0.9},
        {"departmentName": "康复科", "reason": "偏瘫康复", "confidence": 0.8},  # 不在白名单（院内无此科）
        {"departmentName": "全科医学科", "reason": "常见病", "confidence": 0.7},
    ]
    
    filtered = []
    blocked = []
    for dept in raw_departments:
        dept_name = dept.get("departmentName", "").strip()
        if dept_name in result["allowed_names"]:
            filtered.append(dept)
        else:
            blocked.append(dept_name)
    
    assert len(filtered) == 2
    assert len(blocked) == 1
    assert "康复科" in blocked


def test_filter_with_alias():
    """别名映射正确。"""
    config_path = Path(__file__).parent.parent / "config" / "triage-departments.json"
    if not config_path.exists():
        pytest.skip("配置文件不存在，跳过测试")
    
    result = _load_departments_config(config_path)
    
    # 模拟 AI 推荐的科室（使用别名）
    raw_departments = [
        {"departmentName": "消化科", "reason": "胃痛", "confidence": 0.9},  # 别名
        {"departmentName": "全科", "reason": "常见病", "confidence": 0.7},  # 别名
    ]
    
    filtered = []
    for dept in raw_departments:
        dept_name = dept.get("departmentName", "").strip()
        if dept_name in result["allowed_names"]:
            filtered.append(dept)
    
    assert len(filtered) == 2
    assert filtered[0]["departmentName"] == "消化科"
    assert filtered[1]["departmentName"] == "全科"


def test_fallback_when_all_filtered():
    """全部过滤后返回兜底。"""
    config_path = Path(__file__).parent.parent / "config" / "triage-departments.json"
    if not config_path.exists():
        pytest.skip("配置文件不存在，跳过测试")
    
    result = _load_departments_config(config_path)
    
    # 模拟 AI 推荐的科室（全部不在白名单内）
    raw_departments = [
        {"departmentName": "康复科", "reason": "偏瘫康复", "confidence": 0.9},
        {"departmentName": "营养科", "reason": "饮食指导", "confidence": 0.8},
    ]
    
    filtered = []
    for dept in raw_departments:
        dept_name = dept.get("departmentName", "").strip()
        if dept_name in result["allowed_names"]:
            filtered.append(dept)
    
    # 全部过滤后返回兜底
    if not filtered:
        filtered = [{
            "departmentName": result["fallback_dept"],
            "reason": result["fallback_reason"],
            "confidence": None
        }]
    
    assert len(filtered) == 1
    assert filtered[0]["departmentName"] == "全科医学科"
    assert "建议" in filtered[0]["reason"] or "分诊" in filtered[0]["reason"]


def test_fallback_when_ai_returns_empty():
    """AI 返回空时返回兜底。"""
    config_path = Path(__file__).parent.parent / "config" / "triage-departments.json"
    if not config_path.exists():
        pytest.skip("配置文件不存在，跳过测试")
    
    result = _load_departments_config(config_path)
    
    # 模拟 AI 返回空列表
    raw_departments = []
    
    filtered = raw_departments[:]
    
    # AI 返回空时返回兜底
    if not filtered:
        filtered = [{
            "departmentName": result["fallback_dept"],
            "reason": result["fallback_reason"],
            "confidence": None
        }]
    
    assert len(filtered) == 1
    assert filtered[0]["departmentName"] == "全科医学科"
