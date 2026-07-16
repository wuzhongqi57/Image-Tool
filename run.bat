@echo off
setlocal enabledelayedexpansion

set PORT=%1
if "%PORT%"=="" set PORT=5000

title Teacher Image Fusion Tool :%PORT%

echo ========================================
echo   Teacher Image Fusion Tool v3
echo ========================================
echo.
echo   Starting server...
echo   Browser will open: http://127.0.0.1:%PORT%
echo   Press Ctrl+C to stop
echo ========================================
echo.

cd /d "%~dp0"

:: Try conda activate, fall back to direct Python path
call conda activate fusion_tool 2>nul
if errorlevel 1 goto direct_python

where python >nul 2>nul
if errorlevel 1 goto direct_python
goto start

:direct_python
echo [info] Using fusion_tool env Python directly
set PYTHON=C:\Users\Administrator\miniconda3\envs\fusion_tool\python.exe
goto launch

:start
set PYTHON=python

:launch
:: Open browser after a short delay
start "" /b cmd /c "ping -n 2 127.0.0.1 >nul & start http://127.0.0.1:%PORT%"

"%PYTHON%" app.py --port %PORT%

echo.
echo Server stopped.
pause
