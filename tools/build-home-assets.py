# -*- coding: utf-8 -*-
"""首页素材加工 —— 从设计交付图裁切/抠圆 → miniprogram/assets/home/

源图（设计交付，已归档到 tools/_assets_src/，不进小程序包）：
  src-doctor.jpg   小安 3D 头像卡          → ai-doctor.png      （圆形透明底）
  src-banner.jpg   智能导诊 banner 大图     → banner-hospital.jpg（医院插画，含天空/广场留白）
  src-grid9.jpg    3×3 服务图标九宫格       → svc-*.png × 8      （圆形透明底）
  src-bg.jpg       蓝色渐变背景             → 不落地（用 CSS 渐变模拟，省主包体积）
  src-icons4.jpg   底部导航线性图标         → 不落地（tabBar 已有等价蓝/灰双态 PNG）
  src-skeleton.jpg 版式骨架                 → 不落地（仅作布局参照）

⚠️ 主包硬上限 2MB：本脚本输出必须控制在 ~100KB 内。
   坐标由 tools 下的探测脚本（连通域/圆心扫描）实测得出，改动源图需重测。

用法：python tools/build-home-assets.py
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', '_assets_src')
OUT = os.path.join(ROOT, 'miniprogram', 'assets', 'home')

# ---- grid9：8 个浅蓝圆底的圆心（实测，连通域 bbox 中心）----
GRID_D = 400           # 裁切框边长
GRID_SHRINK = 10       # 圆底实测直径 ≈ 376~390，蒙版取 380 落在渐变中（圆外不露背景）
SVC = [
    ('triage',  368,  342, '智能导诊'),
    ('doctor',  958,  342, '找医生'),
    ('dept',   1544,  342, '找科室'),
    ('archive', 372,  920, '健康档案'),
    ('checkup', 956,  920, '体检服务'),
    ('care',   1542,  920, '居家护理'),
    ('advice',  370, 1494, '健康咨询'),
    ('more',    956, 1494, '更多服务'),
]
SVC_OUT = 132          # 输出边长（设计稿显示 44px @375 → 3x）

# ---- 小安头像：圆心 + 裁切框边长 ----
DOC_C = (968, 331)     # 圆心实测，(968,333) 略偏下会带出圆底白色装饰 → 上移 2px
DOC_D = 400
DOC_SHRINK = 18        # 圆的视觉半径 ≈ 182（试版对照：18 时圆完整且圆外干净）
DOC_OUT = 216          # 设计稿显示约 90px @375 → 2.4x

# ---- banner：白卡内的医院插画（去掉标题与留白）----
BAN_BOX = (659, 365, 1615, 855)      # 956×490（插画主体：天空顶 → 楼基 + 一线广场）
BAN_SKY = 62                         # 顶部再向上补的天空行数（复制首行拉伸，渐变无缝）
# 输出比值 1.732 **刻意对齐容器**（卡片宽 520rpx / 高 300rpx ≈ 1.733）：
# 这样 aspectFill 不裁切，整幅插画高度 == 卡片高度 → 楼占卡片高 ≈69%（设计稿 69%）、
# 楼基落在卡片下沿 ≈97% 处。
# ⚠️ 反过来裁成 1.54 的“紧构图”，容器会改按**宽**缩放、楼被放大到卡片高的 ~107%，楼底会被卡片下沿切掉。
BAN_OUT = (660, 381)                 # 比值 1.732


def circle_crop(img, cx, cy, d, out, shrink, feather=3):
    """以 (cx,cy) 为中心、d 为框边长取图，按直径 (d-2*shrink) 的圆形蒙版抠图并缩放到 out。

    ⚠️ shrink 是「实测圆半径」与「框半边长」之差：源图里的圆底外还有一圈渐隐与装饰，
       蒙版若贴到框边就会把圆外像素一起带出来（成品圆外一圈浅色残影，或圆底下方白色月牙）。
       取值由 tools 下的试版对照确定，改源图需重测。
       裁切后把多余边距一并去掉，圆正好填满输出图。
    """
    r = d // 2
    side = d - 2 * shrink
    x0, y0 = cx - r + shrink, cy - r + shrink
    crop = img.crop((x0, y0, x0 + side, y0 + side)).convert('RGBA')
    m = Image.new('L', (side, side), 0)
    ImageDraw.Draw(m).ellipse([0, 0, side - 1, side - 1], fill=255)
    if feather:
        m = m.filter(ImageFilter.GaussianBlur(feather))
    crop.putalpha(m)
    return crop.resize((out, out), Image.LANCZOS)


def save_png(im, path, colors=128):
    """PNG-8 量化（保留 alpha），失败则退回全彩 PNG。"""
    try:
        q = im.quantize(colors=colors, method=Image.FASTOCTREE)
        q.save(path, optimize=True)
    except Exception:
        im.save(path, optimize=True)
    return os.path.getsize(path)


def main():
    if not os.path.isdir(SRC):
        print('缺少源图目录：%s' % SRC)
        return 1
    os.makedirs(OUT, exist_ok=True)
    total = 0

    # ① 小安头像
    doc = Image.open(os.path.join(SRC, 'src-doctor.jpg')).convert('RGB')
    p = os.path.join(OUT, 'ai-doctor.png')
    total += save_png(circle_crop(doc, DOC_C[0], DOC_C[1], DOC_D, DOC_OUT, DOC_SHRINK, 3), p, 192)
    print('  ai-doctor.png            %5.1f KB  %dx%d' % (os.path.getsize(p) / 1024, DOC_OUT, DOC_OUT))

    # ② banner 医院插画（照片类 → JPEG 更省）
    ban = Image.open(os.path.join(SRC, 'src-banner.jpg')).convert('RGB').crop(BAN_BOX)
    if BAN_SKY:
        # 天空是平滑的水平渐变：把首行竖向拉伸补在上方即可无缝续接（比留白/纯色填充自然）
        top = ban.crop((0, 0, ban.width, 1)).resize((ban.width, BAN_SKY), Image.BICUBIC)
        canvas = Image.new('RGB', (ban.width, ban.height + BAN_SKY))
        canvas.paste(top, (0, 0))
        canvas.paste(ban, (0, BAN_SKY))
        ban = canvas
    ban = ban.resize(BAN_OUT, Image.LANCZOS)
    p = os.path.join(OUT, 'banner-hospital.jpg')
    ban.save(p, 'JPEG', quality=82, optimize=True, progressive=True)
    total += os.path.getsize(p)
    print('  banner-hospital.jpg      %5.1f KB  %dx%d' % (os.path.getsize(p) / 1024, ban.size[0], ban.size[1]))

    # ③ 8 个服务图标（圆形透明底）
    g9 = Image.open(os.path.join(SRC, 'src-grid9.jpg')).convert('RGB')
    for key, cx, cy, name in SVC:
        im = circle_crop(g9, cx, cy, GRID_D, SVC_OUT, GRID_SHRINK, 3)
        p = os.path.join(OUT, 'svc-%s.png' % key)
        total += save_png(im, p, 96)
        print('  svc-%-14s.png   %5.1f KB  (%s)' % (key, os.path.getsize(p) / 1024, name))

    print('\n合计 %.1f KB → %s' % (total / 1024, os.path.relpath(OUT, ROOT)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
