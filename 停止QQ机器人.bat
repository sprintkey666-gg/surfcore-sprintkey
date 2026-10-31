@echo off
chcp 65001 >nul
cd /d "%~dp0"
set MODE=
if /i "%~1"=="all" set MODE=-All
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-qq-bot.ps1" %MODE%
echo.
pause
