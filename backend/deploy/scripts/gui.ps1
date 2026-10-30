<#
  gui.ps1 — 本地后端「一键启动」图形面板（常驻窗口）

  规格：docs/v4/08-后端实施双Agent总纲.md §8（一键启动）+ 本次追加的图形化要求：
    ① 图形化界面：服务状态矩阵 / 请求流水 / 服务日志 / 操作输出 四个视图；
    ② 常驻窗口：启动完成后窗口不退出，持续刷新（不像 start-all.bat 那样 pause 后关闭）；
    ③ 显示后端请求信息：解析网关 uvicorn 访问日志（logs\gateway.log），按状态码着色；
    ④ 显示处理信息：编排器实时输出 + 各服务日志增量尾部；
    ⑤ 显示是否成功：请求级（2xx/4xx/5xx/上游失败）与服务级（正常/降级/异常/未启动）两级判定。

  用法：
    双击 backend\deploy\start-gui.bat
    powershell -STA -NoProfile -ExecutionPolicy Bypass -File backend\deploy\scripts\gui.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File backend\deploy\scripts\gui.ps1 -SelfTest   # 无界面自检

  约束：
    - 面板**只观察与转发操作**：启动/停止/重启/冒烟全部转交 orchestrator.ps1（子进程）执行，
      不在本文件里重复实现编排逻辑（避免两套启动语义）。
    - 判定口径与命令行一致：健康接受码、端口探测、pid 存活全部取自 deploy-common.ps1。
    - 不做守护/自动重启（与 deploy\README.md 的既有边界一致）：面板是监控台，不是进程守护。
#>
param(
    [switch]$SelfTest,          # 无界面自检：跑一轮采集并打印结果（供自动化验证）
    [switch]$NoAutoRefresh      # 面板打开时不自动刷新（仍会做一次首屏采集）
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- 环境前置
# WinForms 必须是 STA 线程；用非 STA 方式直接调用本脚本时，自动以 -STA 重启自己。
if (-not $SelfTest -and ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA)) {
    $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $selfPath = $MyInvocation.MyCommand.Path
    Write-Host "[gui] 当前线程非 STA，正在以 -STA 重新启动面板…"
    & $psExe -NoProfile -STA -ExecutionPolicy Bypass -File $selfPath
    exit $LASTEXITCODE
}

$ScriptsDir = $PSScriptRoot
. (Join-Path $ScriptsDir "deploy-common.ps1")   # 路径常量 + 判定口径（与 orchestrator.ps1 同一份）
$DeployDir = $script:DeployRoot                 # deploy-common 只定义 $script:DeployRoot；本文件沿用 $DeployDir 别名
Remove-CaseDuplicateEnv

# 系统代理会把 127.0.0.1 也送进代理 → 502；显式清空默认代理（与 accept-frontend-contract.ps1 一致）
try { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy } catch { }

$Cfg = $null
try {
    $Cfg = Load-Config
} catch {
    if ($SelfTest) { Write-Host ("配置读取失败：" + $_.Exception.Message); exit 2 }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(("配置读取失败：" + $_.Exception.Message), "后端控制台") | Out-Null
    exit 2
}

