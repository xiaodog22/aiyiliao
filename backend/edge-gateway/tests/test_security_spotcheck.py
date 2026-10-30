"""M4 · D4.2 安全抽查（edge-gateway）——日志脱敏 + 注入串按数据对待。

覆盖 08A §D4.2：网关侧不得把原文/凭据落日志；注入/编码串按数据处理。
纯单元测试，不起服务。
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.redact import MASK, RedactingFilter, install_redaction, redact  # noqa: E402


def test_redact_bearer_and_kv():
    assert redact("Authorization: Bearer at-1234567890abcdef") == "Authorization: Bearer " + MASK
    assert redact("Idempotency-Key=abc123def456") == "Idempotency-Key=" + MASK
    assert redact("token: zzz-secret") == "token: " + MASK


def test_redact_phone_idcard_email():
    assert redact("13812345678") == "138****5678"
    assert redact("110101199003071234") == "110101********1234"
    assert redact("li.ming@hospital.cn") == "l***@hospital.cn"


def test_redact_keeps_route_and_status():
    # 网关自身日志（方法/路径/异常类名）必须保持可读
    line = "上游不可达 GET /api/v1/triage (ConnectTimeout)"
    assert redact(line) == line
    line2 = "响应适配失败，已原样透传 POST /api/v1/doctors (KeyError)"
    assert redact(line2) == line2


def test_filter_scrubs_record():
    rec = logging.LogRecord(
        name="gw", level=logging.WARNING, pathname=__file__, lineno=1,
        msg="%s -> %s 带 token=%s", args=("GET", "/api/v1/x", "sekret-123456"), exc_info=None,
    )
    RedactingFilter().filter(rec)
    assert "sekret-123456" not in rec.getMessage()


def test_install_redaction_idempotent():
    lg = logging.getLogger("gw-spotcheck-idem")
    h = logging.StreamHandler()
    lg.addHandler(h)
    try:
        install_redaction(lg)
        install_redaction(lg)
        assert sum(1 for f in h.filters if isinstance(f, RedactingFilter)) == 1
    finally:
        lg.removeHandler(h)


@pytest.mark.parametrize(
    "payload",
    ["../../etc/passwd", "'; DROP TABLE users; --", "$(id)", "<svg/onload=alert(1)>", "a" * 3000, "\x00\x7f"],
)
def test_hostile_path_as_data(payload):
    out = redact(payload)
    assert isinstance(out, str) and out
