<#
  guardian-launch.ps1 — 守护进程的启动/停止/状态入口（脱离会话）

  bat 入口（start/stop/status-guardian.bat）只做薄封装调用本脚本。
  所有 PowerShell 逻辑集中在此（含中文 → 必须 UTF-8 BOM，本文件首字节即 BOM），
  避免 bat 里用 -Command + ^ 续行时中文被拆断的解析问题。

  常驻原理：用 explorer.exe 拉起 guardian-run.bat，进程挂在资源管理器下，
  不随调用方的终端/Agent 会话结束而消失（schtasks 被安全中心拦截，计划任务不可用）。
#>
param(
    [switch]$Start,
    [switch]$Stop,
    [switch]$Status
)

$ErrorActionPreference = "Stop"
$DeployDir = Split-Path -Parent $PSScriptRoot
$RunDir    = Join-Path $DeployDir "run"
$PidPath   = Join-Path $RunDir "guardian.pid"
$RunBat    = Join-Path $DeployDir "guardian-run.bat"
$LogPath   = Join-Path $DeployDir "logs\guardian.log"
$GuardPs1  = Join-Path $PSScriptRoot "guardian.ps1"
$psExe     = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

# 环境归一：本机环境块同时存在 HTTPS_PROXY 与 https_proxy、HTTP_PROXY 与 http_proxy。
# PowerShell 5.1 在 Start-Process 需要重建环境块（尤其是带 -RedirectStandardOutput）时
# 会抛「已添加项。字典中的关键字…」并直接失败 —— 表现为「点了按钮没反应」。
# 与 orchestrator.ps1 / gui.ps1 同一处置，且不依赖调用方是否已清理。
try {
    . (Join-Path $PSScriptRoot "deploy-common.ps1")
    Remove-CaseDuplicateEnv
} catch {
    Write-Host ("[guardian] 环境归一失败（不影响本次启动）：" + $_.Exception.Message)
}

function Test-GuardAlive {
    if (-not (Test-Path -LiteralPath $PidPath)) { return $false }
    $id = 0
    if (-not [int]::TryParse(((Get-Content -LiteralPath $PidPath -Raw -ErrorAction SilentlyContinue).Trim()), [ref]$id)) { return $false }
    try { return ($null -ne (Get-Process -Id $id -ErrorAction Stop)) } catch { return $false }
}

if ($Start) {
    if (Test-GuardAlive) {
        Write-Host "[guardian] 守护已在运行，跳过重复启动。"
        exit 0
    }
    if (-not (Test-Path -LiteralPath $RunBat)) { Write-Host "[guardian] 缺少 $RunBat"; exit 2 }

    # 清掉可能残留的 pid：guardian.ps1 有「pid 存活则跳过」的防重复逻辑，
    # 若旧 pid 恰好被无关进程复用，会把这次启动直接吞掉。
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    $LaunchLog = Join-Path $DeployDir "logs\guardian-launch.log"
    Remove-Item -LiteralPath $LaunchLog -Force -ErrorAction SilentlyContinue

    # 关键：explorer.exe 拉起 → 挂资源管理器，脱离本会话（与 start-all.bat 同源，2026-11-15 实测）
    Start-Process -FilePath explorer.exe -ArgumentList ('"' + $RunBat + '"') | Out-Null

    # 主动确认：轮询 pid 文件（guardian.ps1 在首轮巡检前就写 pid，通常 1~3 秒）
    $ok = $false
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-GuardAlive) { $ok = $true; break }
    }
    if ($ok) {
        $procId = (Get-Content -LiteralPath $PidPath -Raw).Trim()
        Write-Host ("[guardian] 启动成功，常驻 PID " + $procId + "（已脱离本会话，关闭本窗口不影响守护）")
        exit 0
    }

    Write-Host "[guardian] 启动失败：12 秒内未出现守护进程。"
    if (Test-Path -LiteralPath $LaunchLog) {
        Write-Host "[guardian] logs\guardian-launch.log 末尾内容："
        Get-Content -LiteralPath $LaunchLog -Tail 20 -Encoding UTF8 | ForEach-Object { Write-Host ("    " + $_) }
    } else {
        Write-Host "[guardian] 未生成 logs\guardian-launch.log —— explorer 未能执行 guardian-run.bat。"
        Write-Host "[guardian] 请改用前台方式定位报错（会直接打印原因）："
        Write-Host ("    powershell -NoProfile -ExecutionPolicy Bypass -File `"" + $GuardPs1 + "`"")
    }
    exit 1
}

if ($Stop) {
    if (-not (Test-Path -LiteralPath $PidPath)) { Write-Host "[guardian] 未发现守护 pid 文件，可能未运行。"; exit 0 }
    $id = 0
    if (-not [int]::TryParse(((Get-Content -LiteralPath $PidPath -Raw -ErrorAction SilentlyContinue).Trim()), [ref]$id)) {
        Write-Host "[guardian] pid 文件内容非法。"; Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue; exit 0
    }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($null -ne $p) {
        Stop-Process -Id $id -Force
        Write-Host ("[guardian] 已停止守护 PID " + $id)
    } else {
        Write-Host "[guardian] 进程已不存在。"
    }
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    exit 0
}

if ($Status) {
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $GuardPs1 -Status
    exit 0
}

Write-Host "用法：guardian-launch.ps1 -Start | -Stop | -Status"
exit 0
