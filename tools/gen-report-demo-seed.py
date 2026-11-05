#!/usr/bin/env python3
"""生成 V9010 演示检查报告种子 SQL（幂等、只新增、不触碰原有账号与档案）。

数据来源：本文件内的模拟教科书式数值 + 项目自带的演示声明；
不读取真实患者信息，不冒充任何真实医疗机构出具的报告。
用法：python tools/gen-report-demo-seed.py
输出：backend/business-service/src/main/resources/db/dev/V9010__health_report_demo_seed.sql
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = (ROOT / "backend/business-service/src/main/resources/db/dev/"
       "V9010__health_report_demo_seed.sql")

NOTICE = "演示数据 · 非真实医疗报告 · 不构成诊断依据"


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def insert(table, cols, values, pk="id"):
    return ("INSERT INTO %s (%s) VALUES (%s)\n"
            "  ON DUPLICATE KEY UPDATE %s = %s;" %
            (table, ", ".join(cols), ", ".join(q(v) for v in values), pk, pk))


L = []
a = L.append

a("-- =====================================================================")
a("-- V9010__health_report_demo_seed.sql —— 电子检查报告演示数据（2026-11-05）")
a("-- ⚠️ 仅 dev profile 加载（classpath:db/dev），不进入生产迁移。")
a("-- ⚠️ 全部为开发环境模拟数据：模拟机构、模拟患者、模拟医生、模拟数值，")
a("--    不含真实患者身份、真实医生签名、医院公章或官方报告二维码。")
a("-- ⚠️ 不修改 / 不删除任何原有账号（u-dev-user-1/2/3、u-dev-user-fresh-9）")
a("--    与原有 7 条健康档案；所有 ID 使用独立 v9010- 前缀。")
a("-- 幂等：固定主键 + ON DUPLICATE KEY UPDATE pk = pk（no-op），可重复执行。")
a("-- 生成器：tools/gen-report-demo-seed.py（重新生成后勿改已应用文件的 checksum）。")
a("-- 前置：V27__health_report_structure.sql 已建新表与复合外键。")
a("-- =====================================================================")
a("")

# ---------------- 1. 演示机构（独立，不替换现有 hospital_name / hospital） ----------------
a("-- ---------- 1. 演示医疗机构目录 ----------")
INST = [
    ("mi-v9010-lab-01", "DEMO-LAB-01", "演示医学检验中心（模拟）", "LAB", None),
    ("mi-v9010-img-01", "DEMO-IMG-01", "演示影像诊断中心（模拟）", "IMAGING", None),
    ("mi-v9010-check-01", "DEMO-CHECKUP-01", "演示健康体检中心（模拟）", "CHECKUP", None),
]
for i, code, name, typ, level in INST:
    a(insert("medical_institutions",
             ["id", "institution_code", "institution_name", "institution_type",
              "hospital_level", "address", "telephone", "status", "is_demo"],
             [i, code, name, typ, level, "演示环境（无真实地址）", None, "ACTIVE", 1]))
a("")

# ---------------- 2. 三个独立演示患者 ----------------
a("-- ---------- 2. 演示患者账号（openid 为 dev 前缀，非真实微信凭证） ----------")
USERS = [
    ("u-v9010-patient-a", "dev-v9010-patient-a", "演示患者甲", "MALE", "1981-06-15", 45, 172.0, 70.5),
    ("u-v9010-patient-b", "dev-v9010-patient-b", "演示患者乙", "FEMALE", "1988-03-22", 38, 162.0, 56.0),
    ("u-v9010-patient-c", "dev-v9010-patient-c", "演示患者丙", "MALE", "1964-09-08", 62, 170.0, 74.0),
]
for uid, openid, name, sex, birth, age, height, weight in USERS:
    a(insert("users",
             ["id", "wechat_openid", "phone_cipher", "phone_hash", "phone_bound",
              "display_name", "status", "version", "created_at"],
             [uid, openid, None, None, 0, name, "ACTIVE", 1, "2026-11-05 00:00:00.000"]))
    a(insert("user_profiles",
             ["id", "user_id", "birth_date", "sex", "height_cm", "weight_kg",
              "allergies", "chronic_conditions", "version"],
             ["up-" + uid, uid, birth, sex, height, weight,
              "演示数据：无已知药物过敏" if uid != "u-v9010-patient-a" else "演示数据：青霉素类过敏（模拟）",
              None, 1]))
    a(insert("user_preferences",
             ["user_id", "locale", "theme_mode", "font_scale", "tts_rate",
              "tts_auto_play", "version"],
             [uid, "zh-CN", "SYSTEM", "STANDARD", 1.0, 0, 1], pk="user_id"))
a("")

# ---------------- 3. 演示家属（验证复合外键 + 家庭成员切换） ----------------
a("-- ---------- 3. 演示家属（用户 A） ----------")
a(insert("family_members",
         ["id", "user_id", "display_name", "relation", "proxy_status", "gender",
          "age_band", "created_at"],
         ["fm-v9010-patient-a-child", "u-v9010-patient-a", "演示家属小甲", "CHILD",
          "NONE", "MALE", "CHILD", "2026-11-05 00:00:00.000"]))
a("")

# ---------------- 4. 报告定义 ----------------
def item(name, value=None, text=None, unit=None, low=None, high=None,
         ref=None, flag="NORMAL", method=None, remark=None):
    return dict(name=name, value=value, text=text, unit=unit, low=low, high=high,
                ref=ref, flag=flag, method=method, remark=remark)


REPORTS = [
    dict(key="a-cbc", user="u-v9010-patient-a", status="READY", rtype="LAB",
         no="DEMO-20261020-001", inst="mi-v9010-lab-01", dept="检验科",
         title="血常规检验报告（演示）", recorded="2026-10-20 10:05:00.000",
         collected="2026-10-20 07:20:00.000", received="2026-10-20 07:48:00.000",
         tested="2026-10-20 09:10:00.000", reported="2026-10-20 10:05:00.000",
         specimen="静脉血", abnormal=0,
         conclusion="本次模拟血常规各项指标均在参考范围内。" + NOTICE,
         sections=[("CBC", "血常规", [
             item("白细胞计数", 6.20, unit="×10⁹/L", low=3.5, high=9.5, ref="3.5–9.5", method="电阻抗法"),
             item("红细胞计数", 4.82, unit="×10¹²/L", low=4.3, high=5.8, ref="4.3–5.8"),
             item("血红蛋白", 145, unit="g/L", low=130, high=175, ref="130–175"),
             item("血小板计数", 230, unit="×10⁹/L", low=125, high=350, ref="125–350"),
             item("中性粒细胞百分比", 63.5, unit="%", low=40, high=75, ref="40–75"),
             item("淋巴细胞百分比", 28.0, unit="%", low=20, high=50, ref="20–50"),
         ])]),
    dict(key="a-liver", user="u-v9010-patient-a", status="READY", rtype="LAB",
         no="DEMO-20261022-002", inst="mi-v9010-lab-01", dept="检验科",
         title="肝肾功能检验报告（演示）", recorded="2026-10-22 11:20:00.000",
         collected="2026-10-22 07:40:00.000", received="2026-10-22 08:05:00.000",
         tested="2026-10-22 10:15:00.000", reported="2026-10-22 11:20:00.000",
         specimen="静脉血", abnormal=1,
         conclusion="模拟结果提示尿酸轻度偏高、总胆固醇轻度偏高，建议结合临床复查。" + NOTICE,
         sections=[("LIVER", "肝功能", [
             item("丙氨酸氨基转移酶", 46, unit="U/L", low=9, high=50, ref="9–50", method="速率法"),
             item("天门冬氨酸氨基转移酶", 28, unit="U/L", low=15, high=40, ref="15–40"),
             item("总胆红素", 18.2, unit="μmol/L", low=3.4, high=20.5, ref="3.4–20.5"),
             item("白蛋白", 42, unit="g/L", low=40, high=55, ref="40–55"),
         ]), ("KIDNEY", "肾功能", [
             item("肌酐", 88, unit="μmol/L", low=57, high=97, ref="57–97"),
             item("尿素", 5.4, unit="mmol/L", low=3.1, high=8.0, ref="3.1–8.0"),
             item("尿酸", 452, unit="μmol/L", low=208, high=428, ref="208–428", flag="HIGH"),
         ]), ("LIPID", "血脂", [
             item("总胆固醇", 5.9, unit="mmol/L", low=0, high=5.2, ref="<5.2", flag="HIGH"),
         ])]),
    dict(key="a-us", user="u-v9010-patient-a", status="READY", rtype="IMAGING",
         no="DEMO-20261025-003", inst="mi-v9010-img-01", dept="超声科",
         title="腹部超声检查报告（演示）", recorded="2026-10-25 15:30:00.000",
         collected="2026-10-25 14:50:00.000", received="2026-10-25 14:55:00.000",
         tested="2026-10-25 15:10:00.000", reported="2026-10-25 15:30:00.000",
         specimen=None, abnormal=1,
         findings="肝大小形态正常，实质回声稍增强，肝内管道结构显示清晰；胆囊壁光滑，未见结石；胰、脾、双肾未见明显异常（模拟描述）。",
         impression="轻度脂肪肝声像（模拟印象），建议随访。",
         conclusion="模拟影像所见与诊断意见仅供界面演示。" + NOTICE,
         sections=[("US_FINDINGS", "检查所见", [
             item("肝实质回声", text="稍增强，考虑轻度脂肪肝（模拟描述）", flag="ABNORMAL"),
             item("胆囊", text="壁光滑，未见结石（模拟描述）", flag="NORMAL"),
         ])]),
    dict(key="b-urine", user="u-v9010-patient-b", status="READY", rtype="LAB",
         no="DEMO-20261028-004", inst="mi-v9010-lab-01", dept="检验科",
         title="尿常规检验报告（演示）", recorded="2026-10-28 09:40:00.000",
         collected="2026-10-28 08:00:00.000", received="2026-10-28 08:20:00.000",
         tested="2026-10-28 09:00:00.000", reported="2026-10-28 09:40:00.000",
         specimen="中段尿", abnormal=0,
         conclusion="模拟尿常规各项未见明显异常。" + NOTICE,
         sections=[("URINE", "尿常规", [
             item("尿蛋白", text="阴性", flag="NEGATIVE"),
             item("尿糖", text="阴性", flag="NEGATIVE"),
             item("尿白细胞", 3.0, unit="/μL", low=0, high=12, ref="0–12"),
             item("尿红细胞", 1.0, unit="/μL", low=0, high=5, ref="0–5"),
             item("尿比重", 1.020, low=1.005, high=1.030, ref="1.005–1.030"),
             item("尿酸碱度", 6.5, low=4.6, high=8.0, ref="4.6–8.0"),
         ])]),
    dict(key="b-checkup", user="u-v9010-patient-b", status="READY", rtype="CHECKUP",
         no="DEMO-20261101-005", inst="mi-v9010-check-01", dept="体检科",
         title="年度健康体检报告（演示）", recorded="2026-11-01 16:00:00.000",
         collected="2026-11-01 08:30:00.000", received="2026-11-01 08:40:00.000",
         tested="2026-11-01 10:30:00.000", reported="2026-11-01 16:00:00.000",
         specimen=None, abnormal=1,
         conclusion="模拟体检提示低密度脂蛋白轻度偏高，建议生活方式干预后复查。" + NOTICE,
         sections=[("VITAL", "体格检查", [
             item("收缩压", 128, unit="mmHg", low=90, high=139, ref="90–139"),
             item("舒张压", 82, unit="mmHg", low=60, high=89, ref="60–89"),
             item("体质指数", 23.4, unit="kg/m²", low=18.5, high=23.9, ref="18.5–23.9"),
         ]), ("LIPID", "血脂", [
             item("总胆固醇", 5.1, unit="mmol/L", low=0, high=5.2, ref="<5.2"),
             item("低密度脂蛋白胆固醇", 3.5, unit="mmol/L", low=0, high=3.4, ref="<3.4", flag="HIGH"),
         ])]),
    dict(key="c-ecg", user="u-v9010-patient-c", status="REVIEWING", rtype="ECG",
         no="DEMO-20261103-006", inst="mi-v9010-img-01", dept="心电诊断科",
         title="心电图检查报告（演示·待审核）", recorded="2026-11-03 10:00:00.000",
         collected="2026-11-03 09:10:00.000", received="2026-11-03 09:20:00.000",
         tested="2026-11-03 09:30:00.000", reported=None,
         specimen=None, abnormal=None, no_items=True,
         conclusion=None,
         sections=[]),
    dict(key="c-imaging", user="u-v9010-patient-c", status="PENDING", rtype="IMAGING",
         no="DEMO-20261104-007", inst="mi-v9010-img-01", dept="影像科",
         title="胸部影像检查报告（演示·待出结果）", recorded="2026-11-04 09:00:00.000",
         collected="2026-11-04 08:20:00.000", received="2026-11-04 08:35:00.000",
         tested=None, reported=None,
         specimen=None, abnormal=None, no_items=True,
         conclusion=None,
         sections=[]),
]

a("-- ---------- 4. 报告主记录（health_records，保留原表结构） ----------")
for r in REPORTS:
    rid = "hr-v9010-" + r["key"]
    inst_name = next(x[2] for x in INST if x[0] == r["inst"])
    a(insert("health_records",
             ["id", "user_id", "family_member_id", "category", "title", "summary",
              "recorded_at", "source", "doctor_name", "abnormal", "report_status",
              "hospital", "version", "idempotency_key", "request_digest", "created_at"],
             [rid, r["user"], None, "EXAM", r["title"],
              "演示报告摘要：" + r["title"] + "。" + NOTICE,
              r["recorded"], "DEMO_SEED_V9010", "演示医师（模拟）", r["abnormal"],
              r["status"], inst_name, 1, None, None, r["recorded"]]))
a("")

a("-- ---------- 5. 报告详情（REVIEWING/PENDING 不生成项目明细，避免未审核结果落库） ----------")
for r in REPORTS:
    rid = "hr-v9010-" + r["key"]
    did = "hrd-v9010-" + r["key"]
    a(insert("health_report_details",
             ["id", "record_id", "user_id", "report_no", "report_type", "institution_id",
              "department_id", "department_name_snapshot", "patient_name_snapshot",
              "patient_sex_snapshot", "patient_age_snapshot", "outpatient_no",
              "inpatient_no", "clinical_diagnosis", "applicant_doctor", "specimen_type",
              "specimen_no", "collection_at", "received_at", "tested_at", "reported_at",
              "operator_name", "reviewer_name", "inspection_method", "instrument_model",
              "findings_text", "impression_text", "conclusion_text", "recommendation_text",
              "data_origin", "external_report_id", "is_demo", "demo_notice", "version"],
             [did, rid, r["user"], r["no"], r["rtype"], r["inst"], None,
              r["dept"], next(u[2] for u in USERS if u[0] == r["user"]),
              "MALE" if r["user"].endswith(("-a", "-c")) else "FEMALE",
              "45岁" if r["user"].endswith("-a") else ("38岁" if r["user"].endswith("-b") else "62岁"),
              "DEMO-OP-" + r["key"], None,
              "演示：健康体检/随访（模拟）", "演示申请医师（模拟）",
              r["specimen"], "DEMO-SP-" + r["key"],
              r["collected"], r["received"], r["tested"], r["reported"],
              "演示检验员（模拟）", "演示审核员（模拟）",
              "模拟方法学（非真实检测）", "演示设备（模拟）",
              r.get("findings"), r.get("impression"), r.get("conclusion"),
              NOTICE if r["status"] == "READY" else None,
              "DEMO", None, 1, NOTICE, 1]))
a("")

a("-- ---------- 6. 报告分组与检查项目 ----------")
for r in REPORTS:
    did = "hrd-v9010-" + r["key"]
    for si, (code, name, items) in enumerate(r["sections"], 1):
        sid = "hrs-v9010-%s-%d" % (r["key"], si)
        a(insert("health_report_sections",
                 ["id", "report_detail_id", "user_id", "section_code",
                  "section_name", "sort_order"],
                 [sid, did, r["user"], code, name, si * 10]))
        for ii, it in enumerate(items, 1):
            a(insert("health_report_items",
                     ["id", "report_detail_id", "section_id", "user_id", "item_code",
                      "item_name", "result_value", "result_text", "unit",
                      "reference_low", "reference_high", "reference_text",
                      "abnormal_flag", "inspection_method", "remark", "sort_order"],
                     ["hri-v9010-%s-%d-%d" % (r["key"], si, ii), did, sid, r["user"],
                      "DEMO-%s-%d-%d" % (code, si, ii), it["name"], it["value"],
                      it["text"], it["unit"], it["low"], it["high"], it["ref"],
                      it["flag"], it["method"], it["remark"], ii * 10]))
a("")

# ---------------- 7. 非报告类健康档案（report_status = NULL） ----------------
a("-- ---------- 7. 非报告类健康档案：不标 READY（契约 NULL = 非报告类） ----------")
OTHER = [
    ("hr-v9010-a-vitals", "u-v9010-patient-a", "fm-v9010-patient-a-child", "VITALS",
     "家属血压记录（演示）", "演示家属小甲 血压 118/76 mmHg，自测记录。", "2026-10-18 08:00:00.000"),
    ("hr-v9010-a-allergy", "u-v9010-patient-a", None, "ALLERGY",
     "药物过敏史（演示）", "演示数据：青霉素类过敏（模拟，非真实病历）。", "2026-10-15 09:00:00.000"),
    ("hr-v9010-b-vitals", "u-v9010-patient-b", None, "VITALS",
     "体重记录（演示）", "体重 56.0 kg，居家自测。", "2026-10-26 07:30:00.000"),
    ("hr-v9010-b-medication", "u-v9010-patient-b", None, "MEDICATION",
     "用药记录（演示）", "演示数据：维生素 D 滴剂（模拟条目）。", "2026-10-27 20:00:00.000"),
    ("hr-v9010-c-vitals", "u-v9010-patient-c", None, "VITALS",
     "空腹血糖自测（演示）", "空腹血糖 6.1 mmol/L，居家自测（模拟）。", "2026-11-02 07:10:00.000"),
    ("hr-v9010-c-history", "u-v9010-patient-c", None, "HISTORY",
     "既往病史（演示）", "演示数据：高血压病史 5 年（模拟，非真实病历）。", "2026-10-30 10:00:00.000"),
]
for rid, uid, fmid, cat, title, summary, ts in OTHER:
    a(insert("health_records",
             ["id", "user_id", "family_member_id", "category", "title", "summary",
              "recorded_at", "source", "doctor_name", "abnormal", "report_status",
              "hospital", "version", "idempotency_key", "request_digest", "created_at"],
             [rid, uid, fmid, cat, title, summary, ts, "DEMO_SEED_V9010",
              None, None, None, None, 1, None, None, ts]))
a("")

a("-- =====================================================================")
a("-- 验收口径（执行后实测，未执行不得写通过）：")
a("--   新增用户 3 / 新增报告 7（READY 5、REVIEWING 1、PENDING 1）/")
a("--   非报告类档案 6（report_status NULL）/ 演示机构 3 / 演示家属 1。")
a("--   REVIEWING 与 PENDING 报告不写入 health_report_items。")
a("--   原有 4 个账号与 7 条档案逐行保持不变。")
a("-- =====================================================================")

OUT.write_text("\n".join(L) + "\n", encoding="utf-8")
print("已生成 %s（%d 行，%d 条 INSERT）" %
      (OUT, len(L) + 1, sum(1 for x in L if x.startswith("INSERT INTO"))))
