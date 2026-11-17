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
    - **面板不承担守护**：掉线自愈与邮件告警在独立常驻进程 guardian.ps1，面板只负责启停它并展示状态
      —— 监控台关掉不影响自愈链路。
    - 视觉规范：单一主色（医疗蓝）+ 中性灰阶 + 语义状态色；色值/字号集中在文件顶部「设计令牌」段，
      界面代码不写字面色值。状态判定文字与色点并存，保证色盲/灰度打印可读。
#>
param(
    [switch]$SelfTest,          # 无界面自检：跑一轮采集并打印结果（供自动化验证）
    [switch]$NoAutoRefresh,     # 面板打开时不自动刷新（仍会做一次首屏采集）
    [string]$ShotPath = "",     # 仅调试：把首屏渲染为 PNG 后退出（视觉回归用，日常不用）
    [int]$ShotTab = 0           # 仅调试：-ShotPath 时截哪个页签（0 请求 / 1 日志 / 2 操作 / 3 守护）
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
        # 两段式采集：① 先落「进程 / 端口」骨架（1s 内首屏可见）；② 逐服务补 HTTP 健康判定。
        # 慢探测（网关健康端点最长 8s 超时）不再让整屏空白；判定分支与单段版本逐字一致。
        $rows = @()
        if ($null -ne $cfg) {
            foreach ($svc in $cfg.services) {
                $port = 0
                try { $port = [int]$cfg.ports.($svc.portKey) } catch { $port = 0 }
                $procId = Read-ServicePid $svc.name
                $alive = Test-PidAlive $procId
                $portOpen = Test-TcpPort "127.0.0.1" $port 400
                $pidText = "-"
                if ($null -ne $procId) { $pidText = [string]$procId }
                # 骨架判定：只区分「有进程 / 端口被占 / 未启动」，健康结论等第二段
                $verdict = "未启动"; $level = "idle"; $health = "未启动"; $note = ""
                if ($alive) { $verdict = "探测中"; $level = "info"; $health = "探测中…" }
                elseif ($portOpen) {
                    $verdict = "端口被占用"; $level = "bad"; $health = "—"
                    $note = "端口被占用但不是本工具启动的进程，请先处理占用"
                }
                $rows += [pscustomobject]@{
                    Name = $svc.name; Label = $svc.label; Port = $port; Pid = $pidText
                    Alive = $alive; PortOpen = $portOpen; Health = $health
                    Verdict = $verdict; Level = $level; Note = $note
                }
            }
        }
        $state["status"] = $rows

        # 第二段：逐服务补健康判定。每完成一个就整体替换数组（浅拷贝），界面永不读到半更新对象
        if ($null -ne $cfg) {
            for ($i = 0; $i -lt $rows.Count; $i++) {
                $svc = $cfg.services[$i]
                $row = $rows[$i]
                $alive = [bool]$row.Alive
                $portOpen = [bool]$row.PortOpen
                $accept = Get-HealthAcceptCodes $svc
                $ok = $false
                $detail = "未探测"
                $body = ""
                # 快路径：无进程且端口未监听 → 不可能健康，跳过 HTTP 探测（判定结果不变，只省掉连接超时）
                if (-not $alive -and -not $portOpen) {
                    $detail = "未启动"
                } else {
                    try {
                        $h = Test-HealthOnce $svc.healthUrl $svc.healthContains $accept 8
                        $ok = $h.ok
                        $detail = $h.detail
                        $body = [string]$h.body
                    } catch { $detail = "探测异常" }
                }

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

                $rows[$i] = [pscustomobject]@{
                    Name = $row.Name; Label = $row.Label; Port = $row.Port; Pid = $row.Pid
                    Alive = $alive; PortOpen = $portOpen; Health = $detail
                    Verdict = $verdict; Level = $level; Note = $note
                }
                $state["status"] = @($rows)
            }
        }

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

# ---------------------------------------------------------------- 设计令牌
# 企业级控制台规范：中性灰阶打底 + 单一主色（医疗蓝）+ 语义状态色三级。
# 色值/字号/间距只在**本段**定义，界面代码不写字面色值 —— 换主题只改这里。
$cPrimary     = [System.Drawing.Color]::FromArgb(28, 88, 158)    # 主色：医疗蓝
$cPrimaryDeep = [System.Drawing.Color]::FromArgb(20, 66, 122)    # 主色按压/悬停
$cPrimarySoft = [System.Drawing.Color]::FromArgb(233, 241, 250)  # 主色浅底（弱强调）
$cPageBg      = [System.Drawing.Color]::FromArgb(243, 245, 248)  # 页面底
$cSurface     = [System.Drawing.Color]::White                    # 卡片面
$cSurfaceAlt  = [System.Drawing.Color]::FromArgb(249, 250, 252)  # 次级面/悬停底
$cBorder      = [System.Drawing.Color]::FromArgb(223, 228, 235)  # 1px 分隔描边
$cBorderDeep  = [System.Drawing.Color]::FromArgb(199, 208, 220)  # 按钮/输入描边
$cText        = [System.Drawing.Color]::FromArgb(26, 32, 42)     # 主文字
$cTextSub     = [System.Drawing.Color]::FromArgb(88, 97, 112)    # 次文字
$cTextWeak    = [System.Drawing.Color]::FromArgb(140, 149, 163)  # 弱文字/注释
$cTermBg      = [System.Drawing.Color]::FromArgb(24, 28, 36)     # 日志深色面
$cTermFg      = [System.Drawing.Color]::FromArgb(201, 209, 217)  # 日志前景
$cDangerSoft  = [System.Drawing.Color]::FromArgb(253, 240, 238)  # 危险浅底

# 语义状态色 —— 沿用旧变量名，Get-LevelColor / 各 Update-* 无需改动
$colOk   = [System.Drawing.Color]::FromArgb(21, 122, 74)    # 正常
$colWarn = [System.Drawing.Color]::FromArgb(176, 106, 0)    # 降级
$colBad  = [System.Drawing.Color]::FromArgb(180, 35, 24)    # 异常
$colIdle = [System.Drawing.Color]::FromArgb(140, 149, 163)  # 未启动
$colInfo = [System.Drawing.Color]::FromArgb(28, 88, 158)    # 信息

# 字体阶梯：标题 15 / 区块 10.5 / 正文 9 / 注释 8.5 / KPI 20 / 等宽 9
$uiFont     = [System.Drawing.Font]::new("Microsoft YaHei UI", 9.0)
$boldFont   = [System.Drawing.Font]::new("Microsoft YaHei UI", 15.0, [System.Drawing.FontStyle]::Bold)
$sectFont   = [System.Drawing.Font]::new("Microsoft YaHei UI", 10.5, [System.Drawing.FontStyle]::Bold)
$metaFont   = [System.Drawing.Font]::new("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Bold)
$subFont    = [System.Drawing.Font]::new("Microsoft YaHei UI", 8.5)
$kpiFont    = [System.Drawing.Font]::new("Microsoft YaHei UI", 20.0, [System.Drawing.FontStyle]::Bold)
$kpiTextFont= [System.Drawing.Font]::new("Microsoft YaHei UI", 13.0, [System.Drawing.FontStyle]::Bold)
$tabFont    = [System.Drawing.Font]::new("Microsoft YaHei UI", 9.0)
$tabSelFont = [System.Drawing.Font]::new("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Bold)
$monoFont   = [System.Drawing.Font]::new("Consolas", 9.0)

# 间距栅格（4 的倍数）
$sp = @{ xs = 4; sm = 8; md = 12; lg = 16; xl = 24 }

# 卡片 1px 描边（WinForms 无 BorderColor，用 Paint 自绘；Pen 必须 Dispose 否则 GDI 句柄泄漏）
function Add-CardBorder($ctrl) {
    $ctrl.Add_Paint({
        param($s, $e)
        $pen = New-Object System.Drawing.Pen($cBorder, 1)
        try { $e.Graphics.DrawRectangle($pen, 0, 0, ($s.Width - 1), ($s.Height - 1)) } finally { $pen.Dispose() }
    })
}

# 按钮分层：primary（唯一主操作）/ softprimary（启用类）/ danger（破坏性）/ ghost（次操作）/ quiet（弱操作）
function New-Btn([string]$text, [int]$w, [string]$kind = "ghost") {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Width = $w
    $b.Height = 30
    $b.Font = $uiFont
    $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $b.FlatAppearance.BorderSize = 1
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    $b.Margin = [System.Windows.Forms.Padding]::new(0, 0, 8, 0)
    $b.UseVisualStyleBackColor = $false   # Flat 样式下必须关闭，否则悬停色不生效
    switch ($kind) {
        "primary" {
            $b.BackColor = $cPrimary; $b.ForeColor = [System.Drawing.Color]::White
            $b.FlatAppearance.BorderColor = $cPrimary
            $b.FlatAppearance.MouseOverBackColor = $cPrimaryDeep
            $b.FlatAppearance.MouseDownBackColor = $cPrimaryDeep
        }
        "softprimary" {
            $b.BackColor = $cPrimarySoft; $b.ForeColor = $cPrimary
            $b.FlatAppearance.BorderColor = $cPrimary
            $b.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(214, 230, 247)
            $b.FlatAppearance.MouseDownBackColor = [System.Drawing.Color]::FromArgb(214, 230, 247)
        }
        "danger" {
            $b.BackColor = $cSurface; $b.ForeColor = $colBad
            $b.FlatAppearance.BorderColor = $colBad
            $b.FlatAppearance.MouseOverBackColor = $cDangerSoft
            $b.FlatAppearance.MouseDownBackColor = $cDangerSoft
        }
        "quiet" {
            $b.BackColor = $cSurface; $b.ForeColor = $cTextSub
            $b.FlatAppearance.BorderColor = $cBorder
            $b.FlatAppearance.MouseOverBackColor = $cSurfaceAlt
            $b.FlatAppearance.MouseDownBackColor = $cSurfaceAlt
        }
        default {
            $b.BackColor = $cSurface; $b.ForeColor = $cText
            $b.FlatAppearance.BorderColor = $cBorderDeep
            $b.FlatAppearance.MouseOverBackColor = $cSurfaceAlt
            $b.FlatAppearance.MouseDownBackColor = $cSurfaceAlt
        }
    }
    return $b
}

# ListView 行高统一撑到 26px（借 1px 透明图占位；默认 ~20px 太挤，企业级表格宜疏）
function New-RowHeightImageList {
    $il = New-Object System.Windows.Forms.ImageList
    $il.ImageSize = [System.Drawing.Size]::new(1, 26)
    $il.ColorDepth = [System.Windows.Forms.ColorDepth]::Depth32Bit
    $bmp = New-Object System.Drawing.Bitmap(1, 26)
    $bmp.MakeTransparent($bmp.GetPixel(0, 0))
    [void]$il.Images.Add($bmp)
    return $il
}
$rowIco = New-RowHeightImageList

$form = New-Object System.Windows.Forms.Form
$form.Text = "康诊云 · 后端控制台"
$form.Size = [System.Drawing.Size]::new(1240, 840)
$form.MinimumSize = [System.Drawing.Size]::new(1020, 700)
$form.StartPosition = "CenterScreen"
$form.Font = $uiFont
$form.BackColor = $cPageBg

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = "Fill"
$root.ColumnCount = 1
$root.RowCount = 5
[void]$root.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
[void]$root.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::AutoSize))     # 0 品牌栏
[void]$root.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 88)) # 1 KPI 概览
[void]$root.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::AutoSize))     # 2 工具栏
[void]$root.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 178))# 3 状态矩阵
[void]$root.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 100)) # 4 页签
$form.Controls.Add($root)

