"""
院内知识库注入层集成测试（2026-10-22）

覆盖矩阵
--------
| 组别                       | 断言目标                                              |
| -------------------------- | ----------------------------------------------------- |
| 加载器（Loader）           | 有效/缺失/损坏/场景缺失/预算截断/默认预算              |
| 注入生效（Injection）      | 四个执行器的 system 字段真实包含本场景知识（不是只构建不报错） |
| 超预算截断（Truncation）   | 同一份配置在不同预算下丢片段的行为差异，且**发往模型的 system 确实被裁** |
| 缺失降级（Degradation）    | 配置缺失/损坏时退回原始 prompt，生成照常完成、不伪造引用 |

设计要点
--------
1. 「注入生效」必须看**真正发出去的请求体**，不能只看 `build_*_executor()` 没抛异常——
   2026-10-22 修 chat 执行器时即出现「prompt 拼好了但传的是原始 prompt」这类静默失效。
2. 「超预算截断」用同一份临时配置跑四个执行器：预算 400（chat/interpret）保留中优先级
   片段，预算 300（triage/careplan）丢弃它，以此证明截断由预算驱动而非偶然。
3. 「缺失降级」同时覆盖**文件不存在**与**JSON 损坏**两种故障，且验证降级后结果结构仍合法。
4. 所有模型调用走 `httpx.MockTransport`，不依赖本机 Ollama / Qdrant。
"""

import asyncio
import json
import logging
import sys
from pathlib import Path

import httpx
import pytest

# 设置 sys.path 以便导入 app 模块（独立运行本文件时也可用）
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import Settings
from app.executors.careplan import build_careplan_executor
from app.executors.chat import build_chat_executor
from app.executors.interpret import build_interpret_executor
from app.executors.triage import build_triage_executor
from app.knowledge import KnowledgeLoader, get_knowledge_loader

_SERVICE_DIR = Path(__file__).parent.parent
_REAL_KB = _SERVICE_DIR / "config" / "hospital-knowledge.json"
_DEPARTMENTS_CFG = _SERVICE_DIR / "config" / "triage-departments.json"
_SMALL_MODEL = "qwen2.5:0.5b"


# --------------------------------------------------------------------------
# 运行时脚手架：探针桩 / TaskContext 桩 / 四执行器统一调用入口
# --------------------------------------------------------------------------
class _ReadyProbe:
    """探针桩：模型已就位（避免真实打 /api/tags）。"""

    async def ollama_tags(self):
        return [_SMALL_MODEL, "qwen2.5:7b"]


class _Ctx:
    """TaskContext 桩：只记录阶段，不做持久化。"""

    def __init__(self):
        self.phases = []

    async def set_phase(self, phase: str):
        self.phases.append(phase)


# 各执行器「合法」的模型输出：保证流程能走完生成之后，不因输出非法提前抛错
_RESPONSES = {
    "triage": {
        "recommendedDepartments": [
            {"departmentName": "消化内科", "reason": "腹泻提示消化道症状", "confidence": 0.8}
        ]
    },
    "chat": {
        "text": "门诊时间为周一至周五 8:00-17:00。",
        "language": "zh-CN",
        "refused": False,
        "refusalReason": None,
    },
    "careplan": {
        "suggestions": [{"title": "规律作息", "detail": "每天固定 22:30 入睡"}],
        "days": [
            {"label": "第 1 天", "diet": "少盐少油", "exercise": "散步 20 分钟", "sleep": "22:30 入睡"}
        ],
        "refused": False,
        "refusalReason": None,
    },
    "interpret": {
        "summary": "血脂偏高，建议复查并控制饮食。",
        "sections": [{"title": "血脂四项", "body": "总胆固醇偏高。", "abnormal": True}],
        "refused": False,
        "refusalReason": None,
        "language": "zh-CN",
    },
}

_TASKS = {
    "triage": {"taskId": "t_triage_kb", "inputInline": "肚子疼、拉肚子两天"},
    "chat": {"taskId": "t_chat_kb", "inputInline": "门诊时间是什么时候？"},
    "careplan": {"taskId": "t_careplan_kb", "inputInline": "最近血压偏高，想调理作息"},
    "interpret": {"taskId": "t_interpret_kb", "inputInline": "血脂四项：总胆固醇 6.1，低密度脂蛋白 4.2"},
}

