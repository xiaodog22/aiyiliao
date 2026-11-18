"""任务存储：内存字典 + JSON 文件落盘（原子替换）。

M0 骨架档实现说明：
- 契约允许"Redis 丢失不构成数据丢失"——这里的文件存储同样是**可重建的中间态**，
  不是业务权威数据（权威记录在 Spring Boot / MySQL）。
- 单进程 asyncio 锁保护；写入用 临时文件 + os.replace 原子替换。

⚠️ 落盘失败不得让任务失败（2026-11-12 缺陷 DEF-06 / BUG-06）：
Windows 上 `os.replace` 会因目标文件被其他句柄占用（杀毒/索引/并发读）抛
`PermissionError: [WinError 5]`。原实现无 try/except、无重试：
- 在「完成回写」阶段抛 → 结果丢失、business 侧任务永远 QUEUED（前端一直转圈）；
- 在 `set_phase` 阶段抛 → 任务直接 FAILED（模型其实已经跑完了）。
本文件自述的定位是「可重建的中间态」，所以落盘失败的正确语义是**少一次快照**，
而不是让整条任务失败：这里对瞬时占用做指数退避重试，最终仍失败则告警并返回 False。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

_STORE_VERSION = 1
_RESULT_ENC_MARKER = "__fernet_v1__"

#: 终态集合（与 tasks.TERMINAL 同义；此处独立定义避免 store ↔ tasks 循环导入）
_TERMINAL_STATUSES = frozenset({"SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"})

logger = logging.getLogger("ai-service.store")

#: `os.replace` 重试的退避梯度（秒）。合计约 155ms，覆盖杀毒/索引服务的瞬时占用，
#: 又不至于把一次落盘拖成秒级（任务阶段推进是热路径）。
_REPLACE_BACKOFF = (0.01, 0.02, 0.04, 0.08)


def _harden_file(path: Path, mode: int) -> None:
    """审计 M2：任务/缓存快照含 PHI，落盘文件仅属主可读；目录仅属主可进入。

    Windows 的 chmod 语义有限（会被映射为只读位），失败不影响功能，只留 WARN；
    Linux 容器/主机上必须生效（0600/0700 是真正的访问边界）。
    """
    try:
        os.chmod(path, mode)
    except OSError as exc:
        logger.debug("chmod 未生效 path=%s mode=%o err=%s", path.name, mode, exc.__class__.__name__)


class TaskStore:
    def __init__(self, path: Path, encryption_key: str = "") -> None:
        self.path = Path(path)
        key = (encryption_key or "").strip()
        self._fernet = Fernet(key.encode("ascii")) if key else None
        self._lock = asyncio.Lock()
        self.tasks: dict[str, dict] = {}
        self.idempotency: dict[str, dict] = {}

    async def load(self) -> None:
        async with self._lock:
            if not self.path.exists():
                self.tasks = {}
                self.idempotency = {}
                return
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                self.tasks = self._decrypt_tasks(raw.get("tasks") or {})
                self.idempotency = raw.get("idempotency") or {}
            except (OSError, json.JSONDecodeError):
                # 存储损坏不是数据丢失：丢弃中间态，从头开始。
                self.tasks = {}
                self.idempotency = {}
            except InvalidToken:
                # 密钥不匹配/密文被篡改：不把半解密数据带进内存；任务本身是中间态。
                logger.error("任务快照解密失败（AI_STORE_ENCRYPTION_KEY 不匹配或被篡改），丢弃快照")
                self.tasks = {}
                self.idempotency = {}

    async def save(self) -> bool:
        """落盘当前快照；返回 True=已写入，False=本次快照失败（不影响内存态与任务状态）。

        失败语义见模块头注释：存储是「可重建的中间态」，写不进去只是少一次快照，
        绝不能把异常抛给任务执行链（否则结果丢失 / 任务假 FAILED）。
        """
        async with self._lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                _harden_file(self.path.parent, 0o700)
                payload = {
                    "version": _STORE_VERSION,
                    "tasks": self._tasks_for_disk(),
                    "idempotency": self.idempotency,
                }
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=None), encoding="utf-8")
                _harden_file(tmp, 0o600)
                await _replace_with_retry(tmp, self.path)
                _harden_file(self.path, 0o600)
                # 重试用 await asyncio.sleep：本方法是协程且持锁，同步 sleep 会把事件循环
                # 整体卡住（推理任务的状态推进也走这条锁），退避 155ms 就会连带拖慢请求。
                return True
            except OSError as exc:
                # 典型：Windows WinError 5（目标被占用）、磁盘满、只读挂载。
                # 清理残留 .tmp，避免下次写入前留下半成品（.tmp 会被覆盖，但脏文件会误导排障）。
                try:
                    self.path.with_suffix(".tmp").unlink(missing_ok=True)
                except OSError:
                    pass
                logger.warning(
                    "任务快照落盘失败（内存态保留，任务继续）path=%s err=%s",
                    self.path.name,
                    exc.__class__.__name__,
                )
                return False

    # ---- 任务 ----

    def _decrypt_tasks(self, tasks: dict) -> dict:
        if self._fernet is None:
            return tasks
        out = {}
        for task_id, task in tasks.items():
            item = dict(task)
            result = item.get("result")
            if isinstance(result, dict) and result.get(_RESULT_ENC_MARKER) is not None:
                payload = self._fernet.decrypt(str(result[_RESULT_ENC_MARKER]).encode("ascii"))
                item["result"] = json.loads(payload.decode("utf-8"))
            out[task_id] = item
        return out

    def _result_for_disk(self, result):
        if self._fernet is None or not isinstance(result, dict):
            return result
        token = self._fernet.encrypt(json.dumps(result, ensure_ascii=False).encode("utf-8")).decode("ascii")
        return {_RESULT_ENC_MARKER: token}

    def _tasks_for_disk(self) -> dict:
        """落盘前的 PHI 收敛（审计 M2）。

        `tasks.json` 原先原样保存 `inputInline`（患者症状/对话原文），保留 24h 且无加密：
        任何能读该文件的主机进程/运维动作都能拿到全量 PHI 时序档案。
        终态任务不再需要 inputInline（不会被重新执行），因此落盘时剥掉；
        QUEUED/RUNNING 仍保留 —— 那样重启后还能续跑，功能不受影响。
        """
        out: dict = {}
        for task_id, task in self.tasks.items():
            item = task
            if task.get("status") in _TERMINAL_STATUSES and task.get("inputInline") is not None:
                item = dict(item)
                item["inputInline"] = None
            if self._fernet is not None and isinstance(item.get("result"), dict):
                if item is task:
                    item = dict(item)
                item["result"] = self._result_for_disk(item["result"])
            out[task_id] = item
        return out

    def get(self, task_id: str) -> Optional[dict]:
        task = self.tasks.get(task_id)
        return task

    async def put(self, task: dict) -> None:
        self.tasks[task["taskId"]] = task
        await self.save()

    def all(self) -> list[dict]:
        return list(self.tasks.values())

    def prune(self, keep_ids: set[str]) -> int:
        """裁剪存储：保留 keep_ids 内的任务，其余移除。返回移除数量。"""
        removed = [tid for tid in list(self.tasks.keys()) if tid not in keep_ids]
        for tid in removed:
            self.tasks.pop(tid, None)
        return len(removed)

    # ---- 幂等索引 ----

    def get_idempotency(self, key: str) -> Optional[dict]:
        return self.idempotency.get(key)

    async def put_idempotency(self, key: str, task_id: str, digest: str) -> None:
        self.idempotency[key] = {"taskId": task_id, "digest": digest}
        await self.save()


async def _replace_with_retry(tmp: Path, target: Path) -> None:
    """原子替换 + 瞬时占用退避重试。

    Windows 的 `os.replace` 在目标文件被其他进程/线程持有句柄时会抛 `PermissionError`
    （WinError 5），而杀毒扫描、搜索索引、并发读都可能在毫秒级持有该句柄 —— 这类占用是
    瞬时的，退避几次即可成功。**只在 PermissionError 上重试**：目标不存在、磁盘满、
    路径非法等错误立即上抛，不做无意义的重试掩盖真实原因。

    退避用 `await asyncio.sleep`（本函数只被 `save()` 的协程调用）：换成 `time.sleep`
    会在持锁期间阻塞整个事件循环。
    """
    last: OSError | None = None
    for delay in (0.0,) + _REPLACE_BACKOFF:
        if delay:
            await asyncio.sleep(delay)
        try:
            os.replace(tmp, target)
            return
        except PermissionError as exc:  # WinError 5 / EACCES
            last = exc
    raise last  # type: ignore[misc]
