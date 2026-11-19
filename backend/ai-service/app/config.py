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


def _env_float_or_none(name: str) -> "float | None":
    value = os.environ.get(name)
    if value in (None, ""):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _env_bool(name: str, default: bool) -> bool:
    """布尔环境变量：1/true/yes/on 为真，其余显式值一律为假。"""
    value = os.environ.get(name)
    if value in (None, ""):
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on")


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

    # ---- 统一降级开关（2026-11-18，AI能力降级与容灾方案 §2.5）----
    # 总开关 false=仅本地（默认，合规优先、零外部请求）；true=允许按能力链使用云端/外部供应商。
    # 生效公式：master && capability && provider。本地能力（Ollama/FunASR/Qwen3-TTS/规则/模板/预生成）
    # 不受 master 否决；DeepSeek / edge-tts / WechatSI / 任何云端 ASR 在 local 模式一律硬否决，
    # 被否决的供应商不建连、不重试、不探测。
    degrade_enabled: bool = field(default_factory=lambda: _env_bool("AI_DEGRADE_ENABLED", False))
    degrade_llm_enabled: bool = field(default_factory=lambda: _env_bool("AI_DEGRADE_LLM_ENABLED", True))
    degrade_asr_enabled: bool = field(default_factory=lambda: _env_bool("AI_DEGRADE_ASR_ENABLED", True))
    degrade_tts_enabled: bool = field(default_factory=lambda: _env_bool("AI_DEGRADE_TTS_ENABLED", True))
    degrade_rag_enabled: bool = field(default_factory=lambda: _env_bool("AI_DEGRADE_RAG_ENABLED", True))
    # 供应商级开关（默认全开，但只有 master=true 时才可能生效）
    deepseek_enabled: bool = field(default_factory=lambda: _env_bool("AI_PROVIDER_DEEPSEEK_ENABLED", True))
    tts_qwen3_enabled: bool = field(default_factory=lambda: _env_bool("AI_TTS_QWEN3_ENABLED", True))
    tts_edge_enabled: bool = field(default_factory=lambda: _env_bool("AI_TTS_EDGE_ENABLED", True))
    wechat_si_enabled: bool = field(default_factory=lambda: _env_bool("AI_WECHAT_SI_ENABLED", True))
    asr_cloud_enabled: bool = field(default_factory=lambda: _env_bool("AI_ASR_CLOUD_ENABLED", False))
    # 检索关键词兜底：向量检索不可用时退化为关键词检索（纯本地，常开可配）
    rag_keyword_fallback: bool = field(default_factory=lambda: _env_bool("AI_RAG_KEYWORD_FALLBACK", True))

    # ---- 出境策略（2026-11-18 · 审计 H10）----
    # allow    ：按上面的降级开关决定是否允许第三方 provider（默认，行为不变）
    # domestic ：PHI 不出境 —— 所有境外供应商（DeepSeek / 微软 edge-tts）一律硬否决，
    #            即使 master=true 也不建连；链路自然回落到本地 Ollama / 预生成音频。
    # 为什么不止靠"注释约定"：熔断触发境外兜底是**自动**的，值守人员不一定在场，
    # 策略必须是机器可执行的开关，而不是文档里的一句话。
    egress_policy: str = field(default_factory=lambda: _env("AI_EGRESS_POLICY", "domestic").strip().lower())

    # ---- B2 三步走 provider 链（2026-11-04）----
    # 顺序：ollama（本地内网穿透）→ deepseek（OpenAI 兼容 API）→ 兜底。
    # `rule` 不是 provider（由 business TriageRuleEngine 承载），写在配置里也不会被 ai-service 调用。
    provider_order: str = field(default_factory=lambda: _env("AI_PROVIDER_ORDER", "ollama,deepseek"))
    # Ollama 模型常驻时长（2026-11-14，响应速度）。
    # Ollama 默认 5 分钟无请求就卸载模型，7B 在 CPU 上重新加载要 10~30s ——
    # 用户"隔几分钟再问一次"时会突然变慢，且首 token 超时也更容易被触发。
    # 这里统一在 provider 层注入 keep_alive（生成请求里未显式指定时生效），默认 30 分钟。
    # 显存/内存吃紧的机器可调小（如 5m）或设 0 用完即卸。
    ollama_keep_alive: str = field(default_factory=lambda: _env("AI_OLLAMA_KEEP_ALIVE", "30m"))
    # Ollama **首 token** 超时（秒）：只卡"多久出第一个 token"，不卡总生成时长。
    # 7B 生成 300 token 在 CPU 上远超 6~10s，按总时长卡会把正常生成误判为超时。
    # 评审建议值：triage 5 / chat 6 / careplan 8 / interpret 6；此处默认取中间值 8，按任务可覆盖。
    ollama_first_token_timeout: float = field(
        default_factory=lambda: float(_env("AI_OLLAMA_FIRST_TOKEN_TIMEOUT", "8"))
    )
    # 逐任务首 token 阈值（未显式配置则回落到 AI_OLLAMA_FIRST_TOKEN_TIMEOUT）
    triage_first_token_timeout: "float | None" = field(
        default_factory=lambda: _env_float_or_none("AI_TRIAGE_FIRST_TOKEN_TIMEOUT")
    )
    chat_first_token_timeout: "float | None" = field(
        default_factory=lambda: _env_float_or_none("AI_CHAT_FIRST_TOKEN_TIMEOUT")
    )
    careplan_first_token_timeout: "float | None" = field(
        default_factory=lambda: _env_float_or_none("AI_CAREPLAN_FIRST_TOKEN_TIMEOUT")
    )
    interpret_first_token_timeout: "float | None" = field(
        default_factory=lambda: _env_float_or_none("AI_INTERPRET_FIRST_TOKEN_TIMEOUT")
    )
    # DeepSeek（第二级兜底）：key 只从环境变量注入，**任何文件/日志都不得出现**。
    # 模型名以官方当前列表为准（deepseek-flash / deepseek-v4-pro）；
    # 旧默认值 deepseek-chat 已不在官方列表，2026-11-15 更正，详见 providers/deepseek.py 顶部说明。
    deepseek_base_url: str = field(
        default_factory=lambda: _env("AI_DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    )
    deepseek_api_key: str = field(default_factory=lambda: _env("AI_DEEPSEEK_API_KEY", ""))
    deepseek_model: str = field(default_factory=lambda: _env("AI_DEEPSEEK_MODEL", "deepseek-flash"))
    # 逐任务第二级预算（秒）。2026-11-15 调大：云端非流式 300~800 token 生成，
    # 10/16/36/28s 在高峰期或队列波动时会先于模型返回超时，导致兜底形同虚设。
    # 实际生效值 = min(该值, 任务自身 timeout)，见 deepseek_timeout_for()。
    triage_deepseek_timeout: float = field(
        default_factory=lambda: float(_env("AI_TRIAGE_DEEPSEEK_TIMEOUT_SECONDS", "15"))
    )
    chat_deepseek_timeout: float = field(
        default_factory=lambda: float(_env("AI_CHAT_DEEPSEEK_TIMEOUT_SECONDS", "20"))
    )
    careplan_deepseek_timeout: float = field(
        default_factory=lambda: float(_env("AI_CAREPLAN_DEEPSEEK_TIMEOUT_SECONDS", "45"))
    )
    interpret_deepseek_timeout: float = field(
        default_factory=lambda: float(_env("AI_INTERPRET_DEEPSEEK_TIMEOUT_SECONDS", "35"))
    )
    # 熔断：连续失败 N 次 → 冷却 cooldown 秒内直接跳过该级（0 = 关闭熔断）
    breaker_failures: int = field(default_factory=lambda: int(_env("AI_BREAKER_FAILURES", "3")))
    breaker_cooldown_seconds: float = field(
        default_factory=lambda: float(_env("AI_BREAKER_COOLDOWN_SECONDS", "60"))
    )

    # 任务运行参数
    store_path: Path = field(
        default_factory=lambda: Path(_env("AI_STORE_PATH", str(_SERVICE_DIR / "runtime" / "tasks.json")))
    )
    # 审计 M2：任务快照 result 正文静态加密（Fernet，URL-safe base64 32 字节）。
    # 留空 = 明文（仅限 dev/itest）；生产 compose 强制注入。
    store_encryption_key: str = field(
        default_factory=lambda: _env("AI_STORE_ENCRYPTION_KEY", "")
    )
    # 审计 F-03（2026-11-19）：生产强制“快照必须加密”。compose/云部署置 true：
    # 缺 key 直接拒绝启动，避免运维漏配后退化成明文 PHI。
    store_require_encryption: bool = field(
        default_factory=lambda: _env_bool("AI_STORE_REQUIRE_ENCRYPTION", False)
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
    # SSE 订阅空闲超时（秒）：超过该时长无增量即发 error 收尾。
    # 必须 > 7B CPU 上两 token 之间的最大间隔（实测 deep 模式 57s 总时长、块间隔 <5s），
    # 默认 120 给足余量，同时避免断开的客户端把长连接挂成僵尸。
    stream_idle_timeout_seconds: float = field(
        default_factory=lambda: float(_env("AI_STREAM_IDLE_TIMEOUT_SECONDS", "120"))
    )
    # 审计 M3：SSE 全局并发上限（每连接持一个 asyncio 队列 + 长连接；无上限会被慢连接打爆内存/句柄）。
    stream_max_connections: int = field(
        default_factory=lambda: int(_env("AI_STREAM_MAX_CONNECTIONS", "64"))
    )
    # 审计 M3：单租户 SSE 并发上限，防止单个租户/租户密钥占满全局连接池。
    stream_max_connections_per_tenant: int = field(
        default_factory=lambda: int(_env("AI_STREAM_MAX_CONNECTIONS_PER_TENANT", "3"))
    )

    # ---- M4 硬化前瞻（提前到 M3）：周期清理与保留策略 ----
    # 历史任务保留期（sweep 裁剪阈值）与周期清理间隔。
    task_retention_seconds: int = field(default_factory=lambda: int(_env("AI_TASK_RETENTION_SECONDS", "86400")))
    sweep_interval_seconds: int = field(default_factory=lambda: int(_env("AI_SWEEP_INTERVAL_SECONDS", "60")))
    # TTS 合成产物（非权威中间件）保留期：超过且未被在库任务引用的文件由 sweep 删除。
    tts_artifact_ttl_seconds: int = field(default_factory=lambda: int(_env("AI_TTS_ARTIFACT_TTL_SECONDS", "3600")))
    # 审计 M4：单次 TTS 文本上限与产物目录容量上限（防止免费合成被当存储/带宽放大器）。
    tts_max_chars: int = field(default_factory=lambda: int(_env("AI_TTS_MAX_CHARS", "2000")))
    tts_max_disk_mb: int = field(default_factory=lambda: int(_env("AI_TTS_MAX_DISK_MB", "512")))
    # 审计 M4：按租户的 TTS 提交配额（滑动窗口），防止单个租户反复合成占满磁盘/带宽。
    tts_tenant_per_minute: int = field(
        default_factory=lambda: int(_env("AI_TTS_TENANT_PER_MINUTE", "6"))
    )
    tts_tenant_per_day: int = field(
        default_factory=lambda: int(_env("AI_TTS_TENANT_PER_DAY", "200"))
    )

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
    # 兼容字段：单引擎选择（none / qwen3 / edge）。新部署优先用 AI_TTS_ENGINES 配链。
    tts_engine: str = field(default_factory=lambda: _env("AI_TTS_ENGINE", "none").lower())
    # 多引擎降级链：qwen3（本地 sidecar）→ edge（微软 Edge 在线朗读）→ 端侧 WechatSI（不在本服务合成）。
    # 未配置时回落到 AI_TTS_ENGINE 单引擎，保持旧行为。
    tts_engines: str = field(
        default_factory=lambda: _env("AI_TTS_ENGINES", _env("AI_TTS_ENGINE", "none")).lower()
    )
    # 业务 TTS 总预算（秒）：qwen3 35 + edge 12 + 余量，必须小于 business task-budget(60)。
    tts_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_TTS_TIMEOUT_SECONDS", "55")))
    tts_qwen3_timeout_seconds: float = field(
        default_factory=lambda: float(_env("AI_TTS_QWEN3_TIMEOUT_SECONDS", "42"))
    )
    tts_edge_timeout_seconds: float = field(
        default_factory=lambda: float(_env("AI_TTS_EDGE_TIMEOUT_SECONDS", "12"))
    )
    # 本地 Qwen3-TTS sidecar 地址（空=未接入）。HTTP 契约见 voice.py 顶部说明。
    tts_qwen3_endpoint: str = field(default_factory=lambda: _env("AI_TTS_QWEN3_ENDPOINT", ""))
    tts_qwen3_default_voice: str = field(
        default_factory=lambda: _env("AI_TTS_QWEN3_DEFAULT_VOICE", "female-1")
    )
    tts_qwen3_health_path: str = field(
        default_factory=lambda: _env("AI_TTS_QWEN3_HEALTH_PATH", "/health")
    )
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

    # ---- TTS 固定句式预生成（2026-10-22，2026-11-17 默认开启）----
    # 启动时后台遍历清单预合成，命中缓存后首字节=文件读取（ms 级），不调 edge-tts。
    # 默认开启：高频问候/提示先落盘，患者端首播不再等实时合成；TTS 不可用时自检后跳过。
    tts_pregen_enabled: bool = field(
        default_factory=lambda: _env("AI_TTS_PREGEN_ENABLED", "true").lower() in ("1", "true", "yes", "on")
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
    asr_timeout_seconds: float = field(default_factory=lambda: float(_env("AI_ASR_TIMEOUT_SECONDS", "25")))
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

    # ---- provider 链取值辅助（B2）----
    def validate_security(self) -> None:
        """启动自检（审计 H10/M3/M4）：非法值直接拒绝启动，避免静默降级放行。"""
        policy = (self.egress_policy or "domestic").strip().lower()
        if policy not in ("domestic", "allow"):
            raise RuntimeError(f"AI_EGRESS_POLICY={policy} 非法（允许：domestic/allow）")
        if policy == "domestic" and (self.deepseek_api_key or "").strip():
            # H10：domestic 下 DeepSeek 本来就会被 provider_allowed 否决；
            # 但“配了境外 key 却假装 domestic”会让运维误判，启动即拒绝。
            raise RuntimeError("AI_EGRESS_POLICY=domestic 时禁止配置 AI_DEEPSEEK_API_KEY（医疗数据不出境）")
        if int(self.stream_max_connections) < 1:
            raise RuntimeError("AI_STREAM_MAX_CONNECTIONS 必须 ≥ 1")
        if int(self.stream_max_connections_per_tenant) < 1:
            raise RuntimeError("AI_STREAM_MAX_CONNECTIONS_PER_TENANT 必须 ≥ 1")
        if int(self.tts_max_chars) < 1:
            raise RuntimeError("AI_TTS_MAX_CHARS 必须 ≥ 1")
        if int(self.tts_max_disk_mb) < 0:
            raise RuntimeError("AI_TTS_MAX_DISK_MB 不得为负")
        if int(self.tts_tenant_per_minute) < 0 or int(self.tts_tenant_per_day) < 0:
            raise RuntimeError("AI_TTS_TENANT_PER_MINUTE / AI_TTS_TENANT_PER_DAY 不得为负")
        if self.store_require_encryption and not (self.store_encryption_key or "").strip():
            raise RuntimeError("AI_STORE_REQUIRE_ENCRYPTION=true 但未配置 AI_STORE_ENCRYPTION_KEY，拒绝启动")
        if (self.store_encryption_key or "").strip():
            try:
                from cryptography.fernet import Fernet
                Fernet(self.store_encryption_key.strip().encode("ascii"))
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError("AI_STORE_ENCRYPTION_KEY 非法：必须是 Fernet URL-safe base64 32 字节密钥") from exc

    def first_token_timeout_for(self, task: str) -> float:
        """逐任务首 token 阈值；未配置则回落到全局默认。"""
        override = getattr(self, f"{task}_first_token_timeout", None)
        return float(override) if override else float(self.ollama_first_token_timeout)

    def deepseek_timeout_for(self, task: str, task_timeout: float) -> float:
        """第二级预算：不超过该任务自身 timeout（避免降级把任务拖到上游先超时）。"""
        value = getattr(self, f"{task}_deepseek_timeout", None)
        return min(float(value), float(task_timeout)) if value else float(task_timeout)

    # ---- 统一降级开关取值辅助（2026-11-18）----
    def degrade_mode(self) -> str:
        """full=允许全链路；local=仅本地（外部供应商一律否决）。"""
        return "full" if self.degrade_enabled else "local"

    def capability_enabled(self, capability: str) -> bool:
        """能力级开关（llm/asr/tts/rag）：总开关关闭时外部降级能力一律关闭。"""
        if not self.degrade_enabled:
            return False
        return bool(getattr(self, f"degrade_{capability.lower()}_enabled", False))

    def provider_allowed(self, provider: str) -> bool:
        """供应商是否被允许（master && capability && provider）。

        本地供应商（ollama/funasr/qwen3/规则/缓存）恒允许，不受总开关影响；
        外部供应商在 local 模式下一票否决，调用方必须**直接跳过**，不得建连/重试/探测。
        """
        name = str(provider or "").strip().lower()
        if name in ("ollama", "funasr", "qwen3", "qwen3-tts", "local", "rule", "rules"):
            if name in ("qwen3", "qwen3-tts"):
                return bool(self.tts_qwen3_enabled)
            return True
        # 出境策略 domestic：境外供应商一票否决（审计 H10），与降级总开关正交：
        # 总开关打开表示"允许降级"，出境策略表示"降级也不能出医疗数据"。
        if (self.egress_policy or "domestic") == "domestic":
            return False
        if not self.degrade_enabled:
            return False
        if name == "deepseek":
            return bool(self.degrade_llm_enabled and self.deepseek_enabled)
        if name in ("edge", "edge-tts"):
            return bool(self.degrade_tts_enabled and self.tts_edge_enabled)
        if name in ("wechat_si", "wechatsi", "wechat-si"):
            return bool((self.degrade_asr_enabled or self.degrade_tts_enabled) and self.wechat_si_enabled)
        if name in ("asr_cloud", "cloud_asr", "tencent_asr", "xfyun"):
            return bool(self.degrade_asr_enabled and self.asr_cloud_enabled)
        # 未登记的外部供应商（含 Azure/境内厂商）一律否决：宁可不可用，也不偷偷外联。
        return False

    def tts_engine_candidates(self) -> list[str]:
        """TTS 服务端候选引擎（按配置顺序）；wechat_si 由端侧兜底，不在本服务合成。"""
        alias = {"qwen3-tts": "qwen3", "edge-tts": "edge", "wechatsi": "wechat_si"}
        raw = str(self.tts_engines or "").strip()
        # 兼容：构造时只传了旧字段 tts_engine、或新字段显式 none → 回落到旧字段
        if not raw or raw.lower() == "none":
            raw = str(self.tts_engine or "none")
        result: list[str] = []
        for item in raw.split(","):
            name = alias.get(item.strip().lower(), item.strip().lower())
            if name in ("none", ""):
                continue
            if name not in result:
                result.append(name)
        return result

    def asr_locale_supported(self, locale: "str | None") -> bool:
        """本地 FunASR 只覆盖普通话；粤语/潮汕等必须由端侧或文字通道承接。"""
        value = str(locale or "").strip().lower().replace("_", "-")
        if not value:
            return True
        return value in ("zh", "zh-cn", "zh-hans", "cmn", "mandarin")


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
        "ttsEngine": ",".join(settings.tts_engine_candidates()) or "none",
        "ttsStream": "on" if settings.tts_stream else "off",
        # 统一降级开关：只报模式与生效的供应商，便于运维一眼确认「是不是只跑本地」
        "degradeMode": settings.degrade_mode(),
        "degradeCapabilities": ",".join(
            name for name in ("llm", "asr", "tts", "rag") if settings.capability_enabled(name)
        ) or "none",
        "degradeProviders": ",".join(
            name for name in ("deepseek", "edge", "wechat_si", "asr_cloud")
            if settings.provider_allowed(name)
        ) or "none",
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
        # B2 三步走：只报状态与名字，**不回显 base URL / key**
        "providerOrder": ",".join(
            p.strip().lower() for p in str(settings.provider_order or "").split(",") if p.strip()
        ),
        "deepseek": ("configured" if settings.provider_allowed("deepseek")
                     and settings.deepseek_api_key else "denied_by_switch"),
        "deepseekModel": settings.deepseek_model
                          if settings.provider_allowed("deepseek") and settings.deepseek_api_key else "n/a",
        "fallback": "on" if (settings.provider_allowed("deepseek") and settings.deepseek_api_key) else "off",
        "firstTokenTimeout": float(settings.ollama_first_token_timeout),
        "breaker": f"{int(settings.breaker_failures)}/{float(settings.breaker_cooldown_seconds):.0f}s",
    }


def format_config_summary(summary: dict) -> str:
    """把摘要压成一行 `key=value | ...`（供启动日志使用，便于 grep）。"""
    return " | ".join(f"{key}={value}" for key, value in summary.items())
