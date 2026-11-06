# -*- coding: utf-8 -*-
"""
tools/build-health-videos.py —— 生成「健康提示视频」（本地演示素材）

为什么需要它：
  「健康科普」板块要有**真能播**的提示视频，但：
    ① 后端没有视频接口（不能伪造后端数据）；
    ② 主包已 1.82MB（2MB 上限）→ 视频必须落在分包 packageContent 里；
    ③ 不能依赖外网 CDN（无备案域名、离线也要能演示）。
  所以用 Pillow 逐帧画「康诊云蓝调」要点卡 + ffmpeg 合成 H.264 mp4：
  640×360、12fps、静态画面为主 → 每个约 40~90KB，三个视频合计 < 300KB。

用法（受管 venv，已含 Pillow 12.3）：
  ~/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/build-health-videos.py

产物：
  miniprogram/packageContent/videos/<id>.mp4    视频本体（video 组件 src）
  miniprogram/packageContent/videos/<id>.jpg    封面（视频列表卡 poster）

⚠️ 勿手改产物；改内容请改本脚本顶部的 VIDEOS 后重跑（与 tools/build-floorplan.py 同一约定）。

🚨 2026-11-05（F2 Phase B）：包内 mp4/jpg 已**出包删除**，播放走资源端点（video.*）、
   封面走清单（health.*），服务端副本 `backend/deploy/resources/` 才是线上源。
   **重跑本脚本会把 3 个 mp4 + 3 张 jpg 重新写进 packageContent/videos/（包体 193KB → 358KB，
   质量面板「图片音频 ≤200K」会再次未通过）**。重跑后必须执行出包三步：
   ① 拷贝产物到 backend/deploy/resources/（同名覆盖副本）；
   ② 删除 miniprogram/packageContent/videos/ 下全部产物；
   ③ python tools/resource-import.py --write（更新 DB size/sha256）+ 重跑 check-project。
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'miniprogram', 'packageContent', 'videos')

FFMPEG = r'D:\ffmpeg-master-latest-win64-gpl-shared\bin\ffmpeg.exe'
FONT_BD = r'C:\Windows\Fonts\msyhbd.ttc'   # 微软雅黑 Bold
FONT_RG = r'C:\Windows\Fonts\msyh.ttc'     # 微软雅黑 Regular

W, H = 640, 360
FPS = 12
SLIDE_SEC = 2.6          # 每屏停留（秒）
FADE_SEC = 0.45          # 每屏淡入时长（秒）

# 康诊云蓝调（与 app.wxss 的设计变量一致）
BLUE = (22, 93, 255)
DEEP = (10, 62, 200)
WHITE = (255, 255, 255)
BG = (245, 247, 250)
CARD = (255, 255, 255)
CARD_EDGE = (233, 238, 248)
TITLE = (29, 33, 41)
SUB = (78, 89, 105)
WEAK = (134, 144, 156)
TRACK = (223, 230, 240)

# ==================== 视频内容（改这里即可） ====================
VIDEOS = [
    {
        'id': 'wash-hands',
        'title': '七步洗手法',
        'subtitle': '每一步都要搓到位，全程不少于 20 秒',
        'slides': [
            ('1', '内 · 掌心相对搓', '掌心相对，手指并拢，来回搓 5 次'),
            ('2', '外 · 手背交替搓', '手心对手背，沿指缝上下搓 5 次'),
            ('3', '夹 · 十指交叉搓', '掌心相对，十指交叉，沿指缝搓 5 次'),
            ('4', '腕 · 手腕也要洗', '握住手腕旋转搓，两手交替各 5 次'),
        ],
    },
    {
        'id': 'measure-bp',
        'title': '在家量血压 4 个要点',
        'subtitle': '姿势不对，数值会偏高 10~20mmHg',
        'slides': [
            ('1', '先静坐 5 分钟', '不喝浓茶、不吸烟，排空小便后安静坐好'),
            ('2', '手臂与心脏同高', '手肘平放桌面，袖带中心与心脏齐平'),
            ('3', '袖带留两指宽', '袖带下缘距肘窝约两指，松紧能塞进一指'),
            ('4', '连测两次取平均', '间隔 1 分钟再测一次，记下两次的平均值'),
        ],
    },
    {
        'id': 'stand-up',
        'title': '起床三步曲（防跌倒）',
        'subtitle': '老年人起夜、起床最容易头晕跌倒',
        'slides': [
            ('1', '醒后先躺 30 秒', '睁开眼睛，活动手脚，别急着坐起'),
            ('2', '坐起再等 30 秒', '慢慢坐直，床边靠一会儿再动'),
            ('3', '床边坐 30 秒', '双脚踩实地面，确认不头晕'),
            ('4', '站稳再迈步', '扶稳床沿或扶手，站稳后一步步走'),
        ],
    },
]


def font(path, size):
    """加载中文字体；.ttc 取 index 0（雅黑 Bold / Regular 的第一款）"""
    try:
        return ImageFont.truetype(path, size, index=0)
    except Exception:
        return ImageFont.truetype(r'C:\Windows\Fonts\simhei.ttf', size)


def hsl_tint():
    """主标题条：蓝色竖向渐变（用柱状填充近似，避免逐像素开销）"""
    bar = Image.new('RGB', (W, 66), BLUE)
    d = ImageDraw.Draw(bar)
    for x in range(W):
        t = x / W
        c = (int(BLUE[0] + (DEEP[0] - BLUE[0]) * t),
             int(BLUE[1] + (DEEP[1] - BLUE[1]) * t),
             int(BLUE[2] + (DEEP[2] - BLUE[2]) * t))
        d.line([(x, 0), (x, 66)], fill=c)
    # ⚠️ 不要在这里画右下/右上装饰圆：会盖住标题条右端的"院内健康提示"小字（已踩过）。
    return bar


def base_frame(video, idx, total):
    """背景层（不参与淡入）：底部品牌条 + 进度点 —— 每帧只画一次"""
    img = Image.new('RGB', (W, H), BG)
    img.paste(hsl_tint(), (0, 0))
    d = ImageDraw.Draw(img)

    f_title = font(FONT_BD, 25)
    f_tag = font(FONT_RG, 13)
    d.text((22, 20), video['title'], font=f_title, fill=WHITE)
    tag = '院内健康提示'
    tw = d.textlength(tag, font=f_tag)
    d.text((W - 26 - tw, 27), tag, font=f_tag, fill=(214, 226, 255))

    # 底部：品牌行 + 进度点
    d.line([(0, H - 34), (W, H - 34)], fill=TRACK)
    f_foot = font(FONT_RG, 12)
    d.text((22, H - 24), 'AI 智慧医疗 · 健康提示', font=f_foot, fill=WEAK)
    dot_r, gap = 3, 8
    total_w = total * dot_r * 2 + (total - 1) * gap
    x0 = W - 22 - total_w
    for i in range(total):
        cx = x0 + i * (dot_r * 2 + gap)
        cy = H - 17
        fill = BLUE if i == idx else TRACK
        d.ellipse([cx, cy - dot_r, cx + dot_r * 2, cy + dot_r], fill=fill)
    return img


def content_layer(video, idx):
    """内容层（参与淡入）：副标题 + 要点卡（序号圆 + 步骤名 + 说明）"""
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    no, name, desc = video['slides'][idx]

    # 副标题（标题条下）
    f_sub = font(FONT_RG, 15)
    d.text((22, 78), video['subtitle'], font=f_sub, fill=SUB)

    # 要点卡
    cx0, cy0, cx1, cy1 = 22, 112, W - 22, H - 52
    d.rounded_rectangle([cx0 + 2, cy0 + 4, cx1 + 2, cy1 + 4], radius=14, fill=(226, 233, 245, 255))
    d.rounded_rectangle([cx0, cy0, cx1, cy1], radius=14, fill=CARD + (255,))

    # 左侧竖条（蓝色，呼应小程序卡片的 border-left 强调）
    d.rounded_rectangle([cx0, cy0 + 22, cx0 + 5, cy1 - 22], radius=3, fill=BLUE + (255,))

    # 序号圆 + 步骤名 + 说明：整块在卡片内**垂直居中**（block_top 为块顶）
    r = 21
    block_top = cy0 + 76
    ccx, ccy = cx0 + 34 + r, block_top + r
    d.ellipse([ccx - r, ccy - r, ccx + r, ccy + r], fill=BLUE + (255,))
    f_no = font(FONT_BD, 22)
    nw = d.textlength(no, font=f_no)
    d.text((ccx - nw / 2, ccy - 17), no, font=f_no, fill=WHITE + (255,))

    # 步骤名 + 说明
    f_name = font(FONT_BD, 25)
    d.text((ccx + r + 18, block_top - 4), name, font=f_name, fill=TITLE + (255,))

    f_desc = font(FONT_RG, 16)
    # 说明较长时按宽度自动折行（中文按字符折）
    max_w = cx1 - (ccx + r + 18) - 24
    line, lines = '', []
    for ch in desc:
        if d.textlength(line + ch, font=f_desc) > max_w:
            lines.append(line)
            line = ch
        else:
            line += ch
    if line:
        lines.append(line)
    for i, ln in enumerate(lines[:2]):
        d.text((ccx + r + 18, block_top + 34 + i * 26), ln, font=f_desc, fill=SUB + (255,))
    return layer


def render_frames(video, tmp):
    total = len(video['slides'])
    frames_per_slide = int(SLIDE_SEC * FPS)
    fade_frames = max(1, int(FADE_SEC * FPS))
    n = 0
    cover_src = None
    for idx in range(total):
        base = base_frame(video, idx, total)
        content = content_layer(video, idx)
        for f in range(frames_per_slide):
            a = min(1.0, (f + 1) / fade_frames)
            frame = base.convert('RGBA')
            if a < 1.0:
                layer = content.copy()
                layer.putalpha(layer.getchannel('A').point(lambda v: int(v * a)))
                frame = Image.alpha_composite(frame, layer)
            else:
                frame = Image.alpha_composite(frame, content)
            rgb = frame.convert('RGB')
            path = os.path.join(tmp, '%03d.png' % n)
            rgb.save(path)
            # 封面取第一屏淡入完成后的那一帧（画面最完整）
            if cover_src is None and idx == 0 and f == fade_frames:
                cover_src = rgb
            n += 1
    return n, cover_src


def main():
    if not os.path.exists(FFMPEG):
        print('未找到 ffmpeg：%s' % FFMPEG)
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)
    print('输出目录：%s' % OUT_DIR)
    total_size = 0

    for video in VIDEOS:
        tmp = tempfile.mkdtemp(prefix='hbv_')
        try:
            n, cover = render_frames(video, tmp)
            mp4 = os.path.join(OUT_DIR, video['id'] + '.mp4')
            jpg = os.path.join(OUT_DIR, video['id'] + '.jpg')
            cmd = [
                FFMPEG, '-y', '-loglevel', 'error',
                '-framerate', str(FPS), '-i', os.path.join(tmp, '%03d.png'),
                '-c:v', 'libx264', '-preset', 'slow', '-crf', '27',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                mp4,
            ]
            subprocess.run(cmd, check=True)
            if cover is not None:
                cover.save(jpg, quality=82)
            size = os.path.getsize(mp4)
            total_size += size
            print('  ✅ %-12s %2d 帧 → %6.1f KB（%d 屏 × %.1fs）· 封面 %s'
                  % (video['id'], n, size / 1024, len(video['slides']), SLIDE_SEC,
                     os.path.basename(jpg)))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    print('合计 %.1f KB（分包上限 2MB，主包 2MB —— 必须留在 packageContent 分包内）'
          % (total_size / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