# ================================================================ 采集脚本块
# 面板与 -SelfTest 共用同一份采集逻辑（单一事实来源，避免自检通过但面板行为不同）。
$CollectorScript = {
    param($state, $scriptsDir, $deployDir)

    $ErrorActionPreference = "Continue"
    try { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy } catch { }
    . (Join-Path $scriptsDir "deploy-common.ps1")

    $logsDir = Join-Path $deployDir "logs"
    $runDir = Join-Path $deployDir "run"
    $positions = @{}      # 文件 → 已读字节位置（增量读取）
    $encodings = @{}      # 文件 → 编码嗅探结果（utf8 / cp936）

    $cfg = $null
    try { $cfg = Load-Config } catch { $cfg = $null }

    # uvicorn 访问日志行：INFO:     127.0.0.1:56337 - "GET /api/gw/health HTTP/1.1" 200 OK
    $reqRx = [regex]'^(?<lvl>[A-Z]+):\s+(?<client>\S+)\s+-\s+"(?<method>[A-Z]+)\s+(?<path>[^"]+?)\s+HTTP/(?<ver>[\d\.]+)"\s+(?<code>\d{3})(?<rest>.*)$'
    # 网关上游失败告警（edge-gateway.proxy）：上游不可达/上游超时/上游异常
    # 形如：2026-10-20 13:28:37,703 WARNING edge-gateway.proxy 上游不可达 GET /api/v1/me（ConnectError）
    $errRx = [regex]'(?<kind>上游不可达|上游超时|上游异常)\s+(?<method>[A-Z]+)\s+(?<path>[^\s（(]+)\s*[（(](?<reason>[^)）]*)[)）]'

    function Read-Delta([string]$path, [string]$key) {
        # 运行中的进程独占日志文件，必须 FileShare.ReadWrite 打开；增量读避免反复全量扫描。
        if ([string]::IsNullOrEmpty($path)) { return "" }
        if (-not (Test-Path -LiteralPath $path)) { return "" }
        try {
            $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            try {
                $len = $fs.Length
                $pos = 0L
                if ($positions.ContainsKey($key)) { $pos = [int64]$positions[$key] }
                if ($pos -gt $len) { $pos = 0L }        # 文件被轮转/截断 → 从头读
                $fs.Seek($pos, [System.IO.SeekOrigin]::Begin) | Out-Null
                $count = [int]($len - $pos)
                if ($count -le 0) { return "" }
                if ($count -gt 262144) { $count = 262144 }   # 单次最多 256KB
                $buf = New-Object byte[] $count
                $read = $fs.Read($buf, 0, $count)
                $positions[$key] = $pos + $read
                if ($read -le 0) { return "" }
                # 编码嗅探：UTF-8 严格解码失败 → 回落 CP936（网关/AI 的 error 日志含 GBK 中文）
                if ($encodings[$key] -eq "cp936") {
                    return [System.Text.Encoding]::GetEncoding(936).GetString($buf, 0, $read)
                }
                $strict = New-Object System.Text.UTF8Encoding($false, $true)
                try {
                    return $strict.GetString($buf, 0, $read)
                } catch {
                    $encodings[$key] = "cp936"
                    return [System.Text.Encoding]::GetEncoding(936).GetString($buf, 0, $read)
                }
            } finally { $fs.Dispose() }
        } catch { return "" }
    }

    function Get-LogFiles {
        # 动态枚举日志文件（服务启动后日志文件才出现/轮转）
        $items = @()
        try {
            $files = @(Get-ChildItem -Path $logsDir -File -ErrorAction SilentlyContinue |
                Where-Object { ($_.Name -like "*.log" -or $_.Name -like "*.error.log") -and $_.Name -notlike "*.bak" })
            foreach ($f in $files) {
                $items += [pscustomobject]@{ Key = $f.Name; Path = $f.FullName }
            }
        } catch { }
        return $items
    }

    while ($true) {
        # ---------------- 服务状态矩阵（判定口径与 orchestrator 完全一致）----------------
        $rows = @()
        if ($null -ne $cfg) {
            foreach ($svc in $cfg.services) {
                $port = 0
                try { $port = [int]$cfg.ports.($svc.portKey) } catch { $port = 0 }
                $procId = Read-ServicePid $svc.name
                $alive = Test-PidAlive $procId
                $portOpen = Test-TcpPort "127.0.0.1" $port 400
                $accept = Get-HealthAcceptCodes $svc
                $ok = $false
                $detail = "未探测"
                $body = ""
                try {
                    $h = Test-HealthOnce $svc.healthUrl $svc.healthContains $accept 8
                    $ok = $h.ok
                    $detail = $h.detail
                    $body = [string]$h.body
                } catch { $detail = "探测异常" }

                $verdict = "未启动"
                $level = "idle"
                if ($ok) {
                    if ($detail -eq "HTTP 200") { $verdict = "正常"; $level = "ok" }
                    else { $verdict = "降级"; $level = "warn" }   # 网关 503 = 上游不可达但进程存活
                } elseif ($alive) { $verdict = "异常"; $level = "bad" }
                elseif ($portOpen) { $verdict = "端口被占用"; $level = "bad" }

                # 上游明细（网关健康体里的 upstreams 列表）：业务服务挂掉时明确指出是谁不可达
                $note = ""
                if ($body) {
                    $down = @()
                    $up = @()
                    foreach ($m in [regex]::Matches($body, '"name":"(?<n>[^"]+)","reachable":(?<v>true|false)')) {
                        if ($m.Groups["v"].Value -eq "true") { $up += $m.Groups["n"].Value }
                        else { $down += $m.Groups["n"].Value }
                    }
                    if ($down.Count -gt 0) { $note = "上游不可达：" + ($down -join "、") }
                    elseif ($up.Count -gt 0) { $note = "上游可达：" + ($up -join "、") }
                }
                if ($level -eq "bad" -and $note -eq "") {
                    if (-not $alive -and $portOpen) { $note = "端口被占用但不是本工具启动的进程，请先处理占用" }
                    else { $note = "进程在但健康探测失败，见「服务日志」页签" }
                } elseif ($level -eq "warn" -and $note -eq "") {
                    $note = "上游不可达但进程存活（网关降级）"
                }

                $pidText = "-"
                if ($null -ne $procId) { $pidText = [string]$procId }
                $rows += [pscustomobject]@{
                    Name = $svc.name; Label = $svc.label; Port = $port; Pid = $pidText
                    Alive = $alive; PortOpen = $portOpen; Health = $detail
                    Verdict = $verdict; Level = $level; Note = $note
                }
            }
        }
        $state["status"] = $rows

        # ---------------- 请求流水（网关访问日志）----------------
        $probePaths = @()
        if ($null -ne $cfg) {
            foreach ($svc in $cfg.services) {
                # 取健康检查的路径部分（不能直接 IndexOf("/")，那会截到 "//host"）
                try { $probePaths += ([System.Uri]([string]$svc.healthUrl)).AbsolutePath } catch { }
            }
        }
        $now = Get-Date -Format "HH:mm:ss"
        $chunk = Read-Delta (Join-Path $logsDir "gateway.log") "gateway.log"
        if ($chunk) {
            foreach ($line in ($chunk -split "`r?`n")) {
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                $m = $reqRx.Match($line)
                if (-not $m.Success) { continue }
                $code = [int]$m.Groups["code"].Value
                $path = $m.Groups["path"].Value
                $kind = "biz"
                if ($probePaths -contains $path) { $kind = "probe" }
                $verdict = "成功"; $level = "ok"
                if ($code -ge 500) { $verdict = "服务端错误"; $level = "bad" }
                elseif ($code -ge 400) { $verdict = "客户端错误"; $level = "warn" }
                elseif ($code -ge 300) { $verdict = "跳转"; $level = "info" }
                $row = [pscustomobject]@{
                    Time = $now; Method = $m.Groups["method"].Value; Path = $path; Code = $code
                    Verdict = $verdict; Level = $level; Client = $m.Groups["client"].Value; Kind = $kind; Note = ""
                }
                [System.Threading.Monitor]::Enter($state.SyncRoot)
                try {
                    while ($state["requests"].Count -gt 2000) { $state["requests"].RemoveAt(0) }
                    [void]$state["requests"].Add($row)
                    $state["counters"]["total"] = [int]$state["counters"]["total"] + 1
                    if ($kind -eq "probe") { $state["counters"]["probe"] = [int]$state["counters"]["probe"] + 1 }
                    elseif ($level -eq "ok") { $state["counters"]["ok"] = [int]$state["counters"]["ok"] + 1 }
                    else { $state["counters"]["fail"] = [int]$state["counters"]["fail"] + 1 }
                } finally { [System.Threading.Monitor]::Exit($state.SyncRoot) }
            }
        }

        # ---------------- 上游失败告警（网关 error 日志）----------------
        $errChunk = Read-Delta (Join-Path $logsDir "gateway.error.log") "gateway.error.log"
        if ($errChunk) {
            foreach ($line in ($errChunk -split "`r?`n")) {
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                $m = $errRx.Match($line)
                if (-not $m.Success) { continue }
                $code = 503
                if ($m.Groups["kind"].Value -eq "上游超时") { $code = 504 }
                elseif ($m.Groups["kind"].Value -eq "上游异常") { $code = 502 }
                $method = $m.Groups["method"].Value
                $path = $m.Groups["path"].Value
                $reason = $m.Groups["reason"].Value
                # 命中健康探测路径的上游失败随探测请求一起隐藏（与「隐藏健康探测请求」开关一致）
                $kind = "upstream"
                if ($probePaths -contains $path) { $kind = "upstream-probe" }
                [System.Threading.Monitor]::Enter($state.SyncRoot)
                try {
                    # 上游失败是**同一请求的补充说明**（访问日志里已有该请求的 5xx 行），
                    # 因此不新增显示行、不重复计数：由界面层合并到同一条记录上。
                    $row = [pscustomobject]@{
                        Time = $now; Method = $method; Path = $path; Code = $code
                        Verdict = "上游失败"; Level = "bad"; Client = "网关"; Kind = $kind; Note = $reason
                    }
                    while ($state["requests"].Count -gt 2000) { $state["requests"].RemoveAt(0) }
                    [void]$state["requests"].Add($row)
                } finally { [System.Threading.Monitor]::Exit($state.SyncRoot) }
            }
        }

        # ---------------- 各服务日志增量（供「日志」页签按需取用）----------------
        foreach ($f in (Get-LogFiles)) {
            $t = Read-Delta $f.Path $f.Key
            if ($t) {
                [System.Threading.Monitor]::Enter($state.SyncRoot)
                try {
                    $state["logs"][$f.Key] = ([string]$state["logs"][$f.Key]) + $t
                } finally { [System.Threading.Monitor]::Exit($state.SyncRoot) }
            }
        }

        # ---------------- 编排器操作输出（实时）----------------
        $opOut = Read-Delta (Join-Path $runDir "_gui-op-out.txt") "_gui-op-out.txt"
        $opErr = Read-Delta (Join-Path $runDir "_gui-op-err.txt") "_gui-op-err.txt"
        if ($opOut -or $opErr) {
            [System.Threading.Monitor]::Enter($state.SyncRoot)
            try { $state["op"] = ([string]$state["op"]) + $opOut + $opErr }
            finally { [System.Threading.Monitor]::Exit($state.SyncRoot) }
        }

        # 自检模式跑满指定轮数（首轮探测产生的请求行要等下一轮才出现在访问日志里）
        if ($state["once"]) {
            $state["once"] = [int]$state["once"] - 1
            if ([int]$state["once"] -le 0) { break }
        }
        if (-not $state["wake"]) { Start-Sleep -Milliseconds 1500 }
        $state["wake"] = $false
    }
}

