#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""make_robot_asset.py —— 从白底设计稿生成透明机器人 PNG（登录页小安）

背景：设计稿 `design-output/assets/img/robot-*.png` 实际是 **JPEG（ff d8 ff）白底图**，
       没有 alpha 通道；包内 `assets/home/xiaoan-robot.png` 是旧版调色板图，腰部有误抠缺口。
做法：白底 → 透明，分三步，避免"整片白都被扣掉"和"边缘白边"两类常见错误：
  1. 只把**与画布边界连通**的近白区域判为背景（连通域），机身内部被轮廓包住的高光保留；
  2. 边缘 2~3px 过渡带按"白底合成"公式反解 alpha：p = a*F + (1-a)*255
     → a = (255 - L_p) / (255 - L_ref)，L_ref 取最近的高置信实心像素亮度；
  3. 按 alpha 反预乘还原边缘真实颜色，避免蓝底上出现白边。

输出：RGBA PNG；`--palette` 额外产一份 PNG8（调色板 + tRNS），用于包内回退（体积更小）。
"""
import argparse
import hashlib
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def extract_alpha(rgb: np.ndarray, bg_threshold: int = 248, band: int = 3,
                  min_component: int = 200):
    """返回 (alpha float32[0..1], bg_mask)。"""
    h, w, _ = rgb.shape
    near_white = (rgb >= bg_threshold).all(axis=2)

    # 1) 只认与边界连通的近白区域为背景（连通域，防止机身白被吃）
    lab, n = ndimage.label(near_white)
    border_labels = np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]]))
    border_labels = border_labels[border_labels > 0]
    bg = np.isin(lab, border_labels)

    fg = ~bg
    # 去掉 JPEG 噪点级别的碎屑
    fl, fn = ndimage.label(fg)
    if fn:
        sizes = ndimage.sum(fg, fl, range(1, fn + 1))
        keep = np.where(sizes >= min_component)[0] + 1
        fg = np.isin(fl, keep)

    alpha = fg.astype(np.float32)

    # 2) 边缘过渡带反解 alpha
    lum = rgb.astype(np.float32).mean(axis=2)
    solid = fg & ~ndimage.binary_dilation(bg, iterations=band)
    if solid.any():
        _, idx = ndimage.distance_transform_edt(~solid, return_indices=True)
        ref_lum = lum[idx[0], idx[1]]
        edge = fg & ~solid
        denom = 255.0 - ref_lum
        est = np.ones_like(lum)
        ok = denom > 8.0                      # 参照像素本身太白 → 不存在可见过渡，按实心处理
        est[ok] = (255.0 - lum[ok]) / denom[ok]
        est = np.clip(est, 0.0, 1.0)
        alpha[edge] = est[edge]

    return alpha, bg


def unpremultiply_white(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """p = a*F + (1-a)*255 → F = (p - 255*(1-a)) / a，消除蓝底上的白边。"""
    out = rgb.astype(np.float32).copy()
    a = alpha[..., None]
    safe = np.maximum(a, 1e-3)
    out = (out - 255.0 * (1.0 - a)) / safe
    out = np.clip(out, 0, 255)
    # alpha 过低处颜色不可靠，沿用邻近颜色意义不大，统一压成中性灰避免彩噪
    out[alpha < 0.06] = 255.0
    return out.astype(np.uint8)


def trim_to_subject(rgba: np.ndarray, pad_ratio: float = 0.012,
                    aspect: float = 0.0) -> np.ndarray:
    """裁到主体包围盒（含少量留白），并按 aspect = w/h 补对称空白。

    为什么需要：白底设计稿四周留白很大，直接缩放会让机器人只占画幅 86%，
    同一 CSS 尺寸下比旧素材（占 99%）明显小一圈，登录页与健康页头像都会失准。
    先裁后补 aspect，等于"把主体重新装回原画幅比例"，页面样式无需改动。
    """
    h, w = rgba.shape[:2]
    ys, xs = np.where(rgba[:, :, 3] > 8)
    if len(ys) == 0:
        return rgba
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    pad = int(round(max(x1 - x0, y1 - y0) * pad_ratio))
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(w - 1, x1 + pad), min(h - 1, y1 + pad)
    crop = rgba[y0:y1 + 1, x0:x1 + 1]

    if aspect > 0:
        ch, cw = crop.shape[:2]
        if cw / float(ch) > aspect:                      # 太宽 → 补上下
            th = int(round(cw / aspect))
            if th > ch:
                top = (th - ch) // 2
                canvas = np.zeros((th, cw, 4), np.uint8)
                canvas[top:top + ch] = crop
                crop = canvas
        else:                                            # 太高 → 补左右
            tw = int(round(ch * aspect))
            if tw > cw:
                left = (tw - cw) // 2
                canvas = np.zeros((ch, tw, 4), np.uint8)
                canvas[:, left:left + cw] = crop
                crop = canvas
    return crop


def resize_rgba(rgba: np.ndarray, size: tuple) -> np.ndarray:
    """按预乘 alpha 缩放，避免透明边缘发黑/发白。"""
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    prem = rgba[..., :3].astype(np.float32) * a
    img = np.concatenate([prem, a * 255.0], axis=2)
    out = np.dstack([
        np.array(Image.fromarray(img[..., i].astype(np.float32), mode="F").resize(size, Image.LANCZOS))
        for i in range(4)
    ])
    a2 = np.clip(out[..., 3:4], 0, 255) / 255.0
    rgb2 = np.where(a2 > 1e-4, out[..., :3] / np.maximum(a2, 1e-4), 255.0)
    return np.dstack([np.clip(rgb2, 0, 255), np.clip(out[..., 3], 0, 255)]).astype(np.uint8)


def render_preview(rgba: np.ndarray, bg=(217, 238, 254), scale: int = 1) -> Image.Image:
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    comp = rgba[..., :3].astype(np.float32) * a + np.array(bg, np.float32) * (1 - a)
    im = Image.fromarray(comp.astype(np.uint8))
    if scale != 1:
        im = im.resize((im.width * scale, im.height * scale), Image.LANCZOS)
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="design-output/assets/img/robot-wave.png")
    ap.add_argument("--out", default="miniprogram/assets/home/xiaoan-robot.png")
    ap.add_argument("--size", default="720x882", help="输出尺寸，如 720x882；空字符串=不缩放")
    ap.add_argument("--palette", default="", help="额外输出 PNG8 路径（包内回退用）")
    ap.add_argument("--preview", default="", help="输出蓝底预览图路径")
    ap.add_argument("--threshold", type=int, default=248)
    ap.add_argument("--band", type=int, default=3)
    ap.add_argument("--denoise", type=int, default=0,
                    help="中值去噪核尺寸（0=关，3=推荐）：源图是 JPEG，白机身上的压缩噪点"
                         "会让 PNG8 量化出现砂砾感，同时把体积抬高三成")
    ap.add_argument("--trim", type=float, default=0.0,
                    help="裁到主体包围盒并留白比例（0=不裁；0.012≈1.2%%）。"
                         "设计稿四周留白大会导致同一 CSS 尺寸下主体偏小")
    ap.add_argument("--aspect", type=float, default=0.0,
                    help="裁边后补齐到的宽高比（如 0.7903 = 720/911 原画幅）；0=不补")
    args = ap.parse_args()

    src = Path(args.src)
    rgb = np.array(Image.open(src).convert("RGB"))
    print("源图 %s  %dx%d" % (src, rgb.shape[1], rgb.shape[0]))

    alpha, bg = extract_alpha(rgb, args.threshold, args.band)
    alpha8 = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    colors = unpremultiply_white(rgb, alpha8.astype(np.float32) / 255.0)
    rgba = np.dstack([colors, alpha8])

    hist = np.bincount(alpha8.ravel(), minlength=256)
    ys, xs = np.where(alpha8 > 8)
    print("透明 %.1f%% / 半透明 %.2f%% / 不透明 %.1f%%"
          % (hist[0] / alpha8.size * 100, hist[1:255].sum() / alpha8.size * 100,
             hist[255] / alpha8.size * 100))
    print("前景包围盒 x %d-%d y %d-%d" % (xs.min(), xs.max(), ys.min(), ys.max()))

    if args.trim > 0:
        before = rgba.shape[1], rgba.shape[0]
        rgba = trim_to_subject(rgba, args.trim, args.aspect)
        print("裁边 %dx%d → %dx%d（aspect=%s）"
              % (before[0], before[1], rgba.shape[1], rgba.shape[0],
                 args.aspect if args.aspect > 0 else "保持"))

    if args.size:
        tw, th = (int(v) for v in args.size.lower().split("x"))
        rgba = resize_rgba(rgba, (tw, th))
        print("缩放 → %dx%d" % (tw, th))

    if args.denoise and args.denoise >= 3:
        from PIL import ImageFilter
        rgb_only = Image.fromarray(rgba[:, :, :3], "RGB").filter(
            ImageFilter.MedianFilter(args.denoise))
        rgba = np.dstack([np.array(rgb_only), rgba[:, :, 3]])
        print("中值去噪 %dx%d" % (args.denoise, args.denoise))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(out, "PNG", optimize=True)
    print("写出 %s  %d B  sha256=%s" % (out, out.stat().st_size, sha256_of(out)[:16] + "…"))

    if args.palette:
        # PNG8 = 调色板 + tRNS 全表。两个坑必须同时规避：
        #   1) 调色板必须补足 256 项：只写 255 项时，索引 255 会越界被渲染成纯黑；
        #   2) tRNS 必须给满 256 项，索引 255 专门留给全透明像素（alpha=0）。
        # 量化只量化 RGB、alpha 按索引取均值，避免 RGBA 混合量化把边缘抠成硬边。
        src_img = Image.fromarray(rgba, mode="RGBA")
        q = src_img.convert("RGB").quantize(colors=255, method=Image.FASTOCTREE)
        idx = np.array(q)
        alpha8 = rgba[:, :, 3]
        # ⚠️ 统计 alpha 时必须排除"即将被强制归到透明索引"的像素：
        #    背景是白的，和机身白同色，同一个调色板索引会同时覆盖两者，
        #    若把背景的 alpha=0 一起平均，机身白就会被算成半透明（实测 30% 像素中招）。
        keep = alpha8 >= 8
        tabs = np.zeros(256, np.uint8)
        for i in range(255):
            m = (idx == i) & keep
            if m.any():
                tabs[i] = int(np.round(alpha8[m].mean()))
        idx = np.where(alpha8 < 8, 255, idx).astype(np.uint8)
        palette = list(q.getpalette()[:765]) + [255, 255, 255]
        pal_img = Image.fromarray(idx, "P")
        pal_img.putpalette(palette)
        p = Path(args.palette)
        pal_img.save(p, "PNG", optimize=True, transparency=bytes(tabs))
        print("写出 %s  %d B（调色板 256 项 + tRNS 256 项）" % (p, p.stat().st_size))

    if args.preview:
        render_preview(rgba).save(args.preview)
        print("预览 %s" % args.preview)


if __name__ == "__main__":
    main()
