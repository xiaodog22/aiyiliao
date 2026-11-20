"""初始化数据：科室、30 名人员与账号、号源、药品、ICD-10、检验项目、对接密钥。

编制：8 医生 / 14 护士（含公卫 3）/ 6 行政 / 2 医技。
演示初始口令统一为 Clinic@2026（生产必须启用首次登录强制改密）。
"""

from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timedelta

from . import db
from .security import hash_password, patient_hash

DEFAULT_PASSWORD = "Clinic@2026"

DEPARTMENTS = [
    ("QK", "全科医学科", "CLINICAL"),
    ("NK", "内科", "CLINICAL"),
    ("EK", "儿科", "CLINICAL"),
    ("ZY", "中医科", "CLINICAL"),
    ("KQ", "口腔科", "CLINICAL"),
    ("HL", "护理部", "NURSING"),
    ("YF", "药房", "PHARMACY"),
    ("SF", "收费处", "FINANCE"),
    ("GW", "公共卫生科", "PUBLIC_HEALTH"),
    ("YJ", "医技科", "TECH"),
    ("YW", "医务科", "ADMIN"),
    ("XX", "信息科", "ADMIN"),
    ("YB", "院办", "ADMIN"),
]

# (staff_no, 姓名, 性别, 角色, 职称, 科室, 执业证书编号, 专长/岗位, 处方权限级别, 账号)
STAFF = [
    # —— 医生 8 人 ——
    ("D001", "陈志远", "男", "DOCTOR", "主任医师", "QK", "1104401020001", "高血压、糖尿病等慢病管理", 3, "doctor01"),
    ("D002", "林秀珍", "女", "DOCTOR", "副主任医师", "QK", "1104401020002", "呼吸、消化系统常见病", 3, "doctor02"),
    ("D003", "黄伟成", "男", "DOCTOR", "住院医师", "QK", "1104401020003", "常见病、多发病诊治", 1, "doctor03"),
    ("D004", "郑海燕", "女", "DOCTOR", "副主任医师", "NK", "1104401020004", "高血压、冠心病等心血管疾病", 3, "doctor04"),
    ("D005", "吴国栋", "男", "DOCTOR", "主治医师", "NK", "1104401020005", "糖尿病、甲状腺疾病", 2, "doctor05"),
    ("D006", "蔡晓彤", "女", "DOCTOR", "主治医师", "EK", "1104401020006", "儿童呼吸、消化系统疾病", 2, "doctor06"),
    ("D007", "罗文彬", "男", "DOCTOR", "副主任医师", "ZY", "1104401020007", "针灸、中医内科调理", 3, "doctor07"),
    ("D008", "谢嘉怡", "女", "DOCTOR", "主治医师", "KQ", "1104401020008", "龋病、牙周病诊治", 2, "doctor08"),
    # —— 护士 14 人（N010~N012 公卫岗）——
    ("N001", "张丽群", "女", "NURSE", "主管护师", "HL", "N4401202600001", "护士长 · 门诊护理管理", 0, "nurse01"),
    ("N002", "李春梅", "女", "NURSE", "护师", "HL", "N4401202600002", "分诊", 0, "nurse02"),
    ("N003", "王秀云", "女", "NURSE", "护士", "HL", "N4401202600003", "分诊", 0, "nurse03"),
    ("N004", "陈小凤", "女", "NURSE", "主管护师", "HL", "N4401202600004", "输液室", 0, "nurse04"),
    ("N005", "刘慧敏", "女", "NURSE", "护师", "HL", "N4401202600005", "输液室", 0, "nurse05"),
    ("N006", "周雅婷", "女", "NURSE", "护士", "HL", "N4401202600006", "治疗室", 0, "nurse06"),
    ("N007", "许海珍", "女", "NURSE", "护师", "HL", "N4401202600007", "治疗室", 0, "nurse07"),
    ("N008", "方少玲", "女", "NURSE", "护士", "HL", "N4401202600008", "输液室", 0, "nurse08"),
    ("N009", "曾美玲", "女", "NURSE", "护士", "HL", "N4401202600009", "治疗室", 0, "nurse09"),
    ("N010", "苏玉兰", "女", "PUBLIC_HEALTH", "主管护师", "GW", "N4401202600010", "慢病随访管理", 0, "nurse10"),
    ("N011", "邱丽萍", "女", "PUBLIC_HEALTH", "护师", "GW", "N4401202600011", "传染病上报", 0, "nurse11"),
    ("N012", "谢婉如", "女", "PUBLIC_HEALTH", "护士", "GW", "N4401202600012", "居民健康档案", 0, "nurse12"),
    ("N013", "洪瑞珠", "女", "NURSE", "护士", "HL", "N4401202600013", "消毒供应", 0, "nurse13"),
    ("N014", "蔡美华", "女", "NURSE", "护士", "HL", "N4401202600014", "消毒供应", 0, "nurse14"),
    # —— 行政管理 6 人 ——
    ("A001", "马建华", "男", "DIRECTOR", "副主任医师", "YB", "1104401030001", "院长", 0, "admin01"),
    ("A002", "高志明", "男", "MEDICAL_AFFAIRS", "主治医师", "YW", "1104401030002", "医务科科长 · 病案质控", 0, "admin02"),
    ("A003", "潘丽君", "女", "PHARMACIST", "主管药师", "YF", "4401202630001", "药房负责人 · 处方审核", 0, "admin03"),
    ("A004", "苏晓红", "女", "CASHIER", "", "SF", "", "挂号收费", 0, "admin04"),
    ("A005", "李国强", "男", "CASHIER", "", "SF", "", "挂号收费", 0, "admin05"),
    ("A006", "吴敏", "女", "ADMIN", "工程师", "XX", "", "信息科 · 系统运维", 0, "admin06"),
    # —— 医技支撑 2 人 ——
    ("T001", "何建平", "男", "TECHNICIAN", "检验技师", "YJ", "T4401202640001", "临床检验", 0, "tech01"),
    ("T002", "陈丽云", "女", "TECHNICIAN", "放射技师", "YJ", "T4401202640002", "X 线摄影", 0, "tech02"),
]

