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


def test_redact_signature_query_l11():
    """L11：附件签名 URL 的 sig/expires 是持有即凭证，不得原样进 access log。"""
    line = 'GET /api/v1/attachments/abc.jpg?sig=deadbeefcafebabe&expires=1700000000 HTTP/1.1'
    out = redact(line)
    assert "deadbeefcafebabe" not in out
    assert "1700000000" not in out
    assert "sig=" + MASK in out
    assert "expires=" + MASK in out
    # 保留路径与参数名，排障仍能定位是哪个附件接口
    assert "/api/v1/attachments/abc.jpg" in out


def test_redact_extensible_query_params_l11():
    """L11：签名参数采用敏感词族，新增 nonce/api_key/X-Amz-Signature 不得漏掩。"""
    line = ("GET /x?sig=aa11&X-Amz-Signature=bb22&nonce=cc33&api_key=dd44"
            "&access_token=ee55&keyword=感冒 HTTP/1.1")
    out = redact(line)
    for secret in ("aa11", "bb22", "cc33", "dd44", "ee55"):
        assert secret not in out, f"query 凭证 {secret} 原样落日志"
    assert "X-Amz-Signature=***" in out
    assert "nonce=***" in out
    assert "api_key=***" in out
    # 非敏感查询词不要求掩码，但不得因掩码丢失路径
    assert "/x?" in out


def test_install_redaction_on_non_propagating_logger_l11():
    """uvicorn.access 默认 propagate=False：filter 必须挂在 logger 本身才生效。"""
    import logging

    lg = logging.getLogger("gw-access-nonprop")
    lg.propagate = False
    lg.handlers.clear()
    try:
        install_redaction(lg)
        install_redaction(lg)
        assert sum(1 for f in lg.filters if isinstance(f, RedactingFilter)) == 1
        rec = lg.makeRecord("gw-access-nonprop", logging.INFO, __file__, 1,
                            "%s", ("GET /x?sig=abc123dead&expires=99",), None)
        for f in lg.filters:
            f.filter(rec)
        assert "abc123dead" not in rec.getMessage()
    finally:
        lg.filters.clear()


def test_redact_keeps_route_and_status():
    # 网关自身日志（方法/路径/异常类名）必须保持可读
    line = "上游不可达 GET /api/v1/triage (ConnectTimeout)"
    assert redact(line) == line
    line2 = "响应适配失败，已原样透传 POST /api/v1/doctors (KeyError)"
    assert redact(line2) == line2


def test_access_log_file_on_disk_is_redacted_l11(tmp_path):
    """L11 实测落盘：uvicorn.access 的 FileHandler 里不能出现 sig/expires 原值。"""
    lg = logging.getLogger("uvicorn.access.l11-file")
    lg.propagate = False
    lg.setLevel(logging.INFO)
    lg.handlers.clear()
    log_path = tmp_path / "access.log"
    fh = logging.FileHandler(log_path, encoding="utf-8")
    lg.addHandler(fh)
    install_redaction(lg)
    try:
        lg.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1", "GET",
                "/api/v1/attachments/abc.jpg?sig=deadbeefcafebabe&expires=1700000000",
                "1.1", 200)
    finally:
        fh.flush()
        fh.close()
        lg.removeHandler(fh)
        lg.filters.clear()
    text = log_path.read_text(encoding="utf-8")
    assert "deadbeefcafebabe" not in text
    assert "1700000000" not in text
    assert "sig=***" in text and "expires=***" in text


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
