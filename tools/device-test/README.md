# device-test —— 基于 adb 的真机用例执行器

真机维度验证：**连接设备 → 触发功能路径 → 采集截图/日志/接口响应 → 断言 → 出报告**。
只依赖 adb，不依赖微信开发者工具、不注入 JS、不改小程序代码。

## 与 `tools/e2e-weapp` 的分工

| 套件 | 维度 | 依赖 | 断言能力 |
| --- | --- | --- | --- |
| `tools/e2e-weapp` | 开发者工具 / 协议层 | `miniprogram-automator`、JMeter | WXML 结构、网关压测 |
| `tools/device-test`（本目录） | **真机** | adb + USB 调试 | 截图非空、logcat 无崩溃、真实接口字段 |

两者互补，不能互相替代：开发者工具不渲染真机 GPU/触控，协议压测不覆盖页面行为。

## 前置条件

| 项 | 要求 | 不满足时 |
| --- | --- | --- |
| adb | `ADB_PATH` 指定，或本机 `D:\OpenWeChar\微信web开发者工具\bin\adb-win\adb.exe`，或 PATH | 退出码 2（SKIP） |
| 设备 | USB 调试已授权，`adb devices` 显示 `device` | 退出码 2（SKIP） |
| 小程序 | 已打开到目标页（微信「最近使用」/扫码进入） | 断言会失败，按实际结果记 |
| token | `DEVICE_TEST_TOKEN`（联调会话 Bearer） | 接口断言 SKIP，不伪造 |

## 用法

```bash
# 看有哪些用例
node tools/device-test/run.js --list

# 跑一个用例（默认第一台 device 设备）
node tools/device-test/run.js --case appointment-demo

# 指定设备 + 带 token（接口断言才会真正执行）
node tools/device-test/run.js --case his-booking-fields --serial <serial> --token <bearer>

# 覆盖 adb 路径 / 输出目录
ADB_PATH=/d/.../adb.exe node tools/device-test/run.js --case appointment-demo --out ./artifacts/device-test
```

退出码：`0` 全 PASS 或仅含 SKIP；`1` 有 FAIL；`2` 环境不可用（SKIP，**不当作通过**）。

## 用例 schema

```jsonc
{
  "name": "case-name",
  "description": "这条用例证明什么",
  "steps": [
    { "type": "wait",        "ms": 800 },
    { "type": "wake",        "waitMs": 500 },
    { "type": "tap",         "x": 540, "y": 1800, "waitMs": 1200 },       // 设备像素
    { "type": "tapRatio",    "x": 0.5, "y": 0.75, "waitMs": 1200 },       // 相对坐标（0~1），跨分辨率
    { "type": "swipe",       "x1": 0.5, "y1": 0.8, "x2": 0.5, "y2": 0.3, "ratio": true },
    { "type": "input",       "text": "13800138001" },                     // 仅 ASCII
    { "type": "keyevent",    "code": 4 },
    { "type": "shot",        "name": "03-预约页" },
    { "type": "assertScreenshot", "name": "04-非空白", "minBytes": 20000 },
    { "type": "assertLogcat", "pattern": "FATAL EXCEPTION|ANR in com.tencent.mm", "absent": true },
    { "type": "assertHttp",  "method": "GET", "path": "/api/v1/appointments/me",
      "expectStatus": 200, "expectBodyContains": ["bookingSource"],
      "skipIfNoToken": true, "skipIfBodyMatches": "\"data\":\\s*\\[\\s*\\]" }
  ]
}
```

`assertLogcat` 会把完整 logcat 落到证据目录；`assertHttp` 会把响应体落盘；
每次运行生成 `report.json` + `report.md` + 截图，目录为
`artifacts/device-test/<case>-<yyyyMMdd-HHmmss>/`。

## 三条硬规矩

1. **不伪造**：无设备/无 token 一律 SKIP，退出码 2；不把「没跑到」写成 PASS。
2. **坐标不靠肉眼量图**：截图是设备全分辨率，看图器会缩放（系数 2.03~2.25 浮动）。
   一律用 `tapRatio` 传相对坐标，或先用 `adb shell wm size` 拿物理尺寸再换算。
3. **小程序无节点树**：`uiautomator dump` 在小程序页只有一层 FrameLayout，拿不到文字节点。
   文本类断言只能走接口字段（`assertHttp`）或既有 `device/ocr.ps1`，不要指望 `dump` 出文案。

## 已知坑

- `exec-out screencap` 在部分老设备会产生 CRLF 损坏；本执行器已校验 PNG 魔数，失败自动回退
  `screencap` + `pull`。
- `adb shell input text` 不支持中文；输入中文需切输入法或用剪贴板方案（未内置）。
- 微信进程名在不同版本可能是 `com.tencent.mm` 或 `com.tencent.mm:push`；`assertLogcat` 的正则
  按需调整，不要写死单一进程名。
- 本目录不参与 `check-project.js` 的主包体积统计；但仍在全仓禁址扫描范围内，禁止写入
  任何字面后端地址/端口（网关一律从 `miniprogram/config/env.js` 解析）。
