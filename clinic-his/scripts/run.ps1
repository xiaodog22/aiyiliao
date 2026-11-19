# 启动康诊云社区诊所信息系统（默认 http://127.0.0.1:8310）
# 可选环境变量：CLINIC_PORT（端口）、CLINIC_HOST（监听地址，默认 127.0.0.1）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:CLINIC_PORT) { $env:CLINIC_PORT } else { '8310' }
$env:PYTHONIOENCODING = 'utf-8'

Write-Host "Clinic HIS 正在启动：http://127.0.0.1:$port" -ForegroundColor Cyan
Write-Host "演示账号：doctor01 / admin06 等，初始口令 Clinic@2026" -ForegroundColor DarkGray
Push-Location $root
try {
    python -m app.main
} finally {
    Pop-Location
}
