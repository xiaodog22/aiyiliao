@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
rem status-guardian.bat - 查看守护状态（薄入口）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\guardian-launch.ps1" -Status
echo.
echo [guardian] 最近日志（logs\guardian.log 尾部 15 行）：
if exist "%HERE%logs\guardian.log" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath '%HERE%logs\guardian.log' -Tail 15 -Encoding UTF8"
) else (
  echo   （尚无日志）
)
endlocal
if "%~1"=="" pause
exit /b 0
