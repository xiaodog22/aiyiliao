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
        - **UTF-16 代理对必须合并**（2026-11-18）：模型输出 emoji 时 JSON 转义是
          `\\uD83D\\uDE00` 这种**两个** `\\uXXXX`，逐个 `chr()` 会得到两个孤立代理码点；
          出站 UTF-8 编码遇孤立代理直接抛 `UnicodeEncodeError` → SSE 半路断流。
          故高代理先暂存，等下一个 `\\uXXXX` 判断是否拼成完整码点；拼不上就降级 U+FFFD。
    """

    def __init__(self) -> None:
        self._seek_buf = ""
        self._state = "seek"  # seek | value | done
        self._esc: Optional[str] = None
        # 已解出但尚未配对的高代理码点（`\\uD83D`）。必须跨块保留：代理对可能被切在
        # 两个增量块里，逐块 flush 会把 emoji 拆成两个 �。
        self._high: Optional[int] = None

    @property
    def done(self) -> bool:
        return self._state == "done"

    def _flush_high(self, out: list[str]) -> None:
        """把没有配对的孤立高代理降级成 U+FFFD（宁可显示 �，也不让流中断）。"""
        if self._high is not None:
            out.append("\ufffd")
            self._high = None

    def _emit_code(self, code: int, out: list[str]) -> None:
        """按 UTF-16 代理规则输出码点：高代理暂存、低代理合并、孤立代理降级。"""
        if 0xD800 <= code <= 0xDBFF:
            self._flush_high(out)   # 连续两个高代理：前一个已是孤立
            self._high = code
            return
        if 0xDC00 <= code <= 0xDFFF:
            high = self._high
            self._high = None
            if high is None:
                out.append("\ufffd")
            else:
                out.append(chr(0x10000 + ((high - 0xD800) << 10) + (code - 0xDC00)))
            return
        self._flush_high(out)
        out.append(chr(code))

    def _literal(self, text: str, out: list[str]) -> None:
        """输出一个普通字符：先结算待配的高代理，保证替换字符落在原位置而不是句尾。"""
        self._flush_high(out)
        out.append(text)

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
                self._literal(char, out)
                continue
            if self._esc == "":
                if char == "u":
                    self._esc = "u"
                    continue
                self._literal(_SIMPLE_ESCAPES.get(char, char), out)
                self._esc = None
                continue
            self._esc += char
            if len(self._esc) == 5:  # u + 4 hex
                try:
                    self._emit_code(int(self._esc[1:], 16), out)
                except ValueError:
                    out.append("")  # 非法码点：丢弃该字符，不抛异常打断生成
                self._esc = None
        if self._state == "done":
            self._flush_high(out)  # 正文已结束：残留的孤立代理降级，避免出站编码失败
        return "".join(out)
