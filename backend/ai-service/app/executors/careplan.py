"""CARE_PLAN 执行器：照护建议生成（M2 · D2.1）。

输入（任务字段）：
- `inputInline`：业务侧拼好的目标 + 约束文本
  （形如「目标：改善睡眠；约束：高血压。……证据不足时结构化拒答。」）；
- `locale`：语言标记（zh-CN 等），仅用于提示词，不参与结果语言断言。

输出（result；契约 TaskResult additionalProperties:true 允许扩展）：
    {
      "suggestions": [{"title": "...", "detail": "...", "provenance": "AI_GENERATED"}],
      "days": [{"label": "第 1 天", "diet": "...", "exercise": "...", "sleep": "..."}],
      "limitations": "……不构成处方、治疗方案或用药指导。",
      "refused": false,
      "refusalReason": null,
      "provenance": "AI_GENERATED"
    }

红线：
- 严格生活方式与膳食参考，**不构成处方**（limitations 恒含该声明）；
- 证据不足或超出范围 → 结构化拒答（refused=true + refusalReason），**不用空数组冒充「没有建议」**；
- days 为按天结构（2026-10-21 增补，业务侧养生页消费）：模型未给/给脏数据时归一为空数组，
  业务侧回落 suggestions 渲染，**不编造按天内容**；
- 快降级：INVALID_INPUT / CAPABILITY_UNAVAILABLE / MODEL_TIMEOUT / MODEL_OUTPUT_INVALID。
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx

from ..config import Settings
from ..knowledge import get_knowledge_loader
from ..tasks import TaskContext, TaskFailure
from ._llm import (
    PROVENANCE_AI,
    build_options,
    ensure_model_ready,
    generate_text,
    parse_json_strict,
    require_input_text,
    resolve_model,
    trim,
)

logger = logging.getLogger("ai-service.executors.careplan")

PROMPT_TEMPLATE_VERSION = "care-plan-v2"

# 业务侧按 containsString("不构成处方") 做红线断言，此文案为契约外事实约定，改动需与 M 侧同步。
LIMITATIONS = "以上为生活方式与膳食参考，不构成处方、治疗方案或用药指导；出现不适请及时就医。"

_SYSTEM_PROMPT = (
    "你是社区医院健康管理助手，为居民给出生活方式与膳食方面的参考建议。要求："
    "1）只给生活方式、作息、膳食等非药物建议，不推荐任何药物、剂量或治疗方案；"
    "2）建议要具体、可执行，适合长期坚持；"
    "3）若目标涉及诊断、用药调整、急症处置，或缺少必要信息无法给出针对性建议，则拒答；"
    "4）只输出 JSON，不输出任何其他文字。"
)

_USER_PROMPT = (
    "用户需求：{goal}\n"
    "请只输出 JSON，格式："
    '{{"suggestions":[{{"title":"标题","detail":"具体做法"}}],'
    '"days":[{{"label":"第 1 天","diet":"当日膳食建议","exercise":"当日运动建议","sleep":"当日作息建议"}}],'
    '"refused":false,"refusalReason":null}}'
    "（suggestions 最多 5 条；days 给 3 天，每天从 diet/exercise/sleep 三个维度各给一条具体安排；"
    "拒答时 refused=true、suggestions 与 days 给空数组，并在 refusalReason 写明原因）"
)

_MAX_SUGGESTIONS = 5
_MAX_DAYS = 3


def build_careplan_executor(
    settings: Settings,
    probe,
    transport: Optional[httpx.AsyncBaseTransport] = None,
):
    """构造 CARE_PLAN 执行器。transport 仅测试注入（httpx.MockTransport），生产为 None。"""
    
    # 启动时加载知识库
    knowledge_loader = get_knowledge_loader(settings.knowledge_base_path)

    async def executor(task: dict, ctx: TaskContext) -> dict:
        goal = require_input_text(task)
        profile = str(task.get("modelProfile") or "small-default")
        model = resolve_model(settings, profile)

        await ensure_model_ready(probe, model)

        # 加载院内知识库（careplan 场景，预算 300 tokens）
        hospital_knowledge = knowledge_loader.get_knowledge("careplan", budget_tokens=300)
        if hospital_knowledge:
            system_prompt = f"{_SYSTEM_PROMPT}\n\n院内知识库：\n{hospital_knowledge}"
            logger.info(
                "CAREPLAN knowledge injected | task=%s | version=%s",
                task.get("taskId", "unknown"),
                knowledge_loader.version or "unknown"
            )
        else:
            system_prompt = _SYSTEM_PROMPT
            logger.info(
                "CAREPLAN knowledge unavailable, using default prompt | task=%s",
                task.get("taskId", "unknown")
            )

        options = build_options(task, temperature=0.5, num_predict=700)
        await ctx.set_phase("generation")
        response_text, actual_model = await generate_text(
            settings, model, system_prompt,
            _USER_PROMPT.format(goal=goal),
            options, settings.careplan_timeout_seconds,
            transport=transport, json_mode=True,
        )

        payload = parse_json_strict(response_text)
        if not isinstance(payload, dict):
            raise TaskFailure("MODEL_OUTPUT_INVALID", "模型输出缺少照护建议结构",
                              dependency="ollama", retryable=False)

        refused = bool(payload.get("refused")) if isinstance(payload.get("refused"), bool) else False
        suggestions = _normalize_suggestions(payload.get("suggestions"))
        days = _normalize_days(payload.get("days"))

        refusal_reason = trim(payload.get("refusalReason"), 200)
        if refused:
            if refusal_reason is None:
                refusal_reason = "当前证据不足，暂无法给出针对性建议"
        elif not suggestions:
            # 非拒答但无建议：视为证据不足，按拒答收口（不用空数组冒充"没有建议"）
            refused = True
            refusal_reason = refusal_reason or "当前证据不足，暂无法给出针对性建议"

        logger.info("CARE_PLAN 完成 task=%s model=%s refused=%s n=%d days=%d",
                    task.get("taskId"), actual_model, refused, len(suggestions), len(days))

        return {
            "result": {
                "suggestions": suggestions if not refused else [],
                "days": days if not refused else [],
                "limitations": LIMITATIONS,
                "refused": refused,
                "refusalReason": refusal_reason,
                "provenance": PROVENANCE_AI,
            },
            "model": {
                "modelId": actual_model,
                "modelProfile": profile,
                "promptTemplateVersion": PROMPT_TEMPLATE_VERSION,
                "cached": False,
            },
        }

    return executor


def _normalize_suggestions(raw) -> list:
    """规范建议条目：容忍脏数据（非 dict / 无标题 → 丢弃该条），上限 5 条。"""
    if not isinstance(raw, list):
        return []
    out: list = []
    for item in raw:
        if len(out) >= _MAX_SUGGESTIONS:
            break
        if not isinstance(item, dict):
            continue
        title = trim(item.get("title"), 40)
        detail = trim(item.get("detail"), 300)
        if title is None and detail is None:
            continue
        out.append({
            "title": title or detail[:40],
            "detail": detail or title,
            "provenance": PROVENANCE_AI,
        })
    return out


def _normalize_days(raw) -> list:
    """规范按天结构（2026-10-21）：容忍脏数据，上限 3 天。

    - 非 list / 非 dict 条目 → 丢弃；
    - diet/exercise/sleep 三条全空 → 丢弃（不凑数）；
    - label 缺失按序号补「第 N 天」；
    - 拒答由调用方收口（days 给空数组），此处不做拒答判定。
    """
    if not isinstance(raw, list):
        return []
    out: list = []
    for item in raw:
        if len(out) >= _MAX_DAYS:
            break
        if not isinstance(item, dict):
            continue
        diet = trim(item.get("diet"), 300)
        exercise = trim(item.get("exercise"), 300)
        sleep = trim(item.get("sleep"), 300)
        if diet is None and exercise is None and sleep is None:
            continue
        label = trim(item.get("label"), 20)
        out.append({
            "label": label or f"第 {len(out) + 1} 天",
            "diet": diet,
            "exercise": exercise,
            "sleep": sleep,
        })
    return out