PATIENTS = [
    ("P000001", "王秀英", "女", "1953-04-12", "3621", "138****6621", "湘桥区西新街道", "青霉素过敏", ["高血压", "2型糖尿病"]),
    ("P000002", "李建国", "男", "1965-09-03", "4472", "139****2208", "湘桥区金山街道", "无", ["高血压"]),
    ("P000003", "陈美华", "女", "1978-12-25", "7781", "136****9910", "湘桥区城西街道", "磺胺类过敏", []),
    ("P000004", "张伟明", "男", "1989-06-18", "3325", "135****4471", "湘桥区桥东街道", "无", []),
    ("P000005", "刘淑芬", "女", "1949-02-07", "5583", "133****8802", "湘桥区南春街道", "无", ["冠心病", "高脂血症"]),
    ("P000006", "黄志强", "男", "1972-11-30", "6614", "137****3356", "潮安区庵埠镇", "无", ["痛风"]),
    ("P000007", "林小梅", "女", "1995-08-14", "2198", "158****7734", "湘桥区凤新街道", "无", []),
    ("P000008", "吴德胜", "男", "1961-01-22", "8067", "159****1163", "湘桥区意溪镇", "阿司匹林过敏", ["高血压"]),
    ("P000009", "郑桂香", "女", "1958-07-09", "4439", "138****5507", "湘桥区太平街道", "无", ["2型糖尿病"]),
    ("P000010", "周文杰", "男", "2001-03-16", "1205", "186****9928", "湘桥区西新街道", "无", []),
]

