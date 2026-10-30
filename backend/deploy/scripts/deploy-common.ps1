<#
  deploy-common.ps1 — backend/deploy 脚本共享层（路径常量 + 健康/端口/pid 判定口径）
  被 orchestrator.ps1 与 gui.ps1 同时 dot-source：保证「命令行说健康」与「面板说健康」
  永远是同一个判定。

  约束：
    - 只做定义与判定，不启停进程、不打印任何凭据。
    - 本文件含中文，必须是 UTF-8 **带 BOM**：Windows PowerShell 5.1 对无 BOM 的 .ps1
      按 ANSI(GBK) 解码，中文会被拆出意外引号并在运行前就 ParserError。
      （start-all.bat 等入口会先跑 ensure-utf8bom.ps1 自愈，但编辑器若已写坏则无解，
        故本文件本身也要保持 BOM。）
#>

$script:DeployRoot = Split-Path -Parent $PSScriptRoot
$script:RepoRoot   = Split-Path -Parent (Split-Path -Parent $script:DeployRoot)
$script:ConfigPath = Join-Path $script:DeployRoot 'config.json'
$script:EnvLocalPath = Join-Path $script:DeployRoot 'env.local'
$script:LogsDir   = Join-Path $script:DeployRoot 'logs'
$script:RunDir    = Join-Path $script:DeployRoot 'run'

# ---------------------------------------------------------------- 配置读取
function Load-Config {
    if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
        throw ("配置文件不存在：" + $script:ConfigPath)
    }
    return (Get-Content -LiteralPath $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json)
}
# 旧名兼容（gui.ps1 早期版本用过）
function Read-DeployConfig { Load-Config }

function Read-EnvLocal {
    $values = @{}
    if (Test-Path -LiteralPath $script:EnvLocalPath) {
        foreach ($line in Get-Content -LiteralPath $script:EnvLocalPath -Encoding UTF8) {
            if ($line -match '^\s*#' -or $line -notmatch '^\s*([^=\s]+)\s*=\s*(.*)\s*$') { continue }
            $values[$matches[1]] = $matches[2]
        }
    }
    return $values
}

# ------------------------------------------------------- 环境变量大小写变体清理
function Remove-CaseDuplicateEnv {
    # 现象（本机实测）：进程环境块里同时存在 HTTPS_PROXY 与 https_proxy、HTTP_PROXY 与
    # http_proxy —— 同值、仅大小写不同。Windows 变量名本不区分大小写，但 PowerShell 5.1
    # 用**区分大小写**的字典重建环境（Start-Process 拉起子进程、Get-ChildItem Env: 都走
    # 这条路径），撞到同键直接抛：
    #   Item has already been added. Key in dictionary: 'HTTPS_PROXY' ... 'https_proxy'
    # 结果三个服务一个都起不来。故启动前把大小写变体归一：保留「全大写」写法，删掉其余。
    # 另外顺带清掉 SERVER__PORT 的大小写变体（Spring relaxed binding 会把它当成
    # server.port，实测解析成 57213 造成端口占用）。删除走 .NET API —— Remove-Item Env:
    # 在本机安全包装下（目标不存在即抛异常）会中断流程。
    $snapshot = New-Object System.Collections.ArrayList
    try {
        $envs = [System.Environment]::GetEnvironmentVariables('Process')
        foreach ($k in $envs.Keys) { [void]$snapshot.Add(@([string]$k, [string]$envs[$k])) }
    } catch { return }

    $groups = @{}
    foreach ($pair in $snapshot) {
        $key = $pair[0].ToUpperInvariant()
        if (-not $groups.ContainsKey($key)) { $groups[$key] = New-Object System.Collections.ArrayList }
        [void]$groups[$key].Add($pair)
    }
    foreach ($key in @($groups.Keys)) {
        $items = @($groups[$key])
        if ($items.Count -lt 2) { continue }
        $value = $null
        foreach ($it in $items) { if ($it[0] -ceq $it[0].ToUpperInvariant()) { $value = $it[1]; break } }
        if ($null -eq $value) { foreach ($it in $items) { if (-not [string]::IsNullOrEmpty($it[1])) { $value = $it[1]; break } } }
        foreach ($it in $items) {
            try { [System.Environment]::SetEnvironmentVariable($it[0], $null, 'Process') } catch { }
        }
        try { [System.Environment]::SetEnvironmentVariable($key, $value, 'Process') } catch { }
    }

    # SERVER__PORT：无论是否有重复写法，一律按规范名清除（Process 作用域，不影响用户环境）
    try { [System.Environment]::SetEnvironmentVariable('SERVER__PORT', $null, 'Process') } catch { }
}

# ------------------------------------------------------------------ 服务路径
function Resolve-ServicePath($Service) {
    $rel = $null
    if ($Service.PSObject.Properties.Name -contains 'dir')  { $rel = [string]$Service.dir }
    if ([string]::IsNullOrWhiteSpace($rel) -and $Service.PSObject.Properties.Name -contains 'path') { $rel = [string]$Service.path }
    if ([string]::IsNullOrWhiteSpace($rel)) { return $null }
    $p = $rel -replace '/', '\'
    if ([System.IO.Path]::IsPathRooted($p)) { return $p }
    return (Join-Path $script:RepoRoot $p)
}

function Get-VenvPython($Service) {
    $rel = '.venv\Scripts\python.exe'
    if ($Service.PSObject.Properties.Name -contains 'venvPython' -and $Service.venvPython) {
        $rel = ([string]$Service.venvPython) -replace '/', '\'
    }
    if ([System.IO.Path]::IsPathRooted($rel)) { return $rel }
    return (Join-Path (Resolve-ServicePath $Service) $rel)
}

