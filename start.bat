@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 自动发布视频工具

echo.
echo ========================================
echo        自动发布视频工具 - 启动程序
echo ========================================
echo.

set "BUNDLED_RUNTIME=0"
set "NODE_EXE=node"
set "NPM_CMD=npm.cmd"

if exist "%CD%\runtime\node.exe" if exist "%CD%\runtime\npm.cmd" (
  set "BUNDLED_RUNTIME=1"
  set "NODE_EXE=%CD%\runtime\node.exe"
  set "NPM_CMD=%CD%\runtime\npm.cmd"
  set "PATH=%CD%\runtime;%PATH%"
  echo [提示] 正在使用程序内置运行环境。
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [错误] 程序内置运行环境缺失，电脑中也未检测到 Node.js。
    echo 请重新解压完整交付包，或安装 Node.js 20 及以上版本。
    pause
    exit /b 1
  )

  where npm.cmd >nul 2>nul
  if errorlevel 1 (
    echo [错误] 未检测到 npm，请重新安装 Node.js。
    pause
    exit /b 1
  )
)

set "NODE_MAJOR=0"
for /f "tokens=1 delims=." %%V in ('""%NODE_EXE%" --version"') do set "NODE_MAJOR=%%V"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if %NODE_MAJOR% LSS 20 (
  echo [错误] 当前 Node.js 版本过低。
  "%NODE_EXE%" --version
  echo 请安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)

if not exist "package.json" (
  echo [错误] 程序文件不完整，缺少 package.json。
  pause
  exit /b 1
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo [提示] 已创建配置文件 .env。
)

set "PORT=8787"
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$port=8787; if(Test-Path '.env'){ $text=Get-Content '.env' -Raw; $match=[regex]::Match($text,'(?m)^\s*SERVER_PORT\s*=\s*(\d+)\s*$'); if($match.Success){ $port=$match.Groups[1].Value } }; $port"`) do set "PORT=%%P"
set "APP_URL=http://127.0.0.1:%PORT%"

powershell -NoProfile -Command "try { $r=Invoke-RestMethod -Uri '%APP_URL%/api/health' -TimeoutSec 2; if($r.ok){exit 0}else{exit 1} } catch { exit 1 }"
if not errorlevel 1 (
  echo [完成] 工具已经在运行，正在打开网页……
  start "" "%APP_URL%"
  exit /b 0
)

powershell -NoProfile -Command "if(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue){exit 0}else{exit 1}"
if not errorlevel 1 (
  echo [错误] 端口 %PORT% 已被其他程序占用。
  echo 请关闭占用程序，或在 .env 中修改 SERVER_PORT。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/3] 首次运行，正在安装程序依赖……
  call "%NPM_CMD%" install --no-fund --no-audit
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络连接。
    pause
    exit /b 1
  )
) else (
  echo [1/3] 程序依赖已就绪。
)

if "%BUNDLED_RUNTIME%"=="1" if exist "dist\index.html" (
  echo [2/3] 网页文件已就绪。
) else (
  echo [2/3] 正在构建网页……
  call "%NPM_CMD%" run build
  if errorlevel 1 (
    echo [错误] 网页构建失败，请查看上方错误信息。
    pause
    exit /b 1
  )
)

echo [3/3] 正在启动后台服务……
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=(Get-Location).Path; Start-Process -FilePath $env:NPM_CMD -ArgumentList 'run','start' -WorkingDirectory $root -RedirectStandardOutput (Join-Path $root 'server.out.log') -RedirectStandardError (Join-Path $root 'server.err.log') -WindowStyle Hidden"

for /l %%I in (1,1,20) do (
  powershell -NoProfile -Command "try { $r=Invoke-RestMethod -Uri '%APP_URL%/api/health' -TimeoutSec 1; if($r.ok){exit 0}else{exit 1} } catch { exit 1 }"
  if not errorlevel 1 goto ready
  powershell -NoProfile -Command "Start-Sleep -Seconds 1"
)

echo [错误] 服务启动超时。
echo 请查看 server.err.log，或将日志发给技术支持。
if exist "server.err.log" type "server.err.log"
pause
exit /b 1

:ready
echo.
echo [完成] 工具已启动：%APP_URL%
echo 正在打开浏览器……
start "" "%APP_URL%"
exit /b 0
