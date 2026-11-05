"""staging 开关验证脚本（2026-10-22 配置开启任务）。

用途：对一个**已启动的 ai-service** 实例做开关效果验证，输出可直接贴进开发日志的数据。
不启动服务、不改配置；只发任务、量耗时、读结果。

用法（在 `backend/ai-service` 下用 venv 跑，或直接指定 venv python）：

    python tools/verify-ai-switches.py config --base http://127.0.0.1:8011
    python tools/verify-ai-switches.py cache  --base http://127.0.0.1:8011 --runs 5
    python tools/verify-ai-switches.py asr    --base http://127.0.0.1:8011 --ref asr:demo1 --runs 2
    python tools/verify-ai-switches.py rag    --base http://127.0.0.1:8011

口径：
- 任务耗时 = 提交时刻 → 轮询到终态时刻（含排队；单 worker 串行，所以这就是用户侧等待）；
- 缓存命中以返回体 `cached=true` 为准（服务端判定，不由脚本推断）；
- 输出里**不含**地址/密钥（`--base` 只用于连接，不打印）。
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request

TASKS = "/internal/v1/tasks"
TERMINAL = {"SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"}

TRIAGE_TEXT = "最近两天胃疼，吃完饭有点反酸，想看看挂什么科。"
CHAT_TEXT = "门诊时间到几点？"


def _request(base: str, method: str, path: str, body: dict | None = None, headers: dict | None = None):
    """最小 HTTP 客户端：**禁用环境代理**（本机设了 http_proxy，会把 127.0.0.1 也代理掉）。"""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _submit(base: str, task_type: str, *, key: str, input_inline: str | None = None,
            input_ref: str | None = None) -> dict:
    body = {
        "tenantId": "t-staging", "userId": "u-staging", "taskType": task_type,
        "policyVersion": "policy-staging", "traceId": f"trace-{key}",
    }
    if input_inline is not None:
        body["inputInline"] = input_inline
    if input_ref is not None:
        body["inputRef"] = input_ref
    return _request(base, "POST", TASKS, body, {"Idempotency-Key": key})["data"]


def _wait(base: str, task_id: str, timeout: float = 180.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = _request(base, "GET", f"{TASKS}/{task_id}")["data"]
        if data["status"] in TERMINAL:
            return data
        time.sleep(0.05)
    raise SystemExit(f"任务 {task_id} 未在 {timeout:.0f}s 内到达终态")


def _run_task(base: str, task_type: str, *, key: str, input_inline: str | None = None,
              input_ref: str | None = None, timeout: float = 180.0) -> tuple[dict, float]:
    started = time.perf_counter()
    task_id = _submit(base, task_type, key=key, input_inline=input_inline, input_ref=input_ref)["taskId"]
    done = _wait(base, task_id, timeout=timeout)
    return done, round((time.perf_counter() - started) * 1000, 1)


def cmd_config(args) -> int:
    ready = _request(args.base, "GET", "/internal/health/ready")
    data = ready.get("data") or ready
    print(f"readiness status = {data.get('status')}")
    for dep in data.get("dependencies", []):
        detail = str(dep.get("detail") or "")
        print(f"  {dep['name']:<14} {dep['status']:<12} {detail[:80]}")
    for model in data.get("models", []):
        print(f"  model[{model['role']:<13}] {str(model.get('modelId')):<20} {model['status']}")
    return 0


def cmd_cache(args) -> int:
    rows = []
    for i in range(args.runs):
        done, ms = _run_task(args.base, "TRIAGE", key=f"cache-{int(time.time())}-{i}", input_inline=TRIAGE_TEXT)
        rows.append({"ms": ms, "cached": bool(done.get("cached")), "status": done["status"]})
        print(f"  [{i + 1}] status={done['status']:<9} cached={str(rows[-1]['cached']):<5} {ms} ms")

    hits = sum(1 for r in rows if r["cached"])
    misses = [r["ms"] for r in rows if not r["cached"]]
    hit_ms = [r["ms"] for r in rows if r["cached"]]
    print(f"命中率 = {hits}/{len(rows)} = {hits / len(rows) * 100:.1f}%")
    if misses:
        print(f"未命中耗时(中位) = {statistics.median(misses)} ms")
    if hit_ms:
        print(f"命中耗时(中位)   = {statistics.median(hit_ms)} ms")
        if misses:
            print(f"加速比           = {statistics.median(misses) / statistics.median(hit_ms):.0f}x")
    return 0 if hits >= max(1, len(rows) - 1) else 1


def cmd_asr(args) -> int:
    rows = []
    for i in range(args.runs):
        done, ms = _run_task(args.base, "ASR", key=f"asr-{int(time.time())}-{i}", input_ref=args.ref, timeout=300)
        text = ""
        if done.get("result"):
            payload = done["result"] or {}
            # ASR 契约用 transcript（不是 text）；换行/标点会被模型吃掉属正常
            text = str(payload.get("transcript") or payload.get("text") or "")[:40]
        rows.append(ms)
        print(f"  [{i + 1}] status={done['status']:<9} {ms:>8} ms  text={text}")
        if done["status"] != "SUCCEEDED":
            print("   error =", json.dumps(done.get("error"), ensure_ascii=False))
            return 1
    if len(rows) >= 2:
        print(f"首次 = {rows[0]} ms | 第二次 = {rows[1]} ms | 差 = {round(rows[0] - rows[1], 1)} ms")
    return 0


def cmd_rag(args) -> int:
    done, ms = _run_task(args.base, "RAG", key=f"rag-{int(time.time())}", input_inline="高血压要注意什么？")
    result = done.get("result") or {}
    docs = result.get("documents") or []
    print(f"RAG task status={done['status']} {ms} ms | documents={len(docs)} | provenance={result.get('provenance')}")
    if docs:
        first = docs[0]
        print("  示例(脱敏) =", json.dumps({
            "documentId": first.get("documentId"),
            "chunkId": first.get("chunkId"),
            "score": first.get("score"),
            "title": (first.get("metadata") or {}).get("title"),
            "contentLen": len(str(first.get("content") or "")),
        }, ensure_ascii=False))

    chat, chat_ms = _run_task(args.base, "CHAT", key=f"rag-chat-{int(time.time())}", input_inline=CHAT_TEXT)
    cres = chat.get("result") or {}
    print(f"CHAT task status={chat['status']} {chat_ms} ms | citations={len(cres.get('citations') or [])} "
          f"| textLen={len(str(cres.get('text') or ''))}")
    print("  降级判定 =", "生效（无引用但回答照常）" if chat["status"] == "SUCCEEDED" and not (cres.get("citations") or [])
          else "未观察到降级（引用非空或回答失败）")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="ai-service 开关验证（cache / asr / rag / config）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("config", help="打印 readiness（脱敏）")
    p.add_argument("--base", required=True)
    p.set_defaults(func=cmd_config)

    p = sub.add_parser("cache", help="同输入重复提交，量命中率与命中耗时")
    p.add_argument("--base", required=True)
    p.add_argument("--runs", type=int, default=5)
    p.set_defaults(func=cmd_cache)

    p = sub.add_parser("asr", help="同一音频重复识别，量首次/第二次耗时")
    p.add_argument("--base", required=True)
    p.add_argument("--ref", required=True, help="asr:{id}，文件需在 AI_ASR_AUDIO_DIR 下")
    p.add_argument("--runs", type=int, default=2)
    p.set_defaults(func=cmd_asr)

    p = sub.add_parser("rag", help="RAG 检索 + CHAT 引用/降级")
    p.add_argument("--base", required=True)
    p.set_defaults(func=cmd_rag)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
