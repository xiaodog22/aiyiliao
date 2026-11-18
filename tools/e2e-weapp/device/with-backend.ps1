<#
  with-backend.ps1 —— 真机测试的"后端保活"包装器

  背景（不是设计缺陷，是环境约束）：本仓库的后端进程随工具调用结束被回收，
  而真机小程序走公网隧道域名（config/env.js 的 development gateway），
  隧道又依赖 127.0.0.1:8080 在监听。于是"先起后端、下一条命令再点手机"必然失败。
  本脚本把"确保后端在跑 + 执行一串设备步骤"放进同一次调用。

  用法：
    .\with-backend.ps1 -Steps "key:4;wait:1;tap:942,2258;wait:2;cap:p1"

  ⚠️ 三个已踩过的坑（改这个脚本前先看，别重复踩）：
    1) 不要用 & / . 在本进程里调用 orchestrator.ps1 后继续跑后续步骤 —— 它末尾有 `exit`，
       会连带结束调用方进程，表现为"设备步骤一条都没执行、也没报错"。这里改成
       cmd.exe /c powershell -File orchestrator.ps1，起独立子进程，只取退出码。
    2) 本会话环境里同时存在 HTTPS_PROXY 和 https_proxy 两个键（大小写重复），
       直接复用 $env 传给 Start-Process 会抛 "已存在同名键"，导致服务根本起不来。
       处理方式：构造 ProcessStartInfo 时逐键去重（见 Start-Service 段落）。
    3) 隧道域名报 HTTP 000 时，先查 8088/8080 有没有在监听，再查 phtunnel 进程 ——
       后端没起时域名同样是 000，"隧道坏了"是最容易误判的一条。

  步骤语法（分号分隔）：
    tap:x,y      点击（设备像素坐标）
    key:N        按键，4=返回
    wait:N       等待 N 秒
    cap:name     截图到 $DevDir/name.png
    b64:文本     用 ADBKeyboard 以 base64 广播输入（绕开中文编码问题）
    swipe:x1,y1,x2,y2[,ms]
    sleep 与 wait 等价
    http:METHOD|PATH|BODY   本机直连 business:8088（自动带 Bearer 与契约头），用于"起服务→验接口"一次跑完

  参数：
    -Steps      步骤串
    -DevDir     截图目录（默认 artifacts/e2e-weapp/device-current）
    -Serial     设备序列号（默认取 adb devices 第一台）
    -SkipStart  跳过启动后端（仅本机联调已确认在跑时用）
#>
param(
    [Parameter(Mandatory = $true)][string]$Steps,
    [string]$DevDir = 'artifacts/e2e-weapp/device-current',
    [string]$Serial = '',
    [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$adb = 'D:\OpenWeChar\微信web开发者工具\bin\adb-win\adb.exe'
if (-not (Test-Path $adb)) { throw "未找到 adb：$adb" }

function Get-Serial {
    if ($Serial) { return $Serial }
    # adb 首次拉起 daemon 会把 "* daemon not running" 写到 stderr；脚本顶部是
    # $ErrorActionPreference='Stop'，stderr 会被包装成 NativeCommandError 直接终止脚本
    # （表现为「设备步骤一条都没跑，只报 daemon not running」）。这段必须临时放宽。
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & $adb devices 2>$null | Select-Object -Skip 1
    } finally {
        $ErrorActionPreference = $prev
    }
    foreach ($l in $lines) {
        if ($l -match '^(\S+)\s+device$') { return $matches[1] }
    }
    throw '没有处于 device 状态的设备'
}

function Test-Port([int]$port) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $port)
        $c.Close()
        return $true
    } catch { return $false }
}

$s = Get-Serial
Write-Output "device=$s"

if (-not $SkipStart) {
    if (-not (Test-Port 8088) -or -not (Test-Port 8080)) {
        Write-Output 'backend: 未在运行，启动中…'
        # 两个坑：
        # ① orchestrator.ps1 末尾有 exit，同进程 & 调会把调用方一起结束 → 必须走子进程；
        # ② 当前会话环境里 HTTPS_PROXY / https_proxy 大小写重复，Start-Process 构建环境字典会抛异常
        #    （-UseNewEnvironment 也躲不开）→ 改用 cmd.exe 起子进程，只取退出码。
        $orch = Join-Path $root 'backend\deploy\scripts\orchestrator.ps1'
        $log = Join-Path $env:TEMP 'e2e-orchestrator.log'
        $cmdLine = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $orch + '" -Action start > "' + $log + '" 2>&1'
        & cmd.exe /c $cmdLine | Out-Null
        Write-Output ("backend: orchestrator exit=" + $LASTEXITCODE)
    }
    $up = (Test-Port 8088) -and (Test-Port 8080)
    Write-Output ("backend: " + $(if ($up) { 'ready' } else { 'NOT READY' }))
    # 隧道路由自检（只为提示，不阻断）
    # 2026-11-18（审计 H8）：隧道域名不入库，从环境变量 WECHAR_TUNNEL_BASE 读；未设置则跳过。
    if ($env:WECHAR_TUNNEL_BASE) {
        $code = & curl.exe -s -o NUL -w '%{http_code}' --noproxy '*' --max-time 8 ($env:WECHAR_TUNNEL_BASE.TrimEnd('/') + '/health')
        Write-Output "tunnel: HTTP $code"
    } else {
        Write-Output "tunnel: skipped (WECHAR_TUNNEL_BASE not set)"
    }
}

