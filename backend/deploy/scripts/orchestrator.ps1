<#
  orchestrator.ps1 - 一键启动/停止/状态/重启（backend/deploy）
  规格：docs/v4/08-后端实施双Agent总纲.md §8（行为规格逐条实现）
  由 start-all.bat / stop-all.bat / status.bat / restart.bat 调用。
  参数：
    -Action start|stop|status|restart
    -Setup    首次初始化（建 venv / 装依赖 / 构建业务服务；需网络）
    -SkipAI   不启动 AI 服务
    -Smoke    启动后冒烟（只读、无副作用）
    -Yes      免交互
  退出码：0 全绿；1 有服务运行期失败；2 前置未过（有服务因前置条件未就绪而未启动）
  约束：只管理自己启动的进程（run/*.pid）；不改系统环境、不写注册表；不打印任何凭据。
#>
param(
    [ValidateSet("start", "stop", "status", "restart")]
    [string]$Action = "start",
    [switch]$Setup,
    [switch]$SkipAI,
    [switch]$Smoke,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # 健康轮询用 Invoke-WebRequest：不渲染进度条（控制台/转录噪音）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 共享工具：路径常量 + 健康/端口/pid 判定口径。图形面板 gui.ps1 引入同一份，
# 保证「命令行说健康」与「面板说健康」永远是同一个判定。
. (Join-Path $PSScriptRoot "deploy-common.ps1")

Remove-CaseDuplicateEnv

function Info([string]$m) { Write-Host $m }
function Ok([string]$m) { Write-Host $m -ForegroundColor Green }
function Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Bad([string]$m) { Write-Host $m -ForegroundColor Red }
function Dim([string]$m) { Write-Host $m -ForegroundColor DarkGray }

function Load-EnvLocal {
    if (-not (Test-Path $EnvLocalPath)) {
        Dim "  (未发现 env.local，使用进程环境与默认值；模板见 env.example)"
        return
    }
    $count = 0
    foreach ($line in (Get-Content -LiteralPath $EnvLocalPath -Encoding UTF8)) {
        $t = ($line -as [string]).Trim()
        if ($t -eq "" -or $t.StartsWith("#")) { continue }
        $eq = $t.IndexOf("=")
        if ($eq -lt 1) { continue }
        $k = $t.Substring(0, $eq).Trim()
        $v = $t.Substring($eq + 1).Trim()
        Set-Item -Path ("env:" + $k) -Value $v
        $count++
    }
    Dim ("  已从 env.local 注入 " + $count + " 个环境变量（不显示内容）")
}

function Rotate-Log([string]$Name) {
    foreach ($suffix in @(".log", ".error.log")) {
        $logPath = Join-Path $LogsDir ($Name + $suffix)
        if (Test-Path $logPath) {
            $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
            $backup = Join-Path $LogsDir ($Name + "." + $stamp + $suffix + ".bak")
            Move-Item -LiteralPath $logPath -Destination $backup -Force
        }
    }
    # 保留最近 5 份备份，其余删除
    foreach ($suffix in @(".log", ".error.log")) {
        $pattern = $Name + ".*" + $suffix + ".bak"
        $files = @(Get-ChildItem -Path $LogsDir -Filter $pattern -ErrorAction SilentlyContinue |
            Where-Object { ($suffix -ne ".log") -or ($_.Name -notlike "*.error.log.bak") } |
            Sort-Object LastWriteTime -Descending)
        if ($files.Count -gt 5) {
            $files | Select-Object -Skip 5 | ForEach-Object { Remove-FileQuiet $_.FullName }
        }
    }
}

function Quote-Arg([string]$a) {
    if ($a -match '[\s"]') { return ('"' + ($a -replace '"', '\"') + '"') }
    return $a
}

function Resolve-StartCommand($svc, $cfg) {
    $dir = Resolve-ServicePath $svc
    $exe = $svc.start.exe
    $args = @()
    foreach ($a in $svc.start.args) { $args += $a }
    if ($exe -eq "{venvPython}") { $exe = Get-VenvPython $svc }
    $args = @($args | ForEach-Object { $_.Replace("{venvPython}", (Get-VenvPython $svc)) })

    # 业务服务：优先打好的 jar，其次 mvnw spring-boot:run（dev 档）
    if ($svc.name -eq "business" -and $svc.PSObject.Properties.Name -contains "startJar") {
        $jarDir = Join-Path $dir "target"
        $jar = $null
        if (Test-Path $jarDir) {
            $jar = Get-ChildItem -Path $jarDir -Filter "*.jar" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notlike "*sources*" -and $_.Name -notlike "*javadoc*" } |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        }
        if ($null -ne $jar) {
            $jarArgs = @()
            foreach ($a in $svc.startJar.args) { $jarArgs += $a.Replace("{jar}", $jar.FullName) }
            # 显式钉住端口：宿主会向子进程注入 SERVER__PORT / SERVER_PORT（实测被解析成 57213，
            # 进而因端口占用启动失败）。命令行参数优先级最高，保证一定绑 cfg.ports.business。
            $jarArgs += ("--server.port=" + [string]$cfg.ports.business)
            return @{ exe = "java"; args = $jarArgs; mode = "jar" }
        }
        $runArg = "-Dspring-boot.run.arguments=--server.port=" + [string]$cfg.ports.business
        return @{ exe = "cmd"; args = @("/c", "mvnw.cmd", "spring-boot:run", $runArg); mode = "mvnw" }
    }
    return @{ exe = $exe; args = $args; mode = "direct" }
}

function Start-OneService($svc, $cfg) {
    $name = $svc.name
    $dir = Resolve-ServicePath $svc
    $port = [int]$cfg.ports.($svc.portKey)
    $accept = Get-HealthAcceptCodes $svc

    # 1) 已在运行（健康 OK）→ 幂等跳过
    $h = Test-HealthOnce $svc.healthUrl $svc.healthContains $accept
    if ($h.ok) {
        Ok ("  [" + $name + "] 已在运行（健康 " + $h.detail + "），跳过")
        return "already"
    }
    # 2) 端口冲突：占用但健康失败 → 不杀、按冲突处理
    if (Test-TcpPort "127.0.0.1" $port) {
        Bad ("  [" + $name + "] 端口 " + $port + " 被其他进程占用且健康检查未通过 —— 请先处理占用后重试")
        return "conflict"
    }

    Rotate-Log $name
    $logPath = Join-Path $LogsDir ($name + ".log")
    $errPath = Join-Path $LogsDir ($name + ".error.log")
    $cmd = Resolve-StartCommand $svc $cfg
    $argList = @($cmd.args | ForEach-Object { Quote-Arg $_ })

    Info ("  [" + $name + "] 启动中（" + $cmd.mode + "）…")
    $proc = Start-Process -FilePath $cmd.exe -ArgumentList $argList -WorkingDirectory $dir `
        -RedirectStandardOutput $logPath -RedirectStandardError $errPath -PassThru -WindowStyle Hidden
    Set-Content -LiteralPath (Get-PidFilePath $name) -Value $proc.Id -Encoding Ascii

    $timeout = [int]$cfg.healthTimeoutSeconds
    $r = Wait-Health $svc.healthUrl $svc.healthContains $timeout $accept $proc.Id
    if ($r.ok) {
        $note = ""
        if ($r.detail -ne "HTTP 200") { $note = "（上游降级，进程存活）" }
        Ok ("  [" + $name + "] 就绪（pid=" + $proc.Id + "，健康 " + $r.detail + $note + "）")
        return "running"
    }
    if ($r['dead'] -or (-not (Test-PidAlive $proc.Id))) {
        Bad ("  [" + $name + "] 进程已退出。日志尾部：")
        Show-LogTail $name 6
        return "dead"
    }
    Bad ("  [" + $name + "] 健康等待失败（" + $r.detail + "）。日志尾部：")
    Show-LogTail $name 6
    return "unhealthy"
}

function Show-LogTail([string]$Name, [int]$Lines) {
    $p = Join-Path $LogsDir ($Name + ".log")
    if (Test-Path $p) {
        Get-Content -LiteralPath $p -Tail $Lines -ErrorAction SilentlyContinue | ForEach-Object { Dim ("    | " + $_) }
    }
    $e = Join-Path $LogsDir ($Name + ".error.log")
    if (Test-Path $e) {
        Get-Content -LiteralPath $e -Tail 3 -ErrorAction SilentlyContinue | ForEach-Object { Dim ("    ! " + $_) }
    }
}

function Stop-OneService($svc) {
    $name = $svc.name
    $procId = Read-ServicePid $name
    if ($null -eq $procId) {
        Dim ("  [" + $name + "] 无本工具启动记录，跳过（不触碰手工启动的进程）")
        return
    }
    if (-not (Test-PidAlive $procId)) {
        Remove-FileQuiet (Get-PidFilePath $name)
        Dim ("  [" + $name + "] 进程已不在（清理 pid 记录）")
        return
    }
    # 记录子进程（如 venv 的 python 转发进程、cmd 包装进程），防止父进程退出后子进程残留占口
    $children = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $procId) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId)
    # 先温和终止整棵进程树（≤10 秒）；经 cmd 包装以避免原生命令 stderr 在 Stop 偏好下变成中止异常
    & cmd.exe /c ("taskkill /PID " + $procId + " /T >nul 2>&1") | Out-Null
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and (Test-PidAlive $procId)) { Start-Sleep -Milliseconds 500 }
    # 强制：连同已记录子进程一并清扫
    if (Test-PidAlive $procId) {
        & cmd.exe /c ("taskkill /PID " + $procId + " /T /F >nul 2>&1") | Out-Null
        Start-Sleep -Milliseconds 400
    }
    foreach ($k in $children) {
        if (Test-PidAlive $k) {
            & cmd.exe /c ("taskkill /PID " + $k + " /T /F >nul 2>&1") | Out-Null
            Start-Sleep -Milliseconds 200
        }
    }
    $left = @($children | Where-Object { Test-PidAlive $_ })
    if ((Test-PidAlive $procId) -or ($left.Count -gt 0)) {
        Bad ("  [" + $name + "] 停止失败，请手动检查 pid=" + $procId)
    } else {
        Remove-FileQuiet (Get-PidFilePath $name)
        Ok ("  [" + $name + "] 已停止（pid=" + $procId + "）")
    }
}

function Show-Status($cfg) {
    Info ""
    Info "  服务状态矩阵"
    Info "  ---------------------------------------------------------------"
    Info "  服务        PID      端口    进程    健康"
    foreach ($svc in $cfg.services) {
        $name = $svc.name
        $port = [int]$cfg.ports.($svc.portKey)
        $procId = Read-ServicePid $name
        $alive = Test-PidAlive $procId
        $accept = Get-HealthAcceptCodes $svc
        $h = Test-HealthOnce $svc.healthUrl $svc.healthContains $accept
        $pidText = "-"; if ($null -ne $procId) { $pidText = [string]$procId }
        $procText = "无"; if ($alive) { $procText = "在" }
        $healthText = "FAIL(" + $h.detail + ")"
        $level = "bad"
        if ($h.ok) {
            if ($h.detail -eq "HTTP 200") { $healthText = "OK"; $level = "ok" }
            else { $healthText = "降级(" + $h.detail + ")"; $level = "warn" }
        }
        $line = "  " + $name.PadRight(10) + $pidText.PadRight(8) + ([string]$port).PadRight(8) + $procText.PadRight(8) + $healthText
        if ($level -eq "ok") { Ok $line } elseif ($level -eq "warn") { Warn $line } else { Bad $line }
        Dim ("    日志： logs\" + $name + ".log")
    }
    Info "  ---------------------------------------------------------------"
}

function Invoke-Smoke($cfg) {
    Info ""
    Info "  冒烟检查（只读）"
    $pass = 0
    $fail = 0
    foreach ($item in $cfg.smoke) {
        $headers = @{}
        if ($item.headers) {
            foreach ($p in $item.headers.PSObject.Properties) { $headers[$p.Name] = $p.Value }
        }
        try {
            $resp = Invoke-WebRequest -Uri $item.url -UseBasicParsing -TimeoutSec 5 -Headers $headers
            if ($resp.StatusCode -lt 400) {
                Ok ("  [PASS] " + $item.name + " -> HTTP " + $resp.StatusCode)
                $pass++
            } else {
                Bad ("  [FAIL] " + $item.name + " -> HTTP " + $resp.StatusCode)
                $fail++
            }
        } catch {
            Bad ("  [FAIL] " + $item.name + " -> " + $_.Exception.Message)
            $fail++
        }
    }
    Info ("  冒烟结果：PASS " + $pass + " / FAIL " + $fail)
    return $fail
}

function Invoke-Setup($cfg) {
    Info ""
    Info "  初始化（-Setup）：创建 venv / 安装依赖 / 构建业务服务"
    $pipIndex = $cfg.pipIndexUrl
    foreach ($svc in $cfg.services) {
        if ($svc.name -eq "business") { continue }
        $dir = Resolve-ServicePath $svc
        if (-not (Test-Path $dir)) {
            Warn ("  [" + $svc.name + "] 目录不存在，跳过：" + $dir)
            continue
        }
        $venvPython = Get-VenvPython $svc
        if (-not (Test-Path $venvPython)) {
            $sysPython = (Get-Command python -ErrorAction SilentlyContinue)
            if ($null -eq $sysPython) {
                Bad "  找不到系统 python（请先安装 Python 3.10+ 并加入 PATH），未完成 " ; continue
            }
            Info ("  [" + $svc.name + "] 创建 venv…")
            & $sysPython.Source -m venv (Join-Path $dir ".venv")
        }
        $req = Join-Path $dir $svc.setup.requirements
        if (Test-Path $req) {
            Info ("  [" + $svc.name + "] 安装依赖（镜像：" + $pipIndex + "）…")
            $pipArgs = @("-m", "pip", "install", "-q", "-r", $req)
            if ($pipIndex) { $pipArgs += @("-i", $pipIndex) }
            & $venvPython @pipArgs
            if ($LASTEXITCODE -ne 0) { Bad ("  [" + $svc.name + "] 依赖安装失败（exit " + $LASTEXITCODE + "）") }
            else { Ok ("  [" + $svc.name + "] 依赖就绪") }
        }
    }
    # 业务服务：有 mvnw 且无 jar 时预构建
    $biz = $cfg.services | Where-Object { $_.name -eq "business" } | Select-Object -First 1
    $bizDir = Resolve-ServicePath $biz
    if (Test-Path $bizDir) {
        $jar = Get-ChildItem -Path (Join-Path $bizDir "target") -Filter "*.jar" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "*sources*" } | Select-Object -First 1
        if ($null -eq $jar -and (Test-Path (Join-Path $bizDir "mvnw.cmd"))) {
            Info "  [business] 未发现构建产物，执行 mvnw package（跳过测试）…"
            Push-Location $bizDir
            try { & (Join-Path $bizDir "mvnw.cmd") -q -DskipTests package } finally { Pop-Location }
            if ($LASTEXITCODE -ne 0) { Bad ("  [business] 构建失败（exit " + $LASTEXITCODE + "）") } else { Ok "  [business] 构建完成" }
        } else {
            Dim "  [business] 已有构建产物或缺少 mvnw，跳过构建"
        }
    } else {
        Warn "  [business] 目录不存在（等待 Agent-M 交付），跳过"
    }
}

# ============================== 主流程 ==============================

if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }
if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir | Out-Null }

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$exitCode = 0

try {
    $cfg = Load-Config
} catch {
    Bad ("前置检查失败：" + $_.Exception.Message)
    exit 2
}

# 日志目录可写检查
try {
    $probeFile = Join-Path $LogsDir ".write-test"
    [System.IO.File]::WriteAllText($probeFile, "ok")
    [System.IO.File]::Delete($probeFile)
} catch {
    Bad "前置检查失败：logs 目录不可写"
    exit 2
}

$services = @($cfg.services)
if ($SkipAI) {
    $services = @($services | Where-Object { $_.name -ne "ai" })
    Warn "  (-SkipAI：本次不启动/检查 AI 服务)"
}

switch ($Action) {
    "stop" {
        Info ""
        Info "  停止服务（仅回收本工具启动的进程）"
        foreach ($svc in ($services | Sort-Object { switch ($_.name) { "gateway" { 0 } "ai" { 1 } default { 2 } } })) {
            try { Stop-OneService $svc } catch { Bad ("  [" + $svc.name + "] 停止异常：" + $_.Exception.Message) }
        }
        Info ""
        Dim "  提示：若曾用 start-all 启动过但 pid 记录被清理，请用 status.bat 核对端口再处理。"
    }
    "status" {
        Show-Status $cfg
    }
    default {
        Info ""
        Info "  ============================================"
        Info "   医疗健康 AI 小程序 · 本地后端一键启动"
        Info ("   " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
        Info "  ============================================"
        Load-EnvLocal

        if ($Setup) {
            if (-not $Yes) {
                $answer = Read-Host "  将创建 venv / 安装依赖 / 构建服务（需要网络）。继续？(Y/N)"
                if ($answer -notmatch '^[Yy]') { Warn "  已取消"; exit 0 }
            }
            Invoke-Setup $cfg
            Info ""
        }

        # --- 环境泄漏防护（启动任何服务前）---
        # 本机 IDE/工具宿主会向子进程注入 SERVER__PORT（Spring relaxed binding 会将其解析为
        # server.port，导致业务服务去绑错误端口）；移除冲突变量，并在未显式指定时钉住 SERVER_PORT
        # （env.local 中如提供了 SERVER_PORT 则以 env.local 为准）。
        # 注：环境变量删除必须走 .NET API —— 本机安全删除包装器会把 Remove-Item Env: 判为
        # fail-closed（目标不存在即抛异常中断流程）。
        try { [System.Environment]::SetEnvironmentVariable("SERVER__PORT", $null, "Process") } catch { }
        if (-not $env:SERVER_PORT) { $env:SERVER_PORT = [string]$cfg.ports.business }

        # 本机回环绕过系统代理：实测 HTTP_PROXY 会把 127.0.0.1 的请求也送去代理（表现为 502）。
        # NO_PROXY 只影响遵循该约定的客户端（curl / requests / httpx 等），不改动用户的出网代理配置。
        $noProxyHosts = "127.0.0.1,localhost,::1"
        $env:NO_PROXY = $noProxyHosts
        $env:no_proxy = $noProxyHosts

        # --- 全局前置检查（docs/v4/08 §8.3-1）---
        # 不通过 → 中文指引 + 退出码 2，且不启动任何服务（不留半启动状态）。
        $preErrors = @()
        foreach ($svc in $services) {
            if (-not $svc.venvPython) { continue }
            $venvPy = Get-VenvPython $svc
            if (-not (Test-Path $venvPy)) {
                $preErrors += ("  [" + $svc.name + "] venv 未初始化 —— 请先运行 start-all.bat -Setup")
            }
        }
        $preHost = [string]$cfg.mysql.host
        $prePort = [int]$cfg.mysql.port
        if ($env:MYSQL_HOST) { $preHost = [string]$env:MYSQL_HOST }
        if ($env:MYSQL_PORT) { $prePort = [int]$env:MYSQL_PORT }
        if (-not (Test-TcpPort $preHost $prePort)) {
            $preErrors += ("  [business] MySQL 不可达（" + $preHost + ":" + $prePort + "）—— 请先启动 MySQL 或核对 env.local")
        }
        if ($preErrors.Count -gt 0) {
            Info ""
            Bad "  前置检查未通过：本次不启动任何服务（不留半启动状态）"
            foreach ($pe in $preErrors) { Bad $pe }
            Info ""
            Dim "  修复后重新运行：start-all.bat（首次初始化加 -Setup）"
            exit 2
        }

        if ($Action -eq "restart") {
            Info "  重启：先停止再启动"
            foreach ($svc in ($services | Sort-Object { switch ($_.name) { "gateway" { 0 } "ai" { 1 } default { 2 } } })) {
                try { Stop-OneService $svc } catch { }
            }
            Start-Sleep -Milliseconds 800
        }

        Info ""
        Info "  前置检查与启动（顺序：business -> ai -> gateway）"
        $states = @{}
        foreach ($svc in $services) {
            $name = $svc.name
            $dir = Resolve-ServicePath $svc
            try {
                # --- 前置：产物/运行时检查 ---
                if (-not (Test-Path $dir)) {
                    if ($name -eq "business") {
                        Warn ("  [business] 产物未交付（等待 Agent-M 构建 backend/business-service）—— 本次未启动")
                    } else {
                        Bad ("  [" + $name + "] 目录缺失：" + $dir)
                    }
                    $states[$name] = "precheck-missing"
                    continue
                }
                if ($name -eq "business") {
                    $hasMvnw = Test-Path (Join-Path $dir "mvnw.cmd")
                    $hasJar = $null -ne (Get-ChildItem -Path (Join-Path $dir "target") -Filter "*.jar" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "*sources*" } | Select-Object -First 1)
                    if (-not ($hasMvnw -or $hasJar)) {
                        Warn ("  [business] 缺少 mvnw.cmd 且无构建产物 —— 本次未启动")
                        $states[$name] = "precheck-missing"
                        continue
                    }
                    # 迁移脚本比 jar 新 → 运行期必现 "Detected applied migration not resolved
                    # locally: N"（库里已应用、包里没这个脚本）。这里只提示，不阻断启动。
                    if ($hasJar) {
                        $migDir = Join-Path $dir "src\main\resources\db\migration"
                        if (Test-Path $migDir) {
                            $newestSql = Get-ChildItem -Path $migDir -Filter "V*.sql" -ErrorAction SilentlyContinue |
                                Sort-Object LastWriteTime -Descending | Select-Object -First 1
                            $jarFile = Get-ChildItem -Path (Join-Path $dir "target") -Filter "*.jar" -ErrorAction SilentlyContinue |
                                Where-Object { $_.Name -notlike "*sources*" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
                            if ($null -ne $newestSql -and $null -ne $jarFile -and $jarFile.LastWriteTime -lt $newestSql.LastWriteTime) {
                                Warn ("  [business] 构建产物落后于迁移脚本（" + $newestSql.Name + " 更新）—— 请先重新打包：backend\business-service\mvnw.cmd -DskipTests package")
                            }
                        }
                    }
                    if ($null -eq (Get-Command java -ErrorAction SilentlyContinue)) {
                        Bad "  [business] 未找到 Java（JDK 17+ 需在 PATH）—— 本次未启动"
                        $states[$name] = "precheck-missing"
                        continue
                    }
                    # 探测目标：默认取 config.json；env.local 提供了 MYSQL_HOST/MYSQL_PORT 时以 env.local 为准
                    $myHost = [string]$cfg.mysql.host
                    $myPort = [int]$cfg.mysql.port
                    if ($env:MYSQL_HOST) { $myHost = [string]$env:MYSQL_HOST }
                    if ($env:MYSQL_PORT) { $myPort = [int]$env:MYSQL_PORT }
                    $mysqlOk = Test-TcpPort $myHost $myPort
                    if (-not $mysqlOk) {
                        Bad ("  [business] MySQL 不可达（" + $myHost + ":" + $myPort + "）—— 本次未启动；请先启动 MySQL 或核对 env.local")
                        $states[$name] = "precheck-missing"
                        continue
                    }
                } else {
                    $venvPython = Get-VenvPython $svc
                    if (-not (Test-Path $venvPython)) {
                        Bad ("  [" + $name + "] venv 未初始化 —— 请先运行 start-all.bat -Setup")
                        $states[$name] = "precheck-missing"
                        continue
                    }
                }
                # --- 启动 ---
                $state = Start-OneService $svc $cfg
                $states[$name] = $state
            } catch {
                Bad ("  [" + $name + "] 启动异常：" + $_.Exception.Message)
                $states[$name] = "error"
            }
        }

        $sw.Stop()
        Info ""
        $running = @($states.Values | Where-Object { $_ -eq "running" -or $_ -eq "already" }).Count
        $blocked = @($states.Values | Where-Object { $_ -eq "precheck-missing" -or $_ -eq "conflict" }).Count
        $failed = @($states.Values | Where-Object { $_ -eq "dead" -or $_ -eq "unhealthy" -or $_ -eq "error" }).Count
        Info ("  汇总：就绪 " + $running + " / 前置未过 " + $blocked + " / 运行失败 " + $failed + "（耗时 " + [int]$sw.Elapsed.TotalSeconds + " 秒）")

        if ($Smoke) {
            $gatewayState = $states["gateway"]
            if ($gatewayState -eq "running" -or $gatewayState -eq "already") {
                Invoke-Smoke $cfg | Out-Null
            } else {
                Warn "  网关未就绪，跳过冒烟"
            }
        }

        Info ""
        Dim "  下一步：status.bat 查看矩阵；stop-all.bat 停止；日志见 backend\deploy\logs\"

        if ($blocked -gt 0) { $exitCode = 2 }
        elseif ($failed -gt 0) { $exitCode = 1 }
        else { $exitCode = 0 }
    }
}

exit $exitCode
