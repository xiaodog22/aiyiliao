@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
rem -STA: WinForms requires single-threaded apartment (persistent panel window)
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%HERE%scripts\gui.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [start-gui] exit code = %RC%
  pause
)
exit /b %RC%
