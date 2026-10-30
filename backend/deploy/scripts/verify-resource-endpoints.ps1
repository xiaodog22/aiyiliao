# -*- coding: utf-8 -*-
<#
.SYNOPSIS
    资源库端点验收脚本（V14）：一条命令跑完「流式返回 + 头部 + 安全 + 清单」六项。

.DESCRIPTION
    默认打本地统一入口 http://127.0.0.1:8080；真机前请先对穿透域名跑一遍：
        .\verify-resource-endpoints.ps1 -Base https://qv56gv32944.vicp.fun
    任何一项 FAIL 都以退出码 1 结束（可接 CI）。

    为什么必须跑这个而不是"浏览器能打开"：
      - <image> 看的是 Content-Type 与字节，浏览器可能"渲染"一段 JSON 错误页；
      - downloadFile / 缓存复用依赖 Content-Length / Cache-Control / ETag；
      - 停用资源与路径穿越必须 404，不能靠前端兜底掩盖。

.PARAMETER Base
    统一入口基址（不含尾部斜杠）。

.PARAMETER Key
    用于主验证的资源 key，默认 home.ai-doctor（A 级、image/png、种子固定）。

.EXAMPLE
    .\verify-resource-endpoints.ps1
.EXAMPLE
    .\verify-resource-endpoints.ps1 -Base https://qv56gv32944.vicp.fun
#>
param(
    [string]$Base = "http://127.0.0.1:8080",
    # 默认用清单里的 remote 条目（V15 分类后 home.ai-doctor 已改为 local，不在清单里）
    [string]$Key = "home.banner-hospital"
)

$ErrorActionPreference = "Continue"
$Base = $Base.TrimEnd("/")

# 本地验收时系统代理会把 127.0.0.1 也劫持走（实测 502），显式直连。
try { [System.Net.WebRequest]::DefaultWebProxy = $null } catch { }

$script:pass = 0
$script:fail = 0
$results = New-Object System.Collections.ArrayList

function Add-Result {
    param([string]$Name, [bool]$Ok, [string]$Detail)
    if ($Ok) { $script:pass++ } else { $script:fail++ }
    $tag = if ($Ok) { "PASS" } else { "FAIL" }
    [void]$results.Add([pscustomobject]@{ 项 = $Name; 结果 = $tag; 详情 = $Detail })
}

Write-Host "== 资源端点验收 ==" -ForegroundColor Cyan
Write-Host "Base = $Base"
Write-Host "Key  = $Key"
Write-Host ""

# ---------- 1. 资源清单 ----------
$manifest = $null
try {
    $url = "$Base/api/v1/resources/manifest?platform=wechat-miniprogram"
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 0
    $manifest = ($resp.Content | ConvertFrom-Json).data
    $itemCount = @($manifest.items).Count
    Add-Result "清单可达且非空" ($resp.StatusCode -eq 200 -and $itemCount -gt 0) "HTTP $($resp.StatusCode), items=$itemCount"
} catch {
    Add-Result "清单可达且非空" $false $_.Exception.Message
}

$item = $null
if ($manifest) {
    $item = @($manifest.items) | Where-Object { $_.key -eq $Key } | Select-Object -First 1
    if ($item) {
        # url 断言不绑定 Base：本地验收用 127.0.0.1:8080，而下发的是穿透域名（本就不同源）。
        # 真正要保证的是「绝对 http(s) 地址 + 稳定的资源路径后缀」。
        $isAbsolute = $item.url -match "^https?://"
        $hasSuffix = $item.url -like "*/api/v1/resources/$Key"
        Add-Result "清单 url 为绝对地址且路径正确" ($isAbsolute -and $hasSuffix) "url=$($item.url)"
        Add-Result "清单保留 bundlePath 兜底" (-not [string]::IsNullOrWhiteSpace($item.fallbackKey)) "fallbackKey=$($item.fallbackKey)"
        Add-Result "清单不下发视频/可执行资源" (-not (@($manifest.items) | Where-Object { $_.mime -notin @('image/png','image/jpeg','image/webp') })) "mimes=$( (@($manifest.items) | ForEach-Object { $_.mime } | Sort-Object -Unique) -join ',')"
    } else {
        Add-Result "清单包含目标 key" $false "清单中无 $Key"
    }
}