# ---------------- 品牌栏（左：标识 + 标题；右：入口地址 + 守护徽标）----------------
$header = New-Object System.Windows.Forms.TableLayoutPanel
$header.Dock = "Fill"
$header.AutoSize = $true
$header.ColumnCount = 3
$header.RowCount = 1
$header.BackColor = $cSurface
$header.Padding = [System.Windows.Forms.Padding]::new($sp.lg, 10, $sp.lg, 10)
[void]$header.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Absolute, 46))
[void]$header.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
[void]$header.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::AutoSize))

# 品牌标识：主色方块 + 单字（无位图依赖，高 DPI 不失真）
$logo = New-Object System.Windows.Forms.Panel
$logo.Size = [System.Drawing.Size]::new(36, 36)
$logo.BackColor = $cPrimary
$logo.Margin = [System.Windows.Forms.Padding]::new(0, 3, 10, 0)
$logoText = New-Object System.Windows.Forms.Label
$logoText.Text = "康"
$logoText.Dock = "Fill"
$logoText.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$logoText.ForeColor = [System.Drawing.Color]::White
$logoText.Font = [System.Drawing.Font]::new("Microsoft YaHei UI", 14.0, [System.Drawing.FontStyle]::Bold)
[void]$logo.Controls.Add($logoText)

$titleBox = New-Object System.Windows.Forms.TableLayoutPanel
$titleBox.Dock = "Fill"
$titleBox.AutoSize = $true
$titleBox.ColumnCount = 1
$titleBox.RowCount = 2
[void]$titleBox.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
[void]$titleBox.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::AutoSize))
[void]$titleBox.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::AutoSize))
$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "康诊云 · 本地后端控制台"
$lblTitle.Font = $boldFont
$lblTitle.ForeColor = $cText
$lblTitle.AutoSize = $true
$lblTitle.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 2)
$lblSummary = New-Object System.Windows.Forms.Label
$lblSummary.Text = "正在采集…"
$lblSummary.ForeColor = $cTextSub
$lblSummary.Font = $subFont
$lblSummary.AutoSize = $true
$lblSummary.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 0)
[void]$titleBox.Controls.Add($lblTitle, 0, 0)
[void]$titleBox.Controls.Add($lblSummary, 0, 1)