# -------------------------------------------------------------- 端口 / 健康
function Test-TcpPort([string]$HostName, [int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $a = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $a.AsyncWaitHandle.WaitOne(800)) { return $false }
        $client.EndConnect($a); return $true
    } catch { return $false } finally { $client.Close() }
}

function Get-HealthAcceptCodes($Service) {
    # 网关显式声明 200/503（上游未就绪时网关自身仍存活）；其余服务只认 200。
    if ($Service.PSObject.Properties.Name -contains 'healthAcceptStatus' -and $Service.healthAcceptStatus) {
        return @($Service.healthAcceptStatus | ForEach-Object { [int]$_ })
    }
    return @(200)
}

function Convert-HealthContent($Raw) {
    # 实测坑：Spring Boot actuator 返回 Content-Type 为 application/vnd.spring-boot.actuator.v3+json，
    # PowerShell 5.1 的 Invoke-WebRequest（-UseBasicParsing）不把它当文本，$r.Content 是 **byte[]**，
    # 于是 .Contains('"UP"') 恒为 false —— 服务其实已经 UP，却被判成「健康等待失败（HTTP 200）」。
    if ($null -eq $Raw) { return '' }
    if ($Raw -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($Raw) }
    return [string]$Raw
}

function Test-HealthOnce([string]$Url, [string]$Contains, [int[]]$AcceptCodes = @(200)) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 4
        $body = Convert-HealthContent $r.Content
        $ok = ($AcceptCodes -contains [int]$r.StatusCode) -and ([string]::IsNullOrEmpty($Contains) -or $body.Contains($Contains))
        return @{ ok = $ok; code = [int]$r.StatusCode; detail = ('HTTP ' + $r.StatusCode); dead = $false }
    } catch {
        $resp = $_.Exception.Response
        if ($null -ne $resp) {
            $c = [int]$resp.StatusCode
            return @{ ok = ($AcceptCodes -contains $c); code = $c; detail = ('HTTP ' + $c); dead = $false }
        }
        return @{ ok = $false; code = 0; detail = $_.Exception.Message; dead = $false }
    }
}

function Wait-Health([string]$Url, [string]$Contains, [int]$TimeoutSec, [int[]]$AcceptCodes = @(200), [int]$ProcessId = 0) {
    if ($TimeoutSec -lt 1) { $TimeoutSec = 1 }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $last = @{ ok = $false; code = 0; detail = 'timeout'; dead = $false }
    while ((Get-Date) -lt $deadline) {
        if ($ProcessId -gt 0 -and -not (Test-PidAlive $ProcessId)) {
            return @{ ok = $false; code = 0; detail = 'process-exited'; dead = $true }
        }
        $r = Test-HealthOnce $Url $Contains $AcceptCodes
        if ($r.ok) { return $r }
        $last = $r
        Start-Sleep -Milliseconds 1000
    }
    return $last
}

# ------------------------------------------------------------------- 进程 / pid
function Get-PidFilePath([string]$Name) { Join-Path $script:RunDir ($Name + '.pid') }

function Read-ServicePid([string]$Name) {
    $p = Get-PidFilePath $Name
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    try {
        $raw = (Get-Content -LiteralPath $p -Raw -ErrorAction Stop)
        if ($null -eq $raw) { return $null }
        $raw = $raw.Trim()
        if ($raw -match '^\d+$') { return [int]$raw }
    } catch { }
    return $null
}

function Test-PidAlive($ProcessId) {
    if ($null -eq $ProcessId) { return $false }
    try { $p = Get-Process -Id ([int]$ProcessId) -ErrorAction Stop; return ($null -ne $p) }
    catch { return $false }
}
# 旧名兼容
function Test-ProcessAlive([int]$ProcessId) { Test-PidAlive $ProcessId }
function Get-ServiceProcessId([string]$Name) { Read-ServicePid $Name }

function Remove-FileQuiet([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    try { if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop } }
    catch { }
}

# ------------------------------------------------------------------- 状态聚合
function Get-ServiceStatus($Service, $Config) {
    $h = Test-HealthOnce $Service.healthUrl $Service.healthContains (Get-HealthAcceptCodes $Service)
    $port = [int]$Config.ports.($Service.portKey)
    $pid = Read-ServicePid $Service.name
    $alive = $false; if ($null -ne $pid) { $alive = Test-PidAlive $pid }
    $open = Test-TcpPort '127.0.0.1' $port
    $state = '未启动'
    if ($h.ok -and $h.code -eq 200) { $state = '正常' }
    elseif ($h.ok) { $state = '降级' }
    elseif ($open) { $state = '端口被占用' }
    elseif ($alive) { $state = '异常' }
    return [pscustomobject]@{ name = $Service.name; port = $port; pid = $pid; alive = $alive; portOpen = $open; health = $h; state = $state }
}

function Test-ServicePrerequisites($Service, $Config) {
    $issues = New-Object System.Collections.ArrayList
    $dir = Resolve-ServicePath $Service
    if (-not (Test-Path -LiteralPath $dir)) { [void]$issues.Add("服务目录不存在：$dir") }
    return @($issues)
}

# ------------------------------------------------------------------- 输出工具
function Quote-Arg([string]$Value) { if ($Value -match '[\s"]') { return ('"' + ($Value -replace '"', '\"') + '"') }; return $Value }
function Info([string]$Message) { Write-Host $Message -ForegroundColor Cyan }
function Ok([string]$Message)   { Write-Host $Message -ForegroundColor Green }
function Warn([string]$Message) { Write-Host $Message -ForegroundColor Yellow }
function Bad([string]$Message)  { Write-Host $Message -ForegroundColor Red }
