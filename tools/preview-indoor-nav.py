# -*- coding: utf-8 -*-
"""
preview-indoor-nav.py —— 院内导航页面渲染的离线等价预览（验收用）

作用：小程序 canvas 代码没法在命令行跑，但它的几何公式是确定的。
本脚本用**与 nav.js 相同的公式**（scale / 标记半径 / 字号 / pill 尺寸 / 路径线宽，
均为"屏幕尺寸 ÷ scale"）把 底图 + 路径 + 标记 合成一张预览图，
用来提前发现：标记名互相压字、marker 压住底图区名、路线出界等问题。

渲染两次：
  ① 全尺寸（1200×860，便于看清细节）
  ② 按 375×420 手机地图区、fit scale 缩小 → 模拟真机观感（检验可读性）

用法：python tools/preview-indoor-nav.py [目的地id ...]   # 省略则预览全部目的地
输出：tools/_preview_nav_full.png / tools/_preview_nav_screen.png
"""
import os
import sys
import json
import math

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'floorplan-src.json')
BASE = os.path.join(ROOT, 'miniprogram', 'packageNav', 'assets', 'floor1.png')

FONT_CANDIDATES = ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyhbd.ttc',
                   'C:/Windows/Fonts/simhei.ttf', '/System/Library/Fonts/PingFang.ttc']
CAT_COLOR = {'门诊': (22, 93, 255), '检查': (0, 180, 42), '服务': (255, 125, 0),
             '治疗': (123, 97, 255), '设施': (134, 144, 156)}
SCREEN_W, SCREEN_H = 375, 420      # 模拟手机地图区尺寸
FONT_STANDARD = 13                 # nav.js FONT_BY_THEME.standard


def font(size, bold=False):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, int(round(size)), index=0)
            except Exception:
                continue
    return None


def text_size(draw, s, f):
    box = draw.textbbox((0, 0), s, font=f)
    return box[2] - box[0], box[3] - box[1]