# 右侧徽标区（RightToLeft：先加的靠最右）
$badgeBox = New-Object System.Windows.Forms.FlowLayoutPanel
$badgeBox.FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft
$badgeBox.WrapContents = $false
$badgeBox.AutoSize = $true
$badgeBox.Dock = "Fill"
$badgeBox.Margin = [System.Windows.Forms.Padding]::new(0)
$guardBadge = New-Object System.Windows.Forms.Panel
$guardBadge.AutoSize = $true
$guardBadge.BackColor = $cSurfaceAlt
$guardBadge.Padding = [System.Windows.Forms.Padding]::new(10, 5, 10, 5)
$guardBadge.Margin = [System.Windows.Forms.Padding]::new(8, 4, 0, 0)
Add-CardBorder $guardBadge
$lblGuard = New-Object System.Windows.Forms.Label
$lblGuard.Text = "● 守护 检测中"
$lblGuard.AutoSize = $true
$lblGuard.Font = $metaFont
$lblGuard.ForeColor = $cTextWeak
[void]$guardBadge.Controls.Add($lblGuard)
$entryVal = "—"
try { $entryVal = "http://127.0.0.1:" + [int]$Cfg.ports.gateway } catch { }
$lblEntry = New-Object System.Windows.Forms.Label
$lblEntry.Text = "统一入口  " + $entryVal
$lblEntry.AutoSize = $true
$lblEntry.Font = $subFont
$lblEntry.ForeColor = $cTextSub
$lblEntry.Margin = [System.Windows.Forms.Padding]::new(6, 10, 8, 0)
[void]$badgeBox.Controls.Add($guardBadge)
[void]$badgeBox.Controls.Add($lblEntry)
[void]$header.Controls.Add($logo, 0, 0)
[void]$header.Controls.Add($titleBox, 1, 0)
[void]$header.Controls.Add($badgeBox, 2, 0)
$root.Controls.Add($header, 0, 0)

# ---------------- KPI 概览条（数据前置：4 张指标卡）----------------
$kpiBar = New-Object System.Windows.Forms.TableLayoutPanel
$kpiBar.Dock = "Fill"
$kpiBar.ColumnCount = 4
$kpiBar.RowCount = 1
$kpiBar.BackColor = $cPageBg
$kpiBar.Padding = [System.Windows.Forms.Padding]::new($sp.lg, 0, $sp.lg - 10, $sp.sm)
$kpiBar.Margin = [System.Windows.Forms.Padding]::new(0)
for ($i = 0; $i -lt 4; $i++) { [void]$kpiBar.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 25)) }

function New-KpiCard([string]$caption, [string]$hint, [System.Drawing.Color]$accent, [bool]$textMode) {
    $card = New-Object System.Windows.Forms.Panel
    $card.Dock = "Fill"
    $card.BackColor = $cSurface
    $card.Margin = [System.Windows.Forms.Padding]::new(0, 0, 10, 0)
    $card.Padding = [System.Windows.Forms.Padding]::new(14, 8, 12, 8)
    Add-CardBorder $card

    # 三行网格：数值（固定高）/ 指标名 / 说明（占余量，避免 Dock 堆叠把文字顺序搞乱）
    $inner = New-Object System.Windows.Forms.TableLayoutPanel
    $inner.Dock = "Fill"
    $inner.ColumnCount = 1
    $inner.RowCount = 3
    $inner.BackColor = $cSurface
    [void]$inner.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
    [void]$inner.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 36))
    [void]$inner.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::AutoSize))
    [void]$inner.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))

    $val = New-Object System.Windows.Forms.Label
    $val.Text = if ($textMode) { "—" } else { "0" }
    $val.Font = if ($textMode) { $kpiTextFont } else { $kpiFont }
    $val.ForeColor = $accent
    $val.AutoSize = $false
    $val.Dock = "Fill"
    $val.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
    $val.Margin = [System.Windows.Forms.Padding]::new(0)

    $cap = New-Object System.Windows.Forms.Label
    $cap.Text = $caption
    $cap.Font = $uiFont
    $cap.ForeColor = $cText
    $cap.AutoSize = $true
    $cap.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 1)

    $hintLbl = New-Object System.Windows.Forms.Label
    $hintLbl.Text = $hint
    $hintLbl.Font = $subFont
    $hintLbl.ForeColor = $cTextWeak
    $hintLbl.AutoSize = $true
    $hintLbl.Margin = [System.Windows.Forms.Padding]::new(0)

    [void]$inner.Controls.Add($val, 0, 0)
    [void]$inner.Controls.Add($cap, 0, 1)
    [void]$inner.Controls.Add($hintLbl, 0, 2)
    [void]$card.Controls.Add($inner)
    return @{ Card = $card; Value = $val; Hint = $hintLbl }
}
$kpiOk    = New-KpiCard "服务就绪" "健康探测通过" $colOk   $false
$kpiWarn  = New-KpiCard "降级"     "上游不可达但存活" $colWarn $false
$kpiBad   = New-KpiCard "异常 / 未启动" "进程异常、端口占用或未启动" $colBad $false
$kpiGuard = New-KpiCard "自动守护" "掉线自愈 + 邮件告警" $colIdle $true
$kpiOkVal = $kpiOk.Value; $kpiWarnVal = $kpiWarn.Value; $kpiBadVal = $kpiBad.Value; $kpiGuardVal = $kpiGuard.Value
[void]$kpiBar.Controls.Add($kpiOk.Card, 0, 0)
[void]$kpiBar.Controls.Add($kpiWarn.Card, 1, 0)
[void]$kpiBar.Controls.Add($kpiBad.Card, 2, 0)
[void]$kpiBar.Controls.Add($kpiGuard.Card, 3, 0)
$root.Controls.Add($kpiBar, 0, 1)

# ---------------- 工具栏（左：分层操作组；中：守护启停；右：刷新选项）----------------
$toolbar = New-Object System.Windows.Forms.TableLayoutPanel
$toolbar.Dock = "Fill"
$toolbar.AutoSize = $true
$toolbar.ColumnCount = 3
$toolbar.RowCount = 1
$toolbar.BackColor = $cSurface
$toolbar.Padding = [System.Windows.Forms.Padding]::new($sp.lg, $sp.sm, $sp.lg, $sp.sm)
[void]$toolbar.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
[void]$toolbar.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::AutoSize))
[void]$toolbar.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::AutoSize))

