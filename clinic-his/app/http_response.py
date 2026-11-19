"""验证响应：用于返回 HTML / PDF 等非 JSON 内容。"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RawResponse:
    payload: bytes
    content_type: str
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