# ---------- 2. 流式返回：头部与字节 ----------
$tmp = Join-Path $env:TEMP ("res-" + [guid]::NewGuid().ToString("N") + ".bin")
try {
    $r = Invoke-WebRequest -Uri "$Base/api/v1/resources/$Key" -UseBasicParsing -TimeoutSec 30 -OutFile $tmp -PassThru
    $ct = $r.Headers["Content-Type"]
    $cl = $r.Headers["Content-Length"]
    $cc = $r.Headers["Cache-Control"]
    $et = $r.Headers["ETag"]

    Add-Result "GET 200" ($r.StatusCode -eq 200) "HTTP $($r.StatusCode)"
    Add-Result "Content-Type 为图片（非 octet-stream/JSON）" ($ct -like "image/*") "Content-Type=$ct"
    Add-Result "Content-Length 存在" (-not [string]::IsNullOrWhiteSpace($cl)) "Content-Length=$cl"
    Add-Result "Cache-Control 含 max-age 且 public" (($cc -match "max-age=\d+") -and ($cc -match "public")) "Cache-Control=$cc"
    Add-Result "ETag 存在（支持 304 复用）" (-not [string]::IsNullOrWhiteSpace($et)) "ETag=$et"

    if (Test-Path $tmp) {
        $size = (Get-Item $tmp).Length
        $sha = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
        Add-Result "响应体是完整文件字节" ($size -gt 1024 -and ($null -eq $item -or $size -eq [int64]$item.size)) "bytes=$size"
        if ($item) {
            Add-Result "sha256 与清单一致" ($sha -eq $item.sha256) "actual=$sha expected=$($item.sha256)"
        }
        $fs = [System.IO.File]::OpenRead($tmp)
        $head = New-Object byte[] 4
        [void]$fs.Read($head, 0, 4)
        $fs.Close()
        # 按 Content-Type 判魔数：png=89 50 4E 47 / jpeg=FF D8 FF（清单里两者都有）
        $isPng = ($head[0] -eq 0x89 -and $head[1] -eq 0x50 -and $head[2] -eq 0x4E -and $head[3] -eq 0x47)
        $isJpeg = ($head[0] -eq 0xFF -and $head[1] -eq 0xD8 -and $head[2] -eq 0xFF)
        $isWebp = ($head[0] -eq 0x52 -and $head[1] -eq 0x49 -and $head[2] -eq 0x46 -and $head[3] -eq 0x46)
        Add-Result "图片魔数正确（真的是图片）" ($isPng -or $isJpeg -or $isWebp) ("head=" + (($head | ForEach-Object { $_.ToString('x2') }) -join ' ') + " ct=$ct")
    }
} catch {
    Add-Result "GET 资源" $false $_.Exception.Message
} finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

# ---------- 3. HEAD（curl -I 等价） ----------
try {
    $h = Invoke-WebRequest -Uri "$Base/api/v1/resources/$Key" -Method Head -UseBasicParsing -TimeoutSec 15
    Add-Result "HEAD 200 且带 Content-Length" ($h.StatusCode -eq 200 -and -not [string]::IsNullOrWhiteSpace($h.Headers["Content-Length"])) "HTTP $($h.StatusCode), Content-Length=$($h.Headers['Content-Length'])"
} catch {
    Add-Result "HEAD 200 且带 Content-Length" $false $_.Exception.Message
}

# ---------- 4. 停用资源 / 不存在 → 404 ----------
foreach ($case in @(@{ k = "legacy.disabled-sample"; name = "停用资源返回 404" }, @{ k = "home.not-exists"; name = "不存在的 key 返回 404" })) {
    try {
        $r = Invoke-WebRequest -Uri "$Base/api/v1/resources/$($case.k)" -UseBasicParsing -TimeoutSec 10
        Add-Result $case.name $false "HTTP $($r.StatusCode)（应为 404）"
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        Add-Result $case.name ($code -eq 404) "HTTP $code"
    }
}

# ---------- 5. 路径穿越 → 400/404（绝不 200） ----------
foreach ($evil in @("../..%2Fetc%2Fpasswd", "..%5C..%5Cwindows%5Cwin.ini")) {
    $u = "$Base/api/v1/resources/$evil"
    try {
        $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 0
        Add-Result "路径穿越被拒（$evil）" ($r.StatusCode -ne 200) "HTTP $($r.StatusCode)"
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        Add-Result "路径穿越被拒（$evil）" ($code -eq 400 -or $code -eq 404) "HTTP $code"
    }
}

# ---------- 6. /ai 分流探针 ----------
try {
    $r = Invoke-WebRequest -Uri "$Base/ai/health" -UseBasicParsing -TimeoutSec 10
    Add-Result "/ai 分流可达（FastAPI）" ($r.StatusCode -eq 200 -and $r.Content -match "status") "HTTP $($r.StatusCode)"
} catch {
    Add-Result "/ai 分流可达（FastAPI）" $false $_.Exception.Message
}

# ---------- 输出 ----------
Write-Host ""
$results | Format-Table -AutoSize -Wrap
Write-Host ("PASS={0}  FAIL={1}" -f $script:pass, $script:fail) -ForegroundColor $(if ($script:fail -eq 0) { "Green" } else { "Red" })
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
