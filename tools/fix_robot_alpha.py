#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""修复 assets/home/xiaoan-robot.png 的 alpha 通道破损，并转为标准真彩 RGBA。

背景（2026-10-20 实机排查）：
  该 PNG 是 indexed-color（colorType=3）+ 256 项 tRNS 调色板 alpha 表。
  腰部左侧轮廓在 y≈535~565 被误删（每行左缘内凹 60~90px），脚底阴影亦有碎裂。
  显示端 aspectFit 如实渲染 → 实机表现为「腰被啃掉一块」。

做法（只动缺口，不碰其余像素）：
  1. 逐行求 alpha>200 的左缘 l(y)；用缺口上下的健康行做线性基线 base(y)；
  2. 仅当 l(y) > base(y)+阈值 时，把 [base(y), l(y)) 区间补为不透明；
  3. 填色用同列上下健康像素的垂直插值（机身白 + 灰描边能自然延续）；
  4. 缺口边界做 2px alpha 羽化，避免硬边；
  5. 输出真彩 RGBA（colorType=6），消除调色板量化与 tRNS 兼容风险。
"""
import argparse
import struct
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image


def decode_palette_png(path: Path):
    """手工解码 8bit 调色板 PNG（含 256 项 tRNS），返回 rgba(uint8 HxWx4)。

    不依赖 PIL 的 palette 转换：Pillow 对「tRNS 用 bytes 表示」的图会告警并按
    单一透明色处理，拿不到逐索引 alpha。
    """
    blob = path.read_bytes()
    pos, chunks = 8, []
    while pos < len(blob):
        ln = struct.unpack(">I", blob[pos:pos + 4])[0]
        chunks.append((blob[pos + 4:pos + 8].decode("latin1"), blob[pos + 8:pos + 8 + ln]))
        pos += 12 + ln
    d = dict(chunks)
    w, h, bit, ctype, _, _, interlace = struct.unpack(">IIBBBBB", d["IHDR"])
    if ctype != 3 or bit != 8:
        raise SystemExit("预期 8bit 调色板 PNG，实际 colorType=%d bit=%d" % (ctype, bit))
    if interlace:
        raise SystemExit("不支持隔行扫描")

    raw = zlib.decompress(b"".join(payload for t, payload in chunks if t == "IDAT"))
    stride = w
    idx = bytearray(w * h)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(1, stride):
                line[i] = (line[i] + line[i - 1]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                left = line[i - 1] if i else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - 1] if i else 0
                b = prev[i]
                c = prev[i - 1] if i else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        idx[y * stride:(y + 1) * stride] = line
        prev = line

    index = np.frombuffer(bytes(idx), dtype=np.uint8).reshape(h, w)
    pal = np.frombuffer(d["PLTE"], dtype=np.uint8).reshape(-1, 3)
    alpha_tbl = np.frombuffer(d["tRNS"], dtype=np.uint8) if "tRNS" in d else np.full(256, 255, np.uint8)
    if len(alpha_tbl) < len(pal):
        alpha_tbl = np.concatenate([alpha_tbl, np.full(len(pal) - len(alpha_tbl), 255, np.uint8)])

    rgba = np.empty((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = pal[index]
    rgba[:, :, 3] = alpha_tbl[index]
    return rgba


def left_edge(alpha: np.ndarray) -> np.ndarray:
    """每行 alpha>200 的最左列；无实体行记 -1。"""
    solid = alpha > 200
    has = solid.any(axis=1)
    out = np.where(has, solid.argmax(axis=1), -1)
    return out


def body_left(alpha: np.ndarray, from_x: int = 400) -> np.ndarray:
    """每行「身体主体」的左边界：从 from_x 向左扫到首个透明像素。

    from_x 必须落在身体内部（本图 400 列在 y 410~640 恒为实体），
    若某行 from_x 处已是透明则记 -1（该行无身体）。
    """
    h, w = alpha.shape
    out = np.full(h, -1, dtype=np.int32)
    for y in range(h):
        if alpha[y, from_x] <= 32:
            continue
        x = from_x
        while x > 0 and alpha[y, x] > 32:
            x -= 1
        out[y] = x + 1
    return out


def repair_notch(rgba: np.ndarray, y_lo: int, y_hi: int, fit_lo: int, fit_hi: int,
                 from_x: int = 400):
    """用健康段拟合身体左缘曲线，把缺口行补到拟合轮廓。

    缺口是「从身体左缘啃进去的锯齿凹陷」，会与外部背景连通，因此不能用
    「两侧都被夹住」的洞检测；只能用上下健康段的轮廓做回归预测缺失轮廓。
    """
    alpha = rgba[:, :, 3]
    h, w = alpha.shape
    bl = body_left(alpha, from_x)

    # 健康样本：缺口上方与下方的行
    ys, xs = [], []
    for y in range(fit_lo, fit_hi + 1):
        if y_lo <= y <= y_hi:
            continue
        if bl[y] > 0:
            ys.append(y)
            xs.append(bl[y])
    if len(ys) < 12:
        raise SystemExit("健康轮廓样本不足（%d），检查 fit 区间" % len(ys))
    ys_arr = np.array(ys, dtype=np.float64)
    xs_arr = np.array(xs, dtype=np.float64)
    # 分段线性插值：二次拟合在腰段末端会向上过冲（实测 y=570 预测 269 vs 真实趋势 224），
    # 线性插值在缺口上下各只有一个支撑点时最稳，无过冲。
    order = np.argsort(ys_arr)
    ys_arr, xs_arr = ys_arr[order], xs_arr[order]

    def base_at(y: int) -> int:
        return int(round(np.interp(y, ys_arr, xs_arr)))

    resid = np.abs(np.interp(ys_arr, ys_arr, xs_arr) - xs_arr)
    print("轮廓基线：健康样本 %d 行（y %.0f~%.0f），分段线性插值"
          % (len(ys), ys_arr.min(), ys_arr.max()))

    filled = 0
    for y in range(y_lo, y_hi + 1):
        if bl[y] <= 0:
            continue
        base = max(base_at(y), 1)
        if bl[y] - base < 3:      # 内凹不足 3px 视为正常轮廓
            continue
        for xx in range(base, min(bl[y], w)):
            up = down = None
            for dy in range(1, 90):
                yy = y - dy
                if yy < 0:
                    break
                if alpha[yy, xx] > 200:
                    up = yy
                    break
            for dy in range(1, 90):
                yy = y + dy
                if yy >= h:
                    break
                if alpha[yy, xx] > 200:
                    down = yy
                    break
            if up is None and down is None:
                continue
            if up is None:
                rgba[y, xx, :3] = rgba[down, xx, :3]
                rgba[y, xx, 3] = rgba[down, xx, 3]
            elif down is None:
                rgba[y, xx, :3] = rgba[up, xx, :3]
                rgba[y, xx, 3] = rgba[up, xx, 3]
            else:
                t = (y - up) / float(down - up)
                rgba[y, xx, :3] = np.clip(
                    rgba[up, xx, :3].astype(np.float32) * (1 - t)
                    + rgba[down, xx, :3].astype(np.float32) * t, 0, 255).astype(np.uint8)
                rgba[y, xx, 3] = int(round(rgba[up, xx, 3] * (1 - t) + rgba[down, xx, 3] * t))
            filled += 1

    # 新边缘 1px 羽化，避免补丁与背景之间出现硬阶梯
    if filled:
        for y in range(y_lo, y_hi + 1):
            b = base_at(y)
            if 0 <= b - 1 and b < w:
                rgba[y, b - 1, 3] = min(int(rgba[y, b - 1, 3]), 120)
    return filled


def fill_interior_holes(rgba: np.ndarray, y_lo: int, y_hi: int, x_lo: int, x_hi: int,
                        min_span: int = 8) -> int:
    """补齐 ROI 内「左右都被不透明像素夹住」的横向透明段。

    缺口上段虽与背景连通（左上有出口），但每个横截面仍被身体夹住，
    因此按行判定即可；x_lo 需避开「手臂与身体之间的真实缝隙」（本图 x<240）。
    """
    alpha = rgba[:, :, 3]
    h, w = alpha.shape
    filled = 0

    for y in range(y_lo, y_hi + 1):
        row = alpha[y]
        x = x_lo
        while x <= x_hi:
            if row[x] > 32:
                x += 1
                continue
            s = x
            while x <= x_hi and row[x] <= 32:
                x += 1
            e = x - 1
            # 段必须完整落在 ROI 内部，且左右紧邻均不透明
            if s <= x_lo or e >= x_hi:
                continue
            if row[s - 1] <= 32 or row[e + 1] <= 32:
                continue
            if e - s + 1 < min_span:
                continue
            for xx in range(s, e + 1):
                up = down = None
                for dy in range(1, 90):
                    yy = y - dy
                    if yy < 0:
                        break
                    if alpha[yy, xx] > 200:
                        up = yy
                        break
                for dy in range(1, 90):
                    yy = y + dy
                    if yy >= h:
                        break
                    if alpha[yy, xx] > 200:
                        down = yy
                        break
                if up is None and down is None:
                    continue
                if up is None:
                    rgba[y, xx, :3] = rgba[down, xx, :3]
                    rgba[y, xx, 3] = rgba[down, xx, 3]
                elif down is None:
                    rgba[y, xx, :3] = rgba[up, xx, :3]
                    rgba[y, xx, 3] = rgba[up, xx, 3]
                else:
                    t = (y - up) / float(down - up)
                    rgba[y, xx, :3] = np.clip(
                        rgba[up, xx, :3].astype(np.float32) * (1 - t)
                        + rgba[down, xx, :3].astype(np.float32) * t, 0, 255).astype(np.uint8)
                    rgba[y, xx, 3] = int(round(rgba[up, xx, 3] * (1 - t) + rgba[down, xx, 3] * t))
                filled += 1
    return filled


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="miniprogram/assets/home/xiaoan-robot.png")
    ap.add_argument("--out", default=None, help="输出路径，缺省时覆盖 src")
    ap.add_argument("--preview", default=None, help="额外输出一张蓝底检视图")
    ap.add_argument("--y-lo", type=int, default=526)
    ap.add_argument("--y-hi", type=int, default=579)
    ap.add_argument("--fit-lo", type=int, default=458)
    ap.add_argument("--fit-hi", type=int, default=636)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out) if args.out else src
    rgba = decode_palette_png(src)
    before = rgba[:, :, 3].copy()

    filled = repair_notch(rgba, args.y_lo, args.y_hi, args.fit_lo, args.fit_hi)
    print("阶段一 轮廓重建补齐：%d 像素（缺口 y %d~%d，拟合样本 y %d~%d）"
          % (filled, args.y_lo, args.y_hi, args.fit_lo, args.fit_hi))

    holes = fill_interior_holes(rgba, 440, 582, 240, 360)
    print("阶段二 内部空洞补齐：%d 像素（ROI y 440~582, x 240~360）" % holes)

    changed = int((before != rgba[:, :, 3]).sum())
    print("alpha 变更像素合计：%d" % changed)

    if args.preview:
        bg = np.array([11, 110, 248], dtype=np.float32)
        af = rgba[:, :, 3:4].astype(np.float32) / 255.0
        comp = (rgba[:, :, :3].astype(np.float32) * af + bg * (1 - af)).astype(np.uint8)
        Image.fromarray(comp).save(args.preview)
        print("检视图：%s" % args.preview)

    if args.dry_run:
        print("dry-run，未写文件")
        return 0

    img = Image.fromarray(rgba, mode="RGBA")
    img.save(out, format="PNG", optimize=True)
    print("已写出 %s（%d 字节，真彩 RGBA）" % (out, out.stat().st_size))
    return 0


if __name__ == "__main__":
    sys.exit(main())
