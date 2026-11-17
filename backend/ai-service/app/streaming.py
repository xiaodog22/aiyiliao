"""任务 token 流汇聚点（对外流式第一期，仅 CHAT 使用；旁路，不改变轮询链路）。

为什么单独成模块：
    `tasks.py` 被 `providers/chain.py` 反向依赖（`TaskFailure`），把 sink 放进 tasks.py
    会形成循环导入。本模块不依赖任何业务模块，只做三件事：
    ① 给当前执行上下文绑定一个「增量文本出口」；
    ② 把增量投递给订阅队列（**无订阅者时为空操作**）；
    ③ 用哨兵对象标记流结束（不能用空串 —— 空 delta 是合法增量）。

红线（不阻塞 worker）：
    订阅队列有上限（`QUEUE_MAX`）。客户端断开后队列积压 → 丢弃增量并计数，
    **绝不 await、绝不抛异常**，避免一条断掉的 SSE 连接拖死整个任务队列。

契约：本模块只搬运文本，不解析、不改写、不落盘；不做任何数据留存。
"""

from __future__ import annotations

import asyncio
import logging
import re
from contextvars import ContextVar, Token
from typing import Callable, Optional

logger = logging.getLogger("ai-service.streaming")

# 流结束哨兵：用对象身份比较，避免"空串增量"被误判成结束。
STREAM_END = object()

# 被新连接顶替的哨兵：同一任务重连时，旧连接收到它后应静默收尾。
# 为什么不复用 STREAM_END：否则旧连接会误以为任务正常结束，去读终态并回一个假的 error。
STREAM_SUPERSEDED = object()

# 单任务订阅队列容量（块数）。按 7B CPU 生成速率，256 块 ≈ 数十秒的缓冲，
# 足以覆盖手机端短暂卡顿；超出说明客户端已断开，丢弃即可。
QUEUE_MAX = 256

# 当前执行上下文的增量出口。ContextVar 保证 pool 内多 worker 并发时互不串流。
_SINK: ContextVar[Optional[Callable[[str], None]]] = ContextVar("token_sink", default=None)


def bind_sink(sink: Optional[Callable[[str], None]]) -> Token:
    """绑定出口并返回 reset 令牌（调用方必须在 finally 里 reset，避免上下文泄漏）。"""
    return _SINK.set(sink)


def reset_sink(token: Token) -> None:
    _SINK.reset(token)


def current_sink() -> Optional[Callable[[str], None]]:
    return _SINK.get()


def publish(chunk: str) -> None:
    """执行器侧调用：把增量交给当前出口。无绑定 / 空块 → 直接返回（零开销路径）。"""
    if not chunk:
        return
    sink = _SINK.get()
    if sink is None:
        return
    try:
        sink(chunk)
    except Exception:  # 订阅端异常不得影响生成主流程
        logger.warning("token 投递失败（已忽略，不影响生成）", exc_info=True)


def new_queue() -> asyncio.Queue:
    return asyncio.Queue(maxsize=QUEUE_MAX)


_SIMPLE_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f"}
_TEXT_KEY = re.compile(r'"text"\s*:\s*"')


class TextFieldExtractor:
    """从 JSON 流里增量抽出 `"text":"…"` 的值（CHAT 是 json_mode 结构化输出）。

    为什么必须抽：
        `executors/chat.py` 用 `json_mode=True`，模型实际吐的是
        `{"text":"…","language":"zh-CN","refused":false}`。把原始 token 直接推给前端，
        用户会看到 `{"text":"你` 这类语法噪声 —— 提案 §3 默认"纯文本 delta"，漏了这一层。

    为什么不用 json.loads：
        增量块是半截 JSON，任何时点都可能不合法；只能做字符级状态机。

    边界：
        - 跨块转义（结尾反斜杠、`\\uXXXX` 半截）暂存到下一块，绝不吐半个字符；
        - 找不到 `"text"` 键（模型没按格式输出）→ 返回空，端点末尾用最终结果补一块；
        - 只抽取、不改写，不解析其余字段。
    """

    def __init__(self) -> None:
        self._seek_buf = ""
        self._state = "seek"  # seek | value | done
        self._esc: Optional[str] = None

    @property
    def done(self) -> bool:
        return self._state == "done"

    def feed(self, chunk: str) -> str:
        if not chunk or self._state == "done":
            return ""

        if self._state == "seek":
            self._seek_buf += chunk
            match = _TEXT_KEY.search(self._seek_buf)
            if match is None:
                # 键名只有几十字符，超长即丢弃头部，避免缓冲无界增长
                if len(self._seek_buf) > 96:
                    self._seek_buf = self._seek_buf[-96:]
                return ""
            chunk = self._seek_buf[match.end():]
            self._seek_buf = ""
            self._state = "value"

        out: list[str] = []
        for char in chunk:
            if self._esc is None:
                if char == "\\":
                    self._esc = ""
                    continue
                if char == '"':
                    self._state = "done"
                    break
                out.append(char)
                continue
            if self._esc == "":
                if char == "u":
                    self._esc = "u"
                    continue
                out.append(_SIMPLE_ESCAPES.get(char, char))
                self._esc = None
                continue
            self._esc += char
            if len(self._esc) == 5:  # u + 4 hex
                try:
                    out.append(chr(int(self._esc[1:], 16)))
                except ValueError:
                    out.append("")  # 非法码点：丢弃该字符，不抛异常打断生成
                self._esc = None
        return "".join(out)