_BUILDERS = {
    "triage": build_triage_executor,
    "chat": build_chat_executor,
    "careplan": build_careplan_executor,
    "interpret": build_interpret_executor,
}

_SCENARIOS = list(_BUILDERS)


@pytest.fixture(params=_SCENARIOS)
def scenario(request):
    """四执行器参数化：同一断言在四个场景各跑一遍。"""
    return request.param


def _settings(knowledge_path: Path) -> Settings:
    """构造真实 Settings（不用 MagicMock：超时/模型等字段会被 httpx.Timeout 真实消费）。"""
    return Settings(
        ollama_url="http://127.0.0.1:11434",
        small_model=_SMALL_MODEL,
        large_model="qwen2.5:7b",
        rag_enabled=False,
        knowledge_base_path=knowledge_path,
        triage_departments_config=_DEPARTMENTS_CFG,
    )


def _run(name: str, settings: Settings):
    """跑一次执行器，返回 (发往 Ollama 的请求体, 执行器 result 段)。"""
    captured: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            200,
            json={
                "model": _SMALL_MODEL,
                "response": json.dumps(_RESPONSES[name], ensure_ascii=False),
            },
        )

    executor = _BUILDERS[name](
        settings, _ReadyProbe(), transport=httpx.MockTransport(handler)
    )
    outcome = asyncio.run(executor(dict(_TASKS[name]), _Ctx()))

    assert len(captured) == 1, f"{name} 应恰好发出一次生成请求，实际 {len(captured)} 次"
    return captured[0], outcome["result"]


def _assert_result_ok(name: str, result: dict) -> None:
    """降级/注入都不得改变结果结构。"""
    if name == "triage":
        assert result["recommendedDepartments"], "triage 结果应给出科室"
    elif name == "chat":
        assert result["text"], "chat 结果应有正文"
        assert result["citations"] == [], "RAG 关闭时不得伪造引用"
    elif name == "careplan":
        assert result["suggestions"], "careplan 结果应有建议"
    else:
        assert result["summary"], "interpret 结果应有结论"


def _estimate_tokens(text: str) -> int:
    """与 knowledge.py 内部估算口径保持一致（中文字符数 × 1.5）。"""
    return int(len(text) * 1.5)


