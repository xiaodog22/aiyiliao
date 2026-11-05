"""从契约生成接口目录 JSON，并注入到 HTML 调试台。

用法：
    backend/ai-service/.venv/Scripts/python.exe tools/gen-api-catalog.py

输出：
    1) docs/v4/09-API调试台.html 中的占位符 __CATALOG_JSON__ 被替换为目录 JSON（自包含）。
    2) docs/v4/api-catalog.json 独立备份（便于排障）。
"""

from __future__ import annotations

import json
import os
import re
import sys
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUSINESS_YAML = os.path.join(REPO, "backend", "contracts", "business-openapi.yaml")
AI_YAML = os.path.join(REPO, "backend", "contracts", "ai-openapi.yaml")
HTML_PATH = os.path.join(REPO, "docs", "v4", "09-API调试台.html")
CATALOG_JSON = os.path.join(REPO, "docs", "v4", "api-catalog.json")
PLACEHOLDER = "__CATALOG_JSON__"

HTTP_METHODS = ("get", "post", "put", "patch", "delete", "options", "head")


def load_yaml(path):
    import yaml
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def resolve_ref(spec, ref):
    parts = ref.lstrip("#/").split("/")
    cur = spec
    for p in parts:
        cur = cur[p]
    return cur


def gen_example(schema, spec, depth=0, seen=None):
    """从 schema 生成占位示例（反映结构，非真实数据）。"""
    if schema is None:
        return None
    if not isinstance(schema, dict):
        return None
    if depth > 8:
        return None
    if "$ref" in schema:
        return gen_example(resolve_ref(spec, schema["$ref"]), spec, depth + 1, seen)
    if "const" in schema:
        return schema["const"]
    if "enum" in schema and schema["enum"]:
        for e in schema["enum"]:
            if e is not None:
                return e
        return schema["enum"][0]
    t = schema.get("type")
    if isinstance(t, list):  # 可空联合，如 [string, 'null']
        t = [x for x in t if x != "null"]
        t = t[0] if t else "string"
    if "allOf" in schema:
        merged = {}
        for sub in schema["allOf"]:
            e = gen_example(sub, spec, depth + 1, seen)
            if isinstance(e, dict):
                merged.update(e)
        return merged
    if t == "object" or "properties" in schema:
        props = schema.get("properties", {}) or {}
        if not props:
            return {}
        obj = {}
        for k, v in props.items():
            obj[k] = gen_example(v, spec, depth + 1, seen)
        return obj
    if t == "array":
        items = schema.get("items", {}) or {}
        ex = gen_example(items, spec, depth + 1, seen)
        return [ex] if ex is not None else []
    if t == "string":
        fmt = schema.get("format")
        if fmt == "date-time":
            return "2026-01-01T08:00:00Z"
        if fmt == "date":
            return "2026-01-01"
        if "example" in schema:
            return schema["example"]
        ml = schema.get("maxLength")
        if isinstance(ml, int) and ml < 24:
            return "x" * max(1, min(ml, 6))
        return "string"
    if t == "integer":
        return 0
    if t == "number":
        return 0.0
    if t == "boolean":
        return True
    return None


def extract_params(op, spec):
    out = []
    for p in op.get("parameters", []) or []:
        if "$ref" in p:
            p = resolve_ref(spec, p["$ref"])
        out.append({
            "name": p.get("name"),
            "in": p.get("in"),
            "required": bool(p.get("required", False)),
            "description": (p.get("description") or "").strip(),
            "example": gen_example(p.get("schema", {}), spec),
        })
    return out


def extract_body(op, spec):
    rb = op.get("requestBody")
    if not rb:
        return None
    content = rb.get("content", {}) or {}
    if "application/json" in content:
        return gen_example(content["application/json"].get("schema", {}), spec)
    if content:
        first = next(iter(content))
        return gen_example(content[first].get("schema", {}), spec)
    return None


