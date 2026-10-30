"""静态素材公开通道（GET /api/gw/assets/{filename}）——前端适配：素材经后端传递。

设计（与 `/api/gw/tts/audio/{filename}` 同构，见 docs/v4/09 §4.2）：
- 目的：把 `backend/deploy/resources/` 中的**图片与短视频小素材**经统一入口对外分发，
  作为契约 `ResourceManifest.items[].url` / `ContentItem.coverUrl|videoUrl` 的可达承载
  （ai/business 均不直接对外）。
- 鉴权=公开（`<image>`/`<video>` 元素无法携带 Authorization 头）；**只读**、
  **白名单扩展名**（png/jpg/jpeg/webp/mp4，2026-10-17 起含 mp4：科普提示视频 60KB 级）、
  **文件名白名单**（小写字母数字 . _ -，禁斜杠与 `..`）、
  目录穿越双保险（resolve 后父目录必须等于根）、单文件 ≤4MiB。
- 响应头：`ETag`（sha256 前 32 位）→ 支持 `If-None-Match` 304 复用；
  `Cache-Control: public, max-age=86400`；`X-Resource-Sha256` / `X-Resource-Size`
  供客户端下载后校验（对齐契约 sha256 字段口径）。
- 红线：任何非图片扩展名、路径穿越、超限、目录缺失一律 404（不列目录、不下发）。
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Optional

from fastapi import Response

# 扩展名白名单 → MIME。刻意**不含**可执行/脚本类（契约 manifest 红线同源）。
# mp4 仅用于院内审核过的科普提示视频（短、小、无交互），仍走同一目录穿越/大小校验。
ALLOWED_EXT: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
}

# 文件名白名单：小写字母数字开头，只含 [a-z0-9._-]，≤80 字符；不含斜杠。
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")

# 单文件上限：公开素材只放图片类小文件；超限视为配置错误（404，不敞开流式）。
MAX_BYTES = 4 * 1024 * 1024


def try_serve(root: Path, filename: str, if_none_match: Optional[str]) -> Optional[Response]:
    """命中白名单且文件存在 → 返回文件响应（含缓存/校验头）；否则 None（调用方转 404）。"""
    if not _NAME_RE.match(filename) or ".." in filename:
        return None

    media_type = ALLOWED_EXT.get(Path(filename).suffix.lower())
    if media_type is None:
        return None

    root = root.resolve()
    candidate = (root / filename).resolve()
    # 目录穿越双保险：解析后的父目录必须仍是素材根（符号链接/组合穿越一律拒绝）。
    if candidate.parent != root or not candidate.is_file():
        return None

    try:
        data = candidate.read_bytes()
    except OSError:
        return None
    if len(data) > MAX_BYTES:
        return None

    sha256 = hashlib.sha256(data).hexdigest()
    etag = '"' + sha256[:32] + '"'
    headers = {
        "Cache-Control": "public, max-age=86400",
        "ETag": etag,
        "X-Resource-Sha256": sha256,
        "X-Resource-Size": str(len(data)),
    }

    inm = (if_none_match or "").strip()
    if inm and (inm == etag or inm == "*"):
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type=media_type, headers=headers)
