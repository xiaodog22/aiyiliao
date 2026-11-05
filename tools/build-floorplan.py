# -*- coding: utf-8 -*-
"""
build-floorplan.py —— 院内导航底图 + 路径数据生成器（单一数据源）

为什么要它：底图（PNG）与路径点（JS/JSON）必须永远对齐。手绘一张图 + 手填一套坐标，
改一处忘一处就会出现"线飘在墙外"。所以只维护 tools/floorplan-src.json，
本脚本一次产出三样东西（单一真源派生，勿手改任何派生文件）：
    ① miniprogram/packageNav/assets/floor1.png   静态平面图底图（Pillow 绘制，2x 超采样）
    ② miniprogram/packageNav/data/indoor-map.js  前端导航数据（目的地 + 路径 + 步骤文案，百分比坐标）
    ③ backend/business-service/src/main/resources/indoor-map.json
       后端 IndoorMapService 的 classpath 数据源（GET /api/v1/indoor-map/* 的楼层/路径）
       ——与 ② 同源派生：改坐标只改 floorplan-src.json 后重跑本脚本，前后端同时更新，杜绝双份漂移。

为什么走分包：主包已 1.94MB / 2MB，底图必须放 packageNav 分包，不占主包额度。

用法：
    python tools/build-floorplan.py
    python tools/build-floorplan.py --check   # 只做自检（路径穿门/越界），不写文件
"""
import os
import sys
import json
import math

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print('需要 Pillow：python -m pip install pillow')
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'floorplan-src.json')
OUT_PNG = os.path.join(ROOT, 'miniprogram', 'packageNav', 'assets', 'floor1.png')
OUT_JS = os.path.join(ROOT, 'miniprogram', 'packageNav', 'data', 'indoor-map.js')
# 后端 IndoorMapService 的 classpath 数据源：必须与 ② 同源派生（本脚本生成，勿手改）。
OUT_JSON = os.path.join(ROOT, 'backend', 'business-service', 'src', 'main', 'resources', 'indoor-map.json')

SS = 2  # 超采样倍数（平坦色块压缩后很小，2x 足够清晰）

# 底图上写中文区名需要 CJK 字体；找不到就跳过文字（不阻断生成）
FONT_CANDIDATES = [
    ('C:/Windows/Fonts/msyh.ttc', 0),
    ('C:/Windows/Fonts/msyhbd.ttc', 0),
    ('C:/Windows/Fonts/simhei.ttf', 0),
    ('C:/Windows/Fonts/simsun.ttc', 0),
    ('/System/Library/Fonts/PingFang.ttc', 0),
    ('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 0),
]


def load_font(size):
    for path, idx in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=idx)
            except Exception:
                try:
                    return ImageFont.truetype(path, size)
                except Exception:
                    continue
    return None


