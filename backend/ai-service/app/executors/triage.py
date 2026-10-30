"""TRIAGE 执行器：科室推荐「补充档」（M1 · D1.1）。

定位（business-openapi `/api/v1/triage/recommendations` 描述 / 08A 任务书 D1.1）：
- 「本地红旗规则先跑，远端模型只做补充」中的**远端部分**：只给科室建议与简短依据，
  不给诊断结论、不推荐药物；
- **快降级**：模型服务不可达 / 模型缺失 / 超时 / 输出非法 → **秒级结构化失败**
  （CAPABILITY_UNAVAILABLE / MODEL_TIMEOUT / MODEL_OUTPUT_INVALID），
  不让上游（business-service）无限等待；上游据此回退纯本地规则结论。
- 本执行器不做急诊判定（那条链路由业务侧本地规则承担），失败也不得让上游把它
  当成功——错误码与 dependency 如实上报（O-10 原则：不造假）。
- **白名单校验**（2026-10-22 可配置化）：AI 推荐结果必须在本院科室白名单内；
  越界科室被过滤，全部过滤或 AI 返回空时使用安全兜底（"全科医学科" + 建议人工分诊）。

输入：任务 `inputInline` = 症状描述文本（<=1000 字符，超出截断）。
输出（result，登记于 ai-service README「任务类型与结果契约」）：
    {
      "recommendedDepartments": [{"departmentName", "reason"?, "confidence"?}],
      "provenance": "AI_GENERATED",
      "limitations": "...",
      "promptTemplateVersion": "triage-supplement-v2"
    }
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import httpx

from ..config import Settings
from ..tasks import TaskContext, TaskFailure
from ..knowledge import get_knowledge_loader
from ..http_client import ollama_client
from ._llm import _post_ollama_generate

logger = logging.getLogger("ai-service.executors.triage")

PROMPT_TEMPLATE_VERSION = "triage-supplement-v2"

# 默认本院科室配置（当配置文件缺失/损坏时使用）
_DEFAULT_DEPARTMENTS_CONFIG = {
    "version": "1.0.0",
    "departments": [
        {"name": "全科医学科", "alias": ["全科"]},
        {"name": "消化内科", "alias": ["消化科"]},
        {"name": "呼吸内科", "alias": ["呼吸科"]},
        {"name": "心血管内科", "alias": ["心内科", "心血管科"]},
        {"name": "骨科", "alias": []},
        {"name": "急诊科", "alias": ["急诊"]},
    ],
    "fallbackDepartment": "全科医学科",
    "fallbackReason": "症状不明确或本院暂无相关专科，建议先咨询全科医学科或人工分诊",
}

_MAX_SYMPTOMS_CHARS = 1000  # 与业务侧 TriageRequest.symptoms 上限一致


def _load_departments_config(config_path: Path) -> dict:
    """加载并校验科室白名单配置。
    
    返回：
        {
            "departments": [{"name": str, "alias": list[str]}],
            "allowed_names": set[str],  # 包含正式名称与别名的白名单集合
            "hint": str,  # AI prompt 提示字符串："全科医学科、消化内科、..."
            "fallback_dept": str,
            "fallback_reason": str,
        }
    """
    if not config_path.exists():
        logger.warning(
            "科室白名单配置文件不存在：%s，使用内置默认 6 个科室",
            config_path
        )
        config = _DEFAULT_DEPARTMENTS_CONFIG
    else:
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
        except Exception as exc:
            logger.error(
                "科室白名单配置文件加载失败：%s | 错误=%s | 使用内置默认",
                config_path, exc
            )
            config = _DEFAULT_DEPARTMENTS_CONFIG
    
    # 校验必需字段
    departments = config.get("departments", [])
    if not isinstance(departments, list) or len(departments) == 0:
        logger.warning(
            "科室白名单配置无效或为空（departments=%s），使用内置默认",
            departments
        )
        departments = _DEFAULT_DEPARTMENTS_CONFIG["departments"]
    
    # 构建白名单集合（正式名称 + 别名）
    allowed_names = set()
    dept_names = []
    hint_parts = []
    for dept in departments:
        if not isinstance(dept, dict) or "name" not in dept:
            logger.warning("跳过无效科室配置项：%s", dept)
            continue
        dept_name = dept["name"].strip()
        if not dept_name:
            continue
        allowed_names.add(dept_name)
        dept_names.append(dept_name)
        # hint 带上科室擅长方向（2026-10-24）：只给科室名时模型分不清"耳鼻喉科 vs 呼吸内科"，
        # 实测 7B 会把「嗓子疼」判成消化内科 —— 描述是给模型的判别依据，不是诊断结论。
        desc = str(dept.get("description") or "").strip()
        hint_parts.append(dept_name + ("（" + desc + "）" if desc else ""))
        # 别名映射
        for alias in dept.get("alias", []):
            alias_str = alias.strip()
            if alias_str:
                allowed_names.add(alias_str)

    if len(allowed_names) == 0:
        logger.error("科室白名单为空，使用内置默认 6 个科室")
        return _load_departments_config(Path("/nonexistent"))  # 递归触发默认

    # AI prompt 提示字符串
    hint = "、".join(hint_parts)
    
    fallback_dept = config.get("fallbackDepartment", "全科医学科")
    fallback_reason = config.get(
        "fallbackReason",
        "症状不明确或本院暂无相关专科，建议先咨询全科医学科或人工分诊"
    )
    
    logger.info(
        "科室白名单已加载 | 科室数=%d | 白名单含别名=%d | 兜底=%s",
        len(dept_names), len(allowed_names), fallback_dept
    )
    
    return {
        "departments": departments,
        "allowed_names": allowed_names,
        "hint": hint,
        "fallback_dept": fallback_dept,
        "fallback_reason": fallback_reason,
    }

_SYSTEM_PROMPT = (
    "你是医院智能导诊助手。根据用户的症状描述，给出最可能的就诊科室建议。"
    "要求：最多 3 个科室，按可能性从高到低排序；科室名称必须从候选科室里选；"
    "reason 只能引用用户原话里出现过的症状，用户没提到的症状一个字都不许编；"
    "confidence 是你对这个科室的把握（0~1）：症状部位/性质不明确、或需要鉴别的系统多时，给低分；"
    "只输出 JSON，不输出任何其他文字；不给出诊断结论，不推荐药物。"
)

# ⚠️ 2026-10-24 修正：原示例把「消化内科 / 腹痛、腹泻」写死，小模型（qwen2.5:0.5b）
# 会直接照抄示例的科室与理由（实测输入"嗓子疼三天"仍返回消化症状理由）—— 改成占位符示例，
# 并在 system 里禁止编造未提及的症状。
_USER_PROMPT = (
    "候选科室：{hint}\n"
    "用户症状描述：{symptoms}\n"
    "请只输出 JSON，格式如下（尖括号是占位符，必须换成真实内容）："
    '{{"recommendedDepartments":[{{"departmentName":"<候选科室名>",'
    '"reason":"<引用用户原话里的症状>","confidence":<0到1之间的小数>}}]}}'
)

_MAX_SYMPTOMS_CHARS = 1000  # 与业务侧 TriageRequest.symptoms 上限一致


def build_triage_executor(
    settings: Settings,
    probe,
    transport: Optional[httpx.AsyncBaseTransport] = None,
):
    """构造 TRIAGE 执行器。

    probe：CapabilityProbe（复用其带 5s 缓存的 ollama 探活，避免每次任务都打 /api/tags）。
    transport：仅测试注入（httpx.MockTransport）；生产为 None。
    """
    # 启动时加载科室白名单配置（一次性加载，避免每次请求读文件）
    departments_config = _load_departments_config(settings.triage_departments_config)
    
    # 启动时加载院内知识库（2026-10-22 知识库注入层）
    knowledge_loader = get_knowledge_loader(settings.knowledge_base_path)

    async def executor(task: dict, ctx: TaskContext) -> dict:
        text = str(task.get("inputInline") or "").strip()
        if not text:
            raise TaskFailure("INVALID_INPUT", "TRIAGE 任务需要 inputInline（症状描述文本）", retryable=False)
        if len(text) > _MAX_SYMPTOMS_CHARS:
            logger.warning("TRIAGE 输入超长，截断到 %d 字符（task=%s）", _MAX_SYMPTOMS_CHARS, task.get("taskId"))
            text = text[:_MAX_SYMPTOMS_CHARS]

        profile = str(task.get("modelProfile") or "small-default")
        model = settings.large_model if profile == "large-upgrade" else settings.small_model

        # ---- 快降级①：服务/模型就位性（探针有缓存，通常毫秒级返回）----
        tags = await probe.ollama_tags()
        if tags is None:
            raise TaskFailure(
                "CAPABILITY_UNAVAILABLE", "本机模型服务不可达（ollama）",
                dependency="ollama", retryable=True,
            )
        if model not in tags:
            raise TaskFailure(
                "CAPABILITY_UNAVAILABLE", f"模型 {model} 未安装",
                dependency="ollama", retryable=True,
            )

        options: dict = {"temperature": 0.3, "num_predict": 300}
        gen = task.get("generationParameters") or {}
        if gen.get("temperature") is not None:
            options["temperature"] = float(gen["temperature"])
        if gen.get("topP") is not None:
            options["top_p"] = float(gen["topP"])
        if gen.get("maxOutputTokens") is not None:
            options["num_predict"] = int(gen["maxOutputTokens"])

        await ctx.set_phase("generation")
        
        # 注入院内知识库（2026-10-22 知识库注入层）
        hospital_knowledge = knowledge_loader.get_knowledge("triage", budget_tokens=300)
        if hospital_knowledge:
            system_prompt = f"{_SYSTEM_PROMPT}\n\n院内知识库：\n{hospital_knowledge}"
            logger.info("TRIAGE 任务注入院内知识库 | task=%s | knowledge_version=%s", task.get("taskId"), knowledge_loader.version)
        else:
            system_prompt = _SYSTEM_PROMPT
            logger.info("TRIAGE 任务降级为通用 prompt（知识库未加载或场景缺失）| task=%s", task.get("taskId"))
        
        payload = {
            "model": model,
            "system": system_prompt,
            "prompt": _USER_PROMPT.format(hint=departments_config["hint"], symptoms=text),
            "stream": False,
            "format": "json",  # Ollama 结构化输出：强制 JSON，降低小模型跑偏概率
            "options": options,
        }

        # ---- 快降级②：生成调用（独立短超时，不占满任务总预算）----
        # 复用 httpx 单例 / transport 注入路径（2026-10-22 连接复用优化），
        # 错误映射集中在 `_post_ollama_generate`（与 chat/careplan/interpret 一致）。
        async with ollama_client(settings, transport=transport) as client:
            resp = await _post_ollama_generate(client, settings, payload, settings.triage_timeout_seconds)

        # ---- 快降级③：输出解析与结构校验（不合法即失败，绝不缝合半成品）----
        try:
            raw = resp.json()
            parsed = json.loads(raw.get("response") or "")
        except (ValueError, TypeError):
            raise TaskFailure("MODEL_OUTPUT_INVALID", "模型输出不是合法 JSON", dependency="ollama", retryable=False)

        raw_departments = _normalize_departments(parsed)
        if raw_departments is None:
            raise TaskFailure(
                "MODEL_OUTPUT_INVALID", "模型输出缺少 recommendedDepartments 结构",
                dependency="ollama", retryable=False,
            )

        # ---- 白名单过滤（2026-10-22 可配置化）：只保留白名单内科室，越界科室过滤掉 ----
        filtered_departments = []
        for dept in raw_departments:
            dept_name = dept.get("departmentName", "").strip()
            if dept_name in departments_config["allowed_names"]:
                filtered_departments.append(dept)
            else:
                # 日志脱敏：不打印原始症状文本，只记录 task ID 与越界科室名
                logger.warning(
                    "TRIAGE AI 推荐了白名单外科室，已过滤 | task=%s | invalidDept=%s",
                    task.get("taskId"), dept_name
                )

        # ---- 安全兜底：空推荐或全部过滤 → 返回兜底科室 ----
        if not filtered_departments:
            logger.info(
                "TRIAGE AI 未推荐有效科室（空或全被过滤），返回兜底 | task=%s | fallback=%s",
                task.get("taskId"), departments_config["fallback_dept"]
            )
            filtered_departments = [{
                "departmentName": departments_config["fallback_dept"],
                "reason": departments_config["fallback_reason"],
                "confidence": None
            }]

        actual_model = str(raw.get("model") or model)
        logger.info(
            "TRIAGE 补充完成 | task=%s | model=%s | raw=%d | filtered=%d",
            task.get("taskId"), actual_model, len(raw_departments), len(filtered_departments)
        )
        return {
            "result": {
                "recommendedDepartments": filtered_departments,
                "provenance": "AI_GENERATED",
                "limitations": "AI 补充建议，不构成诊断；就诊科室以院内分诊规则与医生面诊为准。",
                "promptTemplateVersion": PROMPT_TEMPLATE_VERSION,
            },
            "model": {
                "modelId": actual_model,
                "modelProfile": profile,
                "promptTemplateVersion": PROMPT_TEMPLATE_VERSION,
                "cached": False,
            },
        }

    return executor


def _normalize_departments(parsed) -> Optional[list]:
    """把模型输出规范为稳定结构；结构不符返回 None（由调用处转 MODEL_OUTPUT_INVALID）。

    容忍项：条目非 dict / 无科室名 → 丢弃该条；confidence 越界 → 丢弃该字段（不猜测）。
    上限 3 条**作用于有效条目**（与提示词约束一致，防模型多给）。
    """
    if not isinstance(parsed, dict):
        return None
    raw_list = parsed.get("recommendedDepartments")
    if not isinstance(raw_list, list):
        return None
    out: list = []
    for item in raw_list:
        if len(out) >= 3:
            break
        if not isinstance(item, dict):
            continue
        name = str(item.get("departmentName") or "").strip()
        if not name:
            continue
        entry: dict = {"departmentName": name[:40]}
        reason = str(item.get("reason") or "").strip()
        if reason:
            entry["reason"] = reason[:200]
        conf = item.get("confidence")
        if isinstance(conf, (int, float)) and not isinstance(conf, bool) and 0 <= conf <= 1:
            entry["confidence"] = round(float(conf), 3)
        out.append(entry)
    return out
