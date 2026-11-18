<#
  mail-alert.ps1 — QQ 邮箱告警发送模块（后端守护专用）

  职责边界（单一）：把 guardian.ps1 传来的「巡检报告」渲染成纯文本邮件并投递。
  不探活、不重启、不读服务日志——那些是守护进程的事。本模块只负责「怎么发」。

  凭据来源：backend/deploy/env.local（唯一生效文件），绝不硬编码任何邮箱/授权码。
    必需键：
      ALERT_MAIL_USER       发件 QQ 邮箱（如 xxxxx@qq.com）
      ALERT_MAIL_AUTH_CODE  QQ 邮箱 SMTP 授权码（不是登录密码！）
      ALERT_MAIL_TO         收件人，多个用 ; 或 , 分隔
    可选键（带默认值）：
      ALERT_MAIL_ENABLED       true/false，默认 false（未显式打开不发信）
      ALERT_MAIL_SMTP_HOST     默认 smtp.qq.com
      ALERT_MAIL_SMTP_PORT     默认 465
      ALERT_MAIL_SMTP_SSL      true/false，默认 true（465 用隐式 SSL）
      ALERT_MAIL_FROM_NAME     默认「后端守护」
      ALERT_MAIL_TIMEOUT_MS    默认 15000

  用法：
    # 作为库被 guardian.ps1 引用（dot-source 后只定义函数，不执行）
    . .\mail-alert.ps1
    Send-GuardianAlert -Report $report

    # 自检：渲染示例正文 + 配置脱敏摘要，不连接 SMTP、不发信
    powershell -NoProfile -ExecutionPolicy Bypass -File mail-alert.ps1 -SelfTest

    # 连通性测试：真发一封测试邮件（填完 env.local 后验证凭据是否正确）
    powershell -NoProfile -ExecutionPolicy Bypass -File mail-alert.ps1 -SendTest
#>
param(
    [switch]$SelfTest,     # 渲染示例正文 + 脱敏配置，不发信
    [switch]$SendTest,     # 真发一封测试邮件，验证 SMTP 配置
    [string]$BodyOut = ""  # 配合 -SelfTest：把渲染后的正文原样写到指定文件（核对排版用）
)

$ErrorActionPreference = "Stop"

$script:MailScriptsDir = $PSScriptRoot
$script:MailDeployDir  = Split-Path -Parent $PSScriptRoot
. (Join-Path $script:MailScriptsDir "deploy-common.ps1")   # Read-EnvLocal / 路径常量

# ---------------------------------------------------------------- 配置读取
function Get-AlertMailConfig {
    $env = Read-EnvLocal

    function Get-Val([string]$key, [string]$default) {
        if ($env.ContainsKey($key) -and -not [string]::IsNullOrWhiteSpace([string]$env[$key])) {
            return ([string]$env[$key]).Trim()
        }
        return $default
    }

    $enabledRaw = (Get-Val "ALERT_MAIL_ENABLED" "false").ToLowerInvariant()
    $toRaw      = Get-Val "ALERT_MAIL_TO" ""
    $toList     = @($toRaw -split '[;,]' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })

    $port = 465
    if (-not [int]::TryParse((Get-Val "ALERT_MAIL_SMTP_PORT" "465"), [ref]$port)) { $port = 465 }
    $timeout = 15000
    if (-not [int]::TryParse((Get-Val "ALERT_MAIL_TIMEOUT_MS" "15000"), [ref]$timeout)) { $timeout = 15000 }
    $sslRaw = (Get-Val "ALERT_MAIL_SMTP_SSL" "true").ToLowerInvariant()

    return [pscustomobject]@{
        Enabled  = ($enabledRaw -in @("1", "true", "yes", "on"))
        Host     = Get-Val "ALERT_MAIL_SMTP_HOST" "smtp.qq.com"
        Port     = $port
        Ssl      = ($sslRaw -in @("1", "true", "yes", "on"))
        User     = Get-Val "ALERT_MAIL_USER" ""
        AuthCode = Get-Val "ALERT_MAIL_AUTH_CODE" ""
        To       = $toList
        FromName = Get-Val "ALERT_MAIL_FROM_NAME" "后端守护"
        Timeout  = $timeout
    }
}

