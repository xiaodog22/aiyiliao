<#
  watchdog.ps1 —— 本地后端保活巡检（2026-11-15）

  【为什么需要它】
  orchestrator.ps1 用 Start-Process 起的进程，如果挂在“会结束的会话”里
  （Agent 工具调用、临时 PowerShell 窗口、IDE 终端），会话被回收时整棵进程树一起消失 ——
  小程序侧的表现就是「时不时掉后端 / 接口 502」。
  本脚本交给 Windows 计划任务托管：每次只做「探活 → 缺谁拉谁 → 退出」，
  拉起的进程挂在任务宿主下，不再依赖任何交互会话。

  【判定口径】
  - TCP 端口连不上        → 判 DOWN，触发 orchestrator 拉起（orchestrator 自身幂等：
                            健康则跳过、端口被别的进程占用则不动，不会误杀在跑的服务）
  - 端口通但健康非 2xx     → 判 DEGRADED，只记日志不重启（上游降级不该被当成宕机反复重启）
  - 三个都 UP             → 只在状态发生变化时写一行日志，避免每 2 分钟刷屏

  【用法】
    powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1            # 巡检一次
    powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1 -Status    # 只看状态
    powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1 -Quiet     # 无输出（计划任务用）

  ⚠️ 本机限制（2026-11-15 实测）：schtasks.exe 被安全中心「程序黑名单」拦截，
     计划任务注册不了 —— 所以本脚本目前只能**手动/双击**跑，不能自动定时。
     常驻仍靠「双击 start-all.bat」（进程挂在 explorer 下，不随任何终端/工具会话结束）。

  【日志】backend/deploy/logs/watchdog.log
#>
param(
    [switch]$Status,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$DeployDir  = Split-Path -Parent $PSScriptRoot          # scripts -> deploy
$ConfigPath = Join-Path $DeployDir 'config.json'
$LogDir     = Join-Path $DeployDir 'logs'
$LogPath    = Join-Path $LogDir 'watchdog.log'
$StatePath  = Join-Path $LogDir '.watchdog-state'
$OrchPath   = Join-Path $PSScriptRoot 'orchestrator.ps1'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Wd([string]$Text) {
    if (-not $Quiet) { Write-Output $Text }
}

function Write-Log([string]$Text) {
    # 超过 512KB 先截断，避免长期运行把盘写满
    if (Test-Path $LogPath) {
        $size = (Get-Item $LogPath).Length
        if ($size -gt 512KB) { Set-Content -LiteralPath $LogPath -Value '' -Encoding UTF8 }
    }
    Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text) -Encoding UTF8
}

function Test-Port([int]$Port, [int]$TimeoutMs = 1200) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Test-Health([string]$Url, [int]$TimeoutSec = 6) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
        return ('HTTP ' + [int]$r.StatusCode)
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($resp) { return ('HTTP ' + [int]$resp.StatusCode + ' 降级') }
        return '连接失败'
    } catch {
        return '探测异常'
    }
}

if (-not (Test-Path $ConfigPath)) {
    Write-Log 'FATAL config.json 缺失，巡检中止'
    Write-Wd ('config.json 不存在：' + $ConfigPath)
    exit 1
}

$cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

# ---------- 逐个探活 ----------
$rows = @()
$down = @()
foreach ($svc in $cfg.services) {
    $port = [int]$cfg.ports.($svc.portKey)
    $tcp = Test-Port $port
    $health = if ($tcp) { Test-Health $svc.healthUrl } else { '端口未监听' }
    $state = if (-not $tcp) { 'DOWN' } elseif ($health -notlike 'HTTP 2*') { 'DEGRADED' } else { 'UP' }
    $rows += [pscustomobject]@{ Name = $svc.name; Port = $port; State = $state; Health = $health }
    if ($state -eq 'DOWN') { $down += $svc.name }
}

$summary = ($rows | ForEach-Object { $_.Name + '=' + $_.State }) -join ' '

if ($Status) {
    Write-Wd ('后端状态 · ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    foreach ($r in $rows) {
        Write-Wd ('  {0,-9} :{1,-5} {2,-9} {3}' -f $r.Name, $r.Port, $r.State, $r.Health)
    }
    exit 0
}

# ---------- 状态没变且全在跑 → 直接退出（不刷日志）----------
$prev = ''
if (Test-Path $StatePath) { $prev = (Get-Content -LiteralPath $StatePath -Raw -ErrorAction SilentlyContinue) }
$prev = ([string]$prev).Trim()
Set-Content -LiteralPath $StatePath -Value $summary -Encoding UTF8

if ($down.Count -eq 0) {
    if ($summary -ne $prev) { Write-Log ('巡检：' + $summary) }
    Write-Wd $summary
    exit 0
}

# ---------- 有服务 DOWN：拉起（orchestrator 幂等，只补缺的）----------
Write-Log ('巡检：' + $summary + ' → 触发拉起')
Write-Wd ($summary + ' → 正在拉起…')

try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $OrchPath -Action start
} catch {
    Write-Log ('拉起失败：' + $_.Exception.Message)
    Write-Wd ('拉起失败：' + $_.Exception.Message)
    exit 1
}

# 拉起后复查一次，结果写进日志（便于回溯“到底有没有救回来”）
$after = @()
foreach ($svc in $cfg.services) {
    $port = [int]$cfg.ports.($svc.portKey)
    $tcp = Test-Port $port
    $after += ($svc.name + '=' + $(if ($tcp) { 'UP' } else { 'DOWN' }))
}
$afterText = $after -join ' '
Write-Log ('拉起后：' + $afterText)
Write-Wd $afterText
Set-Content -LiteralPath $StatePath -Value $afterText -Encoding UTF8
exit 0
