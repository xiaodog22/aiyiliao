"""CHAT 执行器：AI 问诊对话生成（M2 · D2.1）。

输入（任务字段）：
- `inputInline`：**业务侧拼好的本轮输入文本**（当前 business-service 传单条用户消息）；
- `requestedProfile`：small-default / large-upgrade（资源档，不是模型名）；
- `generationParameters`：temperature / topP / maxOutputTokens（提交侧已白名单过滤）。

输出（result，形状对齐 ai-openapi TaskResult + additionalProperties:true）：
    {
      "text": "<回复正文>",
      "citations": [],                 # 本轮无检索链路：如实给空数组，**不编造来源**
      "provenance": "AI_GENERATED",
      "refused": false,                # 结构化拒答（超范围/要求诊断处方）时为 true
      "refusalReason": null,
      "language": "zh-CN" | null,      # 模型真实给出的语言；不给则 null（不猜测）
      "hasTimestamps": false
    }

红线：
- 不输出诊断结论、不推荐药物/剂量；急症提示由业务侧本地红旗规则先行（本执行器不替代）；
- 失败快降级：INVALID_INPUT / CAPABILITY_UNAVAILABLE / MODEL_TIMEOUT / MODEL_OUTPUT_INVALID；
- **不 200 + 空对象**、不缝合半成品。
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx

from ..config import Settings
from ..tasks import TaskContext, TaskFailure
from ..knowledge import get_knowledge_loader
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

logger = logging.getLogger("ai-service.executors.chat")

PROMPT_TEMPLATE_VERSION = "consultation-chat-v5"

# ⚠️ 2026-10-24 重写：原 prompt 是「健康咨询助手」——实测会直接给科室结论（还常常是错的），
#    与「先收集信息、信息够了再由 TRIAGE 出科室」的产品链路冲突。
#    v2 长段规则 7B 仍会写「建议您去耳鼻喉科」；v3 单一任务+显式禁词可用，但会**复读上一轮的问句**
#    （实测第二轮又问了一遍"有没有发热"）；v4 补「不得重复已问过的问题」并给出换角度提示。
_SYSTEM_PROMPT = (
    "你在做医院导诊前的问诊信息收集。规则："
    "① 你这一轮只输出**一个问句**，问患者还没说清的一个关键细节"
    "（起病多久、具体部位、什么感觉、有没有发热/呕吐等伴随症状、吃过什么药、有没有加重因素）；"
    "② 严禁出现任何科室名称、疾病名称、药品名称；严禁出现「建议您去」「可能是」「考虑」「挂号」等字样；"
    "③ 不要复述患者说过的话，不要总结；"
    "④ **不要重复你前面已经问过的问题**：先看对话里「医生助手：」说过什么，换一个还没问的角度；"
    "⑤ 若出现急症信号（持续胸痛、呼吸困难、意识改变、大出血），改为提示立即拨打 120；"
    "⑥ 只输出 JSON，不输出任何其他文字。"
)

_USER_PROMPT = (
    "以下是本次问诊的对话记录（「你：」是你自己在前面轮次说过的话，"
    "不要重复其中的问题）：\n{message}\n"
    "请只输出 JSON，格式："
    '{{"text":"一个问句","language":"zh-CN","refused":false,"refusalReason":null}}'
    "（拒答时 refused=true，并在 refusalReason 写明原因，text 给出简短的转介说明）"
)

_MAX_TEXT_CHARS = 400


def build_chat_executor(
    settings: Settings,
    probe,
    transport: Optional[httpx.AsyncBaseTransport] = None,
):
    """构造 CHAT 执行器。transport 仅测试注入（httpx.MockTransport），生产为 None。"""

    # 启动时加载院内知识库（2026-10-22 知识库注入层）
    knowledge_loader = get_knowledge_loader(settings.knowledge_base_path)

    # RAG 执行器在顶层只构造一次（2026-10-22 性能优化：避免每次请求新建闭包）
    # 开关关时造空闭包占位，运行时仍会走 settings.rag_enabled 快速失败路径
    from .rag import build_rag_executor as _build_rag
    rag_executor = _build_rag(settings, probe, transport=transport)

    # 模拟 TaskContext（RAG 执行器需要 set_phase，但 CHAT 内部调用不关心阶段）
    class _SimpleContext:
        async def set_phase(self, phase: str):
            pass
    _simple_ctx = _SimpleContext()

    # ---- RAG 检索助手（特征开关控制）----
    async def _retrieve_context(query: str, task_id: str) -> tuple[list[dict], str]:
        """调用 RAG 检索，返回 (citations, context_text)。

        失败时返回空 citations 和空 context（不抛异常，降级为无检索模式）。
        """
        if not settings.rag_enabled:
            return [], ""

        try:
            rag_task = {"taskId": task_id, "inputInline": query}
            rag_result = await rag_executor(rag_task, _simple_ctx)
            
            documents = rag_result.get("result", {}).get("documents", [])
            if not documents:
                logger.info("RAG 检索无结果 | task=%s", task_id)
                return [], ""
            
            # 构造 citations
            citations = []
            context_parts = []
            for idx, doc in enumerate(documents, 1):
                citations.append({
                    "index": idx,
                    "documentId": doc["documentId"],
                    "chunkId": doc.get("chunkId"),
                    "title": doc.get("metadata", {}).get("title"),
                    "source": doc.get("metadata", {}).get("source"),
                    "score": doc.get("score"),
                })
                # 拼接检索上下文（注入 prompt）
                context_parts.append(f"[文档{idx}] {doc['content']}")
            
            context_text = "\n\n".join(context_parts)
            logger.info("RAG 检索成功 | task=%s | results=%d", task_id, len(citations))
            return citations, context_text
        
        except Exception as exc:
            # 降级为空结果（不阻断回答）
            logger.warning("RAG 检索异常，降级为无检索模式 | task=%s | error=%s", task_id, exc.__class__.__name__)
            return [], ""

    async def executor(task: dict, ctx: TaskContext) -> dict:
        message = require_input_text(task)
        profile = str(task.get("modelProfile") or "small-default")
        model = resolve_model(settings, profile)

        await ensure_model_ready(probe, model)

        # ---- RAG 检索（特征开关控制）----
        citations, rag_context = await _retrieve_context(message, task.get("taskId"))
        
        # ---- 注入院内知识库（2026-10-22 知识库注入层）----
        hospital_knowledge = knowledge_loader.get_knowledge("chat", budget_tokens=400)
        if hospital_knowledge:
            system_prompt = f"{_SYSTEM_PROMPT}\n\n院内知识库：\n{hospital_knowledge}"
            logger.info("CHAT 任务注入院内知识库 | task=%s | knowledge_version=%s", task.get("taskId"), knowledge_loader.version)
        else:
            system_prompt = _SYSTEM_PROMPT
            logger.info("CHAT 任务降级为通用 prompt（知识库未加载或场景缺失）| task=%s", task.get("taskId"))
        
        # ---- 构造 prompt（注入检索上下文）----
        if rag_context:
            user_prompt = (
                f"参考以下院内知识库内容：\n{rag_context}\n\n"
                "以下是本次问诊的对话记录（「你：」是你自己在前面轮次说过的话，不要重复其中的问题）：\n"
                f"{message}\n"
                "请只输出 JSON，格式："
                '{"text":"一个问句","language":"zh-CN","refused":false,"refusalReason":null}'
                "（拒答时 refused=true，并在 refusalReason 写明原因，text 给出简短的转介说明）"
            )
        else:
            user_prompt = _USER_PROMPT.format(message=message)

        # num_predict 512 → 160（2026-10-24）：导诊追问只要一句问句，
        # 512 tokens 在 CPU 上意味着多等 20~30s，对每轮都等的对话是纯浪费。
        options = build_options(task, temperature=0.3, num_predict=160)
        await ctx.set_phase("generation")
        response_text, actual_model = await generate_text(
            settings, model, system_prompt,
            user_prompt,
            options, settings.chat_timeout_seconds,
            transport=transport, json_mode=True,
        )

        payload = parse_json_strict(response_text)
        if not isinstance(payload, dict):
            raise TaskFailure("MODEL_OUTPUT_INVALID", "模型输出缺少对话对象结构",
                              dependency="ollama", retryable=False)

        # 拒答与正文二选一：拒答必须给原因，非拒答必须有正文（否则视为输出非法）
        refused = bool(payload.get("refused")) if isinstance(payload.get("refused"), bool) else False
        text = trim(payload.get("text"), 8000)
        refusal_reason = trim(payload.get("refusalReason"), 200)

        if refused and refusal_reason is None:
            refusal_reason = "该问题超出健康咨询范围，建议线下就医咨询"
        if text is None:
            if refused:
                text = refusal_reason
            else:
                raise TaskFailure("MODEL_OUTPUT_INVALID", "模型输出缺少回复正文",
                                  dependency="ollama", retryable=False)

        language = trim(payload.get("language"), 20)
        logger.info("CHAT 完成 task=%s model=%s refused=%s chars=%d citations=%d",
                    task.get("taskId"), actual_model, refused, len(text), len(citations))

        return {
            "result": {
                "text": text,
                "citations": citations,  # RAG 开关开启时为真实引用，关闭时为空数组
                "provenance": PROVENANCE_AI,
                "refused": refused,
                "refusalReason": refusal_reason,
                "language": language,
                "hasTimestamps": False,
            },
            "model": {
                "modelId": actual_model,
                "modelProfile": profile,
                "promptTemplateVersion": PROMPT_TEMPLATE_VERSION,
                "cached": False,
            },
        }

    return executor
