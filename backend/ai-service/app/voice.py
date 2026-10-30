"""语音能力适配层（M2 · D2.3）：TTS 引擎与 ASR 权重的**如实**探测、加载与合成/识别。

设计原则（对齐 08A D2.3 与总纲 §7「能力依赖不阻断启动」）：
- 引擎/权重缺失 → 能力状态 `unavailable`，相关端点**快速结构化失败**（TTS_UNAVAILABLE /
  CAPABILITY_UNAVAILABLE），**绝不播占位音、绝不 200+空对象**；
- 引擎标识**如实返回**（O-10 未定稿：edge-tts 就标 edge，未配置就标 none，不含糊）；
- ASR 音频经 `inputRef`（`asr:{id}`）引用进入本服务：仅当 `AI_ASR_AUDIO_DIR` 配置了
  约定目录时才可取用，否则能力如实不可用（不猜测、不伪造转写）。

本模块只做能力与编解码；任务编排与降级语义在 `executors/` 中收口。
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .config import Settings

logger = logging.getLogger("ai-service.voice")

# 未配置 AI_TTS_URL_SECRET 时用进程内随机密钥（重启后旧签名 URL 失效，符合"短期"语义）
_PROCESS_SECRET: Optional[bytes] = None

# ASR 模型单例（进程级，避免每次请求重新加载 CPU 权重）
_ASR_MODEL_SINGLETON: Optional[Any] = None
_ASR_MODEL_LOCK = asyncio.Lock()
_ASR_MODEL_LOAD_TIME: Optional[float] = None


def _signing_secret(settings: Settings) -> bytes:
    global _PROCESS_SECRET
    if settings.tts_url_secret:
        return settings.tts_url_secret.encode("utf-8")
    if _PROCESS_SECRET is None:
        _PROCESS_SECRET = os.urandom(32)
        logger.info("TTS URL 签名使用进程内随机密钥（未配置 AI_TTS_URL_SECRET；重启后旧 URL 失效）")
    return _PROCESS_SECRET


# ---------------------------------------------------------------- TTS


def _edge_tts_module():
    try:
        import edge_tts  # type: ignore  # noqa: F401
        return edge_tts
    except Exception:  # pragma: no cover - 依赖缺失路径
        return None


def tts_status(settings: Settings) -> tuple[str, str]:
    """返回 (status, detail)：status ∈ available/unavailable（degraded 留作引擎部分可用）。"""
    engine = (settings.tts_engine or "none").lower()
    if engine in ("", "none"):
        return "unavailable", "TTS 引擎未配置（O-10 未定稿；文字展示不受影响）"
    if engine == "edge":
        if _edge_tts_module() is None:
            return "unavailable", "TTS 引擎 edge-tts 未安装（安装后启用；不播占位音）"
        return "available", "TTS 引擎 edge-tts 已就绪（引擎标识如实返回，不构成 SLA）"
    return "unavailable", f"未识别的 TTS 引擎：{engine}（不猜测、不降级为占位音）"


def tts_engine_name(settings: Settings) -> str:
    status, _ = tts_status(settings)
    return (settings.tts_engine or "none").lower() if status == "available" else "none"


def resolve_voice(settings: Settings, voice_id: Optional[str]) -> str:
    """业务音色 ID → 引擎音色；未知音色回退默认（契约：未知音色回退而非报错）。"""
    mapping: dict[str, str] = {}
    for pair in (settings.tts_voice_map or "").split(","):
        if "=" in pair:
            key, _, value = pair.partition("=")
            mapping[key.strip()] = value.strip()
    if voice_id and voice_id in mapping:
        return mapping[voice_id]
    return settings.tts_default_voice


def _sign(settings: Settings, filename: str, exp: int) -> str:
    """签名只绑定「文件名 | 过期时间」，同 exp 可复算（校验路径依赖此确定性）。"""
    return hmac.new(_signing_secret(settings), f"{filename}|{exp}".encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def sign_audio_token(settings: Settings, filename: str, ttl_seconds: int) -> str:
    """生成短期签名（`exp.sig`）；签名绑定文件名与过期时间。"""
    exp = int(time.time()) + max(1, ttl_seconds)
    return f"{exp}.{_sign(settings, filename, exp)}"


def verify_audio_token(settings: Settings, filename: str, token: str) -> bool:
    """校验签名与有效期；任何异常（格式/过期/签名不符）一律 False。"""
    try:
        exp_str, _, sig = token.partition(".")
        exp = int(exp_str)
    except (ValueError, AttributeError):
        return False
    if not sig or exp < int(time.time()):
        return False
    return hmac.compare_digest(_sign(settings, filename, exp), sig)


def synthesis_available(settings: Settings) -> bool:
    return tts_status(settings)[0] == "available"


# ---------------------------------------------------------------- TTS 连接池（2026-10-22 性能优化）
#
# 结论先行（edge-tts 7.3.1 实测）：该库每次合成都走**新的 WebSocket 升级**，
# 库本身不支持跨请求复用已升级的连接；可复用的只有 `aiohttp.TCPConnector`
# （连接池 + DNS 缓存 + 会话对象复用）。因此本层做两件事：
#   ① 进程级共享 TCPConnector（`ttl_dns_cache`，省掉每次建连的 DNS/对象开销）；
#   ② `Communicate.stream()` 增量落盘（首字节可观测、无音频时快速失败），
#      而非 `save()` 一次性写完后才知道结果。
# 回滚：`TTS_STREAM=false`（或 AI_TTS_STREAM=false）→ 完全回到旧的 `save()` 路径。

_TTS_CONNECTOR: Optional[Any] = None
_TTS_CONNECTOR_LOOP: Optional[asyncio.AbstractEventLoop] = None
_TTS_CONNECT_TIMEOUT_S = 10  # edge-tts 只接受 int 秒


def _tts_connector() -> Optional[Any]:
    """返回进程级 TCP 连接器；**按 event loop 归属重建**（测试里多次 asyncio.run 不会串 loop）。"""
    global _TTS_CONNECTOR, _TTS_CONNECTOR_LOOP
    try:
        import aiohttp  # type: ignore  # edge-tts 的硬依赖
    except Exception:  # pragma: no cover - 依赖缺失路径
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover - 非异步上下文
        return None
    if (
        _TTS_CONNECTOR is None
        or _TTS_CONNECTOR_LOOP is not loop
        or getattr(_TTS_CONNECTOR, "closed", True)
    ):
        _TTS_CONNECTOR = aiohttp.TCPConnector(limit=8, ttl_dns_cache=300, enable_cleanup_closed=True)
        _TTS_CONNECTOR_LOOP = loop
        logger.info("TTS 连接池已建立 | limit=8 | dnsCache=300s")
    return _TTS_CONNECTOR


async def close_tts_connector() -> None:
    """服务停止时关闭连接池（幂等；未建立过则 no-op）。"""
    global _TTS_CONNECTOR, _TTS_CONNECTOR_LOOP
    connector = _TTS_CONNECTOR
    _TTS_CONNECTOR = None
    _TTS_CONNECTOR_LOOP = None
    if connector is not None and not getattr(connector, "closed", True):
        await connector.close()


def _remove_quietly(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:  # pragma: no cover - 清理失败不掩盖原始错误
        pass


async def _synthesize_streaming(
    edge_tts, settings: Settings, text: str, engine_voice: str, tmp_path: Path, metrics: dict
) -> None:
    """流式合成：音频分片到达即写盘，首片到达时刻记为 firstByteMs。"""
    communicate = edge_tts.Communicate(
        text,
        engine_voice,
        connector=_tts_connector(),
        connect_timeout=_TTS_CONNECT_TIMEOUT_S,
        receive_timeout=max(1, int(settings.tts_timeout_seconds or 30)),
    )
    audio_bytes = 0
    started = metrics["_started"]
    with open(tmp_path, "wb") as fh:
        async for chunk in communicate.stream():
            if not isinstance(chunk, dict) or chunk.get("type") != "audio":
                continue  # WordBoundary/SentenceBoundary 等元数据不落盘
            data = chunk.get("data") or b""
            if not data:
                continue
            if metrics["firstByteMs"] is None:
                metrics["firstByteMs"] = round((time.perf_counter() - started) * 1000, 1)
            fh.write(data)
            audio_bytes += len(data)
    if audio_bytes == 0:
        # 关键：绝不把"只有元数据没有音频"当成功（否则会写出 0 字节产物毒化缓存）
        raise RuntimeError("TTS 引擎未返回任何音频")
    metrics["bytes"] = audio_bytes


async def _synthesize_save(
    edge_tts, settings: Settings, text: str, engine_voice: str, tmp_path: Path
) -> None:
    """旧实现（回滚档）：整段 save()。调用签名保持原样，便于一键回退对照。"""
    communicate = edge_tts.Communicate(text, engine_voice)
    await communicate.save(str(tmp_path))


async def synthesize(settings: Settings, text: str, engine_voice: str, out_path: Path) -> dict:
    """调用引擎合成并落盘；返回本次合成的耗时画像（**返回契约仍是文件**，调用方按需记录）。

    落盘契约（防「残次产物毒化缓存」）：
    - 先写临时文件 `.part`，**成功且非空**才原子替换到目标名；
    - 失败或产出为空 → 删除临时文件并抛错，**绝不留下半成品**。
    否则目标名一旦存在（哪怕 0 字节），调用方会把它当缓存命中，该文本将被永久毒化
    （每次跳过合成、每次都判空失败）。

    性能画像（2026-10-22 新增，返回值）：
    `{"mode": "stream"|"save", "firstByteMs": 首片音频到达毫秒|None, "totalMs": 总毫秒,
      "bytes": 落盘字节, "fallback": 流式失败后降级的异常类名|None}`。
    `mode="save"` 时 `firstByteMs` 恒为 None —— 旧路径没有任何首字节观测点，**不编造数字**。
    """
    engine = tts_engine_name(settings)
    if engine != "edge":
        raise RuntimeError("TTS 引擎未配置")
    edge_tts = _edge_tts_module()
    if edge_tts is None:
        raise RuntimeError("TTS 引擎 edge-tts 未安装")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_name(out_path.name + ".part")

    started = time.perf_counter()
    metrics: dict = {
        "mode": "save",
        "firstByteMs": None,
        "totalMs": None,
        "bytes": 0,
        "fallback": None,
        "_started": started,
    }

    use_stream = bool(getattr(settings, "tts_stream", True)) and hasattr(
        getattr(edge_tts, "Communicate", None), "stream"
    )

    try:
        if use_stream:
            metrics["mode"] = "stream"
            try:
                await _synthesize_streaming(edge_tts, settings, text, engine_voice, tmp_path, metrics)
            except Exception as exc:
                # 失败降级到非流式：先清残片，再用旧路径重试一次（不改变对外错误语义）
                metrics["fallback"] = exc.__class__.__name__
                metrics["mode"] = "save"
                metrics["firstByteMs"] = None
                metrics["bytes"] = 0
                metrics["_started"] = time.perf_counter()
                logger.warning(
                    "TTS 流式合成失败，降级非流式 | err=%s: %s", exc.__class__.__name__, str(exc)[:160]
                )
                _remove_quietly(tmp_path)
                await _synthesize_save(edge_tts, settings, text, engine_voice, tmp_path)
        else:
            await _synthesize_save(edge_tts, settings, text, engine_voice, tmp_path)

        if not tmp_path.exists() or tmp_path.stat().st_size == 0:
            raise RuntimeError("TTS 引擎返回空音频")
        metrics["bytes"] = tmp_path.stat().st_size
        tmp_path.replace(out_path)
    except BaseException:
        _remove_quietly(tmp_path)
        raise

    metrics.pop("_started", None)
    metrics["totalMs"] = round((time.perf_counter() - started) * 1000, 1)
    logger.info(
        "TTS 合成完成 | mode=%s | firstByte=%s | total=%.1fms | bytes=%d | fallback=%s",
        metrics["mode"],
        f"{metrics['firstByteMs']:.1f}ms" if metrics["firstByteMs"] is not None else "n/a",
        metrics["totalMs"],
        metrics["bytes"],
        metrics["fallback"] or "-",
    )
    return metrics


# ---------------------------------------------------------------- ASR

TTS_Synthesizer = Callable[..., object]
ASR_Transcriber = Callable[..., object]


def asr_status(settings: Settings) -> tuple[str, str]:
    engine = (settings.asr_engine or "none").lower()
    if engine in ("", "none"):
        return "unavailable", "ASR 权重未配置（语音输入暂不可用，可改用文字输入）"
    if engine == "funasr":
        if not settings.asr_model_path:
            return "unavailable", "ASR 引擎 funasr 已选但未配置权重路径（AI_ASR_MODEL_PATH）"
        if not Path(settings.asr_model_path).exists():
            return "unavailable", "ASR 权重路径不存在（不猜测、不伪造转写）"
        return "available", "本地 ASR 权重已就绪（准确率未经测试集验证）"
    return "unavailable", f"未识别的 ASR 引擎：{engine}"


def asr_engine_name(settings: Settings) -> str:
    return (settings.asr_engine or "none").lower() if asr_status(settings)[0] == "available" else "none"


def resolve_audio_path(settings: Settings, input_ref: Optional[str]) -> Optional[Path]:
    """把 `inputRef`（`asr:{id}`）解析为音频目录下的实际文件；无约定义务时返回 None。

    目录由 `AI_ASR_AUDIO_DIR` 约定（业务侧写入、任务侧只读）。未配置 → 能力如实不可用。
    """
    if not settings.asr_audio_dir or not input_ref:
        return None
    prefix, _, ref_id = input_ref.partition(":")
    if prefix != "asr" or not ref_id:
        return None
    base = Path(settings.asr_audio_dir)
    for suffix in (".wav", ".mp3", ".m4a", ".pcm", ".ogg", ".webm"):
        candidate = base / f"{ref_id}{suffix}"
        if candidate.exists():
            return candidate
    return None


async def get_asr_model(settings: Settings) -> Any:
    """进程级单例：首次加载模型权重，之后复用。线程安全（双检锁）。
    
    设计语义：
    - 模型加载是 CPU 密集操作（数秒~数十秒），必须在线程池执行，避免阻塞 event loop。
    - 单例生命周期=进程生命周期；重启=重新加载（重启前预热失败不影响首次请求懒加载兜底）。
    - 首次加载记录耗时并 INFO 日志，后续复用不重复日志（避免噪音）。
    """
    global _ASR_MODEL_SINGLETON, _ASR_MODEL_LOAD_TIME
    
    # 快路径：已加载直接返回（无锁，常态高并发场景）
    if _ASR_MODEL_SINGLETON is not None:
        return _ASR_MODEL_SINGLETON
    
    # 慢路径：首次加载（双检锁，只有首次或预热失败进入）
    async with _ASR_MODEL_LOCK:
        if _ASR_MODEL_SINGLETON is not None:  # 双检：等锁期间可能被其他协程加载完
            return _ASR_MODEL_SINGLETON
        
        # 在线程池加载，避免阻塞 event loop（CPU 密集+同步 IO）
        loop = asyncio.get_running_loop()
        start = time.time()
        
        def _load():
            try:
                from funasr import AutoModel  # type: ignore  # pragma: no cover
            except Exception as exc:  # pragma: no cover
                raise RuntimeError("funasr 依赖不可用") from exc
            return AutoModel(model=settings.asr_model_path, disable_update=True)
        
        model = await loop.run_in_executor(None, _load)
        elapsed = time.time() - start
        
        _ASR_MODEL_SINGLETON = model
        _ASR_MODEL_LOAD_TIME = elapsed
        logger.info("ASR 模型加载完成 | 路径=%s | 耗时=%.2fs | 后续请求将复用", settings.asr_model_path, elapsed)
        return model


async def preload_asr_model(settings: Settings) -> None:
    """后台预热：启动时调用，不阻塞主服务启动。失败只 WARN，首次请求可懒加载兜底。"""
    try:
        start = time.time()
        await get_asr_model(settings)
        logger.info("ASR 模型预热成功 | 耗时=%.2fs", time.time() - start)
    except Exception as exc:
        logger.warning("ASR 模型预热失败（首次请求将懒加载兜底）| 错误=%s", exc, exc_info=True)


async def transcribe(settings: Settings, audio_path: Path, locale: Optional[str]) -> tuple[str, Optional[str]]:
    """调用本地 ASR 权重转写；返回 (文本, 语言或 None)。引擎异常由调用方转 CAPABILITY_UNAVAILABLE。
    
    性能优化（P0，2026-10-22）：
    - 模型改为进程级单例（首次加载 + 后续复用），避免每次请求重新加载 CPU 权重（原耗时数秒~数十秒）。
    - generate() 在线程池执行（CPU 密集），避免阻塞 event loop。
    - 目标：第 2 次起响应 0.5~2s（CPU 环境实测记录）。
    """
    request_start = time.time()
    engine = asr_engine_name(settings)
    if engine != "funasr":
        raise RuntimeError("ASR 引擎未配置")
    
    # 获取单例模型（首次懒加载 or 复用预热结果）
    model = await get_asr_model(settings)
    model_ready_time = time.time() - request_start
    
    # generate() 也要在线程池跑（CPU 密集）
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: model.generate(input=str(audio_path))
    )
    
    text = ""
    if isinstance(result, list) and result and isinstance(result[0], dict):
        text = str(result[0].get("text") or "")
    if not text.strip():
        raise RuntimeError("ASR 未产出转写文本")
    
    total_time = time.time() - request_start
    logger.info(
        "ASR 转写完成 | 模型就绪=%.2fs | 总耗时=%.2fs | 文本长度=%d | 是否首次=%s",
        model_ready_time, total_time, len(text), _ASR_MODEL_LOAD_TIME is not None and model_ready_time > 1.0
    )
    
    # 语言标记只透传模型给出的值；FunASR 不提供时如实返回 None（不猜测）
    return text.strip(), None
