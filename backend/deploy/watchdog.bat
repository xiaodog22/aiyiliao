@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
set "TASK=WecharBackendWatchdog"
set "PS1=%HERE%scripts\watchdog.ps1"

rem PowerShell 5.1 会把无 BOM 的 ps1 当 GBK 解析（中文注释直接语法错）——先补 BOM
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\ensure-utf8bom.ps1" "%HERE%scripts" >nul 2>&1

if /i "%~1"=="install" goto :install
if /i "%~1"=="remove"  goto :remove
if /i "%~1"=="status"  goto :status
if /i "%~1"=="task"    goto :taskrun

echo [watchdog] 巡检一次…
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
goto :end

:status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Status
schtasks /query /tn "%TASK%" >nul 2>&1 && (echo. & echo [watchdog] 计划任务已注册：%TASK%) || (echo. & echo [watchdog] 计划任务未注册（运行 watchdog.bat install 安装）)
goto :end

:install
rem ⚠️ 本机实测（2026-11-15）：schtasks.exe 被安全中心「程序黑名单」拦截（拒绝访问），
rem    计划任务注册不了 —— 所以 install 只做提示，不要反复重试（会被安全策略硬拦）。
echo [watchdog] 本机 schtasks.exe 被安全策略禁用，无法注册计划任务。
echo             请改用下面任一方式保持后端常驻：
echo               1) 双击 backend\deploy\start-all.bat（窗口留着，进程挂在资源管理器下）
echo               2) 需要巡检时双击 backend\deploy\watchdog.bat（探活 + 缺谁拉谁）
goto :end

:remove
schtasks /delete /tn "%TASK%" /f
if errorlevel 1 (echo [watchdog] 没有找到任务 %TASK%) else (echo [watchdog] 已删除任务 %TASK%)
goto :end

:taskrun
schtasks /run /tn "%TASK%"
goto :end

:end
if "%~1"=="" pause
exit /b %ERRORLEVEL%
