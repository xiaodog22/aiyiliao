#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
md2docx.py —— 把交付 Markdown 转成排版规整的 DOCX（无 pandoc 环境的替代方案）

支持子集：H1–H4 / 段落（**粗体**、`行内代码`）/ 无序·有序列表 / 管道表格 /
引用块 / 围栏代码块 / 分割线 / 图片（存在才插）。

用法：
  python 设计交付_20261128/06_验证记录/md2docx.py <in.md> [out.docx] [--pdf]

--pdf 会尝试用本机 Word（win32com）导出同名 PDF；无 Word 则跳过并提示。
"""

import os
import re
import sys

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BODY_FONT_CN = "宋体"
BODY_FONT_EN = "Times New Roman"
HEAD_FONT_CN = "黑体"
CODE_FONT = "Consolas"
ACCENT = RGBColor(0x5F, 0x78, 0xC4)   # 与小程序主色一致的标题装饰色
INK = RGBColor(0x28, 0x32, 0x4F)


# ---------------------------------------------------------------- 基础工具
def set_run_font(run, cn=BODY_FONT_CN, en=BODY_FONT_EN, size=None,
                 bold=None, color=None):
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color
    run.font.name = en
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), en)
    rfonts.set(qn("w:hAnsi"), en)
    rfonts.set(qn("w:eastAsia"), cn)


def shade(cell, hex_color):
    tcpr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    tcpr.append(shd)


def add_field(paragraph, instr):
    run = paragraph.add_run()
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr_el = OxmlElement("w:instrText")
    instr_el.set(qn("xml:space"), "preserve")
    instr_el.text = instr
    fld_sep = OxmlElement("w:fldChar")
    fld_sep.set(qn("w:fldCharType"), "separate")
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run._r.append(fld_begin)
    run._r.append(instr_el)
    run._r.append(fld_sep)
    run._r.append(fld_end)


def setup_document():
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    sec.top_margin = Cm(2.5)
    sec.bottom_margin = Cm(2.3)
    sec.left_margin = Cm(2.6)
    sec.right_margin = Cm(2.6)

    normal = doc.styles["Normal"]
    normal.font.name = BODY_FONT_EN
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = INK
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT_CN)
    pf = normal.paragraph_format
    pf.line_spacing = 1.5
    pf.space_before = Pt(0)
    pf.space_after = Pt(4)

    for name, size, before, after in (
        ("Heading 1", 18, 18, 10),
        ("Heading 2", 14.5, 14, 8),
        ("Heading 3", 12, 10, 6),
        ("Heading 4", 11, 8, 4),
    ):
        st = doc.styles[name]
        st.font.name = BODY_FONT_EN
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.color.rgb = INK if name != "Heading 1" else ACCENT
        st._element.rPr.rFonts.set(qn("w:eastAsia"), HEAD_FONT_CN)
        st.paragraph_format.space_before = Pt(before)
        st.paragraph_format.space_after = Pt(after)
        st.paragraph_format.keep_with_next = True
        st.paragraph_format.line_spacing = 1.3

    # 页脚页码
    footer = sec.footer
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_run_font(p.add_run("— "), size=9)
    add_field(p, " PAGE ")
    set_run_font(p.add_run(" —"), size=9)

    # 页眉
    header = sec.header
    hp = header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    set_run_font(hp.add_run("康诊云 · 患者端 AI 助手"), size=9,
                 color=RGBColor(0x8E, 0x98, 0xB4))
    return doc


INLINE = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`)")


def write_inline(paragraph, text, size=10.5, base_bold=False, cn=BODY_FONT_CN):
    """处理 **粗体** 与 `行内代码`。"""
    for chunk in INLINE.split(text):
        if not chunk:
            continue
        if chunk.startswith("**") and chunk.endswith("**") and len(chunk) > 4:
            r = paragraph.add_run(chunk[2:-2])
            set_run_font(r, cn=cn, size=size, bold=True)
        elif chunk.startswith("`") and chunk.endswith("`") and len(chunk) > 2:
            r = paragraph.add_run(chunk[1:-1])
            set_run_font(r, cn=cn, en=CODE_FONT, size=size - 1.0,
                         color=RGBColor(0x4C, 0x63, 0xA8))
        else:
            r = paragraph.add_run(chunk)
            set_run_font(r, cn=cn, size=size, bold=base_bold)


def is_table_sep(line):
    return bool(re.match(r"^\s*\|[\s:|-]+\|\s*$", line))


def split_row(line):
    cells = line.strip().strip("|").split("|")
    return [c.strip() for c in cells]


def add_table(doc, rows):
    cols = max(len(r) for r in rows)
    table = doc.add_table(rows=0, cols=cols)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True
    for i, row in enumerate(rows):
        cells = table.add_row().cells
        for j in range(cols):
            text = row[j] if j < len(row) else ""
            cell = cells[j]
            cell.text = ""
            p = cell.paragraphs[0]
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.line_spacing = 1.15
            if i == 0:
                write_inline(p, text, size=9, base_bold=True,
                             cn=HEAD_FONT_CN)
                shade(cell, "E2E9F9")
            else:
                write_inline(p, text, size=9)
    # 表后留白
    gap = doc.add_paragraph()
    gap.paragraph_format.space_after = Pt(2)
    return table


def add_code_block(doc, lines):
    for ln in lines:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.6)
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = 1.1
        r = p.add_run(ln if ln else " ")
        set_run_font(r, cn=BODY_FONT_CN, en=CODE_FONT, size=9,
                     color=RGBColor(0x33, 0x3D, 0x5C))
        shade_par(p, "F5F7FC")
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def shade_par(paragraph, hex_color):
    ppr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    ppr.append(shd)


def add_quote(doc, lines):
    for ln in lines:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.5)
        p.paragraph_format.space_after = Pt(2)
        write_inline(p, ln, size=10)
        for r in p.runs:
            r.font.color.rgb = RGBColor(0x5E, 0x6A, 0x8C)
        ppr = p._p.get_or_add_pPr()
        borders = OxmlElement("w:pBdr")
        left = OxmlElement("w:left")
        left.set(qn("w:val"), "single")
        left.set(qn("w:sz"), "18")
        left.set(qn("w:space"), "6")
        left.set(qn("w:color"), "8BA0DC")
        borders.append(left)
        ppr.append(borders)


def add_image(doc, path, alt):
    if not os.path.exists(path):
        p = doc.add_paragraph()
        write_inline(p, "[图缺] " + alt, size=9)
        return
    try:
        doc.add_picture(path, width=Cm(14))
        doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
        if alt:
            cap = doc.add_paragraph()
            cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
            write_inline(cap, alt, size=8.5)
            cap.runs[0].font.color.rgb = RGBColor(0x5E, 0x6A, 0x8C)
    except Exception as exc:  # pragma: no cover
        p = doc.add_paragraph()
        write_inline(p, f"[图片无法插入: {exc}]", size=9)


def build(md_path, out_path):
    text = open(md_path, encoding="utf-8").read()
    lines = text.split("\n")
    doc = setup_document()

    i = 0
    first_h1 = None
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # 围栏代码
        if stripped.startswith("```"):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i].rstrip())
                i += 1
            i += 1
            add_code_block(doc, buf)
            continue

        # 标题
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            content = m.group(2).strip().replace('**', '').replace('`', '')
            if level == 1 and first_h1 is None:
                first_h1 = content
                p = doc.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                p.paragraph_format.space_before = Pt(120)
                p.paragraph_format.space_after = Pt(6)
                r = p.add_run(content)
                set_run_font(r, cn=HEAD_FONT_CN, size=26, bold=True,
                             color=ACCENT)

                sub = doc.add_paragraph()
                sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
                r = sub.add_run("康诊云 · 患者端 AI 助手（微信小程序）")
                set_run_font(r, cn=BODY_FONT_CN, size=12,
                             color=RGBColor(0x5E, 0x6A, 0x8C))
                meta = doc.add_paragraph()
                meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
                meta.paragraph_format.space_before = Pt(4)
                r = meta.add_run("第十八届软件应用开发大赛 · 作品提交材料")
                set_run_font(r, cn=BODY_FONT_CN, size=10.5,
                             color=RGBColor(0x8E, 0x98, 0xB4))
                doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
                i += 1
                continue
            if level == 1:
                doc.add_page_break()
            doc.add_heading(content, level=level)
            i += 1
            continue

        # 表格
        if stripped.startswith("|") and i + 1 < len(lines) and is_table_sep(lines[i + 1]):
            rows = [split_row(stripped)]
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i].strip()))
                i += 1
            add_table(doc, rows)
            continue

        # 引用
        if stripped.startswith(">"):
            buf = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            add_quote(doc, [b for b in buf if b])
            continue

        # 图片
        im = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)\s*$", stripped)
        if im:
            add_image(doc, im.group(2), im.group(1))
            i += 1
            continue

        # 分割线
        if re.match(r"^-{3,}$", stripped) or re.match(r"^\*{3,}$", stripped):
            i += 1
            continue

        # 列表
        lm = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", line)
        if lm:
            indent = len(lm.group(1))
            ordered = lm.group(2)[0].isdigit()
            style = "List Number" if ordered else "List Bullet"
            p = doc.add_paragraph(style=style)
            p.paragraph_format.left_indent = Cm(0.75 + 0.6 * (indent // 2))
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.line_spacing = 1.45
            write_inline(p, lm.group(3))
            i += 1
            continue

        # 空行
        if not stripped:
            i += 1
            continue

        # 段落
        p = doc.add_paragraph()
        p.paragraph_format.first_line_indent = Cm(0)
        write_inline(p, stripped)
        i += 1

    doc.save(out_path)
    return out_path


def to_pdf(docx_path):
    try:
        import win32com.client  # noqa
    except Exception:
        print("!! 未安装 pywin32，无法导出 PDF")
        return None
    pdf_path = os.path.splitext(docx_path)[0] + ".pdf"
    word = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        d = word.Documents.Open(os.path.abspath(docx_path))
        # 更新目录与所有域
        try:
            for toc in d.TablesOfContents:
                toc.Update()
            d.Fields.Update()
        except Exception:
            pass
        d.Save()
        d.ExportAsFixedFormat(os.path.abspath(pdf_path), 17)  # 17 = wdExportFormatPDF
        d.Close(0)
        print("PDF:", pdf_path)
        return pdf_path
    except Exception as exc:
        print("!! PDF 导出失败（Word 不可用？）:", exc)
        return None
    finally:
        if word is not None:
            try:
                word.Quit()
            except Exception:
                pass


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") \
        else os.path.splitext(src)[0] + ".docx"
    build(src, dst)
    print("DOCX:", dst)
    if "--pdf" in sys.argv:
        to_pdf(dst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
