"""ai-service 入口：装配应用、路由与异常处理。

启动：backend/ai-service/.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import re
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Callable, Optional

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import ValidationError

from .cache import ContentCache
from .capabilities import CapabilityProbe
from .config import APP_VERSION, Settings, config_summary, format_config_summary
from .http_client import close_http_client
from .envelope import ApiError, bad_request, error_payload, new_request_id, ok_envelope, validation_failed
from .executors import CACHE_DESCRIPTORS, build_default_executors
from .executors._llm import resolve_model
from .models import CancelRequest, TaskSubmitRequest
from . import redact, retention, streaming
from .security import install_auth
from .store import TaskStore
from .tasks import TERMINAL, StreamCapacityExceeded, TaskService
from .voice import close_tts_connector, preload_asr_model, verify_audio_token

logger = logging.getLogger("ai-service")

_STARTED_AT = time.time()


def _knowledge_version(settings: Settings) -> str:
    """院内知识库版本（文件缺失/损坏 → unknown，不抛异常；仅用于启动摘要）。"""
    try:
        from .knowledge import get_knowledge_loader

        return get_knowledge_loader(settings.knowledge_base_path).version
    except Exception:  # pragma: no cover - 摘要不能阻断启动
        return "unknown"

# 合成产物文件名白名单（防路径穿越：只允许 16~64 位十六进制 + .mp3）
_AUDIO_NAME_RE = re.compile(r"^[0-9a-f]{16,64}\.mp3$")


def _result_text(result) -> str:
    """取任务结果里可直接上屏的正文（当前仅 CHAT 有 `result.text`）。

    其余类型（triage/careplan/interpret/tts/asr）返回空串 —— 它们的结构不允许被
    简化成一句话推给前端，宁可空流也不伪造。
    """
    if not isinstance(result, dict):
        return ""
    text = result.get("text")
    return text if isinstance(text, str) else ""


# 请求 ID 白名单（审计 L3）：客户端可控且会回显进响应信封 + 两侧日志，
# 允许任意字符串等于开放日志注入（ANSI 转义、换行伪造日志行）。
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")

# 请求体上限（审计 M3）：Starlette 会把 JSON 整读进内存，无上限即单请求 OOM。
_MAX_REQUEST_BYTES = 1 << 20  # 1 MiB（业务侧最大载荷是长文本 prompt，远低于该值）


class _BodyTooLarge(Exception):
    """请求体在流式读取阶段超过上限（审计 M3：chunked 也不能绕过）。"""


class _BodyLimitMiddleware:
    """纯 ASGI 请求体上限：Content-Length 与实际累计字节双重校验。

    只靠 Content-Length 会被 `Transfer-Encoding: chunked` 绕过：攻击者可声明无长度并持续发块，
    等 FastAPI 聚合完 body 才检查已经太晚。这里在 receive 层累计，超过上限立刻中断，
    在响应未开始时返回 413；响应已开始则不再二次写（避免协议错乱）。
    """

    def __init__(self, app, max_bytes: int = _MAX_REQUEST_BYTES) -> None:
        self.app = app
        self.max_bytes = int(max_bytes)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        declared = headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > self.max_bytes:
            await self._reject(scope, receive, send)
            return

        received = 0
        response_started = False

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body", b"") or b"")
                if received > self.max_bytes:
                    raise _BodyTooLarge()
            return message

        async def tracked_send(message):
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except _BodyTooLarge:
            if not response_started:
                await self._reject(scope, receive, send)
            else:
                raise

    async def _reject(self, scope, receive, send) -> None:
        body = json.dumps(
            error_payload("PAYLOAD_TOO_LARGE", "请求体过大（上限 1MiB）", new_request_id(), retryable=False),
            ensure_ascii=False,
        ).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [(b"content-type", b"application/json; charset=utf-8"),
                        (b"content-length", str(len(body)).encode("ascii"))],
        })
        await send({"type": "http.response.body", "body": body})


def _rid(request: Request) -> str:
    cached = getattr(request.state, "request_id", None)
    if cached:
        return cached
    raw = request.headers.get("x-request-id") or ""
    return raw if _REQUEST_ID_RE.match(raw) else new_request_id()


def _validation_details(exc: ValidationError) -> list:
    details = []
    for err in exc.errors():
        loc = [str(part) for part in err.get("loc", ())]
        field = ".".join(loc[1:]) if len(loc) > 1 else None
        details.append({"field": field, "reason": str(err.get("msg", "")), "code": str(err.get("type", ""))})
    return details


def create_app(
    settings: Optional[Settings] = None,
    executors: Optional[dict] = None,
    ollama_probe: Optional[Callable] = None,
    cache: Optional[ContentCache] = None,
) -> FastAPI:
    settings = settings or Settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    redact.install_redaction()  # D4.2：日志脱敏（防原文/凭据落盘）
    settings.validate_security()  # H10/M2/M3/M4：非法安全配置在创建任何资源前 fail-fast

    store = TaskStore(settings.store_path, settings.store_encryption_key)
    # 内容寻址缓存（D2.4）：默认关（dev/测试不共享全局缓存文件）；deploy 以 AI_CACHE_ENABLED 开启。
    cache_obj = cache if cache is not None else (
        ContentCache(settings.cache_path, settings.cache_ttl_seconds) if settings.cache_enabled else None
    )
    # 生产注入 executors._llm.resolve_model 作为唯一档位→模型解析来源（与执行器实际用的一致）。
    service = TaskService(store, settings, cache=cache_obj, model_resolver=resolve_model)
    probe = CapabilityProbe(settings, ollama_probe=ollama_probe)
    # 默认注册生产执行器（TRIAGE 补充档）；显式传入 executors（含空字典）时不合并默认值，
    # 供测试构造「无执行器 → CAPABILITY_UNAVAILABLE」等受控场景。
    resolved_executors = build_default_executors(settings, probe) if executors is None else executors
    for task_type, executor in (resolved_executors or {}).items():
        # 只有登记了缓存描述的执行器才参与内容寻址缓存（见 executors.CACHE_DESCRIPTORS）。
        service.register_executor(task_type, executor, cache_descriptor=CACHE_DESCRIPTORS.get(task_type))

    async def _tts_pregen_background(settings) -> None:
        """TTS 固定句式预生成：后台遍历清单，已存在则跳过，失败仅 WARN。"""
        import hashlib
        import json
        import time
        from pathlib import Path
        from .voice import EDGE_BUILTIN_VOICES, ENGINE_FORMAT, resolve_voice, synthesize, tts_engine_name, tts_status
        try:
            phrases_path = Path(settings.tts_pregen_phrases_path)
            if not phrases_path.exists():
                logger.warning("TTS 预生成清单不存在: %s", phrases_path)
                return
            data = json.loads(phrases_path.read_text(encoding="utf-8"))
            phrases = data.get("phrases", [])
            if not phrases:
                logger.info("TTS 预生成清单为空，跳过")
                return
            status, detail = tts_status(settings)
            if status != "available":
                logger.warning("TTS 预生成跳过：TTS 不可用 (%s)", detail)
                return
            out_dir = Path(settings.tts_output_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            locale = "zh-CN"
            engine = tts_engine_name(settings)
            if engine == "none":
                logger.warning("TTS 预生成跳过：服务端无可用引擎（端侧兜底不预生成）")
                return
            ext, _ = ENGINE_FORMAT.get(engine, ("mp3", "audio/mpeg"))
            # 预生成必须覆盖前端可选音色：只预生成默认女声会让男声首播仍走实时合成。
            # 粤语音色不在这里预生成：预生成清单是普通话语料，用粤语音色读普通话会音色/语言错配。
            voice_ids = [None] + [v for v in EDGE_BUILTIN_VOICES if not v.startswith("yue-")]
            t0 = time.perf_counter()
            ok = skip = fail = 0
            for ph in phrases:
                text = ph["text"]
                for voice_id in voice_ids:
                    voice = resolve_voice(settings, voice_id, engine=engine, locale=locale)
                    d = hashlib.sha256(
                        f"{engine}|{text}|{voice}|{locale}".encode("utf-8")
                    ).hexdigest()[:16]
                    out_path = out_dir / f"{d}.{ext}"
                    if out_path.exists() and out_path.stat().st_size > 0:
                        skip += 1
                        continue
                    try:
                        await synthesize(settings, text, voice, out_path, engine=engine, locale=locale)
                        ok += 1
                    except Exception as exc:
                        fail += 1
                        logger.warning("TTS 预生成失败 id=%s voice=%s err=%s: %s",
                                       ph.get("id"), voice_id or "default",
                                       exc.__class__.__name__, str(exc)[:120])
                        try:
                            if out_path.exists():
                                out_path.unlink()
                        except OSError:
                            pass
            elapsed = time.perf_counter() - t0
            logger.info(
                "TTS 预生成完成 | 条目=%d 音色=%d 合成=%d 跳过=%d 失败=%d 耗时=%.1fs",
                len(phrases), len(voice_ids), ok, skip, fail, elapsed,
            )
        except Exception:
            logger.exception("TTS 预生成后台任务异常（已忽略，不影响主服务）")

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await store.load()
        if cache_obj is not None:
            await cache_obj.load()
            logger.info(
                "内容寻址缓存已启用 | 存储=JSON文件 | TTL=%ds | 版本=%d | 已加载=%d条",
                cache_obj.ttl_seconds, 1, len(cache_obj.entries)
            )
        else:
            logger.info("内容寻址缓存未启用（AI_CACHE_ENABLED=false）")
        await service.start()

        # ASR 模型预热（P0 性能优化，2026-10-22）：后台启动，不阻塞主服务启动。
        # 失败只 WARN，首次请求可懒加载兜底；开关：AI_ASR_PRELOAD（默认 false，向后兼容）。
        preload_task: Optional[asyncio.Task] = None
        if settings.asr_preload and settings.asr_engine == "funasr" and settings.asr_model_path:
            preload_task = asyncio.create_task(
                preload_asr_model(settings),
                name="asr-model-preload"
            )

        # TTS 固定句式预生成（2026-10-22）：后台遍历清单，命中缓存后首字节=文件读取。
        # 失败仅 WARN，不阻塞主服务；开关：AI_TTS_PREGEN_ENABLED（默认 true）。
        tts_pregen_task: Optional[asyncio.Task] = None
        if settings.tts_pregen_enabled:
            tts_pregen_task = asyncio.create_task(
                _tts_pregen_background(settings),
                name="tts-pregen"
            )

        async def _sweep_once() -> dict:
            """一轮清理：推进过期/裁剪历史任务 + 回收无引用的 TTS 产物。"""
            stats = await service.sweep()
            stats["artifactsRemoved"] = retention.sweep_tts_artifacts(
                settings.tts_output_dir,
                retention.referenced_audio_filenames(service.store.all()),
                settings.tts_artifact_ttl_seconds,
            )
            return stats

        async def _sweep_loop() -> None:
            interval = max(5, int(settings.sweep_interval_seconds))
            while True:
                await asyncio.sleep(interval)
                try:
                    await _sweep_once()
                except asyncio.CancelledError:
                    raise
                except Exception:  # 清理失败不影响服务；下轮重试
                    logger.exception("周期清理异常（已忽略，下轮重试）")

        sweeper: Optional[asyncio.Task] = None
        if settings.sweep_interval_seconds > 0:
            sweeper = asyncio.create_task(_sweep_loop(), name="ai-retention-sweeper")
        # 审计 F1-8（2026-11-23）：off 档不能只在安全模块里一行 warning —— 启动摘要常被
        # grep 查看，必须在最显眼的位置重复提示，避免"本机联调配置"被误带到对外服务。
        if (settings.auth_mode or "").lower() == "off":
            logger.warning(
                "################ 不安全配置 | AI_AUTH_MODE=off | 服务令牌校验关闭 | "
                "生产环境必须设置 AI_AUTH_MODE=static + AI_SERVICE_TOKEN ################"
            )
        logger.info(
            "ai-service %s 启动 | 令牌校验=%s | 执行器=%d | 内容寻址缓存=%s | 存储=%s | 周期清理=%s | ASR预热=%s | TTS预生成=%s",
            APP_VERSION, settings.auth_mode, service.executor_count,
            f"on({len(cache_obj.entries)} 条)" if cache_obj is not None else "off",
            settings.store_path,
            (f"on({max(5, int(settings.sweep_interval_seconds))}s)" if sweeper is not None else "off"),
            "background" if preload_task is not None else "off",
            "background" if tts_pregen_task is not None else "off",
        )
        # 配置摘要（2026-10-22）：一行可 grep 的开关/后端/模型/集合/TTL/版本；**不含**地址·路径·密钥
        logger.info(
            "启动配置摘要 | %s",
            format_config_summary(
                config_summary(settings, knowledge_version=_knowledge_version(settings))
            ),
        )
        yield
        if sweeper is not None:
            sweeper.cancel()
            with suppress(asyncio.CancelledError):
                await sweeper
        if preload_task is not None:
            preload_task.cancel()
            with suppress(asyncio.CancelledError):
                await preload_task
        if tts_pregen_task is not None:
            tts_pregen_task.cancel()
            with suppress(asyncio.CancelledError):
                await tts_pregen_task
        await service.stop()
        # LLM httpx 复用 client（2026-10-22）：优雅关闭，释放连接池
        with suppress(Exception):
            await close_http_client()
        # TTS 连接池（2026-10-22）：优雅关闭，避免 aiohttp 在 GC 时刷 "Unclosed connector" 告警
        with suppress(Exception):
            await close_tts_connector()
        if cache_obj is not None:
            await cache_obj.save()
            logger.info("内容寻址缓存统计 %s", cache_obj.stats())
        logger.info("ai-service 已停止")

    app = FastAPI(
        title="ai-service",
        version=APP_VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.service = service
    app.state.store = store
    app.state.probe = probe

    install_auth(app, settings)
    # M3：ASGI 层累计请求体上限（chunked 也不能绕过）。放在鉴权外层，超大体不进入业务/模型链路。
    app.add_middleware(_BodyLimitMiddleware, max_bytes=_MAX_REQUEST_BYTES)

    @app.middleware("http")
    async def _request_guard(request: Request, call_next):
        """请求入口守卫（审计 M3/L3）：请求体上限 + requestId 白名单。

        顺序说明：本中间件在 install_auth 之后注册 → 位于更外层，
        非法超大体在下沉到业务逻辑（以及鉴权错误回显）之前就被 413 拒绝。
        """
        raw_len = request.headers.get("content-length")
        if raw_len and raw_len.isdigit() and int(raw_len) > _MAX_REQUEST_BYTES:
            rid = _rid(request)
            return JSONResponse(
                status_code=413,
                content=error_payload(
                    "PAYLOAD_TOO_LARGE", "请求体过大（上限 1MiB）", rid, retryable=False
                ),
            )
        header_rid = request.headers.get("x-request-id")
        # 非法 requestId 一律丢弃并重新生成：不写进 state、不进日志、不回显
        request.state.request_id = (
            header_rid if header_rid and _REQUEST_ID_RE.match(header_rid) else new_request_id()
        )
        return await call_next(request)

    # ---------- 异常处理 ----------

    @app.exception_handler(ApiError)
    async def _api_error_handler(request: Request, exc: ApiError):
        return JSONResponse(
            status_code=exc.http_status,
            content=error_payload(exc.code, exc.message, _rid(request), exc.retryable, exc.dependency, details=exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def _request_validation_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            content=error_payload("VALIDATION_FAILED", "请求校验失败", _rid(request), False, details=_validation_details(exc)),
        )

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception):
        logger.exception("未处理异常：%s", repr(exc))
        return JSONResponse(
            status_code=500,
            content=error_payload("INTERNAL_ERROR", "服务内部错误（已记录，请联系运维）", _rid(request), False),
        )

    # ---------- 内部任务接口 ----------

    # 租户归属校验（审计 C3）：/internal/v1/tasks 的读取、取消、SSE 订阅必须证明"调用方租户
    # = 任务租户"，否则同一服务令牌下的任一主体可枚举他人任务的转写/对话原文。
    # 缺省策略：服务令牌开启（static/jwks）时必须携带 X-Tenant-Id；off 档为本机联调，允许缺省。
    _tenant_required = (settings.auth_mode or "static").lower() != "off"

    def _tenant(request: Request) -> Optional[str]:
        raw = (request.headers.get("x-tenant-id") or "").strip()
        if not raw:
            if _tenant_required:
                raise bad_request("缺少 X-Tenant-Id（服务间调用必须声明租户边界）")
            return None
        return raw

    @app.post("/internal/v1/tasks")
    async def submit_task(request: Request):
        request.state.request_id = _rid(request)  # 已由请求守卫校验过（非法值不落地）
        idempotency_key = (request.headers.get("idempotency-key") or "").strip()
        if not (8 <= len(idempotency_key) <= 128):
            raise bad_request("缺少或不合法的 Idempotency-Key（8~128 字符）")
        try:
            body = await request.json()
        except Exception:
            raise bad_request("请求体必须是合法 JSON")
        try:
            payload = TaskSubmitRequest.model_validate(body)
        except ValidationError as exc:
            raise validation_failed("请求校验失败", details=_validation_details(exc))
        declared = _tenant(request)
        if declared is not None and declared != payload.tenant_id:
            # 代他人提交 = 直接以他人租户写任务；一律拒绝，不做"以载荷为准"的宽容处理
            raise bad_request("X-Tenant-Id 与载荷 tenantId 不一致")
        task, created = await service.submit(payload, idempotency_key, request.state.request_id)
        meta = None if created else {"idempotentReplay": True}
        return ok_envelope(request.state.request_id, task, meta=meta)

    @app.get("/internal/v1/tasks/{task_id}")
    async def get_task(task_id: str, request: Request):
        request.state.request_id = _rid(request)  # 已由请求守卫校验过（非法值不落地）
        task = await service.get_view(task_id, _tenant(request))
        if task is None:
            raise ApiError(404, "NOT_FOUND", "任务不存在", retryable=False)
        return ok_envelope(request.state.request_id, task)

    @app.post("/internal/v1/tasks/{task_id}/cancel")
    async def cancel_task(task_id: str, request: Request):
        request.state.request_id = _rid(request)  # 已由请求守卫校验过（非法值不落地）
        tenant = _tenant(request)
        reason = None
        raw = await request.body()
        if raw:
            try:
                cancel_req = CancelRequest.model_validate_json(raw)
                reason = cancel_req.reason.value if cancel_req.reason else None
            except ValidationError as exc:
                raise validation_failed("请求校验失败", details=_validation_details(exc))
        task = await service.cancel(task_id, reason, tenant)
        if task is None:
            raise ApiError(404, "NOT_FOUND", "任务不存在", retryable=False)
        return ok_envelope(request.state.request_id, task)

    # ---------- 对外流式（SSE）订阅通道 ----------
    # 第一期：仅 CHAT 有增量（triage/careplan/interpret 是 JSON 结构化输出，不外发）。
    # 旁路设计：不订阅时任务行为与轮询链路完全一致；端点可独立下线，不影响任务队列。
    @app.get("/internal/v1/tasks/{task_id}/stream")
    async def stream_task(task_id: str, request: Request):
        request.state.request_id = _rid(request)  # 已由请求守卫校验过（非法值不落地）
        # 订阅位必须先过租户归属（审计 C3）：SSE 直通的是对话增量原文，
        # 越权订阅等价于实时窃听他人问诊。
        tenant = _tenant(request)
        view = await service.get_view(task_id, tenant)
        if view is None:
            raise ApiError(404, "NOT_FOUND", "任务不存在", retryable=False)

        try:
            queue = service.open_stream(task_id, tenant)
        except StreamCapacityExceeded as exc:
            raise ApiError(503, "STREAM_LIMIT", "实时通道繁忙，请改用轮询", retryable=True,
                           details=[{"field": "stream", "reason": str(exc)}]) from exc
        idle = float(settings.stream_idle_timeout_seconds)
        from .metrics import metrics as _metrics

        _metrics().record_stream_subscriber()

        def frame(event: str, data: dict, seq: int) -> str:
            raw = json.dumps(data, ensure_ascii=False)
            # 出站兜底（2026-11-18）：正文若仍含无法编码的字符（孤立 UTF-16 代理等），
            # Starlette 写 UTF-8 时会抛 UnicodeEncodeError 把整条流打断。这里先试编码，
            # 失败才降级为 U+FFFD 并留 WARN —— 宁可显示 �，也不能让用户拿半截答案。
            try:
                raw.encode("utf-8")
            except UnicodeEncodeError:
                logger.warning("SSE 帧含不可编码字符，已降级为替换字符 | event=%s", event)
                raw = raw.encode("utf-8", "replace").decode("utf-8")
            return f"event: {event}\nid: {seq}\ndata: {raw}\n\n"

        def error_payload(view: dict) -> dict:
            """任务未成功时的统一 error 载荷（活流与终态回放共用，避免两处口径漂移）。"""
            err = view.get("error") or {}
            return {
                "code": err.get("code") or view.get("status") or "TASK_FAILED",
                "message": err.get("message") or "任务未成功",
                "retryable": bool(err.get("retryable")),
            }

        async def _events():
            seq = 0
            deltas = 0
            current = await service.get_view(task_id) or view

            seq += 1
            yield frame("start", {
                "taskId": task_id,
                "taskType": current.get("taskType"),
                "modelId": current.get("modelId"),
                "knowledgeSnapshot": current.get("knowledgeSnapshot"),
            }, seq)

            # 已终态（含缓存命中）：直接回放最终结果，便于客户端断线重连后补齐。
            # 必须先占订阅位再判终态（open_stream 在端点入口处），否则会漏掉两者的竞态；
            # 终态无活流可听，这里立即释放订阅位，避免队列长期挂在 _streams 里。
            if current.get("status") in TERMINAL:
                service.close_stream(task_id, queue)
                text = _result_text(current.get("result"))
                if text:
                    seq += 1
                    yield frame("delta", {"text": text}, seq)
                seq += 1
                if current.get("status") == "SUCCEEDED":
                    # 不带 status：事件类型即语义（done=成功 / error=失败），
                    # 与活流口径一致，客户端无需依赖该字段（2026-11-17 契约收口）。
                    yield frame("done", {
                        "finishReason": "stop",
                        "cached": bool(current.get("cached")),
                    }, seq)
                else:
                    # 失败/取消的任务重连时必须回 error：回 done 会让客户端把失败当成功。
                    yield frame("error", error_payload(current), seq)
                return

            try:
                while True:
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=idle)
                    except asyncio.TimeoutError:
                        _metrics().record_stream_interrupted()
                        seq += 1
                        yield frame("error", {
                            "code": "STREAM_IDLE_TIMEOUT",
                            "message": "长时间无增量，连接已关闭（可重连或改用轮询）",
                            "retryable": True,
                        }, seq)
                        return
                    except asyncio.CancelledError:
                        _metrics().record_stream_interrupted()
                        raise
                    if item is streaming.STREAM_SUPERSEDED:
                        # 同任务的更新连接已顶替本连接（重连场景）：静默收尾，不报错、不重放。
                        _metrics().record_stream_interrupted()
                        seq += 1
                        yield frame("error", {
                            "code": "STREAM_SUPERSEDED",
                            "message": "该任务已有新的订阅连接，本连接已关闭",
                            "retryable": False,
                        }, seq)
                        return
                    if item is streaming.STREAM_END:
                        break
                    seq += 1
                    deltas += 1
                    _metrics().record_stream_delta()
                    yield frame("delta", {"text": item}, seq)
            finally:
                # 客户端断开 / 空等超时都要交还订阅位：任务仍在跑时重连可继续接增量。
                # 带 queue 自证身份，避免把顶替自己的新订阅者一起摘掉。
                service.close_stream(task_id, queue)

            final = await service.get_view(task_id) or {}
            if final.get("status") != "SUCCEEDED":
                seq += 1
                yield frame("error", error_payload(final), seq)
                return

            if deltas == 0:
                # 无增量（DeepSeek 降级 / 模型未按 JSON 格式输出 / TTS 等非文本类型）：
                # 用最终结果补一块完整正文，保证客户端不拿到空流。
                text = _result_text(final.get("result"))
                if text:
                    seq += 1
                    yield frame("delta", {"text": text}, seq)
            seq += 1
            yield frame("done", {"finishReason": "stop", "cached": bool(final.get("cached"))}, seq)

        return StreamingResponse(
            _events(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                # 反代（nginx 系）必须关缓冲，否则 token 被攒批，逐字效果失效
                "X-Accel-Buffering": "no",
            },
        )

    # ---------- TTS 音频通道（契约外·内部通道；仅本服务与经授权的边缘可达） ----------
    # 说明：TTS 结果只回 audioUrl（不内联字节）。此通道按「短期签名 + 文件名白名单」取音频；
    # 客户端可达性由 AI_TTS_PUBLIC_BASE 决定（O-10 定稿前默认指向本服务，见 README 待决项）。
    @app.get("/internal/v1/tts/audio/{filename}")
    async def tts_audio(filename: str, request: Request):
        if not _AUDIO_NAME_RE.match(filename) or Path(filename).name != filename:
            raise ApiError(404, "NOT_FOUND", "音频不存在", retryable=False)
        token = request.query_params.get("token") or ""
        if not verify_audio_token(settings, filename, token):
            raise ApiError(403, "FORBIDDEN", "音频链接无效或已过期", retryable=False)
        path = Path(settings.tts_output_dir) / filename
        if not path.exists():
            raise ApiError(404, "NOT_FOUND", "音频不存在或已清理", retryable=False)
        return FileResponse(path, media_type="audio/mpeg")

    # ---------- 健康探针（按契约不经统一信封） ----------

    @app.get("/internal/health/live")
    async def liveness():
        return {"status": "ok", "uptimeSeconds": round(time.time() - _STARTED_AT, 1), "version": APP_VERSION}

    # 探针限速（审计 H11）：未鉴权者以低频请求 ready 也能把同步 Redis ping 打成 loop 阻塞，
    # 且响应会泄露内部拓扑（模型名、索引在位性）。两道处理：
    #  1) 本进程内按来源 IP 固定窗口限速（默认 30 次/分，业务侧轮询远低于此）；
    #  2) 未携带有效服务令牌时只回 {status, degraded}，不再回模型名/引擎/依赖明细。
    _READY_LIMIT_PER_MINUTE = 30
    _ready_hits: dict[str, list] = {}

    def _ready_rate_limited(host: str) -> bool:
        now = time.time()
        window = _ready_hits.setdefault(host, [0.0, 0])
        if now - window[0] >= 60:
            window[0] = now
            window[1] = 0
        window[1] += 1
        return window[1] > _READY_LIMIT_PER_MINUTE

    def _service_token_ok(request: Request) -> bool:
        expected = "Bearer " + (settings.service_token or "")
        provided = request.headers.get("authorization", "")
        return bool(settings.service_token) and hmac.compare_digest(provided, expected)

    @app.get("/internal/health/ready")
    async def readiness(request: Request, response: Response):
        host = request.client.host if request.client else "unknown"
        if _ready_rate_limited(host):
            raise ApiError(429, "RATE_LIMITED", "探针请求过于频繁", retryable=True)
        result = await probe.readiness()
        if result.get("status") == "down":
            response.status_code = 503
        # off 档是本机联调（服务令牌本身已关闭），没有需要保护的"内网拓扑"边界，保留明细；
        # static/jwks 档对未持令牌者只回聚合状态，避免把模型名/索引在位性变成侦察情报。
        if (settings.auth_mode or "static").lower() == "off" or _service_token_ok(request):
            return result
        # 未鉴权：只暴露聚合状态与"谁降级"，供外部探活判断，不暴露模型名/引擎/内部地址
        degraded = [
            item.get("name")
            for item in (result.get("dependencies") or [])
            if item.get("status") != "available"
        ]
        return {"status": result.get("status"), "degraded": degraded}

    # ---------- 内部可观测（仅运维，不在 ai-openapi 契约内） ----------
    @app.get("/internal/metrics/llm")
    async def llm_metrics():
        from .metrics import metrics

        return metrics().snapshot()

    return app


app = create_app()
