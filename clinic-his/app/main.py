"""HTTP 服务入口：路由、鉴权中间件、统一响应包、静态管理端。

启动：python app/main.py
环境变量：CLINIC_HOST（默认 127.0.0.1）、CLINIC_PORT（默认 8310）、CLINIC_DB。
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sys
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import db, legacy_credentials, security, seed
from .errors import ApiError
from .http_response import RawResponse
from .api import (admin, auth, basic, charge, clinical, documents as documents_api, lab,
                  openapi, ph, pharmacy, registration, ward)

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
MAX_BODY = 1024 * 1024
SERVER_HEADER = "ClinicHIS/1.0"

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/assets/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/assets/autocomplete.js": ("autocomplete.js", "application/javascript; charset=utf-8"),
    "/assets/style.css": ("style.css", "text/css; charset=utf-8"),
    "/assets/print.css": ("print.css", "text/css; charset=utf-8"),
    "/assets/print.js": ("print.js", "application/javascript; charset=utf-8"),
}


class Ctx:
    def __init__(self):
        self.method = "GET"
        self.path = ""
        self.query: dict[str, str] = {}
        self.params: dict[str, str] = {}
        self.body: dict = {}
        self.raw_body: bytes = b""
        self.headers = None
        self.user = None
        self.token = ""
        self.ip = ""
        self.request_id = ""
        self.status = 200
        self.openapi_key = None

    def q(self, name: str, default: str = "") -> str:
        value = self.query.get(name)
        return default if value is None else value


class Router:
    def __init__(self):
        self.routes = []

    def add(self, method: str, pattern: str, handler, perm: str | None = None, auth: bool = True):
        self.routes.append((method.upper(), re.compile("^" + pattern + "$"), handler, perm, auth))

    def match(self, method: str, path: str):
        path_matched = False
        for m, rx, handler, perm, need_auth in self.routes:
            mt = rx.match(path)
            if not mt:
                continue
            path_matched = True
            if m == method:
                return handler, mt.groupdict(), perm, need_auth
        if path_matched:
            raise ApiError(405, "METHOD_NOT_ALLOWED", "请求方法不被支持")
        return None


def build_router() -> Router:
    router = Router()
    for module in (auth, basic, registration, clinical, ward, pharmacy, charge, lab, ph, admin,
                   openapi, documents_api):
        module.register(router)
    return router


ROUTER = build_router()


def _new_request_id() -> str:
    return "REQ-" + datetime.now().strftime("%Y%m%d%H%M%S") + "-" + secrets.token_hex(2).upper()


def _json_bytes(payload) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def envelope(request_id: str, data=None, message: str = "成功", code: str = "OK", **extra) -> dict:
    payload = {"code": code, "message": message, "requestId": request_id, "data": data}
    payload.update(extra)
    return payload


def error_envelope(request_id: str, err: ApiError) -> dict:
    payload = {
        "code": err.code,
        "message": err.message,
        "requestId": request_id,
        "retryable": err.retryable,
        "data": None,
    }
    if err.details:
        payload["details"] = err.details
    return payload


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = SERVER_HEADER
    sys_version = ""

    # ------------------------------------------------------------ 公共工具

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self'; "
                         "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
                         "base-uri 'none'; form-action 'self'")
        self.send_header("Cache-Control", "no-store")

    def _write(self, status: int, payload: bytes, content_type: str) -> None:
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _write_json(self, status: int, payload: dict) -> None:
        self._write(status, _json_bytes(payload), "application/json; charset=utf-8")

    def _write_raw(self, response: RawResponse) -> None:
        self.send_response(response.status)
        self._security_headers()
        for name, value in response.headers.items():
            self.send_header(name, value)
        self.send_header("Content-Type", response.content_type)
        self.send_header("Content-Length", str(len(response.payload)))
        self.end_headers()
        try:
            self.wfile.write(response.payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):  # 屏蔽默认 access log（自行输出脱敏日志）
        return

    def _client_ip(self) -> str:
        return (self.client_address[0] if self.client_address else "")[:64]

    def _read_body(self) -> bytes:
        length_header = self.headers.get("Content-Length")
        if not length_header:
            return b""
        try:
            length = int(length_header)
        except ValueError:
            raise ApiError(400, "VALIDATION_FAILED", "Content-Length 不合法")
        if length > MAX_BODY:
            raise ApiError(413, "PAYLOAD_TOO_LARGE", "请求体超过 1MB 上限")
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _parse_json(self, raw: bytes) -> dict:
        if not raw:
            return {}
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "VALIDATION_FAILED", "请求体必须是合法的 JSON")
        if not isinstance(obj, dict):
            raise ApiError(400, "VALIDATION_FAILED", "请求体必须是 JSON 对象")
        return obj

    def _bearer_token(self) -> str:
        header = self.headers.get("Authorization") or ""
        if header.startswith("Bearer "):
            return header[7:].strip()
        return ""

    # ------------------------------------------------------------ 请求分发

    def _handle_api(self, method: str, path: str, parsed) -> None:
        ctx = Ctx()
        ctx.method = method
        ctx.path = path
        ctx.query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        ctx.headers = self.headers
        ctx.ip = self._client_ip()
        ctx.request_id = _new_request_id()
        ctx.token = self._bearer_token()

        try:
            matched = ROUTER.match(method, path)
            if matched is None:
                raise ApiError(404, "NOT_FOUND", "接口不存在")
            handler, params, perm, need_auth = matched
            ctx.params = params
            ctx.raw_body = self._read_body() if method in ("POST", "PATCH", "PUT") else b""
            ctx.body = self._parse_json(ctx.raw_body) if method in ("POST", "PATCH", "PUT") else {}

            if need_auth:
                ctx.user = security.resolve_session(ctx.token)
                if not ctx.user:
                    raise ApiError(401, "AUTH_REQUIRED", "登录状态已失效，请重新登录")
                # 敌意审查 L4（2026-11-22）：种子账号默认口令必须首登改密。
                # 未改密前仅放行 me/password/logout，其余业务接口 403（fail-closed）。
                if security.must_change_blocks(ctx.user, method, path):
                    raise ApiError(403, "PASSWORD_CHANGE_REQUIRED",
                                   "首次登录必须修改初始口令后才能继续使用", None, False)
                if perm:
                    security.require_perm(ctx.user, perm)

            data = handler(ctx)
            if isinstance(data, RawResponse):
                self._write_raw(data)
                print(f"[{ctx.request_id}] {method} {path} -> {data.status} {data.content_type}")
            else:
                payload = envelope(ctx.request_id, data)
                self._write_json(ctx.status, payload)
                print(f"[{ctx.request_id}] {method} {path} -> {ctx.status} ip={ctx.ip}")
        except ApiError as exc:
            self._write_json(exc.status, error_envelope(ctx.request_id, exc))
            print(f"[{ctx.request_id}] {method} {path} -> {exc.status} {exc.code}")
        except Exception:  # noqa: BLE001 - 兜底，绝不向客户端泄露堆栈
            traceback.print_exc()
            payload = error_envelope(ctx.request_id, ApiError(500, "INTERNAL_ERROR", "系统繁忙，请稍后重试", None, True))
            self._write_json(500, payload)
            print(f"[{ctx.request_id}] {method} {path} -> 500 INTERNAL_ERROR")

    def _serve_static(self, method: str, path: str) -> None:
        entry = STATIC_FILES.get(path)
        if entry is None:
            self._write_json(404, {"code": "NOT_FOUND", "message": "资源不存在", "data": None})
            return
        filename, content_type = entry
        full = os.path.join(WEB_DIR, filename)
        try:
            with open(full, "rb") as fh:
                payload = fh.read()
        except OSError:
            self._write_json(404, {"code": "NOT_FOUND", "message": "静态资源缺失", "data": None})
            return
        if method == "HEAD":
            self.send_response(200)
            self._security_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            return
        self._write(200, payload, content_type)

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/") or path.startswith("/openapi/"):
            self._handle_api(method, path, parsed)
        elif method in ("GET", "HEAD"):
            self._serve_static(method, path)
        else:
            self._write_json(405, {"code": "METHOD_NOT_ALLOWED", "message": "请求方法不被支持", "data": None})

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")


class ClinicServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def bootstrap() -> None:
    db.init_db()
    created = seed.ensure_seed()
    if created:
        print("已初始化演示数据：8 医生 / 14 护士 / 6 行政 / 2 医技；"
              "初始口令见 seed 一次性输出（或由 CLINIC_SEED_PASSWORD 指定），所有账号首登必须改密")
    # B3（2026-11-23）：存量库不会重新 seed，必须在每次启动时兜底标记「从未改密」的账号。
    # 幂等；只置 must_change=1，不改口令哈希；审计记录数量与角色分布（无明文）。
    migrated = legacy_credentials.mark_legacy_accounts()
    if migrated["marked"]:
        detail = "、".join(f"{role} {count}" for role, count in migrated["roles"].items())
        print(f"存量账号口令迁移：{migrated['marked']} 个从未改密账号已强制首登改密（{detail}）")


def main() -> None:
    bootstrap()
    host = os.environ.get("CLINIC_HOST", "127.0.0.1")
    port = int(os.environ.get("CLINIC_PORT", "8310"))
    server = ClinicServer((host, port), Handler)
    print("=" * 66)
    print("  康诊云社区诊所信息系统（Clinic HIS） V1.0")
    print(f"  管理端：http://{host}:{port}/")
    print(f"  对外接口：http://{host}:{port}/openapi/v1/ping")
    print(f"  数据库：{db.DB_PATH}")
    print("=" * 66)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止服务")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
