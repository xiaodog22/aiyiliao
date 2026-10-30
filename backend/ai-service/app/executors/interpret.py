"""INTERPRET 执行器：健康档案（检验/检查报告）通俗解读（2026-10-22 新增）。

背景：此前 `PatientService.interpret` 是**规则式模板拼装**（本地拼接档案字段，注释自述
"MVP，待 AI 模型接入"），既不是 AI，也违反"不得用模板冒充 AI 结果"的降级红线。
本执行器把该端点接入真实 Ollama（qwen2.5 档位），由业务侧编排为同步等待。

输入（任务字段）：
- `inputInline`：业务侧拼好的档案要点（标题 / 类别 / 摘要 / 来源 / 出具医师 / 异常标记 /
  解读范围）。**不含**姓名、手机号、证件号、病历号（这些字段必须走 inputRef，见 ai-openapi）；
- `modelProfile`：small-default / large-upgrade（资源档，不是模型名）。

输出（result；契约 TaskResult additionalProperties:true 允许扩展）：
    {
      "summary": "一句话通俗结论（≤300 字，不含确定性诊断措辞）",
      "sections": [{"title": "指标含义", "body": "……", "abnormal": false}],
      "refused": false,
      "refusalReason": null,
      "provenance": "AI_GENERATED",
      "language": "zh-CN" | null
    }

红线：
- 只做**通俗解释**：不给确诊结论、不给药物名称/剂量/处方、不预测病程；
- 模型拒答（要求诊断、开药、超出报告解读范围）→ refused=true + refusalReason，
  sections 恒空数组（不把"拒答"包装成"暂无可解读内容"）；
- 输出非法 JSON / 缺 summary → MODEL_OUTPUT_INVALID 快降级，不缝合半成品；
- 免责声明（disclaimer）由业务侧固定下发，本执行器不生成、不覆盖。
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

logger = logging.getLogger("ai-service.executors.interpret")

PROMPT_TEMPLATE_VERSION = "health-record-interpret-v1"

_SYSTEM_PROMPT = (
    "你是社区医院的健康档案解读助手，服务对象多为老人。要求："
    "1）把检验/检查报告里的术语翻译成通俗、平实的日常语言，说明这类指标大致反映什么；"
    "2）不给出确诊结论，不推荐任何药物名称、剂量或处方，不预测病程与预后；"
    "3）只依据给出的报告摘要解释，报告没写的指标不要臆造，缺信息就说明「报告未提供」；"
    "4）若被要求诊断疾病、开药或调整用药，则拒答；"
    "5）只输出 JSON，不输出任何其他文字。"
)

_USER_PROMPT = (
    "报告要点：{record}\n"
    "解读范围：{scope}（SUMMARY=只说重点；DETAIL=按指标分节说明）\n"
    "请只输出 JSON，格式："
    '{{"summary":"一句话通俗结论",'
    '"sections":[{{"title":"分节标题","body":"通俗解释","abnormal":true}}],'
    '"refused":false,"refusalReason":null,"language":"zh-CN"}}'
    "（sections 最多 5 节，每节 body ≤ 300 字；abnormal 表示该节是否指向报告标注的异常项，"
    "无法判断给 null；拒答时 refused=true、sections 给空数组，并在 refusalReason 写明原因）"
)

_MAX_SECTIONS = 5


def build_interpret_executor(
    settings: Settings,
    probe,
    transport: Optional[httpx.AsyncBaseTransport] = None,
):
    """构造 INTERPRET 执行器。transport 仅测试注入（httpx.MockTransport），生产为 None。"""
    
    # 启动时加载知识库
    knowledge_loader = get_knowledge_loader(settings.knowledge_base_path)

    async def executor(task: dict, ctx: TaskContext) -> dict:
        record = require_input_text(task)
        scope = _resolve_scope(task)
        profile = str(task.get("modelProfile") or "small-default")
        model = resolve_model(settings, profile)

        await ensure_model_ready(probe, model)

        # 加载院内知识库（interpret 场景，预算 400 tokens）
        hospital_knowledge = knowledge_loader.get_knowledge("interpret", budget_tokens=400)
        if hospital_knowledge:
            system_prompt = f"{_SYSTEM_PROMPT}\n\n院内知识库：\n{hospital_knowledge}"
            logger.info(
                "INTERPRET knowledge injected | task=%s | version=%s",
                task.get("taskId", "unknown"),
                knowledge_loader.version or "unknown"
            )
        else:
            system_prompt = _SYSTEM_PROMPT
            logger.info(
                "INTERPRET knowledge unavailable, using default prompt | task=%s",
                task.get("taskId", "unknown")
            )

        options = build_options(task, temperature=0.3, num_predict=800)
        await ctx.set_phase("generation")
        response_text, actual_model = await generate_text(
            settings, model, system_prompt,
            _USER_PROMPT.format(record=record, scope=scope),
            options, settings.interpret_timeout_seconds,
            transport=transport, json_mode=True,
        )

        payload = parse_json_strict(response_text)
        if not isinstance(payload, dict):
            raise TaskFailure("MODEL_OUTPUT_INVALID", "模型输出缺少解读结构",
                              dependency="ollama", retryable=False)

        refused = bool(payload.get("refused")) if isinstance(payload.get("refused"), bool) else False
        summary = trim(payload.get("summary"), 300)
        sections = _normalize_sections(payload.get("sections"))
        refusal_reason = trim(payload.get("refusalReason"), 200)
        language = trim(payload.get("language"), 20)

        if refused:
            if refusal_reason is None:
                refusal_reason = "该问题超出报告解读范围，建议咨询出具报告的医师"
        elif summary is None:
            # 非拒答但连一句话结论都没有 → 视为输出无效（不用占位文案兜底）
            raise TaskFailure("MODEL_OUTPUT_INVALID", "模型未给出解读结论",
                              dependency="ollama", retryable=False)

        logger.info("INTERPRET 完成 task=%s model=%s refused=%s n=%d",
                    task.get("taskId"), actual_model, refused, len(sections))

        return {
            "result": {
                "summary": None if refused else summary,
                "sections": [] if refused else sections,
                "refused": refused,
                "refusalReason": refusal_reason,
                "language": language,
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


def _resolve_scope(task: dict) -> str:
    """解读范围从输入文本里的标记推断，默认 SUMMARY（不猜 DETAIL）。"""
    text = str(task.get("inputInline") or "")
    if "解读范围：DETAIL" in text:
        return "DETAIL"
    return "SUMMARY"


def _normalize_sections(raw) -> list:
    """规范分节：容忍脏数据（非 dict / 标题与正文全空 → 丢弃），上限 5 节。"""
    if not isinstance(raw, list):
        return []
    out: list = []
    for item in raw:
        if len(out) >= _MAX_SECTIONS:
            break
        if not isinstance(item, dict):
            continue
        title = trim(item.get("title"), 60)
        body = trim(item.get("body"), 1000)
        if title is None and body is None:
            continue
        abnormal = item.get("abnormal")
        out.append({
            "title": title or (body[:18] if body else "解读"),
            "body": body or "",
            "abnormal": abnormal if isinstance(abnormal, bool) else None,
        })
    return out
