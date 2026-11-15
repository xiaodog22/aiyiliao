#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成健康档案「系统推送资料」演示图片（2026-11-15）

做法（按需求：变形网页代码并截取网页）：
  1. 用 HTML/CSS 排版两张院内报告单（血常规检验报告、血压动态监测报告）；
  2. 调用本机 Edge 无头模式截图（--headless=new --screenshot）；
  3. 用 Pillow 缩放并转 JPEG（quality 可调，默认 52），控制单图 ≤ 24KB。

⚠️ 体积口径（2026-11-15 微信「代码质量」要求图片+音频 ≤200K）：
   两张图**不放进小程序包**，改由后端资源库下发（resource_asset + GET /api/v1/resources/{key}），
   前端只按 key 拼地址。生成时控制在 ≤24KB/张，减少患者流量。

产物：backend/deploy/resources/health/report-blood-routine.jpg  → key: health.report-blood-routine
      backend/deploy/resources/health/report-blood-pressure.jpg → key: health.report-blood-pressure

用法：python tools/gen-health-push-images.py
      # 调参：HP_OUT_W / HP_OUT_H / HP_QUALITY / HP_MAX_KB
依赖：本机 Edge + Pillow（不引入 npm 依赖）。

⚠️ 重新生成后必须同步 DB 的 file_size / sha256（新增迁移 UPDATE，见 V30）。
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'backend', 'deploy', 'resources', 'health')

PAGE_W, PAGE_H = 420, 560       # 3:4 竖版报告单（按最终像素设计，1:1 输出）
SCALE = int(os.environ.get('HP_SCALE', 2))       # 截图 2 倍后再缩小，文字边缘更干净
OUT_W, OUT_H = int(os.environ.get('HP_OUT_W', 420)), int(os.environ.get('HP_OUT_H', 560))
QUALITY = int(os.environ.get('HP_QUALITY', 52))
MAX_BYTES = int(os.environ.get('HP_MAX_KB', 24)) * 1024

EDGE_CANDIDATES = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
]

BASE_CSS = """
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: %(w)dpx; height: %(h)dpx; overflow: hidden;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
  background: #eef1f5; color: #1f2430;
  display: flex; align-items: center; justify-content: center;
}
.paper {
  width: 396px; padding: 14px 16px 12px;
  background: #ffffff; border-radius: 5px;
  box-shadow: 0 1px 6px rgba(31, 36, 48, .10);
}
.head { display: flex; align-items: center; border-bottom: 1.5px solid #0b6ef8; padding-bottom: 7px; }
.logo {
  width: 28px; height: 28px; border-radius: 7px; background: #0b6ef8;
  color: #fff; font-size: 15px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.hospital { margin-left: 8px; }
.hospital .name { font-size: 14px; font-weight: 700; letter-spacing: .5px; }
.hospital .sub { margin-top: 2px; font-size: 8px; color: #7a8291; }
.doc-title {
  margin-top: 8px; text-align: center;
  font-size: 15px; font-weight: 700; letter-spacing: 2px;
}
.meta {
  display: flex; flex-wrap: wrap; margin-top: 6px;
  font-size: 9.5px; color: #4a5260; line-height: 1.7;
}
.meta span { width: 50%%; }
.meta b { color: #1f2430; font-weight: 600; }
table { width: 100%%; margin-top: 7px; border-collapse: collapse; font-size: 9.5px; }
th, td { border: .5px solid #d8dde6; padding: 3px 5px; text-align: left; }
th { background: #f3f6fb; color: #4a5260; font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.abn td { color: #d4380d; font-weight: 600; }
.sec-title { margin-top: 8px; font-size: 10px; font-weight: 700; color: #0b6ef8; }
.conclusion {
  margin-top: 5px; padding: 6px 8px; border-radius: 4px;
  background: #f3f7ff; border-left: 3px solid #0b6ef8;
  font-size: 9.5px; line-height: 1.65; color: #2a3140;
}
.foot {
  margin-top: 8px; padding-top: 6px; border-top: 1px dashed #d8dde6;
  display: flex; justify-content: space-between;
  font-size: 8px; color: #8a92a1;
}
.bp-grid { display: flex; gap: 8px; margin-top: 7px; }
.bp-card {
  flex: 1; padding: 6px 8px; border-radius: 5px; background: #f3f7ff;
}
.bp-card .k { font-size: 8.5px; color: #6b7484; }
.bp-card .v { margin-top: 2px; font-size: 15px; font-weight: 700; color: #0b6ef8; }
.bp-card .u { font-size: 8.5px; color: #6b7484; font-weight: 400; }
.chart { margin-top: 6px; }
.chart svg { display: block; width: 100%%; height: auto; }
.legend { margin-top: 3px; font-size: 8px; color: #7a8291; }
"""