$btnBar = New-Object System.Windows.Forms.FlowLayoutPanel
$btnBar.Dock = "Fill"
$btnBar.AutoSize = $true
# 必须 $false：WrapContents=$true 时 AutoSize 会按「可能换行」预算两行高度，
# 导致工具栏下方留出约 100px 空白（2026-11-17 实测）。
# 关键入口（启动/停止守护）已独立到 AutoSize 列，不会因本列被压缩而丢失；
# 本列最右侧的「刷新」在极窄窗口下可能被裁，属可接受降级。
$btnBar.WrapContents = $false
$btnBar.Margin = [System.Windows.Forms.Padding]::new(0)
$btnBar.BackColor = $cSurface

function New-Separator {
    $p = New-Object System.Windows.Forms.Panel
    $p.Width = 1
    $p.Height = 20
    $p.BackColor = $cBorder
    $p.Margin = [System.Windows.Forms.Padding]::new(4, 5, 12, 0)
    return $p
}

$btnStart     = New-Btn "启动全部" 90 "primary"
$btnStop      = New-Btn "停止全部" 90 "danger"
$btnRestart   = New-Btn "重启" 72 "ghost"
$btnSmoke     = New-Btn "冒烟检查" 86 "ghost"
$btnResetSlots= New-Btn "一键重置号源" 98 "quiet"
$btnRefresh   = New-Btn "刷新" 66 "quiet"
$btnGuard     = New-Btn "启动守护" 92 "softprimary"
$btnGuardStop = New-Btn "停止守护" 92 "quiet"

# 主操作组（不含守护；「日志目录」已移到状态栏，避免挤占主操作区宽度）
foreach ($c in @($btnStart, $btnStop, (New-Separator),
                 $btnRestart, $btnSmoke, (New-Separator),
                 $btnResetSlots, $btnRefresh)) {
    [void]$btnBar.Controls.Add($c)
}

# 守护启停单独占一个 AutoSize 列 —— TableLayoutPanel 会优先保证 AutoSize 列的完整宽度，
# 因此「启动 / 停止守护」在任何窗口宽度下都不会被裁掉（操作入口不允许因排版丢失）。
$guardBar = New-Object System.Windows.Forms.FlowLayoutPanel
$guardBar.Dock = "Fill"
$guardBar.AutoSize = $true
$guardBar.WrapContents = $false
$guardBar.Margin = [System.Windows.Forms.Padding]::new(0)
$guardBar.BackColor = $cSurface
foreach ($c in @((New-Separator), $btnGuard, $btnGuardStop)) {
    [void]$guardBar.Controls.Add($c)
}

$optBar = New-Object System.Windows.Forms.FlowLayoutPanel
$optBar.Dock = "Fill"
$optBar.AutoSize = $true
$optBar.WrapContents = $false
$optBar.FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft
$optBar.Margin = [System.Windows.Forms.Padding]::new(0)
$optBar.BackColor = $cSurface

$chkAuto = New-Object System.Windows.Forms.CheckBox
$chkAuto.Text = "自动刷新"
$chkAuto.Checked = (-not $NoAutoRefresh)
$chkAuto.AutoSize = $true
$chkAuto.ForeColor = $cTextSub
$chkAuto.Margin = [System.Windows.Forms.Padding]::new(8, 8, 0, 0)
$chkStopOnClose = New-Object System.Windows.Forms.CheckBox
$chkStopOnClose.Text = "关闭面板时停止服务"
$chkStopOnClose.Checked = $false
$chkStopOnClose.AutoSize = $true
$chkStopOnClose.ForeColor = $cTextSub
$chkStopOnClose.Margin = [System.Windows.Forms.Padding]::new(12, 8, 0, 0)
$lblTick = New-Object System.Windows.Forms.Label
$lblTick.Text = "刷新 —"
$lblTick.AutoSize = $true
$lblTick.ForeColor = $cTextWeak
$lblTick.Font = $subFont
$lblTick.Margin = [System.Windows.Forms.Padding]::new(12, 10, 4, 0)

# RTL：先加的贴最右
[void]$optBar.Controls.Add($lblTick)
[void]$optBar.Controls.Add($chkStopOnClose)
[void]$optBar.Controls.Add($chkAuto)
[void]$toolbar.Controls.Add($btnBar, 0, 0)
[void]$toolbar.Controls.Add($guardBar, 1, 0)
[void]$toolbar.Controls.Add($optBar, 2, 0)
$root.Controls.Add($toolbar, 0, 2)

# ---------------- 状态矩阵（卡片：标题行 + 无格线表格）----------------
$matrixCard = New-Object System.Windows.Forms.TableLayoutPanel
$matrixCard.Dock = "Fill"
$matrixCard.ColumnCount = 1
$matrixCard.RowCount = 2
$matrixCard.BackColor = $cSurface
$matrixCard.Margin = [System.Windows.Forms.Padding]::new($sp.lg, 0, $sp.lg, $sp.sm)
$matrixCard.Padding = [System.Windows.Forms.Padding]::new(1, 1, 1, 1)
Add-CardBorder $matrixCard
[void]$matrixCard.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
[void]$matrixCard.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 34))
[void]$matrixCard.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))

$matrixHead = New-Object System.Windows.Forms.TableLayoutPanel
$matrixHead.Dock = "Fill"
$matrixHead.ColumnCount = 2
$matrixHead.RowCount = 1
$matrixHead.BackColor = $cSurfaceAlt
$matrixHead.Margin = [System.Windows.Forms.Padding]::new(0)
[void]$matrixHead.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::AutoSize))
[void]$matrixHead.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
$lblMatrixTitle = New-Object System.Windows.Forms.Label
$lblMatrixTitle.Text = "服务状态"
$lblMatrixTitle.Font = $sectFont
$lblMatrixTitle.ForeColor = $cText
$lblMatrixTitle.AutoSize = $true
$lblMatrixTitle.Margin = [System.Windows.Forms.Padding]::new(14, 8, 12, 0)
$lblMatrixHint = New-Object System.Windows.Forms.Label
$lblMatrixHint.Text = "判定口径与 orchestrator 一致（健康接受码 / 端口探测 / pid 存活）；「说明」列出失败原因与处置建议"
$lblMatrixHint.Font = $subFont
$lblMatrixHint.ForeColor = $cTextWeak
$lblMatrixHint.AutoSize = $true
$lblMatrixHint.Margin = [System.Windows.Forms.Padding]::new(0, 10, 0, 0)
[void]$matrixHead.Controls.Add($lblMatrixTitle, 0, 0)
[void]$matrixHead.Controls.Add($lblMatrixHint, 1, 0)