DRUGS = [
    ("AMX", "阿莫西林胶囊", "0.25g*24粒", "盒", 12.50, 200, 30, "口服", "非限制", 0),
    ("CFK", "头孢克洛胶囊", "0.25g*12粒", "盒", 26.00, 150, 20, "口服", "限制", 0),
    ("AZM", "阿奇霉素分散片", "0.25g*6片", "盒", 18.50, 120, 20, "口服", "限制", 0),
    ("DXP", "地西泮片", "5mg*20片", "盒", 8.00, 50, 10, "口服", "", 1),
    ("BLD", "布洛芬缓释胶囊", "0.3g*20粒", "盒", 15.00, 180, 30, "口服", "", 0),
    ("DXY", "对乙酰氨基酚片", "0.5g*12片", "盒", 6.00, 200, 30, "口服", "", 0),
    ("LLT", "氯雷他定片", "10mg*6片", "盒", 9.80, 160, 20, "口服", "", 0),
    ("OMP", "奥美拉唑肠溶胶囊", "20mg*14粒", "盒", 22.00, 140, 20, "口服", "", 0),
    ("MTS", "蒙脱石散", "3g*10袋", "盒", 16.50, 120, 20, "口服", "", 0),
    ("ORS", "口服补液盐Ⅲ", "5.125g*6袋", "盒", 12.00, 100, 15, "口服", "", 0),
    ("NFD", "硝苯地平控释片", "30mg*7片", "盒", 28.00, 130, 20, "口服", "", 0),
    ("ALD", "苯磺酸氨氯地平片", "5mg*14片", "盒", 19.50, 150, 20, "口服", "", 0),
    ("MET", "二甲双胍缓释片", "0.5g*30片", "盒", 24.00, 160, 20, "口服", "", 0),
    ("ATV", "阿托伐他汀钙片", "20mg*7片", "盒", 32.00, 110, 15, "口服", "", 0),
    ("GML", "复方感冒灵颗粒", "14g*9袋", "盒", 13.50, 170, 25, "口服", "", 0),
    ("BGL", "板蓝根颗粒", "10g*20袋", "盒", 11.00, 150, 20, "口服", "", 0),
    ("DFS", "碘伏消毒液", "500ml", "瓶", 7.50, 90, 15, "外用", "", 0),
    ("NS5", "0.9%氯化钠注射液", "500ml", "瓶", 4.50, 300, 50, "注射", "", 0),
    ("GS5", "5%葡萄糖注射液", "500ml", "瓶", 4.80, 280, 50, "注射", "", 0),
    ("YNB", "云南白药气雾剂", "85g", "瓶", 36.00, 70, 10, "外用", "", 0),
    ("ASA", "阿司匹林肠溶片", "100mg*30片", "盒", 9.90, 140, 20, "口服", "", 0),
    ("JWP", "健胃消食片", "0.8g*32片", "盒", 12.00, 120, 20, "口服", "", 0),
]

# 药品默认用法/频次（AutoComplete 选中后联动带出；幂等覆盖空值）
DRUG_RX_DEFAULTS = {
    "AMX": ("口服", "每日三次"), "CFK": ("口服", "每日三次"), "AZM": ("口服", "每日一次"),
    "DXP": ("口服", "睡前一次"), "BLD": ("口服", "每日两次"), "DXY": ("口服", "需要时"),
    "LLT": ("口服", "每日一次"), "OMP": ("口服", "每日一次"), "MTS": ("口服", "每日三次"),
    "ORS": ("口服补液", "按需"), "NFD": ("口服", "每日一次"), "ALD": ("口服", "每日一次"),
    "MET": ("口服", "每日两次"), "ATV": ("口服", "睡前一次"), "GML": ("开水冲服", "每日三次"),
    "BGL": ("开水冲服", "每日三次"), "DFS": ("外用", "每日两次"), "NS5": ("静脉滴注", "每日一次"),
    "GS5": ("静脉滴注", "每日一次"), "YNB": ("外用喷敷", "每日三次"),
    "ASA": ("口服", "每日一次"), "JWP": ("口服", "每日三次"),
}