# ================================================================ 自检模式
if ($SelfTest) {
    $state = [hashtable]::Synchronized(@{})
    $state["status"] = @()
    $state["requests"] = New-Object System.Collections.ArrayList
    $state["logs"] = [hashtable]::Synchronized(@{})
    $state["op"] = ""
    $state["counters"] = @{ total = 0; ok = 0; fail = 0; probe = 0 }
    $state["once"] = 3
    & $CollectorScript $state $ScriptsDir $DeployDir
    Write-Host "== 服务状态矩阵 =="
    foreach ($r in $state["status"]) {
        Write-Host ("  {0,-9} 端口 {1,-6} pid {2,-7} 进程 {3,-3} 健康 {4,-10} 判定 {5,-6} {6}" -f `
            $r.Name, $r.Port, $r.Pid, $(if ($r.Alive) { "在" } else { "无" }), $r.Health, $r.Verdict, $r.Note)
    }
    Write-Host "== 请求流水（最近 10 条）=="
    $rows = @($state["requests"])
    $take = if ($rows.Count -gt 10) { $rows[-10..-1] } else { $rows }
    foreach ($r in $take) {
        Write-Host ("  {0} {1,-6} {2,-38} {3} {4,-8} {5}" -f $r.Time, $r.Method, $r.Path, $r.Code, $r.Verdict, $r.Note)
    }
    Write-Host ("== 计数：总 {0} / 成功 {1} / 失败 {2} / 探测 {3} ==" -f `
        $state["counters"]["total"], $state["counters"]["ok"], $state["counters"]["fail"], $state["counters"]["probe"])
    Write-Host ("== 日志文件增量：{0} 个 ==" -f $state["logs"].Count)
    exit 0
}

# ================================================================ 图形界面
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$colOk   = [System.Drawing.Color]::FromArgb(21, 101, 56)
$colWarn = [System.Drawing.Color]::FromArgb(173, 104, 0)
$colBad  = [System.Drawing.Color]::FromArgb(173, 40, 40)
$colIdle = [System.Drawing.Color]::FromArgb(120, 120, 120)
$colInfo = [System.Drawing.Color]::FromArgb(40, 80, 160)

$uiFont   = [System.Drawing.Font]::new("Microsoft YaHei UI", 9.0)
$boldFont = [System.Drawing.Font]::new("Microsoft YaHei UI", 11.0, [System.Drawing.FontStyle]::Bold)
$monoFont = [System.Drawing.Font]::new("Consolas", 9.0)

$form = New-Object System.Windows.Forms.Form
$form.Text = "医疗健康 AI 小程序 · 后端控制台"
$form.Size = [System.Drawing.Size]::new(1180, 780)
$form.MinimumSize = [System.Drawing.Size]::new(940, 620)
$form.StartPosition = "CenterScreen"
$form.Font = $uiFont
$form.BackColor = [System.Drawing.Color]::White

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = "Fill"
$root.ColumnCount = 1
$root.RowCount = 4
[void]$root.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
[void]$root.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::AutoSize))    # 0 标题
[void]$root.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::AutoSize))    # 1 工具栏
[void]$root.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 150)) # 2 状态矩阵
[void]$root.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))   # 3 页签
$form.Controls.Add($root)