$matrix = New-Object System.Windows.Forms.ListView
$matrix.Dock = "Fill"
$matrix.View = [System.Windows.Forms.View]::Details
$matrix.FullRowSelect = $true
$matrix.MultiSelect = $false
$matrix.GridLines = $false
$matrix.BorderStyle = [System.Windows.Forms.BorderStyle]::None
$matrix.HeaderStyle = [System.Windows.Forms.ColumnHeaderStyle]::Nonclickable
$matrix.HideSelection = $true
$matrix.Font = $uiFont
$matrix.BackColor = $cSurface
$matrix.SmallImageList = $rowIco
foreach ($c in @(
    @{ t = "服务"; w = 130 }, @{ t = "端口"; w = 70 }, @{ t = "PID"; w = 70 },
    @{ t = "进程"; w = 60 }, @{ t = "健康探测"; w = 130 }, @{ t = "判定"; w = 110 }, @{ t = "说明"; w = 520 })) {
    [void]$matrix.Columns.Add($c.t, $c.w)
}
# 最后一列铺满：列宽全固定时右侧会留一大片空白，看起来像没做完
$matrix.Add_Resize({
    $w = $matrix.ClientSize.Width - 570 - 4
    if ($w -lt 160) { $w = 160 }
    $matrix.Columns[6].Width = $w
})
[void]$matrixCard.Controls.Add($matrixHead, 0, 0)
[void]$matrixCard.Controls.Add($matrix, 0, 1)
$root.Controls.Add($matrixCard, 0, 3)

# ---------------- 页签（自绘标签头：选中白底+主色下划线，未选中中性底）----------------
$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = "Fill"
$tabs.Font = $tabFont
$tabs.ItemSize = [System.Drawing.Size]::new(116, 34)
$tabs.SizeMode = [System.Windows.Forms.TabSizeMode]::Fixed
$tabs.DrawMode = [System.Windows.Forms.TabDrawMode]::OwnerDrawFixed
$tabs.Margin = [System.Windows.Forms.Padding]::new($sp.lg, 0, $sp.lg, $sp.sm)
$tabs.Padding = [System.Drawing.Point]::new(10, 4)

# 请求页
$tabReq = New-Object System.Windows.Forms.TabPage
$tabReq.Text = "请求流水"
$tabReq.Padding = [System.Windows.Forms.Padding]::new($sp.md)
$tabReq.BackColor = $cSurface
$tabReq.UseVisualStyleBackColor = $false
$reqTop = New-Object System.Windows.Forms.Panel
$reqTop.Dock = "Top"
$reqTop.Height = 32
$reqTop.BackColor = $cSurface
$chkHideProbe = New-Object System.Windows.Forms.CheckBox
$chkHideProbe.Text = "隐藏健康探测请求"
$chkHideProbe.Checked = $true
$chkHideProbe.AutoSize = $true
$chkHideProbe.ForeColor = $cText
$chkHideProbe.Location = [System.Drawing.Point]::new(2, 7)
$lblReqHint = New-Object System.Windows.Forms.Label
$lblReqHint.Text = "数据源 logs\gateway.log · 「时间」为面板观测时间（uvicorn 访问日志本身不含时间戳）"
$lblReqHint.AutoSize = $true
$lblReqHint.Font = $subFont
$lblReqHint.ForeColor = $cTextWeak
$lblReqHint.Location = [System.Drawing.Point]::new(146, 9)
[void]$reqTop.Controls.Add($chkHideProbe)
[void]$reqTop.Controls.Add($lblReqHint)
$listReq = New-Object System.Windows.Forms.ListView
$listReq.Dock = "Fill"
$listReq.View = [System.Windows.Forms.View]::Details
$listReq.FullRowSelect = $true
$listReq.GridLines = $false
$listReq.BorderStyle = [System.Windows.Forms.BorderStyle]::None
$listReq.HeaderStyle = [System.Windows.Forms.ColumnHeaderStyle]::Nonclickable
$listReq.HideSelection = $false
$listReq.Font = $uiFont
$listReq.BackColor = $cSurface
$listReq.SmallImageList = $rowIco
foreach ($c in @(
    @{ t = "时间"; w = 84 }, @{ t = "方法"; w = 66 }, @{ t = "路径"; w = 300 },
    @{ t = "状态码"; w = 70 }, @{ t = "判定"; w = 96 }, @{ t = "客户端"; w = 110 }, @{ t = "说明"; w = 240 })) {
    [void]$listReq.Columns.Add($c.t, $c.w)
}
$listReq.Add_Resize({
    $w = $listReq.ClientSize.Width - 726 - 4
    if ($w -lt 160) { $w = 160 }
    $listReq.Columns[6].Width = $w
})
[void]$tabReq.Controls.Add($listReq)
[void]$tabReq.Controls.Add($reqTop)

# 日志页
$tabLog = New-Object System.Windows.Forms.TabPage
$tabLog.Text = "服务日志"
$tabLog.Padding = [System.Windows.Forms.Padding]::new($sp.md)
$tabLog.BackColor = $cSurface
$tabLog.UseVisualStyleBackColor = $false
$logTop = New-Object System.Windows.Forms.Panel
$logTop.Dock = "Top"
$logTop.Height = 34
$logTop.BackColor = $cSurface
$cmbLog = New-Object System.Windows.Forms.ComboBox
$cmbLog.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
$cmbLog.Width = 260
$cmbLog.Height = 24
$cmbLog.Font = $uiFont
$cmbLog.Location = [System.Drawing.Point]::new(2, 5)
[void]$logTop.Controls.Add($cmbLog)
$lblLogHint = New-Object System.Windows.Forms.Label
$lblLogHint.Text = "增量读取运行中进程的日志（共享读，不影响服务写入）"
$lblLogHint.AutoSize = $true
$lblLogHint.Font = $subFont
$lblLogHint.ForeColor = $cTextWeak
$lblLogHint.Location = [System.Drawing.Point]::new(272, 10)
[void]$logTop.Controls.Add($lblLogHint)
$txtLog = New-Object System.Windows.Forms.RichTextBox
$txtLog.Dock = "Fill"
$txtLog.ReadOnly = $true
$txtLog.WordWrap = $false
$txtLog.BorderStyle = [System.Windows.Forms.BorderStyle]::None
$txtLog.Font = $monoFont
$txtLog.BackColor = $cTermBg
$txtLog.ForeColor = $cTermFg
[void]$tabLog.Controls.Add($txtLog)
[void]$tabLog.Controls.Add($logTop)

# 操作页
$tabOp = New-Object System.Windows.Forms.TabPage
$tabOp.Text = "操作输出"
$tabOp.Padding = [System.Windows.Forms.Padding]::new($sp.md)
$tabOp.BackColor = $cSurface
$tabOp.UseVisualStyleBackColor = $false
$txtOp = New-Object System.Windows.Forms.RichTextBox
$txtOp.Dock = "Fill"
$txtOp.ReadOnly = $true
$txtOp.WordWrap = $false
$txtOp.BorderStyle = [System.Windows.Forms.BorderStyle]::None
$txtOp.Font = $monoFont
$txtOp.BackColor = $cTermBg
$txtOp.ForeColor = $cTermFg
[void]$tabOp.Controls.Add($txtOp)

