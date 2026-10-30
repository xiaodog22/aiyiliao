# -*- coding: utf-8 -*-
"""
svg2png.py —— 轻量 SVG → PNG 渲染器（本项目图标专用）

背景：环境无 cairosvg / resvg，npm 安装失败，故用 Pillow 自行光栅化。
支持元素：path(M/L/H/V/C/S/Q/T/A/Z) / line / circle / ellipse / rect / polyline / polygon
支持属性：fill=none（本项目图标均为描边）、stroke、stroke-width、stroke-linecap、stroke-linejoin
做法：4x 超采样绘制后 LANCZOS 缩小，实现抗锯齿。

用法：python tools/svg2png.py            # 渲染 assets/icons/*.svg 全部
"""
import os
import re
import math
import glob
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, ImageChops, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC_DIR = os.path.join(ROOT, 'assets', 'icons')
SS = 4  # 超采样倍数

# ---------- path 解析 ----------
TOKEN_RE = re.compile(r'([MmZzLlHhVvCcSsQqTtAa])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)')


def tokenize(d):
    tokens = []
    for m in TOKEN_RE.finditer(d):
        if m.group(1):
            tokens.append(m.group(1))
        else:
            tokens.append(float(m.group(2)))
    return tokens


def bezier(p0, p1, p2, p3, steps=24):
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def quad(p0, p1, p2, steps=20):
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1 - t
        x = mt**2 * p0[0] + 2 * mt * t * p1[0] + t**2 * p2[0]
        y = mt**2 * p0[1] + 2 * mt * t * p1[1] + t**2 * p2[1]
        pts.append((x, y))
    return pts


def arc_points(p0, rx, ry, phi_deg, large, sweep, p1, steps=32):
    """SVG 椭圆弧 → 采样点（简化端点参数化实现）"""
    if rx == 0 or ry == 0:
        return [p1]
    phi = math.radians(phi_deg)
    cos_p, sin_p = math.cos(phi), math.sin(phi)

    x0, y0 = p0
    x1, y1 = p1
    dx2, dy2 = (x0 - x1) / 2.0, (y0 - y1) / 2.0
    x1p = cos_p * dx2 + sin_p * dy2
    y1p = -sin_p * dx2 + cos_p * dy2

    rx, ry = abs(rx), abs(ry)
    lam = (x1p ** 2) / (rx ** 2) + (y1p ** 2) / (ry ** 2)
    if lam > 1:
        s = math.sqrt(lam)
        rx *= s
        ry *= s

    num = rx**2 * ry**2 - rx**2 * y1p**2 - ry**2 * x1p**2
    den = rx**2 * y1p**2 + ry**2 * x1p**2
    co = math.sqrt(max(num / den, 0))
    if large == sweep:
        co = -co
    cxp = co * rx * y1p / ry
    cyp = -co * ry * x1p / rx
    cx = cos_p * cxp - sin_p * cyp + (x0 + x1) / 2.0
    cy = sin_p * cxp + cos_p * cyp + (y0 + y1) / 2.0

    def ang(ux, uy, vx, vy):
        dot = ux * vx + uy * vy
        norm = math.sqrt(ux**2 + uy**2) * math.sqrt(vx**2 + vy**2)
        a = math.acos(max(-1, min(1, dot / norm))) if norm else 0
        if ux * vy - uy * vx < 0:
            a = -a
        return a

    theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dtheta > 0:
        dtheta -= 2 * math.pi
    elif sweep and dtheta < 0:
        dtheta += 2 * math.pi

    pts = []
    for i in range(1, steps + 1):
        th = theta1 + dtheta * i / steps
        cth, sth = math.cos(th), math.sin(th)
        x = cos_p * rx * cth - sin_p * ry * sth + cx
        y = sin_p * rx * cth + cos_p * ry * sth + cy
        pts.append((x, y))
    return pts


