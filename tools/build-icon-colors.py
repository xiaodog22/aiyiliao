# -*- coding: utf-8 -*-
"""
build-icon-colors.py —— 由单色蓝图标派生出**彩色变体**。

背景：
  assets/icons/*.png 只有蓝(#0B6EF8)/灰/白三种配色（线稿由 tools/build-icons.js +
  tools/svg2png.py 生成）。页面需要参考图那样的**分色系图标**（蓝/绿/粉/橙/紫 分组），
  而 WXSS 无法给 PNG 着色 —— 于是按 alpha 通道重着色，产出物仍是 PNG（<image> 可直接用）。

原理：
  原图标是「纯色 + 抗锯齿只在 alpha 通道」的形状（R/G/B 恒为基色，A 变化）。
  因此：新图 = 目标色填充 + 沿用原图 alpha。形状与边缘抗锯齿完全不变，只是换了颜色。

用法：
  python tools/build-icon-colors.py            # 生成缺失的彩色变体
  python tools/build-icon-colors.py --force     # 全部重生成
产出（写入 miniprogram/assets/icons/），色板 = 参考图「装饰五色」（D-01④）：
  #3FAB7C 装饰绿 / #EF5481 装饰粉 / #FBA036 装饰橙 / #9566FA 装饰紫（蓝=基色 PNG 本身）
  语义红 #F53F3F 保留（体检/危险），不与装饰色混用。
⚠️ 新增变体后必须同步在 miniprogram/utils/icons.js 里登记键名，否则页面引用不到。
"""
import os
import sys

from PIL import Image

SRC_DIR = os.path.join(os.path.dirname(__file__), '..', 'miniprogram', 'assets', 'icons')

# 目标色 = 参考图实测的「图标字形五色」（装饰色，与状态徽章语义色分工并存，D-01④）
GREEN = (63, 171, 124)    # #3FAB7C 装饰绿（薄荷底板配字）
PINK = (239, 84, 129)     # #EF5481 装饰粉
AMBER = (251, 160, 54)    # #FBA036 装饰橙
PURPLE = (149, 102, 250)  # #9566FA 装饰紫
RED = (245, 63, 63)       # #F53F3F 语义红（体检服务等，保持）

# 输出文件名 -> (源文件名, 目标色)
MAP = {
    # —— 既有 7 枚（2026-10-16 色值切到装饰五色板）——
    'calendar_green.png':  ('calendar.png',  GREEN),   # 预约挂号
    'leaf_amber.png':      ('leaf.png',      AMBER),   # AI 养生
    'fileText_purple.png': ('fileText.png',  PURPLE),  # 报告查询
    'pill_green.png':      ('pill.png',      GREEN),   # 找科室
    'heartbeat_red.png':   ('heartbeat.png', RED),     # 体检服务
    'home_amber.png':      ('home.png',      AMBER),   # 居家护理
    'chat_purple.png':     ('chat.png',      PURPLE),  # 健康咨询
    # —— 新增（2026-10-16 基调对齐：我的 / 工作台 / 养生 用点）——
    'archive_mint.png':      ('archive.png',      GREEN),   # 我的·健康档案
    'chat_pink.png':         ('chat.png',         PINK),    # 我的·我的问诊
    'users_purple.png':      ('users.png',        PURPLE),  # 我的·家庭成员
    'bed_mint.png':          ('bed.png',          GREEN),   # 工作台·床位管理
    'tv_amber.png':          ('tv.png',           AMBER),   # 工作台·智能电视大屏
    'user_purple.png':       ('user.png',         PURPLE),  # 工作台·个人管理
    'user_amber.png':        ('user.png',         AMBER),   # 工作台·待就诊统计
    'checkCircle_green.png': ('checkCircle.png',  GREEN),   # 工作台·已完成统计
    'moon_purple.png':       ('moon.png',         PURPLE),  # 养生·改善睡眠
    'bowl_mint.png':         ('bowl.png',         GREEN),   # 养生·食谱推荐
    'activity_amber.png':    ('activity.png',     AMBER),   # 养生·老年人运动
    # —— 2026-10-20 新增（医生工作台「今日工作·在线问诊」：薄荷底板配绿字形，对齐 01 号效果图）——
    'chat_mint.png':         ('chat.png',         GREEN),   # 工作台·在线问诊
    # —— 2026-10-21 新增（适老化首页 08 稿：紧急提示条用橙色警示图标）——
    'alert_amber.png':       ('alert.png',        AMBER),   # 适老首页·紧急提示条
}


def recolor(src_path, color, dst_path):
    """把单色图标重着色为目标色：保留原图 alpha，RGB 换成目标色。"""
    src = Image.open(src_path).convert('RGBA')
    alpha = src.split()[3]                      # A 通道 = 形状 + 抗锯齿
    out = Image.new('RGBA', src.size, color + (0,))
    out.putalpha(alpha)
    out.save(dst_path, 'PNG', optimize=True)
    return out.size, alpha


def main():
    force = '--force' in sys.argv
    if not os.path.isdir(SRC_DIR):
        print('找不到图标目录: ' + SRC_DIR)
        return 1

    made, skipped, failed = [], [], []
    for dst_name, (src_name, color) in MAP.items():
        src_path = os.path.join(SRC_DIR, src_name)
        dst_path = os.path.join(SRC_DIR, dst_name)
        if not os.path.exists(src_path):
            failed.append(dst_name + ' (源缺失 ' + src_name + ')')
            continue
        if os.path.exists(dst_path) and not force:
            skipped.append(dst_name)
            continue
        size, _ = recolor(src_path, color, dst_path)
        made.append('%s <- %s %s %dB' % (
            dst_name, src_name, '#%02X%02X%02X' % color, os.path.getsize(dst_path)))

    for line in made:
        print('  生成 ' + line)
    if skipped:
        print('  跳过（已存在，加 --force 可重生成）：' + '、'.join(skipped))
    if failed:
        print('  失败：' + '、'.join(failed))

    total = sum(os.path.getsize(os.path.join(SRC_DIR, f)) for f in MAP if os.path.exists(os.path.join(SRC_DIR, f)))
    print('彩色变体合计 %.1f KB' % (total / 1024.0))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