# 守护页（摘要 → 服务表 → 守护日志）
$tabGuard = New-Object System.Windows.Forms.TabPage
$tabGuard.Text = "守护告警"
$tabGuard.Padding = [System.Windows.Forms.Padding]::new($sp.md)
$tabGuard.BackColor = $cSurface
$tabGuard.UseVisualStyleBackColor = $false
$guardRoot = New-Object System.Windows.Forms.TableLayoutPanel
$guardRoot.Dock = "Fill"
$guardRoot.ColumnCount = 1
$guardRoot.RowCount = 3
$guardRoot.BackColor = $cSurface
[void]$guardRoot.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))
[void]$guardRoot.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 34))
[void]$guardRoot.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Absolute, 130))
[void]$guardRoot.RowStyles.Add([System.Windows.Forms.RowStyle]::new([System.Windows.Forms.SizeType]::Percent, 100))

$lblGuardMeta = New-Object System.Windows.Forms.Label
$lblGuardMeta.Text = "守护未运行 · 点工具栏「启动守护」开启掉线自动重启与邮件告警"
$lblGuardMeta.Dock = "Fill"
$lblGuardMeta.AutoSize = $false
$lblGuardMeta.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$lblGuardMeta.Font = $uiFont
$lblGuardMeta.ForeColor = $cTextSub
$lblGuardMeta.BackColor = $cSurfaceAlt
$lblGuardMeta.Padding = [System.Windows.Forms.Padding]::new(10, 0, 0, 0)
$lblGuardMeta.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 6)

$lstGuard = New-Object System.Windows.Forms.ListView
$lstGuard.View = [System.Windows.Forms.View]::Details
$lstGuard.Dock = "Fill"
$lstGuard.FullRowSelect = $true
$lstGuard.GridLines = $false
$lstGuard.BorderStyle = [System.Windows.Forms.BorderStyle]::None
$lstGuard.HeaderStyle = [System.Windows.Forms.ColumnHeaderStyle]::Nonclickable
$lstGuard.HideSelection = $true
$lstGuard.Font = $uiFont
$lstGuard.BackColor = $cSurface
$lstGuard.SmallImageList = $rowIco
$lstGuard.Margin = [System.Windows.Forms.Padding]::new(0, 0, 0, 6)
foreach ($c in @(
    @{ t = "服务"; w = 130 }, @{ t = "端口"; w = 70 }, @{ t = "状态"; w = 100 }, @{ t = "健康探测"; w = 130 }, @{ t = "说明"; w = 520 })) {
    [void]$lstGuard.Columns.Add($c.t, $c.w)
}
$lstGuard.Add_Resize({
    $w = $lstGuard.ClientSize.Width - 430 - 4
    if ($w -lt 160) { $w = 160 }
    $lstGuard.Columns[4].Width = $w
})
$txtGuardLog = New-Object System.Windows.Forms.RichTextBox
$txtGuardLog.Dock = "Fill"
$txtGuardLog.ReadOnly = $true
$txtGuardLog.WordWrap = $false
$txtGuardLog.BorderStyle = [System.Windows.Forms.BorderStyle]::None
$txtGuardLog.Font = $monoFont
$txtGuardLog.BackColor = $cTermBg
$txtGuardLog.ForeColor = $cTermFg
$txtGuardLog.Margin = [System.Windows.Forms.Padding]::new(0)
[void]$guardRoot.Controls.Add($lblGuardMeta, 0, 0)
[void]$guardRoot.Controls.Add($lstGuard, 0, 1)
[void]$guardRoot.Controls.Add($txtGuardLog, 0, 2)
[void]$tabGuard.Controls.Add($guardRoot)

[void]$tabs.TabPages.Add($tabReq)
[void]$tabs.TabPages.Add($tabLog)
[void]$tabs.TabPages.Add($tabOp)
[void]$tabs.TabPages.Add($tabGuard)

# 自绘标签头（GDI 对象全部显式 Dispose，避免长期常驻后句柄累积）
$tabs.Add_DrawItem({
    param($s, $e)
    if ($e.Index -lt 0) { return }
    $g = $e.Graphics
    $r = $e.Bounds
    $sel = ($s.SelectedIndex -eq $e.Index)
    $brBg = New-Object System.Drawing.SolidBrush($cSurface)
    try {
        $g.FillRectangle($brBg, $r)
        $brFg = New-Object System.Drawing.SolidBrush($(if ($sel) { $cPrimary } else { $cTextSub }))
        $sf = New-Object System.Drawing.StringFormat
        try {
            $sf.Alignment = [System.Drawing.StringAlignment]::Center
            $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
            $f = $tabFont
            if ($sel) { $f = $tabSelFont }
            $box = [System.Drawing.RectangleF]::new([float]$r.X, [float]$r.Y, [float]$r.Width, [float]$r.Height)
            $g.DrawString([string]$s.TabPages[$e.Index].Text, $f, $brFg, $box, $sf)
        } finally { $sf.Dispose(); $brFg.Dispose() }
        if ($sel) {
            $brBar = New-Object System.Drawing.SolidBrush($cPrimary)
            try { $g.FillRectangle($brBar, $r.X, ($r.Y + $r.Height - 3), $r.Width, 3) } finally { $brBar.Dispose() }
        }
    } finally { $brBg.Dispose() }
})
$root.Controls.Add($tabs, 0, 4)

