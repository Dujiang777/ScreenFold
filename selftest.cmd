@echo off
setlocal
title ScreenFold selftest

rem ============================================================
rem  ScreenFold self-test  --  just double-click, or:
rem      selftest.cmd --shot=shots
rem
rem  Runs the app in `--shot` mode and writes one PNG per UI state.
rem  Two things make this safe to run while you are using the app:
rem
rem    1. It uses its OWN Chromium profile (.selftest-userdata), so it
rem       does not fight the running copy for the single-instance lock
rem       (without this, a second instance just quits after ~6 seconds
rem       and produces zero screenshots).
rem    2. It gets its own config file, so YOUR real settings are never
rem       touched. That's why the seed below is copied in, not edited.
rem ============================================================

cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
set "PROFILE=%~dp0.selftest-userdata"

if not exist "%ELECTRON%" goto :noelectron

if not exist "%PROFILE%" mkdir "%PROFILE%"

rem Always start from the same known config, so screenshots are
rem comparable between runs instead of depending on your current size.
copy /y "%~dp0selftest-seed.json" "%PROFILE%\screenfold.json" >nul

if "%~1"=="" (
  "%ELECTRON%" "%~dp0." --shot=shots --sf-debug --user-data-dir="%PROFILE%"
) else (
  "%ELECTRON%" "%~dp0." %* --user-data-dir="%PROFILE%"
)

set "RC=%errorlevel%"
echo.
echo   selftest exit code: %RC%    (0 = all screenshots written)
echo   screenshots are in: %~dp0shots
echo.
exit /b %RC%

:noelectron
echo.
echo   electron.exe was not found at:
echo     %ELECTRON%
echo   Run `npm install` in this folder first.
echo.
pause
exit /b 1
