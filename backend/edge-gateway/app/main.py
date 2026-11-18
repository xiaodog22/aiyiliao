"""edge-gateway 入口。

职责（docs/v4/08 §3/§6）：
- /api/gw/**：网关自身（health / routes / voices 别名）。
- /api/**（除 /api/gw/**）：全量代理到 business-service。
- legacy 兼容层：迁移期把旧路径翻译到新契约路径（compat.py）。
- /health：旧探针路径，映射到网关健康（x-migration）。
"""

from __future__ import annotations

import logging
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from . import assets, cast as cast_bridge, compat, preflight, ratelimit, redact
from .config import APP_VERSION, GateSettings
from .envelope import (
    ApiError,
    error_payload,
    forbidden,
    new_request_id,
    not_found,
    ok_envelope,
    unauthorized,
    upstream_error,
    upstream_unavailable,
)
from .proxy import forward

logger = logging.getLogger("edge-gateway")

PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


# 请求 ID 白名单（审计 L3）：见 _request_id_middleware
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")


def _rid(request: Request) -> str:
    # 2026-11-17 全链路 trace：优先用中间件落定的 id，保证「信封 requestId / 响应头 /
    # 转发给 Java·AI 的 X-Request-Id」是同一个值；没有中间件上下文时退回旧行为。
    return (
        getattr(request.state, "request_id", None)
        or request.headers.get("x-request-id")
        or new_request_id()
    )