def parse_path(d):
    """返回子路径列表：每个子路径是点列表 [(x,y), ...]"""
    tokens = tokenize(d)
    i = 0
    subpaths = []
    cur = []
    pos = (0.0, 0.0)
    start = (0.0, 0.0)
    cmd = None
    prev_ctrl = None  # 用于 S/T 平滑

    def num():
        nonlocal i
        v = tokens[i]
        i += 1
        return float(v)

    while i < len(tokens):
        t = tokens[i]
        if isinstance(t, str):
            cmd = t
            i += 1
            if cmd in ('Z', 'z'):
                if cur:
                    cur.append(start)
                    subpaths.append(cur)
                    cur = []
                pos = start
                continue
        rel = cmd.islower()
        c = cmd.upper()

        if c == 'M':
            x, y = num(), num()
            pos = (pos[0] + x, pos[1] + y) if rel else (x, y)
            start = pos
            if cur:
                subpaths.append(cur)
            cur = [pos]
        elif c == 'L':
            x, y = num(), num()
            pos = (pos[0] + x, pos[1] + y) if rel else (x, y)
            cur.append(pos)
            prev_ctrl = None
        elif c == 'H':
            x = num()
            pos = (pos[0] + x, pos[1]) if rel else (x, pos[1])
            cur.append(pos)
            prev_ctrl = None
        elif c == 'V':
            y = num()
            pos = (pos[0], pos[1] + y) if rel else (pos[0], y)
            cur.append(pos)
            prev_ctrl = None
        elif c == 'C':
            x1, y1, x2, y2, x, y = num(), num(), num(), num(), num(), num()
            p1 = (pos[0] + x1, pos[1] + y1) if rel else (x1, y1)
            p2 = (pos[0] + x2, pos[1] + y2) if rel else (x2, y2)
            p3 = (pos[0] + x, pos[1] + y) if rel else (x, y)
            cur.extend(bezier(pos, p1, p2, p3))
            pos = p3
            prev_ctrl = p2
        elif c == 'S':
            x2, y2, x, y = num(), num(), num(), num()
            p1 = (2 * pos[0] - prev_ctrl[0], 2 * pos[1] - prev_ctrl[1]) if prev_ctrl else pos
            p2 = (pos[0] + x2, pos[1] + y2) if rel else (x2, y2)
            p3 = (pos[0] + x, pos[1] + y) if rel else (x, y)
            cur.extend(bezier(pos, p1, p2, p3))
            pos = p3
            prev_ctrl = p2
        elif c == 'Q':
            x1, y1, x, y = num(), num(), num(), num()
            p1 = (pos[0] + x1, pos[1] + y1) if rel else (x1, y1)
            p2 = (pos[0] + x, pos[1] + y) if rel else (x, y)
            cur.extend(quad(pos, p1, p2))
            pos = p2
            prev_ctrl = p1
        elif c == 'T':
            x, y = num(), num()
            p1 = (2 * pos[0] - prev_ctrl[0], 2 * pos[1] - prev_ctrl[1]) if prev_ctrl else pos
            p2 = (pos[0] + x, pos[1] + y) if rel else (x, y)
            cur.extend(quad(pos, p1, p2))
            pos = p2
            prev_ctrl = p1
        elif c == 'A':
            rx, ry, phi = num(), num(), num()
            large, sweep = int(num()), int(num())
            x, y = num(), num()
            p1 = (pos[0] + x, pos[1] + y) if rel else (x, y)
            cur.extend(arc_points(pos, rx, ry, phi, large, sweep, p1))
            pos = p1
            prev_ctrl = None
        else:
            i += 1
    if cur:
        subpaths.append(cur)
    return subpaths


# ---------- 渲染 ----------
def hex_to_rgba(color):
    color = (color or '#000000').strip()
    if color.lower() in ('none', 'transparent'):
        return None
    if color.startswith('#'):
        h = color[1:]
        if len(h) == 3:
            h = ''.join(ch * 2 for ch in h)
        return tuple(int(h[k:k + 2], 16) for k in (0, 2, 4)) + (255,)
    return (0, 0, 0, 255)


