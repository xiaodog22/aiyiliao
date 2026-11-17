@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
rem start-guardian.bat - 启动常驻守护（薄入口，逻辑在 scripts\guardian-launch.ps1）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\ensure-utf8bom.ps1" "%HERE%scripts" >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\guardian-launch.ps1" -Start
endlocal
if "%~1"=="" pause
exit /b 0
