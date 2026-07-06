@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 停止自动发布视频工具

set "PORT=8787"
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$port=8787; if(Test-Path '.env'){ $text=Get-Content '.env' -Raw; $match=[regex]::Match($text,'(?m)^\s*SERVER_PORT\s*=\s*(\d+)\s*$'); if($match.Success){ $port=$match.Groups[1].Value } }; $port"`) do set "PORT=%%P"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$connection=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if(-not $connection){exit 2}; Stop-Process -Id $connection.OwningProcess -Force"

if errorlevel 2 (
  echo 工具当前没有运行。
) else if errorlevel 1 (
  echo [错误] 停止服务失败，请在任务管理器中结束 Node.js 进程。
) else (
  echo 工具已停止。
)

powershell -NoProfile -Command "Start-Sleep -Seconds 2"
exit /b 0
