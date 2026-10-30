"""运行产物回收（M4 硬化前瞻 · 提前到 M3）。

TTS 合成产物（`{tts_output_dir}/{digest}.mp3`）是**非权威中间件**——可重建、重启可失，
但不回收会随使用无限增长（每个新文本/音色/语言组合产生一个新文件）。本模块给出**保守**回收：

- 只删「**未被任何在库任务引用**」且「mtime 早于 TTL」的 `.mp3`；
- 文件名必须匹配产物命名白名单（16~64 位十六进制 + `.mp3`），其余一律不碰（不误删无关文件）；
- 「被引用」的判定唯一来源是任务 `result.audioUrl` 的末段文件名——不猜测、不建索引；
- 删除失败只告警、不抛错：回收是尽力而为，不是权威操作。

⚠️ 边界：产物同时起「内容寻址缓存」作用（同文本命中即复用）。回收只按 **TTL + 无引用** 判定，
因此可能删掉一个「理论上还能复用」的文件——这是可接受的：下一次同文本请求会重新合成，
只是多花一次算力，不影响正确性。
"""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

logger = logging.getLogger("ai-service.retention")

# 与 main.py 的音频白名单一致（防路径穿越 / 不误删无关文件）
_ARTIFACT_NAME_RE = re.compile(r"^[0-9a-f]{16,64}\.mp3$")


def referenced_audio_filenames(tasks) -> set[str]:
    """从在库任务的 `result.audioUrl` 收集仍被引用的产物文件名。"""
    names: set[str] = set()
    for task in tasks:
        result = task.get("result") if isinstance(task, dict) else None
        if not isinstance(result, dict):
            continue
        url = result.get("audioUrl")
        if not isinstance(url, str) or not url:
            continue
        name = urlsplit(url).path.rsplit("/", 1)[-1]
        if name:
            names.add(name)
    return names


def sweep_tts_artifacts(
    output_dir: Path | str,
    referenced: set[str],
    ttl_seconds: int,
    now: float | None = None,
) -> int:
    """删除 `output_dir` 下「未被引用且已过 TTL」的产物文件。返回删除数量。"""
    directory = Path(output_dir)
    if not directory.is_dir():
        return 0
    ts = time.time() if now is None else now
    removed = 0
    for entry in directory.iterdir():
        if not entry.is_file() or not _ARTIFACT_NAME_RE.match(entry.name):
            continue
        if entry.name in referenced:
            continue
        try:
            if (ts - entry.stat().st_mtime) < ttl_seconds:
                continue
            entry.unlink()
            removed += 1
        except OSError as exc:  # 回收是尽力而为：失败不中断主流程
            logger.warning("TTS 产物回收失败 file=%s（%s）", entry.name, exc.__class__.__name__)
    if removed:
        logger.info("TTS 产物回收 %d 个（目录 %s）", removed, directory)
    return removed


__all__ = ["referenced_audio_filenames", "sweep_tts_artifacts"]
