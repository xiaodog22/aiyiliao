<#
  guardian.ps1 — 后端常驻守护：掉线检测 → 自动重启 → 失败邮件告警

  为什么独立成进程（而不是塞进 gui.ps1）：
    - 面板是监控台，关掉窗口服务不该断；守护必须脱离 GUI 与终端会话常驻。
    - 本机 schtasks.exe 被安全中心拦截，计划任务用不了 → 常驻靠 explorer 脱离会话拉起
      （见 start-guardian.bat，与 start-all.bat 同一范式，2026-11-15 已验证跨命令存活）。

  判定口径（复用 deploy-common.ps1，与 orchestrator / gui 面板完全一致）：
    - 健康 2xx（网关含 503）        → UP        不动作
    - 端口通但健康没过             → DEGRADED  只记录，不重启（上游降级不是宕机）
    - TCP 端口连不上               → DOWN      连续 N 次才触发重启（防抖动误判）

  自愈流程：
    DOWN × N → 冷却检查 → orchestrator.ps1 -Action start（幂等，只补缺的，不误杀健康服务）
            → 重启后复查 → 仍 DOWN → 发 QQ 邮件（含检测时间/服务状态/失败原因/重启记录/日志摘要）
    告警抑制：同一故障只发一次；服务恢复后重置，再掉线可再发。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File guardian.ps1                 # 常驻（默认）
    powershell -NoProfile -ExecutionPolicy Bypass -File guardian.ps1 -SelfTest       # 跑一轮判定，不重启不发信
    powershell -NoProfile -ExecutionPolicy Bypass -File guardian.ps1 -Once           # 跑一轮含动作（调试）
    powershell -NoProfile -ExecutionPolicy Bypass -File guardian.ps1 -Status         # 读状态文件打印

  可选配置（写进 backend\deploy\env.local，均有默认值，缺项不影响启动）：
    GUARD_INTERVAL_SEC      巡检间隔秒，默认 60
    GUARD_FAIL_THRESHOLD    连续失败几次触发重启，默认 2
    GUARD_COOLDOWN_SEC      两次重启最小间隔秒，默认 180（防疯狂重启）
    GUARD_LOG_TAIL_LINES    邮件里每个服务的错误日志摘要行数，默认 3

  日志：logs\guardian.log    状态：run\guardian-state.json（GUI 读取展示）