def hex2rgba(c):
    c = (c or '#000000').lstrip('#')
    if len(c) == 3:
        c = ''.join(ch * 2 for ch in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


# ---------------- 底图渲染 ----------------
def render(src):
    W, H = src['canvas']['w'], src['canvas']['h']
    pal = src['palette']
    img = Image.new('RGBA', (W * SS, H * SS), hex2rgba(pal['ground']))
    d = ImageDraw.Draw(img)

    def rect(x, y, w, h, fill=None, outline=None, width=2):
        d.rectangle([x * SS, y * SS, (x + w) * SS, (y + h) * SS],
                    fill=hex2rgba(fill) if fill else None,
                    outline=hex2rgba(outline) if outline else None,
                    width=max(1, int(width * SS)))

    # 建筑外轮廓（投影感：先画一层浅灰边）
    o = src['outer']
    rect(o['x'] - 6, o['y'] - 6, o['w'] + 12, o['h'] + 12, fill='#EFF3F8')
    rect(o['x'], o['y'], o['w'], o['h'], fill=pal['ground'], outline=pal['outline'], width=3)

    # 房间区块（按数组顺序绘制，后画的压前面的，便于"大厅内的卫生间"这类嵌套）
    for z in src['zones']:
        rect(z['x'], z['y'], z['w'], z['h'],
             fill=pal[z['kind']], outline=pal['wall'], width=2)

    # 门洞：用底色白线把墙"剪开"
    for dr in src['doors']:
        half = dr['gap'] / 2.0
        if dr['axis'] == 'h':
            x1, y1, x2, y2 = dr['a'] - half, dr['c'], dr['a'] + half, dr['c']
        else:
            x1, y1, x2, y2 = dr['c'], dr['a'] - half, dr['c'], dr['a'] + half
        d.line([x1 * SS, y1 * SS, x2 * SS, y2 * SS],
               fill=hex2rgba(pal['ground']), width=int(6 * SS))

    # 区名文字
    for z in src['zones']:
        if not z.get('label'):
            continue
        lx, ly, size = z['label']
        f = load_font(int(size * SS))
        if not f:
            continue
        col = hex2rgba('#165DFF' if z['kind'] == 'hall' else '#4E5969')
        d.text((lx * SS, ly * SS), z['name'], font=f, fill=col, anchor='mm')
        if z.get('sub'):
            f2 = load_font(int(size * 0.72 * SS))
            if f2:
                d.text((lx * SS, (ly + size * 1.25) * SS), z['sub'], font=f2,
                       fill=hex2rgba('#86909C'), anchor='mm')

    for lb in src.get('extraLabels', []):
        f = load_font(int(lb['size'] * SS))
        if not f:
            continue
        d.text((lb['x'] * SS, lb['y'] * SS), lb['text'], font=f,
               fill=hex2rgba(lb.get('color', '#4E5969')), anchor=lb.get('anchor', 'mm'))

    return img.resize((W, H), Image.LANCZOS)


# ---------------- 路径 → 步骤文案 ----------------
def unit_dir(dx, dy):
    ux = 0 if abs(dx) < 0.5 else (1 if dx > 0 else -1)
    uy = 0 if abs(dy) < 0.5 else (1 if dy > 0 else -1)
    return ux, uy


def build_steps(points, px_per_m, start_label, end_label):
    steps = ['从%s出发' % start_label]
    heading = None
    for i in range(len(points) - 1):
        x1, y1 = points[i]
        x2, y2 = points[i + 1]
        dx, dy = x2 - x1, y2 - y1
        dist_m = math.hypot(dx, dy) / float(px_per_m)
        if dist_m < 0.75:
            continue
        ux, uy = unit_dir(dx, dy)
        if heading is None:
            turn = '直行'
        else:
            cross = heading[0] * uy - heading[1] * ux  # 屏幕 y 向下：cross>0 = 右转
            if cross > 0:
                turn = '向右转'
            elif cross < 0:
                turn = '向左转'
            else:
                turn = '继续直行'
        heading = (ux, uy)
        steps.append('%s，走约 %d 米' % (turn, max(1, int(round(dist_m)))))
    steps.append('到达%s' % end_label)
    return steps


def path_len(points):
    return sum(math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1])
               for i in range(len(points) - 1))


# ---------------- 自检 ----------------
def self_check(src, strict):
    W, H = src['canvas']['w'], src['canvas']['h']
    o = src['outer']
    zones = src['zones']
    problems = []

    def in_zone(pt, z, pad=0):
        return (z['x'] - pad <= pt[0] <= z['x'] + z['w'] + pad and
                z['y'] - pad <= pt[1] <= z['y'] + z['h'] + pad)

    for dest in src['destinations']:
        c = [dest['x'], dest['y']]
        if not any(in_zone(c, z, 1) for z in zones):
            problems.append('%s: 终点 (%d,%d) 不在任何房间内' % (dest['id'], c[0], c[1]))
        pts = dest['path']
        if len(pts) < 2:
            problems.append('%s: 路径点不足' % dest['id'])
        for p in pts:
            if not (o['x'] <= p[0] <= o['x'] + o['w'] and o['y'] <= p[1] <= o['y'] + o['h']):
                problems.append('%s: 路径点 (%d,%d) 超出建筑范围' % (dest['id'], p[0], p[1]))
        # 每段必须是正交（水平或垂直），否则导航线在斜线上会"穿墙"
        for i in range(len(pts) - 1):
            if abs(pts[i + 1][0] - pts[i][0]) > 1 and abs(pts[i + 1][1] - pts[i][1]) > 1:
                problems.append('%s: 第 %d 段是斜线（院内导航只走正交走廊）' % (dest['id'], i + 1))
        # 除首末两端，中间点必须落在"公共通行区"（走廊/大厅）
        passable = [z for z in zones if z['kind'] in ('corridor', 'hall')]
        for i in range(1, len(pts) - 1):
            if not any(in_zone(pts[i], z, 2) for z in passable):
                problems.append('%s: 第 %d 个拐点 (%d,%d) 不在走廊/大厅内' % (dest['id'], i, pts[i][0], pts[i][1]))

    if problems:
        print('自检发现 %d 个问题：' % len(problems))
        for p in problems:
            print('  - ' + p)
        if strict:
            return False
    else:
        print('自检通过：%d 个目的地路径全部正交且在通行区内' % len(src['destinations']))
    return True


# ---------------- 输出 JS ----------------
def pct(v, total):
    return round(v / float(total) * 100.0, 2)


def to_pct_path(points, W, H):
    return [[pct(p[0], W), pct(p[1], H)] for p in points]


