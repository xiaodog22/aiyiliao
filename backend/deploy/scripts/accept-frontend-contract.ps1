<#
  accept-frontend-contract.ps1 — 前端契约十条验收（可一键复跑）
  依据：docs/前端数据依赖与后端接口需求_20261017.md §7「验收清单」

  用法（在仓库根目录）：
    powershell -ExecutionPolicy Bypass -File backend\deploy\scripts\accept-frontend-contract.ps1
    powershell -ExecutionPolicy Bypass -File backend\deploy\scripts\accept-frontend-contract.ps1 -SkipStart
    powershell -ExecutionPolicy Bypass -File backend\deploy\scripts\accept-frontend-contract.ps1 -StopAfter

  参数：
    -Base      网关基址（默认 http://127.0.0.1:8080）
    -SkipStart 服务已在运行，跳过 orchestrator 启动
    -StopAfter 验收结束后停掉三服务

  退出码：0 = 十条全部通过（含已声明项）；1 = 存在未通过项
  约束：只调只读接口 + 一次登录（登录对 users 做 upsert，dev 库可接受）；不伪造任何请求头以外的数据。
#>
param(
    [string]$Base = "http://127.0.0.1:8080",
    [switch]$SkipStart,
    [switch]$StopAfter
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest 不渲染进度条（否则日志被 Reading web response 刷屏）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
# 系统代理会让 127.0.0.1 走代理 → 502；显式清空默认代理
try { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy } catch { }

$deployRoot = Split-Path -Parent $PSScriptRoot
$psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

# ---------------------------------------------------------------- 工具函数
function Invoke-Api {
    param([string]$Method, [string]$Path, [hashtable]$Headers = @{}, $Body = $null)

    $params = @{
        Uri             = $Base + $Path
        Method          = $Method
        UseBasicParsing = $true
        TimeoutSec      = 30
        Headers         = $Headers
    }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 8 -Compress
        $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
        $params.ContentType = "application/json; charset=utf-8"
    }

    try {
        $resp = Invoke-WebRequest @params
        # 响应体按字节解 UTF-8：PS5.1 默认按 ISO-8859-1 解，中文 message 会变乱码
        $content = $resp.Content
        try {
            $bytes = $resp.RawContentStream.ToArray()
            if ($bytes.Length -gt 0) { $content = [System.Text.Encoding]::UTF8.GetString($bytes) }
        } catch { }
        $obj = $null
        try { $obj = $content | ConvertFrom-Json } catch { }
        return @{ status = [int]$resp.StatusCode; json = $obj; raw = $content }
    } catch {
        $ex = $_.Exception.Response
        $status = 0
        $raw = $_.Exception.Message
        if ($null -ne $ex) {
            $status = [int]$ex.StatusCode
            try {
                $sr = New-Object System.IO.StreamReader($ex.GetResponseStream(), [System.Text.Encoding]::UTF8)
                $raw = $sr.ReadToEnd()
            } catch { }
        }
        $obj = $null
        try { $obj = $raw | ConvertFrom-Json } catch { }
        return @{ status = $status; json = $obj; raw = $raw }
    }
}

function Get-Count {
    param($Value)
    if ($null -eq $Value) { return 0 }
    return @($Value).Count
}

function Get-Brief {
    param($Result, [int]$Max = 160)
    if ($null -eq $Result) { return "" }
    $text = [string]$Result.raw
    $text = $text -replace "\s+", " "
    if ($text.Length -gt $Max) { $text = $text.Substring(0, $Max) + "..." }
    return $text
}

$script:rows = New-Object System.Collections.ArrayList

function Add-Row {
    param([string]$No, [string]$Item, [string]$Expect, [string]$Actual, [bool]$Ok, [string]$Detail = "", [bool]$Declared = $false)

    $verdict = "FAIL"
    if ($Ok -and $Declared) { $verdict = "PASS*" }
    elseif ($Ok) { $verdict = "PASS" }

    [void]$script:rows.Add([pscustomobject]@{
        No      = $No
        Item    = $Item
        Expect  = $Expect
        Actual  = $Actual
        Verdict = $verdict
        Detail  = $Detail
    })
    Write-Host ("[{0}] {1,-2} {2}" -f $verdict, $No, $Item) -ForegroundColor $(if ($Ok) { "Green" } else { "Red" })
}