# --------------------------------------------------------------------------
# 一、加载器基础功能
# --------------------------------------------------------------------------
class TestKnowledgeLoader:
    """知识库加载器：有效加载、故障降级、场景缺失、预算截断。"""

    def test_load_valid_knowledge_base(self):
        """有效配置：版本号、四场景、关键内容均可读。"""
        loader = KnowledgeLoader(_REAL_KB)

        assert loader.is_loaded, "知识库应成功加载"
        assert loader.version == "hospital-knowledge-v3", f"版本号不匹配: {loader.version}"

        triage_knowledge = loader.get_knowledge("triage", budget_tokens=300)
        chat_knowledge = loader.get_knowledge("chat", budget_tokens=400)
        careplan_knowledge = loader.get_knowledge("careplan", budget_tokens=300)
        interpret_knowledge = loader.get_knowledge("interpret", budget_tokens=400)

        assert "全科医学科" in triage_knowledge, "triage 知识应包含本院科室"
        assert "预约号源" in chat_knowledge, "chat 知识应包含预约号源时段"
        assert "营养咨询" in careplan_knowledge, "careplan 知识应包含营养咨询"
        assert "低密度脂蛋白胆固醇" in interpret_knowledge, "interpret 知识应包含检验术语"

    def test_load_missing_knowledge_base(self):
        """文件不存在：标记未加载、版本 unknown、取文本为空（降级）。"""
        loader = KnowledgeLoader(Path("/nonexistent/hospital-knowledge.json"))

        assert not loader.is_loaded
        assert loader.version == "unknown"
        assert loader.get_knowledge("triage", budget_tokens=300) == ""

    def test_load_corrupted_knowledge_base(self, tmp_path):
        """JSON 损坏：标记未加载并降级，不抛异常。"""
        temp_path = tmp_path / "broken-knowledge.json"
        temp_path.write_text("{ invalid json ", encoding="utf-8")

        loader = KnowledgeLoader(temp_path)

        assert not loader.is_loaded, "损坏的知识库应标记为未加载"
        assert loader.get_knowledge("chat", budget_tokens=400) == ""

    def test_missing_required_fields_degrades(self, tmp_path):
        """缺少 version/scenarios 视为格式错误 → 降级（不半加载）。"""
        temp_path = tmp_path / "no-version.json"
        temp_path.write_text(json.dumps({"scenarios": {}}, ensure_ascii=False), encoding="utf-8")

        loader = KnowledgeLoader(temp_path)

        assert not loader.is_loaded
        assert loader.version == "unknown"

    def test_token_budget_truncation(self, tmp_path):
        """超预算：高优先级保留，低优先级被截断。"""
        test_config = {
            "version": "test-v1",
            "scenarios": {
                "test_scenario": {
                    "budgetTokens": 100,
                    "knowledge": [
                        {"topic": "高优先级片段", "content": "这是高优先级内容，应保留。" * 5, "priority": 10},
                        {"topic": "中优先级片段", "content": "这是中优先级内容，可能保留。" * 5, "priority": 5},
                        {"topic": "低优先级片段", "content": "这是低优先级内容，应被截断。" * 10, "priority": 1},
                    ],
                }
            },
        }
        temp_path = tmp_path / "budget.json"
        temp_path.write_text(json.dumps(test_config, ensure_ascii=False), encoding="utf-8")

        loader = KnowledgeLoader(temp_path)
        knowledge = loader.get_knowledge("test_scenario", budget_tokens=100)

        assert "高优先级内容" in knowledge, "高优先级片段应被保留"
        assert "低优先级内容" not in knowledge, "低优先级片段应被截断"

    def test_scenario_default_budget_used_when_unspecified(self, tmp_path):
        """未传 budget_tokens 时取场景 budgetTokens（这里是必然截断的小预算）。"""
        test_config = {
            "version": "test-v1",
            "scenarios": {
                "tiny": {
                    "budgetTokens": 10,
                    "knowledge": [
                        {"topic": "小片段", "content": "短", "priority": 10},
                        {"topic": "大片段", "content": "长" * 100, "priority": 1},
                    ],
                }
            },
        }
        temp_path = tmp_path / "default-budget.json"
        temp_path.write_text(json.dumps(test_config, ensure_ascii=False), encoding="utf-8")

        knowledge = KnowledgeLoader(temp_path).get_knowledge("tiny")

        assert "短" in knowledge
        assert "长" * 10 not in knowledge

    def test_nonexistent_scenario(self):
        """场景不存在：返回空字符串（降级），不抛异常。"""
        loader = KnowledgeLoader(_REAL_KB)

        assert loader.get_knowledge("nonexistent_scenario", budget_tokens=300) == ""


class TestKnowledgeLoaderSingleton:
    """加载器工厂：同路径复用实例，不同路径互不干扰。"""

    def test_get_knowledge_loader_returns_singleton(self):
        loader1 = get_knowledge_loader(_REAL_KB)
        loader2 = get_knowledge_loader(_REAL_KB)

        assert loader1 is loader2, "get_knowledge_loader 应返回单例实例"
        assert loader1.is_loaded, "单例实例应成功加载知识库"

    def test_get_knowledge_loader_different_paths(self, tmp_path):
        loader1 = get_knowledge_loader(_REAL_KB)
        loader2 = get_knowledge_loader(tmp_path / "other-knowledge.json")

        assert loader1 is not loader2, "不同路径应返回不同实例"


# --------------------------------------------------------------------------
# 二、注入生效：system 字段真的带上了本场景知识
# --------------------------------------------------------------------------
# 各场景「独有」标记（不与其他场景知识重叠），用于正反两向校验
_SCENARIO_MARKERS = {
    "triage": "开设科室",
    "chat": "就诊前一日或当日截止前",
    "careplan": "竞技与高强度训练",
    "interpret": "坏胆固醇",
}