def table_html(rows, widths):
    trs = ''
    for name, val, ref, unit, abn in rows:
        cls = ' class="abn"' if abn else ''
        trs += (
            '<tr%s><td>%s</td><td class="num">%s</td><td class="num">%s</td><td>%s</td></tr>'
            % (cls, name, val, ref, unit)
        )
    ths = ''.join('<th style="width:%s">%s</th>' % (w, t)
                  for w, t in zip(widths, ('项目', '结果', '参考', '单位')))
    return ('<table><thead><tr>' + ths + '</tr></thead><tbody>' + trs + '</tbody></table>')


def blood_routine_html():
    # 只保留报告单核心指标（整页缩印会让 10px 的字糊成一团）
    rows = [
        ('白细胞计数 WBC', '6.21', '3.5 - 9.5', '10^9/L', False),
        ('血红蛋白 HGB', '138', '130 - 175', 'g/L', False),
        ('血小板计数 PLT', '187', '125 - 350', '10^9/L', False),
        ('中性粒细胞比率', '82.4', '40 - 75', '%', True),
        ('淋巴细胞比率', '12.1', '20 - 50', '%', True),
        ('C 反应蛋白 CRP', '12.6', '0 - 10', 'mg/L', True),
    ]
    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
        + (BASE_CSS % {'w': PAGE_W, 'h': PAGE_H})
        + '</style></head><body><div class="paper">'
        '<div class="head"><div class="logo">康</div><div class="hospital">'
        '<div class="name">康诊云互联网医院 · 检验科</div>'
        '<div class="sub">Kangzhenyun Internet Hospital · Clinical Laboratory</div>'
        '</div></div>'
        '<div class="doc-title">血 常 规 检 验 报 告 单</div>'
        '<div class="meta">'
        '<span>姓名：<b>张建国</b></span><span>性别：<b>男</b>　年龄：<b>65 岁</b></span>'
        '<span>科室：<b>呼吸内科</b></span><span>样本：<b>静脉血（EDTA 抗凝）</b></span>'
        '<span>送检医生：<b>李副主任医师</b></span><span>报告时间：<b>2026-07-15 10:26</b></span>'
        '</div>'
        + table_html(rows, ('38%', '20%', '24%', ''))
        + '<div class="sec-title">检验结论</div>'
        '<div class="conclusion">'
        '1. 白细胞、血红蛋白、血小板均在参考区间内；<br>'
        '2. 中性粒细胞比率偏高（82.4%）、淋巴细胞比率偏低，结合 CRP 12.6 mg/L，'
        '提示轻度细菌感染表现；<br>'
        '3. 建议结合咳嗽、咳痰等症状由接诊医生综合判断，必要时复查。'
        '</div>'
        '<div class="foot"><span>检验者：王技师　审核者：赵主管技师</span>'
        '<span>本报告仅对本次样本负责 · 系统推送</span></div>'
        '</div></body></html>'
    )