# ---------------- 底部状态栏 ----------------
$statusStrip = New-Object System.Windows.Forms.StatusStrip
$statusStrip.BackColor = $cSurfaceAlt
$statusStrip.SizingGrip = $false
$statusStrip.Padding = [System.Windows.Forms.Padding]::new(14, 0, 14, 0)
$lblStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$lblStatus.Text = "就绪"
$lblStatus.Spring = $true
$lblStatus.Font = $subFont
$lblStatus.ForeColor = $cTextSub
$lblStatus.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
[void]$statusStrip.Items.Add($lblStatus)
# 「日志目录」从工具栏移到状态栏：它是低频排查入口，放这里既不让主操作区挤爆，
# 也不会因窗口变窄被裁掉（工具栏曾因此整颗丢掉「停止守护」，2026-11-17）。
$lnkLogs = New-Object System.Windows.Forms.ToolStripStatusLabel
$lnkLogs.Text = "日志目录"
$lnkLogs.IsLink = $true
$lnkLogs.Font = $subFont
$lnkLogs.Margin = [System.Windows.Forms.Padding]::new(16, 0, 4, 0)
$lnkLogs.Add_Click({ try { Start-Process -FilePath "explorer.exe" -ArgumentList $script:LogsDir | Out-Null } catch { } })
[void]$statusStrip.Items.Add($lnkLogs)
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
        # 状态色点前置：色只做视觉锚点，判定仍由文字表达（色盲/灰度打印可读）
        $it.SubItems.Add("● " + [string]$r.Verdict)
        $note = [string]$r.Note
        $it.SubItems.Add($note)
        $color = Get-LevelColor $r.Level
        $it.ForeColor = $cText          # 行文字保持中性，仅状态列染色（整行染色会让主次不分）
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
    if ($rows.Count -eq 0) {
        # 空态占位：空表容易被误读成「读不到日志」，给一行说明增量读取语义
        if ($listReq.Items.Count -eq 0) {
            $ph = [System.Windows.Forms.ListViewItem]::new("—")   # 时间
            foreach ($t in @("—", "—", "—", "—", "—")) { [void]$ph.SubItems.Add($t) }   # 方法/路径/状态码/判定/客户端
            $ph.SubItems.Add("暂无请求记录 · 增量读取：面板启动后产生的新请求会实时出现在这里")   # 说明
            $ph.ForeColor = $cTextWeak
            $ph.Tag = "EMPTY"
            [void]$listReq.Items.Add($ph)
        }
        return
    }
    if ($listReq.Items.Count -eq 1 -and [string]$listReq.Items[0].Tag -eq "EMPTY") { $listReq.Items.Clear() }
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
    # 「异常」含未启动：只统计 bad 会让「两个服务根本没起」显示成 0 异常，属于误导
    $probing = @($rows | Where-Object { $_.Level -eq "info" }).Count
    $bad = @($rows.Count - $ready - $degraded - $probing)
    if ($bad -lt 0) { $bad = 0 }
    $c = $state["counters"]
    $gw = 8080; $bz = 8088; $ai = 8001
    try { $gw = [int]$Cfg.ports.gateway; $bz = [int]$Cfg.ports.business; $ai = [int]$Cfg.ports.ai } catch { }
    # KPI 概览卡：数据前置到页面顶部，判读不用先扫表格。
    # 着色规则「非零才亮」：0 用中性灰，避免「异常 0」被红色误读成故障。
    $kpiOkVal.Text = [string]$ready
    $kpiOkVal.ForeColor = $(if ($ready -gt 0) { $colOk } else { $cTextWeak })
    $kpiWarnVal.Text = [string]$degraded
    $kpiWarnVal.ForeColor = $(if ($degraded -gt 0) { $colWarn } else { $cTextWeak })
    $kpiBadVal.Text = [string]$bad
    $kpiBadVal.ForeColor = $(if ($bad -gt 0) { $colBad } else { $cTextWeak })
    $lblSummary.Text = ("统一入口 :{0}  ·  业务 :{1}  ·  AI :{2}      请求 成功 {3} / 失败 {4} / 探测 {5}" -f `
        $gw, $bz, $ai, $c["ok"], $c["fail"], $c["probe"])
    $lblTick.Text = "刷新 " + (Get-Date -Format "HH:mm:ss")
}

# ---------------- 守护状态刷新（读 guardian-state.json + guardian.log，最小改动）----------------
$script:guardStatePath = Join-Path $RunDir "guardian-state.json"
$script:guardPidPath = Join-Path $RunDir "guardian.pid"
$script:guardLogPath = Join-Path $LogsDir "guardian.log"
$script:guardSig = "__init__"

function Get-GuardianAlive {
    if (-not (Test-Path -LiteralPath $script:guardPidPath)) { return $false }
    $id = 0
    if (-not [int]::TryParse(((Get-Content -LiteralPath $script:guardPidPath -Raw -ErrorAction SilentlyContinue).Trim()), [ref]$id)) { return $false }
    try { return ($null -ne (Get-Process -Id $id -ErrorAction Stop)) } catch { return $false }
}

function Update-Guardian {
    # 1) 品牌栏徽标 + KPI 卡联动（按钮可用性即语义：已在跑就不给重复启动入口）
    $alive = Get-GuardianAlive
    if ($alive) {
        $lblGuard.Text = "● 守护运行中"
        $lblGuard.ForeColor = $colOk
        $kpiGuardVal.Text = "运行中"
        $kpiGuardVal.ForeColor = $colOk
        $btnGuardStop.Enabled = $true
        $btnGuard.Enabled = $false
    } else {
        $lblGuard.Text = "○ 守护未运行"
        $lblGuard.ForeColor = $cTextWeak
        $kpiGuardVal.Text = "未运行"
        $kpiGuardVal.ForeColor = $colIdle
        $btnGuardStop.Enabled = $false
        $btnGuard.Enabled = $true
    }

    # 2) 状态矩阵（有变化才重绘）
    $st = $null
    if (Test-Path -LiteralPath $script:guardStatePath) {
        try {
            $rawSt = Get-Content -LiteralPath $script:guardStatePath -Raw -Encoding UTF8
            if (-not [string]::IsNullOrWhiteSpace($rawSt)) { $st = $rawSt | ConvertFrom-Json }
        } catch { $st = $null }
        # 空文件/残缺快照一律视为无数据：否则摘要条会渲染成「最近巡检  · 判定 」一串空值
        if ($null -ne $st -and [string]::IsNullOrWhiteSpace([string]$st.lastCheck)) { $st = $null }
    }
    $sig = ""
    if ($null -ne $st) {
        $sig = ([string]$st.lastCheck) + "|" + ([string]$st.verdict)
        foreach ($s in $st.services) { $sig += "|" + $s.name + ":" + $s.state }
    }
    if ($sig -ne $script:guardSig) {
        $script:guardSig = $sig
        $lstGuard.BeginUpdate()
        $lstGuard.Items.Clear()
        if ($null -eq $st) {
            # 空态占位：不留一张只有表头的空表（比空白更能说明"为什么没数据"）
            $ph = [System.Windows.Forms.ListViewItem]::new("（暂无数据）")
            [void]$ph.SubItems.Add("—")
            [void]$ph.SubItems.Add("—")
            [void]$ph.SubItems.Add("—")
            [void]$ph.SubItems.Add("守护进程未运行，或刚启动尚未完成首轮巡检")
            $ph.ForeColor = $cTextWeak
            [void]$lstGuard.Items.Add($ph)
        } else {
            foreach ($s in $st.services) {
                $it = [System.Windows.Forms.ListViewItem]::new([string]$s.name)
                [void]$it.SubItems.Add([string]$s.port)
                [void]$it.SubItems.Add([string]$s.state)
                [void]$it.SubItems.Add([string]$s.health)
                [void]$it.SubItems.Add([string]$s.reason)
                $lvl = "idle"
                if ($s.state -eq "UP") { $lvl = "ok" }
                elseif ($s.state -eq "DEGRADED") { $lvl = "warn" }
                elseif ($s.state -eq "DOWN") { $lvl = "bad" }
                $it.ForeColor = Get-LevelColor $lvl
                [void]$lstGuard.Items.Add($it)
            }
        }
        $lstGuard.EndUpdate()
        # 决策点摘要：只在有真实快照时渲染；无快照给空态文案，避免一串空值（如「最近巡检  · 判定 」）
        if ($null -ne $st) {
            $meta = ("最近巡检 {0}   ·   判定 {1}   ·   今日重启 {2} 次   ·   上次告警 {3}（{4}）" -f `
                ([string]$st.lastCheck), ([string]$st.verdict), ([string]$st.restartToday), `
                $(if ($st.lastAlert) { [string]$st.lastAlert } else { "—" }), `
                $(if ($st.lastAlertResult) { [string]$st.lastAlertResult } else { "—" }))
            $lblGuardMeta.Text = $meta
            $lblGuardMeta.ForeColor = $cTextSub
            if ([string]$st.verdict -eq "HEALTHY") { $lblGuardMeta.ForeColor = $colOk }
            elseif ([string]$st.verdict -eq "DEGRADED") { $lblGuardMeta.ForeColor = $colWarn }
            elseif ([string]$st.verdict -eq "DOWN") { $lblGuardMeta.ForeColor = $colBad }
            $lblStatus.Text = "守护 · " + $meta
        } else {
            if ($alive) {
                $lblGuardMeta.Text = "守护运行中 · 首轮巡检尚未产出快照（一个巡检间隔后出现）"
            } else {
                $lblGuardMeta.Text = "守护未运行 · 点工具栏「启动守护」开启掉线自动重启与邮件告警"
            }
            $lblGuardMeta.ForeColor = $cTextSub
            $lblStatus.Text = $(if ($alive) { "守护运行中（无巡检快照）" } else { "守护未运行" })
        }
    }

    # 3) 守护日志尾部（仅守护页被选中时才读，省 IO）
    if ($tabs.SelectedTab -eq $tabGuard -and (Test-Path -LiteralPath $script:guardLogPath)) {
        try {
            $tail = Get-Content -LiteralPath $script:guardLogPath -Tail 200 -Encoding UTF8 -ErrorAction Stop
            $text = ($tail -join "`r`n")
            if ($txtGuardLog.Text -ne $text) {
                $txtGuardLog.Text = $text
                $txtGuardLog.SelectionStart = $txtGuardLog.TextLength
                $txtGuardLog.ScrollToCaret()
            }
        } catch { }
    }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 600
