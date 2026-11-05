# -*- coding: utf-8 -*-
"""
optimize-pngs.py —— 包内 PNG / JPG 体积优化（包体整改 F1.1-3）

背景：小程序主包 2MB 红线，本仓主包实测上界 2.10MB。删除未引用资源后仍有
      大量「真彩 RGBA」大图与图标，可通过「调色板化」显著压小且肉眼无损。

原理：
  1. 图标是**单色 + alpha 抗锯齿**：像素颜色只有「一个 RGB + 若干 alpha 档」。
     用「alpha 分桶调色板」（index = 量化后的 alpha 档，palette 每档取该档众数 RGB，
     tRNS 记录该档 alpha）→ PNG8 + tRNS，体积降到 1/5~1/7。
  2. 扁平插画（封面 / 空态图）色彩数少 → 直接 PNG8 调色板（≤256 色）。
  3. JPEG（banner 等）→ 按质量重编码。

约束：
  - **不做有损 RGB 量化**：只压缩 alpha 精度（32 档），RGB 取众数。
    实测最大合成误差 ≤23/255、平均 0.5/255（3 种背景合成后比对）。
  - 逐文件「改后不更大才落盘」，且颜色数超限自动跳过（保持原样）。
  - **不动 tabBar 硬依赖图标的语义**：只改编码，不改文件名/尺寸。

用法：
    python tools/optimize-pngs.py            # 优化默认清单
    python tools/optimize-pngs.py --dry-run  # 只报告不落盘
"""
import io
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
ICONS = os.path.join(ASSETS, "icons")

ALPHA_LEVELS = 32       # alpha 量化档数（32 → 最大 alpha 误差 8/255）
MAX_COLORS = 256        # PNG8 调色板上限

# 需要优化的目标（相对 miniprogram/）
# 2026-11-04 现状：
#   · kb-cover-person-leaf.png —— 真彩插画，FASTOCTREE 量化后 30235 → 2943（-90%），肉眼无差。
#   · xiaoan-robot.png —— 登录页/健康页 3D 主视觉（600×759）。实测：调色板化后更大，
#     q64/q32 量化误差分别达 130/255 不可接受；**保持原图**（61KB < 100KB 单图红线）。
#   · banner-hospital.jpg —— JPEG 重编码后不比原来小，保持原图（23KB）。
#   · assets/img/empty-records.png —— 零引用，已从包内与服务端副本删除，不再是目标。
#
# 2026-11-05 质量面板整改（图片音频总量 200K 规则，实测 617,815 → 需大幅下降）：
#   · 科普封面 5 张（330,888B）—— 全是矢量生成的扁平插画，FASTOCTREE q256 后
#     误差 mean≤1.03 / max≤9（肉眼不可见），330,888 → 38,685（-88%），是最大单笔收益。
#   · floor1.png（导航楼层平面图 1440×860 RGBA）→ q256：23,960 → 8,754，err mean 4.4 / max 11。
#   · 视频封面 3 张 JPG（69,689B）→ JPEG q60：→ 40,644（缩略图用途，q60 无可见伪影）。
#   · ai-doctor.png q64（err mean 0.63/max 22）、xiaoan-robot.png q96（err mean 0.63/max 25）、
#     banner-hospital.jpg q60 —— 均已实测误差后纳入。
#   · 图标（105 个）维持 2026-11-04 的 alpha 分桶结果：实测再压（16 档 / 降采样）体积反而
#     变大或损伤边缘，已到该尺寸的熵下限，不再动。
#   · 条目第 3 项可为 (相对路径, 模式, 参数)：quant 的参数 = 颜色数，jpeg 的参数 = 质量。
TARGETS = [
    ("assets/home/kb-cover-person-leaf.png", "quant"),
    ("packageNav/assets/floor1.png", "quant"),
    ("assets/home/ai-doctor.png", "quant", 64),
    ("assets/home/xiaoan-robot.png", "quant", 96),
    ("assets/home/banner-hospital.jpg", "jpeg", 60),
]
# 2026-11-05（F2 Phase B）：5 张科普封面 png 与 3 张视频海报 jpg 已**出包**
#（包内不再有源文件，服务端副本 backend/deploy/resources 才是源），相应 TARGETS 已移除。
# 图标目录：全部 *.png 逐个做 alpha 分桶调色板
ICON_DIR = "assets/icons"


def _alpha_ladder(im):
    """alpha 分桶调色板（index=alpha 档，palette RGB=该档众数，tRNS=该档 alpha）。"""
    im = im.convert("RGBA")
    step = 255.0 / (ALPHA_LEVELS - 1)
    idx = im.getchannel("A").point(lambda v: min(ALPHA_LEVELS - 1, int(round(v / step))))
    idxs = list(idx.getdata())

    buckets = {}
    for i, px in enumerate(im.getdata()):
        buckets.setdefault(idxs[i], []).append(px[:3])

    palette = []
    trans = bytearray()
    for k in range(ALPHA_LEVELS):
        rgb = buckets.get(k)
        if rgb:
            # 该档众数 RGB（抗锯齿边缘像素 RGB 有细微抖动，取众数最稳）
            counts = {}
            for c in rgb:
                counts[c] = counts.get(c, 0) + 1
            best = max(counts.items(), key=lambda kv: kv[1])[0]
        else:
            best = (0, 0, 0)
        palette.extend(best)
        trans.append(min(255, int(round(k * step))))

    pim = Image.new("P", im.size)
    pim.putpalette(palette + [0, 0, 0] * (MAX_COLORS - ALPHA_LEVELS))
    pim.putdata(idxs)
    buf = io.BytesIO()
    pim.save(buf, format="PNG", optimize=True, transparency=bytes(trans))
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGBA"), buf.getvalue()


