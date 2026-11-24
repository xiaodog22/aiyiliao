#!/usr/bin/env bash
# HIS 管理端批量截图（agent-browser + 系统 Chrome）
# 关键：daemon 随工具 shell 回收，故登录+遍历+截图必须在单次调用内完成。
# Token 存 sessionStorage，用 location.hash 切视图不重载即可保持登录态。
# 命名规则：序号-中文页面名.png（按页面名称清晰命名）
set -u
export AGENT_BROWSER_EXECUTABLE_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe"
ROOT="D:/asr_chaoshanhua/asr_chaoshanhua_V01/_V01/wechar"
OUT="$ROOT/artifacts/page-atlas/08-HIS管理端"
mkdir -p "$OUT"

# 登录（admin06 口令已还原为种子轮换值；mustChange=false）
agent-browser open "http://127.0.0.1:8310/" >/dev/null 2>&1
sleep 1
agent-browser type "#login-username" "admin06" >/dev/null 2>&1
agent-browser type "#login-password" 'YJk*CjgcR-3+rx5@' >/dev/null 2>&1
agent-browser click "#login-form button[type=submit]" >/dev/null 2>&1
sleep 2

# 若仍有强制改密弹窗则取消（保险，不改口令）
if agent-browser snapshot 2>/dev/null | grep -q "修改口令"; then
  agent-browser click "#modal-cancel" >/dev/null 2>&1
  sleep 1
fi

# 视图清单：hash key|中文文件名(不含扩展名)|中文页面名|页面说明
VIEWS=(
  "dashboard|01-工作台|工作台|全院运营概览、我的待办（危急值/异常检查/公卫任务告警）与运营统计卡片"
  "registration|02-挂号登记|挂号登记|按就诊日+患者+科室+号源挂号、状态筛选与撤销"
  "queue|03-分诊叫号|分诊叫号|患者签到、按就诊日全局流水叫号（JZ001…）、过号/重呼"
  "doctor|04-医生工作站|医生工作站|接诊、病历全文、诊断、开立处方与检查、处置"
  "charge|05-收费管理|收费管理|挂号/处方/检查计费，收费、退费、作废与流水查询"
  "beds|06-留观床位|留观床位|床位总览，开立/转床/出区/保洁，床位申请审批"
  "nursing|07-护理执行|护理执行|执行医嘱、记录体征、取消医嘱（权限隔离）"
  "pharmacy|08-处方审方|处方审方|药师审核处方、发药、退回，药品库存联动"
  "drugs|09-药品库存|药品库存|药品目录与库存查询、入库、盘点、效期预警"
  "patients|10-患者档案|患者档案|患者建档、检索（姓名/病历号/手机尾号）、全就诊史概览"
  "lab|11-医技检查|医技检查|检查项目开立、采样登记、报告录入与查阅"
  "ph|12-公共卫生|公共卫生|传染病上报、慢病随访、公卫报表"
  "reports|13-统计报表|统计报表|就诊量/收入/处方等多维统计报表"
  "staff|14-人员与排班|人员与排班|职工账号管理、科室排班维护、启用/停用"
  "system|15-系统管理|系统管理|合规自检（8 项控制点）、审计日志、对接密钥、口令策略"
)

OK=0; TOTAL=${#VIEWS[@]}
JSON="$OUT/manifest.json"
printf '[\n' > "$JSON"
first=1
for item in "${VIEWS[@]}"; do
  IFS='|' read -r key fname cname desc <<< "$item"
  agent-browser eval "location.hash='#/$key'" >/dev/null 2>&1
  sleep 1.8
  shot="$OUT/$fname.png"
  agent-browser screenshot --full "$shot" >/dev/null 2>&1
  if [ -f "$shot" ]; then
    size=$(wc -c < "$shot")
    [ $first -eq 0 ] && printf ',\n' >> "$JSON"; first=0
    printf '  {"seq":"%s","key":"%s","pageName":"%s","desc":"%s","file":"%s.png","bytes":%s,"url":"http://127.0.0.1:8310/#/%s"}' \
      "${fname%%-*}" "$key" "$cname" "$desc" "$fname" "$size" "$key" >> "$JSON"
    echo "OK | $fname | $cname | ${size}B"
    OK=$((OK+1))
  else
    echo "FAIL | $fname | $cname"
  fi
done
printf '\n]\n' >> "$JSON"

echo "RESULT: $OK/$TOTAL -> $OUT"
agent-browser close >/dev/null 2>&1