# ---------------- 标题 ----------------
$header = New-Object System.Windows.Forms.TableLayoutPanel
$header.Dock = "Fill"
$header.ColumnCount = 1
$header.RowCount = 2
$header.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)
[void]$header.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
[void]$header.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::AutoSize))
[void]$header.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::AutoSize))
$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "医疗健康 AI 小程序 · 本地后端控制台"
$lblTitle.Font = $boldFont
$lblTitle.AutoSize = $true
$lblTitle.Margin = [System.Windows.Forms.Padding]::new(10, 8, 10, 0)
$lblSummary = New-Object System.Windows.Forms.Label
$lblSummary.Text = "正在采集…"
$lblSummary.ForeColor = [System.Drawing.Color]::DimGray
$lblSummary.AutoSize = $true
$lblSummary.Margin = [System.Windows.Forms.Padding]::new(10, 0, 10, 8)
[void]$header.Controls.Add($lblTitle, 0, 0)
[void]$header.Controls.Add($lblSummary, 0, 1)
$root.Controls.Add($header, 0, 0)

# ---------------- 工具栏 ----------------
$toolbar = New-Object System.Windows.Forms.FlowLayoutPanel
$toolbar.Dock = "Fill"
$toolbar.AutoSize = $true
$toolbar.WrapContents = $false
$toolbar.Padding = [System.Windows.Forms.Padding]::new(8, 6, 8, 6)
$toolbar.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)

function New-ToolButton([string]$text, [int]$width = 96) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Width = $width
    $b.Height = 28
    $b.Margin = [System.Windows.Forms.Padding]::new(0, 0, 8, 0)
    $b.FlatStyle = [System.Windows.Forms.FlatStyle]::System
    return $b
}

$btnStart = New-ToolButton "启动全部"
$btnStop = New-ToolButton "停止全部"
$btnRestart = New-ToolButton "重启"
$btnSmoke = New-ToolButton "冒烟检查"
$btnResetSlots = New-ToolButton "一键重置号源" 110
$btnRefresh = New-ToolButton "刷新" 80
$btnOpenLogs = New-ToolButton "日志目录" 90
$chkAuto = New-Object System.Windows.Forms.CheckBox
$chkAuto.Text = "自动刷新"
$chkAuto.Checked = (-not $NoAutoRefresh)
$chkAuto.AutoSize = $true
$chkAuto.Margin = [System.Windows.Forms.Padding]::new(10, 7, 8, 0)
$chkStopOnClose = New-Object System.Windows.Forms.CheckBox
$chkStopOnClose.Text = "关闭面板时停止服务"
$chkStopOnClose.Checked = $false
$chkStopOnClose.AutoSize = $true
$chkStopOnClose.Margin = [System.Windows.Forms.Padding]::new(10, 7, 8, 0)
$lblTick = New-Object System.Windows.Forms.Label
$lblTick.Text = "上次刷新：—"
$lblTick.AutoSize = $true
$lblTick.ForeColor = [System.Drawing.Color]::DimGray
$lblTick.Margin = [System.Windows.Forms.Padding]::new(10, 7, 8, 0)

foreach ($c in @($btnStart, $btnStop, $btnRestart, $btnSmoke, $btnResetSlots, $btnRefresh, $btnOpenLogs, $chkAuto, $chkStopOnClose, $lblTick)) {
    [void]$toolbar.Controls.Add($c)
}
$root.Controls.Add($toolbar, 0, 1)

