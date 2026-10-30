"""内容寻址缓存（M2 · D2.4）。

键设计对齐 `docs/v4/04-FastAPI-AI后端开发指南.md` §9.2：

    inputDigest = SHA-256(canonicalBytes)
    cacheKey    = HMAC-SHA256(tenantSecret,
                    taskType | inputDigest | modelId | modelVersion | quantization |
                    promptTemplateVersion | policyVersion | knowledgeSnapshot |
                    voice | locale | generationParameters)

纪律（同 §9.1 / §9.3，违反即返工）：
- 缓存**不是**权威业务数据（权威在 Spring Boot / MySQL）；Redis 缺 → 本机 JSON 文件实现，
  重启可失（可重建）。
- **敏感原文不进键、不进日志**：进键前先 SHA-256，键里只剩摘要与版本元数据。
- 规范化**不得**为提高命中率而合并不同含义：只做 NFC 归一 + 首尾空白折叠，
  原文中的数字、单位、否定词、时间一律保留原样（不做「有点/很/挺」之类宽松折叠）。
- 只缓存**成功且非拒答**的生成类任务（白名单）；ASR 音频不可复用、TTS 另走产物级内容寻址
  （见 `executors/tts.py` 的 cached 语义），均不并入本缓存。
- 租户隔离：tenantSecret 参与 HMAC；换 secret / 换租户即换键，不跨租户命中。
  注意：本服务只有一个进程级 secret，故键中**额外并入 `tenantId`**（§9.2 之外的收窄），
  以隔离同进程内的不同租户（详见 `compute_cache_key`）。
- **权限先于缓存命中（O-03 铁律，用户裁定 2026-10-15）**：本缓存**只**运行在 ai-service 进程内，
  该进程在网络与契约上均仅内网可达（`/internal/**`，由 business-service 编排调用）；命中发生在
  业务侧完成租户隔离 / 鉴权 / 角色校验**之后**的任务受理流程里。因此**不得**把该缓存下沉到网关或
  任何对客户端暴露的路径——否则未授权的、构造相同 `inputDigest` 的请求会直接命中他人结果。
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import unicodedata
from pathlib import Path
from typing import Optional

logger = logging.getLogger("ai-service.cache")

# 参与内容寻址缓存的任务类型白名单（生成类；ASR/TTS 见模块 docstring）。
# ⚠️ 必须与 executors/__init__.py 的 CACHE_DESCRIPTORS 对齐：缺任意一项 → 该类型登记了缓存
#    却永远拿不到键（compute_cache_key 返回 None），等于"登记了但没生效"（2026-10-23 修复 INTERPRET）。
CACHEABLE_TYPES = frozenset({"TRIAGE", "CHAT", "RAG", "CARE_PLAN", "INTERPRET"})

_CACHE_VERSION = 1
_KEY_JOIN = "|"
_MODEL_META_KEYS = (
    "modelId", "modelVersion", "quantization", "promptTemplateVersion", "knowledgeSnapshot",
)


def resolve_tenant_secret(configured: str) -> str:
    """租户密钥：空 → 进程内随机（重启即换键，旧条目自然失效，符合「可失」语义）。"""
    return configured or secrets.token_hex(32)


def canonical_bytes(text: str) -> bytes:
    """规范化：NFC 归一 + 首尾空白折叠。

    有意**不做**宽松折叠（不像前端 `normalizeLoose` 那样合并程度副词）：
    避免把「有点疼」与「非常疼」这类不同含义合并成同一缓存键。
    """
    return unicodedata.normalize("NFC", text or "").strip().encode("utf-8")


def input_digest(text: str) -> str:
    return hashlib.sha256(canonical_bytes(text)).hexdigest()


def _component(value) -> str:
    """把单个键分量稳定序列化（dict/list 排序后紧凑 JSON；None → 空串）。"""
    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def compute_cache_key(
    task: dict,
    *,
    tenant_secret: str,
    prompt_template_version: str = "",
    model_id: str = "",
) -> Optional[str]:
    """按 §9.2 计算内容寻址键。

    非白名单类型 / 无文本输入 → None（该任务不参与缓存，调用方跳过即可）。
    """
    task_type = str(task.get("taskType") or "")
    if task_type not in CACHEABLE_TYPES:
        return None
    text = str(task.get("inputInline") or "").strip()
    if not text:
        return None
    message = _KEY_JOIN.join([
        task_type,
        # tenantId 在 §9.2 分量之外**额外加入**：本服务只有一个进程级 tenantSecret，
        # 仅靠 secret 无法区分同进程内的不同租户 → 显式并入 tenantId 做隔离（收窄复用，不放大）。
        _component(task.get("tenantId")),
        input_digest(text),
        _component(model_id),                                  # 本次将要用的模型（执行前即可知）
        _component(task.get("modelVersion")),
        _component(task.get("quantization")),
        _component(prompt_template_version),
        _component(task.get("policyVersion")),
        _component(task.get("knowledgeSnapshot")),
        _component(task.get("voice")),
        _component(task.get("locale")),
        _component(task.get("generationParameters")),
    ])
    return hmac.new(tenant_secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def model_meta(source: Optional[dict]) -> dict:
    """从模型元信息里挑出参与「版本失效」的字段（结果值本身不参与）。"""
    source = source or {}
    return {key: source.get(key) for key in _MODEL_META_KEYS if source.get(key) is not None}


class ContentCache:
    """本机 JSON 文件实现（Redis 缺省时的降级）：单进程锁 + 原子替换。

    进程内另有内存字典作为一级读缓存；`get` 命中即不触盘。
    """

    def __init__(self, path: Path, ttl_seconds: int = 3600) -> None:
        self.path = Path(path)
        self.ttl_seconds = max(1, int(ttl_seconds))
        self._lock = asyncio.Lock()
        self.entries: dict[str, dict] = {}
        self.hits = 0
        self.misses = 0

    async def load(self) -> None:
        async with self._lock:
            self.entries = {}
            if not self.path.exists():
                return
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                # 缓存损坏不是数据丢失：丢弃重建（非权威数据）。
                logger.warning("缓存文件损坏，已丢弃重建：%s", self.path)
                return
            if raw.get("version") != _CACHE_VERSION:
                return
            self.entries = {
                key: value for key, value in (raw.get("entries") or {}).items() if isinstance(value, dict)
            }

    async def save(self) -> None:
        async with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"version": _CACHE_VERSION, "entries": self.entries}
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self.path)

    def get(self, key: str) -> Optional[dict]:
        """命中返回条目副本；过期/缺失返回 None（过期即顺手剔除）。"""
        entry = self.entries.get(key)
        if entry is None:
            self.misses += 1
            return None
        if float(entry.get("expiresAt") or 0) <= time.time():
            self.entries.pop(key, None)
            self.misses += 1
            return None
        self.hits += 1
        return entry

    async def put(self, key: str, result: dict, model: Optional[dict]) -> None:
        self.entries[key] = {
            "result": result,
            "model": model_meta(model),
            "createdAt": time.time(),
            "expiresAt": time.time() + self.ttl_seconds,
        }
        await self.save()

    def prune(self) -> int:
        """剔除过期条目，返回剔除数量。"""
        now = time.time()
        stale = [key for key, entry in self.entries.items() if float(entry.get("expiresAt") or 0) <= now]
        for key in stale:
            self.entries.pop(key, None)
        return len(stale)

    def stats(self) -> dict:
        return {
            "entries": len(self.entries),
            "hits": self.hits,
            "misses": self.misses,
            "ttlSeconds": self.ttl_seconds,
        }