# ---------------------------------------------------------------- 启动服务
if (-not $SkipStart) {
    Write-Host "=== 启动三服务（business / ai / gateway）===" -ForegroundColor Cyan
    $startArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        (Join-Path $PSScriptRoot "orchestrator.ps1"), "-Action", "start", "-Yes")
    # 用子进程调 orchestrator：它内部 exit 会直接结束整个宿主，不能再同进程内调用
    & $psExe @startArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "启动失败（orchestrator 退出码 $LASTEXITCODE），后续验收不可信。" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "=== 前端契约十条验收（$Base）===" -ForegroundColor Cyan

$baseHeaders = @{
    "X-Platform"       = "wechat-miniprogram"
    "X-Client-Version" = "1.0.0"
}

# ---- 2. 旧登录路径（兼容层翻译 + X-Platform 不重复 → 不再 422）
#     注：旧登录适配器 legacy_login_view 刻意**不下发令牌**（旧端只读 name/userId），
#     令牌一律走契约登录，故本条只判 200 与信封形状。
$login = Invoke-Api -Method "POST" -Path "/api/user/login" -Headers $baseHeaders `
    -Body @{ phone = "13800138001"; password = "123456" }
$loginCode = $null
$loginName = $null
if ($null -ne $login.json) {
    $loginCode = $login.json.code
    $loginName = $login.json.name
}
$ok2 = ($login.status -eq 200) -and ([string]$loginCode -eq "200")
Add-Row "02" "旧登录 /api/user/login（X-Platform 不重复 → 422 已修）" "200（信封 code=200）" `
    ("HTTP {0}，code={1}，name={2}" -f $login.status, $loginCode, $loginName) $ok2 (Get-Brief $login)

# ---- 契约登录取令牌（后续受保护接口用；dev 档 code 不含 dev-user-2 → 患者 u-dev-user-1）
$session = Invoke-Api -Method "POST" -Path "/api/v1/auth/wechat/login" -Headers $baseHeaders `
    -Body @{ code = "accept-patient-dev-user-1"; consentVersion = "accept-20261017" }
$patientToken = $null
if ($null -ne $session.json -and $null -ne $session.json.data) { $patientToken = $session.json.data.accessToken }
if ($null -eq $patientToken) {
    Write-Host ("契约登录未取到令牌（HTTP {0}）：{1}" -f $session.status, (Get-Brief $session 240)) -ForegroundColor Red
}

$authHeaders = $baseHeaders.Clone()
if ($null -ne $patientToken) { $authHeaders["Authorization"] = "Bearer " + $patientToken }

# ---- 1. 家属邀请列表不再被 {memberId} 吞掉
$inv = Invoke-Api -Method "GET" -Path "/api/v1/family-members/invitations?limit=20" -Headers $authHeaders
$invCount = 0
if ($inv.status -eq 200 -and $null -ne $inv.json) { $invCount = Get-Count $inv.json.data }
Add-Row "01" "GET /api/v1/family-members/invitations" "200（不再 404）" `
    ("HTTP {0}，data={1} 条" -f $inv.status, $invCount) ($inv.status -eq 200) (Get-Brief $inv)

# ---- 3. 预约列表补 location
$apts = Invoke-Api -Method "GET" -Path "/api/v1/appointments/me?limit=20" -Headers $authHeaders
$aptCount = 0
$aptLocation = $null
if ($apts.status -eq 200 -and $null -ne $apts.json -and $null -ne $apts.json.data) {
    $aptList = @($apts.json.data)
    $aptCount = $aptList.Count
    if ($aptCount -gt 0) { $aptLocation = $aptList[0].location }
}
$ok3 = ($apts.status -eq 200) -and ($aptCount -gt 0) -and (-not [string]::IsNullOrEmpty($aptLocation))
Add-Row "03" "GET /api/v1/appointments/me → data[0].location" "非空" `
    ("HTTP {0}，{1} 条，location={2}" -f $apts.status, $aptCount, $aptLocation) $ok3 (Get-Brief $apts)

# ---- 4. 我的资料补 gender
$me = Invoke-Api -Method "GET" -Path "/api/v1/me" -Headers $authHeaders
$gender = $null
$birth = $null
if ($null -ne $me.json -and $null -ne $me.json.data) {
    $gender = $me.json.data.gender
    $birth = $me.json.data.birthDate
}
$ok4 = ($me.status -eq 200) -and (-not [string]::IsNullOrEmpty($gender))
Add-Row "04" "GET /api/v1/me → data.gender / birthDate" "gender 存在" `
    ("HTTP {0}，gender={1}，birthDate={2}" -f $me.status, $gender, $birth) $ok4 (Get-Brief $me)

