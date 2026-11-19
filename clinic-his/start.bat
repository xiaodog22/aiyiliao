@echo off
rem ============================================================
rem  康诊云社区诊所信息系统（Clinic HIS）· 一键启动
rem  双击运行；可选环境变量：CLINIC_PORT（默认 8310）、CLINIC_HOST（默认 127.0.0.1）
rem ============================================================
setlocal
chcp 65001 >nul
title 康诊云社区诊所信息系统（Clinic HIS）
cd /d "%~dp0"

set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
if "%CLINIC_PORT%"=="" set "CLINIC_PORT=8310"
if "%CLINIC_HOST%"=="" set "CLINIC_HOST=127.0.0.1"

rem ---------- 查找 Python ----------
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (
    where py >nul 2>nul && set "PY=py -3"
)
if not defined PY (
    echo [错误] 未找到 Python。
    echo        请安装 Python 3.10 及以上，并在安装时勾选 "Add Python to PATH"。
    echo        下载地址：https://www.python.org/downloads/windows/
    echo.
    pause
    exit /b 1
)

%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 (
    echo [错误] Python 不可用或版本低于 3.10，当前为：
    %PY% -V
    echo        请升级 Python 后重试：https://www.python.org/downloads/windows/
    echo.
    pause
    exit /b 1
)

echo ============================================================
echo   康诊云社区诊所信息系统  Clinic HIS
echo ------------------------------------------------------------
echo   访问地址：http://%CLINIC_HOST%:%CLINIC_PORT%
echo   演示账号：doctor01（医师）/ admin06（信息科）等 30 个
echo   初始口令：Clinic@2026
echo ------------------------------------------------------------
echo   首次启动自动建库、写入演示数据与对外接口密钥
echo   （data\openapi-credentials.txt，勿提交、勿外传）
echo   演示数据全部虚构，禁止录入真实患者信息
echo   按 Ctrl+C 停止服务
echo ============================================================
echo.

rem 稍候自动打开浏览器（服务启动失败也能在窗口里看到报错）
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://%CLINIC_HOST%:%CLINIC_PORT%'"

%PY% -m app.main
set "EXIT_CODE=%errorlevel%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo [提示] 服务异常退出（代码 %EXIT_CODE%）。常见原因：
    echo        - 端口 %CLINIC_PORT% 被占用：设置环境变量 CLINIC_PORT=8311 后重试；
    echo        - 数据文件损坏：先备份 data\clinic.db 再排查。
) else (
    echo 服务已正常退出。
)
pause
exit /b %EXIT_CODE%
