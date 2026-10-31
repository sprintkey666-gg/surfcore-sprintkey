@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   QQ 机器人 - 全部停止
echo   桥接 + SnowLuma 一起关（QQ 保持运行）
echo ==========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-qq-bot.ps1" -All
echo.
pause
