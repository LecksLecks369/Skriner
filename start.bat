@echo off
rem MetaScalp Screener - quick start (Windows)
chcp 65001 >nul
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo [!] Bun is not installed. Install it from https://bun.sh
  echo     PowerShell: powershell -c "irm bun.sh/install.ps1 | iex"
  pause
  exit /b 1
)

if not exist node_modules (
  echo [*] Installing dependencies...
  call bun install
)

if not exist .next\standalone\server.js (
  echo [*] Building project...
  call bun run build
)

echo [*] Starting: http://localhost:3000  (Ctrl+C to stop)
call bun start
pause
