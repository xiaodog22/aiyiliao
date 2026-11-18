"""日志脱敏（M4 · D4.2 安全抽查）——确保日志不落「原文 / 凭据」。

定位：**保守掩码**，只处理明确的敏感项，不改动普通诊断字段
（`taskId` / `model` / 计数 / 异常类名等保持原样，便于排障）。

接入：`install_redaction()` 在 logging 根 logger 的 handler 上挂全局 `Filter`，
对所有 `LogRecord` 的**最终消息**（含 args 格式化结果）做掩码 —— 幂等、无副作用。

规则：
- `Bearer <token>` / `Token: <k>` / `secret|password|authorization|serviceToken|Idempotency-Key` 的值 → `***`
- 中国大陆手机号（允许 `-`/空格分隔、零宽字符干扰）→ `138****8000`
- 18 位身份证（末位可为 X）→ `110101********1234`
- 邮箱 → 本地部分保留首字符 + `***`
- 姓名字段（`name` / `patient_name` / `姓名`）→ `***`

2026-11-18（审计 M1）修正四处可绕过点：
1. 分隔符绕过：`138-0013-8000` / `138 0013 8000` 因"连续 \\d"要求而不命中 —— 改为允许分隔符；
2. 零宽字符（U+200B 等）破坏连续性 —— 匹配前统一剥离；
3. 身份证末位 `X` 不命中 —— 尾段改 `\\d{3}[\\dXx]`；
4. `exc_info` 堆栈不脱敏 —— filter 里先格式化堆栈再脱敏，随后清空 `exc_info` 防重复输出。

**不覆盖**：业务侧把原文拼进异常消息的情况仍须自行约束（本模块只兜底日志通道）。
另提供 `deep_sanitize()` 供**出境前**（第三方 provider）使用：同一套规则，但更保守。
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
# 手机号：允许 - / 空格 / 点 分隔（审计 M1）
_PHONE = re.compile(r"(?<!\d)(1[3-9]\d)[\s\-‐-―.]?(\d{4})[\s\-‐-―.]?(\d{4})(?!\d)")
# 身份证：末位可为 X/x（审计 M1）
_IDCARD = re.compile(r"(?<!\d)(\d{6})(\d{8})(\d{3}[\dXx])(?![0-9Xx])")
_EMAIL = re.compile(r"\b([A-Za-z0-9._%+\-])([A-Za-z0-9._%+\-]{0,63})@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})")
# 姓名字段（审计 M1）：键名匹配后掩码值，避免"张建国"这类明文进日志
_NAME_KV = re.compile(
    r"(?i)(?<![\w])(patient[_-]?name|patientName|real[_-]?name|真实姓名|患者姓名|姓名)"
    r"(\s*[:=]\s*)(?!\*)([^\s,;\"'}\]]+)"
)

# 零宽/方向控制字符：先剥离，否则 `138\u200b0013\u200b8000` 不命中
_ZERO_WIDTH = re.compile(r"[\u200b-\u200f\u202a-\u202e\ufeff]")


def _strip_zero_width(text: str) -> str:
    return _ZERO_WIDTH.sub("", text)


def redact(text: str) -> str:
    """对单条日志文本做掩码；非字符串原样返回。"""
    if not isinstance(text, str) or not text:
        return text
    out = _strip_zero_width(text)
    out = _BEARER.sub(lambda m: m.group(1) + " " + MASK, out)
    out = _TOKEN_KV.sub(lambda m: m.group(1) + m.group(2) + MASK, out)
    out = _NAME_KV.sub(lambda m: m.group(1) + m.group(2) + MASK, out)
    out = _PHONE.sub(lambda m: m.group(1) + "****" + m.group(3), out)
    out = _IDCARD.sub(lambda m: m.group(1) + "********" + m.group(3), out)
    out = _EMAIL.sub(lambda m: m.group(1) + MASK + "@" + m.group(3), out)
    return out


def deep_sanitize(text: str) -> str:
    """出境前脱敏（审计 H10）：比日志脱敏更保守。

    第三方 provider（DeepSeek / edge-tts 等）会拿到完整 prompt 文本，
    其中的手机号、身份证、邮箱、以及显式姓名标签一律替换为占位符。
    这里只做"可机器判定"的替换，不做语义改写（改写会破坏诊疗语境）。
    """
    if not isinstance(text, str) or not text:
        return text
    out = _strip_zero_width(text)
    out = _PHONE.sub(lambda m: m.group(1) + "****" + m.group(3), out)
    out = _IDCARD.sub(lambda m: m.group(1) + "********" + m.group(3), out)
    out = _EMAIL.sub(lambda m: m.group(1) + MASK + "@" + m.group(3), out)
    out = _NAME_KV.sub(lambda m: m.group(1) + m.group(2) + MASK, out)
    out = _BEARER.sub(lambda m: m.group(1) + " " + MASK, out)
    out = _TOKEN_KV.sub(lambda m: m.group(1) + m.group(2) + MASK, out)
    return out


class RedactingFilter(logging.Filter):
    """把 `LogRecord` 的最终消息（格式化后）替换为脱敏版本。"""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        try:
            msg = record.getMessage()
        except Exception:  # 格式化异常不应阻断日志
            return True
        red = redact(msg)
        if red != msg:
            record.msg = red
            record.args = ()
        # 堆栈同样要脱敏（审计 M1）：异常消息里可能带用户原文/手机号。
        # 先固化为文本并脱敏，再清 exc_info，避免 handler 二次格式化时覆盖回原文。
        if record.exc_info:
            try:
                if not record.exc_text:
                    record.exc_text = logging.Formatter().formatException(record.exc_info)
                record.exc_text = redact(record.exc_text)
                record.exc_info = None
            except Exception:  # 堆栈格式化失败不影响日志本身
                pass
        return True


def install_redaction(logger: logging.Logger | None = None) -> None:
    """在根 logger（或指定 logger）的每个 handler 上挂脱敏过滤器（幂等）。"""
    target = logger or logging.getLogger()
    filt = RedactingFilter()
    handlers = target.handlers or []
    if not handlers:
        # basicConfig 未生效时，挂到 lastResort，保证至少一条通道。
        handlers = [logging.getLogger().lastResort] if logging.getLogger().lastResort else []
    for h in handlers:
        if h is None:
            continue
        if not any(isinstance(f, RedactingFilter) for f in h.filters):
            h.addFilter(filt)
