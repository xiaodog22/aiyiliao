"""端到端冒烟测试：全业务链路 + 对外接口签名/幂等/防重放。

用法（在 clinic-his 目录）：
    python scripts/smoke_test.py                 # 自动复用或拉起本地服务
    python scripts/smoke_test.py --base http://127.0.0.1:8310
仅依赖 Python 标准库；任何断言失败以非 0 退出码结束。
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("CLINIC_DATA_DIR") or os.path.join(ROOT, "data")
BASE = "http://127.0.0.1:8310"
DEFAULT_PASSWORD = "Clinic@2026"

passed = 0
failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  [PASS] {name}")
    else:
        failed += 1
        print(f"  [FAIL] {name}" + (f" -> {detail}" if detail else ""))


def call(method: str, path: str, token: str = "", body=None, headers=None, raw: bytes | None = None):
    data = raw
    if data is None and body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        try:
            payload = json.loads(err.read().decode("utf-8"))
        except Exception:
            payload = {"code": f"HTTP_{err.code}", "message": str(err)}
        return err.code, payload


def login(username: str, password: str = DEFAULT_PASSWORD) -> str:
    status, payload = call("POST", "/api/v1/auth/login", body={"username": username, "password": password})
    if status != 200 or payload.get("code") != "OK":
        raise SystemExit(f"登录失败 {username}: {status} {payload}")
    return payload["data"]["token"]


def ok_data(status: int, payload: dict, label: str):
    if status not in (200, 201) or payload.get("code") != "OK":
        raise SystemExit(f"{label} 失败: HTTP {status} {payload}")
    return payload.get("data")


def wait_ready(timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status, _ = call("GET", "/openapi/v1/ping")
            if status == 200:
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def sign(secret: str, method: str, path: str, app_id: str, timestamp: str, nonce: str, raw: bytes) -> str:
    body_hash = hashlib.sha256(raw).hexdigest()
    message = "\n".join([method.upper(), path, app_id, timestamp, nonce, body_hash])
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def load_credentials() -> tuple[str, str]:
    path = os.path.join(DATA_DIR, "openapi-credentials.txt")
    app_id, secret = "wechar-mini", ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("appId="):
                    app_id = line.split("=", 1)[1]
                elif line.startswith("appSecret="):
                    secret = line.split("=", 1)[1]
    if not secret:
        raise SystemExit("未找到对外接口密钥，请先启动服务完成初始化")
    return app_id, secret


def signed_call(method: str, path: str, app_id: str, secret: str, body=None,
                idem: str | None = None, timestamp: str | None = None, nonce: str | None = None):
    raw = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else b""
    ts = timestamp or str(int(time.time()))
    nc = nonce or secrets.token_hex(8)
    headers = {
        "X-App-Id": app_id,
        "X-Timestamp": ts,
        "X-Nonce": nc,
        "X-Signature": sign(secret, method, path, app_id, ts, nc, raw),
    }
    if idem:
        headers["Idempotency-Key"] = idem
    return call(method, path, body=body, raw=raw if body is not None else raw, headers=headers), headers


def main() -> int:
    global BASE, DATA_DIR
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--no-start", action="store_true", help="服务未启动时不自动拉起")
    args = parser.parse_args()
    BASE = args.base.rstrip("/")

    proc = None
    temp_dir = None
    if not wait_ready(2.0):
        if args.no_start:
            raise SystemExit("服务未启动且指定了 --no-start")
        # 隔离数据目录：冒烟会消耗当日号源、写入就诊/收费数据，复用 data/ 会导致重复运行失败
        print("服务未运行，正在自动拉起（使用临时隔离数据目录，可重复运行）…")
        temp_dir = tempfile.mkdtemp(prefix="clinic-smoke-")
        DATA_DIR = temp_dir
        env = dict(os.environ, PYTHONIOENCODING="utf-8", CLINIC_DATA_DIR=temp_dir)
        proc = subprocess.Popen([sys.executable, "-m", "app.main"], cwd=ROOT, env=env)
        if not wait_ready(20.0):
            proc.terminate()
            raise SystemExit("服务启动超时")
    print(f"目标服务：{BASE}")

    try:
        today = datetime.now().strftime("%Y-%m-%d")
        stamp = datetime.now().strftime("%H%M%S")

        print("\n[1] 认证与基础数据")
        admin_token = login("admin06")
        status, payload = call("GET", "/api/v1/auth/me", token=admin_token)
        me = ok_data(status, payload, "读取当前用户")
        check("系统管理员登录", me["role"] == "ADMIN")
        check("权限集合返回", "system.admin" in me["perms"])

        doctor_token = login("doctor01")
        depts = ok_data(*call("GET", "/api/v1/departments", token=doctor_token), "科室列表")
        check("科室字典非空", len(depts) >= 10, f"got {len(depts)}")

        staff = ok_data(*call("GET", "/api/v1/staff?role=DOCTOR", token=admin_token), "医师列表")
        doctor_row = next((s for s in staff if s["staffNo"] == "D001"), None)
        check("医师编制 5~8 人", 5 <= len(staff) <= 8, f"got {len(staff)}")
        check("医生 D001 存在", doctor_row is not None)
        nurses = ok_data(*call("GET", "/api/v1/staff?role=NURSE", token=admin_token), "护士列表")
        ph_nurses = ok_data(*call("GET", "/api/v1/staff?role=PUBLIC_HEALTH", token=admin_token), "公卫护士")
        nurse_total = len(nurses) + len(ph_nurses)
        check("护士编制 12~15 人", 12 <= nurse_total <= 15, f"got {nurse_total}")

        print("\n[2] 建档与挂号")
        patient = ok_data(*call("POST", "/api/v1/patients", token=admin_token, body={
            "name": "冒烟测试" + stamp, "gender": "男", "birthDate": "1985-06-01",
            "idCard": "440101198506011234", "phone": "13800001234",
            "address": "演示地址", "allergy": "无", "chronicTags": ["高血压"],
        }), "新建患者")
        check("患者建档返回病历号", patient["mrn"].startswith("P"))

        ok_data(*call("POST", "/api/v1/schedules/generate", token=admin_token,
                      body={"startDate": today, "days": 7}), "生成排班")
        slots = ok_data(*call("GET", f"/api/v1/schedules?date={today}&doctorId={doctor_row['id']}",
                              token=admin_token), "查询号源")
        open_slots = [s for s in slots if s["status"] == "OPEN" and s["remaining"] > 0]
        check("存在可用号源", bool(open_slots))
        slot = open_slots[0]

        reg = ok_data(*call("POST", "/api/v1/registrations", token=admin_token, body={
            "patientId": patient["id"], "slotId": slot["id"], "source": "ONSITE",
        }), "挂号")
        check("挂号成功生成单号", reg["regNo"].startswith("RG"))

        charges = ok_data(*call("GET", f"/api/v1/charges?status=UNPAID&date={today}", token=admin_token), "待收费列表")
        reg_charge = next((c for c in charges if c["refType"] == "REGISTRATION" and c["refId"] == reg["id"]), None)
        check("挂号费账单已生成", reg_charge is not None)

        print("\n[3] 收费 → 签到 → 叫号")
        cashier_token = login("admin04")
        paid = ok_data(*call("POST", "/api/v1/charges/pay", token=cashier_token,
                             body={"ids": [reg_charge["id"]]}), "挂号费收费")
        check("收费金额正确", abs(paid["totalAmount"] - reg["feeAmount"]) < 0.01)

        nurse_token = login("nurse01")
        checkin = ok_data(*call("POST", f"/api/v1/registrations/{reg['id']}/checkin", token=nurse_token,
                                body={"temperature": 36.8, "systolic": 128, "diastolic": 82, "pulse": 76}),
                          "签到")
        check("签到生成队列号", bool(checkin.get("queueNo")))
        target_ticket = checkin["queueNo"]
        hit = False
        for _ in range(10):
            called = ok_data(*call("POST", "/api/v1/queue/call-next", token=nurse_token,
                                   body={"deptId": slot["deptId"]}), "叫号")
            current = called.get("called")
            if not current:
                break
            if current["ticketNo"] == target_ticket:
                hit = True
                break
        check("叫号命中本患者", hit, f"target={target_ticket}")

        print("\n[4] 接诊 → 病历 → 诊断 → 处方 → 检查")
        visit = ok_data(*call("POST", "/api/v1/visits", token=doctor_token,
                              body={"registrationId": reg["id"]}), "接诊")
        visit_id = visit["id"]
        ok_data(*call("PATCH", f"/api/v1/visits/{visit_id}", token=doctor_token, body={
            "chiefComplaint": "发热咳嗽 2 天", "presentIllness": "2 天前受凉后发热，最高 38.5℃",
            "pastHistory": "高血压 3 年", "physicalExam": "咽部充血", "treatmentAdvice": "对症治疗，多饮水",
        }), "保存病历")

        diag = ok_data(*call("POST", f"/api/v1/visits/{visit_id}/diagnose", token=doctor_token,
                             body={"code": "J11.1", "note": "流感样症状"}), "诊断")
        check("诊断按 ICD-10 保存", diag["diagnosisCode"] == "J11.1")

        drugs = ok_data(*call("GET", "/api/v1/drugs", token=doctor_token), "药品目录")
        normal_drug = next(d for d in drugs if not d["controlled"] and not d["antibioticLevel"])
        rx = ok_data(*call("POST", f"/api/v1/visits/{visit_id}/prescriptions", token=doctor_token, body={
            "items": [{"drugId": normal_drug["id"], "dosage": "口服", "frequency": "一日三次",
                       "days": 3, "quantity": 1}],
        }), "开具处方")
        check("处方合计 > 0", rx["totalAmount"] > 0)

        labs = ok_data(*call("POST", f"/api/v1/visits/{visit_id}/lab-orders", token=doctor_token,
                             body={"items": ["LAB01"]}), "开检查")
        lab_id = labs["orders"][0]["id"]
        ok_data(*call("PATCH", f"/api/v1/visits/{visit_id}/vitals", token=doctor_token,
                      body={"temperature": 37.2, "spo2": 97}), "补录体征")
        visit_detail = ok_data(*call("GET", f"/api/v1/visits/{visit_id}", token=doctor_token), "读取病历")
        check("体征补录与分诊签到合并",
              visit_detail["vitals"].get("temperature") == 37.2
              and visit_detail["vitals"].get("systolic") == 128
              and visit_detail["vitalsSource"] == "MERGED",
              json.dumps({"vitals": visit_detail["vitals"], "src": visit_detail["vitalsSource"]},
                         ensure_ascii=False))
        ok_data(*call("POST", f"/api/v1/visits/{visit_id}/finish", token=doctor_token), "完成就诊")

        print("\n[4B] 病历强校验 / 主次诊断 / 历史调阅")
        patient2 = ok_data(*call("POST", "/api/v1/patients", token=admin_token, body={
            "name": "冒烟乙" + stamp, "gender": "女", "birthDate": "1990-03-15",
            "idCard": "440101199003152345", "phone": "13800005678",
            "address": "演示地址", "allergy": "无", "chronicTags": [],
        }), "新建患者乙")
        ok_data(*call("POST", "/api/v1/schedules/generate", token=admin_token,
                      body={"startDate": today, "days": 7}), "生成排班乙")
        slots2 = ok_data(*call("GET", f"/api/v1/schedules?date={today}&doctorId={doctor_row['id']}",
                               token=admin_token), "查询号源乙")
        open2 = [s for s in slots2 if s["status"] == "OPEN" and s["remaining"] > 0]
        if not open2:
            raise SystemExit("无可用号源，无法继续病历增强测试")
        reg2 = ok_data(*call("POST", "/api/v1/registrations", token=admin_token, body={
            "patientId": patient2["id"], "slotId": open2[0]["id"], "source": "ONSITE",
        }), "挂号乙")
        charges2 = ok_data(*call("GET", f"/api/v1/charges?status=UNPAID&date={today}", token=admin_token),
                           "待收费乙")
        reg2_charge = next((c for c in charges2
                            if c["refType"] == "REGISTRATION" and c["refId"] == reg2["id"]), None)
        ok_data(*call("POST", "/api/v1/charges/pay", token=cashier_token,
                      body={"ids": [reg2_charge["id"]]}), "缴费乙")
        ok_data(*call("POST", f"/api/v1/registrations/{reg2['id']}/checkin", token=nurse_token,
                      body={"temperature": 36.9, "systolic": 118, "diastolic": 76}), "签到乙")
        visit2 = ok_data(*call("POST", "/api/v1/visits", token=doctor_token,
                               body={"registrationId": reg2["id"]}), "接诊乙")
        vid2 = visit2["id"]

        status, payload = call("POST", f"/api/v1/visits/{vid2}/finish", token=doctor_token)
        check("空病历完成就诊被拒（EMR_INCOMPLETE）",
              status == 400 and payload.get("code") == "EMR_INCOMPLETE", f"{status} {payload}")

        ok_data(*call("PATCH", f"/api/v1/visits/{vid2}", token=doctor_token,
                      body={"chiefComplaint": "咳嗽 3 天", "presentIllness": "3 天前受凉后咳嗽",
                            "allergyHistory": "否认药物过敏"}), "保存病历乙")
        status, payload = call("POST", f"/api/v1/visits/{vid2}/finish", token=doctor_token)
        check("无诊断完成就诊被拒（EMR_INCOMPLETE）",
              status == 400 and payload.get("code") == "EMR_INCOMPLETE"
              and "诊断" in payload.get("message", ""), f"{status} {payload}")

        d1 = ok_data(*call("POST", f"/api/v1/visits/{vid2}/diagnoses", token=doctor_token,
                           body={"code": "J11.1", "isPrimary": True}), "主诊断乙")
        v_after = ok_data(*call("GET", f"/api/v1/visits/{vid2}", token=doctor_token), "读取病历乙")
        check("主诊断同步 visits 冗余字段",
              v_after["diagnosisCode"] == "J11.1" and len(v_after["diagnoses"]) == 1,
              f"code={v_after['diagnosisCode']} n={len(v_after['diagnoses'])}")

        ok_data(*call("POST", f"/api/v1/visits/{vid2}/diagnoses", token=doctor_token,
                      body={"code": "R05", "isPrimary": False}), "次要诊断乙")
        v_after = ok_data(*call("GET", f"/api/v1/visits/{vid2}", token=doctor_token), "读取病历乙2")
        check("次要诊断保存", len(v_after["diagnoses"]) == 2, f"got {len(v_after['diagnoses'])}")

        d3 = ok_data(*call("POST", f"/api/v1/visits/{vid2}/diagnoses", token=doctor_token,
                           body={"code": "K29.7", "isPrimary": True}), "切换主诊断乙")
        v_after = ok_data(*call("GET", f"/api/v1/visits/{vid2}", token=doctor_token), "读取病历乙3")
        primaries = [d for d in v_after["diagnoses"] if d["isPrimary"]]
        check("主诊断切换唯一且冗余同步",
              v_after["diagnosisCode"] == "K29.7" and len(primaries) == 1 and primaries[0]["code"] == "K29.7",
              f"code={v_after['diagnosisCode']} primaries={primaries}")

        ok_data(*call("DELETE", f"/api/v1/visits/{vid2}/diagnoses/{d3['id']}", token=doctor_token), "删除主诊断乙")
        v_after = ok_data(*call("GET", f"/api/v1/visits/{vid2}", token=doctor_token), "读取病历乙4")
        primaries = [d for d in v_after["diagnoses"] if d["isPrimary"]]
        check("删除主诊断后自动升主",
              len(primaries) == 1 and v_after["diagnosisCode"] == primaries[0]["code"],
              f"code={v_after['diagnosisCode']} primaries={primaries}")

        history = ok_data(*call("GET",
                                f"/api/v1/patients/{patient['id']}/visits?limit=5&excludeVisitId=999999",
                                token=doctor_token), "患者历史就诊")
        check("患者历史就诊含主诉与诊断",
              any(h.get("chiefComplaint") and h.get("diagnosisName") for h in history),
              json.dumps(history, ensure_ascii=False))
        history_ex = ok_data(*call("GET",
                                   f"/api/v1/patients/{patient['id']}/visits?limit=5&excludeVisitId={visit_id}",
                                   token=doctor_token), "历史就诊排除当前")
        check("历史就诊支持 excludeVisitId", len(history_ex) == 0, f"got {len(history_ex)}")

        print("\n[4C] 留观床位与护理执行")
        beds = ok_data(*call("GET", "/api/v1/beds", token=nurse_token), "床位看板")
        check("床位看板 10 张", len(beds) == 10, f"got {len(beds)}")
        free_bed = next((b for b in beds if b["status"] == "FREE"), None)
        if free_bed is None:
            raise SystemExit("无空闲床位，无法继续留观测试")
        stay = ok_data(*call("POST", "/api/v1/bed-stays", token=doctor_token, body={
            "patientId": patient2["id"], "visitId": vid2, "bedId": free_bed["id"],
            "nursingLevel": "二级护理", "diet": "半流质", "diagnosis": "急性上呼吸道感染",
        }), "开立留观")
        check("开立留观生成 OB 单号", str(stay["stayNo"]).startswith("OB"), json.dumps(stay, ensure_ascii=False))

        status, payload = call("POST", "/api/v1/bed-stays", token=doctor_token, body={
            "patientId": patient["id"], "bedId": free_bed["id"], "nursingLevel": "三级护理",
        })
        check("重复占床被拒（400 BED_OCCUPIED）",
              status == 400 and payload.get("code") == "BED_OCCUPIED", f"{status} {payload}")

        orders = ok_data(*call("POST", f"/api/v1/bed-stays/{stay['id']}/orders", token=doctor_token, body={
            "items": [
                {"orderType": "INFUSION", "content": "0.9% 氯化钠 250ml", "dose": "250ml",
                 "route": "静脉滴注", "frequency": "每日一次"},
                {"orderType": "MEASURE", "content": "测体温", "frequency": "每 4 小时"},
            ],
        }), "开立医嘱")
        check("批量开立医嘱 2 条", len(orders["orders"]) == 2, f"got {len(orders['orders'])}")

        first_order = orders["orders"][0]["id"]
        done = ok_data(*call("POST", f"/api/v1/nursing-orders/{first_order}/execute", token=nurse_token,
                             body={"remark": "已执行"}), "护士执行医嘱")
        check("护士执行医嘱状态 DONE", done["status"] == "DONE")
        status, payload = call("POST", f"/api/v1/nursing-orders/{first_order}/execute", token=nurse_token)
        check("重复执行医嘱被拒（400）", status == 400, f"{status} {payload}")

        record = ok_data(*call("POST", "/api/v1/nursing-records", token=nurse_token, body={
            "patientId": patient2["id"], "stayId": stay["id"],
            "temperature": 37.4, "pulse": 82, "spo2": 98, "note": "留观期间体温波动",
        }), "写入护理记录")
        check("护理记录写入成功", record["temperature"] == 37.4, json.dumps(record, ensure_ascii=False))
        records = ok_data(*call("GET", f"/api/v1/nursing-records?stayId={stay['id']}", token=nurse_token),
                          "查询护理记录")
        check("护理记录可按留观单查询", len(records) >= 1, f"got {len(records)}")

        ok_data(*call("POST", f"/api/v1/bed-stays/{stay['id']}/discharge", token=nurse_token,
                      body={"reason": "病情稳定，转门诊随访"}), "办理出区")
        beds = ok_data(*call("GET", "/api/v1/beds", token=nurse_token), "床位看板2")
        bed_after = next(b for b in beds if b["id"] == free_bed["id"])
        check("出区后床位转为待清洁", bed_after["status"] == "CLEANING", bed_after["status"])

        ok_data(*call("POST", f"/api/v1/beds/{free_bed['id']}/clean", token=nurse_token), "床位保洁")
        beds = ok_data(*call("GET", "/api/v1/beds", token=nurse_token), "床位看板3")
        bed_after = next(b for b in beds if b["id"] == free_bed["id"])
        check("保洁后床位恢复空闲", bed_after["status"] == "FREE", bed_after["status"])

        print("\n[5] 审方 → 收费 → 发药 → 检查报告")
        pharmacist_token = login("admin03")
        submitted = ok_data(*call("GET", "/api/v1/prescriptions?status=SUBMITTED", token=pharmacist_token), "待审处方")
        rx_row = next((r for r in submitted if r["id"] == rx["id"]), None)
        check("处方进入待审列表", rx_row is not None)
        ok_data(*call("POST", f"/api/v1/prescriptions/{rx['id']}/review", token=pharmacist_token,
                      body={"decision": "APPROVE", "comment": "用法用量正确"}), "审方通过")

        charges = ok_data(*call("GET", f"/api/v1/charges?status=UNPAID&date={today}", token=cashier_token), "待收费")
        drug_charge = next((c for c in charges if c["refType"] == "PRESCRIPTION" and c["refId"] == rx["id"]), None)
        lab_charge = next((c for c in charges if c["refType"] == "LAB_ORDER" and c["refId"] == lab_id), None)
        check("药品费账单已生成", drug_charge is not None)
        check("检查费账单已生成", lab_charge is not None)
        ok_data(*call("POST", "/api/v1/charges/pay", token=cashier_token,
                      body={"ids": [drug_charge["id"], lab_charge["id"]]}), "缴药费与检查费")

        ok_data(*call("POST", f"/api/v1/prescriptions/{rx['id']}/dispense", token=pharmacist_token), "发药")

        tech_token = login("tech01")
        ok_data(*call("POST", f"/api/v1/lab-orders/{lab_id}/sample", token=tech_token), "采样")
        ok_data(*call("POST", f"/api/v1/lab-orders/{lab_id}/report", token=tech_token, body={
            "findings": "白细胞 6.2×10^9/L，中性粒细胞比例正常",
            "conclusion": "未见明显异常", "abnormal": False,
        }), "录入报告")

        print("\n[6] 公卫任务与审计")
        ph_token = login("nurse10")
        tasks = ok_data(*call("GET", "/api/v1/ph-tasks?status=OPEN&type=INFECTION", token=ph_token), "公卫任务")
        task = next((t for t in tasks if t["patientMrn"] == patient["mrn"]), None)
        check("传染病上报任务已生成", task is not None)
        if task:
            ok_data(*call("POST", f"/api/v1/ph-tasks/{task['id']}/complete", token=ph_token,
                          body={"note": "已电话报告疾控中心"}), "完成上报任务")

        audit = ok_data(*call("GET", "/api/v1/audit-logs/verify", token=admin_token), "审计链校验")
        check("审计哈希链完整", audit["ok"] is True, json.dumps(audit))
        logs = ok_data(*call("GET", "/api/v1/audit-logs?limit=5", token=admin_token), "审计日志")
        check("审计日志可查询", logs["total"] > 0)

        report = ok_data(*call("GET", f"/api/v1/reports/daily?date={today}", token=admin_token), "日报")
        check("日报包含科室统计", len(report["byDept"]) > 0)

        print("\n[6B] 角色工作台 / 患者全视图 / 合理用药 / 病历质控")
        wb_doc = ok_data(*call("GET", "/api/v1/workbench", token=doctor_token), "医生工作台")
        check("医生工作台返回岗位待办",
              wb_doc.get("role") == "DOCTOR"
              and {t["key"] for t in wb_doc["todos"]} >= {"waitingVisits", "inProgress", "abnormalReports"}
              and all(t["view"] for t in wb_doc["todos"]),
              json.dumps(wb_doc, ensure_ascii=False))

        wb_nurse = ok_data(*call("GET", "/api/v1/workbench", token=nurse_token), "护士工作台")
        check("护士工作台含叫号/医嘱/留观待办",
              wb_nurse.get("role") == "NURSE"
              and {t["key"] for t in wb_nurse["todos"]} >= {"waitingQueue", "pendingOrders", "inBed"},
              json.dumps(wb_nurse, ensure_ascii=False))

        wb_ph = ok_data(*call("GET", "/api/v1/workbench", token=pharmacist_token), "药师工作台")
        check("药师工作台含待审方", any(t["key"] == "pendingReview" for t in wb_ph["todos"]),
              json.dumps(wb_ph, ensure_ascii=False))
        wb_cash = ok_data(*call("GET", "/api/v1/workbench", token=cashier_token), "收费工作台")
        check("收费工作台含待收费", any(t["key"] == "unpaid" for t in wb_cash["todos"]),
              json.dumps(wb_cash, ensure_ascii=False))

        overview = ok_data(*call("GET", f"/api/v1/patients/{patient['id']}/overview", token=doctor_token),
                           "患者全视图")
        check("患者全视图聚合就诊与报告",
              overview["patient"]["id"] == patient["id"]
              and len(overview["visits"]) >= 1 and len(overview["reports"]) >= 1
              and "today" in overview and "prescriptions" in overview and "stays" in overview,
              json.dumps(overview, ensure_ascii=False))

        search_rows = ok_data(*call("GET", f"/api/v1/patients?q={stamp}&limit=8", token=doctor_token),
                              "患者搜索")
        check("患者搜索 q 参数命中且限制条数",
              any(p["id"] == patient["id"] for p in search_rows) and len(search_rows) <= 8,
              f"got {len(search_rows)}")

        allergy_patient = ok_data(*call("POST", "/api/v1/patients", token=admin_token, body={
            "name": "过敏测试" + stamp, "gender": "女", "birthDate": "1979-02-02",
            "idCard": "440101197902023456", "phone": "13800009999",
            "address": "演示地址", "allergy": "青霉素过敏", "chronicTags": [],
        }), "过敏患者")
        amx = next(d for d in drugs if d["code"] == "AMX")
        dxp = next(d for d in drugs if d["controlled"])
        item_amx = {"drugId": amx["id"], "dosage": "口服", "frequency": "一日三次",
                    "days": 3, "quantity": 1}
        item_normal = {"drugId": normal_drug["id"], "dosage": "口服", "frequency": "一日两次",
                       "days": 3, "quantity": 1}

        rxcheck = ok_data(*call("POST", "/api/v1/rx-check", token=doctor_token, body={
            "patientId": allergy_patient["id"], "items": [item_amx],
        }), "合理用药-过敏")
        check("rx-check 过敏冲突 HIGH",
              any(w["level"] == "HIGH" and w["code"] == "ALLERGY_CONFLICT" for w in rxcheck["warnings"]),
              json.dumps(rxcheck, ensure_ascii=False))

        rxcheck2 = ok_data(*call("POST", "/api/v1/rx-check", token=doctor_token, body={
            "patientId": patient["id"], "items": [item_normal, item_normal],
        }), "合理用药-重复")
        check("rx-check 同单重复 MEDIUM",
              sum(1 for w in rxcheck2["warnings"]
                  if w["level"] == "MEDIUM" and w["code"] == "DUPLICATE_DRUG") == 1,
              json.dumps(rxcheck2, ensure_ascii=False))

        rxcheck3 = ok_data(*call("POST", "/api/v1/rx-check", token=doctor_token, body={
            "patientId": patient["id"],
            "items": [{"drugId": dxp["id"], "dosage": "口服", "frequency": "睡前", "days": 3, "quantity": 1}],
        }), "合理用药-管制")
        check("rx-check 管制药品 INFO",
              any(w["level"] == "INFO" and w["code"] == "CONTROLLED_DRUG" for w in rxcheck3["warnings"]),
              json.dumps(rxcheck3, ensure_ascii=False))

        qc2 = ok_data(*call("GET", f"/api/v1/visits/{vid2}/qc", token=doctor_token), "质控-缺项")
        check("质控识别缺项（体格检查）",
              any(i["code"] == "physical_exam" and not i["ok"] for i in qc2["items"])
              and qc2["passRate"] < 100,
              json.dumps(qc2, ensure_ascii=False))
        qc1 = ok_data(*call("GET", f"/api/v1/visits/{visit_id}/qc", token=doctor_token), "质控-齐全")
        check("质控齐全完整率 100%",
              qc1["passRate"] == 100 and all(i["ok"] for i in qc1["items"]),
              json.dumps(qc1, ensure_ascii=False))

        with open(os.path.join(ROOT, "app", "web", "app.js"), encoding="utf-8") as fh:
            front = fh.read()
        groups = ("门诊业务", "住院留观", "药事管理", "医技与公卫", "运营与系统")
        check("前端导航分组数据齐备",
              all(f"group: '{g}'" in front for g in groups) and "nav-group-head" in front,
              "app.js 缺少分组导航")

        print("\n[6C] 病历可见范围 / 过敏硬阻断 / 账号恢复 / 退费闭环")
        status, payload = call("GET", f"/api/v1/patients/{patient['id']}/visits", token=cashier_token)
        rows_cash = ok_data(status, payload, "收费员就诊历史")
        check("收费员仅获就诊概要（无 EMR/处方明细）",
              len(rows_cash) >= 1
              and all("chiefComplaint" not in r and "presentIllness" not in r
                      and "prescriptions" not in r for r in rows_cash),
              json.dumps(rows_cash, ensure_ascii=False))
        status, payload = call("GET", f"/api/v1/patients/{patient['id']}", token=cashier_token)
        detail_cash = ok_data(status, payload, "收费员患者详情")
        check("收费员患者详情脱敏",
              "*" in detail_cash["name"] and "address" not in detail_cash,
              json.dumps(detail_cash, ensure_ascii=False))
        ov_cash = ok_data(*call("GET", f"/api/v1/patients/{patient['id']}/overview",
                                token=cashier_token), "收费员患者全视图")
        check("收费员全视图不含报告结论与处方明细",
              all(not r.get("conclusion") for r in ov_cash["reports"])
              and all(not p.get("drugNames") for p in ov_cash["prescriptions"]),
              json.dumps(ov_cash, ensure_ascii=False))

        other_doctor_token = login("doctor02")
        status, payload = call("GET", f"/api/v1/visits/{visit_id}", token=other_doctor_token)
        check("非接诊医生读取 EMR 被拒（403 FORBIDDEN）",
              status == 403 and payload.get("code") == "FORBIDDEN", f"{status} {payload}")
        rows_od = ok_data(*call("GET", f"/api/v1/patients/{patient['id']}/visits",
                                token=other_doctor_token), "非接诊医生就诊历史")
        check("非接诊医生仅获就诊概要",
              len(rows_od) >= 1 and all("chiefComplaint" not in r for r in rows_od),
              json.dumps(rows_od, ensure_ascii=False))

        # 过敏患者建立本人接诊，验证开方服务端硬阻断且整单不落库
        ok_data(*call("POST", "/api/v1/schedules/generate", token=admin_token,
                      body={"startDate": today, "days": 7}), "生成排班丙")
        slots3 = ok_data(*call("GET", f"/api/v1/schedules?date={today}&doctorId={doctor_row['id']}",
                               token=admin_token), "查询号源丙")
        open3 = [s for s in slots3 if s["status"] == "OPEN" and s["remaining"] > 0]
        if not open3:
            raise SystemExit("无可用号源，无法继续过敏开方测试")
        reg3 = ok_data(*call("POST", "/api/v1/registrations", token=admin_token, body={
            "patientId": allergy_patient["id"], "slotId": open3[0]["id"], "source": "ONSITE",
        }), "挂号-过敏患者")
        charges3 = ok_data(*call("GET", f"/api/v1/charges?status=UNPAID&date={today}",
                                 token=admin_token), "待收费丙")
        reg3_charge = next(c for c in charges3
                           if c["refType"] == "REGISTRATION" and c["refId"] == reg3["id"])
        ok_data(*call("POST", "/api/v1/charges/pay", token=cashier_token,
                      body={"ids": [reg3_charge["id"]]}), "缴费丙")
        ok_data(*call("POST", f"/api/v1/registrations/{reg3['id']}/checkin", token=nurse_token,
                      body={"temperature": 36.5, "systolic": 110, "diastolic": 70}), "签到丙")
        visit3 = ok_data(*call("POST", "/api/v1/visits", token=doctor_token,
                               body={"registrationId": reg3["id"]}), "接诊丙")
        before_ov = ok_data(*call("GET", f"/api/v1/patients/{allergy_patient['id']}/overview",
                                  token=doctor_token), "过敏患者全视图-前")
        status, payload = call("POST", f"/api/v1/visits/{visit3['id']}/prescriptions",
                               token=doctor_token, body={"items": [item_amx]})
        check("过敏开方硬阻断（400 ALLERGY_CONFLICT）",
              status == 400 and payload.get("code") == "ALLERGY_CONFLICT", f"{status} {payload}")
        after_ov = ok_data(*call("GET", f"/api/v1/patients/{allergy_patient['id']}/overview",
                                 token=doctor_token), "过敏患者全视图-后")
        check("过敏拒绝后不落处方",
              len(after_ov["prescriptions"]) == len(before_ov["prescriptions"]),
              f"{len(before_ov['prescriptions'])} -> {len(after_ov['prescriptions'])}")

        nurse14 = next((s for s in nurses if s["staffNo"] == "N014"), None)
        check("存在无业务依赖护士 N014", nurse14 is not None)
        ok_data(*call("PATCH", f"/api/v1/staff/{nurse14['id']}", token=admin_token,
                      body={"status": "DISABLED"}), "停用账号")
        status, payload = call("POST", "/api/v1/auth/login",
                               body={"username": "nurse14", "password": DEFAULT_PASSWORD})
        check("停用后登录被拒",
              status in (401, 403) and payload.get("code") in ("ACCOUNT_DISABLED", "LOGIN_FAILED"),
              f"{status} {payload}")
        ok_data(*call("PATCH", f"/api/v1/staff/{nurse14['id']}", token=admin_token,
                      body={"status": "ACTIVE"}), "启用账号")
        status, payload = call("POST", "/api/v1/auth/login",
                               body={"username": "nurse14", "password": DEFAULT_PASSWORD})
        check("启用后账号可正常登录", status == 200 and payload.get("code") == "OK",
              f"{status} {payload}")

        # 退费闭环：挂号费直接退费
        ok_data(*call("POST", "/api/v1/schedules/generate", token=admin_token,
                      body={"startDate": today, "days": 7}), "生成排班丁")
        slots4 = ok_data(*call("GET", f"/api/v1/schedules?date={today}&doctorId={doctor_row['id']}",
                               token=admin_token), "查询号源丁")
        open4 = [s for s in slots4 if s["status"] == "OPEN" and s["remaining"] > 0]
        if not open4:
            raise SystemExit("无可用号源，无法继续退费测试")
        reg4 = ok_data(*call("POST", "/api/v1/registrations", token=admin_token, body={
            "patientId": patient2["id"], "slotId": open4[0]["id"], "source": "ONSITE",
        }), "挂号-退费测试")
        charges4 = ok_data(*call("GET", f"/api/v1/charges?status=UNPAID&date={today}",
                                 token=admin_token), "待收费丁")
        reg4_charge = next(c for c in charges4
                           if c["refType"] == "REGISTRATION" and c["refId"] == reg4["id"])
        ok_data(*call("POST", "/api/v1/charges/pay", token=cashier_token,
                      body={"ids": [reg4_charge["id"]]}), "缴费丁")
        refunded_reg = ok_data(*call("POST", f"/api/v1/charges/{reg4_charge['id']}/refund",
                                     token=cashier_token, body={"reason": "患者临时取消就诊"}),
                               "挂号费退费")
        check("退费成功置为 REFUNDED", refunded_reg["status"] == "REFUNDED")
        status, payload = call("POST", f"/api/v1/charges/{reg4_charge['id']}/refund",
                               token=cashier_token, body={"reason": "重复退费尝试"})
        check("重复退费被拒（400 STATE_CONFLICT）",
              status == 400 and payload.get("code") == "STATE_CONFLICT", f"{status} {payload}")
        regs = ok_data(*call("GET", f"/api/v1/registrations?date={today}", token=admin_token), "挂号列表")
        reg4_row = next(r for r in regs if r["id"] == reg4["id"])
        check("挂号费退款联动取消挂号", reg4_row["status"] == "CANCELLED", reg4_row["status"])

        # M-2：取消已缴费挂号自动生成 REFUNDED 记录
        ok_data(*call("POST", "/api/v1/schedules/generate", token=admin_token,
                      body={"startDate": today, "days": 7}), "生成排班戊")
        slots5 = ok_data(*call("GET", f"/api/v1/schedules?date={today}&doctorId={doctor_row['id']}",
                               token=admin_token), "查询号源戊")
        open5 = [s for s in slots5 if s["status"] == "OPEN" and s["remaining"] > 0]
        if not open5:
            raise SystemExit("无可用号源，无法继续取消退费测试")
        reg5 = ok_data(*call("POST", "/api/v1/registrations", token=admin_token, body={
            "patientId": patient2["id"], "slotId": open5[0]["id"], "source": "ONSITE",
        }), "挂号-取消退费")
        charges5 = ok_data(*call("GET", f"/api/v1/charges?status=UNPAID&date={today}",
                                 token=admin_token), "待收费戊")
        reg5_charge = next(c for c in charges5
                           if c["refType"] == "REGISTRATION" and c["refId"] == reg5["id"])
        ok_data(*call("POST", "/api/v1/charges/pay", token=cashier_token,
                      body={"ids": [reg5_charge["id"]]}), "缴费戊")
        ok_data(*call("POST", f"/api/v1/registrations/{reg5['id']}/cancel", token=cashier_token),
                "取消已缴费挂号")
        refunded_list = ok_data(*call("GET", f"/api/v1/charges?status=REFUNDED&date={today}",
                                      token=cashier_token), "退费列表")
        reg5_refund = next((c for c in refunded_list
                            if c["refType"] == "REGISTRATION" and c["refId"] == reg5["id"]), None)
        check("取消已缴费挂号自动退款",
              reg5_refund is not None and reg5_refund["status"] == "REFUNDED",
              json.dumps(refunded_list, ensure_ascii=False))

        # 检查费已出报告不可退；药品费退费联动处方 REFUNDED 与药品回库
        status, payload = call("POST", f"/api/v1/charges/{lab_charge['id']}/refund",
                               token=cashier_token, body={"reason": "检查退费测试"})
        check("已出报告检查费不可退（400）",
              status == 400 and payload.get("code") == "STATE_CONFLICT", f"{status} {payload}")
        drug_refund = ok_data(*call("POST", f"/api/v1/charges/{drug_charge['id']}/refund",
                                    token=cashier_token, body={"reason": "患者要求退药"}),
                              "药品费退费")
        check("药品费退费成功", drug_refund["status"] == "REFUNDED")
        rx_rows = ok_data(*call("GET", f"/api/v1/prescriptions?date={today}", token=pharmacist_token),
                          "处方列表")
        rx_refunded = next((r for r in rx_rows if r["id"] == rx["id"]), None)
        check("已发药退费后处方置 REFUNDED",
              rx_refunded is not None and rx_refunded["status"] == "REFUNDED",
              json.dumps(rx_refunded, ensure_ascii=False))

        print("\n[7] 对外接口（HMAC 签名 / 幂等 / 防重放）")
        app_id, secret = load_credentials()
        (status, payload), _ = signed_call("GET", "/openapi/v1/departments", app_id, secret)
        dept_data = ok_data(status, payload, "签名查询科室")
        check("签名请求通过", len(dept_data) >= 10)

        (status, payload), headers = signed_call(
            "POST", "/openapi/v1/appointments", app_id, secret,
            body={"appointmentId": "SMOKE-" + stamp, "slotId": slot["slotNo"],
                  "patientName": "测试患者", "doctorId": "D001", "departmentId": "QK"},
            idem="smoke-" + stamp)
        order = ok_data(status, payload, "HIS 受理")
        check("返回 CLN 单号", order["hisOrderNo"].startswith("CLN"))
        check("受理非模拟标记", order["mock"] is False and order["source"] == "HIS_LIVE")

        (status, payload), _ = signed_call(
            "POST", "/openapi/v1/appointments", app_id, secret,
            body={"appointmentId": "SMOKE-" + stamp, "slotId": slot["slotNo"],
                  "patientName": "测试患者", "doctorId": "D001", "departmentId": "QK"},
            idem="smoke-" + stamp)
        replay = ok_data(status, payload, "幂等重放")
        check("同 Idempotency-Key 返回原单", replay["hisOrderNo"] == order["hisOrderNo"] and replay["replayed"])

        # 同一请求（含同 nonce）再发一次 → 必须拒绝重放
        retry_status, retry_payload = call(
            "POST", "/openapi/v1/appointments", body={
                "appointmentId": "SMOKE-" + stamp, "doctorId": "D001", "departmentId": "QK"},
            raw=json.dumps({"appointmentId": "SMOKE-" + stamp, "slotId": slot["slotNo"],
                            "patientName": "测试患者", "doctorId": "D001", "departmentId": "QK"},
                           ensure_ascii=False).encode("utf-8"),
            headers=headers)
        check("同 nonce 重放被拒", retry_status == 409 and retry_payload.get("code") == "REPLAY_DETECTED",
              f"{retry_status} {retry_payload}")

        (status, payload), _ = signed_call("GET", f"/openapi/v1/appointments/{order['hisOrderNo']}",
                                           app_id, secret)
        detail = ok_data(status, payload, "查询受理单")
        check("受理单状态 ACCEPTED", detail["status"] == "ACCEPTED")

        (status, payload), _ = signed_call(
            "POST", f"/openapi/v1/appointments/{order['hisOrderNo']}/cancel", app_id, secret,
            body={"reason": "冒烟测试撤销"}, idem="cancel-" + stamp)
        cancel1 = ok_data(status, payload, "撤销受理")
        check("首次撤销 idempotent=false", cancel1["idempotent"] is False)
        (status, payload), _ = signed_call(
            "POST", f"/openapi/v1/appointments/{order['hisOrderNo']}/cancel", app_id, secret,
            body={"reason": "重复撤销"}, idem="cancel2-" + stamp)
        cancel2 = ok_data(status, payload, "重复撤销")
        check("重复撤销幂等成功", cancel2["idempotent"] is True)

        (status, payload), _ = signed_call("GET", "/openapi/v1/doctors", app_id,
                                           "bad-secret-value")
        check("错误密钥被拒", status == 401 and payload.get("code") == "INVALID_SIGNATURE",
              f"{status} {payload}")

        (status, payload), _ = signed_call("GET", "/openapi/v1/doctors", app_id, secret,
                                           timestamp="1000000000")
        check("过期时间戳被拒", status == 401 and payload.get("code") == "INVALID_TIMESTAMP",
              f"{status} {payload}")

        print("\n[8] 加固校验与危急值闭环")
        slots8 = ok_data(*call("GET", f"/api/v1/schedules?date={today}&doctorId={doctor_row['id']}",
                               token=admin_token), "查询号源8")
        open8 = [s for s in slots8 if s["status"] == "OPEN" and s["remaining"] > 0]
        if not open8:
            raise SystemExit("无可用号源，无法执行加固测试")

        def reg_and_pay(pid, slot_id, label):
            r = ok_data(*call("POST", "/api/v1/registrations", token=admin_token, body={
                "patientId": pid, "slotId": slot_id, "source": "ONSITE"}), label + "挂号")
            rows = ok_data(*call("GET", f"/api/v1/charges?status=UNPAID&date={today}",
                                 token=admin_token), label + "账单")
            c = next(x for x in rows if x["refType"] == "REGISTRATION" and x["refId"] == r["id"])
            ok_data(*call("POST", "/api/v1/charges/pay", token=cashier_token, body={"ids": [c["id"]]}),
                    label + "缴费")
            return r, c

        def checkin_ok(reg_id, label):
            return ok_data(*call("POST", f"/api/v1/registrations/{reg_id}/checkin", token=nurse_token,
                                 body={"temperature": 36.7, "systolic": 120, "diastolic": 78, "pulse": 72}),
                           label + "签到")

        # M-6 停用医生不可挂号（号源不扣）
        doctors8 = ok_data(*call("GET", "/api/v1/staff?role=DOCTOR", token=admin_token), "医生列表8")
        doc2 = next((s for s in doctors8 if s["staffNo"] == "D002"), None)
        check("存在医生 D002", doc2 is not None)
        slots_d2 = ok_data(*call("GET", f"/api/v1/schedules?date={today}&doctorId={doc2['id']}",
                                 token=admin_token), "D002 号源")
        open_d2 = [s for s in slots_d2 if s["status"] == "OPEN" and s["remaining"] > 0]
        ok_data(*call("PATCH", f"/api/v1/staff/{doc2['id']}", token=admin_token,
                      body={"status": "DISABLED"}), "停用医生")
        status, payload = call("POST", "/api/v1/registrations", token=admin_token, body={
            "patientId": patient2["id"], "slotId": open_d2[0]["id"], "source": "ONSITE"})
        check("停用医生不可挂号（400 DOCTOR_UNAVAILABLE）",
              status == 400 and payload.get("code") == "DOCTOR_UNAVAILABLE", f"{status} {payload}")
        ok_data(*call("PATCH", f"/api/v1/staff/{doc2['id']}", token=admin_token,
                      body={"status": "ACTIVE"}), "恢复医生")

        # M-7 分诊体征超范围拒绝
        reg7, _ = reg_and_pay(patient2["id"], open8[0]["id"], "体征测试")
        status, payload = call("POST", f"/api/v1/registrations/{reg7['id']}/checkin",
                               token=nurse_token, body={"temperature": 55, "systolic": 120, "diastolic": 78})
        check("体征超范围被拒（400 INVALID_VITALS）",
              status == 400 and payload.get("code") == "INVALID_VITALS", f"{status} {payload}")

        # 危急值报告 → 工作台告警 → 报告回写（同一就诊闭环）
        reg6, charge6 = reg_and_pay(patient["id"], open8[0]["id"], "闭环")
        checkin_ok(reg6["id"], "闭环")
        visit4 = ok_data(*call("POST", "/api/v1/visits", token=doctor_token,
                               body={"registrationId": reg6["id"]}), "接诊闭环")
        vid4 = visit4["id"]
        ok_data(*call("PATCH", f"/api/v1/visits/{vid4}", token=doctor_token,
                      body={"chiefComplaint": "乏力 1 天"}), "保存主诉闭环")
        lab_items = ok_data(*call("GET", "/api/v1/lab-items", token=doctor_token), "检查项目")
        k_item = next(i for i in lab_items if i["name"] == "血钾")
        check("血钾已配置危急值阈值",
              k_item["criticalLow"] == 3.5 and k_item["criticalHigh"] == 5.5,
              json.dumps(k_item, ensure_ascii=False))
        orders4 = ok_data(*call("POST", f"/api/v1/visits/{vid4}/lab-orders", token=doctor_token,
                                body={"items": [k_item["code"]]}), "开血钾")
        k_order = orders4["orders"][0]["id"]
        ok_data(*call("POST", f"/api/v1/lab-orders/{k_order}/sample", token=tech_token), "血钾采样")
        rep = ok_data(*call("POST", f"/api/v1/lab-orders/{k_order}/report", token=tech_token, body={
            "findings": "血钾 6.2 mmol/L（参考 3.5~5.5）", "conclusion": "高钾血症，危急值",
            "abnormal": True, "value": 6.2}), "血钾报告")
        check("危急值报告 critical=true", rep.get("critical") is True,
              json.dumps(rep, ensure_ascii=False))

        wb = ok_data(*call("GET", "/api/v1/workbench", token=doctor_token), "医生工作台")
        check("工作台出现危急值告警",
              any("危急值" in a["message"] for a in wb["alerts"]),
              json.dumps(wb["alerts"], ensure_ascii=False))
        check("工作台出现危急值待办",
              any(t["key"] == "criticalReports" and t["count"] >= 1 for t in wb["todos"]),
              json.dumps(wb["todos"], ensure_ascii=False))

        reports4 = ok_data(*call("GET", f"/api/v1/visits/{vid4}/reports", token=doctor_token), "就诊报告")
        check("就诊报告接口返回危急值报告",
              any(r["id"] == k_order and r["critical"] and "高钾" in r["conclusion"] for r in reports4),
              json.dumps(reports4, ensure_ascii=False))

        ok_data(*call("PATCH", f"/api/v1/visits/{vid4}", token=doctor_token,
                      body={"auxiliaryExam": "[血钾] 高钾血症，危急值"}), "引用报告回写")
        v4 = ok_data(*call("GET", f"/api/v1/visits/{vid4}", token=doctor_token), "读取闭环病历")
        check("报告结论回写辅助检查", "高钾血症" in v4["auxiliaryExam"], v4["auxiliaryExam"])

        # M-4 无诊断开方不能完成（EMR_INCOMPLETE 列出缺项）
        ok_data(*call("POST", f"/api/v1/visits/{vid4}/prescriptions", token=doctor_token, body={
            "items": [{"drugId": normal_drug["id"], "dosage": "口服", "frequency": "一日三次",
                       "days": 3, "quantity": 1}]}), "闭环处方")
        status, payload = call("POST", f"/api/v1/visits/{vid4}/finish", token=doctor_token)
        check("无诊断开方不能完成（400 EMR_INCOMPLETE）",
              status == 400 and payload.get("code") == "EMR_INCOMPLETE"
              and "诊断" in payload.get("message", ""), f"{status} {payload}")

        # M-5 未完成就诊审方被拒
        rxs4 = ok_data(*call("GET", f"/api/v1/prescriptions?date={today}", token=pharmacist_token),
                       "闭环处方列表")
        rx4 = next(r for r in rxs4 if r["visitId"] == vid4)
        status, payload = call("POST", f"/api/v1/prescriptions/{rx4['id']}/review",
                               token=pharmacist_token,
                               body={"decision": "APPROVE", "comment": "测试"})
        check("未完成就诊审方被拒（400 VISIT_NOT_FINISHED）",
              status == 400 and payload.get("code") == "VISIT_NOT_FINISHED", f"{status} {payload}")

        # m-1 诊断备注可清空
        ok_data(*call("POST", f"/api/v1/visits/{vid4}/diagnoses", token=doctor_token,
                      body={"code": "J11.1", "isPrimary": True, "note": "初始说明"}), "闭环诊断")
        ok_data(*call("POST", f"/api/v1/visits/{vid4}/diagnoses", token=doctor_token,
                      body={"code": "J11.1", "note": ""}), "清空诊断备注")
        v4 = ok_data(*call("GET", f"/api/v1/visits/{vid4}", token=doctor_token), "读取诊断备注")
        check("诊断备注可清空", v4["diagnoses"][0]["note"] == "",
              json.dumps(v4["diagnoses"], ensure_ascii=False))

        ok_data(*call("POST", f"/api/v1/visits/{vid4}/finish", token=doctor_token), "完成闭环就诊")

        # M-3 更正诊断编码须同步主诊断行
        ok_data(*call("POST", f"/api/v1/visits/{vid4}/amendments", token=doctor_token, body={
            "reason": "诊断编码更正测试", "changes": {"diagnosisCode": "R05"}}), "更正诊断")
        v4 = ok_data(*call("GET", f"/api/v1/visits/{vid4}", token=doctor_token), "读取更正病历")
        primary4 = next(d for d in v4["diagnoses"] if d["isPrimary"])
        check("更正诊断同步主表与 diagnoses",
              v4["diagnosisCode"] == "R05" and primary4["code"] == "R05",
              json.dumps({"code": v4["diagnosisCode"], "primary": primary4}, ensure_ascii=False))

        # M-10 重复收费被拒
        status, payload = call("POST", "/api/v1/charges/pay", token=cashier_token,
                               body={"ids": [charge6["id"]]})
        check("重复收费被拒（400 STATE_CONFLICT）",
              status == 400 and payload.get("code") == "STATE_CONFLICT", f"{status} {payload}")

        # M-12 出区后不可补录体征
        status, payload = call("POST", "/api/v1/nursing-records", token=nurse_token, body={
            "patientId": patient2["id"], "stayId": stay["id"], "temperature": 36.8})
        check("出区后记体征被拒（400 STATE_CONFLICT）",
              status == 400 and payload.get("code") == "STATE_CONFLICT", f"{status} {payload}")

        # M-11 已叫号再叫被拒 / force 自动过号
        reg8, _ = reg_and_pay(patient["id"], open8[0]["id"], "叫号甲")
        reg9, _ = reg_and_pay(patient2["id"], open8[0]["id"], "叫号乙")
        checkin_ok(reg8["id"], "叫号甲")
        checkin_ok(reg9["id"], "叫号乙")
        called1 = ok_data(*call("POST", "/api/v1/queue/call-next", token=nurse_token,
                                body={"deptId": slot["deptId"]}), "叫号甲")
        check("首次叫号成功", called1.get("called") is not None,
              json.dumps(called1, ensure_ascii=False))
        status, payload = call("POST", "/api/v1/queue/call-next", token=nurse_token,
                               body={"deptId": slot["deptId"]})
        check("已叫号再叫被拒（409 CALL_IN_PROGRESS）",
              status == 409 and payload.get("code") == "CALL_IN_PROGRESS", f"{status} {payload}")
        called2 = ok_data(*call("POST", "/api/v1/queue/call-next", token=nurse_token,
                                body={"deptId": slot["deptId"], "force": True}), "强制叫号")
        check("force=true 自动过号并继续叫号", called2.get("called") is not None,
              json.dumps(called2, ensure_ascii=False))

        print(f"\n结果：通过 {passed} 项，失败 {failed} 项")
        return 0 if failed == 0 else 1
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