def extract_responses(op, spec):
    resp = op.get("responses", {}) or {}
    codes = list(resp.keys())
    success = None
    for code in codes:
        if str(code).startswith("2"):
            r = resp[code]
            if "$ref" in r:
                r = resolve_ref(spec, r["$ref"])
            content = r.get("content", {}) or {}
            if "application/json" in content:
                success = gen_example(content["application/json"].get("schema", {}), spec)
            elif content:
                first = next(iter(content))
                success = gen_example(content[first].get("schema", {}), spec)
            break
    return codes, success


def build_from_spec(spec, internal=False):
    cats = {t["name"]: (t.get("description") or "").strip() for t in spec.get("tags", [])}
    items = []
    for path, methods in spec.get("paths", {}).items():
        for method, op in methods.items():
            if method not in HTTP_METHODS:
                continue
            tags = op.get("tags") or ["uncategorized"]
            items.append({
                "method": method.upper(),
                "path": path,
                "operationId": op.get("operationId"),
                "summary": op.get("summary", ""),
                "description": (op.get("description") or "").strip(),
                "category": tags[0],
                "idempotency": op.get("x-idempotency"),
                "status": op.get("x-status"),
                "params": extract_params(op, spec),
                "request": extract_body(op, spec),
                "responses": extract_responses(op, spec)[0],
                "success": extract_responses(op, spec)[1],
                "internal": internal,
                "gatewayOwn": False,
            })
    return cats, items


