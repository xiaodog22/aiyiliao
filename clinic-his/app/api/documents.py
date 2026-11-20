"""单据打印：HTML 预览、PDF 生成、短期签名链接。"""

from __future__ import annotations

from .. import db, documents, security
from ..errors import ApiError, forbidden, not_found
from ..http_response import RawResponse

# grant 路由级基线权限（遗留问题整改：防线显式化）；
# charge 例外——医生无 charge.read 但可打印本人接诊患者缴费单，由内部 _authorize_charge 细分。
_GRANT_BASE_PERM = {
    "visit": "visit.read", "packet": "visit.read",
    "prescription": "rx.read", "charge": "charge.read", "lab": "lab.read",
}


def _audit(ctx, kind: str, doc_id: int, fmt: str) -> None:
    with db.tx() as con:
        security.audit(con, ctx.user, "DOC_PRINT", kind, doc_id,
                       f"format={fmt} user={ctx.user.get('username', '')}", "OK", ctx.ip)


def _html(kind: str, doc_id: int, ctx) -> RawResponse:
    try:
        page_html, _title, _doc_no = documents.render_html(kind, doc_id, ctx.user)
    except ApiError:
        raise
    _audit(ctx, kind, doc_id, "html")
    return RawResponse(
        page_html.encode("utf-8"),
        "text/html; charset=utf-8",
        headers={"Content-Disposition": f'inline; filename="document-{kind}-{doc_id}.html"'},
    )


def _pdf(kind: str, doc_id: int, ctx) -> RawResponse:
    page_html, _title, _doc_no = documents.render_html(kind, doc_id, ctx.user)
    cache_key = documents.pdf_cache_key(kind, doc_id, page_html)
    path = documents.render_pdf(page_html, cache_key)
    try:
        with open(path, "rb") as fh:
            payload = fh.read()
    except OSError:
        raise ApiError(503, "PDF_ENGINE_FAILED", "PDF 文件读取失败，请重试")
    _audit(ctx, kind, doc_id, "pdf")
    return RawResponse(
        payload,
        "application/pdf",
        headers={"Content-Disposition": f'inline; filename="document-{kind}-{doc_id}.pdf"'},
    )


def document_html(ctx):
    return _html(ctx.params["kind"], int(ctx.params["id"]), ctx)


def document_pdf(ctx):
    return _pdf(ctx.params["kind"], int(ctx.params["id"]), ctx)


def grant(ctx):
    kind = ctx.params["kind"]
    base_perm = _GRANT_BASE_PERM.get(kind)
    if base_perm and not security.has_perm(ctx.user, base_perm) \
            and not (kind == "charge" and ctx.user["role"] == "DOCTOR"):
        raise forbidden("无该单据查看权限")
    doc_id = int(ctx.params["id"])
    return documents.make_links(kind, doc_id, ctx.user)


def render(ctx):
    payload = documents.verify_token(ctx.q("t"))
    user = documents.load_user(int(payload.get("u", 0)))
    if user is None:
        raise ApiError(401, "AUTH_REQUIRED", "打印链接对应的账号已失效")
    ctx.user = user
    kind = str(payload.get("k", ""))
    try:
        doc_id = int(payload.get("i", 0))
    except (TypeError, ValueError):
        raise ApiError(403, "DOC_LINK_INVALID", "打印链接无效")
    fmt = ctx.q("format", "html")
    if fmt not in ("html", "pdf"):
        raise ApiError(400, "VALIDATION_FAILED", "format 仅支持 html 或 pdf")
    return _html(kind, doc_id, ctx) if fmt == "html" else _pdf(kind, doc_id, ctx)


def register(router):
    router.add("POST", r"/api/v1/documents/(?P<kind>visit|packet|prescription|charge|lab)/(?P<id>\d+)/grant",
               grant, auth=True)
    router.add("GET", r"/api/v1/documents/(?P<kind>visit|packet|prescription|charge|lab)/(?P<id>\d+)/pdf",
               document_pdf, auth=True)
    router.add("GET", r"/api/v1/documents/(?P<kind>visit|packet|prescription|charge|lab)/(?P<id>\d+)",
               document_html, auth=True)
    router.add("GET", r"/api/v1/documents/render", render, auth=False)