def build_dests(src):
    """从 floorplan-src 派生目的地清单（百分比坐标 + 距离 + 步骤文案）。

    单一实现：前端 JS 与后端 JSON 共用本函数，保证两份派生数据永远同值（杜绝双份漂移）。
    """
    W, H = src['canvas']['w'], src['canvas']['h']
    pm = src['canvas']['pxPerMeter']
    org = src['origin']

    dests = []
    for d in src['destinations']:
        pts = d['path']
        steps = build_steps(pts, pm, org['name'], d['name'])
        steps_back = build_steps(list(reversed(pts)), pm, d['name'], org['name'])
        dests.append({
            'id': d['id'],
            'name': d['name'],
            'category': d['category'],
            'icon': d['icon'],
            'desc': d['desc'],
            'x': pct(d['x'], W),
            'y': pct(d['y'], H),
            'distanceM': int(round(path_len(pts) / float(pm))),
            'path': to_pct_path(pts, W, H),
            'steps': steps,
            'stepsBack': steps_back,
        })
    return dests


def write_js(src, dests):
    W, H = src['canvas']['w'], src['canvas']['h']
    pm = src['canvas']['pxPerMeter']
    org = src['origin']

    lines = []
    a = lines.append
    a('/**')
    a(' * indoor-map.js —— 院内导航数据（自动生成，请勿手改）')
    a(' *')
    a(' * 生成：python tools/build-floorplan.py')
    a(' * 数据源：tools/floorplan-src.json（唯一真源：底图与路径坐标同源，改坐标只改那里）')
    a(' *')
    a(' * 坐标说明：x/y 均为**百分比**（相对底图宽高），页面用百分比定位 markers、')
    a(' *          用 baseW/baseH × scale 换算 canvas 像素，缩放时不会错位。')
    a(' */')
    a('module.exports = {')
    a('  FLOOR: %s,' % json.dumps({
        'name': src['floor']['name'],
        'image': src['floor']['image'],
        'baseW': W,
        'baseH': H,
        'pxPerMeter': pm,
        'scaleNote': src['floor']['scaleNote'],
    }, ensure_ascii=False, indent=4).replace('\n', '\n  '))
    a('')
    a('  ORIGIN: %s,' % json.dumps({
        'id': org['id'], 'name': org['name'],
        'x': pct(org['x'], W), 'y': pct(org['y'], H), 'icon': org['icon'],
    }, ensure_ascii=False, indent=4).replace('\n', '\n  '))
    a('')
    a('  CATEGORIES: %s,' % json.dumps(src['categories'], ensure_ascii=False))
    a('')
    a('  DESTINATIONS: [')
    for d in dests:
        a('    %s,' % json.dumps(d, ensure_ascii=False, indent=6).replace('\n', '\n    '))
    a('  ]')
    a('}')
    a('')

    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    with open(OUT_JS, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))
    return len(dests)


def write_json(src, dests):
    """后端 IndoorMapService classpath 数据源（与前端 JS 同源派生）。

    结构与 IndoorMapService 解析对齐：根节点 FLOOR / ORIGIN / CATEGORIES / DESTINATIONS。
    """
    W, H = src['canvas']['w'], src['canvas']['h']
    pm = src['canvas']['pxPerMeter']
    org = src['origin']
    payload = {
        'FLOOR': {
            'name': src['floor']['name'],
            'image': src['floor']['image'],
            'baseW': W,
            'baseH': H,
            'pxPerMeter': pm,
            'scaleNote': src['floor']['scaleNote'],
        },
        'ORIGIN': {
            'id': org['id'], 'name': org['name'],
            'x': pct(org['x'], W), 'y': pct(org['y'], H), 'icon': org['icon'],
        },
        'CATEGORIES': src['categories'],
        'DESTINATIONS': dests,
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write('\n')
    return len(dests)


def main():
    check_only = '--check' in sys.argv
    with open(SRC, 'r', encoding='utf-8') as f:
        src = json.load(f)

    ok = self_check(src, strict=check_only)
    if check_only:
        sys.exit(0 if ok else 1)

    if not check_only:
        img = render(src)
        os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
        img.save(OUT_PNG, 'PNG', optimize=True)
        dests = build_dests(src)
        n = write_js(src, dests)
        m = write_json(src, dests)
        print('底图 → %s （%d×%d，%.1f KB）' % (
            os.path.relpath(OUT_PNG, ROOT), img.width, img.height,
            os.path.getsize(OUT_PNG) / 1024.0))
        print('前端数据 → %s （%d 个目的地）' % (os.path.relpath(OUT_JS, ROOT), n))
        print('后端数据 → %s （%d 个目的地）' % (os.path.relpath(OUT_JSON, ROOT), m))


if __name__ == '__main__':
    main()