# 药品过敏标签（| 分隔）：用于处方前置过敏冲突校验；只标注常见高风险药品
DRUG_ALLERGY_TAGS = {
    "AMX": "青霉素|阿莫西林",
    "CFK": "头孢|青霉素",
    "AZM": "阿奇霉素|大环内酯",
    "BLD": "布洛芬|NSAIDs",
    "ASA": "阿司匹林|水杨酸",
    "DXP": "地西泮|苯二氮卓",
}

ICD10 = [
    ("J06.9", "急性上呼吸道感染", "呼吸系统", 0, 0),
    ("J02.9", "急性咽炎", "呼吸系统", 0, 0),
    ("J20.9", "急性支气管炎", "呼吸系统", 0, 0),
    ("J45.9", "支气管哮喘", "呼吸系统", 1, 0),
    ("J30.4", "过敏性鼻炎", "呼吸系统", 0, 0),
    ("J11.1", "流行性感冒", "呼吸系统", 0, 1),
    ("A16", "肺结核", "传染病", 0, 1),
    ("B19.9", "病毒性肝炎", "传染病", 0, 1),
    ("B01.9", "水痘", "传染病", 0, 1),
    ("B08.4", "手足口病", "传染病", 0, 1),
    ("A09", "感染性腹泻", "消化系统", 0, 1),
    ("I10", "高血压", "循环系统", 1, 0),
    ("I25.1", "冠心病", "循环系统", 1, 0),
    ("I48", "心房颤动", "循环系统", 0, 0),
    ("E11.9", "2型糖尿病", "内分泌", 1, 0),
    ("E78.5", "高脂血症", "内分泌", 1, 0),
    ("M10.9", "痛风", "风湿免疫", 1, 0),
    ("M47.8", "颈椎病", "骨科", 1, 0),
    ("M51.2", "腰椎间盘突出", "骨科", 1, 0),
    ("M19.9", "骨关节炎", "骨科", 1, 0),
    ("M75.0", "肩周炎", "骨科", 1, 0),
    ("M65.4", "腱鞘炎", "骨科", 0, 0),
    ("K29.7", "胃炎", "消化系统", 1, 0),
    ("K21.9", "胃食管反流", "消化系统", 0, 0),
    ("N39.0", "尿路感染", "泌尿系统", 0, 0),
    ("H10.9", "结膜炎", "眼科", 0, 0),
    ("H66.9", "中耳炎", "耳鼻喉", 0, 0),
    ("L30.9", "湿疹", "皮肤科", 0, 0),
    ("L50.9", "荨麻疹", "皮肤科", 0, 0),
    ("D64.9", "贫血", "血液系统", 0, 0),
    ("F51.0", "失眠", "精神心理", 0, 0),
    ("F41.9", "焦虑状态", "精神心理", 0, 0),
    ("K02.9", "龋齿", "口腔", 0, 0),
    ("K05.3", "牙周炎", "口腔", 0, 0),
    ("K12.0", "口腔溃疡", "口腔", 0, 0),
    ("R50.9", "发热", "症状", 0, 0),
    ("R05", "咳嗽", "症状", 0, 0),
]

LAB_ITEMS = [
    # (编码, 名称, 类别, 价格, 危急值下限, 危急值上限)
    ("LAB01", "血常规", "检验", 25.00, None, None),
    ("LAB02", "尿常规", "检验", 15.00, None, None),
    ("LAB03", "肝功能", "检验", 60.00, None, None),
    ("LAB04", "空腹血糖", "检验", 8.00, 3.9, 11.1),
    ("LAB05", "心电图", "检查", 30.00, None, None),
    ("LAB06", "胸部正位片", "检查", 80.00, None, None),
    ("LAB07", "血钾", "检验", 12.00, 3.5, 5.5),
    ("LAB08", "血红蛋白", "检验", 10.00, 110.0, 160.0),
    ("LAB09", "白细胞计数", "检验", 10.00, 4.0, 10.0),
]