# ---------------------------------------------------------------- 配置校验
function Test-AlertMailConfig([object]$Config) {
    $issues = New-Object System.Collections.ArrayList
    if (-not $Config.Enabled) { [void]$issues.Add("ALERT_MAIL_ENABLED 未设为 true（告警邮件默认关闭）") }
    if ([string]::IsNullOrWhiteSpace($Config.User)) { [void]$issues.Add("缺少 ALERT_MAIL_USER（发件 QQ 邮箱）") }
    if ([string]::IsNullOrWhiteSpace($Config.AuthCode)) { [void]$issues.Add("缺少 ALERT_MAIL_AUTH_CODE（QQ 邮箱 SMTP 授权码）") }
    if ($Config.To.Count -eq 0) { [void]$issues.Add("缺少 ALERT_MAIL_TO（收件人）") }
    return @($issues)
}

# ---------------------------------------------------------------- 脱敏摘要
function Get-AlertMailConfigSummary([object]$Config) {
    $maskedUser = $Config.User
    if ($maskedUser -match '^([^@]{1,2})[^@]*(@.*)$') {
        $maskedUser = $matches[1] + "***" + $matches[2]
    }
    $maskedCode = ""
    if (-not [string]::IsNullOrWhiteSpace($Config.AuthCode)) { $maskedCode = "****(" + $Config.AuthCode.Length + "位)" }
    $toText = if ($Config.To.Count -gt 0) { $Config.To -join ", " } else { "(未配置)" }
    $lines = @(
        "  启用       : " + $Config.Enabled
        "  SMTP       : " + $Config.Host + ":" + $Config.Port + "  SSL=" + $Config.Ssl
        "  发件人     : " + $maskedUser + " [" + $Config.FromName + "]"
        "  授权码     : " + $(if ($maskedCode) { $maskedCode } else { "(未配置)" })
        "  收件人     : " + $toText
        "  超时       : " + $Config.Timeout + "ms"
    )
    return ($lines -join "`r`n")
}

