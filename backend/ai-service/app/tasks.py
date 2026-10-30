"""任务编排：状态机、幂等、取消与执行器注册表。

状态机（对齐 TaskStatus）：QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED | EXPIRED。
约束：轮询只有见到终态才算结束；任何人不得以"等待回调"为由把任务永久留在 RUNNING（O-02）。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from contextlib import suppress
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional

from .cache import ContentCache, compute_cache_key, resolve_tenant_secret
from .config import APP_VERSION, Settings
from .envelope import idempotency_conflict, queue_full
from .knowledge import get_knowledge_loader
from .models import ModelProfile, TaskSubmitRequest, TaskType
from .store import TaskStore

logger = logging.getLogger("ai-service.tasks")

TERMINAL = {"SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"}
_ACTIVE = {"QUEUED", "RUNNING"}
VALID_PHASES = {"safety_check", "retrieval", "generation", "postprocess", "synthesis"}

# 任务类型缺失时报告哪一类能力（CAPABILITY_UNAVAILABLE 的 dependency 取值）
_DEPENDENCY_BY_TYPE = {
    TaskType.TRIAGE: "ollama",
    TaskType.CHAT: "ollama",
    TaskType.RAG: "ollama",
    TaskType.CARE_PLAN: "ollama",
    TaskType.INTERPRET: "ollama",
    TaskType.ASR: "asr_model",
    TaskType.TTS: "tts_provider",
}

_VIEW_KEYS = [
    "taskId", "tenantId", "taskType", "status", "priority", "progressPhase",
    "modelProfile", "modelId", "modelVersion", "quantization",
    "promptTemplateVersion", "policyVersion", "knowledgeSnapshot",
    "result", "error", "cached", "createdAt", "startedAt", "finishedAt", "expiresAt",
]


def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _payload_digest(req: TaskSubmitRequest) -> str:
    canonical = json.dumps(req.model_dump(by_alias=True), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class TaskFailure(Exception):
    """执行器可抛出的结构化失败（映射到 TaskError）。"""

    def __init__(self, code: str, message: str, dependency: Optional[str] = None, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.dependency = dependency
        self.retryable = retryable


class TaskCancelled(Exception):
    """执行器观察到取消信号后抛出（协作式取消）。"""


class TaskContext:
    """传给执行器的上下文：阶段名与取消检查。"""

    def __init__(self, service: "TaskService", task: dict) -> None:
        self._service = service
        self.task = task

    @property
    def cancelled(self) -> bool:
        return self._service.is_cancelled(self.task["taskId"])

    async def set_phase(self, phase: str) -> None:
        """记录阶段名（**不是百分比**；模型不提供的精度不得伪造）。"""
        if phase not in VALID_PHASES:
            raise ValueError(f"非法阶段名：{phase}")
        if self.cancelled:
            raise TaskCancelled()
        self.task["progressPhase"] = phase
        await self._service.store.put(self.task)

    def checkpoint(self) -> None:
        if self.cancelled:
            raise TaskCancelled()


Executor = Callable[[dict, TaskContext], Awaitable[dict]]


def _default_model_resolver(settings: Settings, profile: Optional[str]) -> str:
    """资源档 → 模型名兜底实现（生产由 create_app 注入 executors._llm.resolve_model，保持单一事实源）。"""
    return settings.large_model if profile == ModelProfile.LARGE.value else settings.small_model


def _knowledge_snapshot(settings: Settings) -> str:
    """院内知识库版本（进缓存键）；缺失/损坏 → "unknown"（降级，不阻断受理）。"""
    try:
        return get_knowledge_loader(settings.knowledge_base_path).version
    except Exception:  # pragma: no cover - 摘要/键计算都不该阻断任务受理
        return "unknown"


class TaskService:
    def __init__(
        self,
        store: TaskStore,
        settings: Settings,
        cache: Optional[ContentCache] = None,
        model_resolver: Optional[Callable[[Settings, Optional[str]], str]] = None,
    ) -> None:
        self.store = store
        self.settings = settings
        self.cache = cache
        # 租户密钥：仅在启用缓存时确定（空配置 → 进程内随机；日志只打印是否显式配置，不打印值）。
        self.cache_secret = resolve_tenant_secret(settings.tenant_secret) if cache is not None else ""
        self._model_resolver = model_resolver or _default_model_resolver
        # 知识库版本入缓存键（2026-10-22）：否则改 hospital-knowledge.json 后，
        # TTL 内仍会命中旧答案（错误口径）。取不到就是 unknown，不阻断受理。
        self.knowledge_snapshot = _knowledge_snapshot(settings)
        self._cache_descriptors: dict[TaskType, dict] = {}
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=settings.queue_max)
        self._executors: dict[TaskType, Executor] = {}
        self._cancel_flags: set[str] = set()
        # 并发 worker 池（2026-10-22 优化）：默认 1 = 旧的单 worker 行为。
        # 队列自身 maxsize=queue_max 提供背压，避免突发打爆本机 Ollama。
        self._pool_size = max(1, int(settings.llm_worker_pool_size))
        self._workers: list[asyncio.Task] = []
        self._supervisor: Optional[asyncio.Task] = None
        self._processed = 0

    def register_executor(
        self, task_type: TaskType, executor: Executor, cache_descriptor: Optional[dict] = None
    ) -> None:
        """注册执行器；`cache_descriptor`（如 promptTemplateVersion）表示该类型参与内容寻址缓存。"""
        self._executors[task_type] = executor
        if cache_descriptor is not None:
            self._cache_descriptors[task_type] = dict(cache_descriptor)

    @property
    def executor_count(self) -> int:
        return len(self._executors)

    @property
    def cache_enabled(self) -> bool:
        return self.cache is not None and bool(self._cache_descriptors)

    async def start(self) -> None:
        """启动 worker 池。

        - 默认 pool_size=1：与旧版完全一致（单个消费协程）。
        - pool_size>1：并发消费队列，提升 Ollama 吞吐；若创建阶段异常，回退单 worker 并 WARN。
        - pool_size>1 时额外启动 supervisor，监测任一 worker 异常退出即回退单 worker。
        """
        size = self._pool_size
        try:
            self._workers = [
                asyncio.create_task(self._run_worker(), name=f"ai-task-worker-{i}")
                for i in range(size)
            ]
        except Exception as exc:  # pragma: no cover - 创建任务几乎不会失败；仅作防御性回退
            logger.warning("worker 池创建失败，回退单 worker | reason=%s", exc)
            self._workers = [asyncio.create_task(self._run_worker(), name="ai-task-worker")]
        if not self._workers:  # pragma: no cover
            self._workers = [asyncio.create_task(self._run_worker(), name="ai-task-worker")]

        if len(self._workers) > 1:
            logger.info("已启动 LLM 任务 worker 池 | size=%d（队列上限=%d 提供背压）",
                        len(self._workers), self.settings.queue_max)
            self._supervisor = asyncio.create_task(self._supervise(), name="ai-task-supervisor")
        else:
            logger.debug("已启动单 worker（默认并发=1）")

    async def stop(self) -> None:
        if self._supervisor is not None:
            self._supervisor.cancel()
            with suppress(asyncio.CancelledError):
                await self._supervisor
            self._supervisor = None
        for w in self._workers:
            w.cancel()
        for w in self._workers:
            with suppress(asyncio.CancelledError):
                await w
        self._workers.clear()
        await self.store.save()

    async def _supervise(self) -> None:
        """监督 worker 池：任一 worker 非预期退出（异常）即回退单 worker 模式并告警。

        正常关闭由 `stop()` 经 cancel 处理，cancel 的任务 `cancelled()==True`，不会被本监督器误判。
        """
        try:
            while True:
                await asyncio.sleep(0.5)
                for w in list(self._workers):
                    if w.done() and not w.cancelled():
                        logger.warning("worker 异常退出，回退单 worker 模式 | worker=%s", w.get_name())
                        # 取消并回收全部现有 worker，再以单 worker 重启
                        # 回收时吞掉各 worker 的退出异常（崩溃 worker 的异常正是我们要处理的）
                        for x in self._workers:
                            x.cancel()
                        for x in self._workers:
                            with suppress(BaseException):
                                await x
                        self._workers = [asyncio.create_task(self._run_worker(), name="ai-task-worker")]
                        return  # 单 worker 模式不再监督
        except asyncio.CancelledError:
            raise

    def is_cancelled(self, task_id: str) -> bool:
        return task_id in self._cancel_flags

    # ---------- 对外操作 ----------

    async def submit(self, req: TaskSubmitRequest, idempotency_key: str, request_id: str) -> tuple[dict, bool]:
        """返回 (任务视图, 是否新建)。相同键相同载荷 → 返回既有任务；不同载荷 → 409。"""
        digest = _payload_digest(req)
        existing = self.store.get_idempotency(idempotency_key)
        if existing is not None:
            if existing.get("digest") != digest:
                raise idempotency_conflict()
            task = self.store.get(existing.get("taskId", ""))
            if task is not None:
                return self._view(task), False
            raise idempotency_conflict("幂等键对应的任务已超过保留期，请使用新键重新提交")

        if self._queue.full():
            raise queue_full()

        now = _now()
        task: dict = {
            "taskId": "t_" + uuid.uuid4().hex[:16],
            "tenantId": req.tenant_id,
            "taskType": req.task_type.value,
            "status": "QUEUED",
            "priority": req.priority.value,
            "progressPhase": None,
            "modelProfile": (req.requested_profile or ModelProfile.SMALL).value,
            "modelId": None,
            "modelVersion": None,
            "quantization": None,
            "promptTemplateVersion": None,
            "policyVersion": req.policy_version,
            "knowledgeSnapshot": self.knowledge_snapshot,
            "result": None,
            "error": None,
            "cached": None,
            "createdAt": _iso(now),
            "startedAt": None,
            "finishedAt": None,
            "expiresAt": None,
            # 内部字段（响应视图不含）
            "userId": req.user_id,
            "traceId": req.trace_id,
            "inputRef": req.input_ref,
            "inputInline": req.input_inline,
            "voice": req.voice,
            "locale": req.locale,
            "generationParameters": (
                req.generation_parameters.model_dump(by_alias=True) if req.generation_parameters else None
            ),
            "submitRequestId": request_id,
        }
        await self.store.put(task)
        await self.store.put_idempotency(idempotency_key, task["taskId"], digest)
        self._queue.put_nowait(task["taskId"])
        logger.info("任务已受理 task=%s type=%s", task["taskId"], task["taskType"])
        return self._view(task), True

    async def get_view(self, task_id: str) -> Optional[dict]:
        task = self.store.get(task_id)
        if task is None:
            return None
        if self._expire(task):
            await self.store.save()
        return self._view(task)

    async def cancel(self, task_id: str, reason: Optional[str]) -> Optional[dict]:
        task = self.store.get(task_id)
        if task is None:
            return None
        if task["status"] in TERMINAL:
            # 幂等：对终态任务重复取消返回同一终态，不报错。
            return self._view(task)
        self._cancel_flags.add(task_id)
        task["status"] = "CANCELLED"
        task["result"] = None
        task["finishedAt"] = _iso(_now())
        await self.store.save()
        logger.info("任务已取消 task=%s reason=%s", task_id, reason or "UNSPECIFIED")
        return self._view(task)

    # ---------- 工作器 ----------

    async def _run_worker(self) -> None:
        while True:
            task_id = await self._queue.get()
            try:
                await self._process(task_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("任务处理异常 task=%s", task_id)
            finally:
                self._queue.task_done()

    async def _process(self, task_id: str) -> None:
        task = self.store.get(task_id)
        if task is None:
            return
        if self._expire(task):
            await self.store.save()
            return
        if task["status"] != "QUEUED" or self.is_cancelled(task_id):
            return

        task["status"] = "RUNNING"
        task["startedAt"] = _iso(_now())
        await self.store.save()
        if self.is_cancelled(task_id):
            return

        # 内容寻址缓存命中（D2.4）：命中即回填结果，**不消耗模型算力**、不调执行器。
        cache_key = self._cache_key(task)
        if cache_key is not None:
            entry = self.cache.get(cache_key)
            if entry is not None and isinstance(entry.get("result"), dict):
                logger.info(
                    "缓存命中 | task=%s | type=%s | 剩余算力节省=真实计算",
                    task["taskId"], task["taskType"]
                )
                self._succeed_from_cache(task, entry)
                self._processed += 1
                await self.store.save()
                return
            else:
                logger.debug("缓存未命中 | task=%s | type=%s | 将真实计算", task["taskId"], task["taskType"])

        executor = self._executors.get(TaskType(task["taskType"]))
        if executor is None:
            self._fail(
                task,
                code="CAPABILITY_UNAVAILABLE",
                message=f"任务类型 {task['taskType']} 的执行器尚未接入（{APP_VERSION}，按里程碑接入）",
                dependency=_DEPENDENCY_BY_TYPE.get(TaskType(task["taskType"])),
                retryable=False,
            )
            await self.store.save()
            return

        ctx = TaskContext(self, task)
        remaining = self._remaining_budget(task)
        if remaining <= 0:
            self._expire_force(task)
            await self.store.save()
            return
        try:
            output = await asyncio.wait_for(executor(task, ctx), timeout=remaining)
        except asyncio.TimeoutError:
            self._fail(task, "MODEL_TIMEOUT", "任务执行超过总超时预算", _DEPENDENCY_BY_TYPE.get(TaskType(task["taskType"])), True)
        except TaskCancelled:
            if task["status"] not in TERMINAL:
                task["status"] = "CANCELLED"
                task["result"] = None
                task["finishedAt"] = _iso(_now())
        except TaskFailure as exc:
            self._fail(task, exc.code, exc.message, exc.dependency, exc.retryable)
        except Exception:
            logger.exception("执行器异常 task=%s", task_id)
            self._fail(task, "INTERNAL_ERROR", "执行器内部错误（已记录，请联系运维）", None, False)
        else:
            if self.is_cancelled(task_id) or task["status"] == "CANCELLED":
                pass  # 尽力取消：已产生的部分结果不回滚，但不标记为成功
            else:
                self._succeed(task, output)
                await self._cache_remember(task, output, cache_key)
        self._processed += 1
        if self._processed % 50 == 0:
            self._prune()
        await self.store.save()

    # ---------- 内部工具 ----------

    def _succeed(self, task: dict, output: dict) -> None:
        model = output.get("model") or {}
        task["status"] = "SUCCEEDED"
        task["result"] = output.get("result")
        task["error"] = None
        task["progressPhase"] = None
        for key in ("modelProfile", "modelId", "modelVersion", "quantization",
                    "promptTemplateVersion", "knowledgeSnapshot", "cached"):
            if key in model and model[key] is not None:
                task[key] = model[key]
        finished = _now()
        task["finishedAt"] = _iso(finished)
        task["expiresAt"] = _iso(finished + _seconds(self.settings.result_ttl_seconds))

    # ---------- 内容寻址缓存（D2.4）----------

    def _cache_key(self, task: dict) -> Optional[str]:
        """计算本任务的内容寻址键；未启用缓存 / 类型不在白名单 / 无文本输入 → None。"""
        if self.cache is None:
            return None
        task_type = task.get("taskType")
        try:
            descriptor = self._cache_descriptors.get(TaskType(task_type))
        except ValueError:
            descriptor = None
        if descriptor is None:
            return None
        model_id = self._model_resolver(self.settings, task.get("modelProfile"))
        return compute_cache_key(
            task,
            tenant_secret=self.cache_secret,
            prompt_template_version=descriptor.get("promptTemplateVersion", ""),
            model_id=model_id,
        )

    def _succeed_from_cache(self, task: dict, entry: dict) -> None:
        """缓存命中：回填结果与版本元信息，`cached=true`（如实标注该结果来自缓存）。"""
        model = entry.get("model") or {}
        task["status"] = "SUCCEEDED"
        task["result"] = entry.get("result")
        task["error"] = None
        task["progressPhase"] = None
        for key in ("modelId", "modelVersion", "quantization", "promptTemplateVersion", "knowledgeSnapshot"):
            if model.get(key) is not None:
                task[key] = model[key]
        task["cached"] = True
        finished = _now()
        task["finishedAt"] = _iso(finished)
        task["expiresAt"] = _iso(finished + _seconds(self.settings.result_ttl_seconds))
        logger.info("任务命中内容寻址缓存 task=%s", task["taskId"])

    async def _cache_remember(self, task: dict, output: dict, cache_key: Optional[str]) -> None:
        """真实计算成功后写缓存。仅成功且**非拒答**的结果入库（拒答与输入强相关，复用无意义）。"""
        if self.cache is None or cache_key is None or task.get("status") != "SUCCEEDED":
            return
        result = task.get("result")
        if not isinstance(result, dict) or result.get("refused") is True:
            return
        await self.cache.put(cache_key, result, output.get("model"))
        logger.info(
            "缓存已更新 | task=%s | type=%s | 总条目=%d | 命中率=%.1f%%",
            task["taskId"], task["taskType"], len(self.cache.entries),
            100 * self.cache.hits / max(1, self.cache.hits + self.cache.misses)
        )
        if task.get("cached") is None:
            task["cached"] = False  # 如实：本次为真实计算，未命中缓存

    def _fail(self, task: dict, code: str, message: str, dependency: Optional[str], retryable: bool) -> None:
        task["status"] = "FAILED"
        task["result"] = None
        task["error"] = {
            "code": code,
            "message": message,
            "dependency": dependency,
            "retryable": retryable,
        }
        finished = _now()
        task["finishedAt"] = _iso(finished)
        task["expiresAt"] = _iso(finished + _seconds(self.settings.result_ttl_seconds))

    def _expire(self, task: dict, now: Optional[datetime] = None) -> bool:
        """按需推进过期状态。返回是否发生了变更。"""
        status = task["status"]
        now = now or _now()
        if status in _ACTIVE:
            created = _parse_ts(task.get("createdAt"))
            if created is not None and (now - created).total_seconds() > self.settings.task_timeout_seconds:
                self._expire_force(task)
                return True
            return False
        if status in TERMINAL and status != "EXPIRED":
            expires_at = _parse_ts(task.get("expiresAt"))
            if expires_at is not None and now > expires_at:
                task["status"] = "EXPIRED"
                task["result"] = None
                task["error"] = None
                return True
        return False

    def _expire_force(self, task: dict) -> None:
        task["status"] = "EXPIRED"
        task["result"] = None
        task["error"] = None
        task["finishedAt"] = _iso(_now())

    def _remaining_budget(self, task: dict) -> float:
        created = _parse_ts(task.get("createdAt"))
        if created is None:
            return float(self.settings.task_timeout_seconds)
        spent = (_now() - created).total_seconds()
        return max(0.0, self.settings.task_timeout_seconds - spent)

    def _prune(self, now: Optional[datetime] = None) -> int:
        """裁剪超过保留期（`task_retention_seconds`，默认 24h）的历史任务。返回移除数量。"""
        cutoff = (now or _now()) - _seconds(self.settings.task_retention_seconds)
        keep = set()
        for tid, task in self.store.tasks.items():
            created = _parse_ts(task.get("createdAt"))
            if created is not None and created > cutoff:
                keep.add(tid)
        removed = self.store.prune(keep)
        if removed:
            # 同步清理已失效的幂等索引
            stale = [k for k, v in self.store.idempotency.items() if v.get("taskId") not in keep]
            for k in stale:
                self.store.idempotency.pop(k, None)
            logger.info("裁剪历史任务 %d 条", removed)
        return removed

    async def sweep(self, now: Optional[datetime] = None) -> dict:
        """周期清理（M4 硬化前瞻）：推进过期态 + 按保留期裁剪历史任务。

        与「每 50 个任务顺手 prune」互补：后者只在有流量时触发，空闲进程不会回收；
        本方法由 main 的周期任务驱动（`sweep_interval_seconds`），保证**空闲也回收**。
        无异步 IO 之外的外部依赖，可被测试直接调用。
        """
        snap = now or _now()
        expired = 0
        for task in list(self.store.tasks.values()):
            if self._expire(task, now=snap):
                expired += 1
        removed = self._prune(now=snap)
        if expired or removed:
            await self.store.save()
            logger.info("周期清理：过期 %d 条 / 裁剪 %d 条 / 在库 %d", expired, removed, len(self.store.tasks))
        return {"expired": expired, "pruned": removed, "remaining": len(self.store.tasks)}

    def _view(self, task: dict) -> dict:
        return {key: task.get(key) for key in _VIEW_KEYS}


def _seconds(count: int):
    from datetime import timedelta

    return timedelta(seconds=count)