def render_svg(svg_text, size, color):
    """把 SVG 文本渲染为 RGBA 图像（描边色替换为 color）"""
    root = ET.fromstring(svg_text)
    vb = root.get('viewBox', '0 0 24 24')
    vx, vy, vw, vh = [float(v) for v in vb.replace(',', ' ').split()]
    scale = size / max(vw, vh)

    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    rgba = hex_to_rgba(color) or (0, 0, 0, 255)
    bscale = scale * SS

    def tx(pt):
        return ((pt[0] - vx) * bscale, (pt[1] - vy) * bscale)

    def draw_polyline(pts, width, close=False):
        if len(pts) < 2:
            return
        p = [tx(q) for q in pts]
        w = max(int(round(width * bscale)), 1)
        if close:
            draw.line(p + [p[0]], fill=rgba, width=w, joint='curve')
        else:
            draw.line(p, fill=rgba, width=w, joint='curve')

    for el in root.iter():
        tag = el.tag.split('}')[-1]
        sw = float(el.get('stroke-width') or root.get('stroke-width') or 2)

        if tag == 'path':
            for sp in parse_path(el.get('d', '')):
                draw_polyline(sp, sw)
        elif tag == 'line':
            pts = [(float(el.get('x1', 0)), float(el.get('y1', 0))),
                   (float(el.get('x2', 0)), float(el.get('y2', 0)))]
            draw_polyline(pts, sw)
        elif tag == 'polyline':
            nums = [float(x) for x in re.findall(r'-?\d*\.?\d+', el.get('points', ''))]
            pts = [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
            draw_polyline(pts, sw)
        elif tag == 'polygon':
            nums = [float(x) for x in re.findall(r'-?\d*\.?\d+', el.get('points', ''))]
            pts = [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
            draw_polyline(pts, sw, close=True)
        elif tag == 'circle':
            cx, cy, r = float(el.get('cx', 0)), float(el.get('cy', 0)), float(el.get('r', 0))
            draw.ellipse([(cx - r) * bscale, (cy - r) * bscale, (cx + r) * bscale, (cy + r) * bscale],
                         outline=rgba, width=max(int(round(sw * bscale)), 1))
        elif tag == 'ellipse':
            cx, cy = float(el.get('cx', 0)), float(el.get('cy', 0))
            rx, ry = float(el.get('rx', 0)), float(el.get('ry', 0))
            draw.ellipse([(cx - rx) * bscale, (cy - ry) * bscale, (cx + rx) * bscale, (cy + ry) * bscale],
                         outline=rgba, width=max(int(round(sw * bscale)), 1))
        elif tag == 'rect':
            x, y = float(el.get('x', 0)), float(el.get('y', 0))
            w, h = float(el.get('width', 0)), float(el.get('height', 0))
            draw.rectangle([x * bscale, y * bscale, (x + w) * bscale, (y + h) * bscale],
                           outline=rgba, width=max(int(round(sw * bscale)), 1))

    return img.resize((size, size), Image.LANCZOS)


COLORS = {
    '': '#0B6EF8',        # 主蓝（默认 / TabBar 选中；2026-10-16 基调对齐 D-01①，原 #165DFF）
    '_gray': '#86909C',   # 灰（TabBar 未选中）
    '_white': '#FFFFFF',  # 白（深色底）
}

# =====================================================================
# 位图素材管线（设计稿交付件 → 目标体积 PNG）
#
# 为什么放在这个文件：本项目唯一的 Pillow 光栅化入口就是 svg2png.py
# （读图 → LANCZOS 缩放 → PNG 落盘）。交付来的"PNG"其实是 JPEG（无 alpha、
# 2048~2826 宽），必须同一套缩放/量化链路压到目标体积后才能进包。
#
# 用法：
#   python tools/svg2png.py --assets      # 只跑素材压缩（不碰图标）
#   python tools/svg2png.py               # 原有行为：渲染 assets/icons/*.svg
#   ⚠️ 无参数运行会重渲全部图标，icons.js 是人工维护表 —— 日常不要跑默认分支。
#
# 三种处理方式：
#   plain        整幅缩放（背景自带的插画/封面；无透明需求）
#   white_alpha  从四角泛洪去掉外围纯白 → 透明（保留图形内部白色，如病历夹纸面）
#   circle_alpha 方图裁圆（头像/圆形 Logo）
# =====================================================================
ASSET_SRC_DIR = os.path.join(ROOT, '..', 'design-output', 'assets', 'img')

ASSET_PLAN = [
    # 源文件                              目标路径（相对 miniprogram）                      W    H   上限KB  方式
    # 560×420 ≈ 科普卡在 3x 屏上的实际像素（343rpx ≈ 171pt ≈ 514px），再大只是白烧体积
    ('cover-sleep.png',     'packageContent/assets/covers/cover-sleep.png',     560, 420, 60, 'plain'),
    ('cover-nutrition.png', 'packageContent/assets/covers/cover-nutrition.png', 560, 420, 60, 'plain'),
    ('cover-exercise.png',  'packageContent/assets/covers/cover-exercise.png',  560, 420, 60, 'plain'),
    ('cover-wellness.png',  'packageContent/assets/covers/cover-wellness.png',  560, 420, 60, 'plain'),
    ('detail-hero-sleep.png', 'packageContent/assets/covers/detail-hero-sleep.png', 1000, 525, 90, 'plain'),
    ('kb-cover-person-leaf.png', 'assets/home/kb-cover-person-leaf.png',         240, 240, 30, 'plain'),
    ('empty-records.png',   'assets/img/empty-records.png',                      320, 320, 45, 'white_alpha'),
    ('empty-network.png',   'assets/img/empty-network.png',                      320, 320, 45, 'white_alpha'),
    ('logo-medical-ai.png', 'assets/brand/logo-mark.png',                        256, 256, 40, 'circle_alpha'),
    ('avatar-default.png',  'assets/img/avatar-default.png',                     160, 160, 20, 'circle_alpha'),
]


def _fit_cover(img, w, h):
    """等比缩放到覆盖 w×h 后居中裁切（等价 aspectFill，不变形）。"""
    sw, sh = img.size
    scale = max(float(w) / sw, float(h) / sh)
    nw, nh = max(1, int(round(sw * scale))), max(1, int(round(sh * scale)))
    img = img.resize((nw, nh), Image.LANCZOS)
    left = (nw - w) // 2
    top = (nh - h) // 2
    return img.crop((left, top, left + w, top + h))


def _fit_contain(img, w, h):
    """等比缩放到装进 w×h，四周补透明（等价 aspectFit，绝不切掉图形）。"""
    sw, sh = img.size
    scale = min(float(w) / sw, float(h) / sh)
    nw, nh = max(1, int(round(sw * scale))), max(1, int(round(sh * scale)))
    img = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    canvas.paste(img, ((w - nw) // 2, (h - nh) // 2))
    return canvas


def _white_to_alpha(img, limit=12, feather=1.2):
    """把「从四角连通的白底」变透明；图形内部的白色不受影响（泛洪不连通）。

    limit 是灰度差阈值：实测白底 ≈0、浅蓝底板 ≈18（(226,239,255) 与纯白之差），
    取 12 能干净分开两者；再用 3×3 腐蚀咬掉 JPEG 边缘光晕，最后 1.2px 羽化。
    """
    rgb = img.convert('RGB')
    white = Image.new('RGB', rgb.size, (255, 255, 255))
    diff = ImageChops.difference(rgb, white).convert('L')
    near = diff.point(lambda p: 255 if p <= limit else 0)
    for xy in ((0, 0), (rgb.size[0] - 1, 0), (0, rgb.size[1] - 1), (rgb.size[0] - 1, rgb.size[1] - 1)):
        if near.getpixel(xy) == 255:
            ImageDraw.floodfill(near, xy, 128, thresh=0)
    alpha = near.point(lambda p: 0 if p == 128 else 255)
    alpha = alpha.filter(ImageFilter.MinFilter(3))       # 腐蚀 1px：去白边光晕
    if feather:
        alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
    # Pillow 的 8bit 高斯对「全 255 邻域」会回落到 254（浮点转定点截断），
    # 导致整块内部变成 99.6% 不透明 —— 这里把内部拉回 255、外部压到 0，只保留过渡带。
    alpha = alpha.point(lambda p: 255 if p >= 250 else (0 if p <= 4 else p))
    out = rgb.convert('RGBA')
    out.putalpha(alpha)
    return out


def _trim(img, pad=2):
    """按 alpha 非零区域裁掉透明留白（pad 为保留像素）。"""
    bbox = img.split()[-1].getbbox()
    if not bbox:
        return img
    x0, y0, x1, y1 = bbox
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(img.size[0], x1 + pad), min(img.size[1], y1 + pad)
    return img.crop((x0, y0, x1, y1))


def _circle_alpha(img):
    """圆形主体（头像/圆形 Logo）→ 干净圆形透明底。

    为什么不是"白底泛洪就行"：交付件圆形外有一圈柔光（与白色混色的浅蓝），
    泛洪只吃纯白，柔光会留下 1~2px 的浅色光晕，叠到品牌蓝底上就是一个亮环。
    做法：用「明显不是白」的阈值（diff>35）找到实体圆的外接框 → 裁方 → 圆形蒙版
    （半径 = 边长/2 - 1，1px 羽化），柔光被整块裁掉。
    """
    rgb = img.convert('RGB')
    white = Image.new('RGB', rgb.size, (255, 255, 255))
    diff = ImageChops.difference(rgb, white).convert('L')
    solid = diff.point(lambda p: 255 if p > 35 else 0)
    bbox = solid.getbbox()
    if bbox:
        x0, y0, x1, y1 = bbox
        pad = 3
        rgb = rgb.crop((max(0, x0 - pad), max(0, y0 - pad),
                        min(rgb.size[0], x1 + pad), min(rgb.size[1], y1 + pad)))
    side = max(rgb.size)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(rgb.convert('RGBA'), ((side - rgb.size[0]) // 2, (side - rgb.size[1]) // 2))
    mask = Image.new('L', (side * 4, side * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, side * 4 - 1, side * 4 - 1), fill=255)
    mask = mask.resize((side, side), Image.LANCZOS)
    mask = mask.filter(ImageFilter.GaussianBlur(0.8))
    canvas.putalpha(mask)

    # 边缘去白边：源图圆边是「蓝 ↔ 白」的抗锯齿，直接留 alpha 会在蓝底上显亮环。
    # 做法：取 0.75R 处的主体色，把 alpha∈[5,250] 的像素 RGB 统一换成主体色（只改色不改 alpha）。
    cx = cy = side / 2.0
    samples = []
    for deg in range(0, 360, 15):
        rad = math.radians(deg)
        x = int(cx + math.cos(rad) * side * 0.375)
        y = int(cy + math.sin(rad) * side * 0.375)
        if 0 <= x < side and 0 <= y < side:
            r, g, b, a = canvas.getpixel((x, y))
            if a > 200 and not (r > 240 and g > 240 and b > 240):
                samples.append((r, g, b))
    if samples:
        body = tuple(sum(c[i] for c in samples) // len(samples) for i in range(3))
        # 注意：连 alpha=0 的区域也要刷成主体色。Pillow 的 RGBA resize 不做预乘，
        # 透明像素里残留的近白 RGB 会被插值进边缘 → 蓝底上就是一圈亮边。
        opaque = mask.point(lambda p: 255 if p >= 250 else 0)
        flat = Image.new('RGB', (side, side), body)
        rgb_only = Image.composite(canvas.convert('RGB'), flat, opaque)
        canvas = rgb_only.convert('RGBA')
        canvas.putalpha(mask)
    return canvas


def _shrink_on_white(img, w, h):
    """先等比缩到 w×h 内并铺白底。

    ⚠️ 必须先缩再泛洪：源图 2048²=420 万像素，Pillow 的 floodfill 是纯 Python 实现，
    直接在全尺寸上跑会卡到分钟级（实测被超时杀掉）。缩到 ≤640² 后只需 ~1s。
    """
    sw, sh = img.size
    scale = min(float(w) / sw, float(h) / sh)
    nw, nh = max(1, int(round(sw * scale))), max(1, int(round(sh * scale)))
    small = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGB', (w, h), (255, 255, 255))
    canvas.paste(small, ((w - nw) // 2, (h - nh) // 2))
    return canvas


def _save_under(img, out_path, limit_kb, min_colors=32):
    """调色板量化并按 256→min_colors 递减，仍超标再缩 8%，直到 ≤ limit_kb。

    - 为什么不先砍色数：16 色量化会把品牌蓝 #0B6EF8 洗成浅蓝（实测封面月亮
      从 (11,110,248) 掉到 (168,196,232)）。
    - 为什么透明件也要走调色板：160~320px 的扁平插画真彩 RGBA 要 24~37 KB，
      调色板只要 4~18 KB；alpha 精度问题用下面的 tRNS 归一化补救。
    - tRNS 归一化：FASTOCTREE 会把内部 alpha 255 折成簇中心 254（肉眼无差但
      不属于"干净透明"），这里把 ≥250 的调色板项强制拉回 255、≤4 压到 0。
    """
    limit = limit_kb * 1024
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    work = img

    def _emit(candidate, colors):
        if candidate.mode == 'RGBA':
            q = candidate.quantize(colors=colors, method=Image.Quantize.FASTOCTREE)
            # FASTOCTREE 的 alpha 存在调色板里（q.palette.mode == 'RGBA'），不在 info['transparency']。
            # 内部 alpha 会被折成簇中心 254，这里按调色板项归一化回 255/0。
            if q.palette is not None and q.palette.mode == 'RGBA':
                pal = q.getpalette('RGBA')
                for i in range(3, len(pal), 4):
                    v = pal[i]
                    pal[i] = 255 if v >= 250 else (0 if v <= 4 else v)
                q.putpalette(pal, 'RGBA')
        else:
            q = candidate.convert('RGB').quantize(colors=colors, method=Image.Quantize.MEDIANCUT,
                                                 dither=Image.Dither.NONE)
        q.save(out_path, 'PNG', optimize=True)
        return os.path.getsize(out_path)

    for _ in range(8):
        for colors in (256, 192, 160, 128, 96, 64, 48, min_colors):
            size = _emit(work, colors)
            if size <= limit:
                return colors, size
        work = work.resize((max(1, int(round(work.size[0] * 0.92))),
                            max(1, int(round(work.size[1] * 0.92)))), Image.LANCZOS)
    for colors in (24, 16):
        size = _emit(work, colors)
        if size <= limit:
            return colors, size
    return -1, os.path.getsize(out_path)


def run_asset_pipeline():
    print('%-26s %-46s %8s %6s' % ('source', 'target', 'size', 'colors'))
    failed = []
    for src, rel, w, h, limit, mode in ASSET_PLAN:
        src_path = os.path.join(ASSET_SRC_DIR, src)
        out_path = os.path.join(ROOT, *rel.split('/'))
        if not os.path.exists(src_path):
            print('%-26s MISSING SOURCE' % src)
            failed.append((src, 'missing'))
            continue
        img = Image.open(src_path).convert('RGB')
        if mode == 'white_alpha':
            # 2 倍目标尺寸做蒙版，既保留边缘精度又把泛洪范围压到 ≤640²
            img = _shrink_on_white(img, w * 2, h * 2)
            img = _white_to_alpha(img)
            img = _trim(img, pad=2)
            img = _fit_contain(img, w, h)
        elif mode == 'circle_alpha':
            img = _shrink_on_white(img, w * 2, h * 2)
            img = _circle_alpha(img)
            img = _fit_contain(img, w, h)
        else:
            img = _fit_cover(img, w, h)
        colors, size = _save_under(img, out_path, limit)
        ok = 0 < size <= limit * 1024
        print('%-26s %-46s %7.1fK %6s %s' % (src, rel, size / 1024.0, colors, '' if ok else '  << OVER'))
        if not ok:
            failed.append((src, '%.1fK > %dK' % (size / 1024.0, limit)))
    if failed:
        print('\nFAILED: ' + '; '.join('%s(%s)' % (a, b) for a, b in failed))
        return 1
    print('\nOK: %d assets within budget' % len(ASSET_PLAN))
    return 0


if __name__ == '__main__':
    import sys
    if '--assets' in sys.argv[1:]:
        sys.exit(run_asset_pipeline())
    svgs = sorted(glob.glob(os.path.join(SRC_DIR, '*.svg')))
    total = 0
    for svg_path in svgs:
        name = os.path.splitext(os.path.basename(svg_path))[0]
        with open(svg_path, 'r', encoding='utf-8') as f:
            svg_text = f.read()
        for suffix, color in COLORS.items():
            img = render_svg(svg_text, 96, color)
            out = os.path.join(SRC_DIR, name + suffix + '.png')
            img.save(out, 'PNG')
            total += 1
    print('rendered %d PNG from %d SVG' % (total, len(svgs)))
