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

_STORE_VERSION = 1

logger = logging.getLogger("ai-service.store")

#: `os.replace` 重试的退避梯度（秒）。合计约 155ms，覆盖杀毒/索引服务的瞬时占用，
#: 又不至于把一次落盘拖成秒级（任务阶段推进是热路径）。
_REPLACE_BACKOFF = (0.01, 0.02, 0.04, 0.08)


class TaskStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
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
                self.tasks = raw.get("tasks") or {}
                self.idempotency = raw.get("idempotency") or {}
            except (OSError, json.JSONDecodeError):
                # 存储损坏不是数据丢失：丢弃中间态，从头开始。
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
                payload = {
                    "version": _STORE_VERSION,
                    "tasks": self.tasks,
                    "idempotency": self.idempotency,
                }
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=None), encoding="utf-8")
                # 重试用 await asyncio.sleep：本方法是协程且持锁，同步 sleep 会把事件循环
                # 整体卡住（推理任务的状态推进也走这条锁），退避 155ms 就会连带拖慢请求。
                await _replace_with_retry(tmp, self.path)
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
