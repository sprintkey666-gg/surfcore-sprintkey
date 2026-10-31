@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Same as start.bat, plus one extra step: DSH 桌面端每次启动会换一个空闲端口，
rem 而桥接的会话 Cookie 把 host:port 绑进签名，端口错了只会 401。
rem 这里先探测正在运行的 DSH 端口并写回 config.json，再进正常的启动循环。
node scripts\sync-dsh-port.mjs
if errorlevel 1 echo [warn] 没能自动探测 DSH 端口，沿用 config.json 里的 dsh.baseUrl
node scripts\harden-state-acl.mjs --quiet
:loop
node src\bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
