#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""压缩小程序主包内置 PNG（图标 / 插画），减小「主包大小」与「图片和音频资源」两项代码质量告警。

策略：
  · 只处理 miniprogram/assets/icons 与 miniprogram/assets/home（UI 线性图标 + 扁平插画），
    不碰用户头像、报告单照片这类内容型图片；
  · 有 alpha → RGBA + FASTOCTREE 量化；无 alpha → RGB + MEDIANCUT 量化；
  · 量化后若不比原文件小 8% 以上，回滚原图（宁可不省，也不劣化）；
  · 幂等：已经是调色板模式（P）的文件跳过。

用法：
  python tools/optimize-assets.py --dry-run   # 只统计能省多少
  python tools/optimize-assets.py             # 实际写入
"""
import os
import shutil
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET_DIRS = [
    os.path.join(ROOT, 'miniprogram', 'assets', 'icons'),
    os.path.join(ROOT, 'miniprogram', 'assets', 'home'),
]
COLORS = 64
MIN_SAVE_RATIO = 0.92   # 至少省 8% 才采用
MIN_SIZE = 1024         # 小于 1KB 的不折腾


def optimize_one(path, dry_run):
    before = os.path.getsize(path)
    if before < MIN_SIZE:
        return before, before, False
    try:
        img = Image.open(path)
    except Exception:
        return before, before, False
    if img.mode == 'P':
        return before, before, False
    has_alpha = ('A' in img.getbands()) or (img.mode == 'RGBA')
    if has_alpha:
        work = img.convert('RGBA').quantize(colors=COLORS, method=Image.FASTOCTREE)
    else:
        work = img.convert('RGB').quantize(colors=COLORS, method=Image.MEDIANCUT)

    tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
    tmp.close()
    try:
        work.save(tmp.name, 'PNG', optimize=True)
        after = os.path.getsize(tmp.name)
        if after >= before * MIN_SAVE_RATIO:
            return before, before, False
        if not dry_run:
            shutil.copyfile(tmp.name, path)
        return before, after, True
    finally:
        os.unlink(tmp.name)


def main():
    dry_run = '--dry-run' in sys.argv
    total_before = 0
    total_after = 0
    changed = 0
    for d in TARGET_DIRS:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.lower().endswith('.png'):
                continue
            path = os.path.join(d, name)
            before, after, ok = optimize_one(path, dry_run)
            total_before += before
            total_after += after
            changed += 1 if ok else 0
            if ok:
                print('  %-34s %6.1f KB -> %6.1f KB' % (name, before / 1024.0, after / 1024.0))
    print('%s：%d 张可压缩，合计 %.1f KB -> %.1f KB（省 %.1f KB）' % (
        '试算' if dry_run else '完成', changed,
        total_before / 1024.0, total_after / 1024.0, (total_before - total_after) / 1024.0))


if __name__ == '__main__':
    main()