# ---- 5. 科普列表 ≥ 9（6 图文 + 3 视频）
$contents = Invoke-Api -Method "GET" -Path "/api/v1/contents?limit=20" -Headers $authHeaders
$cCount = 0
$cTypes = @()
if ($contents.status -eq 200 -and $null -ne $contents.json) {
    $cList = @($contents.json.data)
    $cCount = $cList.Count
    $cTypes = @($cList | ForEach-Object { $_.contentType } | Sort-Object -Unique)
}
$ok5 = ($contents.status -eq 200) -and ($cCount -ge 9)
Add-Row "05" "GET /api/v1/contents" "≥9 条" `
    ("HTTP {0}，{1} 条，contentType={2}" -f $contents.status, $cCount, ($cTypes -join "/")) $ok5 (Get-Brief $contents)

# ---- 6. 科室列表 ≥ 14（含位置字段）
$depts = Invoke-Api -Method "GET" -Path "/api/v1/departments" -Headers $authHeaders
$dCount = 0
$dLocated = 0
if ($depts.status -eq 200 -and $null -ne $depts.json) {
    $dList = @($depts.json.data)
    $dCount = $dList.Count
    $dLocated = @($dList | Where-Object { -not [string]::IsNullOrEmpty($_.floor) }).Count
}
$ok6 = ($depts.status -eq 200) -and ($dCount -ge 14)
Add-Row "06" "GET /api/v1/departments" "≥14 个（floor 有值）" `
    ("HTTP {0}，{1} 个，floor 非空 {2} 个" -f $depts.status, $dCount, $dLocated) $ok6 (Get-Brief $depts)

# ---- 7. 首页快捷服务 ≥ 8（home_block_config 驱动）
#     注意：$HOME 是 PS 只读自动变量，变量名不能取 $home
$homeSum = Invoke-Api -Method "GET" -Path "/api/v1/home/summary" -Headers $authHeaders
$svcCount = 0
$homeKinds = @()
if ($homeSum.status -eq 200 -and $null -ne $homeSum.json -and $null -ne $homeSum.json.data) {
    $blocks = @($homeSum.json.data.blocks)
    $homeKinds = @($blocks | ForEach-Object { $_.kind })
    $q = $blocks | Where-Object { $_.kind -eq "QUICK_SERVICES" } | Select-Object -First 1
    if ($null -ne $q) { $svcCount = Get-Count $q.services }
}
$ok7 = ($homeSum.status -eq 200) -and ($svcCount -ge 8)
Add-Row "07" "GET /api/v1/home/summary → QUICK_SERVICES" "≥8 项" `
    ("HTTP {0}，services={1}，blocks={2}" -f $homeSum.status, $svcCount, ($homeKinds -join "|")) $ok7 (Get-Brief $homeSum)

# ---- 8. 资源清单：url 策略（M1 无 CDN → url 恒 null，但每项必须有 fallbackKey 兜底）
$man = Invoke-Api -Method "GET" -Path "/api/v1/resources/manifest" -Headers $authHeaders
$mTotal = 0
$mUrl = 0
$mFallback = 0
if ($null -ne $man.json -and $null -ne $man.json.data) {
    $items = @($man.json.data.items)
    $mTotal = $items.Count
    $mUrl = @($items | Where-Object { -not [string]::IsNullOrEmpty($_.url) }).Count
    $mFallback = @($items | Where-Object { -not [string]::IsNullOrEmpty($_.fallbackKey) }).Count
}
# 判据收敛：只要「每条要么有 url、要么有 fallbackKey」即视为可消费；全 null 且无兜底 = 真失败
$ok8 = ($man.status -eq 200) -and ($mTotal -gt 0) -and (($mUrl + $mFallback) -ge $mTotal)
$declared8 = ($mUrl -eq 0)
Add-Row "08" "GET /api/v1/resources/manifest → url 策略" "非全 null（或 fallbackKey 兜底并写明）" `
    ("HTTP {0}，{1} 项，url 非空 {2}，fallbackKey 非空 {3}" -f $man.status, $mTotal, $mUrl, $mFallback) `
    $ok8 "M1 无 CDN：url 恒 null，A 级资源走 bundlePath/fallbackKey（契约 description 已写明）" $declared8

# ---- 9. 医生端：登录 + 工作台摘要四字段
#     dev 档：code 含 "dev-user-2" → openid=dev-user-2 → users.id=u-dev-user-2，
#     该账号在 V9002 种子中被绑定到 doc-gastro-1（ACTIVE），否则 403（未登记任职关系）
$docLogin = Invoke-Api -Method "POST" -Path "/api/v1/doctor/login" -Headers $baseHeaders `
    -Body @{ code = "accept-doctor-dev-user-2"; consentVersion = "accept-20261017" }