def draw_scene(src, base_img, dest_ids, scale, label):
    W = src['canvas']['w']
    H = src['canvas']['h']
    img = base_img.copy().convert('RGBA')
    d = ImageDraw.Draw(img, 'RGBA')

    # ---- 路径（等价 _drawRoute：线宽 = 屏幕 px ÷ scale）----
    halo = 18 / scale
    line = 8 / scale
    for did in dest_ids:
        dest = [x for x in src['destinations'] if x['id'] == did][0]
        # 注意：floorplan-src.json 用的是底图像素坐标（百分比是生成 indoor-map.js 时才换算的）
        pts = [(int(round(p[0])), int(round(p[1]))) for p in dest['path']]
        d.line(pts, fill=(22, 93, 255, 41), width=int(round(halo)), joint='curve')  # 坐标必须整数，float 会被静默忽略
        d.line(pts, fill=(22, 93, 255, 255), width=int(round(line)), joint='curve')
        # 段中方向箭头
        for i in range(len(pts) - 1):
            ax, ay = pts[i]
            bx, by = pts[i + 1]
            mx, my = int((ax + bx) / 2), int((ay + by) / 2)
            dx, dy = bx - ax, by - ay
            L = math.hypot(dx, dy) or 1
            ux, uy = dx / L, dy / L
            nx, ny = -uy, ux
            sz = 9 / scale
            d.polygon([(int(mx + ux * sz), int(my + uy * sz)),
                       (int(mx - ux * sz + nx * sz * 0.72), int(my - uy * sz + ny * sz * 0.72)),
                       (int(mx - ux * sz - nx * sz * 0.72), int(my - uy * sz - ny * sz * 0.72))],
                      fill=(22, 93, 255, 255))
        # 端点
        for idx, col in ((0, (0, 180, 42)), (len(pts) - 1, (22, 93, 255))):
            r = 12 / scale
            x, y = pts[idx]
            d.ellipse([int(x - r), int(y - r), int(x + r), int(y + r)], fill=(255, 255, 255, 255),
                      outline=col, width=int(round(3.5 / scale)))

    # ---- 标记（等价 _marker：半径/字号/pill 均为 屏幕尺寸 ÷ scale）----
    f = font(FONT_STANDARD / scale)
    markers = [dict(src['origin'], color=(0, 180, 42), active=False)] if dest_ids else []
    for dest in src['destinations']:
        markers.append({'name': dest['name'].replace('（取药）', ''), 'x': dest['x'], 'y': dest['y'],
                        'color': CAT_COLOR.get(dest['category'], (22, 93, 255)),
                        'active': dest['id'] in dest_ids})

    overlaps = []
    for m in markers:
        mx = int(m['x'])
        my = int(m['y'])
        r = (15 if m['active'] else 11) / scale
        tw, th = text_size(d, m['name'], f)
        pad = 7 / scale
        ph = FONT_STANDARD / scale + 12 / scale
        pw = tw + pad * 2
        px = mx - pw / 2
        py = my - r - ph - 5 / scale
        d.rounded_rectangle([int(px), int(py), int(px + pw), int(py + ph)], radius=int(round(6 / scale)),
                            fill=m['color'] if m['active'] else (255, 255, 255, 240),
                            outline=m['color'] if m['active'] else (148, 163, 184, 230),
                            width=max(1, int(round(1.5 / scale))))
        d.text((int(mx), int(py + ph / 2)), m['name'], font=f, anchor='mm',
               fill=(255, 255, 255) if m['active'] else (29, 33, 41))
        d.ellipse([int(mx - r), int(my - r), int(mx + r), int(my + r)], fill=(255, 255, 255, 255),
                  outline=m['color'], width=max(1, int(round((4 if m['active'] else 3) / scale))))
        mr = r * 0.42
        d.ellipse([int(mx - mr), int(my - mr), int(mx + mr), int(my + mr)], fill=m['color'])
        m['_box'] = (px, py, px + pw, py + ph)

    # 标记名两两重叠检测（真机上就是"字压字"）
    for i in range(len(markers)):
        for j in range(i + 1, len(markers)):
            a, b = markers[i]['_box'], markers[j]['_box']
            if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                overlaps.append('%s ↔ %s' % (markers[i]['name'], markers[j]['name']))

    print('[%s] scale=%.2f → 标记名重叠：%s' % (label, scale, '、'.join(overlaps) if overlaps else '无'))
    return img, overlaps


def main():
    ids = [a for a in sys.argv[1:] if not a.startswith('-')] or \
          [x['id'] for x in json.load(open(SRC, encoding='utf-8'))['destinations']]
    src = json.load(open(SRC, encoding='utf-8'))
    base = Image.open(BASE)

    # ① 全尺寸（大 scale=1，凑近看细节）
    full, _ = draw_scene(src, base, ids, 1.0, '全尺寸')
    out1 = os.path.join(ROOT, 'tools', '_preview_nav_full.png')
    full.save(out1, 'PNG', optimize=True)

    # ② 模拟真机观感：按 375×420 地图区的 fit scale 渲染后缩到屏幕尺寸
    fit = min(SCREEN_W / float(src['canvas']['w']), SCREEN_H / float(src['canvas']['h']))
    scale = max(0.45, min(1.0, fit))
    scene, ov = draw_scene(src, base, ids, scale, '真机观感')
    out2 = os.path.join(ROOT, 'tools', '_preview_nav_screen.png')
    scene.resize((SCREEN_W, int(src['canvas']['h'] * scale)), Image.LANCZOS).save(out2, 'PNG', optimize=True)

    print('预览 → %s' % os.path.relpath(out1, ROOT))
    print('预览 → %s' % os.path.relpath(out2, ROOT))
    if ov:
        print('⚠️ 存在标记名重叠，请调整 floorplan-src.json 中对应目的地坐标')
        sys.exit(1)


if __name__ == '__main__':
    main()
