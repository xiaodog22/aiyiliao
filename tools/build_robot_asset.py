#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从设计稿原图 robot-wave（JPEG，白底棋盘格）生成透明背景机器人 PNG。

为什么不能按颜色抠：
  背景是 249~255 的极浅棋盘格，与机身白色(255)几乎同色，直接按亮度阈值会把
  机身一起抠掉。改用「连通域」判据：只有与画布边缘连通的浅色区域才算背景，
  机身内部被深色描边包住的白色高光会保留。

输出：RGBA PNG，尺寸 720 宽（与旧资源一致），主包/服务端同源。
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def cut_background(img: Image.Image, light_thr: int = 244, feather: int = 1) -> Image.Image:
    rgb = np.array(img.convert("RGB"))
    h, w, _ = rgb.shape

    # 候选背景：三通道都很亮
    light = (rgb[:, :, 0] >= light_thr) & (rgb[:, :, 1] >= light_thr) & (rgb[:, :, 2] >= light_thr)
    lab, n = ndimage.label(light)
    if n == 0:
        raise SystemExit("未找到浅色区域，阈值需调整")

    border = set(lab[0, :].tolist()) | set(lab[-1, :].tolist())
    border |= set(lab[:, 0].tolist()) | set(lab[:, -1].tolist())
    border.discard(0)

    bg = np.isin(lab, list(border))
    alpha = np.where(bg, 0, 255).astype(np.uint8)

    # 边缘羽化：对 alpha 做轻微高斯，消除 JPEG 振铃造成的硬锯齿
    if feather > 0:
        a = ndimage.gaussian_filter(alpha.astype(np.float32), sigma=feather)
        alpha = np.clip(a, 0, 255).astype(np.uint8)

    out = np.dstack([rgb, alpha])
    return Image.fromarray(out, mode="RGBA")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="design-output/assets/img/robot-wave.png")
    ap.add_argument("--out", default="backend/deploy/resources/xiaoan-robot.png")
    ap.add_argument("--width", type=int, default=720)
    ap.add_argument("--thr", type=int, default=244)
    ap.add_argument("--preview", default=None)
    args = ap.parse_args()

    src = Path(args.src)
    img = Image.open(src)
    print("源图：%s %s %s" % (src, img.format, img.size))

    cut = cut_background(img, light_thr=args.thr)
    arr = np.array(cut)
    alpha = arr[:, :, 3]
    print("抠图：不透明 %d，透明 %d" % (int((alpha > 200).sum()), int((alpha < 32).sum())))

    # 裁到内容 bbox，四周留 2% 余量
    ys, xs = np.where(alpha > 32)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    pad = int(max(y1 - y0, x1 - x0) * 0.02)
    y0, x0 = max(0, y0 - pad), max(0, x0 - pad)
    y1, x1 = min(arr.shape[0] - 1, y1 + pad), min(arr.shape[1] - 1, x1 + pad)
    crop = cut.crop((x0, y0, x1 + 1, y1 + 1))
    print("裁剪：(%d,%d)-(%d,%d) → %s" % (x0, y0, x1, y1, crop.size))

    # 缩放到目标宽度
    ratio = args.width / float(crop.size[0])
    target = (args.width, int(round(crop.size[1] * ratio)))
    final = crop.resize(target, Image.LANCZOS)
    print("缩放：%s（比例 %.3f）" % (final.size, final.size[1] / final.size[0]))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    final.save(out, format="PNG", optimize=True)
    print("已写出 %s（%d 字节）" % (out, out.stat().st_size))

    if args.preview:
        bg = np.array([11, 110, 248], dtype=np.float32)
        a = np.array(final)[:, :, 3:4].astype(np.float32) / 255.0
        comp = (np.array(final)[:, :, :3].astype(np.float32) * a + bg * (1 - a)).astype(np.uint8)
        Image.fromarray(comp).save(args.preview)
        print("检视图：%s" % args.preview)


if __name__ == "__main__":
    main()
