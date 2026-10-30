"""日志脱敏（M4 · D4.2 安全抽查）——确保网关日志不落「原文 / 凭据」。

与 ai-service 同名模块同构（两服务独立部署，保持物理隔离，故各自持有一份）。

- `Bearer <token>` / `Token: <k>` / `secret|password|authorization|serviceToken|Idempotency-Key` 的值 → `***`
- 中国大陆手机号 → `138****8000`
- 18 位身份证 → `110101********1234`
- 邮箱 → 首字符 + `***`

接入：`install_redaction()` 在根 logger 的 handler 上挂全局 Filter（幂等）。
"""

from __future__ import annotations

import logging
import re

MASK = "***"

_BEARER = re.compile(r"(?i)\b(bearer)\s+([A-Za-z0-9._\-]{8,})")
_TOKEN_KV = re.compile(
    r"(?i)\b(token|secret|password|passwd|authorization|service[_-]?token|"
    r"idempotency[-_]key|refresh[_-]?token|access[_-]?token)\b(\s*[:=]\s*)(?!bearer\b)([^\s,;\"'}\]]+)"
)
_PHONE = re.compile(r"(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)")
_IDCARD = re.compile(r"(?<!\d)(\d{6})(\d{8})(\d{4})(?!\d)")
_EMAIL = re.compile(r"\b([A-Za-z0-9._%+\-])([A-Za-z0-9._%+\-]{0,63})@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})")


def redact(text: str) -> str:
    """对单条日志文本做掩码；非字符串原样返回。"""
    if not isinstance(text, str) or not text:
        return text
    out = _BEARER.sub(lambda m: m.group(1) + " " + MASK, text)
    out = _TOKEN_KV.sub(lambda m: m.group(1) + m.group(2) + MASK, out)
    out = _PHONE.sub(lambda m: m.group(1) + "****" + m.group(3), out)
    out = _IDCARD.sub(lambda m: m.group(1) + "********" + m.group(3), out)
    out = _EMAIL.sub(lambda m: m.group(1) + MASK + "@" + m.group(3), out)
    return out


class RedactingFilter(logging.Filter):
    """把 `LogRecord` 的最终消息（格式化后）替换为脱敏版本。"""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        try:
            msg = record.getMessage()
        except Exception:
            return True
        red = redact(msg)
        if red != msg:
            record.msg = red
            record.args = ()
        return True


def install_redaction(logger: logging.Logger | None = None) -> None:
    """在根 logger（或指定 logger）的每个 handler 上挂脱敏过滤器（幂等）。"""
    target = logger or logging.getLogger()
    filt = RedactingFilter()
    handlers = target.handlers or []
    if not handlers:
        handlers = [logging.getLogger().lastResort] if logging.getLogger().lastResort else []
    for h in handlers:
        if h is None:
            continue
        if not any(isinstance(f, RedactingFilter) for f in h.filters):
            h.addFilter(filt)