def _seed_departments(con) -> dict:
    ids = {}
    for code, name, dtype in DEPARTMENTS:
        cur = con.execute("INSERT INTO departments(code,name,type) VALUES (?,?,?)", (code, name, dtype))
        ids[code] = int(cur.lastrowid)
    return ids


def _seed_staff(con, dept_ids: dict) -> None:
    now = db.now_str()
    for staff_no, name, gender, role, title, dept, license_no, specialty, pres_level, username in STAFF:
        cur = con.execute(
            "INSERT INTO staff(staff_no,name,gender,role,title,dept_id,license_no,specialty,phone_mask,status,hire_date,pres_level) "
            "VALUES (?,?,?,?,?,?,?,?,?, 'ACTIVE', ?, ?)",
            (staff_no, name, gender, role, title, dept_ids[dept], license_no, specialty,
             "", "2021-01-01", pres_level),
        )
        staff_id = int(cur.lastrowid)
        con.execute(
            "INSERT INTO users(username,password_hash,staff_id,role,status,failed_count,password_changed_at,must_change,created_at) "
            "VALUES (?,?,?,?, 'ACTIVE', 0, ?, 0, ?)",
            (username, hash_password(DEFAULT_PASSWORD), staff_id, role, now, now),
        )


def _seed_patients(con) -> None:
    now = db.now_str()
    for mrn, name, gender, birth, last4, phone_mask, address, allergy, chronic in PATIENTS:
        con.execute(
            "INSERT INTO patients(mrn,name,gender,birth_date,id_last4,id_hash,phone_mask,phone_hash,address,allergy,chronic_tags,created_at,created_by) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
            (mrn, name, gender, birth, last4, patient_hash(last4), phone_mask, patient_hash(phone_mask.replace("*", "0")),
             address, allergy, json.dumps(chronic, ensure_ascii=False), now),
        )


def ensure_slots(con) -> None:
    """为在职医生生成今天起 7 天的上下午号源（幂等）。"""
    doctors = con.execute(
        "SELECT s.id, s.staff_no, s.dept_id FROM staff s WHERE s.role='DOCTOR' AND s.status='ACTIVE'"
    ).fetchall()
    today = datetime.now().date()
    for offset in range(7):
        day = (today + timedelta(days=offset)).strftime("%Y-%m-%d")
        compact = day.replace("-", "")
        for doc in doctors:
            for period, start, end, cap in (("AM", "08:00", "12:00", 20), ("PM", "14:00", "17:30", 15)):
                slot_no = f"SL{compact}{doc['staff_no']}{period}"
                con.execute(
                    "INSERT OR IGNORE INTO doctor_slots(slot_no,doctor_id,dept_id,work_date,period,start_time,end_time,capacity,booked,status) "
                    "VALUES (?,?,?,?,?,?,?,?,0,'OPEN')",
                    (slot_no, doc["id"], doc["dept_id"], day, period, start, end, cap),
                )


def ensure_openapi_key(con) -> None:
    row = con.execute("SELECT COUNT(*) AS c FROM openapi_keys").fetchone()
    if row["c"]:
        return
    app_id = "wechar-mini"
    secret = secrets.token_hex(24)
    con.execute(
        "INSERT INTO openapi_keys(app_id,app_secret,name,status,created_at) VALUES (?,?,?, 'ACTIVE', ?)",
        (app_id, secret, "康诊云小程序", db.now_str()),
    )
    os.makedirs(db.DATA_DIR, exist_ok=True)
    path = os.path.join(db.DATA_DIR, "openapi-credentials.txt")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# Clinic HIS 对外接口凭据（演示环境；生产请通过密钥管理下发并定期轮换）\n")
        fh.write(f"appId={app_id}\nappSecret={secret}\n")
        fh.write("签名算法见 docs/02-接口契约.md\n")