# ---------------------------------------------------------------- 正文渲染
function New-AlertBody([hashtable]$Report) {
    $detectTime = [string]$Report.DetectTime
    if ([string]::IsNullOrWhiteSpace($detectTime)) { $detectTime = Get-Date -Format "yyyy-MM-dd HH:mm:ss" }
    $hostName = [string]$Report.Host
    if ([string]::IsNullOrWhiteSpace($hostName)) { $hostName = $env:COMPUTERNAME }

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("【后端守护告警】重启失败通知")
    [void]$sb.AppendLine("============================================================")
    [void]$sb.AppendLine("检测时间：" + $detectTime)
    [void]$sb.AppendLine("主机    ：" + $hostName)
    [void]$sb.AppendLine("项目    ：康诊云 · 医疗健康 AI 小程序（本地后端）")
    [void]$sb.AppendLine("")

    # ---- 一、服务状态 ----
    [void]$sb.AppendLine("一、服务状态（检测时刻）")
    [void]$sb.AppendLine("------------------------------------------------------------")
    $services = @($Report.Services)
    if ($services.Count -eq 0) {
        [void]$sb.AppendLine("  （未提供服务状态）")
    } else {
        foreach ($s in $services) {
            $line = "  - {0,-10} 端口 {1,-6} 状态 {2,-10} 健康 {3}" -f `
                ([string]$s.Name), ([string]$s.Port), ([string]$s.State), ([string]$s.Health)
            [void]$sb.AppendLine($line)
            if (-not [string]::IsNullOrWhiteSpace([string]$s.Reason)) {
                [void]$sb.AppendLine("      原因：" + $s.Reason)
            }
        }
    }
    [void]$sb.AppendLine("")

    # ---- 二、失败原因 ----
    [void]$sb.AppendLine("二、失败原因")
    [void]$sb.AppendLine("------------------------------------------------------------")
    $failReason = [string]$Report.FailReason
    if ([string]::IsNullOrWhiteSpace($failReason)) { $failReason = "自动重启后服务仍未恢复健康（原因待人工排查）" }
    foreach ($ln in ($failReason -split "`r?`n")) { [void]$sb.AppendLine("  " + $ln) }
    [void]$sb.AppendLine("")

    # ---- 三、重启尝试记录 ----
    [void]$sb.AppendLine("三、重启尝试记录")
    [void]$sb.AppendLine("------------------------------------------------------------")
    $tries = @($Report.RestartTries)
    if ($tries.Count -eq 0) {
        [void]$sb.AppendLine("  （无重启尝试记录）")
    } else {
        $idx = 0
        foreach ($t in $tries) {
            $idx++
            $ok = [bool]$t.Success
            $flag = if ($ok) { "成功" } else { "失败" }
            [void]$sb.AppendLine(("  第 {0} 次  {1}  [{2}]" -f $idx, ([string]$t.Time), $flag))
            [void]$sb.AppendLine("       动作：" + [string]$t.Action)
            if (-not [string]::IsNullOrWhiteSpace([string]$t.Detail)) {
                [void]$sb.AppendLine("       详情：" + [string]$t.Detail)
            }
        }
    }
    [void]$sb.AppendLine("")

    # ---- 四、错误日志摘要 ----
    [void]$sb.AppendLine("四、错误日志摘要（最近若干行）")
    [void]$sb.AppendLine("------------------------------------------------------------")
    $digest = @($Report.LogDigest)
    if ($digest.Count -eq 0) {
        [void]$sb.AppendLine("  （无可用错误日志摘要）")
    } else {
        foreach ($ln in $digest) { [void]$sb.AppendLine("  " + $ln) }
    }
    [void]$sb.AppendLine("")

    [void]$sb.AppendLine("============================================================")
    [void]$sb.AppendLine("本邮件由后端自动守护程序发送，请勿直接回复。")
    [void]$sb.AppendLine("排查入口：双击 backend\deploy\start-gui.bat 打开控制台查看「服务日志 / 守护告警」页签。")

    return $sb.ToString()
}

# ---------------------------------------------------------------- 主题渲染
function New-AlertSubject([hashtable]$Report) {
    # 主题只列**仍 DOWN** 的服务（m-08，2026-11-18）：Report.Services 是复查后的全量快照，
    # 全拼进主题会让单服务故障看起来像全线崩溃，误导排障。
    # 兼容旧报告：没有 DownServices 字段时从 Services 里按 State 过滤。
    $down = @($Report.DownServices)
    if ($down.Count -eq 0) {
        $down = @($Report.Services | Where-Object { $_.State -eq 'DOWN' } | ForEach-Object { $_.Name })
    }
    $svcNames = @($down) -join "/"
    if ([string]::IsNullOrWhiteSpace($svcNames)) { $svcNames = "未知服务" }
    $time = [string]$Report.DetectTime
    if ([string]::IsNullOrWhiteSpace($time)) { $time = Get-Date -Format "yyyy-MM-dd HH:mm:ss" }
    return ("[后端守护告警] " + $svcNames + " 重启失败 - " + $time)
}

# ---------------------------------------------------------------- 发送
function Send-GuardianAlert([hashtable]$Report, [object]$Config = $null) {
    if ($null -eq $Config) { $Config = Get-AlertMailConfig }
    $issues = @(Test-AlertMailConfig $Config)
    if ($issues.Count -gt 0) {
        throw ("邮件配置不完整：`r`n  " + ($issues -join "`r`n  "))
    }

    $subject = New-AlertSubject $Report
    $body    = New-AlertBody $Report

    $client = $null
    $msg = $null
    try {
        $client = New-Object System.Net.Mail.SmtpClient($Config.Host, $Config.Port)
        $client.EnableSsl = $Config.Ssl
        $client.Timeout = $Config.Timeout
        $client.UseDefaultCredentials = $false
        $client.Credentials = New-Object System.Net.NetworkCredential($Config.User, $Config.AuthCode)

        $msg = New-Object System.Net.Mail.MailMessage
        $msg.From = New-Object System.Net.Mail.MailAddress($Config.User, $Config.FromName)
        foreach ($to in $Config.To) { [void]$msg.To.Add($to) }
        $msg.Subject = $subject
        $msg.Body = $body
        $msg.IsBodyHtml = $false
        $msg.BodyEncoding = [System.Text.Encoding]::UTF8
        $msg.SubjectEncoding = [System.Text.Encoding]::UTF8

        $client.Send($msg)
        return [pscustomobject]@{ ok = $true; subject = $subject; to = ($Config.To -join ",") }
    } catch {
        # 不吞错：原样抛出并补充上下文，交由调用方写日志
        throw ("QQ 邮箱投递失败（" + $Config.Host + ":" + $Config.Port + "）：" + $_.Exception.Message)
    } finally {
        if ($null -ne $msg) { $msg.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
    }
}

# ================================================================ CLI 入口
if ($SelfTest) {
    Write-Host "== 邮件配置（脱敏）=="
    $cfg = Get-AlertMailConfig
    Write-Host (Get-AlertMailConfigSummary $cfg)
    $issues = @(Test-AlertMailConfig $cfg)
    if ($issues.Count -gt 0) {
        Write-Host "`n[提示] 当前配置未就绪（自检不发信，仅提示缺项）："
        foreach ($i in $issues) { Write-Host ("  - " + $i) }
    } else {
        Write-Host "`n[提示] 配置字段齐全。可用 -SendTest 真发一封测试邮件验证凭据。"
    }

    Write-Host "`n== 示例告警正文预览 =="
    $demo = @{
        DetectTime   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Host         = $env:COMPUTERNAME
        # 与 guardian.ps1 的真实报告同形：主题只认这一份「仍 DOWN」名单
        DownServices = @("business")
        Services     = @(
            @{ Name = "business"; Port = "8088"; State = "DOWN"; Health = "连接失败"; Reason = "进程 PID 已消失，端口无监听" },
            @{ Name = "ai";       Port = "8001"; State = "UP";    Health = "HTTP 200"; Reason = "" },
            @{ Name = "gateway";  Port = "8080"; State = "DEGRADED"; Health = "HTTP 503"; Reason = "上游 business 不可达" }
        )
        FailReason   = "连续探测 3 次判定 business 为 DOWN；自动重启后健康探测仍失败。"
        RestartTries = @(
            @{ Time = (Get-Date).AddMinutes(-3).ToString("HH:mm:ss"); Success = $false; Action = "orchestrator.ps1 -Action start"; Detail = "退出码 1：business 启动失败" },
            @{ Time = (Get-Date).AddMinutes(-1).ToString("HH:mm:ss"); Success = $false; Action = "orchestrator.ps1 -Action start"; Detail = "健康探测 HTTP 000（连接超时）" }
        )
        LogDigest    = @(
            "gateway.error.log: 上游不可达 GET /api/v1/me (ConnectError)",
            "business.error.log: Application run failed - Port 8088 was already in use"
        )
    }
    Write-Host ""
    $demoBody = New-AlertBody $demo
    Write-Host $demoBody
    Write-Host ("== 邮件主题 ==")
    Write-Host (New-AlertSubject $demo)
    # -BodyOut：把渲染后的正文原样落盘，便于核对排版/行距（不发信、不修改任何配置）
    if (-not [string]::IsNullOrWhiteSpace($BodyOut)) {
        try {
            $enc = New-Object System.Text.UTF8Encoding($true)
            [System.IO.File]::WriteAllText($BodyOut, $demoBody, $enc)
            Write-Host ("[已导出] 正文：" + $BodyOut)
        } catch {
            Write-Host ("[导出失败] " + $_.Exception.Message)
        }
    }
    exit 0
}

if ($SendTest) {
    $cfg = Get-AlertMailConfig
    Write-Host "== 发送测试邮件 =="
    Write-Host (Get-AlertMailConfigSummary $cfg)
    $issues = @(Test-AlertMailConfig $cfg)
    if ($issues.Count -gt 0) {
        Write-Host "`n[中止] 配置不完整："
        foreach ($i in $issues) { Write-Host ("  - " + $i) }
        exit 2
    }
    $demo = @{
        DetectTime   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Host         = $env:COMPUTERNAME
        Services     = @(@{ Name = "self-test"; Port = "-"; State = "TEST"; Health = "-"; Reason = "" })
        FailReason   = "这是一封连通性测试邮件，用于验证 QQ 邮箱 SMTP 凭据是否正确。无需处理。"
        RestartTries = @()
        LogDigest    = @("mail-alert.ps1 -SendTest 自检通过")
    }
    try {
        $r = Send-GuardianAlert -Report $demo -Config $cfg
        Write-Host ("[成功] 测试邮件已投递至 " + $r.to)
        Write-Host ("       主题：" + $r.subject)
        exit 0
    } catch {
        Write-Host ("[失败] " + $_.Exception.Message)
        exit 1
    }
}
