@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
rem self-heal: PowerShell 5.1 decodes a BOM-less ps1 as GBK and fails to parse
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\ensure-utf8bom.ps1" "%HERE%scripts"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\orchestrator.ps1" -Action start %*
set "RC=%ERRORLEVEL%"
echo [start-all] exit code = %RC%
if "%~1"=="" pause
exit /b %RC%