if (-not (Test-Path $DevDir)) { New-Item -ItemType Directory -Path $DevDir -Force | Out-Null }
$DevDir = (Resolve-Path $DevDir).Path

foreach ($raw in $Steps.Split(';')) {
    $step = $raw.Trim()
    if (-not $step) { continue }
    $k, $v = $step.Split(':', 2)
    switch ($k.ToLower()) {
        'tap' {
            $p = $v.Split(',')
            & $adb -s $s shell input tap $p[0].Trim() $p[1].Trim() | Out-Null
            Write-Output "tap $($p[0]),$($p[1])"
        }
        'key' {
            & $adb -s $s shell input keyevent $v.Trim() | Out-Null
            Write-Output "key $v"
        }
        { $_ -in 'wait', 'sleep' } {
            Start-Sleep -Seconds ([double]$v)
        }
        'swipe' {
            $p = $v.Split(',')
            $ms = if ($p.Count -ge 5) { $p[4].Trim() } else { '320' }
            & $adb -s $s shell input swipe $p[0].Trim() $p[1].Trim() $p[2].Trim() $p[3].Trim() $ms | Out-Null
            Write-Output "swipe $v"
        }
        'b64' {
            $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v))
            & $adb -s $s shell am broadcast -a ADB_INPUT_B64 --es msg $b | Out-Null
            Write-Output ("b64 input " + [Text.Encoding]::UTF8.GetByteCount($v) + " bytes")
        }
        'cap' {
            $f = Join-Path $DevDir ($v.Trim() + '.png')
            & $adb -s $s shell screencap -p /sdcard/_e2e_cap.png | Out-Null
            & $adb -s $s pull /sdcard/_e2e_cap.png $f | Out-Null
            if (Test-Path $f) { Write-Output "cap: $f" } else { Write-Output "cap FAILED: $v" }
        }
        # http:METHOD|PATH|BODY  —— 本机直连 business(8088)，自动带会话与契约头。
        # 为什么需要它：后端进程随工具调用结束被回收，而"起服务 → 调接口 → 看结果"
        # 必须在同一次调用里完成；用 curl 单开一条命令必然连不上。
        # 例：http:PUT|/api/v1/voice/voices/default|{"voiceId":"qwen3-male-1","rate":1}
        'http' {
            $parts = $v.Split('|')
            $method = $parts[0].Trim().ToUpper()
            $path = $parts[1].Trim()
            $body = if ($parts.Count -ge 3) { $parts[2] } else { $null }
            $tokenFile = Join-Path $root 'artifacts\e2e-weapp\_token.txt'
            $token = if (Test-Path $tokenFile) { (Get-Content $tokenFile -Raw).Trim() } else { '' }
            $hd = @{
                'X-Client-Version' = '4.0.0'
                'X-Platform'       = 'wechat-miniprogram'
                'Idempotency-Key'  = 'e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
            }
            if ($token) { $hd['Authorization'] = "Bearer $token" }
            $uri = 'http://127.0.0.1:8088' + $path
            try {
                # GET/DELETE 不能带 ContentType+Body（Invoke-WebRequest 会抛
                # 「无法发送具有此谓词类型的内容正文」并把 code 记成 0，看起来像接口挂了）。
                $hasBody = ($body -ne $null -and "$body".Trim() -ne '' -and $method -in @('POST', 'PUT', 'PATCH'))
                if ($hasBody) {
                    $resp = Invoke-WebRequest -UseBasicParsing -Method $method -Uri $uri -Headers $hd `
                        -ContentType 'application/json' -Body $body -TimeoutSec 20
                } else {
                    $resp = Invoke-WebRequest -UseBasicParsing -Method $method -Uri $uri -Headers $hd -TimeoutSec 20
                }
                $txt = $resp.Content
                if ($txt.Length -gt 400) { $txt = $txt.Substring(0, 400) + '…' }
                Write-Output ("http " + $method + " " + $path + " -> " + [int]$resp.StatusCode + " " + $txt)
            } catch {
                $code = 0
                if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
                $msg = $_.ErrorDetails.Message
                if (-not $msg) { $msg = $_.Exception.Message }
                if ($msg -and $msg.Length -gt 400) { $msg = $msg.Substring(0, 400) + '…' }
                Write-Output ("http " + $method + " " + $path + " -> " + $code + " " + $msg)
            }
        }
        default { Write-Output "skip step: $step" }
    }
}