# ---------------- 状态矩阵 ----------------
$matrix = New-Object System.Windows.Forms.ListView
$matrix.Dock = "Fill"
$matrix.View = [System.Windows.Forms.View]::Details
$matrix.FullRowSelect = $true
$matrix.GridLines = $true
$matrix.HideSelection = $true
$matrix.Font = $uiFont
foreach ($c in @(
    @{ t = "服务"; w = 110 }, @{ t = "端口"; w = 80 }, @{ t = "PID"; w = 90 },
    @{ t = "进程"; w = 70 }, @{ t = "健康探测"; w = 130 }, @{ t = "判定"; w = 120 }, @{ t = "说明"; w = 400 })) {
    [void]$matrix.Columns.Add($c.t, $c.w)
}
$root.Controls.Add($matrix, 0, 2)

# ---------------- 页签 ----------------
$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = "Fill"

# 请求页
$tabReq = New-Object System.Windows.Forms.TabPage
$tabReq.Text = "请求流水"
$tabReq.Padding = [System.Windows.Forms.Padding]::new(6)
$reqTop = New-Object System.Windows.Forms.Panel
$reqTop.Dock = "Top"
$reqTop.Height = 30
$chkHideProbe = New-Object System.Windows.Forms.CheckBox
$chkHideProbe.Text = "隐藏健康探测请求"
$chkHideProbe.Checked = $true
$chkHideProbe.AutoSize = $true
$chkHideProbe.Location = [System.Drawing.Point]::new(6, 6)
$lblReqHint = New-Object System.Windows.Forms.Label
$lblReqHint.Text = "数据源：logs\gateway.log（网关访问日志）。「时间」为面板观测时间（uvicorn 访问日志本身不含时间戳）。"
$lblReqHint.AutoSize = $true
$lblReqHint.ForeColor = [System.Drawing.Color]::DimGray
$lblReqHint.Location = [System.Drawing.Point]::new(150, 8)
[void]$reqTop.Controls.Add($chkHideProbe)
[void]$reqTop.Controls.Add($lblReqHint)
$listReq = New-Object System.Windows.Forms.ListView
$listReq.Dock = "Fill"
$listReq.View = [System.Windows.Forms.View]::Details
$listReq.FullRowSelect = $true
$listReq.GridLines = $true
$listReq.HideSelection = $false
$listReq.Font = $uiFont
foreach ($c in @(
    @{ t = "时间"; w = 90 }, @{ t = "方法"; w = 80 }, @{ t = "路径"; w = 420 },
    @{ t = "状态码"; w = 80 }, @{ t = "判定"; w = 110 }, @{ t = "客户端"; w = 150 }, @{ t = "说明"; w = 160 })) {
    [void]$listReq.Columns.Add($c.t, $c.w)
}
[void]$tabReq.Controls.Add($listReq)
[void]$tabReq.Controls.Add($reqTop)

# 日志页
$tabLog = New-Object System.Windows.Forms.TabPage
$tabLog.Text = "服务日志"
$tabLog.Padding = [System.Windows.Forms.Padding]::new(6)
$logTop = New-Object System.Windows.Forms.Panel
$logTop.Dock = "Top"
$logTop.Height = 30
$cmbLog = New-Object System.Windows.Forms.ComboBox
$cmbLog.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
$cmbLog.Width = 260
$cmbLog.Location = [System.Drawing.Point]::new(6, 4)
[void]$logTop.Controls.Add($cmbLog)
$lblLogHint = New-Object System.Windows.Forms.Label
$lblLogHint.Text = "增量读取运行中进程的日志（共享读，不影响服务写入）"
$lblLogHint.AutoSize = $true
$lblLogHint.ForeColor = [System.Drawing.Color]::DimGray
$lblLogHint.Location = [System.Drawing.Point]::new(276, 8)
[void]$logTop.Controls.Add($lblLogHint)
$txtLog = New-Object System.Windows.Forms.RichTextBox
$txtLog.Dock = "Fill"
$txtLog.ReadOnly = $true
$txtLog.WordWrap = $false
$txtLog.Font = $monoFont
$txtLog.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$txtLog.ForeColor = [System.Drawing.Color]::Gainsboro
[void]$tabLog.Controls.Add($txtLog)
[void]$tabLog.Controls.Add($logTop)

# 操作页
$tabOp = New-Object System.Windows.Forms.TabPage
$tabOp.Text = "操作输出"
$tabOp.Padding = [System.Windows.Forms.Padding]::new(6)
$txtOp = New-Object System.Windows.Forms.RichTextBox
$txtOp.Dock = "Fill"
$txtOp.ReadOnly = $true
$txtOp.WordWrap = $false
$txtOp.Font = $monoFont
$txtOp.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$txtOp.ForeColor = [System.Drawing.Color]::Gainsboro
[void]$tabOp.Controls.Add($txtOp)

[void]$tabs.TabPages.Add($tabReq)
[void]$tabs.TabPages.Add($tabLog)
[void]$tabs.TabPages.Add($tabOp)
$root.Controls.Add($tabs, 0, 3)

# ---------------- 底部状态栏 ----------------
$statusStrip = New-Object System.Windows.Forms.StatusStrip
$lblStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$lblStatus.Text = "就绪"
$lblStatus.Spring = $true
$lblStatus.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
[void]$statusStrip.Items.Add($lblStatus)
$form.Controls.Add($statusStrip)

# ================================================================ 后台采集
$state = [hashtable]::Synchronized(@{})
$state["status"] = @()
$state["requests"] = New-Object System.Collections.ArrayList
$state["logs"] = [hashtable]::Synchronized(@{})
$state["op"] = ""
$state["counters"] = @{ total = 0; ok = 0; fail = 0; probe = 0 }
$state["running"] = $true
$state["wake"] = $false
$state["once"] = $false

