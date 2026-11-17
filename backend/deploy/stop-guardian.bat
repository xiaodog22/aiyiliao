@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
rem stop-guardian.bat - 停止常驻守护（薄入口）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\guardian-launch.ps1" -Stop
endlocal
if "%~1"=="" pause
exit /b 0
