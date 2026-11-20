@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Clinic HIS - Community Clinic Information System
cd /d "%~dp0"

rem ============================================================
rem  Clinic HIS one-click launcher (Windows)
rem  Optional env: CLINIC_PORT (default 8310), CLINIC_HOST (default 127.0.0.1)
rem ============================================================

set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
if "%CLINIC_PORT%"=="" set "CLINIC_PORT=8310"
if "%CLINIC_HOST%"=="" set "CLINIC_HOST=127.0.0.1"

rem Browser host: 0.0.0.0 / :: are listen-only addresses.
set "BROWSE_HOST=%CLINIC_HOST%"
if "%BROWSE_HOST%"=="0.0.0.0" set "BROWSE_HOST=127.0.0.1"
if "%BROWSE_HOST%"=="::" set "BROWSE_HOST=127.0.0.1"

rem ---------- Port check: reuse a running instance, fail fast on a foreign listener ----------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $c=Get-NetTCPConnection -LocalPort %CLINIC_PORT% -State Listen; if (-not $c) { exit 0 }; try { $r=Invoke-RestMethod -Uri 'http://%BROWSE_HOST%:%CLINIC_PORT%/openapi/v1/ping' -TimeoutSec 2; if ($r.data.service -eq 'clinic-his') { exit 2 } } catch {}; exit 3"
set "PORT_STATE=%errorlevel%"
if "%PORT_STATE%"=="2" (
    echo [INFO] Clinic HIS is already running: http://%BROWSE_HOST%:%CLINIC_PORT%
    echo        Opening the browser. Close the existing window before restarting.
    start "" "http://%BROWSE_HOST%:%CLINIC_PORT%"
    ping 127.0.0.1 -n 3 >nul
    exit /b 0
)
if "%PORT_STATE%"=="3" (
    echo [ERROR] Port %CLINIC_PORT% is occupied by another program.
    echo         Close it, or set CLINIC_PORT=8311 and run again:
    echo             set CLINIC_PORT=8311
    echo             start.bat
    echo.
    pause
    exit /b 1
)

rem ---------- Python 3.10+ ----------
set "PY="
call :try_python "py -3"
if not defined PY call :try_python "python"
if not defined PY call :try_python "D:\anaconda3.0\python.exe"
if not defined PY call :try_python "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY call :try_python "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY (
    echo [ERROR] Python 3.10+ was not found.
    echo         Install Python 3.10+ and enable "Add Python to PATH".
    echo         Download: https://www.python.org/downloads/windows/
    echo.
    pause
    exit /b 1
)

echo ============================================================
echo   Clinic HIS - Community Clinic Information System
echo ------------------------------------------------------------
echo   URL: http://%BROWSE_HOST%:%CLINIC_PORT%
echo   Demo accounts: doctor01 / admin06 ... (30 accounts)
echo   Initial password: Clinic@2026
echo ------------------------------------------------------------
echo   First run creates the database, demo data and OpenAPI keys.
echo   (data\openapi-credentials.txt - do not commit or share)
echo   Demo data is fictional. Never enter real patient data.
echo   Press Ctrl+C to stop the server.
echo ============================================================
echo.

rem ---------- Stable document secret: print links survive restarts ----------
if "%CLINIC_DOC_SECRET%"=="" call :load_doc_secret
if "%CLINIC_DOC_SECRET%"=="" (
    echo [WARN] Document secret was not created; print links will expire on restart.
) else (
    echo   Document secret: configured ^(data\.doc_secret or env var^)
)
echo.

rem Open the browser after a short delay; the console still shows startup errors.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://%BROWSE_HOST%:%CLINIC_PORT%'"

%PY% -m app.main
set "EXIT_CODE=%errorlevel%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo [INFO] Server exited with code %EXIT_CODE%. Common causes:
    echo        - Port %CLINIC_PORT% is occupied: set CLINIC_PORT=8311 and retry.
    echo        - Database is damaged: back up data\clinic.db and inspect.
) else (
    echo Server stopped normally.
)
pause
exit /b %EXIT_CODE%

:try_python
%~1 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 set "PY=%~1"
exit /b 0

:load_doc_secret
if not exist "data\.doc_secret" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\ensure-secret.ps1" >nul 2>nul
)
if exist "data\.doc_secret" (
    set /p CLINIC_DOC_SECRET=<"data\.doc_secret"
)
exit /b 0