$runspace = [runspacefactory]::CreateRunspace()
$runspace.ApartmentState = "STA"
$runspace.ThreadOptions = "ReuseThread"
$runspace.Open()
$ps = [powershell]::Create()
$ps.Runspace = $runspace
[void]$ps.AddScript($CollectorScript).AddArgument($state).AddArgument($ScriptsDir).AddArgument($DeployDir)
$collectorHandle = $ps.BeginInvoke()

# ================================================================ 界面刷新
$script:matrixSig = ""
$script:opProc = $null
$script:opExited = $true
$script:lastLogKey = ""
$script:logText = ""
$script:reqShown = 0
$script:reqTotal = 0
$script:reqPending = @{}   # "方法|路径" → 已显示但还没等到访问日志行的上游失败行（占位待合并）

function Get-LevelColor([string]$level) {
    switch ($level) {
        "ok"   { return $colOk }
        "warn" { return $colWarn }
        "bad"  { return $colBad }
        "info" { return $colInfo }
        default { return $colIdle }
    }
}

function Update-Matrix {
    $rows = @($state["status"])
    if ($rows.Count -eq 0) { return }
    $sig = ($rows | ForEach-Object { "$($_.Name)|$($_.Pid)|$($_.Health)|$($_.Verdict)|$($_.Note)" }) -join "; "
    if ($sig -eq $script:matrixSig) { return }
    $script:matrixSig = $sig
    $matrix.BeginUpdate()
    $matrix.Items.Clear()
    foreach ($r in $rows) {
        $it = [System.Windows.Forms.ListViewItem]::new([string]$r.Name)
        $it.SubItems.Add([string]$r.Port)
        $it.SubItems.Add([string]$r.Pid)
        $it.SubItems.Add($(if ($r.Alive) { "在" } else { "无" }))
        $it.SubItems.Add([string]$r.Health)
        $it.SubItems.Add([string]$r.Verdict)
        $note = [string]$r.Note
        $it.SubItems.Add($note)
        $color = Get-LevelColor $r.Level
        $it.ForeColor = $color
        $it.SubItems[3].ForeColor = $color
        $it.SubItems[4].ForeColor = $color
        $it.SubItems[5].ForeColor = $color
        [void]$matrix.Items.Add($it)
    }
    $matrix.EndUpdate()
}

function Get-ItemCode($it) {
    # 列下标：0 时间 / 1 方法 / 2 路径 / 3 状态码 / 4 判定 / 5 客户端 / 6 说明
    # （ListViewItem.Text 即 SubItems[0]，时间列占用 0，所以整体右移一位）
    $c = 0
    if (-not [int]::TryParse([string]$it.SubItems[3].Text, [ref]$c)) { return 0 }
    return $c
}

function Find-FailItem([string]$method, [string]$path, [int]$code, [bool]$exact) {
    # 从新到旧找可合并的 5xx 行：
    #   exact=true  → 方法+路径必须完全一致（网关透传路径的常见情形）
    #   exact=false → 只按方法+状态码匹配（网关 compat 翻译层改写过路径时两侧路径不同）
    for ($i = $listReq.Items.Count - 1; $i -ge 0; $i--) {
        $it = $listReq.Items[$i]
        if ($it.SubItems[1].Text -ne $method) { continue }
        if ($exact) {
            if ($it.SubItems[2].Text -ne $path) { continue }
        } else {
            if ((Get-ItemCode $it) -ne $code) { continue }
        }
        if ((Get-ItemCode $it) -lt 500) { continue }
        return $it
    }
    return $null
}