def blood_pressure_html():
    # 24 小时收缩压/舒张压折线（6 个采样点，SVG 手写坐标）
    hours = ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00']
    sys_vals = [118, 112, 152, 146, 138, 128]
    dia_vals = [72, 68, 94, 90, 86, 80]
    left, top, w, h = 26, 8, 350, 62
    step = w / (len(hours) - 1)

    def pts(vals):
        out = []
        for i, v in enumerate(vals):
            x = left + i * step
            y = top + h - (v - 60) / (170 - 60) * h
            out.append('%.1f,%.1f' % (x, y))
        return ' '.join(out)

    grid = ''
    for gv in (80, 110, 140, 170):
        gy = top + h - (gv - 60) / (170 - 60) * h
        grid += (
            '<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="#e3e8f0" stroke-width="1"/>'
            '<text x="%d" y="%.1f" font-size="6" fill="#8a92a1" text-anchor="end">%d</text>'
            % (left, gy, left + w, gy, left - 4, gy + 2, gv)
        )
    labels = ''
    for i, hr in enumerate(hours):
        labels += (
            '<text x="%.1f" y="%d" font-size="6" fill="#8a92a1" text-anchor="middle">%s</text>'
            % (left + i * step, top + h + 9, hr)
        )

    rows = [
        ('24 小时平均血压', '132 / 82', '130 / 80', 'mmHg', True),
        ('白天平均血压', '139 / 87', '135 / 85', 'mmHg', True),
        ('清晨血压峰值', '152 / 94', '135 / 85', 'mmHg', True),
        ('收缩压负荷', '38', '< 20', '%', True),
        ('夜间血压下降率', '18.7', '10 - 20', '%', False),
    ]

    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
        + (BASE_CSS % {'w': PAGE_W, 'h': PAGE_H})
        + '</style></head><body><div class="paper">'
        '<div class="head"><div class="logo">康</div><div class="hospital">'
        '<div class="name">康诊云互联网医院 · 心血管内科</div>'
        '<div class="sub">Kangzhenyun Internet Hospital · Cardiology</div>'
        '</div></div>'
        '<div class="doc-title">血 压 动 态 监 测 报 告</div>'
        '<div class="meta">'
        '<span>姓名：<b>张建国</b></span><span>性别：<b>男</b>　年龄：<b>65 岁</b></span>'
        '<span>监测时段：<b>2026-07-14 08:00 起 24 小时</b></span>'
        '<span>有效读数：<b>42 / 44 次</b></span>'
        '</div>'
        '<div class="bp-grid">'
        '<div class="bp-card"><div class="k">24 小时平均</div>'
        '<div class="v">132/82 <span class="u">mmHg</span></div></div>'
        '<div class="bp-card"><div class="k">白天平均</div>'
        '<div class="v">139/87 <span class="u">mmHg</span></div></div>'
        '<div class="bp-card"><div class="k">夜间平均</div>'
        '<div class="v">113/69 <span class="u">mmHg</span></div></div>'
        '</div>'
        '<div class="chart"><svg viewBox="0 0 392 86">'
        + grid
        + '<polyline points="' + pts(sys_vals) + '" fill="none" stroke="#d4380d" stroke-width="1.6"/>'
        + '<polyline points="' + pts(dia_vals) + '" fill="none" stroke="#0b6ef8" stroke-width="1.6"/>'
        + labels
        + '</svg></div>'
        '<div class="legend">— 收缩压（mmHg）　— 舒张压（mmHg）</div>'
        + table_html(rows, ('40%', '24%', '22%', ''))
        + '<div class="sec-title">监测结论</div>'
        '<div class="conclusion">'
        '1. 24 小时平均 132/82 mmHg、白天平均 139/87 mmHg，高于参考值；<br>'
        '2. 清晨峰值 152/94 mmHg、收缩压负荷 38%，提示清晨血压控制不佳；<br>'
        '3. 夜间下降率 18.7%，昼夜节律存在；建议调整服药时间并复诊随访。'
        '</div>'
        '<div class="foot"><span>分析者：陈技师　审核者：王主任医师</span>'
        '<span>本报告仅对本次监测负责 · 系统推送</span></div>'
        '</div></body></html>'
    )


def find_edge():
    for p in EDGE_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit('未找到 msedge.exe，请先安装 Microsoft Edge 或手动补充路径')


def shoot(edge, html, png_path, workdir):
    html_path = os.path.join(workdir, os.path.basename(png_path) + '.html')
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    uri = 'file:///' + html_path.replace('\\', '/')
    cmd = [
        edge,
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=%d' % SCALE,
        '--window-size=%d,%d' % (PAGE_W, PAGE_H),
        '--user-data-dir=' + os.path.join(workdir, 'edge-profile'),
        '--screenshot=' + png_path,
        uri,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not os.path.exists(png_path):
        raise SystemExit('Edge 截图失败：' + png_path)


def to_jpeg(png_path, jpg_path):
    img = Image.open(png_path).convert('RGB').resize((OUT_W, OUT_H), Image.LANCZOS)
    q = QUALITY
    while q >= 34:
        img.save(jpg_path, 'JPEG', quality=q, optimize=True, progressive=True)
        size = os.path.getsize(jpg_path)
        if size <= MAX_BYTES:
            print('  %-22s %6.1f KB (quality=%d)' % (os.path.basename(jpg_path), size / 1024.0, q))
            return
        q -= 6
    print('  %-22s %6.1f KB（已到最低质量仍超限）' % (os.path.basename(jpg_path), size / 1024.0))


def main():
    edge = find_edge()
    os.makedirs(OUT_DIR, exist_ok=True)
    workdir = tempfile.mkdtemp(prefix='health_push_')
    jobs = [
        ('report-blood-routine', blood_routine_html()),
        ('report-blood-pressure', blood_pressure_html()),
    ]
    print('Edge:', edge)
    print('输出:', OUT_DIR)
    try:
        for name, html in jobs:
            png_path = os.path.join(workdir, name + '.png')
            shoot(edge, html, png_path, workdir)
            to_jpeg(png_path, os.path.join(OUT_DIR, name + '.jpg'))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    print('完成：共 %d 张' % len(jobs))


if __name__ == '__main__':
    sys.exit(main())