$script:tickCount = 0
$timer.Add_Tick({
    if (-not $state["running"]) { $timer.Stop(); return }
    try {
        Update-Matrix
        Update-Requests
        Update-LogView
        Update-OpView
        Update-Summary
        $script:tickCount++
        if ($script:tickCount % 5 -eq 0) { Update-Guardian }   # 守护状态每 ~3s 读一次，避免频繁 IO
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
# 守护按钮：转交 guardian-launch.ps1（脱离会话 + 防重复 + 启动自确认），面板不自己实现守护逻辑
# 注意：必须重定向 stdout/stderr。以 -WindowStyle Hidden 启动时控制台不可写，
# launch 脚本里的 Write-Host 若无处可去会随 $ErrorActionPreference=Stop 中断启动
# （2026-11-17 修 guardian 静默退出时同源问题，勿删重定向）。
$guardLaunch = Join-Path $ScriptsDir "guardian-launch.ps1"
$guardRunDir = Join-Path $DeployDir "run"
$btnGuard.Add_Click({
    try {
        Start-Process -FilePath $psExe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $guardLaunch, "-Start") `
            -WorkingDirectory $DeployDir -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $guardRunDir "_guard-launch-out.txt") `
            -RedirectStandardError (Join-Path $guardRunDir "_guard-launch-err.txt") | Out-Null
        $lblStatus.Text = "正在启动常驻守护，最多 12 秒内确认（本页签状态会自动刷新）"
    } catch {
        [System.Windows.Forms.MessageBox]::Show(("启动守护失败：" + $_.Exception.Message), "后端控制台") | Out-Null
    }
})
$btnGuardStop.Add_Click({
    try {
        Start-Process -FilePath $psExe -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $guardLaunch, "-Stop") `
            -WorkingDirectory $DeployDir -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $guardRunDir "_guard-stop-out.txt") `
            -RedirectStandardError (Join-Path $guardRunDir "_guard-stop-err.txt") | Out-Null
        $lblStatus.Text = "已请求停止守护，约 3 秒后更新状态"
    } catch {
        [System.Windows.Forms.MessageBox]::Show(("停止守护失败：" + $_.Exception.Message), "后端控制台") | Out-Null
    }
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
$form.Add_Shown({
    try { Update-Guardian } catch { }   # 首屏即给出守护状态，不等第 5 个 tick（约 3s）
    $state["wake"] = $true
    # -ShotPath：等首屏数据落地后整窗渲染成 PNG 并退出（供视觉回归，不影响正常使用）
    if ($ShotPath) {
        $shotTimer = New-Object System.Windows.Forms.Timer
        $shotTimer.Interval = 4200   # 等首轮采集（含健康探测超时）落盘再截
        $shotTimer.Add_Tick({
            $this.Stop()
            try {
                if ($ShotTab -gt 0 -and $ShotTab -lt $tabs.TabPages.Count) { $tabs.SelectedIndex = $ShotTab }
                $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
                $rect = New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)
                $form.DrawToBitmap($bmp, $rect)
                $bmp.Save($ShotPath, [System.Drawing.Imaging.ImageFormat]::Png)
                $bmp.Dispose()
                Write-Host ("[gui] 首屏已渲染：" + $ShotPath)
                # 采集/渲染链路自证：status 行数、请求条数、矩阵控件实际行数（排查"界面空但采集有数据"）
                Write-Host ("[gui] status=" + @($state["status"]).Count + " req=" + $state["requests"].Count + " matrixRows=" + $matrix.Items.Count + " guardRows=" + $lstGuard.Items.Count)
                Write-Host ("[gui] collector completed=" + $collectorHandle.IsCompleted + " errs=" + $ps.Streams.Error.Count)
                if ($ps.Streams.Error.Count -gt 0) { Write-Host ("[gui] err0=" + $ps.Streams.Error[0].ToString()) }
                # RichTextBox 不在 DrawToBitmap 支持范围内（截图会是空白），故用边界断言代替像素判读
                Write-Host ("[gui] 日志区 bounds: log=" + $txtLog.Bounds.ToString() + " op=" + $txtOp.Bounds.ToString() + " guard=" + $txtGuardLog.Bounds.ToString())
            } catch {
                Write-Host ("[gui] 渲染失败：" + $_.Exception.Message)
            }
            $form.Close()
        })
        $shotTimer.Start()
    }
})

[System.Windows.Forms.Application]::Run($form)
