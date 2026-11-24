"""服务令牌校验（对齐 ai-openapi.yaml 的 serviceToken 安全方案）。

模式：
- static ：固定令牌（**安全默认**）：Authorization: Bearer <AI_SERVICE_TOKEN>，常量时间比较；
           启动时强制校验 token 已配置且足够强（≥32 字符），弱/缺 token 一律拒绝启动（fail-fast），
           防止多实例配置不一致或误用弱口令把内网接口暴露给持有者之外的人。
- off    ：开发档（须显式设置 AI_AUTH_MODE=off）。启动日志会显式打印该状态，不允许"偷偷关着"。
- jwks   ：生产形态（M4 实现；当前配置为 jwks 时直接拒绝启动以提示未完成，绝不静默放行）。

健康探针（/internal/health/**）与 TTS 音频签名通道（/internal/v1/tts/audio/**）按契约 exempt：
- 探针：security: []；
- TTS 音频：`<audio>` 元素无法携带 Authorization 头，该端点改由**查询参数短期签名**单独校验
  （app.voice.verify_audio_token，AI_TTS_PUBLIC_BASE 对外经网关白名单 /api/gw/tts/audio），
  因此不再叠加 Bearer 层（叠加会造成签名合法的音频一律 401，属误伤）。
其余 /internal/** 一律要求服务令牌。
"""

from __future__ import annotations

import hmac
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import Settings
from .envelope import error_payload, new_request_id

logger = logging.getLogger("ai-service.security")

_EXEMPT_PREFIXES = ("/internal/v1/tts/audio/",)
# 健康探针精确匹配（审计 L4）：原来用 startswith("/internal/health/") 做前缀判定，
# `/internal/health/../v1/xx` 这类编码路径可能落进豁免分支。改为**精确白名单** +
# 路径归一化（折叠重复斜杠、拒绝含 `..` 的路径），路由表怎么变都不会误放行。
_EXEMPT_PATHS = frozenset({"/internal/health/live", "/internal/health/ready"})

# 强 token 最小长度：HMAC 常量时间比较不防弱口令被猜中；64 hex（≥32 字节）以上才视为可用。
_MIN_TOKEN_LENGTH = 32


def _normalize_path(raw: str) -> str:
    """路径归一化（审计 L4）：折叠空段/`.`，遇到 `..` 直接判为不可信（返回空串 → 不豁免）。"""
    parts: list[str] = []
    for seg in (raw or "").replace("\\", "/").split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            return ""
        parts.append(seg)
    return "/" + "/".join(parts)


def _is_exempt(raw_path: str) -> bool:
    path = _normalize_path(raw_path)
    if not path:
        return False
    if path in _EXEMPT_PATHS:
        return True
    return any(path.startswith(p) for p in _EXEMPT_PREFIXES)


def install_auth(app: FastAPI, settings: Settings) -> None:
    mode = (settings.auth_mode or "static").lower()

    if mode == "jwks":
        raise RuntimeError("AI_AUTH_MODE=jwks 尚未实现（M4）；拒绝以不安全配置启动。")

    if mode == "off":
        logger.warning(
            "################ 不安全配置 | AI_AUTH_MODE=off | 所有 /internal/** 调用方校验已关闭，"
            "仅限本机联调；生产上线前必须改为 static 并配置强令牌 ################"
        )
        return

    if mode != "static":
        raise RuntimeError(f"未知 AI_AUTH_MODE={mode}（允许：off/static/jwks）")

    if not settings.service_token:
        raise RuntimeError("AI_AUTH_MODE=static 但未配置 AI_SERVICE_TOKEN，拒绝以无令牌状态启动。")
    if len(settings.service_token) < _MIN_TOKEN_LENGTH:
        raise RuntimeError(
            f"AI_SERVICE_TOKEN 过短（{len(settings.service_token)} 字符），必须 ≥ {_MIN_TOKEN_LENGTH} 字符，"
            "拒绝以弱令牌状态启动。请用 openssl rand -hex 32 生成强随机值。"
        )

    expected = "Bearer " + settings.service_token
    logger.info("服务令牌校验=static（联调档）")

    @app.middleware("http")
    async def _auth_middleware(request: Request, call_next):
        path = request.url.path
        if _is_exempt(path):
            return await call_next(request)
        provided = request.headers.get("authorization", "")
        if not hmac.compare_digest(provided, expected):
            rid = request.headers.get("x-request-id") or new_request_id()
            return JSONResponse(
                status_code=401,
                content=error_payload("UNAUTHORIZED", "服务令牌无效", rid, retryable=False),
            )
        return await call_next(request)
