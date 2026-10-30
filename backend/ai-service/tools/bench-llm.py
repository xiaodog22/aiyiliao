"""LLM 并发 / 连接复用 / 流式 压测（2026-10-22）。

隔离真实 LLM 波动：把 ai-service 的 `AI_OLLAMA_URL` 指向本地 `stub-ollama-llm.py`，
对比两种配置下的吞吐与延迟：

  BEFORE（旧行为）：pool=1, stream=off, http-reuse=off
  AFTER （优化）：  pool=<N>, stream=on,  http-reuse=on

输出：并发 QPS、P95 延迟、错误率，以及 AFTER 的流式首 token 延迟（取自 /internal/metrics/llm）。

用法：
  .venv/Scripts/python.exe tools/bench-llm.py --tasks 40 --pool 4 --latency 200 --first-token 80
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx

SERVICE_DIR = Path(__file__).resolve().parent.parent
VENV_PY = sys.executable
TERMINAL = ("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED")


def _wait_port(url: str, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = httpx.get(url, timeout=1.0)
            if r.status_code < 500:
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def _pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
    return round(s[k] * 1000, 1)  # ms


def start_stub(stub_port: int, latency: float, first_token: float, *, break_stream: bool = False) -> subprocess.Popen:
    cmd = [VENV_PY, str(SERVICE_DIR / "tools" / "stub-ollama-llm.py"),
           "--port", str(stub_port), "--latency", str(latency), "--first-token", str(first_token)]
    if break_stream:
        cmd.append("--break-stream")
    p = subprocess.Popen(cmd, cwd=str(SERVICE_DIR))
    ok = _wait_port(f"http://127.0.0.1:{stub_port}/api/tags", timeout=10)
    if not ok:
        raise RuntimeError("stub 未就绪")
    return p


def start_ai(stub_port: int, ai_port: int, *, pool: int, stream: bool, reuse: bool) -> subprocess.Popen:
    env = os.environ.copy()
    env.update({
        "PYTHONPATH": str(SERVICE_DIR),
        "AI_OLLAMA_URL": f"http://127.0.0.1:{stub_port}",
        "AI_LLM_WORKER_POOL_SIZE": str(pool),
        "AI_LLM_STREAM": "true" if stream else "false",
        "AI_LLM_HTTP_CLIENT_REUSE": "true" if reuse else "false",
        "AI_CHAT_TIMEOUT_SECONDS": "30",
        "AI_LOG_LEVEL": "WARNING",
        "AI_CACHE_ENABLED": "false",
        "AI_AUTH_MODE": "off",
        "AI_QUEUE_MAX": "300",
        "AI_STORE_PATH": tempfile.mkdtemp(prefix="ai-bench-") + "/tasks.json",
        "AI_PROBE_TIMEOUT_SECONDS": "2",
    })
    p = subprocess.Popen(
        [VENV_PY, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(ai_port),
         "--log-level", "warning"],
        cwd=str(SERVICE_DIR), env=env,
    )
    ok = _wait_port(f"http://127.0.0.1:{ai_port}/internal/health/live", timeout=30)
    if not ok:
        p.terminate()
        raise RuntimeError("ai-service 未就绪")
    return p


def _one_task(client: httpx.Client, ai_port: int, key: str):
    body = {
        "tenantId": "t1", "userId": "u1", "taskType": "CHAT",
        "policyVersion": "p1", "traceId": "bench", "inputInline": "这两天有点头晕怎么办",
    }
    t0 = time.time()
    try:
        r = client.post(f"http://127.0.0.1:{ai_port}/internal/v1/tasks", json=body,
                        headers={"Idempotency-Key": key}, timeout=40)
    except Exception as exc:
        return {"key": key, "submit": t0, "terminal": time.time(), "status": "SUBMIT_ERR", "err": str(exc)}
    if r.status_code != 200:
        return {"key": key, "submit": t0, "terminal": time.time(), "status": f"HTTP_{r.status_code}", "err": r.text[:80]}
    task_id = r.json()["data"]["taskId"]
    while True:
        try:
            g = client.get(f"http://127.0.0.1:{ai_port}/internal/v1/tasks/{task_id}", timeout=10)
            d = g.json()["data"]
        except Exception as exc:
            return {"key": key, "submit": t0, "terminal": time.time(), "status": "POLL_ERR", "err": str(exc)}
        if d["status"] in TERMINAL:
            return {"key": key, "submit": t0, "terminal": time.time(),
                    "status": d["status"], "err": (d.get("error") or {}).get("code")}
        time.sleep(0.02)


def run_scenario(ai_port: int, tasks: int, *, pool: int, stream: bool, reuse: bool,
                 stub_port: int, latency: float, first_token: float,
                 break_stream: bool = False) -> dict:
    stub = start_stub(stub_port, latency, first_token, break_stream=break_stream)
    ai = None
    try:
        ai = start_ai(stub_port, ai_port, pool=pool, stream=stream, reuse=reuse)
        client = httpx.Client(timeout=60)
        rows = []
        with ThreadPoolExecutor(max_workers=tasks) as ex:
            futs = [ex.submit(_one_task, client, ai_port, f"bench-{i:04d}-key") for i in range(tasks)]
            for f in as_completed(futs):
                rows.append(f.result())
        client.close()

        latencies = [r["terminal"] - r["submit"] for r in rows]
        submit_ts = [r["submit"] for r in rows]
        terminal_ts = [r["terminal"] for r in rows]
        window = (max(terminal_ts) - min(submit_ts)) or 1e-9
        fails = [r for r in rows if r["status"] != "SUCCEEDED"]
        qps = tasks / window
        # 首 token：仅 AFTER（stream=on）可读
        first = None
        if stream:
            try:
                m = httpx.get(f"http://127.0.0.1:{ai_port}/internal/metrics/llm", timeout=5).json()
                first = {"p50": m.get("firstTokenP50Ms"), "p95": m.get("firstTokenP95Ms"),
                         "ok": m.get("streamOk"), "fallback": m.get("streamFallback")}
            except Exception:
                first = None
        return {
            "pool": pool, "stream": stream, "reuse": reuse,
            "qps": round(qps, 2),
            "p95_ms": _pct(latencies, 95),
            "p50_ms": _pct(latencies, 50),
            "err_rate": round(100.0 * len(fails) / max(1, len(rows)), 1),
            "fails": len(fails),
            "first_token": first,
        }
    finally:
        if ai is not None:
            ai.terminate()
            try:
                ai.wait(timeout=10)
            except Exception:
                ai.kill()
        stub.terminate()
        try:
            stub.wait(timeout=5)
        except Exception:
            stub.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", type=int, default=40)
    ap.add_argument("--pool", type=int, default=4, help="AFTER 场景的 worker 池大小")
    ap.add_argument("--latency", type=float, default=200, help="桩总生成耗时(ms)")
    ap.add_argument("--first-token", type=float, default=80, help="桩首 token 延迟(ms)")
    ap.add_argument("--stub-port", type=int, default=11499)
    ap.add_argument("--ai-port-before", type=int, default=8011)
    ap.add_argument("--ai-port-after", type=int, default=8012)
    args = ap.parse_args()

    print(f"[bench] tasks={args.tasks} latency={args.latency}ms firstToken={args.first_token}ms", flush=True)

    print("[bench] === BEFORE（旧行为: pool=1, stream=off, reuse=off）===", flush=True)
    before = run_scenario(
        args.ai_port_before, args.tasks, pool=1, stream=False, reuse=False,
        stub_port=args.stub_port, latency=args.latency, first_token=args.first_token,
    )
    _print(before)

    print("[bench] === AFTER （优化: pool=%d, stream=on, reuse=on）===" % args.pool, flush=True)
    after = run_scenario(
        args.ai_port_after, args.tasks, pool=args.pool, stream=True, reuse=True,
        stub_port=args.stub_port + 1, latency=args.latency, first_token=args.first_token,
    )
    _print(after)

    print("[bench] === DEGRADE （AFTER 配置 + 桩强制流式 500 → 应全量回退非流式）===", flush=True)
    degrade = run_scenario(
        args.ai_port_after + 1, args.tasks, pool=args.pool, stream=True, reuse=True,
        stub_port=args.stub_port + 2, latency=args.latency, first_token=args.first_token,
        break_stream=True,
    )
    _print(degrade)
    # 降级断言：错误率必须 0，且 metrics 记录到流式回退
    fb = (degrade["first_token"] or {}).get("fallback") or 0
    degrade_ok = degrade["err_rate"] == 0 and fb >= args.tasks
    print(f"[bench] 降级验证: errRate={degrade['err_rate']}% streamFallback={fb} -> {'PASS' if degrade_ok else 'FAIL'}",
          flush=True)

    speedup = round(before["p95_ms"] / after["p95_ms"], 2) if after["p95_ms"] else None
    print("\n[bench] 汇总对比", flush=True)
    print(f"  QPS        : {before['qps']}  ->  {after['qps']}   (x{round(after['qps']/max(before['qps'],1e-9),2)})")
    print(f"  P95 延迟   : {before['p95_ms']}ms -> {after['p95_ms']}ms (x{speedup})")
    print(f"  错误率     : {before['err_rate']}% -> {after['err_rate']}%")
    if after["first_token"]:
        ft = after["first_token"]
        print(f"  首 token   : P50={ft['p50']}ms P95={ft['p95']}ms (streamOk={ft['ok']}, fallback={ft['fallback']})")
    print(f"  降级回退   : errRate={degrade['err_rate']}% streamFallback={fb} -> {'PASS' if degrade_ok else 'FAIL'}",
          flush=True)
    print("[bench] done", flush=True)


def _print(r: dict):
    print(f"  pool={r['pool']} stream={r['stream']} reuse={r['reuse']} | "
          f"QPS={r['qps']} P50={r['p50_ms']}ms P95={r['p95_ms']}ms err={r['err_rate']}% fails={r['fails']}", flush=True)


if __name__ == "__main__":
    main()