#>
param(
    [switch]$SelfTest,        # 单轮判定打印，不重启、不发信、不写状态
    [switch]$Once,            # 单轮完整流程（含重启与告警）
    [switch]$Status,          # 只读状态文件
    [switch]$NoMail,          # 调试：禁用发信
    [int]$IntervalSec = 0,    # 0 = 用 env.local / 默认 60
    [int]$Threshold = 0,      # 0 = 用 env.local / 默认 2
    [int]$CooldownSec = 0     # 0 = 用 env.local / 默认 180
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:GuardScriptsDir = $PSScriptRoot
$script:GuardDeployDir  = Split-Path -Parent $PSScriptRoot
. (Join-Path $script:GuardScriptsDir "deploy-common.ps1")   # 路径常量 + 判定口径

$LogPath    = Join-Path $script:LogsDir "guardian.log"
$StatePath  = Join-Path $script:RunDir  "guardian-state.json"
$OrchPath   = Join-Path $script:GuardScriptsDir "orchestrator.ps1"
$MailModule = Join-Path $script:GuardScriptsDir "mail-alert.ps1"
$psExe      = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

foreach ($d in @($script:LogsDir, $script:RunDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ---------------------------------------------------------------- 配置
function Read-GuardConfig {
    $env = Read-EnvLocal
    function Get-GuardEnvVal([string]$k, [string]$def) {
        if ($env.ContainsKey($k) -and -not [string]::IsNullOrWhiteSpace([string]$env[$k])) { return ([string]$env[$k]).Trim() }
        return $def
    }
    $interval = 60; $threshold = 2; $cooldown = 180; $tail = 3
    if ($IntervalSec -gt 0) { $interval = $IntervalSec } else { [void][int]::TryParse((Get-GuardEnvVal "GUARD_INTERVAL_SEC" "60"), [ref]$interval) }
    if ($Threshold   -gt 0) { $threshold = $Threshold }   else { [void][int]::TryParse((Get-GuardEnvVal "GUARD_FAIL_THRESHOLD" "2"), [ref]$threshold) }
    if ($CooldownSec -gt 0) { $cooldown = $CooldownSec }   else { [void][int]::TryParse((Get-GuardEnvVal "GUARD_COOLDOWN_SEC" "180"), [ref]$cooldown) }
    [void][int]::TryParse((Get-GuardEnvVal "GUARD_LOG_TAIL_LINES" "3"), [ref]$tail)
    if ($interval -lt 10) { $interval = 10 }
    if ($threshold -lt 1) { $threshold = 1 }
    if ($cooldown -lt 0)  { $cooldown = 0 }
    return @{ Interval = $interval; Threshold = $threshold; Cooldown = $cooldown; TailLines = $tail }
}

# ---------------------------------------------------------------- 日志 / 状态
function Write-GuardLog([string]$Text) {
    if (Test-Path $LogPath) {
        if ((Get-Item $LogPath).Length -gt 512KB) { Set-Content -LiteralPath $LogPath -Value '' -Encoding UTF8 }
    }
    Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text) -Encoding UTF8
}
function Out-Guard([string]$Text) {
    # 用 Console 输出而非 Write-Output：避免污染 Invoke-GuardRound 的返回值。
    # 但 Console 写入必须包 try：以 -WindowStyle Hidden 且 stdout 未重定向启动时，
    # 控制台句柄不可写会抛异常；配合全局 $ErrorActionPreference='Stop' 会让脚本
    # 在第一次打印时就终止，finally 又删掉 pid —— 表现为「点了没反应、日志零新增」
    # （2026-11-17 实测根因，勿再简化回裸调用）。
    try { [Console]::Out.WriteLine($Text) } catch { }
    Write-GuardLog $Text
}

function Save-GuardState([hashtable]$State) {
    $tmp = $StatePath + ".tmp"
    try {
        $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $StatePath -Force
    } catch {
        try { if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force } } catch { }
    }
}
function Load-GuardState {
    if (-not (Test-Path $StatePath)) { return $null }
    try { return (Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# ---------------------------------------------------------------- 探活（口径同 deploy-common）
function Get-SvcSnapshot($svc, $cfg) {
    $port = 0
    try { $port = [int]$cfg.ports.($svc.portKey) } catch { $port = 0 }
    $open  = Test-TcpPort "127.0.0.1" $port
    $accept = Get-HealthAcceptCodes $svc
    $h = Test-HealthOnce ([string]$svc.healthUrl) ([string]$svc.healthContains) $accept
    $state = if ($h.ok) { 'UP' } elseif ($open) { 'DEGRADED' } else { 'DOWN' }
    $reason = ''
    if ($state -eq 'DOWN') {
        $reason = ('TCP 端口 ' + $port + ' 不可达；健康探测：' + [string]$h.detail)
    } elseif ($state -eq 'DEGRADED') {
        $reason = ('端口在监听但健康探测未过：' + [string]$h.detail)
    }
    return [pscustomobject]@{
        Name = [string]$svc.name; Port = $port; State = $state
        Health = [string]$h.detail; Reason = $reason; Open = $open
    }
}

# ---------------------------------------------------------------- 日志摘要（共享读 + 编码嗅探）
function Read-TextTail([string]$path, [int]$n) {
    try {
        $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $take = [int][Math]::Min($fs.Length, 16384)
            if ($take -le 0) { return @() }
            $fs.Seek(($fs.Length - $take), [System.IO.SeekOrigin]::Begin) | Out-Null
            $buf = New-Object byte[] $take
            $read = $fs.Read($buf, 0, $take)
            $strict = New-Object System.Text.UTF8Encoding($false, $true)
            try { $text = $strict.GetString($buf, 0, $read) }
            catch { $text = [System.Text.Encoding]::GetEncoding(936).GetString($buf, 0, $read) }
            $arr = @($text -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            if ($arr.Count -gt $n) { return @($arr | Select-Object -Last $n) }
            return $arr
        } finally { $fs.Dispose() }
    } catch { return @() }
}
function Get-LogDigest($cfg, [int]$tailLines) {
    $lines = New-Object System.Collections.ArrayList
    foreach ($svc in $cfg.services) {
        $found = $false
        foreach ($suffix in @('.error.log', '.log')) {
            $p = Join-Path $script:LogsDir ($svc.name + $suffix)
            if (Test-Path -LiteralPath $p) {
                foreach ($ln in (Read-TextTail $p $tailLines)) {
                    [void]$lines.Add(($svc.name + $suffix + ': ' + $ln.Trim()))
                }
                $found = $true
                break
            }
        }
    }
    return @($lines | Select-Object -First 12)
}

# ================================================================ 单轮巡检
function Invoke-GuardRound([hashtable]$GuardCfg, [hashtable]$FailCounts, [hashtable]$Runtime) {
    $deployCfg = Load-Config
    $snaps = @()
    foreach ($svc in $deployCfg.services) { $snaps += (Get-SvcSnapshot $svc $deployCfg) }

    $now = Get-Date
    $downNow = @($snaps | Where-Object { $_.State -eq 'DOWN' })
    $degraded = @($snaps | Where-Object { $_.State -eq 'DEGRADED' })

    # 连续失败计数：DOWN 累加，其余归零
    foreach ($s in $snaps) {
        if ($s.State -eq 'DOWN') {
            $k = $s.Name
            $FailCounts[$k] = ([int]$FailCounts[$k]) + 1
        } else {
            $FailCounts[$s.Name] = 0
        }
    }

    $verdict = 'HEALTHY'
    if ($downNow.Count -gt 0) { $verdict = 'DOWN' }
    elseif ($degraded.Count -gt 0) { $verdict = 'DEGRADED' }

    $line = ("巡检：{0} | 判定 {1} | 失败计数 [{2}]" -f `
        (($snaps | ForEach-Object { $_.Name + '=' + $_.State }) -join ' '), $verdict, `
        (($snaps | ForEach-Object { $_.Name + ':' + $FailCounts[$_.Name] }) -join ' '))
    Out-Guard $line

    $tries = @()
    $restarted = $false

    # 达到阈值 + 冷却期外 → 重启（orchestrator start 幂等，只补缺的）
    $needRestart = @($downNow | Where-Object { ([int]$FailCounts[$_.Name]) -ge ([int]$GuardCfg.Threshold) })
    $sinceLast = -1
    if ($null -ne $Runtime['LastRestart']) { $sinceLast = [int]((Get-Date) - ([datetime]$Runtime['LastRestart'])).TotalSeconds }
    $coolOK = ($sinceLast -lt 0) -or ($sinceLast -ge ([int]$GuardCfg.Cooldown))

    if ($needRestart.Count -gt 0 -and -not $SelfTest) {
        if (-not $coolOK) {
            Out-Guard ("  冷却中（距上次重启 " + $sinceLast + "s < " + $GuardCfg.Cooldown + "s），本轮跳过重启")
        } else {
            $Runtime['LastRestart'] = Get-Date
            $t0 = Get-Date
            $outFile = Join-Path $script:RunDir '_guard-orch-out.txt'
            $errFile = Join-Path $script:RunDir '_guard-orch-err.txt'
            Remove-FileQuiet $outFile; Remove-FileQuiet $errFile
            $exitCode = -1
            try {
                $p = Start-Process -FilePath $psExe -WorkingDirectory $script:GuardDeployDir `
                    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $OrchPath, "-Action", "start", "-Yes") `
                    -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -WindowStyle Hidden
                [void]$p.WaitForExit(120000)
                if ($p.HasExited) { $exitCode = $p.ExitCode } else { try { $p.Kill() } catch { } }
            } catch {
                $exitCode = -99
                Out-Guard ("  重启调用异常：" + $_.Exception.Message)
            }
            $detail = ('退出码 ' + $exitCode + '；耗时 ' + [int]((Get-Date) - $t0).TotalSeconds + 's')
            $ok = ($exitCode -eq 0)
            $tries += [pscustomobject]@{ Time = $t0.ToString('HH:mm:ss'); Success = $ok; Action = 'orchestrator.ps1 -Action start'; Detail = $detail }
            Out-Guard ("  重启 " + (($downNow.Name) -join ',') + " → " + $detail)

            # 重启后复查
            $after = @()
            foreach ($svc in $deployCfg.services) { $after += (Get-SvcSnapshot $svc $deployCfg) }
            $stillDown = @($after | Where-Object { $_.State -eq 'DOWN' })
            foreach ($a in $after) { $snaps = @($snaps | Where-Object { $_.Name -ne $a.Name }); $snaps += $a }
            if ($stillDown.Count -eq 0) {
                $verdict = 'HEALTHY'; $FailCounts[$needRestart[0].Name] = 0
                Out-Guard ("  复查：全部服务已恢复（" + (($after | ForEach-Object { $_.Name + '=' + $_.State }) -join ' ') + "）")
                $Runtime['AlertKey'] = ''   # 恢复 → 允许下次故障再告警
            } else {
                $verdict = 'DOWN'
                Out-Guard ("  复查仍有服务 DOWN：" + ($stillDown.Name -join ','))
                # 构造告警报告并发信（同一故障只发一次）
                $alertKey = ($stillDown | ForEach-Object { $_.Name } | Sort-Object) -join ','
                if (-not $NoMail -and $alertKey -ne ([string]$Runtime['AlertKey'])) {
                    $failReason = ("以下服务连续 " + $GuardCfg.Threshold + " 次探测判定为 DOWN，自动重启后复查仍未恢复：`r`n" +
                        (($stillDown | ForEach-Object { '  - ' + $_.Name + ':' + $_.Port + '（' + $_.Reason + '）' }) -join "`r`n"))
                    $report = @{
                        DetectTime   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
                        Host         = $env:COMPUTERNAME
                        Services     = @($after | ForEach-Object {
                            @{ Name = $_.Name; Port = [string]$_.Port; State = $_.State; Health = $_.Health; Reason = $_.Reason }
                        })
                        FailReason   = $failReason
                        RestartTries = @($tries)
                        LogDigest    = @(Get-LogDigest $deployCfg ([int]$GuardCfg.TailLines))
                    }
                    try {
                        . $MailModule
                        $r = Send-GuardianAlert -Report $report
                        Out-Guard ("  告警邮件已发送至 " + $r.to + "：" + $r.subject)
                        $Runtime['AlertKey'] = $alertKey
                        $Runtime['LastAlert'] = $report.DetectTime
                        $Runtime['LastAlertResult'] = 'sent'
                    } catch {
                        # 不吞错：发信失败也要落日志与状态，便于人工补发
                        $msg = $_.Exception.Message
                        Out-Guard ("  告警邮件发送失败：" + $msg)
                        $Runtime['AlertKey'] = $alertKey   # 避免每分钟重试刷屏；恢复后重置
                        $Runtime['LastAlert'] = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
                        $Runtime['LastAlertResult'] = 'failed: ' + $msg
                    }
                } elseif ($NoMail) {
                    Out-Guard "  (-NoMail：跳过发信)"
                } else {
                    Out-Guard "  同一故障已告警过，抑制重复发信"
                }
            }
            $restarted = $true
        }
    }

    # 无 DOWN 时清空告警抑制键
    if ($downNow.Count -eq 0) { $Runtime['AlertKey'] = '' }

    # 写状态文件供 GUI 读取
    if (-not $SelfTest) {
        $state = @{
            enabled          = $true
            pid              = $PID
            intervalSec      = [int]$GuardCfg.Interval
            threshold        = [int]$GuardCfg.Threshold
            cooldownSec      = [int]$GuardCfg.Cooldown
            lastCheck        = $now.ToString('yyyy-MM-dd HH:mm:ss')
            verdict          = $verdict
            services         = @($snaps | ForEach-Object { @{ name=$_.Name; port=$_.Port; state=$_.State; health=$_.Health; reason=$_.Reason } })
            failCounts       = @{}
            lastRestart      = if ($null -ne $Runtime['LastRestart']) { ([datetime]$Runtime['LastRestart']).ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
            restartToday     = [int]$Runtime['RestartCount']
            lastAlert        = [string]$Runtime['LastAlert']
            lastAlertResult  = [string]$Runtime['LastAlertResult']
            lastTries        = @($tries)
        }
        foreach ($s in $snaps) { $state.failCounts[$s.Name] = [int]$FailCounts[$s.Name] }
        if ($restarted) { $Runtime['RestartCount'] = ([int]$Runtime['RestartCount']) + 1; $state.restartToday = [int]$Runtime['RestartCount'] }
        Save-GuardState $state
    }

    return $verdict
}

# ================================================================ CLI
$cfg = Read-GuardConfig

if ($Status) {
    $st = Load-GuardState
    if ($null -eq $st) { Write-Output "守护尚未运行（无状态文件：$StatePath）"; exit 0 }
    Write-Output ("守护状态 · " + $st.lastCheck + " · 判定 " + $st.verdict + " · PID " + $st.pid)
    foreach ($s in $st.services) {
        Write-Output ("  {0,-9} :{1,-5} {2,-9} {3}" -f $s.name, $s.port, $s.state, $s.health)
    }
    Write-Output ("  重启次数：" + $st.restartToday + " · 上次重启：" + $(if ($st.lastRestart) { $st.lastRestart } else { '—' }))
    Write-Output ("  上次告警：" + $(if ($st.lastAlert) { $st.lastAlert + '（' + $st.lastAlertResult + '）' } else { '—' }))
    exit 0
}

$failCounts = @{}
foreach ($svc in (Load-Config).services) { $failCounts[[string]$svc.name] = 0 }
$runtime = @{ LastRestart = $null; AlertKey = ''; LastAlert = ''; LastAlertResult = ''; RestartCount = 0 }

if ($SelfTest) {
    Write-Output ("== 守护自检（间隔 " + $cfg.Interval + "s / 阈值 " + $cfg.Threshold + " 次 / 冷却 " + $cfg.Cooldown + "s）==")
    $v = Invoke-GuardRound $cfg $failCounts $runtime
    Write-Output ("== 本轮判定：" + $v + "（自检不重启、不发信、不写状态文件）==")
    exit 0
}

if ($Once) {
    $v = Invoke-GuardRound $cfg $failCounts $runtime
    Write-Output ("单轮完成：" + $v)
    exit 0
}

# ---------------------------------------------------------------- 常驻循环
$PidFile = Join-Path $script:RunDir "guardian.pid"
# 防重复：已有存活守护则直接退出（幂等，供 start-guardian.bat 反复调用）
if (Test-Path -LiteralPath $PidFile) {
    $oldPid = 0
    if ([int]::TryParse(((Get-Content -LiteralPath $PidFile -Raw).Trim()), [ref]$oldPid) -and (Test-PidAlive $oldPid)) {
        try { [Console]::Out.WriteLine("守护已在运行（PID " + $oldPid + "），本次不重复启动") } catch { }
        exit 0
    }
}
Set-Content -LiteralPath $PidFile -Value ([string]$PID) -Encoding ASCII
try {
    Out-Guard ("守护启动：PID " + $PID + " · 间隔 " + $cfg.Interval + "s · 阈值 " + $cfg.Threshold + " 次 · 冷却 " + $cfg.Cooldown + "s")
    if (-not (Test-Path $MailModule)) { Out-Guard "警告：未找到邮件模块 $MailModule，告警发信不可用" }
    while ($true) {
        try {
            Invoke-GuardRound $cfg $failCounts $runtime | Out-Null
        } catch {
            Out-Guard ("巡检异常（已吞并继续，不影响常驻）：" + $_.Exception.Message)
        }
        Start-Sleep -Seconds ([int]$cfg.Interval)
    }
} finally {
    # 正常退出时清理 pid 文件（被 Kill 强杀时靠启动侧 Test-PidAlive 兜底）
    Remove-FileQuiet $PidFile
}
