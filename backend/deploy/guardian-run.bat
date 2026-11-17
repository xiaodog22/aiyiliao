@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
set "LAUNCHLOG=%HERE%logs\guardian-launch.log"
rem guardian-run.bat - launched by explorer.exe to detach from the caller session.
rem Do NOT double-click. Use start-guardian.bat (dedupe + detach) instead.
rem All output goes to logs\guardian-launch.log, otherwise -WindowStyle Hidden
rem swallows startup errors and the failure looks like "nothing happened".
rem NOTE: keep this file ASCII-only; no Chinese text here to avoid codepage issues.

if not exist "%HERE%logs" mkdir "%HERE%logs"
echo [%DATE% %TIME%] === guardian-run begin === >> "%LAUNCHLOG%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%HERE%scripts\guardian.ps1" >> "%LAUNCHLOG%" 2>&1
echo [%DATE% %TIME%] === guardian.ps1 exited code=%ERRORLEVEL% === >> "%LAUNCHLOG%"
exit /b 0