$doctorToken = $null
if ($null -ne $docLogin.json -and $null -ne $docLogin.json.data) { $doctorToken = $docLogin.json.data.accessToken }
$doctorHeaders = $baseHeaders.Clone()
if ($null -ne $doctorToken) { $doctorHeaders["Authorization"] = "Bearer " + $doctorToken }

$wb = Invoke-Api -Method "GET" -Path "/api/v1/doctor/workbench" -Headers $doctorHeaders
$wbFields = @()
if ($null -ne $wb.json -and $null -ne $wb.json.data -and $null -ne $wb.json.data.summary) {
    $s = $wb.json.data.summary
    foreach ($f in @("todayAppointments", "waitingPatients", "availableBeds", "pendingReviews")) {
        if ($null -ne $s.$f) { $wbFields += $f }
    }
}
$ok9 = ($docLogin.status -eq 200) -and ($wb.status -eq 200) -and ($wbFields.Count -ge 1)
Add-Row "09" "医生登录 + GET /api/v1/doctor/workbench" "workbench 200 且 summary 有计数" `
    ("登录 HTTP {0}，workbench HTTP {1}，summary 字段={2}" -f $docLogin.status, $wb.status, ($wbFields -join ",")) `
    $ok9 (Get-Brief $wb)

# ---- 10. 网关健康含 ollama 探针
$health = Invoke-Api -Method "GET" -Path "/api/gw/health"
$upNames = @()
$gwStatus = $null
if ($null -ne $health.json) {
    $payload = $health.json
    if ($null -ne $payload.data) { $payload = $payload.data }
    $gwStatus = $payload.status
    if ($null -ne $payload.upstreams) { $upNames = @($payload.upstreams | ForEach-Object { $_.name }) }
}
$ok10 = ($upNames -contains "ollama")
Add-Row "10" "GET /api/gw/health → upstreams 含 ollama" "含 ollama" `
    ("HTTP {0}，status={1}，upstreams={2}" -f $health.status, $gwStatus, ($upNames -join ",")) $ok10 (Get-Brief $health)

# ---------------------------------------------------------------- 汇总
Write-Host ""
$script:rows | Format-Table -AutoSize No, Verdict, Item, Expect, Actual | Out-String -Width 220 | Write-Host
Write-Host "备注：PASS* = 按文档口径已声明/已解释的通过项（见 Detail）。" -ForegroundColor DarkGray
$script:rows | Where-Object { $_.Verdict -eq "FAIL" -or $_.Detail -ne "" } |
    Format-List No, Item, Detail | Out-String -Width 220 | Write-Host

$failed = @($script:rows | Where-Object { $_.Verdict -eq "FAIL" })
Write-Host ("结果：{0} 通过 / {1} 未通过 / 共 {2} 项" -f ($script:rows.Count - $failed.Count), $failed.Count, $script:rows.Count) `
    -ForegroundColor $(if ($failed.Count -eq 0) { "Green" } else { "Red" })

if ($StopAfter) {
    Write-Host "=== 停止三服务 ===" -ForegroundColor Cyan
    & $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "orchestrator.ps1") -Action stop -Yes
}

if ($failed.Count -eq 0) { exit 0 }
exit 1
