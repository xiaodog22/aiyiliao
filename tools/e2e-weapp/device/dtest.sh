#!/usr/bin/env bash
# 真机测试操作助手（只做动作与取证，不含业务断言）
# 用法：
#   dtest.sh cap <name>                 截图
#   dtest.sh tap <x> <y> <name> [wait]  点击并截图，wait 默认 1.2 秒（坐标为设备像素）
#   dtest.sh tapv <x> <y> <name> [wait] 点击并截图（坐标为看图器缩放后的坐标，自动换算）
#   dtest.sh back <name> [wait]         返回键并截图
#   dtest.sh input <text>               输入 ASCII 文本
#   dtest.sh focus                      打印当前焦点窗口
# 证据目录由环境变量 E2E_DEV_DIR 指定，默认 artifacts/e2e-weapp/device-current
#
# ⚠️ 坐标铁律（2026-11-14 更正）：截图是 1080×2400 全分辨率，但看图器会缩放到约 480 宽。
#   在看图器里量出来的 y 必须 ×(1080/显示宽度) ≈ 2.25 才是设备像素，**不能加固定 ±50 补偿**。
#   之前"D-20 热区偏下 46px"的结论里混入了这个换算误差，凡坐标类缺陷都要用 tapv 复测确认。
set -u
export MSYS_NO_PATHCONV=1
ADB="/d/OpenWeChar/微信web开发者工具/bin/adb-win/adb.exe"
DIR="${E2E_DEV_DIR:-artifacts/e2e-weapp/device-current}"
VIEW_W="${E2E_VIEW_W:-480}"   # 看图器显示宽度；设备实际宽度用 wm size 取
mkdir -p "$DIR"

DEV_W=$("$ADB" shell wm size 2>/dev/null | sed -n 's/.*Physical size: \([0-9]*\)x.*/\1/p')
DEV_W="${DEV_W:-1080}"

_cap() {
  local name="$1" i ok=""
  for i in 1 2 3; do
    "$ADB" shell screencap -p /sdcard/_dt.png >/dev/null 2>&1
    if "$ADB" pull /sdcard/_dt.png "$DIR/$name.png" >/dev/null 2>&1 && [ -s "$DIR/$name.png" ]; then ok=1; break; fi
    sleep 0.6
  done
  if [ -n "$ok" ]; then echo "cap: $DIR/$name.png"; else echo "cap FAILED: $name"; return 1; fi
}

case "${1:-}" in
  cap)  _cap "$2" ;;
  tap)
    x="$2"; y="$3"; name="$4"; wait="${5:-1.2}"
    "$ADB" shell input tap "$x" "$y" >/dev/null 2>&1
    sleep "$wait"
    _cap "$name"
    ;;
  tapv)
    # 看图器坐标 → 设备像素：x*ratio, y*ratio
    x=$(awk -v v="$2" -v r="$DEV_W" -v w="$VIEW_W" 'BEGIN{printf "%d", v*r/w}')
    y=$(awk -v v="$3" -v r="$DEV_W" -v w="$VIEW_W" 'BEGIN{printf "%d", v*r/w}')
    name="$4"; wait="${5:-1.2}"
    echo "tapv: view($2,$3) -> dev($x,$y)"
    "$ADB" shell input tap "$x" "$y" >/dev/null 2>&1
    sleep "$wait"
    _cap "$name"
    ;;
  back)
    name="$2"; wait="${3:-1.2}"
    "$ADB" shell input keyevent 4 >/dev/null 2>&1
    sleep "$wait"
    _cap "$name"
    ;;
  input)
    # 逐字符输入，规避 adb input text 粘包丢字符
    s="$2"
    for (( i=0; i<${#s}; i++ )); do
      "$ADB" shell input text "${s:i:1}" >/dev/null 2>&1
    done
    echo "input done: $s"
    ;;
  focus)
    "$ADB" shell "dumpsys window | grep -E 'mCurrentFocus'" 2>&1 | head -2
    ;;
  *)
    echo "usage: dtest.sh cap|tap|back|input|focus ..." >&2
    exit 2
    ;;
esac