def create_app(settings: Optional[GateSettings] = None) -> FastAPI:
    settings = settings or GateSettings.load()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    redact.install_redaction()  # D4.2：日志脱敏（防原文/凭据落盘）
    # 逐请求日志是性能杀手，但**启动诊断必须留**（2026-11-01 PERF-03/04）。
    # 踩过的坑：把 root 设成 WARNING 会连 uvicorn 启动横幅、网关自身启动行一起吞掉，
    # 运维看不到「服务起来了 / 限流开没开」。所以只在 log_per_request=False 时
    # 精确地把三个**每请求**logger 压到 WARNING，其余一律不动。
    if not settings.log_per_request:
        for _name in ("httpx", "httpcore", "uvicorn.access"):
            logging.getLogger(_name).setLevel(logging.WARNING)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # 运行时依赖自检（PERF-07 衍生）：sniffio 缺失会让 anyio 每次调用重扫 sys.path，
        # 实测吃掉 48.6% CPU，而 pip check 查不出来（可选依赖无人声明）。只告警，不阻截启动。
        preflight.run_startup_check()
        app.state.http = httpx.AsyncClient(
            trust_env=False,  # 本地/内网上游不得走环境代理（HTTP_PROXY/ALL_PROXY）
            timeout=httpx.Timeout(
                connect=settings.connect_timeout_seconds,
                read=settings.proxy_timeout_seconds,
                write=60.0,
                pool=10.0,
            ),
            follow_redirects=False,
        )
        logger.info(
            "edge-gateway %s 启动 | business=%s | ai=%s | 代理读超时=%.0fs | 限流=%s",
            APP_VERSION, settings.business_url, settings.ai_url, settings.proxy_timeout_seconds,
            (f"on({settings.rate_limit_per_minute}/min)" if settings.rate_limit_enabled else "off"),
        )
        yield
        await app.state.http.aclose()
        logger.info("edge-gateway 已停止")

    app = FastAPI(title="edge-gateway", version=APP_VERSION, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.settings = settings
    # 投屏桥接（N14/N15/N16）：每 app 实例一份（注册表来自 settings.cast_devices，
    # 配对状态为进程内——测试用独立 create_app 天然隔离）
    app.state.cast_bridge = cast_bridge.CastBridge(settings.cast_devices)

    # ---------- 受控 CORS（本地调试台跨域调用；cors_enabled 默认开，生产置否）----------
    # 安全默认：即使 cors_enabled=true，**未显式配置 allowOrigins 即不开放任何跨域来源**，
    # 绝不回落 `allow_origins=["*"]`（通配 CORS 会把任意网页变成可读网关响应的客户端）。
    if settings.cors_enabled:
        origins = settings.cors_allow_origins
        if origins:
            from fastapi.middleware.cors import CORSMiddleware

            app.add_middleware(
                CORSMiddleware,
                allow_origins=origins,
                allow_credentials=False,
                allow_methods=["*"],
                allow_headers=["*"],
            )
            logger.info("受控 CORS 已启用 | 来源=%d 个", len(origins))
        else:
            logger.warning(
                "cors.enabled=true 但未配置 allowOrigins/GW_CORS_ALLOW_ORIGINS：不开放任何跨域来源"
            )

    # ---------- 限流（M4 硬化前瞻；默认关，deploy 显式开启） ----------
    limiter = (
        ratelimit.FixedWindowLimiter(settings.rate_limit_per_minute, settings.rate_limit_window_seconds)
        if settings.rate_limit_enabled
        else None
    )
    app.state.limiter = limiter
    if limiter is not None:
        @app.middleware("http")
        async def _rate_limit(request: Request, call_next):
            path = request.url.path
            if path not in ratelimit.EXEMPT_PATHS:
                client_host = request.client.host if request.client else None
                decision = limiter.check(ratelimit.client_key(
                    dict(request.headers), client_host, settings.rate_limit_trust_forwarded_for))
                if not decision.allowed:
                    body = error_payload(
                        "RATE_LIMITED", "请求过于频繁，请稍后重试", _rid(request), retryable=True
                    )
                    return JSONResponse(
                        status_code=429, content=body, headers={"Retry-After": str(decision.retry_after)}
                    )
            return await call_next(request)

    # ---------- 请求 ID（全链路 trace 的唯一入口）----------
    # 客户端可自带 X-Request-Id；未带则网关生成一次，并**贯穿**：
    #   ① 错误/成功信封的 requestId（_rid 读 request.state）；
    #   ② 转发给 Java / FastAPI 的 X-Request-Id（proxy.forward 兜底写入）；
    #   ③ 回给客户端的响应头（下方 setdefault）。
    # ⚠️ 必须**最后注册**（Starlette 后注册的中间件在最外层）：否则限流 429 会先短路，
    #    响应既没有 requestId 也没有 X-Request-Id，线上排障只能靠猜。
    @app.middleware("http")
    async def _request_id_middleware(request: Request, call_next):
        # 审计 L3：入站 X-Request-Id 由客户端控制，会被回显进响应信封并写入两侧日志。
        # 不校验等于开放日志注入（换行伪造日志行、ANSI 控制序列污染终端）。
        header = request.headers.get("x-request-id") or ""
        rid = header if _REQUEST_ID_RE.match(header) else new_request_id()
        request.state.request_id = rid
        response = await call_next(request)
        if "x-request-id" not in response.headers:
            response.headers["X-Request-Id"] = rid
        return response

    # ---------- 异常处理（business 风格信封） ----------

    @app.exception_handler(ApiError)
    async def _api_error_handler(request: Request, exc: ApiError):
        return JSONResponse(
            status_code=exc.http_status,
            content=error_payload(exc.code, exc.message, _rid(request), exc.retryable, details=exc.details),
        )

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception):
        logger.exception("未处理异常：%s", repr(exc))
        return JSONResponse(
            status_code=500,
            content=error_payload("INTERNAL_ERROR", "网关内部错误（已记录）", _rid(request), False),
        )

    # ---------- 健康 ----------

    async def _probe(client: httpx.AsyncClient, base: str, path: str) -> tuple[bool, Optional[int]]:
        started = time.perf_counter()
        try:
            resp = await client.get(base.rstrip("/") + path, timeout=settings.probe_timeout_seconds)
            reachable = resp.status_code < 500
        except httpx.HTTPError:
            reachable = False
        if not reachable:
            return False, None
        return True, int((time.perf_counter() - started) * 1000)

    async def _health_data() -> dict:
        client: httpx.AsyncClient = app.state.http
        java_ok, java_ms = await _probe(client, settings.business_url, "/actuator/health")
        python_ok, python_ms = await _probe(client, settings.ai_url, "/internal/health/live")
        # Ollama 常驻是 care-plans / consultations 的 AI 生成前置：缺失时业务仍可用，
        # 但必须让运维与前端看到 degraded，而不是笼统的 ok（§5.4）。
        ollama_ok, ollama_ms = await _probe(client, settings.ollama_url, settings.ollama_probe_path)
        upstreams = [
            {"name": "java", "reachable": java_ok, "latencyMs": java_ms},
            {"name": "python", "reachable": python_ok, "latencyMs": python_ms},
            {"name": "ollama", "reachable": ollama_ok, "latencyMs": ollama_ms},
        ]
        if java_ok and python_ok:
            # 2026-11-04 复核：Ollama 缺失仍算 degraded（如实上报 AI 生成能力受限）。
            # 之前设置页永远停在"检查中"的根因在**前端映射**（degraded→checking），
            # 已在 miniprogram/pages/profile/settings/settings.js 修正：网关只要可达就显示
            # 在线，各上游按 upstreams[].reachable 逐行显示在线/离线 —— 不靠篡改健康语义。
            status = "ok" if ollama_ok else "degraded"
        elif java_ok or python_ok:
            status = "degraded"
        else:
            status = "down"
        return {"status": status, "upstreams": upstreams}

    async def _health_response(request: Request) -> Response:
        rid = _rid(request)
        data = await _health_data()
        if data["status"] == "down":
            body = error_payload("UPSTREAM_UNAVAILABLE", "网关上游全部不可达", rid, retryable=True)
            body["data"] = data  # 诊断信息：仍不包含内网地址与版本细节
            return JSONResponse(status_code=503, content=body)
        return JSONResponse(status_code=200, content=ok_envelope(rid, data))

    @app.get("/api/gw/health")
    async def gateway_health(request: Request):
        return await _health_response(request)

    # ---------- /ai/ 分流（统一入口按前缀拆分到 FastAPI） ----------
    #
    # ⚠️ 只开放这一条**白名单**路径，不做 /ai/** 通配代理：
    # ai-service 的全部业务端点都在 /internal/**（设计上仅供网关内网调用，客户端不直连），
    # 通配转发等于把内部契约与鉴权边界一起暴露到公网，属安全回归。
    # 因此 /ai/ 前缀在这里只承担「分流可用性探针」职责；新增 AI 对外能力必须先有契约端点，
    # 再在此显式登记一条，不要改成 `@app.api_route("/ai/{path:path}")`。

    @app.get("/ai/health")
    async def ai_health(request: Request):
        """GET /ai/health → ai-service GET /internal/health/live（只读探针，零业务能力）。"""
        return await forward(
            app.state.http,
            request,
            settings.ai_url,
            target_path="/internal/health/live",
        )

    @app.get("/api/gw/routes")
    async def gateway_routes(request: Request):
        if not request.headers.get("authorization"):
            raise unauthorized()
        data = {
            "routes": [
                {"prefix": "/api/gw", "upstream": "gateway"},
                {"prefix": "/api", "upstream": "java"},
            ]
        }
        return ok_envelope(_rid(request), data)

    @app.get("/api/gw/voices")
    async def gateway_voices(request: Request):
        # 兼容别名：等价 /api/v1/voice/voices（deprecated；新代码应使用业务路径）
        return await forward(app.state.http, request, settings.business_url, target_path="/api/v1/voice/voices")

    # ---------- 投屏桥接（N14/N15/N16；SSDP/DLNA 发现在医院内网，由桥接完成，前端不直连广播） ----------

    def _require_auth(request: Request) -> None:
        # 与 /api/gw/routes 同口径：网关只做 Authorization 头存在性检查
        if not request.headers.get("authorization"):
            raise unauthorized()

    # 访问令牌形态（审计 H5）：business 签发的是 `at-<uuid>`；形态检查只作为廉价前置，
    # 真正的会话有效性必须由 _require_doctor_session 向 business 反查，不能只靠正则放行。
    _ACCESS_TOKEN_RE = re.compile(r"^Bearer\s+at-[A-Za-z0-9-]{16,}$")

    async def _require_doctor_session(request: Request, *, verify_role: bool = True) -> None:
        """审计 H5：投屏桥接不能只校验 token 形态，必须向 business 反查会话并校验 DOCTOR 角色。

        患者/任意伪造的 `at-xxxx` 一律 403；business 不可达时 503（fail-closed，不降级放行）。
        只取 whoami 的 roles，不缓存（会话撤销/角色变更立即生效）。
        `verify_role=False` 仅用于桥接未接入时：仍先校验 Bearer 形态（不泄露桥接状态），
        但不访问 business —— 随后由端点返回 CAST_BRIDGE_UNAVAILABLE。
        """
        auth = (request.headers.get("authorization") or "").strip()
        if not _ACCESS_TOKEN_RE.match(auth):
            raise unauthorized()
        if not verify_role:
            return
        try:
            resp = await app.state.http.get(
                settings.business_url.rstrip("/") + "/api/v1/auth/whoami",
                headers={"Authorization": auth, "X-Request-Id": _rid(request)},
                timeout=5.0,
            )
        except httpx.TimeoutException as exc:
            raise upstream_unavailable("会话校验超时，请稍后重试") from exc
        except httpx.HTTPError as exc:
            raise upstream_unavailable("会话校验服务暂不可达，请稍后重试") from exc
        if resp.status_code in (401, 403):
            raise unauthorized()
        if resp.status_code >= 500:
            raise upstream_unavailable("会话校验服务异常，请稍后重试")
        if resp.status_code != 200:
            raise unauthorized()
        try:
            data = (resp.json() or {}).get("data") or {}
        except ValueError as exc:
            raise upstream_error("会话校验响应格式异常") from exc
        roles = data.get("roles") if isinstance(data, dict) else None
        if not isinstance(roles, list) or "DOCTOR" not in roles:
            raise forbidden("仅医生账号可访问投屏设备")

    @app.get("/api/gw/cast/devices")
    async def cast_device_list(request: Request):
        """设备发现轮询。桥接未接入 → 503（前端显空态，不伪造设备）。"""
        await _require_doctor_session(request, verify_role=settings.cast_bridge_enabled)
        if not settings.cast_bridge_enabled:
            raise cast_bridge.bridge_unavailable()
        return ok_envelope(_rid(request), app.state.cast_bridge.discover())

    @app.post("/api/gw/cast/pair")
    async def cast_pair(request: Request):
        await _require_doctor_session(request, verify_role=settings.cast_bridge_enabled)
        if not settings.cast_bridge_enabled:
            raise cast_bridge.bridge_unavailable()
        cast_bridge.require_idempotency_key(request)
        device_id = cast_bridge.parse_pair_body(await request.body())
        return ok_envelope(_rid(request), app.state.cast_bridge.pair(device_id))

    @app.post("/api/gw/cast/push")
    async def cast_push(request: Request):
        """推送受理（QUEUE/PATIENT/KB）。payload 与设备 IP 不落日志（契约红线）。"""
        await _require_doctor_session(request, verify_role=settings.cast_bridge_enabled)
        if not settings.cast_bridge_enabled:
            raise cast_bridge.bridge_unavailable()
        cast_bridge.require_idempotency_key(request)
        raw = await request.body()
        if len(raw) > cast_bridge.MAX_PAYLOAD_BYTES:
            raise cast_bridge.payload_too_large()
        device_id, content_type, payload = cast_bridge.parse_push_body(raw)
        data = app.state.cast_bridge.push(device_id, content_type, payload)
        return ok_envelope(_rid(request), data)

    # ---------- TTS 产物公开通道（O-10 定稿 2026-10-15） ----------

    _tts_audio_name = re.compile(r"^[0-9a-f]{16,64}\.mp3$")

    @app.get("/api/gw/tts/audio/{filename}")
    async def gateway_tts_audio(request: Request, filename: str):
        """把 ai-service 的内部签名通道以**显式白名单路径**对外暴露（不公开 /internal/** 前缀本身）。

        鉴权=短期签名 token（音频元素无法携带 Authorization 头，故本路径不要求登录态）；
        网关只转发，不校验 token、不缓存、不改写响应体；文件名在此**先做白名单校验**，
        非法即 404（不下发上游）。对应 `AI_TTS_PUBLIC_BASE` + `AI_TTS_PUBLIC_PATH`。
        """
        if not _tts_audio_name.match(filename):
            raise not_found()
        return await forward(
            app.state.http,
            request,
            settings.ai_url,
            target_path=f"/internal/v1/tts/audio/{filename}",
        )

    # ---------- 静态素材公开通道（前端适配：素材经后端传递，docs/v4/09 §4.2） ----------

    @app.api_route("/api/gw/assets/{filename}", methods=["GET", "HEAD"])
    async def gateway_asset(request: Request, filename: str):
        """把 `backend/deploy/resources/` 中的**白名单图片**经统一入口对外分发。

        鉴权=公开（`<image>` 元素无法携带 Authorization 头）；服务端只读、目录外不可达、
        非图片扩展名 / 路径穿越 / 超限一律 404。响应带 `ETag` / `Cache-Control` /
        `X-Resource-Sha256` / `X-Resource-Size`，客户端据此做 304 复用与 sha256 校验；
        契约 `ResourceManifest.items[].url` 指向本通道（相对路径口径见 docs/v4/09 §4.4）。
        """
        response = assets.try_serve(settings.assets_dir, filename, request.headers.get("if-none-match"))
        if response is None:
            raise not_found()
        return response

    # ---------- 旧探针路径 ----------

    @app.get("/health")
    async def legacy_health(request: Request):
        return await _health_response(request)

    # ---------- legacy 兼容层 + 全量代理 ----------

    async def _dispatch(request: Request, path: str) -> Response:
        full_path = "/api" + path
        if full_path == "/api" or full_path.startswith("/api/"):
            if full_path.startswith("/api/gw/") or full_path == "/api/gw":
                # /api/gw/** 是网关自身域，未定义即 404，不代理
                raise not_found()
            entry = compat.match(request.method, full_path)
            if entry is not None:
                # dev-only legacy 条目（如 /api/user/login 的 dev 替身）未显式开启即 404：
                # 生产不得下发基于 dev 合成 code 换取会话的通道（安全默认关闭，见 GateSettings）。
                if entry.get("devOnly") and not settings.compat_legacy_login_enabled:
                    raise not_found()
                kind = entry["kind"]
                if kind in ("pending", "dropped"):
                    compat.raise_for(entry)
                query_snapshot = dict(request.query_params)
                if kind == "translate":
                    body = await request.body()
                    new_body, new_content_type = compat.translate_body(entry, full_path, request.query_params, body)
                    return await forward(
                        app.state.http,
                        request,
                        settings.business_url,
                        target_path=entry["target"],
                        body_override=new_body,
                        content_type=new_content_type,
                        query_override="" if compat.drops_query(entry) else None,
                        header_overrides=entry.get("headerOverrides"),
                        response_adapter=compat.response_adapter_for(entry, query_snapshot),
                    )
                if kind == "forward":
                    return await forward(
                        app.state.http,
                        request,
                        settings.business_url,
                        target_path=entry["target"],
                        response_adapter=compat.response_adapter_for(entry, query_snapshot),
                    )
            return await forward(app.state.http, request, settings.business_url)
        raise not_found()

    @app.api_route("/api/{path:path}", methods=PROXY_METHODS)
    async def api_catch_all(request: Request, path: str):
        return await _dispatch(request, "/" + path if path else "")

    return app


app = create_app()
