# 启动康诊云社区诊所信息系统（默认 http://127.0.0.1:8310）
# 可选环境变量：CLINIC_PORT（端口）、CLINIC_HOST（监听地址，默认 127.0.0.1）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:CLINIC_PORT) { $env:CLINIC_PORT } else { '8310' }
$env:PYTHONIOENCODING = 'utf-8'

# L7：患者哈希盐缺失即拒启；本地开发由 scripts/ensure-secret.ps1 生成到
# data/.patient_hash_salt（已 gitignore），生产必须由密钥管理注入环境变量。
if (-not $env:CLINIC_PATIENT_HASH_SALT) {
    $saltPath = Join-Path $root 'data\.patient_hash_salt'
    if (-not (Test-Path -LiteralPath $saltPath)) {
        & (Join-Path $PSScriptRoot 'ensure-secret.ps1')
    }
    if (Test-Path -LiteralPath $saltPath) {
        $env:CLINIC_PATIENT_HASH_SALT = (Get-Content -LiteralPath $saltPath -Raw).Trim()
    } else {
        throw 'CLINIC_PATIENT_HASH_SALT 未配置，且无法生成本地盐；生产必须由密钥管理注入。'
    }
}

Write-Host "Clinic HIS 正在启动：http://127.0.0.1:$port" -ForegroundColor Cyan
Write-Host "演示账号：doctor01 / admin06 等；初始口令在首次初始化日志中一次性打印（或设 CLINIC_SEED_PASSWORD）" -ForegroundColor DarkGray
Push-Location $root
try {
    python -m app.main
} finally {
    Pop-Location
}
