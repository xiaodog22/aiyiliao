"""生成类 provider 包（B2 三步走降级链）。

链路：Ollama（本地内网穿透）→ DeepSeek（OpenAI 兼容 API）→ 兜底（business 规则引擎）。
收口点：所有生成调用最终都经过 `chain.generate`，`triage` 不再绕过链直调底层原语。

红线：本包只报 provider 状态与错误码，**不回显** URL / API key / 磁盘路径。
"""

from .chain import ChainResult, current_provider, generate, has_fallback, provider_order

__all__ = ["ChainResult", "current_provider", "generate", "has_fallback", "provider_order"]
