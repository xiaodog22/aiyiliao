# -*- coding: utf-8 -*-
"""M4 · D4.1 启动硬化——依赖中断故障演练（真实打停 + 幂等补起 + stop-all 干净度）。

演练矩阵（降级语义以运行态探针为准，不以代码字面为准）：
  DRILL-A 网关宕 → 直连 business 仍 UP（网关非业务单点）→ start-all 补起
  DRILL-B ai 宕   → 经网关 TTS → 503 CAPABILITY_UNAVAILABLE（业务侧快降级）→ start-all 补起
  DRILL-C business 宕 → 经网关 /api/** → 503 UPSTREAM_UNAVAILABLE → start-all 补起
  DRILL-D 全停干净度：stop-all 后 8080/8001/8088 无任何 LISTENING → start-all 全量恢复

用法：python fault_drill.py --deploy <deploy目录> --out <证据输出目录>
退出码：0=全绿；1=存在失败。stdout 为人类可读摘要，同时落盘 drill-report.json/txt。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

PORTS = {"gateway": 8080, "business": 8088, "ai": 8001}
RESULTS: list[dict] = []


def http_probe(url: str, method: str = "GET", body: bytes | None = None,
               headers: dict | None = None, timeout: float = 8.0) -> dict:
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return {"status": resp.status, "body": raw[:600].decode("utf-8", "replace")}
    except urllib.error.HTTPError as e:
        raw = e.read()
        return {"status": e.code, "body": raw[:600].decode("utf-8", "replace")}
    except Exception as e:  # 连不上：连接类错误也视为可观测结果
        return {"status": 0, "body": type(e).__name__ + ": " + str(e)[:160]}


def check(name: str, ok: bool, detail: str) -> None:
    RESULTS.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + "  |  " + detail, flush=True)


def port_pid(port: int) -> int | None:
    """按端口定位**真实监听进程** pid（pid 文件记的可能是已退出的启动器包装）。"""
    out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                         timeout=60).stdout
    for line in out.splitlines():
        if (":" + str(port)) in line and "LISTENING" in line.upper():
            parts = line.split()
            try:
                return int(parts[-1])
            except (ValueError, IndexError):
                continue
    return None


def kill_port(port: int) -> None:
    pid = port_pid(port)
    if pid is None:
        return
    # taskkill /T 连同子进程一起终止
    subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"],
                   capture_output=True, timeout=30)


def port_listening(port: int) -> bool:
    out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                         timeout=60).stdout
    return any((":" + str(port)) in line and "LISTENING" in line.upper()
               for line in out.splitlines())


def wait_health(url: str, contains: str | None, timeout_s: float) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        r = http_probe(url, timeout=5.0)
        if r["status"] in (200, 503) and (contains is None or contains in r["body"]):
            return True
        time.sleep(2)
    return False


def start_all(deploy: str, health_timeout: float) -> None:
    """幂等补起：orchestrator 对健康服务返回 already，只补起挂掉的。

    输出走**文件重定向**而非管道：uvicorn/java 等孙进程会继承管道句柄，
    令 subprocess.run 的 timeout 形同虚设（cmd 退出后仍阻塞在管道读取上）。
    """
    env = dict(os.environ)
    env["NO_PROXY"] = "*"
    log = os.path.join(deploy, "run", "_drill-startall.log")
    with open(log, "a", encoding="utf-8") as f:
        # `< nul`：bat 末尾的 pause 在空 stdin 下立即返回，否则非交互挂起
        subprocess.run(["cmd", "/c", "start-all.bat < nul"], cwd=deploy,
                       stdout=f, stderr=subprocess.STDOUT,
                       timeout=max(240, health_timeout * 3 + 120), env=env)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--deploy", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--skip-clean", action="store_true",
                    help="跳过 DRILL-D 全停干净度演练")
    args = ap.parse_args()
    deploy, out = os.path.abspath(args.deploy), os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)

    # 回环探针：剥离代理注入（HTTP(S)_PROXY 会劫持 127.0.0.1）
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
              "ALL_PROXY", "all_proxy"):
        os.environ.pop(k, None)
    os.environ["NO_PROXY"] = os.environ["no_proxy"] = "*"

    GW = "http://127.0.0.1:8080"
    BIZ = "http://127.0.0.1:8088"
    AI = "http://127.0.0.1:8001"
    tts_body = json.dumps({"text": "演练"}).encode()
    tts_headers = {"Content-Type": "application/json", "Idempotency-Key": "drill-tts-0001"}

    # ---- 基线（不全则先自举：本工具环境下常驻服务随任务结束被回收，
    #      bringup+演练+取证必须同一任务内完成，见 DEV_LOG 2026-10-15 22:24 教训①）----
    base = {n: http_probe(u) for n, u in
            (("gw", GW + "/api/gw/health"), ("biz", BIZ + "/actuator/health"),
             ("ai", AI + "/internal/health/live"))}
    if not all(r["status"] in (200, 503) for r in base.values()):
        print("基线不全，先 start-all 自举…", flush=True)
        start_all(deploy, 90)
        # business 冷启动可能超出编排器 90s 健康窗，追加等待
        wait_health(BIZ + "/actuator/health", '"UP"', 240)
        wait_health(GW + "/api/gw/health", None, 60)
        wait_health(AI + "/internal/health/live", '"status"', 60)
        base = {n: http_probe(u) for n, u in
                (("gw", GW + "/api/gw/health"), ("biz", BIZ + "/actuator/health"),
                 ("ai", AI + "/internal/health/live"))}
    base_ok = all(r["status"] in (200, 503) for r in base.values())
    check("基线三服务可达", base_ok,
          json.dumps({n: r["status"] for n, r in base.items()}))
    if not base_ok:
        print("基线不满足，终止演练（不改动运行态）")
        _write(out, {})
        return 1

    # ---- 登录取令牌（M 侧鉴权收口后 TTS 需登录态；匿名回退已移除）----
    lr = http_probe(GW + "/api/v1/auth/wechat/login", "POST",
                    json.dumps({"code": "dev-user-1-code", "consentVersion": "v1.0"}).encode(),
                    {"Content-Type": "application/json", "X-Client-Version": "1.0.0",
                     "X-Platform": "wechat-miniprogram"}, timeout=15)
    m = re.search(r'"accessToken":"([^"]+)"', lr["body"])
    token = m.group(1) if m else ""
    check("基线登录取 accessToken", bool(token),
          f"status={lr['status']} token={'已取得' if token else '缺失'}")
    if token:
        tts_headers["Authorization"] = "Bearer " + token

    # ---- DRILL-A：网关宕，business 独立可用 ----
    kill_port(PORTS["gateway"])
    time.sleep(2)
    down = http_probe(GW + "/api/gw/health")["status"] == 0
    biz_alive = http_probe(BIZ + "/actuator/health", timeout=6.0)["status"] == 200
    check("DRILL-A 网关宕→直连business仍UP", down and biz_alive,
          f"gateway探测={down} business直连200={biz_alive}")
    start_all(deploy, 90)
    check("DRILL-A start-all幂等补起网关",
          wait_health(GW + "/api/gw/health", None, 90), "经 start-all 恢复")

    # ---- DRILL-B：ai 宕，TTS 快降级 ----
    kill_port(PORTS["ai"])
    time.sleep(2)
    r = http_probe(GW + "/api/v1/voice/tts", "POST", tts_body, tts_headers, timeout=15)
    body = r["body"]
    # 降级信封两形态：ai 侧 CAPABILITY_UNAVAILABLE / business 编排侧 AI_UNAVAILABLE（结构化、retryable）
    ok = r["status"] == 503 and ("CAPABILITY_UNAVAILABLE" in body or "AI_UNAVAILABLE" in body)
    check("DRILL-B ai宕→TTS快降级503", ok,
          f"status={r['status']} body={body[:200]}")
    start_all(deploy, 90)
    check("DRILL-B start-all补起ai",
          wait_health(AI + "/internal/health/live", '"status"', 90),
          "经 start-all 恢复")

    # ---- DRILL-C：business 宕，网关代理 503 ----
    kill_port(PORTS["business"])
    deadline = time.time() + 30
    while time.time() < deadline and port_listening(8088):
        time.sleep(1)
    r = http_probe(GW + "/api/v1/voice/voices", timeout=15)
    check("DRILL-C business宕→网关503 UPSTREAM_UNAVAILABLE",
          r["status"] == 503 and "UPSTREAM_UNAVAILABLE" in r["body"],
          f"status={r['status']} body={r['body'][:200]}")
    start_all(deploy, 90)
    check("DRILL-C start-all补起business",
          wait_health(BIZ + "/actuator/health", '"UP"', 240), "经 start-all 恢复")

    # ---- DRILL-D：全停干净度（可选）----
    if not args.skip_clean:
        stoplog = os.path.join(deploy, "run", "_drill-stopall.log")
        with open(stoplog, "a", encoding="utf-8") as f:
            subprocess.run(["cmd", "/c", "stop-all.bat < nul"], cwd=deploy,
                           stdout=f, stderr=subprocess.STDOUT, timeout=240,
                           env={**os.environ, "NO_PROXY": "*"})
        time.sleep(3)
        residue = {n: port_listening(p) for n, p in PORTS.items()}
        check("DRILL-D stop-all后端口无残留", not any(residue.values()),
              json.dumps(residue))
        start_all(deploy, 90)

    # ---- 终态健康 ----
    final_ok = (wait_health(GW + "/api/gw/health", None, 60)
                and wait_health(BIZ + "/actuator/health", '"UP"', 60)
                and wait_health(AI + "/internal/health/live", '"status"', 60))
    check("演练终态三服务恢复", final_ok, "gateway/business/health 全部回 UP")

    failed = [r for r in RESULTS if not r["ok"]]
    _write(out, {"ts": datetime.now().isoformat(timespec="seconds"),
                 "total": len(RESULTS), "failed": len(failed), "results": RESULTS})
    print(f"\n== 演练汇总：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过 ==")
    return 1 if failed else 0


def _write(out: str, extra: dict) -> None:
    doc = {"ts": datetime.now().isoformat(timespec="seconds"), "results": RESULTS, **extra}
    with open(os.path.join(out, "drill-report.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out, "drill-report.txt"), "w", encoding="utf-8") as f:
        for r in RESULTS:
            f.write(("PASS " if r["ok"] else "FAIL ") + r["name"] + " | " + r["detail"] + "\n")


if __name__ == "__main__":
    sys.exit(main())