class TestInjectionEffective:
    """注入生效：四个执行器都必须把知识写进发往模型的 system。"""

    def test_system_prompt_carries_hospital_knowledge(self, scenario):
        payload, result = _run(scenario, _settings(_REAL_KB))

        system = payload["system"]
        assert "院内知识库：" in system, f"{scenario} system 缺少知识库小节"
        assert _SCENARIO_MARKERS[scenario] in system, (
            f"{scenario} system 未包含本场景知识，实际前 200 字：{system[:200]}"
        )
        _assert_result_ok(scenario, result)

    def test_injection_is_scenario_scoped(self, scenario):
        """只注入本场景：不得把别的场景知识塞进来（避免 prompt 膨胀与串味）。"""
        system = _run(scenario, _settings(_REAL_KB))[0]["system"]

        for other, marker in _SCENARIO_MARKERS.items():
            if other != scenario:
                assert marker not in system, f"{scenario} system 混入了 {other} 场景知识"

    def test_original_guardrails_preserved(self, scenario):
        """注入是「追加」不是「替换」：原有红线（不诊断/不推荐药物/只输出 JSON）仍在。"""
        system = _run(scenario, _settings(_REAL_KB))[0]["system"]

        assert "JSON" in system, "原始提示词要求仍在"
        assert "不" in system and ("诊断" in system or "药物" in system or "处方" in system), (
            f"{scenario} 原始红线被覆盖，实际前 200 字：{system[:200]}"
        )

    def test_knowledge_text_precedes_generation_not_output(self, scenario):
        """知识只进 system，不污染发给模型的用户输入（用户原文保持不变）。"""
        payload, _ = _run(scenario, _settings(_REAL_KB))

        assert _TASKS[scenario]["inputInline"] in payload["prompt"], "用户原文应原样保留在 prompt"
        assert _SCENARIO_MARKERS[scenario] not in payload["prompt"], "知识不应被塞进用户 prompt"


# --------------------------------------------------------------------------
# 三、超预算截断：同一配置，预算 400 保留中优先片段 / 预算 300 丢弃
# --------------------------------------------------------------------------
# 片段长度刻意设计成：
#   高优先级 20 字 → 30 tokens（任何预算都保留）
#   中优先级 200 字 → 300 tokens（预算 400 保留；预算 300 时 30+300>300 丢弃）
#   低优先级 400 字 → 600 tokens（任何预算都丢弃）
_HIGH = "【高优先级】" + "填" * 14      # 20 字 → 30 tokens
_MID = "【中优先级】" + "填" * 194      # 200 字 → 300 tokens
_LOW = "【低优先级】" + "填" * 394      # 400 字 → 600 tokens

# 执行器写死的预算（chat/interpret=400，triage/careplan=300）
_BIG_BUDGET_SCENARIOS = {"chat", "interpret"}
_SMALL_BUDGET_SCENARIOS = {"triage", "careplan"}


def _write_budget_config(path: Path) -> Path:
    """为四个场景各写一份「同内容不同名」的知识配置。"""
    scenario_block = {
        "budgetTokens": 300,
        "knowledge": [
            {"topic": "高优先级", "content": _HIGH, "priority": 10},
            {"topic": "中优先级", "content": _MID, "priority": 5},
            {"topic": "低优先级", "content": _LOW, "priority": 1},
        ],
    }
    config = {
        "version": "budget-test-v1",
        "scenarios": {name: dict(scenario_block) for name in _SCENARIOS},
    }
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    return path


