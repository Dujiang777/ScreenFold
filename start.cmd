@echo off
setlocal
title ScreenFold

rem ============================================================
rem  ScreenFold launcher
rem  Just double-click this file. No terminal, no paths, no npm.
rem ============================================================

rem Always work from the folder this file lives in, no matter
rem where it was launched from. This is the whole point.
cd /d "%~dp0"

rem This env var turns Electron into plain Node and it crashes with
rem "Cannot read properties of undefined (reading 'commandLine')".
rem Clear it as insurance -- it was set on this machine at some point.
set "ELECTRON_RUN_AS_NODE="

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" goto :noelectron

rem With arguments: run attached so output stays visible.
rem Used for the self-test:   start.cmd --shot=shots
if not "%~1"=="" (
  "%ELECTRON%" "%~dp0." %*
  exit /b %errorlevel%
)

rem Normal launch: detached on purpose. Otherwise an extra black
rem console window sits on screen and gives the whole thing away.
start "" "%ELECTRON%" "%~dp0."
exit /b 0

:noelectron
echo.
echo   ScreenFold cannot start
echo   -----------------------
echo   electron.exe was not found at:
echo     %ELECTRON%
echo.
echo   To fix it, open a terminal in this folder and run:
echo     npm install
echo.
pause
exit /b 1
