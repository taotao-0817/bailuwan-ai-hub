@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required. Install it from https://nodejs.org
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  if not exist "node_modules\vite\bin\vite.js" (
    call npm install --cache .npm-cache
    if errorlevel 1 (
      pause
      exit /b 1
    )
  )
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo.
echo Bailuwan Command Center - http://127.0.0.1:8788
echo Demo account: admin / Bailuwan2026!
echo Keep this terminal open. Press Ctrl+C to stop.
echo.
call npm start
pause