def _flat_palette(im):
    """色彩数 ≤256 的图 → PNG8 调色板（无 alpha 损失时完全无损）。"""
    im = im.convert("RGBA")
    colors = im.getcolors(maxcolors=1 << 20) or []
    if len(colors) > MAX_COLORS:
        return None, None
    colors.sort(key=lambda c: c[1])
    palette, trans, index = [], bytearray(), {}
    for i, (_cnt, (r, g, b, a)) in enumerate(colors):
        palette.extend((r, g, b))
        trans.append(a)
        index[(r, g, b, a)] = i
    pim = Image.new("P", im.size)
    pim.putpalette(palette + [0, 0, 0] * (MAX_COLORS - len(palette)))
    pim.putdata([index[px] for px in im.getdata()])
    buf = io.BytesIO()
    pim.save(buf, format="PNG", optimize=True, transparency=bytes(trans))
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGBA"), buf.getvalue()


def _quantize(im, colors=256):
    """扁平插画：按 FASTOCTREE 量化到 ≤256 色（保留 alpha 通道）。"""
    im = im.convert("RGBA")
    q = im.quantize(colors=colors, method=Image.Quantize.FASTOCTREE)
    buf = io.BytesIO()
    q.save(buf, format="PNG", optimize=True)
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGBA"), buf.getvalue()


def _jpeg(im, quality=72):
    im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGB"), buf.getvalue()


def optimize_file(path, mode, param=None, dry_run=False):
    """返回 (原大小, 新大小 or None)。新大小为 None 表示未改动。"""
    if not os.path.isfile(path):
        return None, None
    orig_size = os.path.getsize(path)
    im = Image.open(path)
    try:
        if mode == "palette":
            new_im, data = _flat_palette(im)
            if new_im is None:
                new_im, data = _alpha_ladder(im)
        elif mode == "quant":
            new_im, data = _quantize(im, colors=int(param) if param else 256)
        elif mode == "jpeg":
            new_im, data = _jpeg(im, quality=int(param) if param else 72)
        else:
            return orig_size, None
    except Exception as exc:  # noqa: BLE001 —— 单文件失败不阻断整批
        print("  SKIP %s (%s)" % (os.path.basename(path), type(exc).__name__))
        return orig_size, None

    if data is None or len(data) >= orig_size:
        return orig_size, None
    if not dry_run:
        with open(path, "wb") as f:
            f.write(data)
    return orig_size, len(data)


def main():
    dry = "--dry-run" in sys.argv[1:]
    total_old = total_new = 0
    touched = 0

    print("== 指定大图 ==")
    for entry in TARGETS:
        rel, mode = entry[0], entry[1]
        param = entry[2] if len(entry) > 2 else None
        p = os.path.join(ROOT, rel.replace("/", os.sep))
        old, new = optimize_file(p, mode, param, dry)
        if old is None:
            print("  MISS %s" % rel)
            continue
        if new is None:
            print("  %-42s %7d -> (未变)" % (rel, old))
            continue
        total_old += old
        total_new += new
        touched += 1
        print("  %-42s %7d -> %7d  (-%.1f%%)" % (rel, old, new, (old - new) * 100.0 / old))

    print("== 图标（alpha 分桶调色板）==")
    icon_old = icon_new = 0
    over = []
    for fn in sorted(os.listdir(ICONS)):
        if not fn.endswith(".png"):
            continue
        p = os.path.join(ICONS, fn)
        old, new = optimize_file(p, "palette", None, dry)
        if old is None:
            continue
        if new is None:
            icon_old += old
            icon_new += old
            continue
        icon_old += old
        icon_new += new
        touched += 1
        if new > 2048:
            over.append((fn, new))
    print("  %d 个图标 %d -> %d  (-%.1f%%)"
          % (len(os.listdir(ICONS)), icon_old, icon_new,
             (icon_old - icon_new) * 100.0 / icon_old if icon_old else 0))
    if over:
        print("  仍 >2KB 的图标 %d 个：%s" % (len(over), ", ".join("%s(%d)" % o for o in over[:8])))

    total_old += icon_old
    total_new += icon_new
    print("== 合计 ==")
    print("  %d -> %d  (-%d bytes, -%.1f%%)  改动 %d 个文件%s"
          % (total_old, total_new, total_old - total_new,
             (total_old - total_new) * 100.0 / total_old if total_old else 0,
             touched, "（dry-run）" if dry else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
