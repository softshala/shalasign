@echo off
title ShalaSign
echo ============================================
echo  ShalaSign - starting up (first run takes a
echo  few minutes while it downloads components)
echo ============================================

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo.
  echo Node.js is not installed yet.
  echo Please install it first from https://nodejs.org (click the green LTS button),
  echo then double-click this file again.
  pause
  exit /b
)

cd /d "%~dp0"

for /f "delims=" %%v in ('node -p "process.versions.node.split(^".^")[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo.
  echo ShalaSign needs Node.js 22 or newer. Please install the current LTS from https://nodejs.org
  echo and double-click this file again.
  pause
  exit /b
)

echo Checking app components (quick if already installed)...
cd server && call npm install --silent --no-audit --no-fund && cd ..
cd client && call npm install --silent --no-audit --no-fund && cd ..
if not exist "client\dist" (
  echo Preparing the app screens...
  cd client && call npm run build --silent && cd ..
)

echo.
echo ShalaSign is running! Opening it in your browser...
echo Keep this black window open while you use the app.
echo (Close this window to stop ShalaSign.)
start http://localhost:4000
set NODE_NO_WARNINGS=1
cd server && node src/index.js
pause
