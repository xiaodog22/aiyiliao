"""M4 · D4.2 安全抽查（ai-service）——输入长度/编码/注入前置 + 日志脱敏。

覆盖 08A §D4.2：
- 输入长度前置（TRIAGE ≤1000 截断；超长不消耗模型）
- 编码健壮性（控制字符 / 非 BMP / 混合编码不崩溃）
- 注入串按数据对待（不执行、不崩溃）
- 日志脱敏（原文/凭据不入日志）——`redact` 单元 + `RedactingFilter` 端到端

纯单元测试，不起服务、不依赖网络。
"""

from __future__ import annotations

import logging

import pytest

from app.redact import MASK, RedactingFilter, install_redaction, redact


# --------------------------------------------------------------------------- 脱敏映射

def test_redact_bearer():
    assert redact("Authorization: Bearer at-1234567890abcdef") == "Authorization: Bearer " + MASK


def test_redact_token_kv():
    assert redact("token=super-secret-value") == "token=" + MASK
    assert redact("password: hunter2xyz") == "password: " + MASK
    assert redact("Idempotency-Key=abc123def456") == "Idempotency-Key=" + MASK
    assert redact("serviceToken: st-abcdefghij") == "serviceToken: " + MASK


def test_redact_phone_idcard_email():
    assert redact("患者电话 13812345678 已登记") == "患者电话 138****5678 已登记"
    assert redact("身份证 110101199003071234") == "身份证 110101********1234"
    assert redact("联系 zhang.san@example.com") == "联系 z***@example.com"


def test_redact_keeps_diagnostics():
    # 诊断字段（taskId / model / 计数 / 异常类名）不得被改写
    line = "TRIAGE 补充完成 task=t-abc123 model=qwen2.5:0.5b depts=2"
    assert redact(line) == line
    line2 = "上游超时 POST /api/v1/triage (ConnectTimeout)"
    assert redact(line2) == line2


def test_redact_idempotent_and_non_string():
    once = redact("token=abcd1234")
    assert redact(once) == once  # 幂等
    assert redact("") == ""
    assert redact(None) is None  # type: ignore[arg-type]


# --------------------------------------------------------------------------- 过滤器

def test_filter_scrubs_formatted_message():
    rec = logging.LogRecord(
        name="t", level=logging.INFO, pathname=__file__, lineno=1,
        msg="链接 token=%s 与手机 %s", args=("secret-token-xyz", "13812345678"), exc_info=None,
    )
    RedactingFilter().filter(rec)
    out = rec.getMessage()
    assert "secret-token-xyz" not in out
    assert "13812345678" not in out
    assert MASK in out and "138****5678" in out


def test_install_redaction_is_idempotent():
    root = logging.getLogger("spotcheck-idem")
    h = logging.StreamHandler()
    root.addHandler(h)
    try:
        install_redaction(root)
        install_redaction(root)
        count = sum(1 for f in h.filters if isinstance(f, RedactingFilter))
        assert count == 1
    finally:
        root.removeHandler(h)


# --------------------------------------------------------------------------- 编码 / 注入

@pytest.mark.parametrize(
    "payload",
    [
        "\x00\x01\x02 控制字符 \x7f",
        "emoji 🙂🚀 与代理对 𝄞",
        "路径遍历 ../../etc/passwd",
        "SQL '; DROP TABLE users; --",
        "命令注入 $(rm -rf /) `whoami` | cat /etc/shadow",
        "<script>alert(1)</script>",
        "a" * 5000,  # 超长
    ],
)
def test_redact_handles_hostile_input(payload):
    # 注入/编码串必须被当作数据处理：不抛错、返回字符串、不截断成异常
    out = redact(payload)
    assert isinstance(out, str)
    assert len(out) > 0


# --------------------------------------------------------------------------- 输入长度前置

def test_input_length_truncation_precedes_llm(caplog):
    from app.executors._llm import require_input_text

    long_text = "腹" * 1500
    with caplog.at_level(logging.WARNING):
        text = require_input_text({"taskType": "TRIAGE", "taskId": "t-1", "inputInline": long_text}, max_chars=1000)
    assert len(text) == 1000
    # 截断告警只记长度与 taskId，不回显原文
    assert "腹腹" not in caplog.text


def test_triage_cap_matches_contract():
    from app.executors.triage import _MAX_SYMPTOMS_CHARS

    assert _MAX_SYMPTOMS_CHARS == 1000  # 与业务侧 TriageRequest.symptoms 上限一致
