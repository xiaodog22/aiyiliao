"""ai-service 配置（环境变量驱动；不在代码中落任何凭据）。

对齐契约：backend/contracts/ai-openapi.yaml（0.1.0-draft）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

APP_VERSION = "0.1.0-m3"

_SERVICE_DIR = Path(__file__).resolve().parent.parent


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


@dataclass
class Settings:
    host: str = field(default_factory=lambda: _env("AI_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(_env("AI_PORT", "8001")))

    # 服务令牌：static=固定令牌（**安全默认**；缺 token 时启动即拒绝）；off=开发档关闭（须显式设置）；
    # jwks=生产形态（M4，未实现，配置即拒绝启动）。
    auth_mode: str = field(default_factory=lambda: _env("AI_AUTH_MODE", "static").lower())
    service_token: str = field(default_factory=lambda: _env("AI_SERVICE_TOKEN", ""))

    # 模型/依赖
    ollama_url: str = field(default_factory=lambda: _env("AI_OLLAMA_URL", "http://127.0.0.1:11434"))
    small_model: str = field(default_factory=lambda: _env("AI_SMALL_MODEL", "qwen2.5:0.5b"))
    large_model: str = field(default_factory=lambda: _env("AI_LARGE_MODEL", "qwen2.5:7b"))

    # 任务运行参数
    store_path: Path = field(
        default_factory=lambda: Path(_env("AI_STORE_PATH", str(_SERVICE_DIR / "runtime" / "tasks.json")))
    )
    result_ttl_seconds: int = field(default_factory=lambda: int(_env("AI_RESULT_TTL_SECONDS", "3600")))
    task_timeout_seconds: int = field(default_factory=lambda: int(_env("AI_TASK_TIMEOUT_SECONDS", "300")))
    queue_max: int = field(default_factory=lambda: int(_env("AI_QUEUE_MAX", "100")))
    probe_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_PROBE_TIMEOUT_SECONDS", "1.5")))

    # ---- LLM 并发与连接复用（2026-10-22 优化；默认保持旧行为）----
    # worker 池大小：>1 时多个协程并发消费任务队列（队列本身 maxsize=queue_max 提供背压）；
    # 默认 1 = 旧的单 worker 行为（向后兼容，验收基准）。
    llm_worker_pool_size: int = field(default_factory=lambda: int(_env("AI_LLM_WORKER_POOL_SIZE", "1")))
    # Ollama 生成流式开关：true=对 /api/generate 用 stream=True 并累积（可观测首 token 延迟），
    # 失败自动回退非流式；false=始终非流式（旧行为）。**新行为，默认关闭**。
    llm_stream: bool = field(
        default_factory=lambda: _env("AI_LLM_STREAM", _env("LLM_STREAM", "false")).lower() in ("1", "true", "yes", "on")
    )
    # httpx 全局 client 复用开关：true=进程级单例（连接池复用，降低握手开销）；
    # false=每次调用新建一次性 client（完全回滚到优化前）。**回滚开关：设为 false 即回到旧实现**。
    llm_http_client_reuse: bool = field(
        default_factory=lambda: _env("AI_LLM_HTTP_CLIENT_REUSE", "true").lower() in ("1", "true", "yes", "on")
    )
    # 复用 client 的连接池与超时（仅 reuse=true 生效；关闭时退化为旧 per-call 行为）。
    llm_http_pool_max_connections: int = field(
        default_factory=lambda: int(_env("AI_LLM_HTTP_POOL_MAX_CONNECTIONS", "100"))
    )
    llm_http_pool_keepalive: int = field(
        default_factory=lambda: int(_env("AI_LLM_HTTP_POOL_KEEPALIVE", "20"))
    )
    llm_http_timeout_seconds: float = field(
        default_factory=lambda: float(_env("AI_LLM_HTTP_TIMEOUT_SECONDS", "30"))
    )
    # 连接级重试（httpx 仅对连接错误重试，不对 4xx/5xx 重试 → 不改变错误码语义）。
    # 默认 0 = 与旧实现一致（不重试）。
    llm_http_max_retries: int = field(
        default_factory=lambda: int(_env("AI_LLM_HTTP_MAX_RETRIES", "0"))
    )

    # ---- M4 硬化前瞻（提前到 M3）：周期清理与保留策略 ----
    # 历史任务保留期（sweep 裁剪阈值）与周期清理间隔。
    task_retention_seconds: int = field(default_factory=lambda: int(_env("AI_TASK_RETENTION_SECONDS", "86400")))
    sweep_interval_seconds: int = field(default_factory=lambda: int(_env("AI_SWEEP_INTERVAL_SECONDS", "60")))
    # TTS 合成产物（非权威中间件）保留期：超过且未被在库任务引用的文件由 sweep 删除。
    tts_artifact_ttl_seconds: int = field(default_factory=lambda: int(_env("AI_TTS_ARTIFACT_TTL_SECONDS", "3600")))

    # TRIAGE 补充档：单次生成调用的独立短超时（快降级；不占满任务总预算）
    triage_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_TRIAGE_TIMEOUT_SECONDS", "20")))
    # TRIAGE 科室白名单配置文件路径（JSON 格式，包含本院真实科室与兜底策略）
    triage_departments_config: Path = field(
        default_factory=lambda: Path(_env(
            "AI_TRIAGE_DEPARTMENTS_CONFIG",
            str(_SERVICE_DIR / "config" / "triage-departments.json")
        ))
    )

    # ---- M2：对话生成（CHAT）与照护建议（CARE_PLAN）----
    chat_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_CHAT_TIMEOUT_SECONDS", "30")))
    careplan_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_CAREPLAN_TIMEOUT_SECONDS", "60")))
    # ---- 健康档案解读（INTERPRET，2026-10-22）：报告分节解释比对话长，但必须小于业务侧等待预算 ----
    # 三档关系：ai 45s < 业务 await 60s（wechar.interpret.await-seconds）< 前端 aiTimeout 90s。
    interpret_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_INTERPRET_TIMEOUT_SECONDS", "45")))

    # ---- M2：语音适配（O-10 已定稿 2026-10-15：生产默认 edge-tts；引擎仍如实返回）----
    # TTS 引擎：none=未配置（→ TTS_UNAVAILABLE） / edge=edge-tts（需本地可导入 edge_tts）
    # 定稿口径：生产默认 edge（轻量、外部依赖少、首包快）；对音色自然度/情感要求极高时才换 Qwen3-TTS。
    tts_engine: str = field(default_factory=lambda: _env("AI_TTS_ENGINE", "none").lower())
    tts_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_TTS_TIMEOUT_SECONDS", "30")))
    # 流式合成（2026-10-22 性能优化）：true=共享 TCP 连接池 + edge-tts stream() 增量落盘（首字节可观测）；
    # false=回滚到旧实现（每次新建 Communicate + save() 整段落盘）。**回滚开关**：TTS_STREAM=false 亦生效。
    # 契约不变：两种模式都返回「完整产物 + 签名 URL」，流式失败自动降级非流式。
    tts_stream: bool = field(
        default_factory=lambda: _env(
            "AI_TTS_STREAM", _env("TTS_STREAM", "true")
        ).lower() in ("1", "true", "yes", "on")
    )
    # 音色映射："业务音色ID=引擎音色,业务音色ID=引擎音色"；未命中回落默认引擎音色（不报错）
    tts_voice_map: str = field(default_factory=lambda: _env("AI_TTS_VOICE_MAP", ""))
    tts_default_voice: str = field(default_factory=lambda: _env("AI_TTS_DEFAULT_VOICE", "zh-CN-XiaoxiaoNeural"))
    # 合成产物落盘目录（非权威数据；重启可失）与对外可达前缀
    tts_output_dir: Path = field(
        default_factory=lambda: Path(_env("AI_TTS_OUTPUT_DIR", str(_SERVICE_DIR / "runtime" / "tts")))
    )
    tts_public_base: str = field(default_factory=lambda: _env("AI_TTS_PUBLIC_BASE", "http://127.0.0.1:8001"))
    # 可达路径前缀：本服务仅内网可达，故对外部署时把 base 指向客户端可达入口（经网关单入口=网关对外域名），
    # 并把本字段设为该入口转发到本服务内部签名通道的公开路径（默认 /api/gw/tts/audio，见 edge-gateway）。
    tts_public_path: str = field(default_factory=lambda: _env("AI_TTS_PUBLIC_PATH", "/internal/v1/tts/audio"))
    tts_url_ttl_seconds: int = field(default_factory=lambda: int(_env("AI_TTS_URL_TTL_SECONDS", "600")))
    # 短期签名 URL 的密钥；空则进程启动时随机生成（重启后旧 URL 失效，符合"短期"语义）
    tts_url_secret: str = field(default_factory=lambda: _env("AI_TTS_URL_SECRET", ""))

    # ---- TTS 固定句式预生成（2026-10-22）----
    # 启动时后台遍历清单预合成，命中缓存后首字节=文件读取（ms 级），不调 edge-tts。
    tts_pregen_enabled: bool = field(
        default_factory=lambda: _env("AI_TTS_PREGEN_ENABLED", "false").lower() in ("1", "true", "yes", "on")
    )
    tts_pregen_phrases_path: Path = field(
        default_factory=lambda: Path(_env("AI_TTS_PREGEN_PHRASES_PATH", str(_SERVICE_DIR / "config" / "tts-pregen-phrases.json")))
    )

    # ---- M2：内容寻址缓存（D2.4，键设计见 docs/v4/04 §9.2）----
    # 默认关：dev/测试不共享全局缓存文件（同一输入在不同用例下语义不同）；deploy 显式开启。
    cache_enabled: bool = field(
        default_factory=lambda: _env("AI_CACHE_ENABLED", "false").lower() in ("1", "true", "yes", "on")
    )
    cache_path: Path = field(
        default_factory=lambda: Path(_env("AI_CACHE_PATH", str(_SERVICE_DIR / "runtime" / "cache.json")))
    )
    cache_ttl_seconds: int = field(default_factory=lambda: int(_env("AI_CACHE_TTL_SECONDS", "3600")))
    # 租户密钥（HMAC 用）；空 → 进程启动时随机生成（重启换键，旧条目自然失效，符合「可失」语义）
    tenant_secret: str = field(default_factory=lambda: _env("AI_TENANT_SECRET", ""))

    # ASR 引擎：none=未配置（→ CAPABILITY_UNAVAILABLE） / funasr=本地 FunASR 权重
    asr_engine: str = field(default_factory=lambda: _env("AI_ASR_ENGINE", "none").lower())
    asr_model_path: str = field(default_factory=lambda: _env("AI_ASR_MODEL_PATH", ""))
    asr_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_ASR_TIMEOUT_SECONDS", "60")))
    # 音频取用通道：inputRef（asr:{id}）→ 该目录下的 {id}.<ext>。未配置 → 能力如实不可用。
    asr_audio_dir: str = field(default_factory=lambda: _env("AI_ASR_AUDIO_DIR", ""))
    # ASR 模型预热：true=启动时后台预热（不阻塞）；false=首次请求懒加载（默认，向后兼容）
    asr_preload: bool = field(
        default_factory=lambda: _env("AI_ASR_PRELOAD", "false").lower() in ("1", "true", "yes", "on")
    )

    # ---- M3：RAG 检索与知识库（特征开关，默认关闭）----
    # RAG 开关：false=能力探针显示 unavailable，CHAT citations 为空（向后兼容）
    rag_enabled: bool = field(
        default_factory=lambda: _env("AI_RAG_ENABLED", "false").lower() in ("1", "true", "yes", "on")
    )
    # V23（2026-10-24）演示：向量存储后端 qdrant | redis。
    #  - qdrant：生产标准（Qdrant 原生向量索引，需部署 :6333）；
    #  - redis：本地演示（Redis 存向量 + 服务端余弦 top-k；Redis 3.x 无原生向量索引，
    #    生产追求原生索引请升级 Redis Stack 8 / RediSearch 后仅替换 _search_redis 内部实现）。
    rag_store: str = field(default_factory=lambda: _env("AI_RAG_STORE", "redis").lower())
    # Qdrant 向量库连接
    qdrant_url: str = field(default_factory=lambda: _env("AI_QDRANT_URL", "http://127.0.0.1:6333"))
    qdrant_collection: str = field(default_factory=lambda: _env("AI_QDRANT_COLLECTION", "health_kb"))
    qdrant_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_QDRANT_TIMEOUT_SECONDS", "3")))
    qdrant_api_key: str = field(default_factory=lambda: _env("AI_QDRANT_API_KEY", ""))
    # Redis 向量存储连接（rag_store=redis 时生效；演示版索引键 = {prefix}index + {prefix}vec:{chunkId}）
    redis_url: str = field(default_factory=lambda: _env("AI_REDIS_URL", "redis://127.0.0.1:6379/0"))
    redis_key_prefix: str = field(default_factory=lambda: _env("AI_REDIS_KEY_PREFIX", "ai:rag:"))
    redis_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_REDIS_TIMEOUT_SECONDS", "2")))
    # Embedding 模型（Ollama 托管，需提前 pull）
    embedding_model: str = field(default_factory=lambda: _env("AI_EMBEDDING_MODEL", "nomic-embed-text"))
    # RAG 检索参数
    rag_top_k: int = field(default_factory=lambda: int(_env("AI_RAG_TOP_K", "3")))
    rag_score_threshold: float = field(default_factory=lambda: float(_env("AI_RAG_SCORE_THRESHOLD", "0.7")))
    rag_max_retries: int = field(default_factory=lambda: int(_env("AI_RAG_MAX_RETRIES", "2")))

    # ---- M3：院内知识库注入层（2026-10-22）----
    # 院内知识库配置文件路径（JSON 格式，包含 triage/chat/careplan/interpret 四个场景的知识片段）
    knowledge_base_path: Path = field(
        default_factory=lambda: Path(_env(
            "AI_KNOWLEDGE_BASE_PATH",
            str(_SERVICE_DIR / "config" / "hospital-knowledge.json")
        ))
    )

    log_level: str = field(default_factory=lambda: _env("AI_LOG_LEVEL", "INFO"))


def config_summary(settings: Settings, knowledge_version: str = "unknown") -> dict:
    """启动配置摘要（可审计；**不含**任何地址、文件路径、密钥值）。

    用途：每次启动打一行，运维据此判断「开关到底开没开、缓存落在哪种后端、用的是哪个模型/集合/版本」。
    红线：只输出枚举值与名称；`AI_TENANT_SECRET`、`AI_QDRANT_API_KEY`、`AI_SERVICE_TOKEN` 等一律只说
    「configured / auto-random」，绝不回显内容；不输出 ollama/qdrant URL 与磁盘路径。
    """
    cache_on = bool(settings.cache_enabled)
    return {
        "version": APP_VERSION,
        "cache": "on" if cache_on else "off",
        # 存储后端：当前只有 JSON 单文件实现（Redis 未接入，不写不存在的东西）
        "cacheBackend": "json" if cache_on else "none",
        "cacheTtlSeconds": int(settings.cache_ttl_seconds) if cache_on else 0,
        # 密钥来源影响「重启后旧条目是否还能命中」，比密钥本身更有运维价值
        "cacheTenantSecret": "configured" if settings.tenant_secret else "auto-random",
        "rag": "on" if settings.rag_enabled else "off",
        "ragStore": (settings.rag_store or "redis").lower() if settings.rag_enabled else "n/a",
        "qdrantCollection": settings.qdrant_collection if settings.rag_enabled else "n/a",
        "embeddingModel": settings.embedding_model if settings.rag_enabled else "n/a",
        "knowledgeVersion": knowledge_version,
        "asrEngine": (settings.asr_engine or "none").lower(),
        "asrPreload": "on" if settings.asr_preload else "off",
        "ttsEngine": (settings.tts_engine or "none").lower(),
        "ttsStream": "on" if settings.tts_stream else "off",
        # LLM 并发 / 流式 / 连接复用（2026-10-22）
        "llmConcurrency": int(settings.llm_worker_pool_size),
        "llmStream": "on" if settings.llm_stream else "off",
        "llmHttpReuse": "on" if settings.llm_http_client_reuse else "off",
        "llmHttpPool": f"{settings.llm_http_pool_max_connections}/{settings.llm_http_pool_keepalive}"
                       if settings.llm_http_client_reuse else "n/a",
        # 模型名是契约里公开的信息（readiness 也会报），不是秘密
        "llmSmall": settings.small_model,
        "llmLarge": settings.large_model,
        "queueMax": int(settings.queue_max),
        "concurrency": int(settings.llm_worker_pool_size),  # 如实标注实际并发度
        "taskTimeoutSeconds": int(settings.task_timeout_seconds),
    }


def format_config_summary(summary: dict) -> str:
    """把摘要压成一行 `key=value | ...`（供启动日志使用，便于 grep）。"""
    return " | ".join(f"{key}={value}" for key, value in summary.items())
