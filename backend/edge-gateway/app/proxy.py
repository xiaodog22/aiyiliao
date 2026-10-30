"""反向代理：/api/** → business-service（保留路径/查询头/体）。

- 响应以 **raw 字节流式** 回传：SSE（/api/v1/ai/tasks/{id}/events）不会被攒到最后一次性下发。
- 声明了 `response_adapter` 的兼容条目例外：整体读入 → 校验（仅 2xx + JSON）→ 适配 → 返回；
  适配失败**原样透传**并告警（不中断用户链路）。
- 上游出站统一 `accept-encoding: identity`，避免解压/再压缩两侧语义不一致（开发流量无收益）。
- 失败语义（D1.3 映射表）：连不上 → 503 UPSTREAM_UNAVAILABLE；任一超时 → 504 UPSTREAM_TIMEOUT；
  其他传输错误 → 502 UPSTREAM_ERROR；上游 4xx/5xx 响应体**原样透传**（含统一错误信封）。
"""

from __future__ import annotations

import json
import logging
from typing import Callable, Optional

import httpx
from fastapi import Request
from starlette.background import BackgroundTask
from starlette.responses import Response, StreamingResponse

from .envelope import ApiError, upstream_error, upstream_timeout, upstream_unavailable

logger = logging.getLogger("edge-gateway.proxy")

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}


def _reject_path_traversal(path: str) -> None:
    """拒绝含 `..` 段的转发路径（路径混淆 / 请求走私的经典形态）。

    实测背景（V14 资源端点验收）：客户端请求
        GET /api/v1/resources/../..%2Fetc%2Fpasswd
    uvicorn 已把 `%2F` 解码进 scope["path"]，httpx 再对 URL 做规范化，
    实际打到上游的是 `GET /etc/passwd` —— 路径被"上跳"出了 /api 前缀，
    返回的还是「接口尚未实现」的 501，语义完全错位。
    这里在发上游请求前直接 400，保证转发路径 == 业务路径。
    注意：只拒绝 `..` 段，不影响 `/api/v1/consultation/status/{id}` 这类正常路径参数。
    """
    normalized = path.replace("\\", "/")
    if ".." in normalized.split("/"):
        raise ApiError(400, "VALIDATION_FAILED", "请求路径非法")


async def forward(
    client: httpx.AsyncClient,
    request: Request,
    base_url: str,
    target_path: Optional[str] = None,
    body_override: Optional[bytes] = None,
    content_type: Optional[str] = None,
    query_override: Optional[str] = None,
    header_overrides: Optional[dict] = None,
    response_adapter: Optional[Callable[[dict], Optional[dict]]] = None,
) -> Response:
    path = target_path if target_path is not None else request.url.path
    _reject_path_traversal(path)
    url = base_url.rstrip("/") + path
    query = query_override if query_override is not None else str(request.url.query)
    if query:
        url += "?" + query

    # 出站头统一小写键：HTTP 头名大小写不敏感，若保留下游原始大小写，
    # 与 header_overrides 的同名头（如 X-Platform 与 x-platform）会在 dict 里共存，
    # httpx 会向上游发两条同名头 → Spring 拼成 "a,a" → 契约 const 校验 422（§5.1）。
    headers: dict[str, str] = {}
    for key, value in request.headers.items():
        lower = key.lower()
        if lower in HOP_BY_HOP or lower in ("host", "content-length", "accept-encoding", "content-type"):
            continue
        headers[lower] = value
    headers["accept-encoding"] = "identity"
    if content_type:
        headers["content-type"] = content_type
    elif "content-type" in request.headers:
        headers["content-type"] = request.headers["content-type"]
    if header_overrides:
        # 兼容翻译层补充上游必需头（如旧登录路径 → 新 auth 的 X-Client-Version/X-Platform）。
        # 小写键 + 直接赋值 = 覆盖而非叠加：这是 §5.1 重复头的根因修复。
        for key, value in header_overrides.items():
            if value is not None:
                headers[key.lower()] = value

    body = body_override if body_override is not None else await request.body()

    upstream_request = client.build_request(request.method, url, headers=headers, content=body or None)
    try:
        upstream_response = await client.send(upstream_request, stream=True)
    except httpx.ConnectError as exc:
        logger.warning("上游不可达 %s %s（%s）", request.method, path, exc.__class__.__name__)
        raise upstream_unavailable()
    except httpx.TimeoutException as exc:
        # 连接/读取/写入/池等待 任一超时统一归 504（含 ConnectTimeout，不再落入 502 分支）
        logger.warning("上游超时 %s %s（%s）", request.method, path, exc.__class__.__name__)
        raise upstream_timeout()
    except httpx.HTTPError as exc:
        logger.warning("上游异常 %s %s（%s）", request.method, path, exc.__class__.__name__)
        raise upstream_error()

    # 响应头：剔除逐跳头与 content-encoding（出站统一 identity，正常不会出现压缩）。
    # ⚠️ content-length **必须保留**：此前一并剔除后 StreamingResponse 退化为 chunked，
    #    统一入口拿不到长度 —— `<image>` 无法预判、下载无进度、资源端点验收
    #    「curl -I 必须有 Content-Length」直接失败。上游 identity 编码下长度可信。
    response_headers = {
        key: value
        for key, value in upstream_response.headers.items()
        if key.lower() not in HOP_BY_HOP and key.lower() != "content-encoding"
    }

    if response_adapter is None:
        return StreamingResponse(
            upstream_response.aiter_raw(),
            status_code=upstream_response.status_code,
            headers=response_headers,
            background=BackgroundTask(upstream_response.aclose),
        )

    # ---- 兼容响应适配（仅 legacy 条目；小 JSON 响应）----
    # ⚠️ 适配可能改写 body：上游 content-length 已不可信，必须剔除，由 Response 按实际字节重算，
    #    否则声明的长度与 body 不一致会让客户端挂起等数据。
    for k in [k for k in response_headers if k.lower() == "content-length"]:
        response_headers.pop(k, None)
    raw = await upstream_response.aread()
    status = upstream_response.status_code
    await upstream_response.aclose()
    body_out = raw
    content_type_header = upstream_response.headers.get("content-type", "")
    if 200 <= status < 300 and "json" in content_type_header.lower():
        try:
            doc = json.loads(raw.decode("utf-8"))
            adapted = response_adapter(doc) if isinstance(doc, dict) else None
        except Exception as exc:  # noqa: BLE001 —— 适配失败必须原样透传，只告警不中断
            adapted = None
            logger.warning("响应适配失败，已原样透传 %s %s（%s）", request.method, path, exc.__class__.__name__)
        if adapted is not None:
            body_out = json.dumps(adapted, ensure_ascii=False).encode("utf-8")
    return Response(content=body_out, status_code=status, headers=response_headers)