def ensure_beds(con) -> None:
    """留观床位：观察室 G-01~G-06（床）、输液室 S-01~S-04（椅），幂等。"""
    beds = [(f"G-{i:02d}", "观察室", "BED") for i in range(1, 7)]
    beds += [(f"S-{i:02d}", "输液室", "CHAIR") for i in range(1, 5)]
    now = db.now_str()
    for bed_no, zone, kind in beds:
        exists = con.execute("SELECT 1 FROM beds WHERE bed_no=?", (bed_no,)).fetchone()
        if exists:
            continue
        con.execute(
            "INSERT INTO beds(bed_no,zone,kind,status,current_stay_id,note,updated_at) "
            "VALUES (?,?,?, 'FREE', NULL, '', ?)", (bed_no, zone, kind, now))


def ensure_drug_allergy_tags(con) -> None:
    """补齐药品过敏标签（幂等）：新库与存量库都按编码覆盖为空标签的药品。"""
    for code, tags in DRUG_ALLERGY_TAGS.items():
        con.execute("UPDATE drugs SET allergy_tags=? WHERE code=? AND (allergy_tags IS NULL OR allergy_tags='')",
                    (tags, code))


def ensure_drug_rx_defaults(con) -> None:
    """补齐药品默认用法/频次（幂等）：仅覆盖空值，不破坏人工维护过的数据。"""
    for code, (route, freq) in DRUG_RX_DEFAULTS.items():
        con.execute("UPDATE drugs SET default_route=?, default_freq=? "
                    "WHERE code=? AND (default_route IS NULL OR default_route='')",
                    (route, freq, code))


def ensure_seed() -> bool:
    """首次启动时写入演示数据；返回是否执行了初始化。"""
    con = db.connect()
    try:
        seeded = False
        count = con.execute("SELECT COUNT(*) AS c FROM departments").fetchone()["c"]
        if count == 0:
            dept_ids = _seed_departments(con)
            _seed_staff(con, dept_ids)
            _seed_patients(con)
            seeded = True
        if con.execute("SELECT COUNT(*) AS c FROM drugs").fetchone()["c"] == 0:
            con.executemany(
                "INSERT INTO drugs(code,name,spec,unit,price,stock,alert_stock,category,antibiotic_level,controlled,status) "
                "VALUES (?,?,?,?,?,?,?,?,?,?, 'ACTIVE')", DRUGS)
        if con.execute("SELECT COUNT(*) AS c FROM icd10").fetchone()["c"] == 0:
            con.executemany("INSERT INTO icd10(code,name,category,chronic,infectious) VALUES (?,?,?,?,?)", ICD10)
        if con.execute("SELECT COUNT(*) AS c FROM lab_items").fetchone()["c"] == 0:
            con.executemany(
                "INSERT INTO lab_items(code,name,category,price,critical_low,critical_high) VALUES (?,?,?,?,?,?)",
                LAB_ITEMS)
        else:
            # 存量库补齐新增项目与阈值（幂等）
            for code, name, category, price, low, high in LAB_ITEMS:
                con.execute(
                    "INSERT OR IGNORE INTO lab_items(code,name,category,price,critical_low,critical_high) "
                    "VALUES (?,?,?,?,?,?)", (code, name, category, price, low, high))
                con.execute(
                    "UPDATE lab_items SET critical_low=?, critical_high=? WHERE code=? AND critical_low IS NULL AND critical_high IS NULL",
                    (low, high, code))
        ensure_openapi_key(con)
        ensure_slots(con)
        ensure_beds(con)
        ensure_drug_allergy_tags(con)
        ensure_drug_rx_defaults(con)
        con.commit()
        return seeded
    finally:
        con.close()
