"""
TTS 预生成脚本（2026-10-22）。

遍历 config/tts-pregen-phrases.json 的固定句式，对每个文本：
  - 算 SHA16 digest（与 executors/tts.py 完全一致的缓存键）
  - 产物已存在且非空 → 跳过（命中缓存）
  - 不存在 → 调 edge-tts 合成落盘

用法：
  .venv\\Scripts\\python.exe scripts/pregenerate_tts.py           # 跑一遍
  .venv\\Scripts\\python.exe scripts/pregenerate_tts.py --dry-run  # 只看不写
  .venv\\Scripts\\python.exe scripts/pregenerate_tts.py --force   # 强制重合成

注意：
  - 清单中 {科室}/{位置} 等占位符未替换（预生成的是"模板基础音"）；
    带占位符的文本命中缓存后，业务侧实际文本不同 → 不会命中。
    因此清单里只放**不含占位符的纯固定句**（见 JSON 注释）。
  - 本脚本可独立跑，也可由 ai-service 启动时后台调用（见 main.py startup）。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from pathlib import Path

# 让脚本能 import app.*（从 ai-service 根目录跑）
_SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SERVICE_DIR))

from app.config import Settings  # noqa: E402
from app.voice import resolve_voice, synthesize, tts_status  # noqa: E402


def digest_for(text: str, voice: str, locale: str) -> str:
    return hashlib.sha256(f"{text}|{voice}|{locale}".encode("utf-8")).hexdigest()[:16]


async def run(settings: Settings, dry_run: bool, force: bool) -> int:
    phrases_path = Path(settings.tts_pregen_phrases_path)
    if not phrases_path.exists():
        print(f"[pregen] 清单不存在: {phrases_path}")
        return 0

    data = json.loads(phrases_path.read_text(encoding="utf-8"))
    phrases = data.get("phrases", [])
    print(f"[pregen] 清单: {len(phrases)} 条 | version={data.get('version')}")

    status, detail = tts_status(settings)
    if status != "available":
        print(f"[pregen] TTS 不可用，跳过: {detail}")
        return 0

    out_dir = Path(settings.tts_output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    default_voice = settings.tts_default_voice
    locale = "zh-CN"

    synthesized = 0
    skipped = 0
    failed = 0
    t0 = time.perf_counter()

    for ph in phrases:
        text = ph["text"]
        pid = ph["id"]
        voice = resolve_voice(settings, None)  # None → 默认音色
        d = digest_for(text, voice, locale)
        out_path = out_dir / f"{d}.mp3"

        if out_path.exists() and out_path.stat().st_size > 0 and not force:
            skipped += 1
            print(f"  [skip] {pid} ({d}.mp3 已存在)")
            continue

        if dry_run:
            print(f"  [dry-run] {pid} → {d}.mp3 ({len(text)} 字)")
            continue

        try:
            print(f"  [synth] {pid} ({d}.mp3) ...", end=" ", flush=True)
            await synthesize(settings, text, voice, out_path)
            sz = out_path.stat().st_size if out_path.exists() else 0
            print(f"ok ({sz} bytes)")
            synthesized += 1
        except Exception as exc:
            print(f"FAIL: {exc.__class__.__name__}: {str(exc)[:100]}")
            failed += 1
            # 清理残片（与 tts.py 一致）
            try:
                if out_path.exists():
                    out_path.unlink()
            except OSError:
                pass

    elapsed = time.perf_counter() - t0
    print(f"\n[pregen] 完成: 合成={synthesized} 跳过={skipped} 失败={failed} 耗时={elapsed:.1f}s")
    return 0 if failed == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    settings = Settings()
    if not settings.tts_pregen_enabled and not args.dry_run:
        print(f"[pregen] AI_TTS_PREGEN_ENABLED=false，跳过（用 --dry-run 查看清单）")
        return 0

    asyncio.run(run(settings, args.dry_run, args.force))


if __name__ == "__main__":
    main()