function Update-Requests {
    $rows = @()
    [System.Threading.Monitor]::Enter($state.SyncRoot)
    try {
        if ($state["requests"].Count -gt 0) {
            $rows = @($state["requests"])
            $state["requests"].Clear()
        }
    } finally { [System.Threading.Monitor]::Exit($state.SyncRoot) }
    if ($rows.Count -eq 0) { return }
    $listReq.BeginUpdate()
    foreach ($r in $rows) {
        $kind = [string]$r.Kind
        if ($kind -eq "probe") {
            if ($chkHideProbe.Checked) { $script:reqTotal++; continue }
        } elseif ($kind -eq "upstream-probe") {
            if ($chkHideProbe.Checked) { continue }
        }
        $method = [string]$r.Method
        $path = [string]$r.Path

        if ($kind -eq "upstream" -or $kind -eq "upstream-probe") {
            # 上游失败是**同一请求的补充说明**（访问日志里已有该请求的 5xx 行）：
            # 并入那一行 —— 判定改「上游失败」、说明追加失败原因，不新增行、不重复计数。
            $target = Find-FailItem $method $path 0 $true
            $tight = $true
            if ($null -eq $target) {
                $target = Find-FailItem $method $path ([int]$r.Code) $false
                $tight = $false
            }
            if ($null -ne $target) {
                $reason = [string]$r.Note
                if (-not $tight) { $reason = "上游路径 " + $path + "：" + $reason }
                $old = [string]$target.SubItems[6].Text
                if (-not [string]::IsNullOrWhiteSpace($old)) { $reason = $old + "；" + $reason }
                $target.SubItems[4].Text = "上游失败"
                $target.SubItems[6].Text = $reason
                $bad = Get-LevelColor "bad"
                $target.ForeColor = $bad
                $target.SubItems[3].ForeColor = $bad
                $target.SubItems[4].ForeColor = $bad
                continue
            }
            # 还没读到对应的访问日志行 → 先占位，等访问日志行到达时合并
            $it = New-Object System.Windows.Forms.ListViewItem([string]$r.Time)
            $it.SubItems.Add($method)
            $it.SubItems.Add($path)
            $it.SubItems.Add([string]$r.Code)
            $it.SubItems.Add([string]$r.Verdict)
            $it.SubItems.Add([string]$r.Client)
            $it.SubItems.Add([string]$r.Note)
            $it.ForeColor = Get-LevelColor $r.Level
            $it.SubItems[3].ForeColor = Get-LevelColor $r.Level
            $it.SubItems[4].ForeColor = Get-LevelColor $r.Level
            $it.Tag = "UP:" + $method + "|" + $path
            [void]$listReq.Items.Add($it)
            $script:reqPending[$method + "|" + $path] = $it
            $script:reqShown++
            continue
        }

        # 普通访问日志行
        $it = New-Object System.Windows.Forms.ListViewItem([string]$r.Time)
        $it.SubItems.Add($method)
        $it.SubItems.Add($path)
        $it.SubItems.Add([string]$r.Code)
        $it.SubItems.Add([string]$r.Verdict)
        $it.SubItems.Add([string]$r.Client)
        $it.SubItems.Add([string]$r.Note)
        $it.ForeColor = Get-LevelColor $r.Level
        $it.SubItems[3].ForeColor = Get-LevelColor $r.Level
        $it.SubItems[4].ForeColor = Get-LevelColor $r.Level
        $mp = $method + "|" + $path
        if ($script:reqPending.ContainsKey($mp)) {
            # 与先前占位的上游失败行合并：用真实状态码覆盖，判定保留更具体的「上游失败」，说明保留失败原因
            $pend = $script:reqPending[$mp]
            $script:reqPending.Remove($mp)
            $reason = [string]$pend.SubItems[6].Text
            $pend.SubItems[3].Text = [string]$r.Code
            $pend.SubItems[4].Text = "上游失败"
            $pend.SubItems[5].Text = [string]$r.Client
            $pend.SubItems[6].Text = $reason
            $pend.Tag = $mp
            $c = Get-LevelColor "bad"
            $pend.ForeColor = $c
            $pend.SubItems[3].ForeColor = $c
            $pend.SubItems[4].ForeColor = $c
            $script:reqShown++
            continue
        }
        $it.Tag = $mp
        [void]$listReq.Items.Add($it)
        $script:reqShown++
    }
    while ($listReq.Items.Count -gt 800) {
        $old = $listReq.Items[0]
        if ($null -ne $old.Tag) {
            $k = [string]$old.Tag
            if ($k.StartsWith("UP:")) { $script:reqPending.Remove($k.Substring(3)) }
        }
        $listReq.Items.RemoveAt(0)
    }
    $listReq.EndUpdate()
    if ($listReq.Items.Count -gt 0) { $listReq.EnsureVisible($listReq.Items.Count - 1) }
}

function Update-LogView {
    $key = ""
    if ($cmbLog.SelectedItem -ne $null) { $key = [string]$cmbLog.SelectedItem }
    if ($key -eq "") { return }
    $delta = ""
    [System.Threading.Monitor]::Enter($state.SyncRoot)
    try {
        $delta = [string]$state["logs"][$key]
        $state["logs"][$key] = ""
    } finally { [System.Threading.Monitor]::Exit($state.SyncRoot) }
    if ($delta -eq "") { return }
    $script:logText += $delta
    if ($script:logText.Length -gt 300000) { $script:logText = $script:logText.Substring($script:logText.Length - 200000) }
    $txtLog.Text = $script:logText
    $txtLog.SelectionStart = $txtLog.Text.Length
    $txtLog.ScrollToCaret()
}

function Update-OpView {
    $delta = ""
    [System.Threading.Monitor]::Enter($state.SyncRoot)
    try {
        $delta = [string]$state["op"]
        $state["op"] = ""
    } finally { [System.Threading.Monitor]::Exit($state.SyncRoot) }
    if ($delta -ne "") {
        $txtOp.AppendText($delta)
        if ($txtOp.TextLength -gt 300000) { $txtOp.Select(0, 100000); $txtOp.SelectedText = "" }
        $txtOp.SelectionStart = $txtOp.TextLength
        $txtOp.ScrollToCaret()
    }
    if (-not $script:opExited -and $null -ne $script:opProc -and $script:opProc.HasExited) {
        $script:opExited = $true
        $rc = $script:opProc.ExitCode
        $verdict = "成功"
        if ($rc -eq 1) { $verdict = "运行期失败（退出码 1）" }
        elseif ($rc -eq 2) { $verdict = "前置未过（退出码 2）" }
        elseif ($rc -ne 0) { $verdict = "异常（退出码 $rc）" }
        $txtOp.AppendText("[" + (Get-Date -Format "HH:mm:ss") + "] 操作结束：退出码 " + $rc + " —— " + $verdict + "`r`n")
        $lblStatus.Text = "上一次操作：" + $verdict
    }
}