def gateway_own_routes():
    """契约未收录的网关自身路由（实现见 edge-gateway/app/main.py）。"""
    return [
        {
            "method": "GET", "path": "/api/gw/health", "operationId": "gatewayHealth",
            "summary": "网关健康（含双上游可达性）", "category": "edge-gateway",
            "description": "网关自身路由。返回 status 与 upstreams（java/python 可达性与延迟）。无需鉴权。",
            "idempotency": None, "status": None,
            "params": [], "request": None,
            "responses": ["200", "503"],
            "success": {"code": "OK", "message": "OK", "requestId": "r_xxx", "serverTime": "2026-01-01T08:00:00Z",
                        "data": {"status": "ok", "upstreams": [{"name": "java", "reachable": True, "latencyMs": 33},
                                                                {"name": "python", "reachable": True, "latencyMs": 15}]}},
            "internal": False, "gatewayOwn": True,
        },
        {
            "method": "GET", "path": "/api/gw/routes", "operationId": "gatewayRoutes",
            "summary": "网关路由表", "category": "edge-gateway",
            "description": "返回前缀路由归属（/api/gw→网关，/api→business）。需鉴权（Bearer）。",
            "idempotency": None, "status": None,
            "params": [], "request": None,
            "responses": ["200", "401"],
            "success": {"code": "OK", "message": "OK", "requestId": "r_xxx", "serverTime": "2026-01-01T08:00:00Z",
                        "data": {"routes": [{"prefix": "/api/gw", "upstream": "gateway"},
                                            {"prefix": "/api", "upstream": "java"}]}},
            "internal": False, "gatewayOwn": True,
        },
        {
            "method": "GET", "path": "/api/gw/voices", "operationId": "gatewayVoices",
            "summary": "音色列表（兼容别名）", "category": "edge-gateway",
            "description": "等价于 /api/v1/voice/voices（deprecated；新代码应使用业务路径）。需鉴权。",
            "idempotency": None, "status": None,
            "params": [], "request": None,
            "responses": ["200", "401"],
            "success": {"code": "OK", "message": "OK", "requestId": "r_xxx", "serverTime": "2026-01-01T08:00:00Z", "data": []},
            "internal": False, "gatewayOwn": True,
        },
        {
            "method": "GET", "path": "/api/gw/tts/audio/{filename}", "operationId": "gatewayTtsAudio",
            "summary": "TTS 音频公开通道", "category": "edge-gateway",
            "description": "转发 ai-service 内部签名通道（文件名白名单 ^[0-9a-f]{16,64}\\.mp3$）。公开，无需鉴权。",
            "idempotency": None, "status": None,
            "params": [{"name": "filename", "in": "path", "required": True,
                        "description": "16~64 位十六进制 + .mp3", "example": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.mp3"}],
            "request": None, "responses": ["200", "404"],
            "success": "(audio/mpeg 二进制流)", "internal": False, "gatewayOwn": True,
        },
        {
            "method": "GET", "path": "/api/gw/assets/{filename}", "operationId": "gatewayAsset",
            "summary": "静态素材公开通道", "category": "edge-gateway",
            "description": "经统一入口分发 backend/deploy/resources 白名单图片（png/jpg/jpeg/webp）。公开，无需鉴权；响应含 ETag / X-Resource-Sha256 / X-Resource-Size。",
            "idempotency": None, "status": None,
            "params": [{"name": "filename", "in": "path", "required": True,
                        "description": "全小写、无子目录；如 banner-hospital.jpg", "example": "banner-hospital.jpg"}],
            "request": None, "responses": ["200", "304", "404"],
            "success": "(image/* 二进制流 + ETag/sha256/size 头)", "internal": False, "gatewayOwn": True,
        },
    ]


def main():
    business = load_yaml(BUSINESS_YAML)
    ai = load_yaml(AI_YAML)

    biz_cats, biz_items = build_from_spec(business, internal=False)
    gw_items = gateway_own_routes()
    # 合并网关自有路由进 edge-gateway 分类
    for it in gw_items:
        biz_items.append(it)
    ai_cats, ai_items = build_from_spec(ai, internal=True)

    # 分类顺序：契约 tags 顺序优先，再补 edge-gateway（若缺），再补 ai 内网面
    order = [t["name"] for t in business.get("tags", [])]
    if "edge-gateway" not in order:
        order.append("edge-gateway")
    # 过滤掉实际无端点的分类
    order = [c for c in order if any(i["category"] == c for i in biz_items)]
    # ai 内网面单独成组（置后）
    ai_order = [t["name"] for t in ai.get("tags", [])]
    ai_order = [c for c in ai_order if any(i["category"] == c for i in ai_items)]

    catalog = {
        "generatedFrom": ["business-openapi.yaml", "ai-openapi.yaml", "edge-gateway/app/main.py"],
        "baseNote": "客户端只连统一网关（默认 http://127.0.0.1:8000）。business/ai 内网面不经网关暴露。",
        "callableCategories": order,
        "internalCategories": ai_order,
        "categoryDesc": {**biz_cats, **ai_cats},
        "endpoints": biz_items + ai_items,
        "counts": {
            "callable": sum(1 for i in (biz_items) if not i["internal"]),
            "gatewayOwn": sum(1 for i in gw_items),
            "internal": len(ai_items),
            "total": len(biz_items) + len(ai_items),
        },
    }

    payload = json.dumps(catalog, ensure_ascii=False, indent=1)

    # 注入 HTML
    with open(HTML_PATH, "r", encoding="utf-8") as f:
        html = f.read()
    if PLACEHOLDER not in html:
        print("ERROR: 占位符 %s 未出现在 %s" % (PLACEHOLDER, HTML_PATH), file=sys.stderr)
        sys.exit(2)
    html = html.replace(PLACEHOLDER, payload)
    with open(HTML_PATH, "w", encoding="utf-8") as f:
        f.write(html)

    # 独立备份
    with open(CATALOG_JSON, "w", encoding="utf-8") as f:
        f.write(payload)

    print("OK categories=%d internal=%d endpoints=%d (callable=%d gatewayOwn=%d internal=%d)" % (
        len(order), len(ai_order), catalog["counts"]["total"],
        catalog["counts"]["callable"], catalog["counts"]["gatewayOwn"], catalog["counts"]["internal"]))


if __name__ == "__main__":
    main()
