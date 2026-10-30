"""任务存储：内存字典 + JSON 文件落盘（原子替换）。

M0 骨架档实现说明：
- 契约允许"Redis 丢失不构成数据丢失"——这里的文件存储同样是**可重建的中间态**，
  不是业务权威数据（权威记录在 Spring Boot / MySQL）。
- 单进程 asyncio 锁保护；写入用 临时文件 + os.replace 原子替换。
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Optional

_STORE_VERSION = 1


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

    async def save(self) -> None:
        async with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": _STORE_VERSION,
                "tasks": self.tasks,
                "idempotency": self.idempotency,
            }
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=None), encoding="utf-8")
            os.replace(tmp, self.path)

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