function Update-Summary {
    $rows = @($state["status"])
    $ready = @($rows | Where-Object { $_.Level -eq "ok" }).Count
    $degraded = @($rows | Where-Object { $_.Level -eq "warn" }).Count
    $bad = @($rows | Where-Object { $_.Level -eq "bad" }).Count
    $c = $state["counters"]
    $gw = 8080; $bz = 8088; $ai = 8001
    try { $gw = [int]$Cfg.ports.gateway; $bz = [int]$Cfg.ports.business; $ai = [int]$Cfg.ports.ai } catch { }
    $lblSummary.Text = ("统一入口 网关 http://127.0.0.1:{0} · 业务 :{1} · AI :{2}    |    就绪 {3} / 降级 {4} / 异常 {5}    |    请求 成功 {6} / 失败 {7} / 探测 {8}" -f `
        $gw, $bz, $ai, $ready, $degraded, $bad, $c["ok"], $c["fail"], $c["probe"])
    $lblTick.Text = "上次刷新：" + (Get-Date -Format "HH:mm:ss")
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 600
$timer.Add_Tick({
    if (-not $state["running"]) { $timer.Stop(); return }
    try {
        Update-Matrix
        Update-Requests
        Update-LogView
        Update-OpView
        Update-Summary
    } catch {
        $lblStatus.Text = "刷新异常：" + $_.Exception.Message
    }
})
$timer.Start()

# ================================================================ 编排器调用
$psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$orchestrator = Join-Path $ScriptsDir "orchestrator.ps1"

function Invoke-Orchestrator([string]$action, [bool]$smoke) {
    if (-not $script:opExited -and $null -ne $script:opProc -and -not $script:opProc.HasExited) {
        [System.Windows.Forms.MessageBox]::Show("上一个操作仍在进行中，请等待其完成。", "后端控制台") | Out-Null
        return
    }
    $out = Join-Path $RunDir "_gui-op-out.txt"
    $err = Join-Path $RunDir "_gui-op-err.txt"
    Remove-FileQuiet $out
    Remove-FileQuiet $err
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $orchestrator, "-Action", $action, "-Yes")
    if ($smoke) { $argList += "-Smoke" }
    try {
        # 编排器内部 exit 会结束宿主进程，因此只能以子进程方式调用（既有范式见 accept-frontend-contract.ps1）
        $script:opProc = Start-Process -FilePath $psExe -ArgumentList $argList -WorkingDirectory $DeployDir `
            -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
        $script:opExited = $false
        $tabs.SelectedIndex = 2
        $lblStatus.Text = "正在执行：" + $action + $(if ($smoke) { "（含冒烟检查）" } else { "" })
        $state["wake"] = $true
    } catch {
        [System.Windows.Forms.MessageBox]::Show(("无法启动编排器：" + $_.Exception.Message), "后端控制台") | Out-Null
    }
}

$btnStart.Add_Click({ Invoke-Orchestrator "start" $false })
$btnStop.Add_Click({ Invoke-Orchestrator "stop" $false })
$btnRestart.Add_Click({ Invoke-Orchestrator "restart" $false })
$btnSmoke.Add_Click({ Invoke-Orchestrator "start" $true })
$btnResetSlots.Add_Click({
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:8088/api/v1/dev/slots/reset" -Method POST -TimeoutSec 8
        $d = $r.data
        [System.Windows.Forms.MessageBox]::Show(
            ("已关闭过期号源：" + $d.closedExpired + " 条`r`n" +
             "重置 OPEN 号源：" + $d.resetSlots + " 条（每条余 " + $d.remainingEach + "）`r`n`r`n" + $d.message),
            "一键重置号源") | Out-Null
        $lblStatus.Text = "号源已重置为空余 " + $d.remainingEach
    } catch {
        [System.Windows.Forms.MessageBox]::Show(("重置失败：" + $_.Exception.Message + "`r`n请确认 business-service(:8088) 已启动"), "一键重置号源") | Out-Null
    }
})
$btnRefresh.Add_Click({ $state["wake"] = $true })
$btnOpenLogs.Add_Click({
    try { Start-Process -FilePath "explorer.exe" -ArgumentList $LogsDir | Out-Null } catch { }
})
$chkAuto.Add_CheckedChanged({ if ($chkAuto.Checked) { $timer.Start() } else { $timer.Stop() } })
$cmbLog.Add_SelectedIndexChanged({
    $script:logText = ""
    $txtLog.Text = ""
    $key = ""
    if ($cmbLog.SelectedItem -ne $null) { $key = [string]$cmbLog.SelectedItem }
    $txtLog.Text = ""
    $script:logText = ""
})

$form.Add_FormClosing({
    $state["running"] = $false
    $timer.Stop()
    try { $ps.Stop() } catch { }
    if ($chkStopOnClose.Checked) {
        try {
            $out = Join-Path $RunDir "_gui-op-out.txt"
            $err = Join-Path $RunDir "_gui-op-err.txt"
            Remove-FileQuiet $out
            Remove-FileQuiet $err
            $p = Start-Process -FilePath $psExe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $orchestrator, "-Action", "stop", "-Yes") `
                -WorkingDirectory $DeployDir -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
            $null = $p.WaitForExit(60000)
        } catch { }
    }
})

# ---------------- 初始化：日志来源列表 + 首屏 ----------------
try {
    $logFiles = @(Get-ChildItem -Path $LogsDir -File -ErrorAction SilentlyContinue |
        Where-Object { ($_.Name -like "*.log" -or $_.Name -like "*.error.log") -and $_.Name -notlike "*.bak" } |
        Sort-Object Name)
    foreach ($f in $logFiles) { [void]$cmbLog.Items.Add($f.Name) }
} catch { }
if ($cmbLog.Items.Count -gt 0) { $cmbLog.SelectedIndex = 0 }

$lblStatus.Text = "就绪 · 面板常驻，关闭窗口即退出（服务是否随面板停止由工具栏复选框决定）"
$form.Add_Shown({ $state["wake"] = $true })

[System.Windows.Forms.Application]::Run($form)