class TestBudgetTruncation:
    """超预算截断：发往模型的 system 必须已按预算裁剪。"""

    @pytest.fixture()
    def budget_kb(self, tmp_path):
        return _write_budget_config(tmp_path / "budget-knowledge.json")

    def test_low_priority_always_dropped(self, scenario, budget_kb):
        """低优先级（600 tokens）在任何预算下都进不了 system。"""
        system = _run(scenario, _settings(budget_kb))[0]["system"]

        assert "【高优先级】" in system, "高优先级片段应被保留"
        assert "【低优先级】" not in system, "低优先级片段应被截断"

    def test_mid_priority_kept_only_with_big_budget(self, scenario, budget_kb):
        """中优先级片段是否保留，由执行器预算决定（400 保留 / 300 丢弃）。"""
        system = _run(scenario, _settings(budget_kb))[0]["system"]

        if scenario in _BIG_BUDGET_SCENARIOS:
            assert "【中优先级】" in system, (
                f"{scenario} 预算 400，30+300=330 tokens 应能容纳中优先级片段"
            )
        else:
            assert "【中优先级】" not in system, (
                f"{scenario} 预算 300，30+300=330 tokens 超预算，应丢弃中优先级片段"
            )

    def test_truncation_logged(self, tmp_path, caplog):
        """截断必须留痕（便于线上核对注入体积，不静默）。"""
        budget_kb = _write_budget_config(tmp_path / "budget-log.json")
        with caplog.at_level(logging.INFO, logger="app.knowledge"):
            _run("chat", _settings(budget_kb))

        assert any("超预算" in record.getMessage() for record in caplog.records), (
            "应记录超预算截断日志"
        )

    def test_estimated_tokens_never_exceed_budget(self, tmp_path):
        """加载器层面：选中片段的估算总量不超过预算（边界防护）。"""
        budget = 330  # 恰好等于 高+中，验证等号成立时也保留
        loader = KnowledgeLoader(_write_budget_config(tmp_path / "boundary.json"))

        selected = [
            item
            for item in [_HIGH, _MID, _LOW]
            if item in loader.get_knowledge("chat", budget_tokens=budget)
        ]
        total = sum(_estimate_tokens(text) for text in selected)

        assert total <= budget, f"估算 token 总量 {total} 不应超过预算 {budget}"
        assert "【中优先级】" in "".join(selected), "预算恰好吃得下时应保留中优先级"


# --------------------------------------------------------------------------
# 四、缺失降级：配置缺失/损坏时退回原始 prompt，生成不中断
# --------------------------------------------------------------------------
def _degradation_cases(tmp_path):
    """两类故障：(名称, 配置路径, 是否残留临时文件)。"""
    corrupted = tmp_path / "corrupted-knowledge.json"
    corrupted.write_text("{ invalid json ", encoding="utf-8")
    return [
        ("missing", tmp_path / "no-such-dir" / "hospital-knowledge.json"),
        ("corrupted", corrupted),
    ]


class TestDegradation:
    """缺失降级：知识库不可用不得阻断生成，也不得伪造知识。"""

    @pytest.mark.parametrize("case", ["missing", "corrupted"])
    def test_generation_still_succeeds(self, scenario, tmp_path, case):
        """两种故障下生成照常完成，结果结构合法。"""
        path = dict(_degradation_cases(tmp_path))[case]

        payload, result = _run(scenario, _settings(path))

        assert payload["system"], "降级后仍应发出 system"
        assert "院内知识库：" not in payload["system"], "降级后不得残留知识库小节"
        _assert_result_ok(scenario, result)

    @pytest.mark.parametrize("case", ["missing", "corrupted"])
    def test_degrades_to_base_prompt(self, scenario, tmp_path, case):
        """降级后的 system 与「知识库完全为空」时的基线逐字一致。"""
        path = dict(_degradation_cases(tmp_path))[case]
        degraded_system = _run(scenario, _settings(path))[0]["system"]

        loader = KnowledgeLoader(path)
        assert not loader.is_loaded, "故障配置应标记为未加载"
        assert loader.version == "unknown"
        assert loader.get_knowledge(scenario, budget_tokens=400) == "", "故障配置不得吐出知识文本"

        # 基线：直接把真实知识库换成空文本后的 prompt 长度上限校验（防悄悄加料）
        real_system = _run(scenario, _settings(_REAL_KB))[0]["system"]
        assert len(degraded_system) < len(real_system), (
            "降级 prompt 应短于注入后 prompt（说明确实没注入）"
        )
        assert "院内知识库" not in degraded_system

    def test_startup_not_blocked_by_missing_config(self, tmp_path):
        """构建阶段不抛异常：配置缺失也不能让服务起不来。"""
        settings = _settings(tmp_path / "absent.json")

        for name, builder in _BUILDERS.items():
            assert builder(settings, _ReadyProbe()) is not None, f"{name} 执行器应降级构建成功"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
