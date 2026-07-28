@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 1. Dev mode (hot reload)
echo 2. Pack and build
echo.
set /p choice=Select (1/2): 
if "%choice%"=="1" npm run dev
if "%choice%"=="2" npm run pack
pause
