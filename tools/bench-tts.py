"""TTS 性能实测：旧路径 vs 流式 vs 连接池 vs 缓存命中（2026-10-22 优化验收）。

跑法（必须用 ai-service 的 venv，且需要出网到 edge-tts 服务）：
    cd backend/ai-service
    .venv/Scripts/python.exe ../../tools/bench-tts.py --runs 5

输出：
- 每个配置逐次的首字节/总耗时（毫秒）与中位数；
- 缓存命中：同一文本第二次调用（执行器层，纯文件路径）的耗时。

口径说明（不编造）：
- 旧路径（save）**没有首字节观测点** → firstByte 打印 "n/a"，只报总耗时；
- 流式路径的 firstByte = 第一个 audio 分片到达时刻（不含落盘 fsync，落盘是顺序写）；
- 连接池档与 fresh 档跑同一个 stream 实现，唯一差异是是否复用 `aiohttp.TCPConnector`，
  这一对差异就是「连接复用」的净收益（WS 握手无法跨请求跳过，差异通常很小，实测为准）。
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
import tempfile
import time
from pathlib import Path

_SERVICE_DIR = Path(__file__).resolve().parent.parent / "backend" / "ai-service"
sys.path.insert(0, str(_SERVICE_DIR))

from app import voice  # noqa: E402
from app.config import Settings  # noqa: E402
from app.executors import build_tts_executor  # noqa: E402

BASE_TEXT = "请按时服药，每天两次，饭后服用。如有不适请及时就医。"
VOICE_ID = "zh-CN-XiaoxiaoNeural"


def _settings(out_dir: Path, *, stream: bool) -> Settings:
    return Settings(
        tts_engine="edge",
        tts_stream=stream,
        tts_output_dir=out_dir,
        tts_url_ttl_seconds=600,
        log_level="WARNING",
    )


def _ms(value: float) -> float:
    return round(value * 1000, 1)


class _Ctx:
    async def set_phase(self, phase: str):
        pass


async def _bench_synthesize(
    out_dir: Path, *, stream: bool, runs: int, pool: bool, warmup: int = 0
) -> list[dict]:
    """直接打 voice.synthesize：stream=False 走旧 save 路径；stream=True 走流式。"""
    settings = _settings(out_dir, stream=stream)
    if not pool:
        # 关掉共享连接器 → 每次由 edge-tts 自己建 ClientSession（= 旧实现的连接行为）
        voice._tts_connector = lambda: None  # type: ignore[assignment]

    results: list[dict] = []
    for i in range(warmup + runs):
        text = f"{BASE_TEXT}（第{i + 1}次实测）"
        out_path = out_dir / f"bench_{stream}_{pool}_{i}.mp3"
        started = time.perf_counter()
        metrics = await voice.synthesize(settings, text, VOICE_ID, out_path)
        wall = _ms(time.perf_counter() - started)
        if i < warmup:
            continue  # 预热跑只用于付掉 DNS/TLS/DRM 的一次性成本，不计入统计
        size = out_path.stat().st_size if out_path.exists() else 0
        results.append({
            "firstByteMs": metrics.get("firstByteMs"),
            "totalMs": metrics.get("totalMs") or wall,
            "bytes": size,
            "mode": metrics.get("mode"),
        })
    if not pool:
        voice._tts_connector = _real_connector  # 复原
    return results


async def _bench_cache_hit(out_dir: Path, runs: int) -> dict:
    """执行器层缓存命中：同一文本第二次调用（不应触发任何网络）。"""
    settings = _settings(out_dir, stream=True)
    executor = build_tts_executor(settings, None)
    task = {"taskId": "bench-cache", "inputInline": BASE_TEXT, "voice": "qwen3-female-1"}

    cold_started = time.perf_counter()
    cold = await executor(dict(task), _Ctx())
    cold_ms = _ms(time.perf_counter() - cold_started)

    hit_samples: list[float] = []
    for i in range(runs):
        started = time.perf_counter()
        outcome = await executor({**task, "taskId": f"bench-cache-{i}"}, _Ctx())
        hit_samples.append(_ms(time.perf_counter() - started))
        assert outcome["model"]["cached"] is True, "第二次起必须是缓存命中"
    return {
        "coldMs": cold_ms,
        "coldCached": cold["model"]["cached"],
        "hitMs": hit_samples,
        "hitMedianMs": round(statistics.median(hit_samples), 1),
    }


_real_connector = voice._tts_connector


def _summarize(rows: list[dict]) -> dict:
    totals = [r["totalMs"] for r in rows]
    firsts = [r["firstByteMs"] for r in rows if r["firstByteMs"] is not None]
    return {
        "n": len(rows),
        "firstByteMedian": round(statistics.median(firsts), 1) if firsts else None,
        "totalMedian": round(statistics.median(totals), 1),
        "totalMin": min(totals),
        "totalMax": max(totals),
        "bytesMedian": int(statistics.median([r["bytes"] for r in rows])),
    }


def _print_table(label: str, summary: dict) -> None:
    first = "n/a" if summary["firstByteMedian"] is None else f"{summary['firstByteMedian']}ms"
    print(
        f"{label:<28} n={summary['n']}  首字节(中位)={first:<10} "
        f"总耗时(中位)={summary['totalMedian']}ms  "
        f"[{summary['totalMin']}~{summary['totalMax']}ms]  "
        f"产物≈{summary['bytesMedian']}B"
    )


async def main(runs: int, warmup: int = 1) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        print("=" * 96)
        print(f"TTS 性能实测（edge-tts 真实网络，每档 {runs} 次 + 预热 {warmup} 次不计入，文本逐次唯一以避免产物缓存）")
        print("=" * 96)

        # ① 旧路径（save，无连接池）
        legacy = await _bench_synthesize(tmp_path / "legacy", stream=False, runs=runs, pool=False, warmup=warmup)
        _print_table("① 旧路径 save（回滚档）", _summarize(legacy))
        print(f"   逐次总耗时: {[r['totalMs'] for r in legacy]}")

        # ② 流式 + 每次新建连接（隔离连接池变量）
        fresh = await _bench_synthesize(tmp_path / "fresh", stream=True, runs=runs, pool=False, warmup=warmup)
        _print_table("② 流式 stream（不共享连接）", _summarize(fresh))
        print(f"   逐次 首字节/总耗时: {[(r['firstByteMs'], r['totalMs']) for r in fresh]}")

        # ③ 流式 + 共享 TCPConnector（优化后默认档）
        pooled = await _bench_synthesize(tmp_path / "pooled", stream=True, runs=runs, pool=True, warmup=warmup)
        _print_table("③ 流式 stream（共享连接池）", _summarize(pooled))
        print(f"   逐次 首字节/总耗时: {[(r['firstByteMs'], r['totalMs']) for r in pooled]}")

        # ④ 缓存命中（执行器层）
        cache = await _bench_cache_hit(tmp_path / "cache", runs=runs)
        print(
            f"{'④ 缓存命中（执行器层）':<28} 首次={cache['coldMs']}ms(cached={cache['coldCached']})  "
            f"命中中位={cache['hitMedianMs']}ms  逐次={cache['hitMs']}"
        )

        s1, s2, s3 = _summarize(legacy), _summarize(fresh), _summarize(pooled)
        print("-" * 96)
        if s3["firstByteMedian"] is not None:
            print(f"流式首字节中位：{s3['firstByteMedian']}ms（旧路径不可观测）")
        print(f"总耗时中位：旧 {s1['totalMedian']}ms → 流式 {s3['totalMedian']}ms")
        print(f"连接池净收益（② vs ③，总耗时中位）：{round(s2['totalMedian'] - s3['totalMedian'], 1)}ms")
        print(f"缓存命中相比冷启动：{cache['coldMs']}ms → {cache['hitMedianMs']}ms")
        print("=" * 96)
    await voice.close_tts_connector()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=5, help="每档次数（默认 5）")
    parser.add_argument("--warmup", type=int, default=1, help="预热次数（默认 1，不计入统计）")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(max(1, args.runs), max(0, args.warmup))))
